"""Child-process environments: an allowlist, never a copy of the backend environment.

A backend serving several profiles carries the LAUNCH profile's provider keys in os.environ. The tool
server gets only the REQUESTING profile's own secrets (stock `served_profile_child_env`); the download
and listing children get no credentials at all. Offline: no child is really started, except the opt-in
real-helper check, which runs only the stock env helper in a subprocess (no tool server, no network)."""
import asyncio
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import types
import unittest
from unittest.mock import patch
import test_result_url

ROOT = Path(__file__).resolve().parents[2]
SECRETS = {'OPENAI_API_KEY': 'launch-openai', 'FAL_KEY': 'launch-value', 'SOME_SECRET': 'launch-secret'}
KEPT = {'PATH': '/usr/bin:/bin', 'HOME': '/home/fixture', 'LANG': 'C.UTF-8', 'LC_ALL': 'C.UTF-8', 'LC_CTYPE': 'C.UTF-8',
        'TMPDIR': '/fixture/tmp'}
LAUNCH = {**SECRETS, **KEPT, 'HERMES_HOME': '/launch/home', 'TERMINAL_ENV': 'docker', 'PYTHONPATH': '/extra'}
MINIMAL = set(KEPT) | {'HERMES_HOME', 'HERMES_QUIET', 'PYTHONPATH'}
# Synthetic certificate-bundle paths (files need not exist: only propagation is checked) and launch proxies.
CA = {'SSL_CERT_FILE': '/fixture/ca/cert.pem', 'SSL_CERT_DIR': '/fixture/ca/certs',
      'REQUESTS_CA_BUNDLE': '/fixture/ca/requests.pem', 'CURL_CA_BUNDLE': '/fixture/ca/curl.pem'}
PROXIES = {'HTTPS_PROXY': 'http://user:pass@proxy.invalid:3128', 'HTTP_PROXY': 'http://user:pass@proxy.invalid:3128',
           'ALL_PROXY': 'socks5://user:pass@proxy.invalid:1080', 'NO_PROXY': 'internal.invalid',
           'https_proxy': 'http://user:pass@proxy.invalid:3128'}


class FakeMcp:
    """Just enough of `anyio` + `mcp` to see what mcp_dispatch would spawn, without spawning it."""
    def __init__(self):
        self.params = []
        fake = self

        def params(**kw):
            fake.params.append(kw); return types.SimpleNamespace(**kw)

        def stdio_client(p):
            raise OSError('fixture: never spawned')
        stdio = types.ModuleType('mcp.client.stdio'); stdio.stdio_client = stdio_client
        mcp = types.ModuleType('mcp'); mcp.ClientSession = object; mcp.StdioServerParameters = params
        anyio = types.ModuleType('anyio'); anyio.run = lambda fn: asyncio.run(fn())
        self.modules = {'anyio': anyio, 'mcp': mcp, 'mcp.client': types.ModuleType('mcp.client'), 'mcp.client.stdio': stdio}


class ChildEnv(unittest.TestCase):
    def setUp(self):
        import test_backend as harness
        harness.RetakeTest.setUp(self)
        self.runner, self.sel = self.api.direct_runner, self.api.image_selection
        self.dir = tempfile.TemporaryDirectory(); self.target = Path(self.dir.name) / 'profiles' / 'beta'
        self.target.mkdir(parents=True); (self.target / '.env').write_text('FAL_KEY=target-value\n')
        self.src = str(Path(self.dir.name) / 'src')
        self.helper_calls = []
        local = types.ModuleType('tools.environments.local')

        def served_profile_child_env(base=None, *, target_home=None, inherit_credentials=False):
            self.helper_calls.append({'base': dict(base), 'target_home': target_home, 'inherit_credentials': inherit_credentials})
            return {**base, 'HERMES_HOME': str(target_home), 'FAL_KEY': 'target-value'}
        local.served_profile_child_env = served_profile_child_env
        self.helper = local
        self.mcp = FakeMcp()
        self.patches = [patch.dict(os.environ, LAUNCH, clear=True), patch.object(self.runner, 'hermes_source', lambda: self.src),
                        patch.dict(sys.modules, {**self.mcp.modules, 'tools.environments.local': local})]
        for p in self.patches: p.start()

    def tearDown(self):
        for p in reversed(self.patches): p.stop()
        self.mock.stop(); self.tmp.cleanup(); self.dir.cleanup()

    def tool_server_env(self):
        with self.assertRaises(self.runner.NotSent) as e:
            self.runner.mcp_dispatch(self.target, {'prompt': 'x'})
        self.assertEqual(e.exception.code, 'tool_unavailable')
        self.assertEqual(len(self.mcp.params), 1)
        return self.mcp.params[0]['env']

    def download_env(self):
        seen = []

        def run(cmd, env, **kw):
            seen.append(env); return subprocess.CompletedProcess(cmd, 0, stdout=b'RETAKE_PATH=/x.png\n', stderr=b'')
        with patch('subprocess.run', run):
            self.runner.fetch_result_url(self.target, 'https://ok.invalid/a.png')
        return seen[0]

    def listing_env(self):
        seen = []

        def run(cmd, env, **kw):
            seen.append(env); return subprocess.CompletedProcess(cmd, 0, stdout=b'{"selections": []}', stderr=b'')
        with patch.object(self.sel.subprocess, 'run', run):
            self.assertEqual(self.sel._run_listing(self.target), [])
        return seen[0]

    def assert_hermes_vars(self, env):
        self.assertEqual(env['HERMES_HOME'], str(self.target))
        self.assertEqual(env['HERMES_QUIET'], '1')
        self.assertEqual(env['PYTHONPATH'].split(os.pathsep), [self.src, '/extra'])
        for k, v in KEPT.items(): self.assertEqual(env[k], v, k)

    def test_no_child_receives_the_launch_profile_secrets(self):
        for name, env in (('tool server', self.tool_server_env()), ('download', self.download_env()), ('listing', self.listing_env())):
            with self.subTest(name):
                self.assertFalse({'OPENAI_API_KEY', 'SOME_SECRET', 'TERMINAL_ENV'} & set(env), name)
                self.assertNotEqual(env.get('FAL_KEY'), 'launch-value', name)
                self.assert_hermes_vars(env)

    def test_download_and_listing_get_only_the_allowlist(self):
        self.assertEqual(set(self.download_env()), MINIMAL)
        self.assertEqual(set(self.listing_env()), MINIMAL)
        self.assertEqual(self.helper_calls, [], 'credential-free children never ask for profile secrets')

    def test_tool_server_gets_only_the_target_profile_secrets(self):
        env = self.tool_server_env()
        self.assertEqual(env['FAL_KEY'], 'target-value')
        self.assertEqual(set(env), MINIMAL | {'FAL_KEY'})
        [call] = self.helper_calls
        self.assertEqual((call['target_home'], call['inherit_credentials']), (str(self.target), True))
        self.assertEqual(set(call['base']), set(KEPT), 'helper base is the allowlist, never os.environ')

    def test_launch_scratch_tmpdir_is_not_inherited(self):
        with patch.dict(os.environ, {'HERMES_SCRATCH_DIR': '/launch/home/cache/scratch', 'TMPDIR': '/launch/home/cache/scratch'}):
            self.assertNotIn('TMPDIR', self.download_env())

    def children(self):
        return (('tool server', self.tool_server_env()), ('download', self.download_env()), ('listing', self.listing_env()))

    def test_certificate_paths_reach_every_https_child_and_proxies_do_not(self):
        with patch.dict(os.environ, {**CA, **PROXIES}):
            for name, env in self.children():
                with self.subTest(name):
                    for k, v in CA.items(): self.assertEqual(env.get(k), v, f'{name}: {k}')
                    self.assertFalse(set(PROXIES) & set(env), f'{name}: launch proxy leaked')
                    self.assertFalse({'OPENAI_API_KEY', 'SOME_SECRET', 'TERMINAL_ENV'} & set(env), name)
                    self.assertNotEqual(env.get('FAL_KEY'), 'launch-value', name)
            self.assertEqual(set(self.download_env()), MINIMAL | set(CA))
            self.assertEqual(set(self.listing_env()), MINIMAL | set(CA))
        [call, *_] = self.helper_calls
        self.assertEqual(set(call['base']), set(KEPT) | set(CA), 'helper base: allowlist incl. CA paths, no proxies')

    def test_missing_certificate_paths_stay_absent(self):
        for name, env in self.children():
            with self.subTest(name):
                self.assertFalse(set(CA) & set(env), name)

    def test_certificate_paths_leave_target_secret_resolution_unchanged(self):
        with patch.dict(os.environ, CA):
            env = self.tool_server_env()
        self.assertEqual(env['FAL_KEY'], 'target-value')
        self.assertEqual(set(env), MINIMAL | set(CA) | {'FAL_KEY'})
        self.assertEqual([(c['target_home'], c['inherit_credentials']) for c in self.helper_calls], [(str(self.target), True)])

    def test_missing_or_failing_helper_fails_closed_before_spawn(self):
        def boom(*a, **kw): raise RuntimeError('scope unavailable')
        for helper in (None, types.SimpleNamespace(served_profile_child_env=boom)):
            with self.subTest(helper=helper), patch.dict(sys.modules, {'tools.environments.local': helper}):
                with self.assertRaises(self.runner.NotSent) as e:
                    self.runner.mcp_dispatch(self.target, {'prompt': 'x'})
                self.assertEqual(e.exception.code, 'tool_unavailable')
                self.assertEqual(self.mcp.params, [], 'nothing was spawned')


def stock_src():
    for cand in (os.environ.get('RETAKE_STOCK_SRC'), str(test_result_url.STOCK)):
        if cand and (Path(cand) / 'tools' / 'environments' / 'local.py').is_file():
            return cand
    return None


CHECK = r'''import json, os, sys, types, importlib
pkg = types.ModuleType('retake_envcheck'); pkg.__path__ = [sys.argv[1]]; sys.modules['retake_envcheck'] = pkg
runner = importlib.import_module('retake_envcheck.direct_runner')
env, src = runner.server_env(sys.argv[2], credentials=True)
plain, _ = runner.server_env(sys.argv[2])
print('RETAKE_ENV=' + json.dumps({'env': env, 'src': src, 'plain': plain}))
'''


@unittest.skipUnless(stock_src(), 'stock Hermes source not available here')
class RealStockHelper(unittest.TestCase):
    """The real stock `served_profile_child_env`: the target profile's `.env` wins over the launch env."""
    def test_target_profile_env_file_is_the_only_secret_source(self):
        src = stock_src()
        with tempfile.TemporaryDirectory() as d:
            launch, target = Path(d) / 'launch', Path(d) / 'launch' / 'profiles' / 'beta'
            target.mkdir(parents=True)
            (launch / '.env').write_text('FAL_KEY=launch-value\nOPENAI_API_KEY=launch-openai\n')
            (target / '.env').write_text('FAL_KEY=target-value\n')
            env = {**SECRETS, 'PATH': os.environ.get('PATH', '/usr/bin:/bin'), 'HOME': d, 'LANG': 'C.UTF-8', 'LC_ALL': 'C.UTF-8',
                   'HERMES_HOME': str(launch), 'PYTHONPATH': src, 'PYTHONDONTWRITEBYTECODE': '1'}
            try:
                r = subprocess.run([sys.executable, '-c', CHECK, str(ROOT), str(target)], env=env, cwd=src,
                                   stdin=subprocess.DEVNULL, capture_output=True, timeout=120)
            except subprocess.TimeoutExpired:
                self.skipTest('stock import timed out')
            lines = [l for l in r.stdout.decode().splitlines() if l.startswith('RETAKE_ENV=')]
            if r.returncode != 0 and b'ModuleNotFoundError' in r.stderr:
                self.skipTest('stock imports not usable with this interpreter')
            self.assertEqual(r.returncode, 0, r.stderr.decode()[-2000:])
            got = json.loads(lines[-1][len('RETAKE_ENV='):])
        child = got['env']
        self.assertEqual(child.get('FAL_KEY'), 'target-value')
        self.assertFalse({'OPENAI_API_KEY', 'SOME_SECRET'} & set(child), sorted(child))
        self.assertEqual(child['HERMES_HOME'], str(target))
        self.assertEqual(child['PYTHONPATH'].split(os.pathsep)[0], got['src'])
        self.assertEqual(Path(got['src']).resolve(), Path(src).resolve())
        self.assertEqual((child['LANG'], child['LC_ALL'], child['HOME']), ('C.UTF-8', 'C.UTF-8', d))

    def test_certificate_path_precedence_follows_the_stock_helper(self):
        """Observed stock rules (v0.23.1 and later), asserted rather than guessed: an exported launch CA path
        reaches the tool server; the target profile's own `.env` value wins over it; a CA path that only came
        from the LAUNCH profile's `.env` is launch residue and is dropped for a routed target. Credential-free
        children get the process-level paths unchanged. Proxies and launch keys never pass."""
        src = stock_src()
        with tempfile.TemporaryDirectory() as d:
            launch, target = Path(d) / 'launch', Path(d) / 'launch' / 'profiles' / 'beta'
            target.mkdir(parents=True)
            (launch / '.env').write_text('FAL_KEY=launch-value\nCURL_CA_BUNDLE=/fixture/launch-dotenv/curl.pem\n')
            (target / '.env').write_text('FAL_KEY=target-value\nREQUESTS_CA_BUNDLE=/fixture/target/requests.pem\n')
            env = {**SECRETS, **PROXIES, 'PATH': os.environ.get('PATH', '/usr/bin:/bin'), 'HOME': d, 'LANG': 'C.UTF-8',
                   'HERMES_HOME': str(launch), 'PYTHONPATH': src, 'PYTHONDONTWRITEBYTECODE': '1',
                   'SSL_CERT_FILE': '/fixture/launch/cert.pem', 'REQUESTS_CA_BUNDLE': '/fixture/launch/requests.pem',
                   'CURL_CA_BUNDLE': '/fixture/launch-dotenv/curl.pem'}
            try:
                r = subprocess.run([sys.executable, '-c', CHECK, str(ROOT), str(target)], env=env, cwd=src,
                                   stdin=subprocess.DEVNULL, capture_output=True, timeout=120)
            except subprocess.TimeoutExpired:
                self.skipTest('stock import timed out')
            if r.returncode != 0 and b'ModuleNotFoundError' in r.stderr:
                self.skipTest('stock imports not usable with this interpreter')
            self.assertEqual(r.returncode, 0, r.stderr.decode()[-2000:])
            got = json.loads([l for l in r.stdout.decode().splitlines() if l.startswith('RETAKE_ENV=')][-1][len('RETAKE_ENV='):])
        tool, plain = got['env'], got['plain']
        self.assertEqual(tool.get('SSL_CERT_FILE'), '/fixture/launch/cert.pem')
        self.assertEqual(tool.get('REQUESTS_CA_BUNDLE'), '/fixture/target/requests.pem')
        self.assertNotIn('CURL_CA_BUNDLE', tool)
        self.assertNotIn('SSL_CERT_DIR', tool)
        self.assertEqual(tool.get('FAL_KEY'), 'target-value')
        self.assertEqual((plain['SSL_CERT_FILE'], plain['REQUESTS_CA_BUNDLE'], plain['CURL_CA_BUNDLE']),
                         ('/fixture/launch/cert.pem', '/fixture/launch/requests.pem', '/fixture/launch-dotenv/curl.pem'))
        for name, child in (('tool server', tool), ('credential-free', plain)):
            self.assertFalse(set(PROXIES) & set(child), name)
            self.assertFalse({'OPENAI_API_KEY', 'SOME_SECRET'} & set(child), name)
        self.assertNotIn('FAL_KEY', plain)


if __name__ == '__main__':
    unittest.main()
