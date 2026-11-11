"""Chat-free transport for ONE reserved attempt: stock Hermes's documented tool server.

Stock documents `python -m agent.transports.hermes_tools_mcp_server` (website/docs/user-guide/features/
codex-app-server-runtime.md, "Hermes tool callback") as a stdio MCP server that takes `HERMES_HOME`
from its environment, runs Hermes's own builtin-tool and plugin discovery for that home and dispatches
through the same `handle_function_call` path as a chat turn. No session, Agent or chat is created.

Retake spawns it per run for the REQUESTING profile's home only, reads the advertised `image_generate`
schema (a revision needs `image_url`), and makes exactly one `call_tool`. Everything before that call
raises `NotSent` (certainly nothing reached a provider); anything after it is recorded as may-have-run.
No retry and no config write. An attempt that snapshotted a per-request image model (image_selection.py)
pins that one process with `--image-selection provider:model`; Hermes then refuses anything else.

"""
import logging
import os
import sys
import threading
from pathlib import Path

from . import retake_store as store
from . import stock_bridge
from .stock_bridge import NotSent

log = logging.getLogger(__name__)
SERVER_MODULE = 'agent.transports.hermes_tools_mcp_server'
CALL_TIMEOUT = 600   # stock's documented tool_timeout_sec
START_TIMEOUT = 60


def hermes_source():
    """Directory the running Hermes is imported from, so the child runs the same code."""
    import hermes_constants
    return str(Path(hermes_constants.__file__).resolve().parent)


def server_env(home):
    env = dict(os.environ)
    env['HERMES_HOME'] = str(home)
    env['HERMES_QUIET'] = '1'
    src = hermes_source()
    env['PYTHONPATH'] = os.pathsep.join([src] + [p for p in env.get('PYTHONPATH', '').split(os.pathsep) if p and p != src])
    return env, src


def mcp_dispatch(home, args, selection=None):
    """One `image_generate` call through the stock tool server for `home`. Returns the tool's text."""
    try:
        import anyio
        from mcp import ClientSession, StdioServerParameters
        from mcp.client.stdio import stdio_client
    except ImportError:
        raise NotSent('tool_unavailable')
    env, src = server_env(home)
    pin = ['--image-selection', selection] if selection else []
    params = StdioServerParameters(command=sys.executable, args=['-m', SERVER_MODULE, *pin], env=env, cwd=src)
    sent = False

    async def go():
        nonlocal sent
        async with stdio_client(params) as (r, w):
            async with ClientSession(r, w) as s:
                with anyio.fail_after(START_TIMEOUT):
                    await s.initialize()
                    tools = (await s.list_tools()).tools
                tool = next((t for t in tools if t.name == store.TOOL), None)
                if tool is None: raise NotSent('tool_unavailable')
                schema = getattr(tool, 'input_schema', None) or getattr(tool, 'inputSchema', None) or {}
                if 'image_url' in args and 'image_url' not in (schema.get('properties') or {}):
                    raise NotSent('no_edit_support')
                sent = True  # from here the provider may be contacted
                with anyio.fail_after(CALL_TIMEOUT):
                    res = await s.call_tool(store.TOOL, args)
                if getattr(res, 'is_error', getattr(res, 'isError', False)):
                    raise RuntimeError('tool server reported an error')
                texts = [c.text for c in res.content if getattr(c, 'text', None)]
                if len(texts) != 1: raise RuntimeError('unexpected tool result shape')
                return texts[0]
    try:
        return anyio.run(go)
    except NotSent:
        raise
    except BaseException as exc:
        inner = _not_sent_in(exc)
        if inner is not None and not sent: raise inner from None
        if not sent and isinstance(exc, Exception):
            log.debug('Retake: tool server failed before the call', exc_info=True)
            raise NotSent('tool_unavailable') from exc
        raise


FETCH_TIMEOUT = 90   # whole child process; the helper's own HTTP timeout is 60 s
# Runs in a child bound to the REQUESTING profile (get_hermes_home() is process-wide, so the dashboard
# process could write into another profile's cache). Home and URL arrive as argv only, never as code.
FETCH_CODE = '''import sys, pathlib
from hermes_constants import get_hermes_home
if get_hermes_home().resolve() != pathlib.Path(sys.argv[1]).resolve():
    sys.exit(3)
try:
    from agent.image_gen_provider import save_url_image
except ImportError:
    sys.exit(4)
path = save_url_image(sys.argv[2], prefix='retake', timeout=60, max_bytes=12 * 1024 * 1024)
print('RETAKE_PATH=' + str(path))
'''


class FetchFailed(Exception):
    """The provider result could not be downloaded. The generation already ran (may have been billed)."""


def can_fetch_result_urls():
    """Import probe only (no network): does this Hermes ship the public SSRF-guarded download helper?"""
    try:
        import importlib
        import importlib.util
        if importlib.util.find_spec('agent.image_gen_provider') is None: return False
        return callable(getattr(importlib.import_module('agent.image_gen_provider'), 'save_url_image', None))
    except Exception:
        return False


def fetch_result_url(home, url):
    """Download ONE provider result URL through Hermes's `save_url_image` (every hop SSRF-checked,
    redirects re-validated, size-capped) into `home`'s generated-images cache. Returns the local path.
    Raises FetchFailed on any failure; the URL and the child's output are never logged or stored."""
    import subprocess
    try:
        env, src = server_env(home)
        done = subprocess.run([sys.executable, '-c', FETCH_CODE, str(home), url], env=env, cwd=src,
                              stdin=subprocess.DEVNULL, capture_output=True, timeout=FETCH_TIMEOUT)
    except Exception:
        raise FetchFailed('child did not finish') from None
    if done.returncode != 0: raise FetchFailed(f'child exit {done.returncode}')
    lines = [line.strip() for line in done.stdout.decode('utf-8', 'replace').splitlines() if line.strip()]
    path = lines[-1][len('RETAKE_PATH='):] if lines and lines[-1].startswith('RETAKE_PATH=') else ''
    if not path or len(path) > 4096: raise FetchFailed('unexpected output')
    return path


def _not_sent_in(exc):
    """anyio task groups wrap exceptions; find our own refusal inside a group."""
    if isinstance(exc, NotSent): return exc
    for sub in getattr(exc, 'exceptions', ()) or ():
        found = _not_sent_in(sub)
        if found is not None: return found
    return None


def run_claimed(root, home, a, reference, dispatch=None):
    """Execute an attempt this request already claimed. Blocking; call it off the event loop."""
    selection = (a.get('image_selection') or {}).get('id')
    dispatch = dispatch or ((lambda args: mcp_dispatch(home, args, selection)) if selection else (lambda args: mcp_dispatch(home, args)))
    return stock_bridge.execute(root, home, a, reference, dispatch)


def start(root, home, aid, dispatch=None, refuse=None):
    """Claim now (in the request), dispatch in a background thread. Returns (attempt, refusal).
    `refuse`: a claim-time image-selection refusal code; the attempt then fails with nothing sent."""
    a, reference, refusal = stock_bridge.claim(root, aid, revision_ok=True, via=store.DIRECT, refuse=refuse)
    if refusal: return None, refusal
    t = threading.Thread(target=run_claimed, args=(root, home, a, reference, dispatch), name=f'retake-{aid[:8]}', daemon=True)
    t.start()
    return a, None
