#!/usr/bin/env python3
"""Tests for the YouTube video plumbing (content/videos.json) in build/gen.py.

Uses a temp copy of content/. Run: python3 build/test_videos.py
"""
import json, os, re, shutil, sys, tempfile, unittest, warnings
from pathlib import Path

warnings.filterwarnings('ignore', category=ResourceWarning)
ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'build'))
import gen


def ld_blocks(doc):
    return [json.loads(raw) for raw in re.findall(r'<script type="application/ld\+json">(.*?)</script>', doc)]


class VideoTests(unittest.TestCase):
    def setUp(self):
        self._ctx = os.environ.pop('CONTEXT', None)
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        shutil.copytree(ROOT / 'content', self.root / 'content')
        self._saved = (gen.ROOT, gen.C, gen.OUT, gen.QF)
        gen.ROOT, gen.C, gen.OUT = str(self.root), str(self.root / 'content'), str(self.root / 'dist')
        gen.QF = str(self.root / 'content' / 'forms' / 'qualifier.json')

    def tearDown(self):
        gen.ROOT, gen.C, gen.OUT, gen.QF = self._saved
        os.environ.pop('CONTEXT', None)
        if self._ctx is not None: os.environ['CONTEXT'] = self._ctx
        self.tmp.cleanup()

    def vj(self):
        p = self.root / 'content' / 'videos.json'
        return json.loads(p.read_text(encoding='utf-8')), p

    def check(self):
        site, pages, markets, redirects, errs = gen.load_all()
        return gen.check(site, pages, markets, redirects, errs)

    def build(self, live=True):
        site, pages, markets, redirects, errs = gen.load_all()
        E, _ = gen.check(site, pages, markets, redirects, errs)
        self.assertEqual(E, [], E)
        gen.build(site, pages, markets, redirects, live)

    def page(self, rel):
        return (Path(gen.OUT) / rel).read_text(encoding='utf-8')

    def test_no_youtube_request_before_tap(self):
        self.build()
        for f in Path(gen.OUT).rglob('*.html'):
            doc = f.read_text(encoding='utf-8')
            html_only = re.sub(r'<script[^>]*>.*?</script>', '', doc, flags=re.S)
            self.assertNotRegex(html_only, r'<iframe[^>]+youtube', f)
            self.assertNotIn('i.ytimg.com', html_only, f)  # thumbnails are self-hosted
            self.assertNotRegex(html_only, r'<(?:link|img|script)[^>]+youtube', f)

    def test_schema_only_on_main_page(self):
        self.build()
        V = self.vj()[0]['videos']
        seen = {}
        for f in Path(gen.OUT).rglob('index.html'):
            for b in ld_blocks(f.read_text(encoding='utf-8')):
                if b.get('@type') == 'VideoObject':
                    vid = b['embedUrl'].rsplit('/', 1)[1]
                    seen.setdefault(vid, []).append('/' + str(f.parent.relative_to(gen.OUT)).replace('.', '') + '/')
        for k, v in V.items():
            if not gen.yt_on(v): continue
            self.assertEqual([p.replace('//', '/') for p in seen.get(v['id'], [])], [v['schema_page']], k)
        cash = next(b for b in ld_blocks(self.page('sell-your-house-for-cash/index.html')) if b.get('@type') == 'VideoObject')
        for f in ('name', 'description', 'thumbnailUrl', 'uploadDate', 'duration', 'embedUrl', 'contentUrl'):
            self.assertTrue(cash.get(f), f)
        self.assertEqual(cash['duration'], 'PT4M8S')
        self.assertTrue(all(c['@type'] == 'Clip' and c['endOffset'] > c['startOffset'] for c in cash['hasPart']))

    def test_videos_sit_below_the_form(self):
        self.build()
        for rel in ('index.html', 'sell-your-house-for-cash/index.html', 'selling-an-inherited-house/index.html', 'sell-your-house-fast-in-indiana/index.html'):
            doc = self.page(rel)
            self.assertLess(doc.index('id="offer"'), doc.index('data-ytkey='), rel)
            hero_end = doc.index('</section>', doc.index('id="offer"'))
            self.assertLess(hero_end, doc.index('data-ytkey='), rel)

    def test_unconfirmed_slots_render_nothing(self):
        self.build()
        for rel in ('sell-your-house-as-is/index.html', 'stop-foreclosure/index.html', 'sell-your-house-fast/index.html', 'selling-a-house-in-pre-foreclosure/index.html'):
            self.assertNotIn('data-ytkey=', self.page(rel), rel)

    def test_transcript_placeholder_only_on_previews(self):
        self.build(live=True)
        self.assertNotIn('PLACEHOLDER: Andrew', self.page('sell-your-house-for-cash/index.html'))
        os.environ['CONTEXT'] = 'deploy-preview'
        self.build(live=False)
        self.assertIn('PLACEHOLDER: Andrew', self.page('sell-your-house-for-cash/index.html'))

    def test_video_sitemap_and_robots(self):
        self.build()
        sm = self.page('video-sitemap.xml')
        self.assertIn('xmlns:video="http://www.google.com/schemas/sitemap-video/1.1"', sm)
        self.assertIn('<loc>https://fsho.co/sell-your-house-for-cash/</loc>', sm)
        self.assertEqual(sm.count('rc5rfDZgO2A</video:player_loc>'), 1)
        self.assertIn('Sitemap: https://fsho.co/video-sitemap.xml', self.page('robots.txt'))

    def test_banned_claims_and_max_two(self):
        data, p = self.vj()
        data['videos']['cash-offers']['summary'] += ' We will beat any cash offer by $2,000 and close in 7-14 days.'
        data['pages']['home']['videos'] = ['cash-offers', 'inherited-options', 'winamac']
        p.write_text(json.dumps(data), encoding='utf-8')
        E, _ = self.check()
        self.assertTrue(any('claim fsho.co does not use' in e for e in E), E)
        self.assertTrue(any('more than 2 videos' in e for e in E), E)


if __name__ == '__main__':
    unittest.main(verbosity=1)
