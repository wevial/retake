"""Per-request image model choice through Hermes's trusted image-selection contract (optional).

Read-only listing: `python -m agent.transports.hermes_tools_mcp_server --list-image-selections` for the
REQUESTING profile's home. A Hermes without that contract (it ignores the flag, serves on an empty stdin
and prints nothing) reads as "not supported": Retake then keeps its configured-model flow unchanged.

Only subscription-covered ChatGPT (`openai-codex`) and Nous FAL/Krea descriptors are accepted; Portal
(`--include-portal`) is never requested. Every descriptor is re-validated field by field and reduced to
the subset Retake shows and snapshots. Entitlement and cost stay unknown: a listed model is not proof
that the account may run it.
"""
import json
import re
import subprocess
import sys
import threading
import time

from . import direct_runner

# Listed edit-capable models Retake never sends as a revision: Hermes core sends this one the wrong edit parameter, so every
# revision fails. Still listed and usable for new assets. Matched on the bare model id, whatever provider lists it.
REVISION_UNSUPPORTED_MODELS = frozenset({'fal-ai/ideogram/v3'})
SELECTION_ID = re.compile(r'^(openai-codex|nous):[A-Za-z0-9][A-Za-z0-9._/-]{0,119}$')
ROUTES = {'openai-codex': {'chatgpt'}, 'nous': {'nous-fal', 'nous-krea'}}
BILLING = {'openai-codex': 'subscription:chatgpt', 'nous': 'subscription:nous'}
LIST_TIMEOUT = 45
CACHE_SECONDS = 60
MAX_OUTPUT = 512 * 1024
MAX_SELECTIONS = 80
_cache, _lock = {}, threading.Lock()


def _text(v, n):
    return v[:n] if isinstance(v, str) else None


def clean(d):
    """One listed descriptor -> Retake's bounded subset, or None if anything is off-contract."""
    if not isinstance(d, dict): return None
    sid, provider, model = d.get('id'), d.get('provider'), d.get('model')
    if not isinstance(sid, str) or not SELECTION_ID.fullmatch(sid) or sid != f'{provider}:{model}': return None
    if d.get('route') not in ROUTES.get(provider, ()) or d.get('billing') != BILLING[provider]: return None
    caps = d.get('capabilities') if isinstance(d.get('capabilities'), dict) else {}
    available = d.get('available') if d.get('available') in (True, False, None) else None
    return {'id': sid, 'provider': provider, 'model': model, 'display': _text(d.get('display'), 80) or model,
            'route': d['route'], 'billing': d['billing'], 'entitlement': 'unknown', 'available': available,
            'unavailable_reason': _text(d.get('unavailable_reason'), 200) if available is False else None,
            'image_input': caps.get('image_input') if caps.get('image_input') in ('edit', 'style') else None,
            # Revisions send the exact parent as an edit reference: only an explicit edit model qualifies, minus the unsupported ones.
            'revision': caps.get('revision') is True and caps.get('edit') is True and caps.get('image_input') == 'edit'
                        and d.get('model') not in REVISION_UNSUPPORTED_MODELS,
            'variant_enforced': d.get('variant_enforced') is True}


def _run_listing(home):
    try:
        env, src = direct_runner.server_env(home)
    except Exception:  # Hermes source not locatable: no picker, configured flow unchanged
        return None
    try:
        p = subprocess.run([sys.executable, '-m', direct_runner.SERVER_MODULE, '--list-image-selections'], env=env, cwd=src,
                           stdin=subprocess.DEVNULL, capture_output=True, timeout=LIST_TIMEOUT)
    except (OSError, subprocess.TimeoutExpired):
        return None
    if p.returncode != 0 or not p.stdout or len(p.stdout) > MAX_OUTPUT: return None
    try:
        data = json.loads(p.stdout)
    except ValueError:
        return None
    if not isinstance(data, dict) or not isinstance(data.get('selections'), list): return None
    return [c for c in (clean(d) for d in data['selections'][:MAX_SELECTIONS]) if c]


def listing(home, fresh=False):
    """{'supported': bool, 'selections': [...]} for `home`. `fresh` bypasses the short cache (claim time)."""
    key = str(home)
    with _lock:
        hit = _cache.get(key)
        if hit and not fresh and time.monotonic() - hit[0] < CACHE_SECONDS: return hit[1]
    got = _run_listing(home)
    out = {'supported': got is not None, 'selections': got or []}
    with _lock:
        _cache[key] = (time.monotonic(), out)
    return out


def check(home, sid, revision, fresh=False):
    """(descriptor, refusal code). The choice must still be listed, not unavailable and, for a
    revision, edit-capable. Codes map to fixed 'nothing was sent' messages in retake_store."""
    got = listing(home, fresh=fresh)
    if not got['supported']: return None, 'selection_unsupported_host'
    d = next((x for x in got['selections'] if x['id'] == sid), None)
    if d is None: return None, 'selection_unknown'
    if d['available'] is False: return d, 'selection_unavailable'
    if revision and not d['revision']: return d, 'selection_no_revision'
    return d, None


SNAPSHOT_KEYS = ('id', 'provider', 'model', 'display', 'route', 'billing', 'revision', 'variant_enforced')


def snapshot(d):
    return {k: d[k] for k in SNAPSHOT_KEYS}


def changed(snap, d):
    """True if the fresh descriptor no longer matches what the user confirmed (route, billing, edit, variant)."""
    return d is None or any(snap.get(k) != d.get(k) for k in SNAPSHOT_KEYS if k != 'display')
