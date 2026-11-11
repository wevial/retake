"""Retake router generation contract on STOCK Hermes: the router only RESERVES attempts.

Real ASGI router + disposable SQLite. No tool, provider, network, credentials or host loading: the
router has no path to any of them. Running a reservation is covered in test_stock_bridge.py.
(Replaces the pre-stock provider/model picker and hosted-facade tests; see STOCK-CLAUDE-RESULT.md.)"""
import base64
import io
import sqlite3
import unittest
from unittest.mock import patch
from PIL import Image
import test_backend as harness


def png(color, size=(20, 10)):
    out = io.BytesIO(); Image.new('RGB', size, color).save(out, 'PNG'); return out.getvalue()


def cid(n):
    return f'{n:032x}'


class Reservation(unittest.TestCase):
    setUp = harness.RetakeTest.setUp
    tearDown = harness.RetakeTest.tearDown
    run_async = harness.RetakeTest.run_async

    def body(self, n, **kw):
        return {'client_request_id': cid(n), 'confirmed': True, 'prompt': 'An amber radio', 'aspect_ratio': 'landscape', **kw}

    async def project(self, c, name='Gen'):
        return (await c.post('/projects', json={'name': name})).json()['id']

    def test_capabilities_are_static_and_truthful(self):
        async def flow(c):
            caps = (await c.get('/generation-capabilities')).json()
            self.assertEqual((caps['route'], caps['command'], caps['tool']), ('direct', 'retake-generate', 'image_generate'))
            self.assertIsNone(caps['provider']); self.assertIsNone(caps['model']); self.assertEqual(caps['readiness'], 'unknown')
            self.assertIn('provider account may be charged', caps['note']); self.assertIn('cost unknown', caps['note'])
            # Edit support is decided by the configured tool's advertised schema at run time, before sending.
            self.assertTrue(caps['revision']['enabled']); self.assertEqual(caps['revision']['checked'], 'at run time, before sending')
            self.assertNotIn('providers', caps); self.assertNotIn('models', caps)
            self.assertIn('own internal retries or fallback', caps['retry_note'])
        self.run_async(flow)

    def test_confirmed_post_reserves_only_and_replays(self):
        async def flow(c):
            pid = await self.project(c)
            r = await c.post(f'/projects/{pid}/generations', json=self.body(1))
            self.assertEqual(r.status_code, 200, r.text)
            a, hint = r.json()['attempt'], r.json()['dispatch']
            self.assertEqual((a['state'], a['route'], a['prompt'], a['version_id'], a['dispatched_at']), ('reserved', 'direct', 'An amber radio', None, None))
            self.assertEqual(hint, {'run': f'/projects/{pid}/generations/{a["id"]}/run', 'command': 'retake-generate', 'arg': a['id']})
            self.assertNotIn('storage_key', a, 'store identity is private')
            again = (await c.post(f'/projects/{pid}/generations', json=self.body(1))).json()
            self.assertEqual(again['attempt']['id'], a['id'], 'same nonce never reserves twice')
            board = (await c.get(f'/projects/{pid}')).json()
            self.assertEqual([x['state'] for x in board['attempts']], ['reserved']); self.assertEqual(board['versions'], [])
            busy = await c.post(f'/projects/{pid}/generations', json=self.body(2, prompt='Second'))
            self.assertEqual(busy.status_code, 409, 'one reserved/running attempt per profile')
            self.assertFalse((self.scope / 'cache').exists(), 'no tool output can exist: nothing was dispatched')
        self.run_async(flow)

    def test_validation_refuses_before_reserving(self):
        async def flow(c):
            pid = await self.project(c)
            bad = [{k: v for k, v in self.body(1).items() if k != 'confirmed'}, self.body(2, confirmed='true'), self.body(3, provider='nous'),
                   self.body(4, model='google/gemini-3-pro-image'), self.body(5, aspect_ratio='wide'), self.body(6, output_path='/tmp/x.png'),
                   self.body(7, url='https://example.invalid/x.png'), {**self.body(8), 'client_request_id': 'not-hex'},
                   self.body(9, parent_id='a' * 32), {**self.body(10), 'prompt': ''}]
            for b in bad:
                r = await c.post(f'/projects/{pid}/generations', json=b)
                self.assertIn(r.status_code, (404, 409, 422), (b, r.text))
            r = await c.post(f'/projects/{pid}/generations', content=b'x' * (70 * 1024), headers={'content-type': 'application/json'})
            self.assertEqual(r.status_code, 413)
            self.assertEqual((await c.get(f'/projects/{pid}')).json()['attempts'], [])
        self.run_async(flow)

    def test_nonce_collision_and_cross_project_reuse_are_refused(self):
        async def flow(c):
            pid, other = await self.project(c), await self.project(c, 'Other')
            first = (await c.post(f'/projects/{pid}/generations', json=self.body(1))).json()['attempt']
            self.assertEqual((await c.post(f'/projects/{pid}/generations', json=self.body(1, prompt='Different'))).status_code, 409)
            self.assertEqual((await c.post(f'/projects/{pid}/generations', json=self.body(1, aspect_ratio='square'))).status_code, 409)
            self.assertEqual((await c.post(f'/projects/{other}/generations', json=self.body(1))).status_code, 409)
            self.assertEqual((await c.get(f'/projects/{other}/generations/{first["id"]}')).status_code, 404, 'attempts are project-scoped')
        self.run_async(flow)

    def test_cancel_and_expiry_release_unclaimed_reservations_only(self):
        async def flow(c):
            pid = await self.project(c)
            a = (await c.post(f'/projects/{pid}/generations', json=self.body(1))).json()['attempt']
            done = (await c.post(f'/projects/{pid}/generations/{a["id"]}/cancel')).json()['attempt']
            self.assertEqual((done['state'], done['error']['code']), ('failed', 'cancelled'))
            self.assertIn('Nothing was sent', done['error']['message'])
            self.assertEqual((await c.post(f'/projects/{pid}/generations/{a["id"]}/cancel')).json()['attempt']['state'], 'failed', 'idempotent')
            b = (await c.post(f'/projects/{pid}/generations', json=self.body(2))).json()['attempt']
            with patch.object(self.api.store, 'RESERVE_TTL', -1):
                late = (await c.get(f'/projects/{pid}/generations/{b["id"]}')).json()['attempt']
                self.assertEqual((late['state'], late['error']['code']), ('failed', 'expired'), 'an unclaimed reservation certainly never ran')
                self.assertEqual((await c.post(f'/projects/{pid}/generations', json=self.body(3))).status_code, 200, 'expiry frees the profile')
        self.run_async(flow)

    def test_running_attempt_goes_unknown_when_stale_and_cannot_be_cancelled(self):
        async def flow(c):
            pid = await self.project(c)
            a = (await c.post(f'/projects/{pid}/generations', json=self.body(1))).json()['attempt']
            db = self.scope / 'plugin-data' / 'retake' / 'retake.sqlite3'
            con = sqlite3.connect(db); con.execute("UPDATE generation_attempts SET state='running', data=json_set(data,'$.state','running','$.dispatched_at','2000-01-01T00:00:00+00:00')"); con.commit(); con.close()
            self.assertEqual((await c.post(f'/projects/{pid}/generations/{a["id"]}/cancel')).json()['attempt']['state'], 'unknown', 'claimed attempts are never cancelled into a safe state')
            got = (await c.get(f'/projects/{pid}/generations/{a["id"]}')).json()['attempt']
            self.assertEqual((got['state'], got['error']['code']), ('unknown', 'stale'))
            self.assertIn('may or may not', got['error']['message'])
        self.run_async(flow)

    def test_quota_is_checked_before_reserving(self):
        async def flow(c):
            pid = await self.project(c)
            with patch.object(self.api, 'MAX_PROFILE_BYTES', self.api.MAX_IMAGE_BYTES - 1):
                self.assertEqual((await c.post(f'/projects/{pid}/generations', json=self.body(1))).status_code, 413)
            with patch.object(self.api, 'MAX_ATTEMPTS', 0):
                self.assertEqual((await c.post(f'/projects/{pid}/generations', json=self.body(2))).status_code, 409)
            with patch.object(self.api, 'MAX_VERSIONS', 0):
                self.assertEqual((await c.post(f'/projects/{pid}/generations', json=self.body(3))).status_code, 409)
            self.assertEqual((await c.get(f'/projects/{pid}')).json()['attempts'], [])
        self.run_async(flow)

    def test_revision_reserves_without_dispatch_and_briefs_are_unchanged(self):
        # Contract change (direct route): the edit gate moved from reservation to run time (tool schema).
        async def flow(c):
            pid = await self.project(c)
            v = (await c.post(f'/projects/{pid}/versions', files={'file': ('a.png', self.png, 'image/png')})).json()
            brief = (await c.post(f'/projects/{pid}/versions/{v["id"]}/briefs', json={'change': 'Soften', 'preserve': 'Amber'})).json()
            body = {k: x for k, x in self.body(1).items() if k != 'prompt'} | {'parent_id': v['id'], 'brief_id': brief['id']}
            r = await c.post(f'/projects/{pid}/generations', json=body)
            self.assertEqual(r.status_code, 200, r.text); self.assertEqual(r.json()['attempt']['state'], 'reserved')
            board = (await c.get(f'/projects/{pid}')).json()
            self.assertEqual([a['state'] for a in board['attempts']], ['reserved']); self.assertEqual(board['briefs'][0]['generation'], False)
            self.assertEqual(len(board['versions']), 1); self.assertFalse((self.scope / 'cache').exists())
        self.run_async(flow)

    def test_qualified_revision_binds_owned_parent_exact_brief_and_hash(self):
        """Exercised with the qualification gate forced open: the reservation contract is ready for it."""
        async def flow(c):
            pid, other = await self.project(c), await self.project(c, 'Other')
            up = lambda p, parent='': c.post(f'/projects/{p}/versions' + (f'?parent_id={parent}' if parent else ''), files={'file': ('a.png', self.png, 'image/png')})
            v1 = (await up(pid)).json(); v2 = (await up(pid, v1['id'])).json(); foreign = (await up(other)).json()
            await c.post(f'/projects/{pid}/versions/{v1["id"]}/annotations', json={'kind': 'region', 'note': 'Dial glow', 'region': {'x': .1, 'y': .1, 'width': .2, 'height': .2}})
            brief1 = (await c.post(f'/projects/{pid}/versions/{v1["id"]}/briefs', json={'change': 'Soften', 'preserve': 'Amber'})).json()
            brief2 = (await c.post(f'/projects/{pid}/versions/{v2["id"]}/briefs', json={'change': 'Other', 'preserve': 'Other'})).json()
            foreign_brief = (await c.post(f'/projects/{other}/versions/{foreign["id"]}/briefs', json={'change': 'X', 'preserve': 'Y'})).json()
            rev = lambda n, parent, brief: c.post(f'/projects/{pid}/generations', json={**{k: x for k, x in self.body(n).items() if k != 'prompt'}, 'parent_id': parent, 'brief_id': brief})
            self.assertEqual((await rev(1, v1['id'], brief2['id'])).status_code, 409, 'brief saved on another version')
            self.assertEqual((await rev(2, v1['id'], foreign_brief['id'])).status_code, 404, 'cross-project brief')
            self.assertEqual((await rev(3, foreign['id'], brief1['id'])).status_code, 404, 'cross-project parent')
            ok = await rev(5, v1['id'], brief1['id'])
            self.assertEqual(ok.status_code, 200, ok.text)
            a = ok.json()['attempt']
            self.assertEqual((a['state'], a['brief']['id'], a['brief']['change'], a['parent_sha256']), ('reserved', brief1['id'], 'Soften', v1['sha256']))
            self.assertIn('Dial glow', a['prompt']); self.assertEqual(a['brief']['annotations'][0]['note'], 'Dial glow')
            await c.post(f'/projects/{pid}/generations/{a["id"]}/cancel')
            db = self.scope / 'plugin-data' / 'retake' / 'retake.sqlite3'
            con = sqlite3.connect(db); con.execute('UPDATE versions SET media=? WHERE id=?', (png('green'), v1['id'])); con.commit(); con.close()
            self.assertEqual((await rev(6, v1['id'], brief1['id'])).status_code, 409, 'tampered parent bytes are refused')
        with patch.object(self.api.store, 'REVISION_QUALIFIED', True):
            self.run_async(flow)

    def test_revision_prompt_never_silently_omits_saved_notes(self):
        notes = [{'kind': 'region', 'note': ('x' * 700 + 'LONG_NOTE_TAIL') if i == 0 else f'NOTE_{i}',
                  'region': {'x': .1, 'y': .1, 'width': .2, 'height': .2}} for i in range(21)]
        prompt = self.api.revision_prompt({'change': 'Change', 'preserve': 'Preserve', 'annotations': notes})
        self.assertIn('LONG_NOTE_TAIL', prompt); self.assertIn('NOTE_20', prompt)
        async def flow(c):
            pid = await self.project(c)
            v = (await c.post(f'/projects/{pid}/versions', files={'file': ('reference.png', self.png, 'image/png')})).json()
            for i in range(9):
                await c.post(f'/projects/{pid}/versions/{v["id"]}/annotations', json={'kind': 'region', 'note': str(i) + 'x' * 3999, 'region': {'x': .1, 'y': .1, 'width': .2, 'height': .2}})
            brief = (await c.post(f'/projects/{pid}/versions/{v["id"]}/briefs', json={'change': 'Change', 'preserve': 'Preserve'})).json()
            body = {'confirmed': True, 'client_request_id': cid(901), 'aspect_ratio': 'square', 'parent_id': v['id'], 'brief_id': brief['id']}
            self.assertEqual((await c.post(f'/projects/{pid}/generations', json=body)).status_code, 422, 'oversized instructions are refused, never truncated')
            self.assertEqual((await c.get(f'/projects/{pid}')).json()['attempts'], [])
        with patch.object(self.api.store, 'REVISION_QUALIFIED', True):
            self.run_async(flow)

    def test_pre_stock_attempts_remain_readable(self):
        async def flow(c):
            pid = await self.project(c)
            old = {'id': 'f' * 32, 'project_id': pid, 'kind': 'new_asset', 'state': 'succeeded', 'client_request_id': 'e' * 32, 'provider': 'openai-codex',
                   'requested_model': None, 'model': 'gpt-image-2-medium', 'version_id': None, 'error': None, 'created_at': '2026-01-01T00:00:00+00:00'}
            import json
            con = sqlite3.connect(self.scope / 'plugin-data' / 'retake' / 'retake.sqlite3')
            con.execute('INSERT INTO generation_attempts VALUES (?,?,?,?,?,?)', (old['id'], pid, old['client_request_id'], 'old', 'succeeded', json.dumps(old))); con.commit(); con.close()
            got = (await c.get(f'/projects/{pid}/generations/{old["id"]}')).json()['attempt']
            self.assertEqual((got['provider'], got['state']), ('openai-codex', 'succeeded'))
            self.assertEqual((await c.post(f'/projects/{pid}/generations', json={'client_request_id': 'e' * 32, 'confirmed': True, 'prompt': 'x', 'aspect_ratio': 'square'})).status_code, 409,
                             'a pre-stock request ID cannot be replayed into the command route')
        async def init(c):
            await c.get('/projects')
        self.run_async(init); self.run_async(flow)


class OutputReader(unittest.TestCase):
    setUp = harness.RetakeTest.setUp
    tearDown = harness.RetakeTest.tearDown

    def images(self, home):
        d = home / 'cache' / 'generated' / 'images'; d.mkdir(parents=True, exist_ok=True); return d

    def test_output_reader_refuses_urls_paths_symlinks_and_oversize(self):
        read, Rejected = self.api.read_generated_output, self.api.OutputRejected
        home = self.home / 'profile'; d = self.images(home); good = d / 'ok.png'; good.write_bytes(self.png)
        self.assertEqual(read(str(good), home), (self.png, 'image/png'))
        outside = self.home / 'outside.png'; outside.write_bytes(self.png)
        link = d / 'link.png'; link.symlink_to(outside)
        (d / 'text.png').write_bytes(b'hello')
        for bad in ['https://provider.invalid/x.png', 'data:image/png;base64,' + base64.b64encode(self.png).decode(), 'file:///etc/passwd',
                    'cache/generated/images/ok.png', str(outside), str(d / '..' / 'images' / 'ok.png'), str(link), str(d / 'text.png'), str(d / 'missing.png'), '', None, 42]:
            with self.assertRaises(Rejected, msg=bad): read(bad, home)
        with self.assertRaises(Rejected): read(str(good), home, limit=10)
        other = self.home / 'other'; other_images = self.images(other); (other_images / 'x.png').write_bytes(self.png)
        home2 = self.home / 'profile2'; (home2 / 'cache' / 'generated').mkdir(parents=True); (home2 / 'cache' / 'generated' / 'images').symlink_to(other_images)
        with self.assertRaises(Rejected): read(str(home2 / 'cache' / 'generated' / 'images' / 'x.png'), home2)


if __name__ == '__main__':
    unittest.main(verbosity=2)
