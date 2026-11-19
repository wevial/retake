"""`/retake-generate <attempt-id>`: run ONE reserved Retake attempt through stock Hermes.

Public surfaces only: the slash-command call (the host binds the caller's session profile home),
`plugins.plugin_storage.plugin_data_dir('retake')` and `ctx.dispatch_tool('image_generate', args)`.
No provider registry, constructor, facade, config write or renderer internals.

Order of operations (each one fail-closed, none of them retried):
  1. the argument must be exactly one 32-hex attempt ID — checked before ANY storage access;
  2. the profile the host bound for this call must be the profile this plugin registered in;
  3. BEGIN IMMEDIATE: the attempt must exist in THIS profile's store, still be `reserved`, carry
     this store's key and not be expired; it is flipped to `running` and the transaction ends;
  4. outside any transaction: one `image_generate` call with the attempt's snapshotted intent;
  5. owned cache output only -> validated -> version + attempt bound in one transaction. A bare HTTPS
     result URL (FAL) is first downloaded once into that cache by Hermes's SSRF-guarded helper.
A repeated command for the same ID is never permission to regenerate: step 3 refuses it.
"""
import base64
import hashlib
import json
import logging
import os
import uuid

from . import retake_store as store

log = logging.getLogger(__name__)

def _say(aid, text):
    return f'Retake attempt {aid[:8]}…: {text}' if aid else f'Retake: {text}'

def valid_attempt_id(raw):
    """The ONLY accepted argument shape. Anything else never reaches storage or the tool."""
    if not isinstance(raw, str): return None
    value = raw.strip()
    return value if store.ID.fullmatch(value) else None

def current_home():
    from hermes_constants import get_hermes_home
    return get_hermes_home()

def same_path(a, b):
    try:
        return os.path.realpath(a) == os.path.realpath(b)
    except Exception:
        return False

def resolve_root(pinned_home):
    """This call's profile-local store, resolved by the public helper and checked against the home
    this plugin registered under. A mismatch (call bound to another profile) refuses."""
    if not pinned_home: return None, 'this plugin could not determine its own Hermes profile; nothing was sent.'
    try:
        home = current_home()
    except Exception:
        return None, 'the Hermes profile for this call could not be determined; nothing was sent.'
    if not same_path(home, pinned_home):
        return None, 'this command was invoked for a different Hermes profile than Retake is registered in; nothing was sent.'
    from plugins.plugin_storage import plugin_data_dir
    root = plugin_data_dir('retake')
    if not same_path(os.path.dirname(os.path.realpath(root)), os.path.join(os.path.realpath(pinned_home), 'plugin-data')):
        return None, 'Retake storage does not belong to this profile; nothing was sent.'
    if not (root / 'retake.sqlite3').is_file():
        return None, 'no Retake attempt with that ID exists in this profile; nothing was sent.'
    return root, None

def claim(root, aid, revision_ok=None, via=None, refuse=None):
    """Atomically reserved -> running. Returns (attempt, reference_bytes, refusal).
    `revision_ok`: whether this transport may send a reference (the command path: store.REVISION_QUALIFIED;
    the direct path checks the tool's advertised schema before its one call). `via` is recorded."""
    revision_ok = store.REVISION_QUALIFIED if revision_ok is None else revision_ok
    with store.connect(root) as con:
        con.execute('BEGIN IMMEDIATE')
        row = con.execute('SELECT data FROM generation_attempts WHERE id=?', (aid,)).fetchone()
        if not row: return None, None, 'no Retake attempt with that ID exists in this profile; nothing was sent.'
        a = json.loads(row[0])
        if a.get('storage_key') != store.storage_key(root):
            return None, None, 'that attempt was not reserved in this profile’s store; nothing was sent.'
        late = store.expiry(a)
        if late and a.get('state') == 'reserved':
            a.update(state=late[0], error=late[1], finished_at=store.now_iso())
            con.execute('UPDATE generation_attempts SET state=?,data=? WHERE id=?', (a['state'], json.dumps(a), aid))
            return None, None, 'the reservation expired before Hermes ran it; nothing was sent.'
        if a.get('state') != 'reserved':
            return None, None, f'already {a.get("state")}; Retake never runs an attempt twice. Nothing was sent.'
        if refuse:  # the confirmed image model failed its claim-time re-check: fail closed, nothing sent
            a.update(state='failed', error=store.error_info(refuse), finished_at=store.now_iso())
            con.execute('UPDATE generation_attempts SET state=?,data=? WHERE id=?', ('failed', json.dumps(a), aid))
            return None, None, store.ERRORS[refuse]
        reference = None
        if a.get('kind') == 'revision':
            media = None
            if revision_ok:
                got = con.execute('SELECT media FROM versions WHERE project_id=? AND id=?', (a['project_id'], a.get('parent_id'))).fetchone()
                media = bytes(got[0]) if got else None
            if not revision_ok or media is None or hashlib.sha256(media).hexdigest() != a.get('parent_sha256'):
                a.update(state='failed', error=store.error_info('not_dispatched'), finished_at=store.now_iso())
                con.execute('UPDATE generation_attempts SET state=?,data=? WHERE id=?', ('failed', json.dumps(a), aid))
                return None, None, 'the revision could not be sent (automatic revision unavailable or parent changed); nothing was sent.'
            reference = media
        if a.get('aspect_ratio') not in store.ASPECTS or not isinstance(a.get('prompt'), str) or not a['prompt'].strip():
            a.update(state='failed', error=store.error_info('not_dispatched'), finished_at=store.now_iso())
            con.execute('UPDATE generation_attempts SET state=?,data=? WHERE id=?', ('failed', json.dumps(a), aid))
            return None, None, 'the reserved intent is unusable; nothing was sent.'
        a.update(state='running', dispatched_at=store.now_iso(), claimed_via=via or store.COMMAND)
        con.execute('UPDATE generation_attempts SET state=?,data=? WHERE id=?', ('running', json.dumps(a), aid))
    return a, reference, None

def tool_args(a, reference):
    args = {'prompt': a['prompt'], 'aspect_ratio': a['aspect_ratio']}
    if reference is not None:
        mime = store.sniff_raster(reference)
        # Exact owned raster as an inline data URI: never a filesystem path or hosted URL.
        args['image_url'] = f'data:{mime};base64,{base64.b64encode(reference).decode("ascii")}'
    return args

def finish(root, aid, state, error, **extra):
    with store.connect(root) as con:
        con.execute('BEGIN IMMEDIATE')
        a = json.loads(con.execute('SELECT data FROM generation_attempts WHERE id=?', (aid,)).fetchone()[0])
        if not open_for_result(a): return a
        a.update(state=state, error=error, finished_at=store.now_iso(), **extra)
        con.execute('UPDATE generation_attempts SET state=?,data=? WHERE id=?', (state, json.dumps(a), aid))
        return a

def open_for_result(a):
    late = store.expiry(a)
    return a.get('state') == 'running' or (late is not None and late[1]['code'] == 'stale') or \
        (a.get('state') == 'unknown' and (a.get('error') or {}).get('code') == 'stale')

def reported(result):
    """What the tool itself says it used. Recorded as reported; the exact variant is not verified."""
    out = {}
    for key, rule in (('reported_provider', store.SAFE_NAME), ('model', store.SAFE_MODEL), ('fallback_from', store.SAFE_NAME)):
        source = {'reported_provider': 'provider'}.get(key, key)
        value = result.get(source)
        out[key] = value if isinstance(value, str) and rule.fullmatch(value) else None
    out['modality'] = result.get('modality') if result.get('modality') in ('text', 'image') else None
    out['variant_verified'] = False
    # Strict selection (only when the attempt carried one): Hermes reports, the caller judges. A reported
    # provider/model change or any fallback is a mismatch; quality/size variation alone is not.
    if 'selection_mismatch' in result or result.get('requested_model') is not None or result.get('route') is not None:
        out['selection_mismatch'] = result.get('selection_mismatch') is True or bool(result.get('fallback_from'))
        out['reported_route'] = result.get('route') if isinstance(result.get('route'), str) and store.SAFE_NAME.fullmatch(result['route']) else None
    return out

FETCH = None  # test seam: fetch(home, url) -> local path. None = direct_runner.fetch_result_url when available.

def _fetcher():
    """How to download a provider-returned HTTPS result, or None (this Hermes lacks the helper)."""
    if FETCH is not None: return FETCH
    from . import direct_runner
    return direct_runner.fetch_result_url if direct_runner.can_fetch_result_urls() else None

def importable_success(a, result, meta):
    """A reported success with a known modality; a revision must also report editing the reference.
    Stock's `modality` is the INPUT kind: 'text' = text-to-image, 'image' = edited a reference."""
    if result.get('success') is not True: return False
    return not (meta['modality'] != 'image' and (a.get('kind') == 'revision' or meta['modality'] != 'text'))

def fetchable_url(a, result, meta):
    """Some image backends (FAL, incl. managed Nous) succeed with a bare provider URL instead of a
    cache path. Only a qualifying success with a gated HTTPS URL is fetched; everything else keeps the
    plain `url` refusal."""
    return store.result_url(result.get('image')) if importable_success(a, result, meta) else None

def inline_image(a, result, meta):
    """Some models (FAL sync_mode, e.g. FLUX 2 Pro) succeed with the image inline as a data URI, which
    Hermes cannot cache. Only a qualifying success whose value looks like an image data URI is decoded."""
    image = result.get('image')
    if not importable_success(a, result, meta) or not isinstance(image, str): return None
    return image if store.INLINE_IMAGE.match(image) else None

def store_output(root, home, a, result):
    aid = a['id']
    meta = reported(result)
    image = result.get('image')
    url = fetchable_url(a, result, meta)
    fetch = _fetcher() if url else None
    if fetch is not None:
        # The generation already ran: download its result ONCE. Never retried, never re-dispatched,
        # and the URL is never stored (it expires, and the UI must not hotlink it).
        try:
            image = fetch(home, url)
        except Exception:
            log.debug('Retake: downloading the generated image failed')
            return finish(root, aid, 'failed', store.error_info('output_fetch_failed'), **meta)
    inline = None if url else inline_image(a, result, meta)
    try:
        data, mime = store.decode_inline_output(inline) if inline else store.read_generated_output(image, home)
        dims = store.raster_metadata(data, mime)
    except (store.OutputRejected, ValueError) as e:
        reason = str(e) if isinstance(e, store.OutputRejected) else 'format'
        return finish(root, aid, 'failed', store.error_info('invalid_output', reason=reason if reason in ('url', 'path', 'size', 'format', 'missing', 'unreadable') else 'format'), **meta)
    if a.get('kind') == 'revision' and meta['modality'] != 'image':
        return finish(root, aid, 'failed', store.error_info('not_edited'), **meta)
    # A revision made by anything other than the confirmed model is never stored as a child version
    # (new assets are kept and flagged instead). Evidence is kept; the call may have been billed. No retry.
    if a.get('kind') == 'revision' and a.get('image_selection') and meta.get('selection_mismatch') is not False:
        return finish(root, aid, 'failed', store.error_info('selection_mismatch'), **meta)
    with store.connect(root) as con:
        con.execute('BEGIN IMMEDIATE')
        current = json.loads(con.execute('SELECT data FROM generation_attempts WHERE id=?', (aid,)).fetchone()[0])
        if not open_for_result(current): return current
        pid = current['project_id']
        full = con.execute('SELECT count(*) FROM versions WHERE project_id=?', (pid,)).fetchone()[0] >= store.MAX_VERSIONS
        full = full or con.execute('SELECT coalesce(sum(length(media)),0) FROM versions').fetchone()[0] + len(data) > store.MAX_PROFILE_BYTES
        if full:
            current.update(state='failed', error=store.error_info('quota'), finished_at=store.now_iso(), **meta)
        else:
            parent = None
            if current.get('parent_id'):
                prow = con.execute('SELECT data FROM versions WHERE project_id=? AND id=?', (pid, current['parent_id'])).fetchone()
                parent = json.loads(prow[0]) if prow else None
                if parent is None or parent.get('sha256') != current.get('parent_sha256'):
                    current.update(state='failed', error=store.error_info('local_error'), finished_at=store.now_iso(), **meta)
                    con.execute('UPDATE generation_attempts SET state=?,data=? WHERE id=?', (current['state'], json.dumps(current), aid))
                    return current
            v = store.record(project_id=pid, asset_id=parent['asset_id'] if parent else uuid.uuid4().hex, parent_id=current.get('parent_id'),
                             name=f'generated-{aid[:8]}.{store.EXT[mime]}', mime=mime, size=len(data), sha256=hashlib.sha256(data).hexdigest(),
                             origin='generated', generation_attempt_id=aid, **dims)
            con.execute('INSERT INTO versions VALUES (?,?,?,?)', (v['id'], pid, json.dumps(v), data))
            current.update(state='succeeded', version_id=v['id'], error=None, finished_at=store.now_iso(), **meta)
        con.execute('UPDATE generation_attempts SET state=?,data=? WHERE id=?', (current['state'], json.dumps(current), aid))
    return current

def _safe_type(v):
    return v if isinstance(v, str) and v in ('selection_invalid', 'selection_unknown', 'selection_unavailable', 'selection_unsupported') else None

def _selection_off(a, result):
    """Retake's own check on top of Hermes's flag: the call must echo the confirmed request and route."""
    snap = a['image_selection']
    return result.get('requested_provider') != snap['provider'] or result.get('requested_model') != snap['model'] or result.get('route') != snap['route']

def summary(a):
    state = a.get('state')
    if state == 'succeeded': return 'stored as a new immutable version.'
    message = (a.get('error') or {}).get('message') or store.OUTCOME.get(state, '')
    return f'{state}. {message}'

def execute(root, home, a, reference, dispatch):
    """Post-claim: ONE dispatch(args) call, then the result is validated and stored. `dispatch` raises
    store-coded `NotSent` when it certainly sent nothing; any other exception means "may have run".
    Returns the final attempt record. Never retries."""
    aid = a['id']
    try:
        raw = dispatch(tool_args(a, reference))
    except NotSent as refusal:
        return finish(root, aid, 'failed', store.error_info(refusal.code))
    except BaseException as exc:  # includes cancellation/interrupts: record uncertainty, never retry
        log.debug('Retake: image tool dispatch raised', exc_info=True)
        try:
            done = finish(root, aid, 'unknown', store.error_info('tool_exception'))
        except Exception:
            log.debug('Retake: could not record tool exception', exc_info=True)
            done = None
        if not isinstance(exc, Exception): raise
        return done or {'id': aid, 'state': 'unknown', 'error': store.error_info('tool_exception')}
    try:
        try:
            result = json.loads(raw) if isinstance(raw, (str, bytes, bytearray)) else raw
        except ValueError:
            result = None
        if not isinstance(result, dict):
            return finish(root, aid, 'unknown', store.error_info('tool_exception'))
        if a.get('image_selection') and result.get('success') is not True and result.get('nothing_sent') is True:
            return finish(root, aid, 'failed', store.error_info('selection_refused', selection_error=_safe_type(result.get('error_type'))), **reported(result))
        if result.get('success') is True:
            if a.get('image_selection') and _selection_off(a, result):
                result = {**result, 'selection_mismatch': True}
            return store_output(root, home, a, result)
        state, error = store.classify_tool_error(result)
        return finish(root, aid, state, error, **reported(result))
    except Exception:
        log.debug('Retake: storing tool result failed', exc_info=True)
        try:
            return finish(root, aid, 'unknown', store.error_info('local_error'))
        except Exception:
            return {'id': aid, 'state': 'unknown', 'error': store.error_info('local_error')}

class NotSent(Exception):
    """The transport stopped before the tool call could start: certainly nothing reached a provider."""
    def __init__(self, code):
        super().__init__(code); self.code = code

def run(ctx, pinned_home, raw_args):
    aid = valid_attempt_id(raw_args)
    if aid is None:
        return _say('', 'expected exactly one 32-character attempt ID from the Retake page. Nothing was sent.')
    root, refusal = resolve_root(pinned_home)
    if refusal: return _say(aid, refusal)
    try:
        a, reference, refusal = claim(root, aid)
    except Exception:
        log.debug('Retake: claim failed', exc_info=True)
        return _say(aid, 'Retake could not read its attempt record; nothing was sent.')
    if refusal: return _say(aid, refusal)
    # Claimed: from here on the provider may be contacted. No SQLite transaction is open.
    done = execute(root, pinned_home, a, reference, lambda args: ctx.dispatch_tool(store.TOOL, args))
    if done.get('state') == 'unknown' and (done.get('error') or {}).get('code') == 'tool_exception':
        return _say(aid, store.ERRORS['tool_exception'])
    return _say(aid, summary(done))
