"""Per-request image model choice (image_selection.py) over the real ASGI router + disposable SQLite.

The listing fixture is REAL output of Hermes candidate 9a84eb772e (`--list-image-selections`, synthetic
home with image_gen.provider: nous, no sign-in, no network): image_selections_core_9a84eb772e.json.
The tool call itself is the counting fake from test_direct_run; no image is generated anywhere.
Opt-in wire check: RETAKE_SELECTION_SRC=<hermes-image-selection checkout> runs the real listing."""
import asyncio
import copy
import json
import os
import unittest
from pathlib import Path
from unittest.mock import patch
import test_direct_run as direct

CORE = json.loads((Path(__file__).with_name('image_selections_core_9a84eb772e.json')).read_text())
NANO = 'nous:fal-ai/nano-banana-pro'       # edit-capable, available unknown (null)
IDEO = 'nous:fal-ai/ideogram/v3'           # edit-capable in the listing, but never a revision (REVISION_UNSUPPORTED_MODELS)
KREA_STYLE = 'nous:krea-2-medium'          # style reference only: never a revision
TEXT_ONLY = 'nous:fal-ai/z-image/turbo'    # no image input
CODEX = 'openai-codex:gpt-image-2-high'    # not signed in -> available false


class ImageSelection(unittest.TestCase):
    # Borrow the direct-run harness without inheriting (and re-running) its tests.
    tearDown, run_async = direct.DirectRun.tearDown, direct.DirectRun.run_async

    def doCleanups(self):
        for p in getattr(self, 'patches', []): p.stop()
        return super().doCleanups()
    settle, reserve, revision_setup = direct.DirectRun.settle, direct.DirectRun.reserve, direct.DirectRun.revision_setup

    def setUp(self):
        direct.DirectRun.setUp(self)
        self.listed = copy.deepcopy(CORE)
        self.listings = 0
        test, sel = self, self.api.image_selection
        sel._cache.clear()

        def fake_list(home):
            test.listings += 1
            return None if test.listed is None else [c for c in (sel.clean(d) for d in test.listed['selections']) if c]
        self.result_extra = {}

        def fake_dispatch(home, args, selection=None):
            test.calls.append({'home': str(home), 'args': args, 'selection': selection})
            d = home / 'cache' / 'generated' / 'images'; d.mkdir(parents=True, exist_ok=True)
            path = d / f'fake-{len(test.calls)}.png'; path.write_bytes(test.out)
            prov, model = selection.split(':', 1) if selection else ('fixture-fake', 'fixture/fake')
            body = {'success': True, 'image': str(path), 'provider': 'fal' if prov == 'nous' else prov, 'model': model,
                    'modality': 'image' if 'image_url' in args else 'text'}
            if selection:
                body.update(requested_provider=prov, requested_model=model, route='nous-fal' if prov == 'nous' else 'chatgpt',
                            billing='subscription:nous', variant_enforced=True, selection_mismatch=False)
            body.update(test.result_extra); body = {k: v for k, v in body.items() if v is not None}  # None = field absent
            return json.dumps(body)
        p1 = patch.object(sel, '_run_listing', fake_list); p2 = patch.object(self.api.direct_runner, 'mcp_dispatch', fake_dispatch)
        p1.start(); p2.start(); self.patches += [p1, p2]

    def set_available(self, sid, value, reason=None):
        for d in self.listed['selections']:
            if d['id'] == sid: d['available'] = value; d['unavailable_reason'] = reason

    def test_listing_is_bounded_subscription_only_and_honest(self):
        async def flow(c):
            got = (await c.get('/image-selections')).json()
            self.assertTrue(got['supported']); self.assertEqual(got['cost'], 'Cost unknown')
            ids = {d['id'] for d in got['selections']}
            self.assertEqual({d['provider'] for d in got['selections']}, {'openai-codex', 'nous'})
            self.assertTrue({NANO, KREA_STYLE, TEXT_ONLY, CODEX} <= ids)
            self.assertTrue(all(d['entitlement'] == 'unknown' for d in got['selections']))
            by = {d['id']: d for d in got['selections']}
            self.assertEqual((by[KREA_STYLE]['image_input'], by[KREA_STYLE]['revision']), ('style', False))
            self.assertEqual((by[TEXT_ONLY]['image_input'], by[TEXT_ONLY]['revision']), (None, False))
            self.assertEqual((by[CODEX]['available'], by[CODEX]['variant_enforced']), (False, False))
            self.assertIsNone(by[NANO]['available'])
            self.assertEqual(self.calls, [], 'listing never generates')
        self.run_async(flow)

    def test_older_hermes_keeps_the_configured_flow_and_refuses_a_choice(self):
        self.listed = None
        async def flow(c):
            self.assertEqual((await c.get('/image-selections')).json()['supported'], False)
            pid = (await c.post('/projects', json={'name': 'Old'})).json()['id']
            r = await c.post(f'/projects/{pid}/generations', json={'client_request_id': f'{7:032x}', 'confirmed': True, 'aspect_ratio': 'landscape', 'prompt': 'x', 'image_selection': NANO})
            self.assertEqual(r.status_code, 422, r.text); self.assertIn('Nothing was reserved', r.text)
            a = await self.reserve(c, pid, 8)   # no choice: unchanged flow, no listing needed
            self.assertIsNone(a['image_selection'])
            await c.post(f'/projects/{pid}/generations/{a["id"]}/run'); done = await self.settle(c, pid, a['id'])
            self.assertEqual(done['state'], 'succeeded'); self.assertIsNone(self.calls[0]['selection'])
            self.assertNotIn('selection_mismatch', done)
        self.run_async(flow)

    def test_choice_is_snapshotted_idempotent_pinned_and_recorded(self):
        async def flow(c):
            pid = (await c.post('/projects', json={'name': 'Pick'})).json()['id']
            a = await self.reserve(c, pid, 10, image_selection=NANO)
            snap = a['image_selection']
            self.assertEqual((snap['id'], snap['route'], snap['billing'], snap['revision']), (NANO, 'nous-fal', 'subscription:nous', True))
            self.assertEqual(a['requested_model'], 'fal-ai/nano-banana-pro')
            self.assertEqual((await self.reserve(c, pid, 10, image_selection=NANO))['id'], a['id'], 'same request replays')
            r = await c.post(f'/projects/{pid}/generations', json={'client_request_id': f'{10:032x}', 'confirmed': True, 'aspect_ratio': 'landscape', 'prompt': 'An amber radio', 'image_selection': 'nous:fal-ai/flux-2-pro'})
            self.assertEqual(r.status_code, 409, 'same ID, different model: refused')
            await c.post(f'/projects/{pid}/generations/{a["id"]}/run'); done = await self.settle(c, pid, a['id'])
            self.assertEqual(done['state'], 'succeeded', done)
            self.assertEqual([x['selection'] for x in self.calls], [NANO], 'one call, pinned to the confirmed choice')
            self.assertEqual((done['selection_mismatch'], done['reported_route'], done['variant_verified']), (False, 'nous-fal', False))
        self.run_async(flow)

    def test_unavailable_or_unlisted_choice_is_never_reserved(self):
        async def flow(c):
            pid = (await c.post('/projects', json={'name': 'No'})).json()['id']
            for n, sid in ((11, CODEX), (12, 'nous:not-a-listed-model')):
                r = await c.post(f'/projects/{pid}/generations', json={'client_request_id': f'{n:032x}', 'confirmed': True, 'aspect_ratio': 'landscape', 'prompt': 'x', 'image_selection': sid})
                self.assertEqual(r.status_code, 409, r.text); self.assertIn('Nothing was reserved', r.text)
            for bad in ('', 'openai:gpt-image-1', 'fal:x', 5):
                r = await c.post(f'/projects/{pid}/generations', json={'client_request_id': f'{13:032x}', 'confirmed': True, 'aspect_ratio': 'landscape', 'prompt': 'x', 'image_selection': bad})
                self.assertEqual(r.status_code, 422, bad)
            self.assertEqual((await c.get(f'/projects/{pid}')).json()['attempts'], [])
        self.run_async(flow)

    def test_revision_only_with_an_edit_model(self):
        async def flow(c):
            pid, v1, brief, _ = await self.revision_setup(c)
            for n, sid in ((20, KREA_STYLE), (21, TEXT_ONLY)):
                r = await c.post(f'/projects/{pid}/generations', json={'client_request_id': f'{n:032x}', 'confirmed': True, 'aspect_ratio': 'landscape', 'parent_id': v1['id'], 'brief_id': brief['id'], 'image_selection': sid})
                self.assertEqual(r.status_code, 409, r.text); self.assertIn('cannot edit a reference image', r.text)
            a = await self.reserve(c, pid, 22, parent_id=v1['id'], brief_id=brief['id'], image_selection=NANO)
            await c.post(f'/projects/{pid}/generations/{a["id"]}/run'); done = await self.settle(c, pid, a['id'])
            self.assertEqual(done['state'], 'succeeded', done)
            self.assertIn('image_url', self.calls[0]['args']); self.assertEqual(self.calls[0]['selection'], NANO)
        self.run_async(flow)

    def test_revision_exclusion_list_is_exact_and_applied_by_the_listing(self):
        sel = self.api.image_selection
        self.assertEqual(sel.REVISION_UNSUPPORTED_MODELS, frozenset({'fal-ai/ideogram/v3'}))
        by = {d['id']: sel.clean(d) for d in CORE['selections']}
        self.assertEqual((by[IDEO]['revision'], by[IDEO]['image_input'], by[IDEO]['available']), (False, 'edit', None))
        self.assertIs(by[NANO]['revision'], True)
        # Only the listed model is dropped: every other edit-capable descriptor keeps its own revision flag.
        for d in CORE['selections']:
            caps = d['capabilities']
            qualifies = caps.get('revision') is True and caps.get('edit') is True and caps.get('image_input') == 'edit'
            self.assertIs(by[d['id']]['revision'], qualifies and d['model'] != 'fal-ai/ideogram/v3', d['id'])
        # An alias with the same model id under another listed provider is dropped too.
        alias = dict(CORE['selections'][0], id='openai-codex:fal-ai/ideogram/v3', provider='openai-codex', model='fal-ai/ideogram/v3', route='chatgpt', billing='subscription:chatgpt')
        self.assertIs(sel.clean(alias)['revision'], False)

    def test_ideogram_is_offered_for_new_assets_and_refused_for_revisions(self):
        async def flow(c):
            got = {d['id']: d for d in (await c.get('/image-selections')).json()['selections']}
            self.assertEqual((got[IDEO]['revision'], got[IDEO]['available']), (False, None))
            pid, v1, brief, _ = await self.revision_setup(c)
            r = await c.post(f'/projects/{pid}/generations', json={'client_request_id': f'{40:032x}', 'confirmed': True, 'aspect_ratio': 'landscape', 'parent_id': v1['id'], 'brief_id': brief['id'], 'image_selection': IDEO})
            self.assertEqual(r.status_code, 409, r.text); self.assertIn('cannot edit a reference image', r.text)
            self.assertEqual(self.calls, [], 'refused before anything is sent')
            a = await self.reserve(c, pid, 41, image_selection=IDEO)
            self.assertEqual(a['image_selection']['id'], IDEO)
            await c.post(f'/projects/{pid}/generations/{a["id"]}/run'); done = await self.settle(c, pid, a['id'])
            self.assertEqual(done['state'], 'succeeded', done)
            self.assertEqual([x['selection'] for x in self.calls], [IDEO])
        self.run_async(flow)

    def test_claim_time_recheck_fails_closed_with_nothing_sent(self):
        async def flow(c):
            pid = (await c.post('/projects', json={'name': 'Recheck'})).json()['id']
            a = await self.reserve(c, pid, 30, image_selection=NANO)
            self.set_available(NANO, False, 'This profile\'s image backend is not Nous Subscription.')
            r = (await c.post(f'/projects/{pid}/generations/{a["id"]}/run')).json()
            self.assertFalse(r['started']); self.assertEqual(r['attempt']['state'], 'failed')
            self.assertEqual(r['attempt']['error']['code'], 'selection_unavailable'); self.assertIn('Nothing was sent', r['attempt']['error']['message'])
            self.set_available(NANO, None); self.api.image_selection._cache.clear()
            b = await self.reserve(c, pid, 31, image_selection=NANO)
            for d in self.listed['selections']:
                if d['id'] == NANO: d['variant_enforced'] = False   # the confirmed terms changed
            r = (await c.post(f'/projects/{pid}/generations/{b["id"]}/run')).json()
            self.assertEqual((r['started'], r['attempt']['error']['code']), (False, 'selection_changed'))
            self.assertEqual(self.calls, [], 'nothing dispatched on either refusal')
            again = (await c.post(f'/projects/{pid}/generations/{b["id"]}/run')).json()
            self.assertFalse(again['started']); self.assertEqual(self.calls, [], 'never retried')
        self.run_async(flow)

    def test_hermes_refusal_with_nothing_sent_is_failed_not_unknown(self):
        self.result_extra = {'success': False, 'nothing_sent': True, 'error_type': 'selection_unavailable', 'error': 'Managed FAL gateway unresolved'}
        async def flow(c):
            pid = (await c.post('/projects', json={'name': 'Refused'})).json()['id']
            a = await self.reserve(c, pid, 40, image_selection=NANO)
            await c.post(f'/projects/{pid}/generations/{a["id"]}/run'); done = await self.settle(c, pid, a['id'])
            self.assertEqual((done['state'], done['error']['code'], done['error']['selection_error']), ('failed', 'selection_refused', 'selection_unavailable'))
            self.assertIsNone(done['version_id'])
        self.run_async(flow)

    def test_revision_mismatch_fails_closed_without_a_child_version(self):
        async def flow(c):
            pid, v1, brief, parent_bytes = await self.revision_setup(c)
            cases = [{'selection_mismatch': True},                                   # Hermes flags it
                     {'fallback_from': 'fal-ai/nano-banana-pro'},                     # a fallback ran
                     {'requested_model': 'fal-ai/flux-2-pro'},                        # echo: other model
                     {'requested_provider': 'openai-codex'},                          # echo: other provider
                     {'route': 'nous-krea'},                                          # echo: other route
                     {'requested_provider': None, 'requested_model': None, 'route': None, 'selection_mismatch': None}]  # no proof
            for n, extra in enumerate(cases, 60):
                self.result_extra = {k: v for k, v in extra.items()}
                a = await self.reserve(c, pid, n, parent_id=v1['id'], brief_id=brief['id'], image_selection=NANO)
                await c.post(f'/projects/{pid}/generations/{a["id"]}/run'); done = await self.settle(c, pid, a['id'])
                self.assertEqual((done['state'], done['error']['code'], done['version_id']), ('failed', 'selection_mismatch', None), extra)
                self.assertIn('may have reached the provider and been billed', done['error']['message'])
                self.assertNotIn('Nothing was sent', done['error']['message'])
                self.assertIs(done['selection_mismatch'], True, extra)
                self.assertEqual((done['image_selection']['id'], done['reported_provider']), (NANO, 'fal'), 'requested and reported evidence kept')
                again = (await c.post(f'/projects/{pid}/generations/{a["id"]}/run')).json()
                self.assertFalse(again['started'], 'never resubmitted')
            board = (await c.get(f'/projects/{pid}')).json()
            self.assertEqual([v['id'] for v in board['versions']], [v1['id']], 'no revision version was created')
            self.assertEqual(board['versions'][0]['sha256'], v1['sha256'], 'exact parent preserved')
            self.assertEqual(len(self.calls), len(cases), 'one call per attempt, none repeated')
        self.run_async(flow)

    def test_revision_with_chatgpt_quality_variation_is_stored(self):
        for d in self.listed['selections']:
            if d['id'] == 'openai-codex:gpt-image-2-high': d['available'] = True
        self.result_extra = {'reported_quality': 'medium', 'reported_size': '1024x1024', 'variant_enforced': False}
        async def flow(c):
            pid, v1, brief, _ = await self.revision_setup(c)
            a = await self.reserve(c, pid, 70, parent_id=v1['id'], brief_id=brief['id'], image_selection='openai-codex:gpt-image-2-high')
            await c.post(f'/projects/{pid}/generations/{a["id"]}/run'); done = await self.settle(c, pid, a['id'])
            self.assertEqual((done['state'], done['selection_mismatch']), ('succeeded', False), done)
            child = next(v for v in (await c.get(f'/projects/{pid}')).json()['versions'] if v['id'] == done['version_id'])
            self.assertEqual(child['parent_id'], v1['id'])
        self.run_async(flow)

    def test_mismatch_policy(self):
        async def flow(c):
            pid = (await c.post('/projects', json={'name': 'Mismatch'})).json()['id']
            cases = [({'fallback_from': 'fal-ai/nano-banana-pro', 'model': 'fal-ai/flux-2-pro'}, True),     # fallback reported
                     ({'selection_mismatch': True}, True),                                                    # Hermes says so
                     ({'requested_model': 'fal-ai/flux-2-pro'}, True),                                        # Retake's own echo check
                     ({'reported_quality': 'medium', 'reported_size': '1024x1024'}, False)]                   # variation is not a mismatch
            for n, (extra, expect) in enumerate(cases, 50):
                self.result_extra = extra
                a = await self.reserve(c, pid, n, image_selection=NANO)
                await c.post(f'/projects/{pid}/generations/{a["id"]}/run'); done = await self.settle(c, pid, a['id'])
                self.assertEqual(done['state'], 'succeeded', done)          # paid output is kept, never discarded
                self.assertIs(done['selection_mismatch'], expect, extra)
            self.assertEqual(len(self.calls), 4)
        self.run_async(flow)


class ListingFailsClosed(unittest.TestCase):
    def test_unlocatable_or_silent_hermes_reads_as_unsupported(self):
        import importlib.util, subprocess
        spec = importlib.util.spec_from_file_location('h', Path(__file__).with_name('test_backend.py'))
        harness = importlib.util.module_from_spec(spec); spec.loader.exec_module(harness)
        t = harness.RetakeTest(); t.setUp()
        try:
            sel = t.api.image_selection
            with patch.object(sel.direct_runner, 'server_env', side_effect=AttributeError('no __file__')):
                self.assertIsNone(sel._run_listing(t.scope))
            done = subprocess.CompletedProcess([], 0, stdout=b'', stderr=b'')  # older Hermes: ignores the flag, prints nothing
            with patch.object(sel.direct_runner, 'server_env', return_value=({}, '.')), patch.object(sel.subprocess, 'run', return_value=done):
                self.assertIsNone(sel._run_listing(t.scope))
        finally:
            t.tearDown()


@unittest.skipUnless(os.environ.get('RETAKE_SELECTION_SRC'), 'opt-in: RETAKE_SELECTION_SRC=<hermes-image-selection checkout>')
class RealCoreListing(unittest.TestCase):
    def test_real_listing_wire(self):
        import tempfile, importlib.util
        spec = importlib.util.spec_from_file_location('h', Path(__file__).with_name('test_backend.py'))
        harness = importlib.util.module_from_spec(spec); spec.loader.exec_module(harness)
        t = harness.RetakeTest(); t.setUp()
        try:
            sel = t.api.image_selection
            with tempfile.TemporaryDirectory() as home, patch.object(t.api.direct_runner, 'hermes_source', lambda: os.environ['RETAKE_SELECTION_SRC']):
                Path(home, 'config.yaml').write_text('image_gen:\n  provider: nous\n')
                got = sel.listing(Path(home), fresh=True)
            self.assertTrue(got['supported']); self.assertGreater(len(got['selections']), 10)
            self.assertTrue(all(d['provider'] in ('openai-codex', 'nous') for d in got['selections']))
        finally:
            t.tearDown()


if __name__ == '__main__':
    unittest.main()
