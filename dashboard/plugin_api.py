"""Retake: explicit uploads, append-only review records and explicit opt-in image generation.

A confirmed POST /projects/{pid}/generations RESERVES a durable attempt. A separate explicit
POST /projects/{pid}/generations/{gid}/run claims it once and runs it through stock Hermes's
documented tool server for THIS request's profile (direct_runner.py): no chat, session or focus.
Reading capabilities, projects or attempts never contacts a tool or provider.
"""
import base64
from contextlib import contextmanager
from datetime import datetime, timezone
from email.parser import BytesParser
from email.policy import default
import hashlib
import importlib
import importlib.util
import io
import json
import math
import os
from pathlib import Path
import re
import struct
import sys
import uuid
from typing import NoReturn
import warnings

from fastapi import APIRouter, HTTPException, Request
from fastapi.concurrency import run_in_threadpool
from PIL import Image
from plugins.plugin_storage import plugin_data_dir

def _load_package():
    # The dashboard loads this file standalone; load the plugin's own package by path (its __init__ only
    # defines register()) so the router shares retake_store/stock_bridge/direct_runner with the command.
    root = Path(__file__).resolve().parents[1]
    name = 'retake_pkg_' + hashlib.sha256(str(root).encode()).hexdigest()[:12]
    if name not in sys.modules:
        spec = importlib.util.spec_from_file_location(name, root / '__init__.py', submodule_search_locations=[str(root)])
        module = importlib.util.module_from_spec(spec)
        sys.modules[name] = module
        try:
            spec.loader.exec_module(module)
        except BaseException:
            sys.modules.pop(name, None); raise
    return (importlib.import_module(name + '.retake_store'), importlib.import_module(name + '.direct_runner'),
            importlib.import_module(name + '.image_selection'))

store, direct_runner, image_selection = _load_package()
router = APIRouter()
MAX_IMAGE_BYTES = 12 * 1024 * 1024
MAX_VIDEO_BYTES = 32 * 1024 * 1024
MAX_PIXELS = 24_000_000
MAX_DURATION = 120
MAX_PROJECTS = 100
MAX_VERSIONS = 200
MAX_NOTES = 500
MAX_PROFILE_BYTES = 512 * 1024 * 1024
ID = re.compile(r'^[0-9a-f]{32}$')
MIMES = {'image/png':'PNG', 'image/jpeg':'JPEG', 'image/webp':'WEBP', 'video/mp4':'MP4'}
THUMB_SIZE = (240, 180)
MAX_THUMB_BYTES = 256 * 1024
NO_STORE = {'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'}

def fail(code, text) -> NoReturn:
    raise HTTPException(code, text)

def ident(value):
    if not isinstance(value, str) or not ID.fullmatch(value): fail(422, 'Invalid record ID')
    return value

def text(value, label, maximum=4000):
    if not isinstance(value, str) or not value.strip() or len(value) > maximum: fail(422, f'{label} must contain 1–{maximum} characters')
    return value.strip()

def number(value, label):
    if isinstance(value, bool) or not isinstance(value, (float, int)) or (isinstance(value,float) and not math.isfinite(value)): fail(422, f'Invalid {label}')
    return value

def record(**fields):
    return {'id':uuid.uuid4().hex, 'created_at':datetime.now(timezone.utc).isoformat(), **fields}

def storage_root():
    # Resolve on EVERY request, after the host has bound the authenticated profile.
    root = plugin_data_dir('retake')
    root.mkdir(parents=True, exist_ok=True, mode=0o700)
    return root

@contextmanager
def db(root=None):
    # `root` is passed only by a generation request that captured its own profile storage before
    # dispatch, so a late provider result is written back to the profile that requested it.
    root = storage_root() if root is None else root
    try:
        with store.connect(root) as con:
            yield con
    except store.UnsafeStorage:
        fail(503, 'Unsafe plugin storage')

def project(con, pid):
    ident(pid)
    row = con.execute('SELECT data FROM projects WHERE id=?',(pid,)).fetchone()
    if not row: fail(404,'Project not found')
    return json.loads(row[0])

def version(con, pid, vid):
    project(con,pid); ident(vid)
    row=con.execute('SELECT data FROM versions WHERE project_id=? AND id=?',(pid,vid)).fetchone()
    if not row: fail(404,'Version not found in project')
    v=json.loads(row[0]); state=con.execute('SELECT status FROM reviews WHERE version_id=?',(vid,)).fetchone()
    v['status']=state[0] if state else 'needs_revision'
    return v

def annotations(con, vid):
    return [json.loads(r[0]) for r in con.execute('SELECT data FROM annotations WHERE version_id=? ORDER BY rowid',(vid,))]

def boxes(data, start=0, end=None):
    end=len(data) if end is None else end
    count=0
    while start < end:
        if end-start < 8: fail(415,'Malformed MP4 box')
        size,kind=struct.unpack_from('>I4s',data,start); head=8
        if size==1:
            if end-start<16: fail(415,'Malformed MP4 box')
            size=struct.unpack_from('>Q',data,start+8)[0]; head=16
        elif size==0: size=end-start
        if size<head or start+size>end: fail(415,'Malformed MP4 box size')
        count+=1
        if count>4096: fail(415,'MP4 box limit exceeded')
        yield kind,start+head,start+size
        start+=size

def mp4_metadata(data):
    """Bounded ISO-BMFF metadata validation, no executable probes or external references.

    Narrow MVP: nonfragmented self-contained H.264 MP4 with mvhd + mdhd durations.
    Browser remains the decoder; this is container validation, not malware scanning.
    """
    durations=[]; video=False; codecs=[]; references=0; found=set(); dimensions=(None,None)
    def walk(start,end,depth=0):
        nonlocal video,references,dimensions
        if depth>8: fail(415,'MP4 nesting limit exceeded')
        for kind,a,b in boxes(data,start,end):
            if kind in {b'moov',b'trak',b'mdia',b'minf',b'stbl',b'dinf'}:
                walk(a,b,depth+1)
            elif kind==b'ftyp':
                if b-a<8 or data[a:a+4] not in {b'isom',b'iso2',b'mp41',b'mp42',b'avc1'}: fail(415,'Unsupported MP4 brand')
                found.add('ftyp')
            elif kind in {b'moof',b'mvex'}: fail(415,'Fragmented MP4 is not supported')
            elif kind in {b'mvhd',b'mdhd'}:
                if b-a<20: fail(415,'Truncated MP4 duration')
                ver=data[a]
                if ver==0: scale,duration=struct.unpack_from('>II',data,a+12)
                elif ver==1 and b-a>=32: scale,duration=struct.unpack_from('>IQ',data,a+20)
                else: fail(415,'Unsupported MP4 duration')
                if not scale or not 0<duration/scale<=MAX_DURATION: fail(422,'Video must be 0–120 seconds')
                durations.append(duration/scale)
                if kind==b'mvhd': found.add('mvhd')
            elif kind==b'hdlr':
                if b-a<12: fail(415,'Truncated MP4 handler')
                if data[a+8:a+12]==b'vide': video=True
            elif kind==b'stsd':
                if b-a<8: fail(415,'Truncated sample descriptions')
                entries=list(boxes(data,a+8,b))
                if len(entries)!=struct.unpack_from('>I',data,a+4)[0]: fail(415,'Invalid sample descriptions')
                for codec,s,e in entries:
                    if codec not in {b'avc1',b'mp4a'}: fail(415,'Only H.264/AAC MP4 is supported')
                    codecs.append(codec)
                    if codec==b'avc1':
                        if e-s<78: fail(415,'Truncated video sample')
                        dimensions=struct.unpack_from('>HH',data,s+24)
                        if not all(dimensions) or dimensions[0]*dimensions[1]>MAX_PIXELS: fail(415,'Video dimensions exceed limit')
            elif kind==b'dref':
                if b-a<8: fail(415,'Truncated MP4 references')
                refs=list(boxes(data,a+8,b))
                if len(refs)!=struct.unpack_from('>I',data,a+4)[0] or not refs: fail(415,'Invalid media references')
                for typ,s,e in refs:
                    if typ!=b'url ' or e-s!=4 or data[s:e]!=b'\x00\x00\x00\x01': fail(415,'External media references refused')
                    references+=1
    walk(0,len(data))
    if found!={'ftyp','mvhd'} or not video or b'avc1' not in codecs or not references or not durations: fail(415,'Incomplete self-contained H.264 MP4')
    return {'duration':max(durations),'width':dimensions[0],'height':dimensions[1]}

def media_metadata(data,mime):
    if mime=='video/mp4': return mp4_metadata(data)
    try:
        with warnings.catch_warnings():
            warnings.simplefilter('error',Image.DecompressionBombWarning)
            with Image.open(io.BytesIO(data)) as image:
                if image.format!=MIMES[mime] or image.width*image.height>MAX_PIXELS or getattr(image,'n_frames',1)!=1: fail(415,'Unsupported image or dimensions')
                width,height=image.size; image.verify()
            with Image.open(io.BytesIO(data)) as image: image.load()
    except HTTPException: raise
    except Exception: fail(415,'Invalid image')
    return {'width':width,'height':height,'duration':None}

# JSON (base64) upload: the documented plugin REST `body` channel, which every host backend mode carries
# (OAuth-gated remotes refuse the multipart `upload` option before sending). Exactly these keys; no URL or
# server path is ever accepted. The decoded bytes then pass the SAME checks as a multipart upload.
UPLOAD_JSON_KEYS = frozenset({'filename', 'content_type', 'data_base64'})
b64len = lambda n: 4 * -(-n // 3)
MAX_UPLOAD_JSON = b64len(MAX_VIDEO_BYTES) + 65536

async def upload_json(request):
    body=await bounded_json(request, MAX_UPLOAD_JSON)
    if not isinstance(body,dict) or set(body)!=UPLOAD_JSON_KEYS or not all(isinstance(body[k],str) for k in UPLOAD_JSON_KEYS):
        fail(422,'Upload JSON must have exactly filename, content_type and data_base64 strings')
    mime=body['content_type'].lower()
    if mime not in MIMES: fail(415,'Allowed media: PNG, JPEG, static WebP, H.264 MP4')
    if len(body['data_base64'])>b64len(MAX_VIDEO_BYTES if mime=='video/mp4' else MAX_IMAGE_BYTES): fail(413,'Empty file or media size limit exceeded')
    try:
        data=base64.b64decode(body['data_base64'].encode('ascii'),validate=True)
    except (ValueError, UnicodeEncodeError):
        fail(422,'Invalid base64 media')
    return data,mime,body['filename']

async def upload_bytes(request):
    mime=request.headers.get('content-type','').split(';')[0].lower()
    if mime=='application/json':
        data,mime,filename=await upload_json(request)
        return checked_upload(data,mime,filename)
    limit=MAX_VIDEO_BYTES+65536
    length=request.headers.get('content-length')
    if length:
        try:
            if int(length)>limit or int(length)<0: fail(413,'Upload too large')
        except ValueError: fail(422,'Invalid content length')
    chunks=[]; total=0
    async for chunk in request.stream():
        total+=len(chunk)
        if total>limit: fail(413,'Upload too large')
        chunks.append(chunk)
    data=b''.join(chunks); filename=request.headers.get('x-filename','upload')
    if mime=='multipart/form-data':
        message=BytesParser(policy=default).parsebytes(('Content-Type: '+request.headers['content-type']+'\r\nMIME-Version: 1.0\r\n\r\n').encode()+data)
        parts=list(message.iter_parts())
        if len(parts)!=1 or parts[0].get_param('name',header='content-disposition')!='file': fail(422,'Upload exactly one file')
        part=parts[0]; mime=part.get_content_type(); filename=part.get_filename() or 'upload'; data=part.get_payload(decode=True)
        if not isinstance(data,bytes): fail(415,'Invalid upload')
    return checked_upload(data,mime,filename)

def checked_upload(data,mime,filename):
    if mime not in MIMES: fail(415,'Allowed media: PNG, JPEG, static WebP, H.264 MP4')
    if not data or len(data)>(MAX_VIDEO_BYTES if mime=='video/mp4' else MAX_IMAGE_BYTES): fail(413,'Empty file or media size limit exceeded')
    # Filename is display-only. Never opened as a path and never used as an HTTP header.
    filename=filename.replace('\\','/').rsplit('/',1)[-1]
    filename=''.join(c for c in filename if c.isprintable())[:160] or 'upload'
    return data,mime,filename

def cover_version(con, pid):
    """Descriptor of the first owned raster version, for navigation covers. Never media bytes."""
    for (raw,) in con.execute('SELECT data FROM versions WHERE project_id=? ORDER BY rowid',(pid,)):
        v=json.loads(raw)
        if v.get('mime') in MIMES and v['mime'].startswith('image/'):
            return {'id':v['id'],'project_id':pid,'mime':v['mime'],'name':v['name']}
    return None

def thumbnail_png(data, mime):
    """Decode owned raster bytes with Pillow; return a PNG within THUMB_SIZE and MAX_THUMB_BYTES."""
    try:
        with warnings.catch_warnings():
            warnings.simplefilter('error',Image.DecompressionBombWarning)
            with Image.open(io.BytesIO(data)) as image:
                if image.format!=MIMES[mime] or image.width*image.height>MAX_PIXELS or getattr(image,'n_frames',1)!=1: fail(415,'Unsupported image')
                image.draft('RGB',THUMB_SIZE)  # JPEG-only decode shortcut; a no-op for other formats
                alpha=image.mode in ('RGBA','LA','PA') or 'transparency' in image.info
                small=image.convert('RGBA' if alpha else 'RGB')
        small.thumbnail(THUMB_SIZE)
        out=io.BytesIO(); small.save(out,'PNG',optimize=True)
    except HTTPException: raise
    except Exception: fail(415,'Thumbnail unavailable')
    png=out.getvalue()
    if small.width>THUMB_SIZE[0] or small.height>THUMB_SIZE[1] or len(png)>MAX_THUMB_BYTES: fail(413,'Thumbnail exceeds bounds')
    return png,small.size

@router.get('/projects')
async def list_projects():
    with db() as con:
        projects=[json.loads(r[0]) for r in con.execute('SELECT data FROM projects ORDER BY rowid DESC')]
        return {'projects':[{**p,'cover_version':cover_version(con,p['id'])} for p in projects]}

@router.post('/projects')
async def create_project(body:dict):
    p=record(name=text(body.get('name'),'Project name',120))
    with db() as con:
        con.execute('BEGIN IMMEDIATE')
        if con.execute('SELECT count(*) FROM projects').fetchone()[0]>=MAX_PROJECTS: fail(409,'Project limit reached')
        con.execute('INSERT INTO projects VALUES (?,?)',(p['id'],json.dumps(p)))
    return p

# Permanent deletion of ONE project of THIS profile's store: its versions (media blobs), reviews, notes,
# instructions and generation attempts, in one transaction. Requires the exact project name. Refused, with
# nothing changed, while any attempt is reserved, running or of unknown outcome: a late provider result
# must never land in (or race) a deleted project. Never touches files, paths or URLs.
OPEN_ATTEMPT_STATES = ('reserved', 'running', 'unknown')

@router.delete('/projects/{pid}')
async def delete_project(pid:str, request:Request):
    ident(pid)
    body=await bounded_json(request, 4096)
    with db() as con:
        con.execute('BEGIN IMMEDIATE'); p=project(con,pid)
        if not isinstance(body,dict) or set(body)!={'confirm_name'} or body['confirm_name']!=p['name']: fail(422,'Confirm with the exact project name')
        open_=con.execute(f"SELECT count(*) FROM generation_attempts WHERE project_id=? AND state IN ({','.join('?'*len(OPEN_ATTEMPT_STATES))})",(pid,*OPEN_ATTEMPT_STATES)).fetchone()[0]
        if open_: fail(409,f'Not deleted: {open_} generation attempt{"s" if open_!=1 else ""} in this project {"are" if open_!=1 else "is"} reserved, running or of unknown outcome. Nothing was removed.')
        vids='SELECT id FROM versions WHERE project_id=?'
        counts={'versions':con.execute('SELECT count(*) FROM versions WHERE project_id=?',(pid,)).fetchone()[0],
                'notes':con.execute(f'DELETE FROM annotations WHERE version_id IN ({vids})',(pid,)).rowcount}
        con.execute(f'DELETE FROM reviews WHERE version_id IN ({vids})',(pid,))
        counts['instructions']=con.execute('DELETE FROM briefs WHERE project_id=?',(pid,)).rowcount
        con.execute('DELETE FROM asset_names WHERE project_id=?',(pid,))
        counts['attempts']=con.execute('DELETE FROM generation_attempts WHERE project_id=?',(pid,)).rowcount
        con.execute('DELETE FROM versions WHERE project_id=?',(pid,))
        con.execute('DELETE FROM projects WHERE id=?',(pid,))
    return {'deleted':pid,**counts}

# Renames ONE project. Only its display name changes; IDs, versions and everything else stay as they are.
@router.post('/projects/{pid}/name')
async def rename_project(pid:str, body:dict):
    ident(pid)
    if set(body)!={'name'}: fail(422,'Send exactly {"name": "…"}')
    name=text(body['name'],'Project name',120)
    with db() as con:
        con.execute('BEGIN IMMEDIATE'); p=project(con,pid)
        p['name']=name
        con.execute('UPDATE projects SET data=? WHERE id=?',(json.dumps(p),pid))
    return p

@router.get('/projects/{pid}')
async def read_project(pid:str):
    with db() as con:
        p=project(con,pid)
        versions=[version(con,pid,r[0]) for r in con.execute('SELECT id FROM versions WHERE project_id=? ORDER BY rowid',(pid,))]
        return {'project':p,'versions':versions,'annotations':[a for v in versions for a in annotations(con,v['id'])], 'briefs':[json.loads(r[0]) for r in con.execute('SELECT data FROM briefs WHERE project_id=? ORDER BY rowid DESC',(pid,))],
                'attempts':[public_attempt(json.loads(r[0])) for r in con.execute('SELECT data FROM generation_attempts WHERE project_id=? ORDER BY rowid DESC',(pid,))],
                'asset_names':dict(con.execute('SELECT asset_id,name FROM asset_names WHERE project_id=?',(pid,)).fetchall())}

# A display name for one asset of this project. Versions, files and IDs are unchanged; an empty name
# removes the override so the asset shows its default name again.
@router.post('/projects/{pid}/assets/{aid}/name')
async def rename_asset(pid:str, aid:str, body:dict):
    ident(aid); raw=body.get('name')
    if not isinstance(raw,str) or set(body)!={'name'}: fail(422,'Send exactly {"name": "…"}')
    with db() as con:
        con.execute('BEGIN IMMEDIATE'); project(con,pid)
        if not con.execute("SELECT 1 FROM versions WHERE project_id=? AND json_extract(data,'$.asset_id')=? LIMIT 1",(pid,aid)).fetchone(): fail(404,'Asset not found in project')
        if not raw.strip():
            con.execute('DELETE FROM asset_names WHERE asset_id=? AND project_id=?',(aid,pid)); return {'asset_id':aid,'name':None}
        name=text(raw,'Asset name',120)
        con.execute('INSERT INTO asset_names VALUES (?,?,?) ON CONFLICT(asset_id) DO UPDATE SET name=excluded.name',(aid,pid,name))
    return {'asset_id':aid,'name':name}

@router.post('/projects/{pid}/versions')
async def upload_version(pid:str,request:Request,parent_id:str|None=None):
    ident(pid)
    if parent_id is not None: ident(parent_id)
    data,mime,name=await upload_bytes(request)
    meta=media_metadata(data,mime)
    with db() as con:
        con.execute('BEGIN IMMEDIATE'); project(con,pid)
        parent=version(con,pid,parent_id) if parent_id else None
        if parent and parent['mime'].split('/')[0]!=mime.split('/')[0]: fail(422,'A revision must preserve the asset media kind')
        if con.execute('SELECT count(*) FROM versions WHERE project_id=?',(pid,)).fetchone()[0]>=MAX_VERSIONS: fail(409,'Version limit reached')
        if con.execute('SELECT coalesce(sum(length(media)),0) FROM versions').fetchone()[0]+len(data)>MAX_PROFILE_BYTES: fail(413,'Profile media quota reached')
        v=record(project_id=pid,asset_id=parent['asset_id'] if parent else uuid.uuid4().hex,parent_id=parent_id,name=name,mime=mime,size=len(data),sha256=hashlib.sha256(data).hexdigest(),**meta)
        con.execute('INSERT INTO versions VALUES (?,?,?,?)',(v['id'],pid,json.dumps(v),data))
    return {**v,'status':'needs_revision'}

@router.get('/projects/{pid}/versions/{vid}/media')
async def read_media(pid:str,vid:str):
    with db() as con:
        v=version(con,pid,vid)
        data=con.execute('SELECT media FROM versions WHERE id=?',(vid,)).fetchone()[0]
        from fastapi.responses import JSONResponse
        return JSONResponse({'mime':v['mime'],'base64':base64.b64encode(data).decode('ascii')},headers={'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'})

@router.get('/projects/{pid}/versions/{vid}/thumbnail')
async def read_thumbnail(pid:str,vid:str):
    from fastapi.responses import JSONResponse
    with db() as con:
        v=version(con,pid,vid)
        if not v['mime'].startswith('image/'):
            # No frame extraction: no ffmpeg, no URL fetches. The client shows an explicit video placeholder.
            return JSONResponse({'kind':'video','version_id':vid},headers=NO_STORE)
        data=con.execute('SELECT media FROM versions WHERE project_id=? AND id=?',(pid,vid)).fetchone()[0]
    png,(width,height)=thumbnail_png(data,v['mime'])
    return JSONResponse({'kind':'image','version_id':vid,'mime':'image/png','width':width,'height':height,'base64':base64.b64encode(png).decode('ascii')},headers=NO_STORE)

@router.post('/projects/{pid}/versions/{vid}/review')
async def review(pid:str,vid:str,body:dict):
    status=body.get('status')
    if not isinstance(status,str) or status not in {'selected','needs_revision','rejected'}: fail(422,'Invalid review state')
    with db() as con:
        con.execute('BEGIN IMMEDIATE'); v=version(con,pid,vid)
        # Approval is the asset's ONE pick: approving this version returns any other approved version of the
        # same asset to needs_revision, in the same transaction. Nothing is hidden or deleted.
        unapproved=[]
        if status=='selected':
            unapproved=[r[0] for r in con.execute("SELECT r.version_id FROM reviews r JOIN versions x ON x.id=r.version_id WHERE x.project_id=? AND json_extract(x.data,'$.asset_id')=? AND r.version_id!=? AND r.status='selected' ORDER BY x.rowid",(pid,v['asset_id'],vid))]
            con.executemany("UPDATE reviews SET status='needs_revision' WHERE version_id=?",[(x,) for x in unapproved])
        con.execute('INSERT INTO reviews VALUES (?,?) ON CONFLICT(version_id) DO UPDATE SET status=excluded.status',(vid,status))
    return {**v,'status':status,'unapproved':unapproved}

@router.post('/projects/{pid}/versions/{vid}/annotations')
async def annotate(pid:str,vid:str,body:dict):
    note=text(body.get('note'),'Annotation')
    with db() as con:
        con.execute('BEGIN IMMEDIATE'); v=version(con,pid,vid)
        a=record(version_id=vid,kind=body.get('kind'),note=note)
        if a['kind']=='region' and v['mime'].startswith('image/'):
            region=body.get('region')
            if not isinstance(region,dict): fail(422,'Region required')
            r={k:number(region.get(k),k) for k in ('x','y','width','height')}
            if not (0<=r['x']<1 and 0<=r['y']<1 and 0<r['width']<=1 and 0<r['height']<=1 and r['x']+r['width']<=1 and r['y']+r['height']<=1): fail(422,'Region must fit normalized image bounds')
            a['region']=r
        elif a['kind']=='timestamp' and v['mime']=='video/mp4':
            t=number(body.get('timestamp'),'timestamp')
            if not 0<=t<=v['duration']: fail(422,'Timestamp outside video duration')
            a['timestamp']=t
        else: fail(422,'Annotation kind does not match media')
        if len(annotations(con,vid))>=MAX_NOTES: fail(409,'Annotation limit reached')
        con.execute('INSERT INTO annotations VALUES (?,?,?)',(a['id'],vid,json.dumps(a)))
    return a

@router.post('/projects/{pid}/versions/{vid}/briefs')
async def create_brief(pid:str,vid:str,body:dict):
    change=text(body.get('change'),'Change notes'); preserve=text(body.get('preserve'),'Preserve notes')
    with db() as con:
        con.execute('BEGIN IMMEDIATE'); v=version(con,pid,vid)
        if con.execute('SELECT count(*) FROM briefs WHERE project_id=?',(pid,)).fetchone()[0]>=MAX_NOTES: fail(409,'Brief limit reached')
        b=record(project_id=pid,version_id=vid,asset_id=v['asset_id'],parent_id=v['parent_id'],media_sha256=v['sha256'],change=change,preserve=preserve,annotations=annotations(con,vid),draft_only=True,generation=False,payment=False,dispatch=False)
        con.execute('INSERT INTO briefs VALUES (?,?,?)',(b['id'],pid,json.dumps(b)))
    return b

@router.get('/projects/{pid}/briefs/{bid}')
async def read_brief(pid:str,bid:str):
    with db() as con:
        project(con,pid); ident(bid)
        row=con.execute('SELECT data FROM briefs WHERE project_id=? AND id=?',(pid,bid)).fetchone()
        if not row: fail(404,'Brief not found')
        return json.loads(row[0])

# =============================================================================================
# Generation (stock Hermes, plugin-only): still images through Hermes's CONFIGURED `image_generate`.
#
# A confirmed POST snapshots the exact intent (prompt or saved brief + parent hash) under BEGIN IMMEDIATE
# and returns the attempt ID. A second explicit POST .../run claims it once (reserved -> running, atomic)
# and dispatches ONE `image_generate` call through stock's tool server for this request's profile home
# (direct_runner.py). Retake never reads Hermes configuration or credentials and never chooses a
# provider/model. `/retake-generate <id>` (stock_bridge.py) remains a manual fallback inside a chat.
# Attempts are durable records kept separately from immutable versions; a version exists only for
# validated output.
# =============================================================================================
COST_UNKNOWN = store.COST_UNKNOWN
ASPECTS = store.ASPECTS
ACTIVE = store.ACTIVE
EXT = store.EXT
ERRORS = store.ERRORS
OUTCOME = store.OUTCOME
OutputRejected = store.OutputRejected
read_generated_output = store.read_generated_output
sniff_raster = store.sniff_raster
MAX_ATTEMPTS = 100             # per project, all states retained
MAX_GENERATION_BODY = 64 * 1024
MAX_PROMPT = 4000
MAX_REVISION_PROMPT = 32768  # Include the full saved instruction, or refuse before reserving.
BODY_KEYS = frozenset({'client_request_id', 'confirmed', 'prompt', 'aspect_ratio', 'parent_id', 'brief_id', 'image_selection'})
RETRY_NOTE = ('Retake never retries or re-sends an attempt. The configured Hermes image tool or its provider may still '
              'perform its own internal retries or fallback.')

public_attempt = store.public_attempt
error_info = store.error_info

def describe_generation():
    """Truthful, static descriptor of the stock route. Reads nothing from Hermes: no config, no
    provider/model, no readiness or catalog. The configured tool decides everything at call time."""
    return {'available': True, 'route': store.DIRECT, 'command': store.COMMAND, 'tool': store.TOOL,
            'label': 'Hermes configured image generation', 'provider': None, 'model': None, 'readiness': 'unknown',
            'cost': COST_UNKNOWN, 'note': store.SCOPE_NOTE, 'retry_note': RETRY_NOTE, 'reason': None,
            'settings_hint': 'Image generation is configured in Hermes (Capabilities → Tools → Image Generation). Retake never changes it.',
            # Edit support is checked at run time against the tool's own advertised schema (image_url), before the
            # one call; without it the attempt fails with "nothing was sent". Output must also report image input.
            'supports_reference': True, 'revision': {'enabled': True, 'reason': None, 'checked': 'at run time, before sending'},
            'media': ['image'], 'aspect_ratios': list(ASPECTS), 'reference_note': 'Reference-guided; not masked region editing.',
            'reserve_ttl_seconds': store.RESERVE_TTL}

async def bounded_json(request, limit):
    length = request.headers.get('content-length')
    if length:
        try:
            if int(length) > limit or int(length) < 0: fail(413, 'Request too large')
        except ValueError: fail(422, 'Invalid content length')
    chunks, total = [], 0
    async for chunk in request.stream():
        total += len(chunk)
        if total > limit: fail(413, 'Request too large')
        chunks.append(chunk)
    try:
        return json.loads(b''.join(chunks) or b'null')
    except ValueError:
        fail(422, 'Invalid JSON')

def parse_generation(body):
    if not isinstance(body, dict): fail(422, 'Generation request must be a JSON object')
    if 'provider' in body or 'model' in body:
        fail(422, 'Retake no longer chooses an image provider or model: it uses Hermes configured image generation. Nothing was reserved.')
    if set(body) - BODY_KEYS: fail(422, 'Unsupported generation field. Output paths, URLs and provider options are not accepted.')
    if body.get('confirmed') is not True: fail(422, 'Generation must be explicitly confirmed')
    cid = body.get('client_request_id')
    if not isinstance(cid, str) or not ID.fullmatch(cid): fail(422, 'client_request_id must be 32 lowercase hex characters')
    aspect = body.get('aspect_ratio')
    if aspect not in ASPECTS: fail(422, 'aspect_ratio must be landscape, square or portrait')
    parent_id, brief_id = body.get('parent_id'), body.get('brief_id')
    if parent_id is not None or brief_id is not None:
        if parent_id is None or brief_id is None: fail(422, 'A revision needs both the exact parent version and a saved brief')
        ident(parent_id); ident(brief_id)
        if body.get('prompt') not in (None, ''): fail(422, 'Revisions use the saved brief, not a free prompt')
        req = {'kind': 'revision', 'prompt': None, 'parent_id': parent_id, 'brief_id': brief_id}
    else:
        req = {'kind': 'new_asset', 'prompt': text(body.get('prompt'), 'Prompt', MAX_PROMPT), 'parent_id': None, 'brief_id': None}
    sel = body.get('image_selection')
    if sel is not None and (not isinstance(sel, str) or not image_selection.SELECTION_ID.fullmatch(sel)):
        fail(422, 'image_selection must be a listed "provider:model" choice. Nothing was reserved.')
    req.update(client_request_id=cid, aspect_ratio=aspect, image_selection=sel)
    canonical = {k: req[k] for k in ('kind', 'prompt', 'parent_id', 'brief_id', 'aspect_ratio')}
    if sel is not None: canonical['image_selection'] = sel  # absent keeps pre-picker fingerprints identical
    canonical['route'] = store.DIRECT  # never equal to an older route's fingerprint: old IDs cannot be replayed into this route
    req['fingerprint'] = hashlib.sha256(json.dumps(canonical, sort_keys=True).encode()).hexdigest()
    return req

def replay(con, pid, req):
    """Same key + same request → the existing attempt (no dispatch). Same key + different data → 409."""
    row = con.execute('SELECT project_id,fingerprint,data FROM generation_attempts WHERE client_request_id=?', (req['client_request_id'],)).fetchone()
    if not row: return None
    if row[0] != pid or row[1] != req['fingerprint']: fail(409, 'This request ID was already used for a different generation. Nothing was sent.')
    return json.loads(row[2])

def revision_prompt(b):
    lines = ['Revise the supplied reference image (the exact stored version under review).',
             f'Change: {b["change"]}', f'Preserve: {b["preserve"]}']
    notes = []
    for a in (b.get('annotations') or []):
        try:
            if a.get('kind') == 'region':
                r = a['region']
                notes.append(f'- Around x {float(r["x"]):.2f}, y {float(r["y"]):.2f}, width {float(r["width"]):.2f}, height {float(r["height"]):.2f} (fractions of the image): {a["note"]}')
        except Exception:
            fail(422, 'The saved annotation snapshot cannot be used for generation. Nothing was sent.')
    if notes: lines += ['Reviewer notes (approximate areas, guidance only):', *notes]
    lines.append('Keep everything not mentioned above as close to the reference as possible.')
    prompt = '\n'.join(lines)
    if len(prompt) > MAX_REVISION_PROMPT:
        fail(422, 'Saved brief and notes exceed the 32,768-character generation limit. Instructions were not truncated and nothing was sent.')
    return prompt

SELECTION_NOTE = ('Subscription-covered models listed by Hermes for this profile. A listed model is not proof your '
                  'account may run it; entitlement and cost stay unknown until it runs.')

@router.get('/image-selections')
async def image_selections():
    """Read-only: Hermes's own listing for THIS request's profile (no image, no Portal, no network).
    `supported: false` (an older Hermes) means the configured-model flow is used, unchanged."""
    home, _ = bound_profile()
    got = await run_in_threadpool(image_selection.listing, home)
    return {**got, 'note': SELECTION_NOTE, 'cost': COST_UNKNOWN}

@router.get('/generation-capabilities')
async def generation_capabilities():
    # Read-only and static: never generates, never reads Hermes config, sign-in or provider metadata.
    return describe_generation()

def dispatch_hint(attempt):
    if attempt.get('state') != 'reserved': return None
    return {'run': f"/projects/{attempt['project_id']}/generations/{attempt['id']}/run", 'command': store.COMMAND, 'arg': attempt['id']}

@router.post('/projects/{pid}/generations')
async def create_generation(pid: str, request: Request):
    """Reserve ONE durable attempt. Never dispatches: POST .../run (or `/retake-generate <id>`) runs it."""
    ident(pid)
    req = parse_generation(await bounded_json(request, MAX_GENERATION_BODY))
    root = storage_root()
    prompt = req['prompt']
    chosen = None
    if req['image_selection']:
        with db(root) as con:
            existing = replay(con, pid, req)
        if existing is None:  # a replay never re-lists; a new reservation validates the choice now
            home, _ = bound_profile()
            chosen, code = await run_in_threadpool(image_selection.check, home, req['image_selection'], req['kind'] == 'revision')
            if code: fail(409 if code != 'selection_unsupported_host' else 422, store.ERRORS[code].replace('Nothing was sent.', 'Nothing was reserved.'))
    with db(root) as con:
        con.execute('BEGIN IMMEDIATE')
        existing = replay(con, pid, req)
        if existing is not None:
            shown = public_attempt(existing)
            return {'attempt': shown, 'dispatch': dispatch_hint(shown)}
        project(con, pid)
        store.expire_locked(con)
        if con.execute("SELECT count(*) FROM generation_attempts WHERE state IN ('reserved','running')").fetchone()[0]:
            fail(409, 'Another generation is reserved or running in this profile. Wait for it to finish (or cancel an unsent reservation); nothing was reserved.')
        if con.execute('SELECT count(*) FROM generation_attempts WHERE project_id=?', (pid,)).fetchone()[0] >= MAX_ATTEMPTS: fail(409, 'Generation attempt limit reached for this project')
        if con.execute('SELECT count(*) FROM versions WHERE project_id=?', (pid,)).fetchone()[0] >= MAX_VERSIONS: fail(409, 'Version limit reached')
        if con.execute('SELECT coalesce(sum(length(media)),0) FROM versions').fetchone()[0] + MAX_IMAGE_BYTES > MAX_PROFILE_BYTES: fail(413, 'Profile media quota has no room for a generated image')
        snapshot = parent = None
        if req['kind'] == 'revision':
            parent = version(con, pid, req['parent_id'])
            if parent['mime'] not in EXT: fail(422, 'Only still-image versions can be revised with generation. Video generation is not supported.')
            media = con.execute('SELECT media FROM versions WHERE project_id=? AND id=?', (pid, parent['id'])).fetchone()[0]
            if hashlib.sha256(media).hexdigest() != parent['sha256']: fail(409, 'Stored version bytes do not match their recorded hash')
            row = con.execute('SELECT data FROM briefs WHERE project_id=? AND id=?', (pid, req['brief_id'])).fetchone()
            if not row: fail(404, 'Brief not found in project')
            b = json.loads(row[0])
            if b.get('version_id') != parent['id'] or b.get('media_sha256') != parent['sha256'] or b.get('asset_id') != parent['asset_id']:
                fail(409, 'This brief was saved for a different version. Use a brief saved on this exact version.')
            prompt = revision_prompt(b)
            snapshot = {k: b.get(k) for k in ('id', 'version_id', 'asset_id', 'media_sha256', 'change', 'preserve', 'annotations', 'created_at')}
        # Reserve only. The intent is snapshotted exactly; the command reconstructs it from this record.
        attempt = store.record(project_id=pid, kind=req['kind'], state='reserved', client_request_id=req['client_request_id'],
                               route=store.DIRECT, command=store.COMMAND, tool=store.TOOL, scope_note=store.SCOPE_NOTE,
                               prompt=prompt, aspect_ratio=req['aspect_ratio'], provider=None, reported_provider=None,
                               requested_model=chosen['model'] if chosen else None, image_selection=image_selection.snapshot(chosen) if chosen else None,
                               model=None, modality=None, variant_verified=False, cost=COST_UNKNOWN, parent_id=parent['id'] if parent else None,
                               parent_sha256=parent['sha256'] if parent else None, asset_id=parent['asset_id'] if parent else None,
                               brief_id=req['brief_id'], brief=snapshot, version_id=None, error=None, dispatched_at=None, finished_at=None,
                               storage_key=store.storage_key(root))
        con.execute('INSERT INTO generation_attempts VALUES (?,?,?,?,?,?)', (attempt['id'], pid, req['client_request_id'], req['fingerprint'], 'reserved', json.dumps(attempt)))
    shown = public_attempt(attempt)
    return {'attempt': shown, 'dispatch': dispatch_hint(shown)}

def profile_home():
    from hermes_constants import get_hermes_home
    return Path(get_hermes_home())

def bound_profile():
    """(home, store root) of THIS request's authenticated profile; the store must live in that home."""
    root = storage_root()
    try:
        home = profile_home()
    except Exception:
        fail(503, 'The Hermes profile for this request could not be determined. Nothing was sent.')
    if os.path.realpath(root.parent) != os.path.join(os.path.realpath(home), 'plugin-data'):
        fail(503, 'Retake storage does not belong to this request’s profile. Nothing was sent.')
    return home, root

@router.post('/projects/{pid}/generations/{gid}/run')
async def run_generation(pid: str, gid: str):
    """Explicit: claim ONE reserved attempt of this profile and run it once in the background.
    A second call, a replay or another profile's ID is refused with nothing sent; never retried."""
    ident(pid); ident(gid)
    home, root = bound_profile()
    with db(root) as con:
        project(con, pid)
        row = con.execute('SELECT project_id FROM generation_attempts WHERE id=?', (gid,)).fetchone()
        if not row or row[0] != pid: fail(404, 'Generation attempt not found')
    refuse = None
    with db(root) as con:
        pending = json.loads(con.execute('SELECT data FROM generation_attempts WHERE id=?', (gid,)).fetchone()[0])
    snap = pending.get('image_selection') if pending.get('state') == 'reserved' else None
    if snap:  # re-validate the confirmed choice from a FRESH listing; any change fails closed at claim
        fresh, code = await run_in_threadpool(image_selection.check, home, snap['id'], pending.get('kind') == 'revision', True)
        refuse = code or ('selection_changed' if image_selection.changed(snap, fresh) else None)
    try:
        a, refusal = direct_runner.start(root, home, gid, refuse=refuse)
    except store.UnsafeStorage:
        fail(503, 'Unsafe plugin storage')
    with db(root) as con:
        current = public_attempt(json.loads(con.execute('SELECT data FROM generation_attempts WHERE id=?', (gid,)).fetchone()[0]))
    if refusal: return {'attempt': current, 'started': False, 'reason': refusal}
    return {'attempt': current, 'started': True, 'reason': None}

@router.post('/projects/{pid}/generations/{gid}/cancel')
async def cancel_generation(pid: str, gid: str):
    """Release a reservation Hermes has not claimed. A claimed/finished attempt is returned unchanged."""
    with db() as con:
        con.execute('BEGIN IMMEDIATE')
        project(con, pid); ident(gid)
        row = con.execute('SELECT data FROM generation_attempts WHERE project_id=? AND id=?', (pid, gid)).fetchone()
        if not row: fail(404, 'Generation attempt not found')
        a = json.loads(row[0])
        if a.get('state') == 'reserved':
            a.update(state='failed', error=error_info('cancelled'), finished_at=store.now_iso())
            con.execute('UPDATE generation_attempts SET state=?,data=? WHERE id=?', ('failed', json.dumps(a), gid))
        return {'attempt': public_attempt(a)}

@router.get('/projects/{pid}/generations/{gid}')
async def read_generation(pid: str, gid: str):
    with db() as con:
        project(con, pid); ident(gid)
        row = con.execute('SELECT data FROM generation_attempts WHERE project_id=? AND id=?', (pid, gid)).fetchone()
        if not row: fail(404, 'Generation attempt not found')
        return {'attempt': public_attempt(json.loads(row[0]))}
