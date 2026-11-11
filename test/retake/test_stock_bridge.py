"""`/retake-generate` on stock Hermes: reservation -> command -> FAKE `image_generate` -> durable output.

The plugin package is loaded the way the frozen boundary test loads it (actual __init__.py). Only the
public host seams are stubbed: `hermes_constants.get_hermes_home` (the profile home the host binds for
the call), `plugins.plugin_storage.plugin_data_dir`, and `ctx.register_command` / `ctx.dispatch_tool`.
Every tool here is a FAKE that writes fixture bytes; nothing is provider or portability proof."""
import importlib.util
import json
from pathlib import Path
import sys
import threading
import types
import unittest
from unittest.mock import patch
import test_backend as harness

PKG = Path(__file__).resolve().parents[2] 
SECRETS = ('sk-SECRET', '/home/someone', 'provider.invalid', 'Traceback')


def cid(n):
    return f'{n:032x}'


class FakeCtx:
    """Public PluginContext surface only. `dispatch_tool` is a scripted FAKE image tool."""
    def __init__(self, test, script=None):
        self.test, self.commands, self.calls, self.script = test, {}, [], list(script or [])
        self.started, self.release = threading.Event(), None
    def register_command(self, name, handler, **kwargs):
        self.commands[name] = handler
    def dispatch_tool(self, name, args, **kwargs):
        self.calls.append((name, dict(args)))
        self.started.set()
        if self.release is not None: assert self.release.wait(10), 'test never released the fake tool'
        step = self.script.pop(0) if self.script else 'ok'
        if isinstance(step, BaseException): raise step
        if step == 'ok': return json.dumps(self.test.write_output())
        return step if isinstance(step, str) else json.dumps(step)


class Bridge(unittest.TestCase):
    setUp_router = harness.RetakeTest.setUp
    tearDown_router = harness.RetakeTest.tearDown
    run_async = harness.RetakeTest.run_async

    def setUp(self):
        self.setUp_router()
        consts = types.ModuleType('hermes_constants')
        consts.get_hermes_home = lambda: self.scope  # what the host binds for this call
        self.consts = patch.dict(sys.modules, {'hermes_constants': consts}); self.consts.start()
        self.loaded = []

    def tearDown(self):
        for name in self.loaded:
            for key in list(sys.modules):
                if key == name or key.startswith(name + '.'): sys.modules.pop(key, None)
        self.consts.stop(); self.tearDown_router()

    def plugin(self, script=None):
        """Load the actual package and register it under the CURRENT profile home."""
        name = f'retake_bridge_{len(self.loaded)}'
        spec = importlib.util.spec_from_file_location(name, PKG / '__init__.py', submodule_search_locations=[str(PKG)])
        module = importlib.util.module_from_spec(spec); sys.modules[name] = module; self.loaded.append(name)
        spec.loader.exec_module(module)
        ctx = FakeCtx(self, script)
        module.register(ctx)
        ctx.module_name = name
        return ctx, ctx.commands['retake-generate']

    def bridge_store(self, ctx):
        __import__(ctx.module_name + '.stock_bridge')
        return sys.modules[ctx.module_name + '.retake_store']

    def write_output(self, name='fake.png', **extra):
        d = self.scope / 'cache' / 'generated' / 'images'; d.mkdir(parents=True, exist_ok=True)
        (d / name).write_bytes(self.png)
        return {'success': True, 'image': str(d / name), 'provider': 'fake-tool', 'model': 'fake/model-1', 'modality': 'text', **extra}

    async def reserve(self, c, n=1, pid=None, **body):
        pid = pid or (await c.post('/projects', json={'name': 'Bridge'})).json()['id']
        r = await c.post(f'/projects/{pid}/generations', json={'client_request_id': cid(n), 'confirmed': True, 'prompt': 'An amber radio', 'aspect_ratio': 'portrait', **body})
        self.assertEqual(r.status_code, 200, r.text)
        return pid, r.json()['attempt']

    async def board(self, c, pid):
        return (await c.get(f'/projects/{pid}')).json()

    def test_registration_is_inert_and_registers_one_command(self):
        ctx, _ = self.plugin()
        self.assertEqual(list(ctx.commands), ['retake-generate'])
        self.assertEqual(ctx.calls, [])
        self.assertFalse(self.scope.exists(), 'registration created no storage')

    def test_valid_reservation_runs_once_and_stores_durable_output(self):
        ctx, command = self.plugin()
        async def flow(c):
            pid, a = await self.reserve(c)
            self.assertEqual(ctx.calls, [], 'reserving never dispatches')
            out = command(a['id'])
            self.assertEqual(ctx.calls, [('image_generate', {'prompt': 'An amber radio', 'aspect_ratio': 'portrait'})], 'exact public args; no provider/model override')
            self.assertIn('stored as a new immutable version', out)
            board = await self.board(c, pid)
            done = next(x for x in board['attempts'] if x['id'] == a['id'])
            self.assertEqual((done['state'], done['claimed_via'], done['reported_provider'], done['model'], done['variant_verified']), ('succeeded', 'retake-generate', 'fake-tool', 'fake/model-1', False))
            v = next(x for x in board['versions'] if x['id'] == done['version_id'])
            self.assertEqual((v['origin'], v['generation_attempt_id'], v['parent_id'], v['mime']), ('generated', a['id'], None, 'image/png'))
            media = (await c.get(f'/projects/{pid}/versions/{v["id"]}/media')).json()
            import base64
            self.assertEqual(base64.b64decode(media['base64']), self.png)
        self.run_async(flow)

    def test_duplicate_command_and_nonce_replay_never_redispatch(self):
        ctx, command = self.plugin()
        async def flow(c):
            pid, a = await self.reserve(c)
            command(a['id'])
            again = command(a['id'])
            self.assertIn('never runs an attempt twice', again)
            replay = (await c.post(f'/projects/{pid}/generations', json={'client_request_id': cid(1), 'confirmed': True, 'prompt': 'An amber radio', 'aspect_ratio': 'portrait'})).json()
            self.assertEqual((replay['attempt']['id'], replay['attempt']['state'], replay['dispatch']), (a['id'], 'succeeded', None))
            self.assertEqual(len(ctx.calls), 1)
            self.assertEqual(len((await self.board(c, pid))['versions']), 1)
        self.run_async(flow)

    def test_concurrent_claims_dispatch_once(self):
        ctx, command = self.plugin()
        ctx.release = threading.Event()
        async def flow(c):
            pid, a = await self.reserve(c)
            results = []
            worker = threading.Thread(target=lambda: results.append(command(a['id'])))
            worker.start()
            try:
                self.assertTrue(ctx.started.wait(5))
                self.assertIn('already running', command(a['id']))
                running = (await c.get(f'/projects/{pid}/generations/{a["id"]}')).json()['attempt']
                self.assertEqual(running['state'], 'running')
                self.assertEqual((await c.post(f'/projects/{pid}/generations/{a["id"]}/cancel')).json()['attempt']['state'], 'running', 'a claimed attempt cannot be cancelled')
            finally:
                ctx.release.set(); worker.join(10)
            self.assertEqual(len(ctx.calls), 1)
            self.assertIn('stored', results[0])
        self.run_async(flow)

    def test_malformed_nonexistent_terminal_and_expired_ids_never_dispatch(self):
        ctx, command = self.plugin()
        for raw in ['../invalid-attempt', '', None, 'A' * 32, 'a' * 31, 'a' * 33, cid(1) + ' extra', f'{cid(1)}/..', 'g' * 32]:
            self.assertIn('Nothing was sent', command(raw), raw)
        self.assertFalse(self.scope.exists(), 'malformed IDs never touch storage')
        self.assertIn('no Retake attempt', command(cid(77)), 'no store yet: nothing to claim')
        async def flow(c):
            pid, a = await self.reserve(c)
            self.assertIn('no Retake attempt', command(cid(78)))
            await c.post(f'/projects/{pid}/generations/{a["id"]}/cancel')
            self.assertIn('already failed', command(a['id']))
            _, b = await self.reserve(c, 2, pid)
            with patch.object(self.bridge_store(ctx), 'RESERVE_TTL', -1):
                self.assertIn('expired', command(b['id']))
            got = (await c.get(f'/projects/{pid}/generations/{b["id"]}')).json()['attempt']
            self.assertEqual((got['state'], got['error']['code']), ('failed', 'expired'))
        self.run_async(flow)
        self.assertEqual(ctx.calls, [])

    def test_cross_profile_invocations_refuse_without_dispatch(self):
        alpha_ctx, alpha_command = self.plugin()  # registered while the host bound profile alpha
        async def reserve(c):
            self.pid, self.attempt = await self.reserve(c)
        self.run_async(reserve)
        self.scope = self.home / 'beta'  # the host binds another profile for this call
        self.assertIn('different Hermes profile', alpha_command(self.attempt['id']))
        beta_ctx, beta_command = self.plugin()  # the beta profile's own plugin instance
        self.assertIn('no Retake attempt', beta_command(self.attempt['id']), "beta's store has no alpha attempt")
        async def beta_reserve(c):
            await self.reserve(c, 2)
        self.run_async(beta_reserve)
        self.assertIn('no Retake attempt', beta_command(self.attempt['id']))
        self.assertEqual((alpha_ctx.calls, beta_ctx.calls), ([], []))
        self.scope = self.home / 'alpha'
        async def still_reserved(c):
            self.assertEqual((await c.get(f'/projects/{self.pid}/generations/{self.attempt["id"]}')).json()['attempt']['state'], 'reserved')
        self.run_async(still_reserved)

    def test_copied_record_from_another_store_is_refused(self):
        ctx, command = self.plugin()
        async def flow(c):
            pid, a = await self.reserve(c)
            import sqlite3
            con = sqlite3.connect(self.scope / 'plugin-data' / 'retake' / 'retake.sqlite3')
            con.execute("UPDATE generation_attempts SET data=json_set(data,'$.storage_key','0000') WHERE id=?", (a['id'],)); con.commit(); con.close()
            self.assertIn('not reserved in this profile', command(a['id']))
        self.run_async(flow)
        self.assertEqual(ctx.calls, [])

    def test_tool_failures_are_classified_bounded_and_never_leak(self):
        leak = 'token sk-SECRET at /home/someone/.hermes https://provider.invalid/x Traceback (most recent call last)'
        cases = [
            ({'success': False, 'image': None, 'error': f'401 Unauthorized {leak}', 'error_type': 'auth_required'}, 'unknown', 'tool_error', 'signin'),
            ({'success': False, 'image': None, 'error': f'Insufficient credits (402) {leak}', 'error_type': 'provider_exception'}, 'unknown', 'tool_error', 'credits'),
            ({'success': False, 'image': None, 'error': f'rate limit 429 {leak}', 'error_type': 'api_error'}, 'unknown', 'tool_error', 'quota'),
            ({'success': False, 'image': None, 'error': 'Image generation is unavailable in this environment.\nFAL_KEY ...', 'error_type': 'ValueError'}, 'unknown', 'tool_error', 'signin'),
            ({'success': False, 'image': None, 'error': f"Provider 'x' does not support image-to-image {leak}", 'error_type': 'modality_unsupported'}, 'unknown', 'tool_error', 'unsupported'),
            ({'error': f'Unknown tool: image_generate {leak}'}, 'unknown', 'tool_error', 'unsupported'),
            ({'success': False, 'image': None, 'error': leak, 'error_type': 'weird<script>'}, 'unknown', 'tool_error', 'other'),
            (RuntimeError(leak), 'unknown', 'tool_exception', None),
            (f'not json {leak}', 'unknown', 'tool_exception', None),
            ({'success': True, 'image': 'https://provider.invalid/fal.png', 'model': 'm'}, 'failed', 'invalid_output', None),
            ({'success': True, 'image': '/home/someone/elsewhere.png'}, 'failed', 'invalid_output', None),
        ]
        ctx, command = self.plugin([c[0] for c in cases])
        async def flow(c):
            pid = None
            for n, (_, state, code, category) in enumerate(cases, start=1):
                pid, a = await self.reserve(c, n, pid)
                out = command(a['id'])
                got = (await c.get(f'/projects/{pid}/generations/{a["id"]}')).json()['attempt']
                self.assertEqual((got['state'], got['error']['code']), (state, code), n)
                if category: self.assertEqual(got['error']['category'], category, n)
                self.assertIsNone(got['version_id'])
                text = json.dumps(got) + out
                for secret in SECRETS: self.assertNotIn(secret, text, (n, secret))
                if state == 'unknown' or code == 'invalid_output': self.assertIn('billed', got['error']['message'], 'post-dispatch outcomes stay possibly billed')
                self.assertNotIn('Nothing was billed', got['error']['message'])
                self.assertIn('already', command(a['id']), 'no automatic retry')
            self.assertEqual(len(ctx.calls), len(cases))
            self.assertEqual((await self.board(c, pid))['versions'], [])
        self.run_async(flow)

    def test_cancellation_during_tool_call_records_unknown_and_propagates(self):
        ctx, command = self.plugin([KeyboardInterrupt()])
        async def flow(c):
            pid, a = await self.reserve(c)
            with self.assertRaises(KeyboardInterrupt): command(a['id'])
            got = (await c.get(f'/projects/{pid}/generations/{a["id"]}')).json()['attempt']
            self.assertEqual((got['state'], got['error']['code']), ('unknown', 'tool_exception'))
            self.assertIn('already unknown', command(a['id']))
        self.run_async(flow)
        self.assertEqual(len(ctx.calls), 1)

    def test_quota_rechecked_before_insert(self):
        ctx, command = self.plugin()
        async def flow(c):
            pid, a = await self.reserve(c)
            with patch.object(self.bridge_store(ctx), 'MAX_VERSIONS', 0):
                command(a['id'])
            got = (await c.get(f'/projects/{pid}/generations/{a["id"]}')).json()['attempt']
            self.assertEqual((got['state'], got['error']['code'], got['version_id']), ('failed', 'quota', None))
        self.run_async(flow)

    def test_qualified_revision_sends_exact_owned_raster_and_requires_edit_modality(self):
        """Gate forced open on BOTH halves: proves the data-URI path and the post-hoc edit check."""
        ctx, command = self.plugin([{'__write__': 'text'}, {'__write__': 'image'}])
        def scripted(name, args, **kw):
            ctx.calls.append((name, dict(args)))
            return json.dumps(self.write_output(f'r{len(ctx.calls)}.png', modality=ctx.script.pop(0)['__write__']))
        ctx.dispatch_tool = scripted
        async def flow(c):
            pid = (await c.post('/projects', json={'name': 'Rev'})).json()['id']
            v = (await c.post(f'/projects/{pid}/versions', files={'file': ('a.png', self.png, 'image/png')})).json()
            b = (await c.post(f'/projects/{pid}/versions/{v["id"]}/briefs', json={'change': 'Bluer', 'preserve': 'Layout'})).json()
            body = lambda n: {'client_request_id': cid(n), 'confirmed': True, 'aspect_ratio': 'square', 'parent_id': v['id'], 'brief_id': b['id']}
            first = (await c.post(f'/projects/{pid}/generations', json=body(1))).json()['attempt']
            command(first['id'])
            import base64
            sent = ctx.calls[0][1]
            self.assertEqual(base64.b64decode(sent['image_url'].split(',', 1)[1]), self.png, 'exact owned raster as data URI')
            self.assertTrue(sent['image_url'].startswith('data:image/png;base64,'))
            self.assertIn('Bluer', sent['prompt'])
            got = (await c.get(f'/projects/{pid}/generations/{first["id"]}')).json()['attempt']
            self.assertEqual((got['state'], got['error']['code']), ('failed', 'not_edited'), 'text-only output is never stored as a revision')
            second = (await c.post(f'/projects/{pid}/generations', json=body(2))).json()['attempt']
            command(second['id'])
            done = (await c.get(f'/projects/{pid}/generations/{second["id"]}')).json()['attempt']
            child = next(x for x in (await self.board(c, pid))['versions'] if x['id'] == done['version_id'])
            self.assertEqual((child['parent_id'], child['asset_id']), (v['id'], v['asset_id']))
        with patch.object(self.api.store, 'REVISION_QUALIFIED', True), patch.object(self.bridge_store(ctx), 'REVISION_QUALIFIED', True):
            self.run_async(flow)

    def test_unqualified_revision_record_is_never_dispatched(self):
        ctx, command = self.plugin()
        async def flow(c):
            pid = (await c.post('/projects', json={'name': 'Rev'})).json()['id']
            v = (await c.post(f'/projects/{pid}/versions', files={'file': ('a.png', self.png, 'image/png')})).json()
            b = (await c.post(f'/projects/{pid}/versions/{v["id"]}/briefs', json={'change': 'Bluer', 'preserve': 'Layout'})).json()
            with patch.object(self.api.store, 'REVISION_QUALIFIED', True):
                a = (await c.post(f'/projects/{pid}/generations', json={'client_request_id': cid(1), 'confirmed': True, 'aspect_ratio': 'square', 'parent_id': v['id'], 'brief_id': b['id']})).json()['attempt']
            self.assertIn('nothing was sent', command(a['id']))
            got = (await c.get(f'/projects/{pid}/generations/{a["id"]}')).json()['attempt']
            self.assertEqual((got['state'], got['error']['code']), ('failed', 'not_dispatched'))
        self.run_async(flow)
        self.assertEqual(ctx.calls, [])


if __name__ == '__main__':
    unittest.main(verbosity=2)
