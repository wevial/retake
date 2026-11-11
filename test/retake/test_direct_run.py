"""Direct (chat-free) generation: POST .../run claims once and calls the tool once for THIS profile.

Real ASGI router + disposable SQLite. The transport (`direct_runner.mcp_dispatch`, which spawns stock's
hermes_tools_mcp_server) is replaced by a counting fake that writes into the profile's generated-image
cache, exactly where the stock tool writes. No chat, session, command catalog or focus state exists here."""
import asyncio
import base64
import hashlib
import io
import json
import time
import unittest
from unittest.mock import patch
from PIL import Image
import test_backend as harness


def png(color, size=(20, 10)):
    out = io.BytesIO(); Image.new('RGB', size, color).save(out, 'PNG'); return out.getvalue()


class DirectRun(unittest.TestCase):
    tearDown = harness.RetakeTest.tearDown
    run_async = harness.RetakeTest.run_async

    def setUp(self):
        harness.RetakeTest.setUp(self)
        self.calls = []
        self.edit = True
        self.out = png('teal', (24, 16))
        runner = self.api.direct_runner
        test = self

        def fake_dispatch(home, args):
            test.calls.append({'home': str(home), 'args': args})
            if 'image_url' in args and not test.edit:
                raise runner.NotSent('no_edit_support')
            d = home / 'cache' / 'generated' / 'images'; d.mkdir(parents=True, exist_ok=True)
            path = d / f'fake-{len(test.calls)}.png'; path.write_bytes(test.out)
            return json.dumps({'success': True, 'image': str(path), 'provider': 'fixture-fake', 'model': 'fixture/fake',
                               'modality': 'image' if 'image_url' in args else 'text'})
        self.patches = [patch.object(runner, 'mcp_dispatch', fake_dispatch),
                        patch.object(self.api, 'profile_home', lambda: self.scope)]
        for p in self.patches: p.start()

    def doCleanups(self):
        for p in getattr(self, 'patches', []): p.stop()
        return super().doCleanups()

    async def settle(self, c, pid, aid):
        for _ in range(200):
            a = (await c.get(f'/projects/{pid}/generations/{aid}')).json()['attempt']
            if a['state'] not in ('reserved', 'running'): return a
            await asyncio.sleep(0.02)
        self.fail('attempt never finished')

    async def reserve(self, c, pid, n, **kw):
        body = {'client_request_id': f'{n:032x}', 'confirmed': True, 'aspect_ratio': 'landscape', **kw}
        if 'parent_id' not in kw: body.setdefault('prompt', 'An amber radio')
        r = await c.post(f'/projects/{pid}/generations', json=body)
        self.assertEqual(r.status_code, 200, r.text)
        return r.json()['attempt']

    def test_cold_run_without_any_chat_calls_once_and_stores_version(self):
        async def flow(c):
            pid = (await c.post('/projects', json={'name': 'Direct'})).json()['id']
            a = await self.reserve(c, pid, 1)
            self.assertEqual(self.calls, [], 'reserving never dispatches')
            r = await c.post(f'/projects/{pid}/generations/{a["id"]}/run')
            self.assertEqual(r.status_code, 200, r.text); self.assertTrue(r.json()['started'])
            self.assertEqual(r.json()['attempt']['state'], 'running', 'claimed atomically before dispatch')
            done = await self.settle(c, pid, a['id'])
            self.assertEqual(done['state'], 'succeeded', done)
            self.assertEqual(done['claimed_via'], 'direct')
            self.assertEqual(len(self.calls), 1)
            self.assertEqual(self.calls[0]['args'], {'prompt': 'An amber radio', 'aspect_ratio': 'landscape'})
            self.assertEqual(self.calls[0]['home'], str(self.scope), 'the requesting profile home only')
            board = (await c.get(f'/projects/{pid}')).json()
            v = next(x for x in board['versions'] if x['id'] == done['version_id'])
            self.assertEqual(v['sha256'], hashlib.sha256(self.out).hexdigest())
            self.assertEqual((done['reported_provider'], done['model'], done['variant_verified']), ('fixture-fake', 'fixture/fake', False))
            # Replays: same run, a new reservation with the same nonce, a second run: none dispatch again.
            again = await c.post(f'/projects/{pid}/generations/{a["id"]}/run')
            self.assertEqual(again.status_code, 200); self.assertFalse(again.json()['started'])
            self.assertIn('never runs an attempt twice', again.json()['reason'])
            same = await self.reserve(c, pid, 1)
            self.assertEqual(same['id'], a['id'])
            await asyncio.sleep(0.1)
            self.assertEqual(len(self.calls), 1, 'exactly one tool call per attempt')
        self.run_async(flow)

    def test_parallel_runs_dispatch_once(self):
        async def flow(c):
            pid = (await c.post('/projects', json={'name': 'Race'})).json()['id']
            a = await self.reserve(c, pid, 2)
            rs = await asyncio.gather(*[c.post(f'/projects/{pid}/generations/{a["id"]}/run') for _ in range(4)])
            self.assertEqual(sorted(r.json()['started'] for r in rs), [False, False, False, True])
            await self.settle(c, pid, a['id']); await asyncio.sleep(0.1)
            self.assertEqual(len(self.calls), 1)
        self.run_async(flow)

    def test_other_profile_cannot_run_and_nothing_is_sent(self):
        async def flow(c):
            pid = (await c.post('/projects', json={'name': 'Alpha'})).json()['id']
            a = await self.reserve(c, pid, 3)
            alpha = self.scope
            self.scope = self.home / 'beta'
            r = await c.post(f'/projects/{pid}/generations/{a["id"]}/run')
            self.assertEqual(r.status_code, 404, r.text)
            beta_pid = (await c.post('/projects', json={'name': 'Beta'})).json()['id']
            r = await c.post(f'/projects/{beta_pid}/generations/{a["id"]}/run')
            self.assertEqual(r.status_code, 404, 'an ID from another profile is unknown here')
            self.assertEqual(self.calls, [])
            self.scope = alpha
            self.assertEqual((await c.get(f'/projects/{pid}/generations/{a["id"]}')).json()['attempt']['state'], 'reserved')
        self.run_async(flow)

    def test_home_that_does_not_own_the_store_refuses(self):
        async def flow(c):
            pid = (await c.post('/projects', json={'name': 'Mismatch'})).json()['id']
            a = await self.reserve(c, pid, 4)
            with patch.object(self.api, 'profile_home', lambda: self.home / 'elsewhere'):
                r = await c.post(f'/projects/{pid}/generations/{a["id"]}/run')
            self.assertEqual(r.status_code, 503, r.text); self.assertEqual(self.calls, [])
        self.run_async(flow)

    async def revision_setup(self, c):
        pid = (await c.post('/projects', json={'name': 'Revise'})).json()['id']
        parent_bytes = png('orange', (30, 20))
        v1 = (await c.post(f'/projects/{pid}/versions', files={'file': ('a.png', parent_bytes, 'image/png')})).json()
        await c.post(f'/projects/{pid}/versions/{v1["id"]}/annotations', json={'kind': 'region', 'note': 'Dial glow', 'region': {'x': .1, 'y': .1, 'width': .2, 'height': .2}})
        brief = (await c.post(f'/projects/{pid}/versions/{v1["id"]}/briefs', json={'change': 'Soften the light', 'preserve': 'Amber body'})).json()
        return pid, v1, brief, parent_bytes

    def test_revision_sends_exact_parent_bytes_and_records_lineage(self):
        async def flow(c):
            pid, v1, brief, parent_bytes = await self.revision_setup(c)
            a = await self.reserve(c, pid, 5, parent_id=v1['id'], brief_id=brief['id'])
            await c.post(f'/projects/{pid}/generations/{a["id"]}/run')
            done = await self.settle(c, pid, a['id'])
            self.assertEqual(done['state'], 'succeeded', done)
            sent = self.calls[0]['args']
            head, data = sent['image_url'].split(',', 1)
            self.assertEqual(head, 'data:image/png;base64')
            self.assertEqual(hashlib.sha256(base64.b64decode(data)).hexdigest(), v1['sha256'], 'exact parent bytes')
            self.assertIn('Soften the light', sent['prompt']); self.assertIn('Dial glow', sent['prompt'])
            board = (await c.get(f'/projects/{pid}')).json()
            child = next(v for v in board['versions'] if v['id'] == done['version_id'])
            self.assertEqual((child['parent_id'], child['asset_id']), (v1['id'], v1['asset_id']))
            self.assertEqual((done['brief']['id'], done['parent_sha256']), (brief['id'], v1['sha256']))
            original = next(v for v in board['versions'] if v['id'] == v1['id'])
            self.assertEqual(original['sha256'], hashlib.sha256(parent_bytes).hexdigest(), 'parent stays immutable')
        self.run_async(flow)

    def test_revision_without_edit_support_is_refused_with_nothing_sent(self):
        self.edit = False
        async def flow(c):
            pid, v1, brief, _ = await self.revision_setup(c)
            a = await self.reserve(c, pid, 6, parent_id=v1['id'], brief_id=brief['id'])
            await c.post(f'/projects/{pid}/generations/{a["id"]}/run')
            done = await self.settle(c, pid, a['id'])
            self.assertEqual((done['state'], done['error']['code']), ('failed', 'no_edit_support'))
            self.assertIn('Nothing was sent', done['error']['message'])
            self.assertEqual(len((await c.get(f'/projects/{pid}')).json()['versions']), 1, 'no fake edit stored')
        self.run_async(flow)

    def test_text_only_result_for_a_revision_is_not_stored_as_an_edit(self):
        async def flow(c):
            pid, v1, brief, _ = await self.revision_setup(c)
            runner = self.api.direct_runner
            def text_only(home, args):
                self.calls.append(args)
                d = home / 'cache' / 'generated' / 'images'; d.mkdir(parents=True, exist_ok=True)
                (d / 'x.png').write_bytes(self.out)
                return json.dumps({'success': True, 'image': str(d / 'x.png'), 'modality': 'text'})
            with patch.object(runner, 'mcp_dispatch', text_only):
                a = await self.reserve(c, pid, 7, parent_id=v1['id'], brief_id=brief['id'])
                await c.post(f'/projects/{pid}/generations/{a["id"]}/run')
                done = await self.settle(c, pid, a['id'])
            self.assertEqual((done['state'], done['error']['code']), ('failed', 'not_edited'))
        self.run_async(flow)

    def test_failure_after_dispatch_is_unknown_and_never_retried(self):
        async def flow(c):
            pid = (await c.post('/projects', json={'name': 'Lost'})).json()['id']
            runner = self.api.direct_runner
            def lost(home, args):
                self.calls.append(args); raise RuntimeError('connection lost mid-call')
            with patch.object(runner, 'mcp_dispatch', lost):
                a = await self.reserve(c, pid, 8)
                await c.post(f'/projects/{pid}/generations/{a["id"]}/run')
                done = await self.settle(c, pid, a['id'])
                again = (await c.post(f'/projects/{pid}/generations/{a["id"]}/run')).json()
            self.assertEqual((done['state'], done['error']['code']), ('unknown', 'tool_exception'))
            self.assertFalse(again['started']); self.assertEqual(len(self.calls), 1)
        self.run_async(flow)

    def test_tool_server_missing_the_tool_is_failed_not_sent(self):
        async def flow(c):
            pid = (await c.post('/projects', json={'name': 'Hidden'})).json()['id']
            runner = self.api.direct_runner
            def hidden(home, args): raise runner.NotSent('tool_unavailable')
            with patch.object(runner, 'mcp_dispatch', hidden):
                a = await self.reserve(c, pid, 9)
                await c.post(f'/projects/{pid}/generations/{a["id"]}/run')
                done = await self.settle(c, pid, a['id'])
            self.assertEqual((done['state'], done['error']['code']), ('failed', 'tool_unavailable'))
            self.assertIn('tools.tool_search', done['error']['message'])
        self.run_async(flow)

    def test_get_and_capabilities_never_dispatch(self):
        async def flow(c):
            pid = (await c.post('/projects', json={'name': 'Reads'})).json()['id']
            a = await self.reserve(c, pid, 10)
            for path in ('/generation-capabilities', f'/projects/{pid}', f'/projects/{pid}/generations/{a["id"]}', '/projects'):
                self.assertEqual((await c.get(path)).status_code, 200)
            self.assertEqual(self.calls, [])
        self.run_async(flow)


if __name__ == '__main__':
    unittest.main()
