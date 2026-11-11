"""Isolated real ASGI tests; no live Hermes plugin loading or profile reads."""
import asyncio
import base64
import importlib.util
import io
import json
import os
from pathlib import Path
import sys
import tempfile
import types
import unittest
from unittest.mock import patch
import httpx
from PIL import Image

ROOT = Path(__file__).resolve().parents[2]
API = ROOT / 'dashboard/plugin_api.py'

class RetakeTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.home = Path(self.tmp.name)
        self.scope = self.home / 'alpha'
        # Stub only the public storage resolver, not implementation or HTTP.
        storage = types.ModuleType('plugins.plugin_storage')
        storage.plugin_data_dir = lambda name: self.scope / 'plugin-data' / name
        self.mock = patch.dict(sys.modules, {'plugins.plugin_storage': storage})
        self.mock.start()
        spec = importlib.util.spec_from_file_location('retake_test_api', API)
        self.api = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(self.api)
        from fastapi import FastAPI
        self.app = FastAPI()
        self.app.include_router(self.api.router, prefix='/api/plugins/retake')
        out = io.BytesIO(); Image.new('RGB', (16, 12), 'purple').save(out, 'PNG')
        self.png = out.getvalue()
    def tearDown(self):
        self.mock.stop(); self.tmp.cleanup()
    def run_async(self, fn):
        async def run():
            async with httpx.AsyncClient(transport=httpx.ASGITransport(app=self.app), base_url='http://fixture/api/plugins/retake') as c:
                await fn(c)
        asyncio.run(run())
    def test_review_lineage_annotations_and_draft_persist(self):
        async def flow(c):
            self.assertFalse(self.scope.exists(), 'import must be inert')
            p = (await c.post('/projects', json={'name':'Campaign'})).json(); pid=p['id']
            async def upload(parent=''):
                r=await c.post(f'/projects/{pid}/versions'+(f'?parent_id={parent}' if parent else ''),files={'file':('take.png',self.png,'image/png')})
                self.assertEqual(r.status_code,200,r.text); return r.json()
            a=await upload(); b=await upload(a['id'])
            self.assertEqual(b['parent_id'],a['id']); self.assertEqual(b['asset_id'],a['asset_id'])
            path=f'/projects/{pid}/versions/{a["id"]}'
            self.assertEqual((await c.post(path+'/review',json={'status':'rejected'})).status_code,200)
            ann=(await c.post(path+'/annotations',json={'kind':'region','note':'Move caption','region':{'x':.1,'y':.2,'width':.3,'height':.4}})).json()
            r=await c.post(path+'/briefs',json={'change':'Move caption','preserve':'Palette'}); self.assertEqual(r.status_code,200,r.text)
            brief=r.json(); self.assertTrue(brief['draft_only']); self.assertEqual(brief['annotations'][0]['id'],ann['id'])
            self.assertEqual((await c.get(f'/projects/{pid}/briefs/{brief["id"]}')).json(),brief)
            board=(await c.get(f'/projects/{pid}')).json(); self.assertEqual(len(board['versions']),2); self.assertEqual(board['versions'][0]['status'],'rejected')
            media=(await c.get(path+'/media')).json(); self.assertEqual(base64.b64decode(media['base64']),self.png)
            self.assertNotIn(str(self.home),str(board)+str(media))
            self.scope=self.home/'beta'; self.assertEqual((await c.get('/projects')).json(),{'projects':[]})
            self.assertEqual((await c.get(f'/projects/{pid}')).status_code,404)
            self.scope=self.home/'alpha'; self.assertEqual(len((await c.get('/projects')).json()['projects']),1)
        self.run_async(flow)
    def test_safety_boundaries(self):
        async def flow(c):
            pid=(await c.post('/projects',json={'name':'Boundaries'})).json()['id']
            path=f'/projects/{pid}/versions'
            for data,mime in [(b'<svg/>','image/svg+xml'),(b'<html/>','image/png'),(self.png,'text/html')]:
                self.assertEqual((await c.post(path,content=data,headers={'content-type':mime})).status_code,415)
            v=(await c.post(path,content=self.png,headers={'content-type':'image/png'})).json()
            vp=path+'/'+v['id']
            for region in [{'x':.9,'y':0,'width':.2,'height':.2},{'x':0,'y':0,'width':float('inf'),'height':1},{'x':0,'y':0,'width':True,'height':1}]:
                # HTTP JSON cannot encode infinities: raw request for that case.
                import json
                r=await c.post(vp+'/annotations',content=json.dumps({'kind':'region','note':'x','region':region}),headers={'content-type':'application/json'})
                self.assertEqual(r.status_code,422,r.text)
            self.assertEqual((await c.post(vp+'/annotations',json={'kind':'timestamp','note':'x','timestamp':0})).status_code,422)
            self.assertEqual((await c.post(vp+'/review',json={'status':'deleted'})).status_code,422)
            other=(await c.post('/projects',json={'name':'Other'})).json()['id']
            self.assertEqual((await c.post(f'/projects/{other}/versions?parent_id={v["id"]}',content=self.png,headers={'content-type':'image/png'})).status_code,404)
            self.assertEqual((await c.get('/projects/not-an-id')).status_code,422)
            with patch.object(self.api,'MAX_IMAGE_BYTES',10):
                self.assertEqual((await c.post(path,content=self.png,headers={'content-type':'image/png'})).status_code,413)
        self.run_async(flow)

    def test_thumbnails_are_bounded_scoped_and_leave_originals_unchanged(self):
        def encode(image, fmt):
            out = io.BytesIO(); image.save(out, fmt); return out.getvalue()
        wide = encode(Image.new('RGB', (1200, 300), 'orange'), 'JPEG')
        tall = encode(Image.new('RGBA', (90, 400), (10, 20, 30, 128)), 'PNG')
        async def flow(c):
            pid=(await c.post('/projects',json={'name':'Covers'})).json()['id']
            self.assertIsNone((await c.get('/projects')).json()['projects'][0]['cover_version'])
            async def upload(name, data, mime):
                r=await c.post(f'/projects/{pid}/versions',files={'file':(name,data,mime)}); self.assertEqual(r.status_code,200,r.text); return r.json()
            a=await upload('wide.jpg',wide,'image/jpeg'); b=await upload('tall.png',tall,'image/png')
            before=(await c.get(f'/projects/{pid}')).json()
            for v,src,(ow,oh) in [(a,wide,(1200,300)),(b,tall,(90,400))]:
                r=await c.get(f'/projects/{pid}/versions/{v["id"]}/thumbnail'); self.assertEqual(r.status_code,200,r.text)
                self.assertEqual(r.headers['cache-control'],'no-store')
                t=r.json(); self.assertEqual((t['kind'],t['mime'],t['version_id']),('image','image/png',v['id']))
                raw=base64.b64decode(t['base64']); self.assertLessEqual(len(raw),256*1024)
                with Image.open(io.BytesIO(raw)) as im:
                    self.assertEqual(im.format,'PNG'); self.assertEqual(im.size,(t['width'],t['height']))
                    self.assertLessEqual(im.width,240); self.assertLessEqual(im.height,180)
                    self.assertTrue(im.width==240 or im.height==180)
                    self.assertAlmostEqual(im.width/im.height,ow/oh,delta=ow/oh*.05)
                media=(await c.get(f'/projects/{pid}/versions/{v["id"]}/media')).json()
                self.assertEqual(base64.b64decode(media['base64']),src)
            self.assertEqual((await c.get(f'/projects/{pid}')).json(),before,'thumbnailing must not change records')
            listing=(await c.get('/projects')).json()
            self.assertEqual(listing['projects'][0]['cover_version'],{'id':a['id'],'project_id':pid,'mime':'image/jpeg','name':'wide.jpg'})
            self.assertNotIn('base64',json.dumps(listing))
            other=(await c.post('/projects',json={'name':'Other'})).json()['id']
            self.assertEqual((await c.get(f'/projects/{other}/versions/{a["id"]}/thumbnail')).status_code,404)
            self.assertEqual((await c.get(f'/projects/{pid}/versions/not-an-id/thumbnail')).status_code,422)
            self.assertEqual(sorted(p.name for p in (self.scope/'plugin-data'/'retake').iterdir()),['retake.sqlite3'],'no thumbnail files on disk')
            self.scope=self.home/'beta'
            self.assertEqual((await c.get(f'/projects/{pid}/versions/{a["id"]}/thumbnail')).status_code,404)
            self.assertEqual((await c.get('/projects')).json(),{'projects':[]})
            self.scope=self.home/'alpha'
            self.assertEqual((await c.get(f'/projects/{pid}/versions/{a["id"]}/thumbnail')).status_code,200)
        self.run_async(flow)

    def test_video_multipart_duration_and_timestamp_bounds(self):
        import shutil
        import subprocess
        if not shutil.which('ffmpeg'): self.skipTest('Optional video fixture requires ffmpeg')
        clip=self.home/'clip.mp4'
        subprocess.run(['ffmpeg','-hide_banner','-loglevel','error','-y','-f','lavfi','-i','color=c=purple:s=64x48:d=2','-c:v','libx264','-pix_fmt','yuv420p',str(clip)],check=True,timeout=20)
        raw=clip.read_bytes()
        async def flow(c):
            pid=(await c.post('/projects',json={'name':'Video'})).json()['id']
            r=await c.post(f'/projects/{pid}/versions',files={'file':('clip.mp4',raw,'video/mp4')})
            self.assertEqual(r.status_code,200,r.text); v=r.json(); self.assertAlmostEqual(v['duration'],2,places=1)
            vp=f'/projects/{pid}/versions/{v["id"]}'
            self.assertEqual((v['width'],v['height']),(64,48))
            for timestamp in [-.1,2.1,True]:
                self.assertEqual((await c.post(vp+'/annotations',json={'kind':'timestamp','timestamp':timestamp,'note':'hold'})).status_code,422)
            self.assertEqual((await c.post(vp+'/annotations',json={'kind':'timestamp','timestamp':1.2,'note':'hold'})).status_code,200)
            thumb=(await c.get(vp+'/thumbnail')).json(); self.assertEqual(thumb,{'kind':'video','version_id':v['id']})
            self.assertIsNone(next(p for p in (await c.get('/projects')).json()['projects'] if p['id']==pid)['cover_version'],'video-only project has no fake cover')
            b=(await c.post(vp+'/briefs',json={'change':'Hold frame','preserve':'Framing'})).json()
            self.assertEqual(b['annotations'][0]['timestamp'],1.2)
            self.assertEqual((await c.post(f'/projects/{pid}/versions',files={'file':('bad.mp4',b'not video','video/mp4')})).status_code,415)
            # Mutate only the duration field to prove a >120s movie is refused.
            import struct
            bad=bytearray(raw); pos=bad.index(b'mvhd')+4; scale=struct.unpack_from('>I',bad,pos+12)[0]; struct.pack_into('>I',bad,pos+16,121*scale)
            self.assertEqual((await c.post(f'/projects/{pid}/versions',files={'file':('long.mp4',bytes(bad),'video/mp4')})).status_code,422)
            bad=raw.replace(b'url \x00\x00\x00\x01',b'url \x00\x00\x00\x00')
            self.assertNotEqual(bad,raw)
            self.assertEqual((await c.post(f'/projects/{pid}/versions',files={'file':('external.mp4',bad,'video/mp4')})).status_code,415)
        self.run_async(flow)

    # --- JSON (base64) upload: the OAuth-safe ctx.rest body channel. Same checks as multipart. ---
    def test_json_upload_is_byte_identical_and_keeps_every_check(self):
        b64 = lambda raw: base64.b64encode(raw).decode()
        def img(fmt, size=(16, 12), **kw):
            out = io.BytesIO(); Image.new('RGB', size, 'teal').save(out, fmt, **kw); return out.getvalue()
        async def flow(c):
            pid = (await c.post('/projects', json={'name': 'JSON'})).json()['id']
            post = lambda body, q='': c.post(f'/projects/{pid}/versions{q}', json=body)
            seen = {}
            for name, mime, raw in [('a.png', 'image/png', self.png), ('b.jpg', 'image/jpeg', img('JPEG')), ('c.webp', 'image/webp', img('WEBP'))]:
                r = await post({'filename': name, 'content_type': mime, 'data_base64': b64(raw)}); self.assertEqual(r.status_code, 200, r.text)
                v = r.json(); seen[name] = v
                m = (await c.get(f'/projects/{pid}/versions/{v["id"]}/media')).json()
                self.assertEqual(base64.b64decode(m['base64']), raw, 'stored bytes are exactly the uploaded bytes')
                multi = (await c.post(f'/projects/{pid}/versions', files={'file': (name, raw, mime)})).json()
                keys = ('sha256', 'size', 'mime', 'name', 'width', 'height')
                self.assertEqual({k: multi[k] for k in keys}, {k: v[k] for k in keys}, 'JSON and multipart store the same record')
            first = seen['a.png']
            nxt = (await post({'filename': 'a2.png', 'content_type': 'image/png', 'data_base64': b64(self.png)}, f'?parent_id={first["id"]}')).json()
            self.assertEqual((nxt['parent_id'], nxt['asset_id']), (first['id'], first['asset_id']))
            ok = {'filename': 'x.png', 'content_type': 'image/png', 'data_base64': b64(self.png)}
            before = (await c.get(f'/projects/{pid}')).json()['versions']
            split = b64(self.png)
            for body, code in [({**ok, 'extra': 1}, 422), ({k: ok[k] for k in ('filename', 'content_type')}, 422),
                               ({**ok, 'url': 'https://example.invalid/a.png'}, 422),
                               ({'filename': 'x.png', 'content_type': 'image/png', 'path': '/etc/passwd'}, 422),
                               ({**ok, 'filename': 7}, 422), ([ok], 422),
                               ({**ok, 'data_base64': 'abc$'}, 422), ({**ok, 'data_base64': split[:20] + '\n' + split[20:]}, 422),
                               ({**ok, 'data_base64': ''}, 413), ({**ok, 'content_type': 'text/plain'}, 415),
                               ({**ok, 'content_type': 'image/jpeg'}, 415),
                               ({**ok, 'data_base64': 'A' * (self.api.b64len(self.api.MAX_IMAGE_BYTES) + 4)}, 413)]:
                r = await post(body); self.assertEqual(r.status_code, code, (str(body)[:80], r.text))
            frames = [Image.new('RGB', (8, 8), c) for c in ('red', 'blue')]; out = io.BytesIO()
            frames[0].save(out, 'WEBP', save_all=True, append_images=frames[1:])
            self.assertEqual((await post({**ok, 'content_type': 'image/webp', 'data_base64': b64(out.getvalue())})).status_code, 415, 'animated WebP refused')
            huge = b'{"filename":"x.png","content_type":"image/png","data_base64":"' + b'A' * self.api.MAX_UPLOAD_JSON + b'"}'
            self.assertEqual((await c.post(f'/projects/{pid}/versions', content=huge, headers={'content-type': 'application/json'})).status_code, 413, 'encoded body bound')
            with patch.object(self.api, 'MAX_PIXELS', 100):
                self.assertEqual((await post(ok)).status_code, 415, 'pixel bound applies')
            with patch.object(self.api, 'MAX_PROFILE_BYTES', 1):
                self.assertEqual((await post(ok)).status_code, 413, 'profile quota applies')
            self.assertEqual((await c.get(f'/projects/{pid}')).json()['versions'], before, 'refusals store nothing')
            r = await post({**ok, 'filename': '../../etc/pass\x07wd.png'}); self.assertEqual(r.json()['name'], 'passwd.png', 'filename stays display-only')
            other = (await c.post('/projects', json={'name': 'Other'})).json()['id']
            self.assertEqual((await c.post(f'/projects/{other}/versions?parent_id={first["id"]}', json=ok)).status_code, 404, 'parent must be in the same project')
        self.run_async(flow)

    def test_json_upload_video_parity_and_parent_kind(self):
        import shutil, subprocess
        if not shutil.which('ffmpeg'): self.skipTest('ffmpeg unavailable')
        clip = self.home / 'clip.mp4'
        subprocess.run(['ffmpeg', '-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=purple:s=64x48:d=2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', str(clip)], check=True, timeout=20)
        raw = clip.read_bytes(); enc = base64.b64encode(raw).decode()
        async def flow(c):
            pid = (await c.post('/projects', json={'name': 'Video'})).json()['id']
            v = (await c.post(f'/projects/{pid}/versions', json={'filename': 'clip.mp4', 'content_type': 'video/mp4', 'data_base64': enc})).json()
            self.assertEqual((v['mime'], v['duration'] > 1.9), ('video/mp4', True))
            m = (await c.get(f'/projects/{pid}/versions/{v["id"]}/media')).json(); self.assertEqual(base64.b64decode(m['base64']), raw)
            img = (await c.post(f'/projects/{pid}/versions', json={'filename': 'a.png', 'content_type': 'image/png', 'data_base64': base64.b64encode(self.png).decode()})).json()
            r = await c.post(f'/projects/{pid}/versions?parent_id={img["id"]}', json={'filename': 'clip.mp4', 'content_type': 'video/mp4', 'data_base64': enc})
            self.assertEqual(r.status_code, 422, 'parent media kind preserved')
            self.assertEqual((await c.post(f'/projects/{pid}/versions', json={'filename': 'bad.mp4', 'content_type': 'video/mp4', 'data_base64': base64.b64encode(b'not video').decode()})).status_code, 415)
        self.run_async(flow)

    # --- Project deletion: explicit, scoped, transactional, refused while an attempt is unresolved. ---
    def test_delete_project_is_scoped_confirmed_and_blocked_by_open_attempts(self):
        def sql(q, *a):
            with self.api.store.connect(self.api.storage_root()) as con:
                return con.execute(q, a).fetchall()
        async def flow(c):
            async def seeded(name):
                pid = (await c.post('/projects', json={'name': name})).json()['id']
                up = lambda q='': c.post(f'/projects/{pid}/versions{q}', files={'file': ('t.png', self.png, 'image/png')})
                a = (await up()).json(); b = (await up(f'?parent_id={a["id"]}')).json()
                await c.post(f'/projects/{pid}/versions/{a["id"]}/review', json={'status': 'rejected'})
                await c.post(f'/projects/{pid}/versions/{b["id"]}/annotations', json={'kind': 'region', 'note': 'n', 'region': {'x': .1, 'y': .1, 'width': .2, 'height': .2}})
                await c.post(f'/projects/{pid}/versions/{b["id"]}/briefs', json={'change': 'c', 'preserve': 'p'})
                return pid
            target, keep = await seeded('Target'), await seeded('Keep')
            keep_board = (await c.get(f'/projects/{keep}')).json()
            alpha = self.scope; self.scope = self.home / 'beta'  # another profile's store, same router
            beta = (await c.post('/projects', json={'name': 'Target'})).json()['id']
            self.assertEqual((await c.request('DELETE', f'/projects/{target}', json={'confirm_name': 'Target'})).status_code, 404, 'other profile cannot reach it')
            self.scope = alpha
            delete = lambda body: c.request('DELETE', f'/projects/{target}', json=body)
            tables = ('projects', 'versions', 'reviews', 'annotations', 'briefs')
            snapshot = lambda: [sql(f'SELECT count(*) FROM {t}')[0][0] for t in tables]
            start = snapshot()
            for body in [{'confirm_name': 'target'}, {}, {'confirm_name': 'Target', 'force': True}, None]:
                r = await delete(body); self.assertEqual(r.status_code, 422, r.text)
            self.assertEqual(snapshot(), start, 'cancelled/invalid confirmation removes nothing')
            for i, state in enumerate(('reserved', 'running', 'unknown')):
                sql('INSERT INTO generation_attempts VALUES (?,?,?,?,?,?)', f'g{i}', target, f'cid{i}', 'fp', state, json.dumps({'id': f'g{i}', 'project_id': target, 'state': state}))
                r = await delete({'confirm_name': 'Target'}); self.assertEqual(r.status_code, 409, r.text); self.assertIn('Nothing was removed', r.json()['detail'])
                self.assertEqual(snapshot(), start, f'refusal while {state} is non-destructive')
                sql('UPDATE generation_attempts SET state=? WHERE id=?', 'failed', f'g{i}')
            r = await delete({'confirm_name': 'Target'}); self.assertEqual(r.status_code, 200, r.text)
            self.assertEqual([r.json()[k] for k in ('versions', 'notes', 'instructions', 'attempts')], [2, 1, 1, 3])
            self.assertEqual((await c.get(f'/projects/{target}')).status_code, 404)
            left = sum(sql(f'SELECT count(*) FROM {t} WHERE project_id=?', target)[0][0] for t in ('versions', 'briefs', 'generation_attempts'))
            self.assertEqual(left, 0)
            orphans = sql('SELECT count(*) FROM reviews WHERE version_id NOT IN (SELECT id FROM versions)')[0][0] + sql('SELECT count(*) FROM annotations WHERE version_id NOT IN (SELECT id FROM versions)')[0][0]
            self.assertEqual(orphans, 0, 'no orphaned reviews or notes')
            self.assertEqual((await c.get(f'/projects/{keep}')).json(), keep_board, 'other project untouched')
            self.assertEqual([p['id'] for p in (await c.get('/projects')).json()['projects']], [keep])
            self.scope = self.home / 'beta'
            self.assertEqual([p['id'] for p in (await c.get('/projects')).json()['projects']], [beta], 'other profile untouched')
            self.scope = alpha
            self.assertEqual((await c.request('DELETE', f'/projects/{target}', json={'confirm_name': 'Target'})).status_code, 404, 'already gone')
        self.run_async(flow)

    def test_approval_is_one_pick_per_asset(self):
        async def flow(c):
            pid = (await c.post('/projects', json={'name': 'Pick'})).json()['id']
            up = lambda q='': c.post(f'/projects/{pid}/versions{q}', files={'file': ('t.png', self.png, 'image/png')})
            a = (await up()).json(); b = (await up(f'?parent_id={a["id"]}')).json(); c3 = (await up(f'?parent_id={b["id"]}')).json(); other = (await up()).json()
            review = lambda v, s: c.post(f'/projects/{pid}/versions/{v["id"]}/review', json={'status': s})
            await review(c3, 'rejected'); await review(other, 'selected')
            self.assertEqual((await review(a, 'selected')).json()['unapproved'], [])
            r = (await review(b, 'selected')).json(); self.assertEqual(r['unapproved'], [a['id']])
            st = {v['id']: v['status'] for v in (await c.get(f'/projects/{pid}')).json()['versions']}
            self.assertEqual([st[a['id']], st[b['id']], st[c3['id']], st[other['id']]], ['needs_revision', 'selected', 'rejected', 'selected'], 'one pick per asset; rejected and other assets untouched')
            self.assertEqual((await review(b, 'needs_revision')).json()['unapproved'], [], 'un-approving moves nothing')
        self.run_async(flow)

    def test_asset_rename_is_a_display_name_only(self):
        async def flow(c):
            pid = (await c.post('/projects', json={'name': 'Names'})).json()['id']
            other = (await c.post('/projects', json={'name': 'Other'})).json()['id']
            up = lambda p, q='': c.post(f'/projects/{p}/versions{q}', files={'file': ('generated-1a2b3c4d.png', self.png, 'image/png')})
            a = (await up(pid)).json(); foreign = (await up(other)).json()
            before = (await c.get(f'/projects/{pid}')).json()['versions']
            name = lambda body, p=pid, aid=a['asset_id']: c.post(f'/projects/{p}/assets/{aid}/name', json=body)
            r = await name({'name': '  Hero radio  '}); self.assertEqual(r.json(), {'asset_id': a['asset_id'], 'name': 'Hero radio'})
            board = (await c.get(f'/projects/{pid}')).json()
            self.assertEqual(board['asset_names'], {a['asset_id']: 'Hero radio'}); self.assertEqual(board['versions'], before, 'versions, files and IDs unchanged')
            for body, code in [({'name': 'x' * 121}, 422), ({'name': 7}, 422), ({'name': 'a', 'x': 1}, 422), ({}, 422)]:
                self.assertEqual((await name(body)).status_code, code, body)
            self.assertEqual((await name({'name': 'Stolen'}, aid=foreign['asset_id'])).status_code, 404, 'asset must belong to the project')
            self.assertEqual((await c.get(f'/projects/{other}')).json()['asset_names'], {})
            self.assertEqual((await name({'name': ' '})).json()['name'], None)
            self.assertEqual((await c.get(f'/projects/{pid}')).json()['asset_names'], {}, 'empty restores the default name')
            await name({'name': 'Again'})
            self.assertEqual((await c.request('DELETE', f'/projects/{pid}', json={'confirm_name': 'Names'})).status_code, 200)
            with self.api.store.connect(self.api.storage_root()) as con:
                self.assertEqual(con.execute('SELECT count(*) FROM asset_names WHERE project_id=?', (pid,)).fetchone()[0], 0, 'project delete removes its names')
        self.run_async(flow)

    def test_project_rename_changes_only_its_name(self):
        async def flow(c):
            made = (await c.post('/projects', json={'name': 'Before'})).json(); pid = made['id']
            other = (await c.post('/projects', json={'name': 'Other'})).json()['id']
            await c.post(f'/projects/{pid}/versions', files={'file': ('a.png', self.png, 'image/png')})
            before = (await c.get(f'/projects/{pid}')).json()
            name = lambda body, p=pid: c.post(f'/projects/{p}/name', json=body)
            r = await name({'name': '  After  '}); self.assertEqual(r.status_code, 200, r.text)
            self.assertEqual(r.json(), {**made, 'name': 'After'}, 'trimmed; id and created_at kept')
            board = (await c.get(f'/projects/{pid}')).json()
            self.assertEqual(board['project'], {**made, 'name': 'After'})
            self.assertEqual(board['versions'], before['versions'], 'versions and IDs unchanged')
            for body in [{'name': ''}, {'name': '   '}, {'name': 'x' * 121}, {'name': 7}, {'name': None}, {'name': 'a', 'x': 1}, {}]:
                self.assertEqual((await name(body)).status_code, 422, body)
            self.assertEqual((await c.post(f'/projects/{pid}/name', content=b'[]', headers={'Content-Type': 'application/json'})).status_code, 422, 'non-object body')
            self.assertEqual((await name({'name': 'x' * 120})).status_code, 200, '120 is the limit')
            await name({'name': 'After'})
            self.assertEqual((await name({'name': 'Ghost'}, p='f' * 32)).status_code, 404)
            names = {p['id']: p['name'] for p in (await c.get('/projects')).json()['projects']}
            self.assertEqual(names, {pid: 'After', other: 'Other'}, 'only this project renamed')
            self.assertEqual((await c.request('DELETE', f'/projects/{pid}', json={'confirm_name': 'Before'})).status_code, 422, 'the old name no longer confirms')
            self.assertEqual((await c.request('DELETE', f'/projects/{pid}', json={'confirm_name': 'After'})).status_code, 200)
        self.run_async(flow)

if __name__ == '__main__': unittest.main(verbosity=2)
