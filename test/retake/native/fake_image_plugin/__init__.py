"""TEST ONLY native-acceptance fake image tool + guards (loaded in a synthetic fixture profile only).
STATUS: exercised by test/retake/stock_transport (stock `hermes serve` wire); native launch still blocked (FINDINGS.md).

Guards (armed at register(), so backend startup before plugin load is NOT covered):
- audit hook: socket.connect / getaddrinfo to anything but loopback is refused; opening an EXISTING
  credential-named file is refused.
- sys.monitoring PY_START (Python 3.12+, process-wide: existing and future threads; stays armed after a refusal):
  every code object started in plugins.image_gen.* or tools.image_generation_tool is refused, EXCEPT the literal
  top-level <module> body of exactly tools.image_generation_tool and the class body of its docstring-only
  `ImageGenerationInterrupted(Exception)` (both logged 'imported'); every function/method and any other class body is refused.
- RETAKE_FAKE_ALLOWED_PORTS (optional): loopback connects only to these ports.
Ledger: $RETAKE_FAKE_LEDGER (JSON lines) records arm PID, every fake call and every blocked attempt."""
import base64
import hashlib, io, ipaddress, json, os, sys, threading, time
from pathlib import Path

LEDGER = Path(os.environ['RETAKE_FAKE_LEDGER'])
CRED = {'.env', 'auth.json', 'credentials.json'}

def _log(kind, **kw):
    with LEDGER.open('a') as f:
        f.write(json.dumps({'t': time.time(), 'pid': os.getpid(), 'kind': kind, **kw}) + '\n')

def _loopback(host):
    if host in ('localhost', 'localhost.localdomain'): return True
    try: return ipaddress.ip_address(str(host).split('%')[0]).is_loopback
    except ValueError: return False

# Optional test-only restriction: RETAKE_FAKE_ALLOWED_PORTS=39119[,..] limits loopback connects to the owned
# fixture port(s). Unset keeps the older rule (any loopback) for fixtures that rely on it.
_PORTS = {int(p) for p in os.environ.get('RETAKE_FAKE_ALLOWED_PORTS', '').split(',') if p.strip()}

def _audit(event, args):
    if event == 'socket.connect':
        addr = args[1]
        if isinstance(addr, tuple) and (not _loopback(addr[0]) or (_PORTS and addr[1] not in _PORTS)):
            _log('blocked', what='connect', host=f'{addr[0]}:{addr[1]}'); raise PermissionError('connect outside owned loopback port(s) forbidden')
    elif event == 'socket.getaddrinfo':
        if args[0] is not None and not _loopback(args[0] if isinstance(args[0], str) else args[0].decode()):
            _log('blocked', what='dns'); raise PermissionError('dns forbidden')
    elif event == 'open' and isinstance(args[0], (str, bytes)):
        p = os.fsdecode(args[0])
        if Path(p).name in CRED and os.path.exists(p):
            _log('blocked', what='credential-file', path=p); raise PermissionError('credential access forbidden')

GUARD_TOOL = 4  # sys.monitoring tool id (0-2 and 5 are reserved by CPython for debugger/coverage/profiler/optimizer)
EXACT_IMPORT_ALLOWED = 'tools.image_generation_tool'

# Exactly two import-time code objects are permitted (parent adjudication): the <module> body above and the
# class body of this docstring-only exception (stock tools/image_generation_tool.py:92-93, pinned 2bd378ed).
ALLOWED_CLASS = 'ImageGenerationInterrupted'
ALLOWED_CLASS_DOC = 'Raised when the user interrupts while a FAL job is in flight.'
_FUNCTION_FLAGS = 0x1 | 0x2  # CO_OPTIMIZED | CO_NEWLOCALS: set on every function/method/lambda, never on a class body
_CLASS_BODY_NAMES = {'__name__', '__module__', '__qualname__', '__doc__', '__firstlineno__', '__static_attributes__',
                     '__classdictcell__'}

def _allowed_class_body(code):
    return (code.co_name == ALLOWED_CLASS and code.co_qualname == ALLOWED_CLASS
            and not code.co_flags & _FUNCTION_FLAGS
            and set(code.co_names) <= _CLASS_BODY_NAMES  # no other name loaded/called in the body
            and ALLOWED_CLASS_DOC in code.co_consts
            and all(c is None or isinstance(c, (str, int, tuple)) for c in code.co_consts))  # no nested code objects

def _provider_module(m):
    return m.startswith('plugins.image_gen.') or m == EXACT_IMPORT_ALLOWED

def _start(code, offset):
    # PY_START fires for every Python code object started in ANY thread (existing or future). Unlike a
    # sys.setprofile hook, sys.monitoring stays armed after a callback raises, so refusals repeat.
    frame = sys._getframe(1)
    if frame.f_code is not code:
        _log('blocked', what='guard-frame-mismatch', function=code.co_name); raise PermissionError('guard cannot identify frame')
    m = frame.f_globals.get('__name__') or ''
    if not _provider_module(m): return
    if m == EXACT_IMPORT_ALLOWED and code.co_name == '<module>':
        # The literal top-level body of this exact module.
        _log('imported', module=m, function=code.co_name, thread=threading.current_thread().name); return
    if m == EXACT_IMPORT_ALLOWED and _allowed_class_body(code):
        # The one parent-authorized class body (docstring-only Exception subclass; AST-qualified by run_wire.py).
        _log('imported', module=m, function=code.co_qualname, code_kind='class-body', thread=threading.current_thread().name); return
    _log('blocked', what='real-provider', module=m, function=code.co_name, thread=threading.current_thread().name)
    raise PermissionError('real image provider forbidden')

def _fake(args, **kwargs):
    from PIL import Image
    from hermes_constants import get_hermes_home
    home = get_hermes_home()
    out = io.BytesIO(); Image.new('RGB', (64, 64), (40, 120, 210)).save(out, format='PNG'); data = out.getvalue()
    path = home / 'cache/generated/images' / f'fake-{int(time.time()*1000)}.png'
    path.parent.mkdir(parents=True, exist_ok=True); path.write_bytes(data)
    ref = args.get('image_url') if isinstance(args.get('image_url'), str) else None
    ref_sha = hashlib.sha256(base64.b64decode(ref.split(',', 1)[1])).hexdigest() if ref and ref.startswith('data:') else None
    logged = {k: v for k, v in args.items() if k != 'image_url'}  # never log the reference bytes themselves
    _log('fake_call', home=str(home), args=logged, reference_sha256=ref_sha, sha256=hashlib.sha256(data).hexdigest())
    return json.dumps({'success': True, 'image': str(path), 'provider': 'fixture-fake', 'model': 'fixture/fake', 'modality': 'image' if ref_sha else 'text'})

def register(ctx):
    mon = getattr(sys, 'monitoring', None)
    if mon is None:
        raise RuntimeError('fail closed: sys.monitoring (Python 3.12+) unavailable')
    mon.use_tool_id(GUARD_TOOL, 'retake-fake-image-guard')  # raises if the id is taken: fail closed
    mon.register_callback(GUARD_TOOL, mon.events.PY_START, _start)
    mon.set_events(GUARD_TOOL, mon.events.PY_START)
    sys.addaudithook(_audit)
    _log('armed', python=sys.version.split()[0], threads=threading.active_count(), ports=sorted(_PORTS), mechanism='sys.monitoring PY_START')
    ctx.register_tool('image_generate', 'image_gen',
                      {'name': 'image_generate', 'description': 'TEST ONLY fake', 'parameters': {'type': 'object', 'properties': {'prompt': {'type': 'string'}, 'aspect_ratio': {'type': 'string'}, 'image_url': {'type': 'string'}}, 'required': ['prompt']}},
                      _fake, override=True)
