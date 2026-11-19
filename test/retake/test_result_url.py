"""A provider result that is a bare HTTPS URL (FAL, incl. managed Nous) is downloaded ONCE through
Hermes's SSRF-guarded `save_url_image` in a child bound to the requesting profile, then imported by
the unchanged cache-path rules. Offline: the fetch is a fake that writes fixture bytes, except the
real-helper check, which only proves stock refuses a loopback URL before connecting."""
import io
import json
import os
from pathlib import Path
import sqlite3
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch
from PIL import Image
import test_direct_run as direct
import test_image_selection as selection

URL = 'https://example.invalid/fal/result.png'
STOCK = Path(os.environ.get('RETAKE_STOCK_SRC') or '/nonexistent')  # stock Hermes source checkout, opt-in


def png(color, size=(18, 14)):
    out = io.BytesIO(); Image.new('RGB', size, color).save(out, 'PNG'); return out.getvalue()


class ResultUrl(unittest.TestCase):
    tearDown, run_async = selection.ImageSelection.tearDown, selection.ImageSelection.run_async
    settle, reserve, revision_setup = direct.DirectRun.settle, direct.DirectRun.reserve, direct.DirectRun.revision_setup

    def setUp(self):
        selection.ImageSelection.setUp(self)
        self.result_extra = {'image': URL}
        self.fetched = png('navy')
        self.fetches = []
        self.bridge = self.api.direct_runner.stock_bridge
        self.fetch_result = lambda home: self.write(home, 'fetched.png', self.fetched)
        p = patch.object(self.bridge, 'FETCH', self.fake_fetch); p.start(); self.patches.append(p)

    def doCleanups(self):
        for p in getattr(self, 'patches', []): p.stop()
        return super().doCleanups()

    def fake_fetch(self, home, url):
        self.fetches.append((str(home), url))
        return self.fetch_result(home)

    def write(self, home, name, data):
        d = Path(home) / 'cache' / 'generated' / 'images'; d.mkdir(parents=True, exist_ok=True)
        (d / name).write_bytes(data); return str(d / name)

    async def run_one(self, c, n, pid=None, **kw):
        pid = pid or (await c.post('/projects', json={'name': f'Url {n}'})).json()['id']
        a = await self.reserve(c, pid, n, **kw)
        await c.post(f'/projects/{pid}/generations/{a["id"]}/run')
        return pid, await self.settle(c, pid, a['id'])

    def stored_json(self):
        with sqlite3.connect(self.scope / 'plugin-data' / 'retake' / 'retake.sqlite3') as con:
            return json.dumps([r[0] for r in con.execute('SELECT data FROM generation_attempts')] +
                              [r[0] for r in con.execute('SELECT data FROM versions')])

    def assert_refused(self, done, reason):
        self.assertEqual((done['state'], done['error']['code'], done['error'].get('reason')), ('failed', 'invalid_output', reason), done)

    def test_url_gate(self):
        gate = self.api.store.result_url
        self.assertEqual(gate('https://example.invalid/a.png'), 'https://example.invalid/a.png')
        for bad in ['http://example.invalid/a.png', 'data:image/png;base64,AAAA', 'file:///etc/passwd', 'ftp://example.invalid/a.png',
                    'https://u:p@example.invalid/x', 'https://u@example.invalid/x', 'https:///nohost.png', 'https:example.invalid/a.png',
                    'HTTPS://example.invalid/a.png', 'https://example.invalid/a b.png', 'https://example.invalid/a\n.png',
                    'https://example.invalid/a\x00.png', 'https://example.invalid/a\x7f.png', ' https://example.invalid/a.png',
                    'https://example.invalid/' + 'a' * 4096, '', None, 42, b'https://example.invalid/a.png']:
            self.assertIsNone(gate(bad), repr(bad)[:80])

    def test_https_result_is_fetched_once_and_stored_without_the_url(self):
        async def flow(c):
            pid, done = await self.run_one(c, 50)
            self.assertEqual(done['state'], 'succeeded', done)
            self.assertEqual(self.fetches, [(str(self.scope), URL)])
            self.assertEqual(len(self.calls), 1)
            board = (await c.get(f'/projects/{pid}')).json()
            self.assertEqual(len(board['versions']), 1)
            v = board['versions'][0]
            self.assertEqual((v['id'], v['parent_id'], v['origin'], v['generation_attempt_id']), (done['version_id'], None, 'generated', done['id']))
            import hashlib
            self.assertEqual(v['sha256'], hashlib.sha256(self.fetched).hexdigest(), 'the downloaded bytes, not the tool-side file')
            for text in (self.stored_json(), json.dumps(board), json.dumps(done)):
                self.assertNotIn('example.invalid', text)
        self.run_async(flow)

    def test_fetch_failure_is_billed_wording_and_never_redispatched(self):
        def boom(home): raise RuntimeError(f'download failed for {URL}')
        self.fetch_result = boom
        async def flow(c):
            pid, done = await self.run_one(c, 51)
            self.assertEqual((done['state'], done['error']['code']), ('failed', 'output_fetch_failed'))
            self.assertIn('may have been billed', done['error']['message'])
            self.assertNotIn('Nothing was sent', done['error']['message'])
            again = (await c.post(f'/projects/{pid}/generations/{done["id"]}/run')).json()
            self.assertFalse(again['started'])
            self.assertEqual((len(self.calls), len(self.fetches)), (1, 1))
            self.assertEqual((await c.get(f'/projects/{pid}')).json()['versions'], [])
            self.assertNotIn('example.invalid', self.stored_json())
        self.run_async(flow)

    def test_fetched_file_still_passes_every_import_rule(self):
        outside = Path(self.home) / 'outside.png'; outside.write_bytes(self.fetched)
        gif = io.BytesIO(); Image.new('RGB', (8, 8), 'red').save(gif, 'GIF')
        cases = [(52, lambda home: str(outside), 'path'),
                 (53, lambda home: self.write(home, 'big.png', b'\0' * (12 * 1024 * 1024 + 1)), 'size'),
                 (54, lambda home: self.write(home, 'anim.gif', gif.getvalue()), 'format'),
                 (55, lambda home: URL, 'url')]
        async def flow(c):
            for n, fetch, reason in cases:
                self.fetch_result = fetch
                _, done = await self.run_one(c, n)
                self.assert_refused(done, reason)
            self.assertEqual(len(self.fetches), len(cases))
        self.run_async(flow)

    def test_non_https_or_unqualified_results_are_refused_without_fetching(self):
        async def flow(c):
            n = 60
            for extra in ({'image': 'http://example.invalid/a.png'}, {'image': 'data:image/gif;base64,AAAA'},
                          {'image': 'data:text/html;base64,AAAA'}, {'image': 'file:///etc/passwd'}, {'image': 'https://u:p@example.invalid/a.png'},
                          {'image': URL, 'modality': None}, {'image': URL, 'modality': 'video'}):
                self.result_extra = extra
                _, done = await self.run_one(c, n); n += 1
                self.assert_refused(done, 'url')
            self.assertEqual(self.fetches, [])
        self.run_async(flow)

    def test_text_modality_revision_is_not_fetched(self):
        self.result_extra = {'image': URL, 'modality': 'text'}
        async def flow(c):
            pid, v1, brief, _ = await self.revision_setup(c)
            _, done = await self.run_one(c, 70, pid=pid, parent_id=v1['id'], brief_id=brief['id'])
            self.assertEqual(done['state'], 'failed')
            self.assertEqual(self.fetches, [])
            self.assertEqual(len((await c.get(f'/projects/{pid}')).json()['versions']), 1)
        self.run_async(flow)

    def test_revision_from_url_keeps_lineage_and_selection_mismatch_fails_closed(self):
        async def flow(c):
            pid, v1, brief, _ = await self.revision_setup(c)
            _, ok = await self.run_one(c, 71, pid=pid, parent_id=v1['id'], brief_id=brief['id'], image_selection=selection.NANO)
            self.assertEqual(ok['state'], 'succeeded', ok)
            child = next(v for v in (await c.get(f'/projects/{pid}')).json()['versions'] if v['id'] == ok['version_id'])
            self.assertEqual((child['parent_id'], child['asset_id']), (v1['id'], v1['asset_id']))
            self.result_extra = {'image': URL, 'selection_mismatch': True}
            _, bad = await self.run_one(c, 72, pid=pid, parent_id=v1['id'], brief_id=brief['id'], image_selection=selection.NANO)
            self.assertEqual((bad['state'], bad['error']['code']), ('failed', 'selection_mismatch'))
            self.assertEqual(len(self.fetches), 2, 'fetched, then refused by the unchanged revision rules')
            self.assertEqual(len((await c.get(f'/projects/{pid}')).json()['versions']), 2)
        self.run_async(flow)

    def test_hermes_without_the_helper_keeps_the_url_refusal(self):
        async def flow(c):
            with patch.object(self.bridge, 'FETCH', None), patch.object(self.api.direct_runner, 'can_fetch_result_urls', lambda: False):
                _, done = await self.run_one(c, 80)
            self.assert_refused(done, 'url')
            self.assertEqual(self.fetches, [])
        self.run_async(flow)


class InlineResult(unittest.TestCase):
    """FAL sync_mode models (e.g. FLUX 2 Pro) succeed with the image inline as a base64 data URI, which
    Hermes cannot cache. Retake decodes it in memory under the same raster checks; never a fetch."""
    tearDown, run_async, settle, reserve, revision_setup = ResultUrl.tearDown, ResultUrl.run_async, ResultUrl.settle, ResultUrl.reserve, ResultUrl.revision_setup
    setUp, fake_fetch, write, run_one = ResultUrl.setUp, ResultUrl.fake_fetch, ResultUrl.write, ResultUrl.run_one

    def doCleanups(self):
        for p in getattr(self, 'patches', []): p.stop()
        return super().doCleanups()
    stored_json, assert_refused = ResultUrl.stored_json, ResultUrl.assert_refused

    def inline(self, data, mime='image/png'):
        import base64
        return f'data:{mime};base64,' + base64.b64encode(data).decode()

    def test_inline_image_is_imported_for_a_new_asset_and_never_stored_as_text(self):
        self.result_extra = {'image': self.inline(self.fetched)}
        async def flow(c):
            import hashlib
            pid, done = await self.run_one(c, 90)
            self.assertEqual(done['state'], 'succeeded', done)
            self.assertEqual(self.fetches, [])
            v = (await c.get(f'/projects/{pid}')).json()['versions'][0]
            self.assertEqual(v['sha256'], hashlib.sha256(self.fetched).hexdigest())
            for text in (self.stored_json(), json.dumps(done)):
                self.assertNotIn('base64', text)
        self.run_async(flow)

    def test_inline_revision_keeps_lineage_and_text_modality_revision_is_refused(self):
        self.result_extra = {'image': self.inline(self.fetched), 'modality': 'image'}
        async def flow(c):
            pid, v1, brief, _ = await self.revision_setup(c)
            _, ok = await self.run_one(c, 91, pid=pid, parent_id=v1['id'], brief_id=brief['id'])
            self.assertEqual(ok['state'], 'succeeded', ok)
            child = next(v for v in (await c.get(f'/projects/{pid}')).json()['versions'] if v['id'] == ok['version_id'])
            self.assertEqual(child['parent_id'], v1['id'])
            self.result_extra = {'image': self.inline(self.fetched), 'modality': 'text'}
            _, bad = await self.run_one(c, 92, pid=pid, parent_id=v1['id'], brief_id=brief['id'])
            self.assert_refused(bad, 'url')
        self.run_async(flow)

    def test_inline_image_passes_every_import_rule(self):
        gif = io.BytesIO(); Image.new('RGB', (8, 8), 'red').save(gif, 'GIF')
        cases = [(93, self.inline(b'not an image'), 'format'),
                 (94, self.inline(self.fetched, 'image/jpeg'), 'format'),  # declared type must match the bytes
                 (95, self.inline(gif.getvalue()).replace('image/png', 'image/gif'), 'url'),
                 (96, 'data:image/png;base64,not*base64', 'format'),
                 (97, self.inline(self.fetched), 'size')]
        async def flow(c):
            for n, image, reason in cases:
                self.result_extra = {'image': image}
                if n == 97:
                    with patch.object(self.api.store, 'MAX_INLINE_CHARS', 64):
                        _, done = await self.run_one(c, n)
                else:
                    _, done = await self.run_one(c, n)
                self.assert_refused(done, reason)
            self.assertEqual(self.fetches, [])
        self.run_async(flow)

    def test_unqualified_inline_result_is_refused_with_a_reason_not_missing(self):
        long_uri = self.inline(self.fetched) + 'A' * 5000
        self.result_extra = {'image': long_uri, 'success': None}
        async def flow(c):
            _, done = await self.run_one(c, 98)
            self.assertNotEqual(done['error'].get('reason'), 'missing')
        self.run_async(flow)


class FetchChild(unittest.TestCase):
    """The child process protocol, with a stub Hermes source (no stock code, no network)."""
    def setUp(self):
        self.dir = tempfile.TemporaryDirectory(); base = Path(self.dir.name)
        self.home, self.src = base / 'home', base / 'src'
        self.home.mkdir(); (self.src / 'agent').mkdir(parents=True)
        (self.src / 'hermes_constants.py').write_text('import os, pathlib\ndef get_hermes_home():\n    return pathlib.Path(os.environ["HERMES_HOME"])\n')
        (self.src / 'agent' / '__init__.py').write_text('')
        (self.src / 'agent' / 'image_gen_provider.py').write_text(
            'import sys\nfrom hermes_constants import get_hermes_home\n'
            'def save_url_image(url, *, prefix, timeout, max_bytes):\n'
            '    assert (prefix, timeout, max_bytes) == ("retake", 60, 12 * 1024 * 1024)\n'
            '    if not url.startswith("https://ok.invalid/"): raise ValueError("refused")\n'
            '    d = get_hermes_home() / "cache" / "generated" / "images"; d.mkdir(parents=True, exist_ok=True)\n'
            '    p = d / "retake_1.png"; p.write_bytes(b"x"); print("noise from the helper"); return p\n')
        import test_backend as harness
        harness.RetakeTest.setUp(self)  # loads the package under test the usual way
        self.runner = self.api.direct_runner
        self.p = patch.object(self.runner, 'hermes_source', lambda: str(self.src)); self.p.start()

    def tearDown(self):
        self.p.stop(); self.mock.stop(); self.tmp.cleanup(); self.dir.cleanup()

    def test_child_returns_the_helper_path(self):
        got = self.runner.fetch_result_url(self.home, 'https://ok.invalid/a.png')
        self.assertEqual(got, str(self.home / 'cache' / 'generated' / 'images' / 'retake_1.png'))

    def test_helper_refusal_is_fetch_failed(self):
        with self.assertRaises(self.runner.FetchFailed) as e:
            self.runner.fetch_result_url(self.home, 'https://bad.invalid/a.png')
        self.assertEqual(str(e.exception), 'child exit 1')

    def test_home_mismatch_exits_before_the_helper(self):
        other = Path(self.dir.name) / 'other'; other.mkdir()
        real_env = self.runner.server_env
        def wrong_home(home):
            env, src = real_env(home); env['HERMES_HOME'] = str(other); return env, src
        with patch.object(self.runner, 'server_env', wrong_home), self.assertRaises(self.runner.FetchFailed) as e:
            self.runner.fetch_result_url(self.home, 'https://ok.invalid/a.png')
        self.assertEqual(str(e.exception), 'child exit 3')
        self.assertFalse((other / 'cache').exists() or (self.home / 'cache').exists(), 'helper never ran')

    def test_missing_helper_is_fetch_failed(self):
        # An import that fails (not a deleted file: an editable Hermes install in the venv could supply one).
        (self.src / 'agent' / 'image_gen_provider.py').write_text('raise ImportError("no helper in this Hermes")\n')
        with self.assertRaises(self.runner.FetchFailed) as e:
            self.runner.fetch_result_url(self.home, 'https://ok.invalid/a.png')
        self.assertEqual(str(e.exception), 'child exit 4')


def stock_usable():
    if not (STOCK / 'agent' / 'image_gen_provider.py').is_file(): return False
    with tempfile.TemporaryDirectory() as home:
        env = {**os.environ, 'HERMES_HOME': home, 'HERMES_QUIET': '1', 'PYTHONPATH': str(STOCK)}
        try:
            r = subprocess.run([sys.executable, '-c', 'from agent.image_gen_provider import save_url_image; import tools.url_safety'],
                               env=env, cwd=STOCK, stdin=subprocess.DEVNULL, capture_output=True, timeout=60)
        except Exception:
            return False
        return r.returncode == 0


@unittest.skipUnless(stock_usable(), 'stock Hermes source or its imports are not usable here')
class RealHelper(unittest.TestCase):
    def setUp(self):
        import test_backend as harness
        harness.RetakeTest.setUp(self)
        self.runner = self.api.direct_runner
        self.p = patch.object(self.runner, 'hermes_source', lambda: str(STOCK)); self.p.start()
        self.dir = tempfile.TemporaryDirectory(); self.profile = Path(self.dir.name)

    def tearDown(self):
        self.p.stop(); self.mock.stop(); self.tmp.cleanup(); self.dir.cleanup()

    def test_stock_helper_refuses_loopback_before_connecting(self):
        self.assertTrue(self.runner.can_fetch_result_urls() in (True, False))  # probe never raises
        with self.assertRaises(self.runner.FetchFailed) as e:
            self.runner.fetch_result_url(self.profile, 'https://127.0.0.1/x.png')
        self.assertEqual(str(e.exception), 'child exit 1', 'the helper itself refused (not a home or import failure)')
        images = self.profile / 'cache' / 'generated' / 'images'
        self.assertEqual(list(images.iterdir()) if images.exists() else [], [], 'nothing written')


if __name__ == '__main__':
    unittest.main(verbosity=2)
