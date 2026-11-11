"""Parent-owned portability boundary: plugin-only registration and no patched-host facade."""
import asyncio
import importlib.util
import inspect
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

ROOT=Path(__file__).resolve().parents[2]

class StockBoundary(unittest.TestCase):
    def test_package_does_not_reference_the_custom_host_facade(self):
        for relative in ('dashboard/plugin_api.py','desktop/plugin.js','__init__.py'):
            source=(ROOT/relative).read_text()
            self.assertFalse('hermes_image_providers' in source,relative+' still requires our Hermes patch')
            self.assertFalse('agent.image_gen_registry' in source,relative+' bypasses the public command/tool boundary')

    def test_registration_is_inert_and_bad_attempt_never_dispatches(self):
        commands={}; dispatched=[]
        class Context:
            def register_command(self,name,handler,**kwargs):
                commands[name]=handler
            def dispatch_tool(self,*args,**kwargs):
                dispatched.append((args,kwargs))
                raise AssertionError('bad attempt must never dispatch')
        name='retake_stock_boundary'
        spec=importlib.util.spec_from_file_location(name,ROOT/'__init__.py',submodule_search_locations=[str(ROOT)])
        assert spec is not None and spec.loader is not None
        module=importlib.util.module_from_spec(spec)
        sys.modules[name]=module
        try:
            with tempfile.TemporaryDirectory() as home, patch.dict('os.environ',{'HOME':home,'HERMES_HOME':home}):
                spec.loader.exec_module(module)
                module.register(Context())
                self.assertEqual(dispatched,[],'plugin registration generated an image')
                self.assertIn('retake-generate',commands,'stock plugin command bridge missing')
                try:
                    result=commands['retake-generate']('../invalid-attempt')
                    if inspect.isawaitable(result):asyncio.run(result)
                except (ValueError,TypeError):
                    pass
                self.assertEqual(dispatched,[])
        finally:
            for key in list(sys.modules):
                if key==name or key.startswith(name+'.'):sys.modules.pop(key,None)

if __name__=='__main__':unittest.main()
