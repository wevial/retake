"""Parent-owned stock-generation contract: real ASGI/SQLite, no live Hermes/provider.

Replaces the old direct-facade contract after deliberate removal of per-request
provider/model selection and unqualified automatic editing. No stubbed resolver
is allowed to make a router dispatch appear portable.
"""
import hashlib
import unittest
from typing import Any
import test_backend as harness


class GenerationContract(unittest.TestCase):
    api: Any
    png: bytes
    setUp = harness.RetakeTest.setUp
    tearDown = harness.RetakeTest.tearDown
    run_async = harness.RetakeTest.run_async

    def test_capabilities_are_read_only_and_do_not_claim_account_readiness(self):
        async def flow(c):
            for _ in range(2):
                r = await c.get('/generation-capabilities')
                self.assertEqual(r.status_code, 200, r.text)
                caps = r.json()
                self.assertIsNone(caps['provider'])
                self.assertTrue(caps['supports_reference'])  # gated per run by the tool's advertised schema
                self.assertTrue(caps['revision']['enabled'])
                self.assertNotIn('providers', caps)
                self.assertEqual((await c.get('/projects')).json(), {'projects': []})
        self.assertFalse(hasattr(self.api, 'resolve_generation_backend'))
        self.run_async(flow)

    def test_new_asset_post_reserves_only_and_replay_is_stable(self):
        async def flow(c):
            pid = (await c.post('/projects', json={'name': 'Stock contract'})).json()['id']
            body = {'client_request_id': '1' * 32, 'confirmed': True,
                    'prompt': 'An amber radio', 'aspect_ratio': 'landscape'}
            r = await c.post(f'/projects/{pid}/generations', json=body)
            self.assertEqual(r.status_code, 200, r.text)
            first = r.json()
            self.assertEqual(first['attempt']['state'], 'reserved')
            self.assertEqual(first['dispatch']['run'], f'/projects/{pid}/generations/{first["attempt"]["id"]}/run')
            board = (await c.get(f'/projects/{pid}')).json()
            self.assertEqual(board['versions'], [], 'reservation must not create a generated version')
            again = (await c.post(f'/projects/{pid}/generations', json=body)).json()
            self.assertEqual(first, again)
            for field, value in [('provider', 'nous'), ('model', 'fake/model')]:
                rejected = await c.post(f'/projects/{pid}/generations', json={**body, field: value})
                self.assertEqual(rejected.status_code, 422)
            changed = await c.post(f'/projects/{pid}/generations', json={**body, 'prompt': 'Changed after review'})
            self.assertEqual(changed.status_code, 409)
            board = (await c.get(f'/projects/{pid}')).json()
            self.assertEqual(len(board['attempts']), 1)
            self.assertEqual(board['versions'], [])
        self.run_async(flow)

    def test_revision_reservation_keeps_exact_brief_and_manual_revision_survives(self):
        async def flow(c):
            pid = (await c.post('/projects', json={'name': 'Manual revision contract'})).json()['id']
            parent = (await c.post(f'/projects/{pid}/versions', files={'file': ('radio.png', self.png, 'image/png')})).json()
            brief = (await c.post(f'/projects/{pid}/versions/{parent["id"]}/briefs',
                                 json={'change': 'Soften the tuning light', 'preserve': 'Amber enclosure'})).json()
            rejected = await c.post(f'/projects/{pid}/generations', json={
                'client_request_id': '2' * 32, 'confirmed': True,
                'parent_id': parent['id'], 'brief_id': brief['id'], 'aspect_ratio': 'landscape'})
            self.assertEqual(rejected.status_code, 200, rejected.text)  # reserved only; run-time gate decides edit support
            await c.post(f'/projects/{pid}/generations/{rejected.json()["attempt"]["id"]}/cancel')
            manual = await c.post(f'/projects/{pid}/versions?parent_id={parent["id"]}',
                                  files={'file': ('revised.png', self.png, 'image/png')})
            self.assertEqual(manual.status_code, 200, manual.text)
            child = manual.json()
            self.assertEqual(child['parent_id'], parent['id'])
            self.assertEqual(child['asset_id'], parent['asset_id'])
            board = (await c.get(f'/projects/{pid}')).json()
            self.assertEqual([a['error']['code'] for a in board['attempts']], ['cancelled'])
            original = next(v for v in board['versions'] if v['id'] == parent['id'])
            self.assertEqual(original, parent)
            self.assertEqual(original['sha256'], hashlib.sha256(self.png).hexdigest())
            reopened = (await c.get(f'/projects/{pid}')).json()['briefs']
            self.assertEqual(reopened, [brief])
        self.run_async(flow)

    def test_tool_error_text_cannot_prove_no_billing_after_dispatch(self):
        for result in (
            {'success': False, 'error_type': 'api_error', 'error': 'Previously billed job; backend unavailable in this environment'},
            {'success': False, 'error_type': 'invalid_argument', 'error': 'Provider rejected a later processing stage'},
            {'error': 'Output not available after provider execution'},
        ):
            with self.subTest(result=result):
                state, error = self.api.store.classify_tool_error(result)
                self.assertEqual(state, 'unknown')
                self.assertNotIn('Nothing was billed', error['message'])

    def test_unrecognized_error_type_is_not_reflected_as_safe_metadata(self):
        state, error = self.api.store.classify_tool_error({
            'success': False, 'error_type': 'sk-TEST-NOT-A-CLASS', 'error': 'bad response'})
        self.assertEqual(state, 'unknown')
        self.assertIsNone(error['tool_error_type'])
