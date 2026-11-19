"""Retake's plugin-owned storage + generation-attempt rules, shared by the dashboard router and the
`retake-generate` slash command. Standard library + Pillow only: no FastAPI, no Hermes internals.

Both halves resolve the SAME profile-local database through public `plugin_data_dir('retake')`
(the host binds the profile; see plugins/plugin_storage.py: dashboard and tools share it across
processes). This module never resolves a profile itself and never talks to a provider.
"""
import base64
import binascii
from contextlib import contextmanager
from datetime import datetime, timezone
import hashlib
import io
import json
import os
from pathlib import Path
import re
import sqlite3
import stat as stat_mod
import uuid
import warnings

from PIL import Image

MAX_IMAGE_BYTES = 12 * 1024 * 1024
MAX_PIXELS = 24_000_000
MAX_VERSIONS = 200
MAX_PROFILE_BYTES = 512 * 1024 * 1024
ID = re.compile(r'^[0-9a-f]{32}$')
RASTER = {'PNG': 'image/png', 'JPEG': 'image/jpeg', 'WEBP': 'image/webp'}
EXT = {'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp'}
ASPECTS = ('landscape', 'square', 'portrait')
ACTIVE = ('reserved', 'running')
RESERVE_TTL = 5 * 60    # a reservation the command never claimed expires (certainly never dispatched)
STALE_AFTER = 15 * 60   # a claimed (running) attempt with no recorded result reads as unknown
SAFE_NAME = re.compile(r'^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$')
SAFE_MODEL = re.compile(r'^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}(?:/[A-Za-z0-9][A-Za-z0-9._:-]{0,79}){0,4}$')  # FAL ids nest (fal-ai/flux-2/klein/9b)
COMMAND = 'retake-generate'
DIRECT = 'direct'        # POST /generations/{id}/run: stock hermes_tools_mcp_server, no chat (direct_runner.py)
TOOL = 'image_generate'
COST_UNKNOWN = 'Cost unknown'
SCOPE_NOTE = 'Uses Hermes configured image generation; provider account may be charged; cost unknown.'
# Stock image_generate passes image_url to whatever backend Hermes is configured for; plugins get no
# public, pre-dispatch statement that this backend EDITS the image (FAL non-edit models refuse, style
# backends such as Krea use it as a look reference only, other plugins may ignore it). Until that is
# qualified, automatic revision stays off. The command path keeps a post-hoc modality check for later.
REVISION_QUALIFIED = False
REVISION_DISABLED = ('Automatic revision is off: Hermes’s configured image tool does not publish verified image-edit '
                     'support to plugins. Saved briefs still work; upload a revised file as the next version.')

SCHEMA = '''CREATE TABLE IF NOT EXISTS projects(id TEXT PRIMARY KEY, data TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS versions(id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id), data TEXT NOT NULL, media BLOB NOT NULL);
CREATE TABLE IF NOT EXISTS reviews(version_id TEXT PRIMARY KEY REFERENCES versions(id), status TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS annotations(id TEXT PRIMARY KEY, version_id TEXT NOT NULL REFERENCES versions(id), data TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS briefs(id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id), data TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS asset_names(asset_id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id), name TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS generation_attempts(id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id), client_request_id TEXT NOT NULL UNIQUE, fingerprint TEXT NOT NULL, state TEXT NOT NULL, data TEXT NOT NULL);'''

ERRORS = {  # Fixed, sanitized wording. Raw tool text, URLs, paths and exceptions never cross the API.
    'not_dispatched': 'Retake stopped before calling Hermes image generation. Nothing was sent.',
    'cancelled': 'Reservation cancelled before Hermes ran it. Nothing was sent.',
    'expired': 'This reservation was never run by Hermes and has expired. Nothing was sent.',
    'tool_refused': 'Hermes image generation refused the request before contacting a provider. Nothing was billed.',
    'tool_error': 'Hermes image generation reported an error after the request may have reached the provider. It may have been billed.',
    'tool_exception': 'The image tool call ended unexpectedly. The request may have reached the provider and been billed.',
    'invalid_output': 'The image tool returned output Retake will not import (remote URL, outside this profile’s generated-image cache, unsafe, too large or not a PNG/JPEG/WebP still). No version was created; the provider may have billed the request.',
    'not_edited': 'The image tool did not report editing the reference image, so the result was not stored as a revision. The provider may have billed the request.',
    'quota': 'Output arrived but the project or profile media quota is full. No version was created; the provider may have billed the request.',
    'local_error': 'Output could not be stored locally. The provider may have billed the request.',
    'tool_unavailable': 'Hermes did not offer image_generate to Retake in this profile (image generation not configured, or hidden by tools.tool_search). Nothing was sent.',
    'no_edit_support': 'Hermes’s configured image tool does not accept a reference image in this profile, so the revision was not sent. Nothing was sent.',
    # Per-request image model choice (image_selection.py). All are decided before the one tool call.
    'selection_unsupported_host': 'This Hermes no longer offers per-request image model choice. Nothing was sent.',
    'selection_unknown': 'Hermes no longer offers the chosen image model for this profile. Nothing was sent.',
    'selection_unavailable': 'The chosen image model is unavailable for this profile (sign-in or subscription backend). Nothing was sent.',
    'selection_no_revision': 'The chosen image model cannot edit a reference image, so the revision was not sent. Nothing was sent.',
    'selection_changed': 'The chosen image model changed in Hermes after you confirmed (route, billing or edit support). Nothing was sent.',
    'selection_mismatch': 'Hermes did not confirm that the chosen image model made this revision (different model, fallback or missing proof), so it was not stored as a revision. The request may have reached the provider and been billed.',
    'selection_refused': 'Hermes refused the chosen image model before contacting a provider. Nothing was sent.',
    'output_fetch_failed': 'Hermes generated an image, but Retake could not download the result. The request may have been billed. Not retried.',
    'stale': 'Hermes ran this attempt but never reported back (connection lost or backend restarted). The provider may or may not have produced and billed an image.',
}
CATEGORY = {  # Actionable, bounded guidance derived from the tool's error class; the raw text is never shown.
    'signin': 'Sign-in or an API key is missing or expired for the configured image provider. Fix it in Hermes (Capabilities → Tools → Image Generation), then start a new generation.',
    'invalid': 'The provider rejected the request as invalid for this model (a model or Hermes setup problem, not your account). Try another model.',
    'credits': 'The configured image provider reported a billing or credits problem. Check that account, then start a new generation.',
    'quota': 'The configured image provider reported a rate limit or usage quota. Wait before starting a new generation.',
    'unsupported': 'Hermes’s configured image tool does not support this request (no image backend registered, tool not enabled, or no image-edit support).',
    'setup': 'Image generation is not set up in this Hermes profile. Configure it in Capabilities → Tools → Image Generation.',
    'content': 'The provider declined the prompt under its content policy.',
    'interrupted': 'The image tool was interrupted; the remote job may still have run.',
    'other': 'The image tool reported an error Retake does not classify.',
}
OUTCOME = {
    'reserved': 'Reserved. Waiting for Hermes to run it; do not resubmit.',
    'running': 'Hermes is generating. Do not resubmit.',
    'succeeded': 'Stored as a new immutable version.',
    'failed': 'No version was created. Retake does not retry automatically.',
    'unknown': 'Outcome unknown. No version was created here; Retake will not retry automatically.',
}
# Diagnostic class names only, never evidence about submission or billing stage.
# Do not reflect arbitrary provider strings: an error_type can itself contain a secret.
KNOWN_ERROR_TYPES = frozenset({'provider_not_registered', 'modality_unsupported', 'invalid_argument',
    'auth_required', 'missing_dependency', 'invalid_image_input', 'missing_api_key',
    'ImageResolutionError', 'ValueError', 'api_error', 'provider_exception', 'timeout',
    'rate_limit', 'quota_exceeded', 'content_policy'})
CATEGORY_RULES = (
    # Order matters: the first match wins. Patterns are precise phrases, never bare words, because
    # provider errors often repeat the request (e.g. rendering_speed='BALANCED' once read as "balance").
    ('content', re.compile(r'content[ _-]?policy|safety (?:checker|system|filter)|moderation|nsfw|\bblocked by\b', re.I)),
    ('invalid', re.compile(r'invalid_argument|invalid_image_input|validation error|field required|value_error|type_error|unprocessable|bad request|\b(?:400|422)\b|missing required|[\'"]type[\'"]\s*:\s*[\'"]missing[\'"]', re.I)),
    ('signin', re.compile(r'auth_required|missing_api_key|\b401\b|\b403\b|unauthori[sz]ed|forbidden|sign[ -]?in required|not (?:signed|logged) in|invalid (?:api[ _]?)?key|api[ _]?key (?:is )?(?:missing|invalid|not set|required)|FAL_KEY|credentials? (?:are |is )?(?:missing|invalid|not found|not configured|expired)|no credentials|token (?:expired|invalid)', re.I)),
    ('credits', re.compile(r'\b402\b|payment required|insufficient (?:credits?|balance|funds)|not enough (?:credits?|balance|funds)|(?:credits?|balance) (?:are |is |has been )?(?:exhausted|depleted|too low)|exhausted balance|out of credits|no (?:remaining )?credits|billing_error|billing (?:error|issue|problem|required)|top up', re.I)),
    ('quota', re.compile(r'quota|rate[ _-]?limit|\b429\b|too many requests', re.I)),
    ('setup', re.compile(r'unavailable in this environment|not set up|no backend', re.I)),
    ('unsupported', re.compile(r'provider_not_registered|modality_unsupported|not capable|does not support|unsupported|not registered|unknown tool|no such tool|not enabled|not available', re.I)),
    ('interrupted', re.compile(r'interrupt', re.I)),
)
# Request fields a provider echoes back in its error. Their VALUES are the user's own input (prompt,
# reference image, options), so they are cut before matching and can never steer the category.
ECHO_KEYS = re.compile(r'''(['"]?)(?:input|prompt|negative_prompt|image_urls?|reference_image_urls|mask_(?:image_)?url|rendering_speed|style|seed|body)\1\s*[:=]\s*''', re.I)
BARE_VALUE = re.compile(r'[^\s,;)}\]]*')

def _value_end(s, j):
    """End of one echoed value at s[j]: a quoted string, a balanced {...}/[...]/(...) or a bare token."""
    if j >= len(s): return j
    c = s[j]
    if c in '\'"':
        k = j + 1
        while k < len(s) and s[k] != c: k += 2 if s[k] == '\\' else 1
        return min(k + 1, len(s))
    if c in '{[(':
        depth, k, quote = 0, j, None
        while k < len(s):
            ch = s[k]
            if quote:
                if ch == '\\': k += 2; continue
                if ch == quote: quote = None
            elif ch in '\'"': quote = ch
            elif ch in '{[(': depth += 1
            elif ch in '}])':
                depth -= 1
                if depth == 0: return k + 1
            k += 1
        return len(s)
    return BARE_VALUE.match(s, j).end()

def drop_echoes(raw):
    out, i = [], 0
    while True:
        m = ECHO_KEYS.search(raw, i)
        if not m: out.append(raw[i:]); return ''.join(out)
        out.append(raw[i:m.end()]); i = max(_value_end(raw, m.end()), m.end() + 1) if m.end() < len(raw) else len(raw)

class UnsafeStorage(Exception):
    pass

class OutputRejected(Exception):
    """The tool claimed success but its output is not importable."""

def now_iso():
    return datetime.now(timezone.utc).isoformat()

def record(**fields):
    return {'id': uuid.uuid4().hex, 'created_at': now_iso(), **fields}

@contextmanager
def connect(root):
    root = Path(root)
    path = root / 'retake.sqlite3'
    if root.is_symlink() or path.is_symlink(): raise UnsafeStorage('symlink')
    con = sqlite3.connect(path, timeout=10)
    try:
        con.execute('PRAGMA foreign_keys=ON')
        con.executescript(SCHEMA)
        yield con
        con.commit()
    except BaseException:
        con.rollback(); raise
    finally:
        con.close()

def storage_key(root):
    """Opaque identity of one profile's Retake store (never a path in API output)."""
    return hashlib.sha256(os.path.realpath(root).encode()).hexdigest()[:32]

def sniff_raster(data):
    try:
        with warnings.catch_warnings():
            warnings.simplefilter('error', Image.DecompressionBombWarning)
            with Image.open(io.BytesIO(data)) as image:
                return RASTER.get(image.format)
    except Exception:
        return None

def raster_metadata(data, mime):
    """Validate an owned still raster; ValueError when it is not one Retake stores."""
    try:
        with warnings.catch_warnings():
            warnings.simplefilter('error', Image.DecompressionBombWarning)
            with Image.open(io.BytesIO(data)) as image:
                if RASTER.get(image.format) != mime or image.width * image.height > MAX_PIXELS or getattr(image, 'n_frames', 1) != 1:
                    raise ValueError('unsupported image')
                width, height = image.size; image.verify()
            with Image.open(io.BytesIO(data)) as image: image.load()
    except ValueError: raise
    except Exception: raise ValueError('invalid image')
    return {'width': width, 'height': height, 'duration': None}

def generated_images_dir(home):
    # Host convention: provider_media writes `$HERMES_HOME/cache/generated/images/`.
    return Path(home) / 'cache' / 'generated' / 'images'

def read_generated_output(value, home, limit=None):
    """Bounded read of a tool-written file. Accepts ONLY a regular, non-symlink file directly inside
    this profile's generated-images cache. URLs are never read here (refused as `url`), nor are data
    URLs, relative/traversing paths or files elsewhere. A provider-returned HTTPS result is first
    downloaded into that cache by the adapter (stock_bridge.store_output -> direct_runner.fetch_result_url)
    and then comes through here as a path like any other. Returns (bytes, mime)."""
    limit = MAX_IMAGE_BYTES if limit is None else limit
    if not isinstance(value, str) or not value or '\x00' in value: raise OutputRejected('missing')
    if re.match(r'^[A-Za-z][A-Za-z0-9+.-]*:', value): raise OutputRejected('url')
    if len(value) > 4096: raise OutputRejected('path')
    path, base, home = Path(value), generated_images_dir(home), Path(home)
    if not path.is_absolute() or '..' in path.parts or path.parent != base: raise OutputRejected('path')
    real_home, real_base = os.path.realpath(home), os.path.realpath(base)
    if os.path.realpath(path.parent) != real_base or not real_base.startswith(real_home.rstrip(os.sep) + os.sep): raise OutputRejected('path')
    try:
        fd = os.open(path, os.O_RDONLY | getattr(os, 'O_NOFOLLOW', 0) | getattr(os, 'O_NONBLOCK', 0))
    except OSError:
        raise OutputRejected('unreadable')
    try:
        info = os.fstat(fd)
        if not stat_mod.S_ISREG(info.st_mode) or info.st_size <= 0 or info.st_size > limit: raise OutputRejected('size')
        chunks, total = [], 0
        while True:
            chunk = os.read(fd, 1 << 20)
            if not chunk: break
            total += len(chunk)
            if total > limit: raise OutputRejected('size')
            chunks.append(chunk)
    finally:
        os.close(fd)
    data = b''.join(chunks)
    mime = sniff_raster(data)
    if not mime: raise OutputRejected('format')
    return data, mime

INLINE_IMAGE = re.compile(r'data:(image/(?:png|jpeg|webp));base64,', re.I)
MAX_INLINE_CHARS = 64 + (MAX_IMAGE_BYTES + 2) // 3 * 4

def decode_inline_output(value):
    """An image a provider returned inline (FAL sync_mode) as a base64 data URI. Only a bounded
    PNG/JPEG/WebP base64 URI whose bytes sniff as the declared raster is accepted; the caller still
    runs raster_metadata. Never fetched, never written to disk, never stored. Returns (bytes, mime)."""
    m = INLINE_IMAGE.match(value) if isinstance(value, str) else None
    if not m: raise OutputRejected('url')
    if len(value) > MAX_INLINE_CHARS: raise OutputRejected('size')
    try:
        data = base64.b64decode(value[m.end():], validate=True)
    except (binascii.Error, ValueError):
        raise OutputRejected('format')
    if not data: raise OutputRejected('format')
    if len(data) > MAX_IMAGE_BYTES: raise OutputRejected('size')
    if sniff_raster(data) != m.group(1).lower(): raise OutputRejected('format')
    return data, m.group(1).lower()

def result_url(value):
    """The provider result URL Retake may download once, or None. HTTPS only, a host, no userinfo,
    bounded, no whitespace or control characters. Everything else keeps today's `url` refusal."""
    from urllib.parse import urlsplit
    if not isinstance(value, str) or not value or len(value) > 4096: return None
    if any(ch.isspace() or ord(ch) < 0x20 or ord(ch) == 0x7f for ch in value): return None
    try:
        parts = urlsplit(value)
        host = parts.hostname
    except ValueError:
        return None
    if parts.scheme != 'https' or not value.startswith('https://') or not host: return None
    if '@' in parts.netloc or parts.username is not None or parts.password is not None: return None
    return value

def error_info(code, **extra):
    return {'code': code, 'message': ERRORS[code], **extra}

def age_seconds(iso):
    try:
        return (datetime.now(timezone.utc) - datetime.fromisoformat(iso)).total_seconds()
    except Exception:
        return 0

def expiry(a):
    """(state, error) an active attempt should now read as, or None. A reservation that was never
    claimed cannot have dispatched (claiming is the only dispatch path), so it is `failed`."""
    if a.get('state') == 'reserved' and age_seconds(a.get('created_at')) > RESERVE_TTL:
        return 'failed', error_info('expired')
    if a.get('state') == 'running' and age_seconds(a.get('dispatched_at') or a.get('created_at')) > STALE_AFTER:
        return 'unknown', error_info('stale')
    return None

PRIVATE_KEYS = ('storage_key',)

def public_attempt(a):
    a = {k: v for k, v in a.items() if k not in PRIVATE_KEYS}
    late = expiry(a)
    if late: a.update(state=late[0], error=late[1])
    a['outcome'] = OUTCOME.get(a.get('state'), '')
    return a

def expire_locked(con, where_project=None):
    rows = con.execute("SELECT id,data FROM generation_attempts WHERE state IN ('reserved','running')").fetchall()
    for aid, raw in rows:
        a = json.loads(raw)
        late = expiry(a)
        if late:
            a.update(state=late[0], error=late[1], finished_at=now_iso())
            con.execute('UPDATE generation_attempts SET state=?,data=? WHERE id=?', (a['state'], json.dumps(a), aid))

def classify_tool_error(result):
    """Stock image_generate failure envelope -> (state, error dict). Bounded and sanitized: only the
    error CLASS name (if safe) and a fixed category message are kept; the raw text is never stored."""
    error_type = result.get('error_type')
    error_type = error_type if isinstance(error_type, str) and error_type in KNOWN_ERROR_TYPES else ''
    raw = result.get('error') if isinstance(result.get('error'), str) else ''
    raw = drop_echoes(raw[:4096])
    category = next((name for name, rule in CATEGORY_RULES if rule.search(error_type) or rule.search(raw)), 'other')
    # The generic public tool result has no trustworthy submission/billing-stage field.
    # A provider's wording/class cannot establish that a request never reached it.
    code = 'tool_error'
    message = f'{CATEGORY[category]} {ERRORS[code]}'
    return 'unknown', {'code': code, 'message': message, 'category': category,
                       'tool_error_type': error_type or None}
