"""Regression tests for the TEST-ONLY fake image plugin's guards (test/retake/native/fake_image_plugin).

Each case runs in its own isolated (`-I`) stdlib-only subprocess on a Python >= 3.12 interpreter
(RETAKE_GUARD_PYTHON, else python3.14/3.13/3.12 on PATH; absent -> FAIL, never skip). Provider modules are
SYNTHETIC files named like the real ones (`tools.image_generation_tool`, `plugins.image_gen.*`); no real
provider code is imported or invoked. No network beyond refused/closed 127.0.0.1 ports."""
import json, os, shutil, socket, subprocess, sys, tempfile, textwrap, unittest
from pathlib import Path

PLUGIN = Path(__file__).resolve().parent / 'native/fake_image_plugin/__init__.py'

def guard_python():
    explicit = os.environ.get('RETAKE_GUARD_PYTHON')
    if explicit: return explicit
    for name in ('python3.14', 'python3.13', 'python3.12'):
        found = shutil.which(name)
        if found: return found
    raise AssertionError('no Python >= 3.12 for guard tests; set RETAKE_GUARD_PYTHON')

RUNNER = r'''
import importlib, importlib.util, json, os, socket, sys, threading
case = sys.argv[1]
sys.path.insert(0, os.environ['GUARD_PKG'])
gate = threading.Event(); out = {}
def call_provider(key):
    try: out[key] = importlib.import_module('tools.image_generation_tool').provider()
    except PermissionError: out[key] = 'refused'
pre = threading.Thread(target=lambda: (gate.wait(), case == 'function_after_import' and call_provider('existing_thread')), daemon=True)
pre.start()  # exists BEFORE the guard is armed
spec = importlib.util.spec_from_file_location('retake_fake_image', os.environ['GUARD_PLUGIN'])
plugin = importlib.util.module_from_spec(spec); spec.loader.exec_module(plugin)
class Ctx:
    def register_tool(self, *a, **k): out['registered'] = a[0]
plugin.register(Ctx())
def attempt(key, fn):
    try: out[key] = fn()
    except PermissionError: out[key] = 'refused'
if case == 'module_body':
    attempt('import', lambda: importlib.import_module('tools.image_generation_tool').PLAIN)
elif case == 'same_name_function_after':
    attempt('import', lambda: importlib.import_module('tools.image_generation_tool').PLAIN)
    for i in range(2): attempt(f'call{i}', lambda: importlib.import_module('tools.image_generation_tool').ImageGenerationInterrupted())
elif case in ('function_during_import', 'class_during_import', 'plugins_image_gen_body', 'allowed_class',
              'same_name_function', 'same_name_class_extra', 'same_name_class_method'):
    name = 'plugins.image_gen.fakeprov' if case == 'plugins_image_gen_body' else 'tools.image_generation_tool'
    attempt('import', lambda: importlib.import_module(name).PLAIN)
elif case == 'function_after_import':
    attempt('import', lambda: importlib.import_module('tools.image_generation_tool').PLAIN)
    for i in range(3): call_provider(f'call{i}')  # repeated refusals: the guard must not disarm itself
    gate.set(); pre.join()
    t = threading.Thread(target=call_provider, args=('future_thread',)); t.start(); t.join()
elif case.startswith('port'):
    for port in (int(os.environ['OWNED_PORT']), int(os.environ['OTHER_PORT'])):
        s = socket.socket()
        try: s.connect(('127.0.0.1', port)); out[str(port)] = 'connected'
        except PermissionError: out[str(port)] = 'refused'
        except OSError as e: out[str(port)] = 'os:' + type(e).__name__
        finally: s.close()
gate.set(); pre.join()
print(json.dumps(out))
'''

BODIES = {
    # literal module body only: permitted (logged)
    'module_body': 'PLAIN = 1\ndef provider():\n    return "ENTERED"\n',
    'function_after_import': 'PLAIN = 1\ndef provider():\n    return "ENTERED"\n',
    # a provider FUNCTION called from its own module body during import: must not enter
    'function_during_import': 'def provider():\n    return "ENTERED"\nRESULT = provider()\nPLAIN = 1\n',
    # a class body executed during import is not the literal module body: refused
    'class_during_import': 'class Provider:\n    X = 1\nPLAIN = 1\n',
    # the one authorized class body: exact docstring-only Exception subclass, as in pinned stock
    'allowed_class': 'class ImageGenerationInterrupted(Exception):\n    """Raised when the user interrupts while a FAL job is in flight."""\n\n\nPLAIN = 1\n',
    # same name, but a FUNCTION called during import: refused
    'same_name_function': 'def ImageGenerationInterrupted():\n    return "ENTERED"\nRESULT = ImageGenerationInterrupted()\nPLAIN = 1\n',
    # same name and docstring, but the class body loads another name: refused
    'same_name_class_extra': 'class ImageGenerationInterrupted(Exception):\n    """Raised when the user interrupts while a FAL job is in flight."""\n    X = len("a")\nPLAIN = 1\n',
    # same name and docstring, plus a method definition (nested code object): refused
    'same_name_class_method': 'class ImageGenerationInterrupted(Exception):\n    """Raised when the user interrupts while a FAL job is in flight."""\n    def run(self):\n        return 1\nPLAIN = 1\n',
    'same_name_function_after': 'PLAIN = 1\ndef ImageGenerationInterrupted():\n    return "ENTERED"\n',
}


class FakeImageGuard(unittest.TestCase):
    def run_case(self, case, env_extra=None):
        with tempfile.TemporaryDirectory() as tmp:
            tmp = Path(tmp)
            (tmp / 'pkg/tools').mkdir(parents=True); (tmp / 'pkg/tools/__init__.py').write_text('')
            (tmp / 'pkg/plugins/image_gen').mkdir(parents=True)
            (tmp / 'pkg/plugins/__init__.py').write_text(''); (tmp / 'pkg/plugins/image_gen/__init__.py').write_text('')
            (tmp / 'pkg/plugins/image_gen/fakeprov.py').write_text('PLAIN = 1\n')
            (tmp / 'pkg/tools/image_generation_tool.py').write_text(BODIES.get(case, BODIES['module_body']))
            (tmp / 'runner.py').write_text(RUNNER)
            env = {'PATH': '/usr/bin:/bin', 'GUARD_PKG': str(tmp / 'pkg'), 'GUARD_PLUGIN': str(PLUGIN),
                   'RETAKE_FAKE_LEDGER': str(tmp / 'ledger.jsonl'), **(env_extra or {})}
            proc = subprocess.run([guard_python(), '-I', '-B', str(tmp / 'runner.py'), case], env=env, cwd=tmp,
                                  capture_output=True, text=True, timeout=60)
            self.assertEqual(proc.returncode, 0, proc.stderr)
            ledger = [json.loads(l) for l in (tmp / 'ledger.jsonl').read_text().splitlines()]
            return json.loads(proc.stdout.strip().splitlines()[-1]), ledger

    def kinds(self, ledger, kind): return [e for e in ledger if e['kind'] == kind]

    def test_literal_module_body_of_exact_module_is_permitted_and_logged(self):
        out, ledger = self.run_case('module_body')
        self.assertEqual(out['import'], 1)
        self.assertEqual([(e['module'], e['function']) for e in self.kinds(ledger, 'imported')],
                         [('tools.image_generation_tool', '<module>')])
        self.assertEqual(self.kinds(ledger, 'blocked'), [])

    def test_provider_function_called_from_its_own_module_body_cannot_enter(self):
        out, ledger = self.run_case('function_during_import')
        self.assertEqual(out['import'], 'refused')
        self.assertIn(('tools.image_generation_tool', 'provider'),
                      [(e['module'], e['function']) for e in self.kinds(ledger, 'blocked')])

    def test_class_body_during_import_is_refused(self):
        out, ledger = self.run_case('class_during_import')
        self.assertEqual(out['import'], 'refused')
        self.assertIn('Provider', [e['function'] for e in self.kinds(ledger, 'blocked')])

    def test_exact_docstring_only_class_body_is_permitted_and_logged(self):
        out, ledger = self.run_case('allowed_class')
        self.assertEqual(out['import'], 1)
        self.assertEqual([(e['function'], e.get('code_kind')) for e in self.kinds(ledger, 'imported')],
                         [('<module>', None), ('ImageGenerationInterrupted', 'class-body')])
        self.assertEqual(self.kinds(ledger, 'blocked'), [])

    def test_same_named_function_is_refused_during_and_after_import(self):
        out, ledger = self.run_case('same_name_function')
        self.assertEqual(out['import'], 'refused')
        self.assertIn('ImageGenerationInterrupted', [e['function'] for e in self.kinds(ledger, 'blocked')])
        out, ledger = self.run_case('same_name_function_after')
        self.assertEqual((out['import'], out['call0'], out['call1']), (1, 'refused', 'refused'))
        self.assertEqual(len(self.kinds(ledger, 'blocked')), 2)

    def test_same_named_class_with_other_body_is_refused(self):
        for case in ('same_name_class_extra', 'same_name_class_method'):
            out, ledger = self.run_case(case)
            self.assertEqual(out['import'], 'refused', case)
            self.assertIn('ImageGenerationInterrupted', [e['function'] for e in self.kinds(ledger, 'blocked')], case)

    def test_plugins_image_gen_module_body_is_refused(self):
        out, ledger = self.run_case('plugins_image_gen_body')
        self.assertEqual(out['import'], 'refused')
        self.assertEqual(self.kinds(ledger, 'imported'), [])
        self.assertIn('plugins.image_gen.fakeprov', [e['module'] for e in self.kinds(ledger, 'blocked')])

    def test_function_after_import_refused_repeatedly_in_existing_and_future_threads(self):
        out, ledger = self.run_case('function_after_import')
        self.assertEqual(out['import'], 1)
        for key in ('call0', 'call1', 'call2', 'existing_thread', 'future_thread'):
            self.assertEqual(out[key], 'refused', (key, out))
        self.assertEqual(len([e for e in self.kinds(ledger, 'blocked') if e['function'] == 'provider']), 5)

    def closed_ports(self):
        ports = []
        for _ in range(2):
            s = socket.socket(); s.bind(('127.0.0.1', 0)); ports.append(s.getsockname()[1]); s.close()
        return ports

    def test_owned_port_option_refuses_other_loopback_ports(self):
        owned, other = self.closed_ports()
        out, ledger = self.run_case('port_owned', {'RETAKE_FAKE_ALLOWED_PORTS': str(owned),
                                                  'OWNED_PORT': str(owned), 'OTHER_PORT': str(other)})
        self.assertEqual(out[str(owned)], 'os:ConnectionRefusedError')
        self.assertEqual(out[str(other)], 'refused')
        self.assertIn(f'127.0.0.1:{other}', [e.get('host') for e in self.kinds(ledger, 'blocked')])

    def test_default_without_option_keeps_older_any_loopback_rule(self):
        owned, other = self.closed_ports()
        out, _ = self.run_case('port_default', {'OWNED_PORT': str(owned), 'OTHER_PORT': str(other)})
        self.assertEqual(out, {'registered': 'image_generate', str(owned): 'os:ConnectionRefusedError',
                               str(other): 'os:ConnectionRefusedError'})


if __name__ == '__main__':
    unittest.main()
