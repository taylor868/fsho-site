#!/usr/bin/env python3
"""Regression tests for Carrot parity in build/gen.py.

Uses a temp copy of content/. Does not deploy, merge, or write the repo dist/.
Run: python3 build/test_parity.py
"""
import html as html_mod
import json, os, re, shutil, subprocess, sys, tempfile, unittest, warnings
from pathlib import Path

warnings.filterwarnings('ignore', category=ResourceWarning)

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'build'))
import gen

DRAFT_PAGE = '''---
title: "Draft page title"
meta_description: "Hidden on live builds."
template: basic
draft: true
---
<section class="wrap pad"><h1>Draft page body</h1></section>
'''

SPECIAL = '''---
title: "Tom & \\"Jerry\\" <b>"
meta_description: "Say \\"hi\\" & bye"
template: basic
og_title: "OG & \\"title\\" <x>"
og_image: "/logo.webp"
canonical: "https://example.com/a?x=1&y=2"
cta_label: "CTA & \\"go\\""
faq:
  - q: "Own question?"
    a: "Own &amp; answer </script><script>alert(1)"
---
<section class="wrap pad">{{faq}}</section>

{{cta}}

{{cta:Explicit & "heading"}}
'''

# Public ad landing pages. Not in the header nav. Indexable, with the homepage form.
AD_LANDINGS = (
    {
        'slug': 'sell-your-house-as-is',
        'h1': 'Selling a house as is',
        'title': 'Sell Your House As-Is | Fair & Simple Home Offer',
        'meta': 'Sell your house as-is, in its current condition. No repairs or cleaning to ask for a no-obligation offer. Call (910) 636-6669.',
        'only': 'What as-is does not promise',
    },
    {
        'slug': 'companies-that-buy-houses',
        'h1': 'Companies who buy houses',
        'title': 'Companies Who Buy Houses | Fair & Simple Home Offer',
        'meta': 'Comparing companies that buy houses? See what that sale means, what to look for, and how Fair and Simple works. Call (910) 636-6669.',
        'only': 'what to look for',
    },
    {
        'slug': 'sell-your-house-fast',
        'h1': 'Selling your house fast',
        'title': 'Sell Your House Fast | Fair & Simple Home Offer',
        'meta': 'Selling your house fast can be a simple process, on a date you choose. No obligation to accept an offer. Call (910) 636-6669.',
        'only': 'not a copy of the homepage',
    },
    {
        'slug': 'selling-a-house-in-pre-foreclosure',
        'h1': 'Selling a house in pre-foreclosure',
        'title': 'Selling in Pre-Foreclosure | Fair & Simple Home Offer',
        'meta': 'Behind on payments, with time to look at options? Read about selling a house in pre-foreclosure. We are not attorneys. Call (910) 636-6669.',
        'only': 'This is the earlier stage',
    },
    {
        'slug': 'selling-a-house-in-divorce',
        'h1': 'Selling a house in a divorce',
        'title': 'Selling a House in Divorce | Fair & Simple Home Offer',
        'meta': 'Selling a house in a divorce can be one way to move on. We do not take sides, and we are not attorneys. Call (910) 636-6669.',
        'only': 'We do not split proceeds',
    },
    {
        'slug': 'selling-an-inherited-house',
        'h1': 'Selling an inherited house',
        'title': 'Selling an Inherited House | Fair & Simple Home Offer',
        'meta': 'Inherited a house you do not want to keep? Ask about an as-is offer without a cleanup first. Call (910) 636-6669.',
        'only': 'A house you received, not a project you planned',
    },
    {
        'slug': 'selling-a-house-in-probate',
        'h1': 'Selling a house in probate',
        'title': 'Selling a House in Probate | Fair & Simple Home Offer',
        'meta': 'Probate is the court process. We can talk about the house, and we do not give legal advice. Call (910) 636-6669.',
        'only': 'Probate is the court process',
    },
    {
        'slug': 'selling-a-house-with-tenants',
        'h1': 'Selling a house with tenants',
        'title': 'Selling a House With Tenants | Fair & Simple Home Offer',
        'meta': 'Selling a house with tenants still living there. We do not promise they will leave. Call (910) 636-6669.',
        'only': 'We do not evict tenants',
    },
)


def ld_blocks(doc):
    return [json.loads(raw) for raw in re.findall(r'<script type="application/ld\+json">(.*?)</script>', doc)]


def faq_pairs(doc):
    return re.findall(r'<summary>(.*?)</summary><p>(.*?)</p>', doc)


class ParityTests(unittest.TestCase):
    def setUp(self):
        self._ctx = os.environ.pop('CONTEXT', None)
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        shutil.copytree(ROOT / 'content', self.root / 'content')
        self._saved = (gen.ROOT, gen.C, gen.OUT, gen.QF)
        gen.ROOT = str(self.root)
        gen.C = str(self.root / 'content')
        gen.OUT = str(self.root / 'dist')
        gen.QF = str(self.root / 'content' / 'forms' / 'qualifier.json')

    def tearDown(self):
        gen.ROOT, gen.C, gen.OUT, gen.QF = self._saved
        if self._ctx is None:
            os.environ.pop('CONTEXT', None)
        else:
            os.environ['CONTEXT'] = self._ctx
        self.tmp.cleanup()

    def assert_unused_test_page(self, page):
        self.assertIn("<title>This page isn't in use | Fair and Simple Home Offer</title>", page)
        self.assertIn("<h1>This page isn't in use.</h1>", page)
        self.assertIn(
            "This page isn't used anymore. Call or text "
            '<a href="tel:+19106366669">(910) 636-6669</a>, or '
            '<a href="/#offer">start the form on the homepage</a>.',
            page,
        )
        self.assertIn('<p class="fine">If you want an offer, use the homepage form or call us.</p>', page)
        self.assertNotIn('not available on the live site', page)
        self.assertNotIn('Two-stage test intake', page)
        self.assertNotIn('The live site does not turn the test form on.', page)

    def assert_ownership_label(self, page):
        self.assertIn('["decision_maker", "I\'m an heir, executor, or have power of attorney"]', page)
        self.assertNotIn("I'm an heir, executor, or POA", page)

    def write(self, rel, text):
        path = self.root / rel
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text, encoding='utf-8')

    def site(self):
        path = self.root / 'content' / 'site.json'
        return json.loads(path.read_text(encoding='utf-8')), path

    def save_site(self, data, path):
        path.write_text(json.dumps(data, indent=2) + '\n', encoding='utf-8')

    def load(self):
        return gen.load_all()

    def check(self):
        site, pages, markets, redirects, errs = self.load()
        return gen.check(site, pages, markets, redirects, errs)

    def build(self, live=False):
        site, pages, markets, redirects, errs = self.load()
        errors, warns = gen.check(site, pages, markets, redirects, errs)
        self.assertEqual(errors, [], errors)
        return gen.build(site, pages, markets, redirects, live), warns

    def add_drafts(self):
        self.write('content/pages/draft-page.md', DRAFT_PAGE)
        self.write('content/markets/zz-draft.json', json.dumps({
            'state': 'Draftland', 'slug': 'zz-draft-market', 'title': 'Draft market title',
            'meta_description': 'draft market', 'headline': 'Draft headline', 'hero_sub': 'Draft sub',
            'draft': True,
        }))

    def guards(self):
        home = (Path(gen.OUT) / 'index.html').read_text(encoding='utf-8')
        return {
            'home': home,
            'banner': 'PREVIEW: not the live site. Form data is only logged, never sent.' in home,
            'noindex': '<meta name="robots" content="noindex,nofollow">' in home,
            'endpoint': 'var FSHO={endpoint:""' in home,
            'alert': 'forms are off' in home,
        'robots': (Path(gen.OUT) / 'robots.txt').read_text(encoding='utf-8'),
        'headers': (Path(gen.OUT) / '_headers').read_text(encoding='utf-8') if (Path(gen.OUT) / '_headers').is_file() else '',
    }

    def test_repo_check_is_public_without_the_live_flag(self):
        env = os.environ.copy()
        env.pop('CONTEXT', None)
        env.pop('FSHO_USE_REAL_ADAPTER', None)
        proc = subprocess.run([sys.executable, 'build/gen.py', '--check'], cwd=ROOT, env=env, capture_output=True, text=True)
        self.assertEqual(proc.returncode, 0, proc.stdout + proc.stderr)
        self.assertIn('OK: 23 pages, 39 markets, 16 redirects', proc.stdout)
        for name in ('california', 'connecticut', 'massachusetts', 'mississippi', 'north-carolina', 'pennsylvania', 'rhode-island', 'washington'):
            self.assertIn(f'content/markets/{name}.json: title is ', proc.stdout)
        self.assertNotIn('ERROR', proc.stdout)
        site = json.loads((ROOT / 'content' / 'site.json').read_text(encoding='utf-8'))
        self.assertFalse(site['preview'])
        self.assertFalse(site['lead_form']['enabled'])
        self.assertEqual(site['lead_form']['endpoint'], '')
        toml = (ROOT / 'netlify.toml').read_text(encoding='utf-8')
        self.assertNotIn('--live', toml)
        self.assertIn('python3 build/gen.py', toml)
        joined = '\n'.join([
            (ROOT / 'docs' / 'CARROT_PARITY.md').read_text(encoding='utf-8'),
            (ROOT / 'docs' / 'CONTENT_SCHEMA.md').read_text(encoding='utf-8'),
            (ROOT / 'README.md').read_text(encoding='utf-8'),
            site['lead_form']['_note'],
        ])
        self.assertIn('cursor/carrot-lead-routing-f5f7', joined)
        self.assertIn('verified CRM mapping', joined)
        self.assertIn('intake-producer', joined)
        self.assertNotIn('until the narrow create_lead token exists', joined)
        self.assertNotIn('Blocked on the narrow', joined)
        self.assertNotIn('blocked only on the narrow token', joined)
        self.build(live=False)
        home = (Path(gen.OUT) / 'index.html').read_text(encoding='utf-8')
        self.assertNotIn('PREVIEW:', home)
        self.assertNotIn('name="robots" content="noindex,nofollow"', home)
        self.assertIn('id="ts-form"', home)
        self.assertIn('data-public="1"', home)
        self.assertIn('is_test: options.isTest === true', home)
        self.assertIn('chooseAdapter({ isTest: testOn })', home)
        self.assertNotIn('{ is_test: true }', home)
        self.assertIn('window.FSHO_USE_REAL_ADAPTER=""', home)
        self.assertIn('/.netlify/functions/intake-producer', home)
        self.assertIn('GTM-WWPBQGDZ', home)
        self.assertIn('pointerdown', home)
        self.assertIsNone(re.search(r'<script[^>]+src="https://www\.googletagmanager\.com/gtm\.js', home))
        self.assertIn('tracking:false', home)
        self.assertIn('clickcease:""', home)
        self.assertIn('https://www.clickcease.com/monitor/stat.js', home)
        self.assertNotIn('<script src="https://www.clickcease.com', home)
        self.assertTrue(site['whatconverts']['enabled'])
        self.assertEqual(site['whatconverts']['profile_id'], '176490')
        self.assertEqual(site['whatconverts']['script_host'], '//s.ksrndkehqnwntyxlhgto.com')
        self.assertEqual(site['clickcease_id'], '')
        self.assertIn('<script src="//s.ksrndkehqnwntyxlhgto.com/176490.js" defer></script>', home)
        self.assertLess(home.index('var $wc_load=function'), home.index('176490.js'))
        self.assertIn('t.id==="ts-form"', home)
        self.assertIn('forms are off', home)
        robots = (Path(gen.OUT) / 'robots.txt').read_text(encoding='utf-8')
        self.assertEqual(site['domain'], 'https://fsho.co')
        self.assertIn('Disallow: /step-2/', robots)
        self.assertIn('Disallow: /thank-you/', robots)
        self.assertIn('Sitemap: https://fsho.co/sitemap.xml\n', robots)
        self.assertNotIn('fairandsimplehomeoffer.com', robots)
        self.assertNotIn('Disallow: /\n', robots)
        self.assertFalse((Path(gen.OUT) / '_headers').exists())
        sitemap = (Path(gen.OUT) / 'sitemap.xml').read_text(encoding='utf-8')
        locs = re.findall(r'<loc>([^<]+)</loc>', sitemap)
        self.assertTrue(locs)
        self.assertTrue(all(loc.startswith('https://fsho.co/') for loc in locs))
        self.assertNotIn('fairandsimplehomeoffer.com', sitemap)
        for path in ('/test-intake/', '/step-2/', '/thank-you/'):
            self.assertNotIn('https://fsho.co' + path, locs)
        test_page = (Path(gen.OUT) / 'test-intake' / 'index.html').read_text(encoding='utf-8')
        self.assertIn('noindex,nofollow', test_page)
        self.assertNotIn('data-public="1"', test_page)
        self.assertNotIn('/test-intake/', (Path(gen.OUT) / 'sitemap.xml').read_text(encoding='utf-8'))
        company = (Path(gen.OUT) / 'our-company' / 'index.html').read_text(encoding='utf-8')
        self.assertIn('Meet Andrew', company)
        self.assertIn('Andrew Collier, Owner &amp; Founder', company)
        self.assertIn('/andrew-family-768.webp', company)
        self.assertIn('/andrew-family-400.webp', company)
        self.assertNotIn('PHOTO PLACEHOLDER', company)
        self.assertNotIn('name="robots" content="noindex,nofollow"', company)

    def test_homepage_form_is_on_and_test_page_stays_gated(self):
        os.environ['CONTEXT'] = 'production'
        self.build(live=False)
        page = (Path(gen.OUT) / 'test-intake' / 'index.html').read_text(encoding='utf-8')
        self.assertNotIn('id="ts-form"', page)
        self.assert_unused_test_page(page)
        self.assertIn('tracking:false', page)
        self.assertNotIn('id="fsho-google-gate"', page)
        self.assertIn('noindex,nofollow', page)
        self.assertNotIn('data-public="1"', page)
        self.assertNotIn('/test-intake/', (Path(gen.OUT) / 'sitemap.xml').read_text(encoding='utf-8'))
        home = (Path(gen.OUT) / 'index.html').read_text(encoding='utf-8')
        self.assertIn('id="ts-form"', home)
        self.assertIn('data-public="1"', home)
        self.assertIn('FSHO_DEPLOY_CONTEXT="production"', home)
        self.assertNotIn('PREVIEW:', home)
        self.assertNotIn('Test mode is off', home)
        self.assertIn('var FSHO={endpoint:""', home)
        os.environ.pop('CONTEXT')
        self.build(live=True)
        live_page = (Path(gen.OUT) / 'test-intake' / 'index.html').read_text(encoding='utf-8')
        live_home = (Path(gen.OUT) / 'index.html').read_text(encoding='utf-8')
        self.assertNotIn('id="ts-form"', live_page)
        self.assert_unused_test_page(live_page)
        self.assertIn('noindex,nofollow', live_page)
        self.assertIn('data-public="1"', live_home)
        self.assertNotIn('PREVIEW:', live_home)

    def test_production_test_page_stays_noindex_and_homepage_bakes_the_real_flag(self):
        os.environ['CONTEXT'] = 'production'
        os.environ.pop('FSHO_USE_REAL_ADAPTER', None)
        self.build(live=False)
        page = (Path(gen.OUT) / 'test-intake' / 'index.html').read_text(encoding='utf-8')
        home = (Path(gen.OUT) / 'index.html').read_text(encoding='utf-8')
        self.assertNotIn('id="ts-form"', page)
        self.assertNotIn('window.FSHO_USE_REAL_ADAPTER', page)
        self.assert_unused_test_page(page)
        self.assertIn('noindex,nofollow', page)
        self.assertNotIn('/test-intake/', (Path(gen.OUT) / 'sitemap.xml').read_text(encoding='utf-8'))
        self.assertNotIn('PREVIEW:', home)
        self.assertIn('data-public="1"', home)
        self.assertIn('window.FSHO_USE_REAL_ADAPTER=""', home)
        self.assertIn('var FSHO={endpoint:""', home)
        os.environ['FSHO_USE_REAL_ADAPTER'] = '1'
        self.build(live=False)
        flagged = (Path(gen.OUT) / 'test-intake' / 'index.html').read_text(encoding='utf-8')
        home_flagged = (Path(gen.OUT) / 'index.html').read_text(encoding='utf-8')
        self.assertNotIn('id="ts-form"', flagged)
        self.assertNotIn('window.FSHO_USE_REAL_ADAPTER', flagged)
        self.assertIn('noindex,nofollow', flagged)
        self.assertNotIn('PREVIEW:', home_flagged)
        self.assertIn('window.FSHO_USE_REAL_ADAPTER="1"', home_flagged)
        self.assertIn('data-public="1"', home_flagged)
        self.assertIn('var FSHO={endpoint:""', home_flagged)
        os.environ.pop('FSHO_USE_REAL_ADAPTER', None)
        os.environ.pop('CONTEXT', None)

    def test_drafts_preview_included_live_and_production_skipped(self):
        self.add_drafts()
        data, path = self.site()
        data['preview'] = True
        self.save_site(data, path)
        self.build(live=False)
        self.assertTrue((Path(gen.OUT) / 'draft-page' / 'index.html').is_file())
        self.assertTrue((Path(gen.OUT) / 'zz-draft-market' / 'index.html').is_file())
        draft_html = (Path(gen.OUT) / 'draft-page' / 'index.html').read_text(encoding='utf-8')
        self.assertIn('noindex,nofollow', draft_html)
        self.assertIn('Draft page body', draft_html)
        sitemap = (Path(gen.OUT) / 'sitemap.xml').read_text(encoding='utf-8')
        self.assertNotIn('draft-page', sitemap)
        self.assertNotIn('zz-draft-market', sitemap)
        areas = (Path(gen.OUT) / 'service-areas' / 'index.html').read_text(encoding='utf-8')
        self.assertIn('/zz-draft-market/', areas)
        preview_guards = self.guards()

        os.environ['CONTEXT'] = 'production'
        self.build(live=False)
        self.assertFalse((Path(gen.OUT) / 'draft-page').exists())
        self.assertFalse((Path(gen.OUT) / 'zz-draft-market').exists())
        areas = (Path(gen.OUT) / 'service-areas' / 'index.html').read_text(encoding='utf-8')
        self.assertNotIn('zz-draft-market', areas)
        prod = self.guards()
        self.assertEqual(prod['banner'], preview_guards['banner'])
        self.assertEqual(prod['noindex'], preview_guards['noindex'])
        self.assertEqual(prod['endpoint'], preview_guards['endpoint'])
        self.assertEqual(prod['alert'], preview_guards['alert'])
        self.assertIn('FSHO_DEPLOY_CONTEXT="local"', preview_guards['home'])
        self.assertIn('FSHO_DEPLOY_CONTEXT="production"', prod['home'])
        self.assertEqual(prod['robots'], preview_guards['robots'])
        self.assertEqual(prod['headers'], preview_guards['headers'])
        self.assertTrue(prod['banner'])
        self.assertTrue(prod['noindex'])
        self.assertTrue(prod['endpoint'])
        self.assertFalse(prod['alert'])
        self.assertEqual(prod['robots'], 'User-agent: *\nDisallow: /\n')
        self.assertIn('X-Robots-Tag: noindex, nofollow', prod['headers'])

        os.environ.pop('CONTEXT', None)
        self.build(live=True)
        self.assertFalse((Path(gen.OUT) / 'draft-page').exists())
        self.assertFalse((Path(gen.OUT) / 'zz-draft-market').exists())
        live = self.guards()
        self.assertFalse(live['banner'])
        self.assertNotIn('name="robots" content="noindex,nofollow"', live['home'])
        self.assertTrue(live['alert'])
        self.assertTrue(live['endpoint'])
        self.assertEqual(live['headers'], '')
        self.assertFalse((Path(gen.OUT) / '_headers').exists())
        self.assertIn('Disallow: /step-2/', live['robots'])
        self.assertNotIn('Disallow: /', live['robots'].split('Disallow: /step-2/')[0])

    def test_deploy_preview_includes_drafts_even_if_site_preview_off(self):
        self.add_drafts()
        data, path = self.site()
        data['preview'] = False
        self.save_site(data, path)
        os.environ['CONTEXT'] = 'deploy-preview'
        self.build(live=False)
        self.assertTrue((Path(gen.OUT) / 'draft-page' / 'index.html').is_file())
        self.assertTrue((Path(gen.OUT) / 'zz-draft-market' / 'index.html').is_file())
        # Site preview is off, so the global banner stays off. The draft itself is still noindex.
        home = (Path(gen.OUT) / 'index.html').read_text(encoding='utf-8')
        draft = (Path(gen.OUT) / 'draft-page' / 'index.html').read_text(encoding='utf-8')
        self.assertNotIn('PREVIEW:', home)
        self.assertIn('noindex,nofollow', draft)

    def test_home_draft_and_false_are_refused(self):
        home = self.root / 'content' / 'pages' / 'home.md'
        text = home.read_text(encoding='utf-8')
        home.write_text(text.replace('noindex: false', 'noindex: false\ndraft: true', 1), encoding='utf-8')
        errors, _warns = self.check()
        self.assertTrue(any('home page cannot be draft' in e and 'no index' in e for e in errors), errors)

        home.write_text(text, encoding='utf-8')
        self.write('content/pages/draft-false.md', '''---
title: "Published page"
meta_description: "x"
template: basic
draft: false
---
<p>Hi</p>
''')
        self.write('content/markets/zz-false.json', json.dumps({
            'state': 'Nope', 'slug': 'zz-false', 'title': 'Nope title unique',
            'meta_description': 'nope', 'headline': 'H', 'hero_sub': 'S', 'draft': False,
        }))
        errors, _warns = self.check()
        joined = '\n'.join(errors)
        self.assertIn('draft-false.md', joined)
        self.assertIn('never write draft: false', joined)
        self.assertIn('zz-false.json', joined)
        self.assertNotIn('home page cannot be draft', joined)

    def test_media_manifest_validation_and_dimensions(self):
        self.build(live=False)
        home = (Path(gen.OUT) / 'index.html').read_text(encoding='utf-8')
        self.assertIn('<img src="/logo.webp" alt="Fair &amp; Simple Home Offer" fetchpriority="high" width="320" height="122">', home)
        self.assertIn('<img src="/logo.webp" alt="" class="inv" loading="lazy" width="320" height="122">', home)
        self.assertTrue((Path(gen.OUT) / 'logo.webp').is_file())
        self.assertTrue((Path(gen.OUT) / 'favicon.png').is_file())
        self.assertFalse((Path(gen.OUT) / 'media.json').exists())
        # Seeded dimensions match the WebP header (VP8X canvas size).
        blob = (self.root / 'content' / 'media' / 'logo.webp').read_bytes()
        self.assertEqual(blob[12:16], b'VP8X')
        width = 1 + int.from_bytes(blob[24:27], 'little')
        height = 1 + int.from_bytes(blob[27:30], 'little')
        manifest = json.loads((self.root / 'content' / 'media' / 'media.json').read_text(encoding='utf-8'))
        self.assertEqual(manifest, [
            {'file': 'logo.webp', 'alt': 'Fair & Simple Home Offer', 'width': width, 'height': height},
            {'file': 'andrew-family-768.webp', 'alt': 'Andrew Collier with his wife and baby', 'width': 768, 'height': 720},
            {'file': 'andrew-family-400.webp', 'alt': 'Andrew Collier with his wife and baby', 'width': 400, 'height': 375},
            {'file': 'google-ratings.webp', 'alt': '5-star rated on Google', 'width': 195, 'height': 91},
            {'file': 'bbb-white.webp', 'alt': 'A+ BBB rating', 'width': 160, 'height': 112},
            {'file': 'fb-white.webp', 'alt': '5-star rated on Facebook', 'width': 100, 'height': 46},
        ])
        self.assertEqual((width, height), (320, 122))

        manifest[0].pop('alt')
        self.write('content/media/media.json', json.dumps(manifest))
        errors, warns = self.check()
        self.assertEqual(errors, [], errors)
        self.assertTrue(any('logo.webp is missing alt' in w for w in warns), warns)

        manifest[0]['alt'] = 'Fair & Simple Home Offer'
        manifest[0]['width'] = True
        self.write('content/media/media.json', json.dumps(manifest))
        errors, _warns = self.check()
        self.assertTrue(any('positive integer width' in e for e in errors), errors)

        manifest[0]['width'] = 320
        manifest[0]['file'] = 'notes.png'
        self.write('content/media/media.json', json.dumps(manifest))
        errors, _warns = self.check()
        self.assertTrue(any('webp' in e.lower() for e in errors), errors)

        self.write('content/media/media.json', json.dumps([{'file': 'logo.webp', 'alt': 'Fair & Simple Home Offer', 'width': 320, 'height': 122}]))
        self.write('content/pages/extra-img.md', '''---
title: "Extra image"
meta_description: "x"
template: basic
og_image: "/missing.webp"
---
<img src="/missing.webp" alt="missing">
''')
        errors, _warns = self.check()
        self.assertTrue(any('missing.webp' in e and 'missing entry' in e for e in errors), errors)

    def test_faq_schema_matches_rendered_items(self):
        self.write('content/pages/own-faq.md', '''---
title: "Own FAQ page"
meta_description: "own"
template: basic
faq:
  - q: "Own question?"
    a: "Own &amp; answer"
  - q: "Second?"
    a: "Two"
---
<section class="wrap pad">{{faq:1}}</section>
''')
        self.build(live=False)
        site, _pages, _markets, _redirects, _errs = self.load()
        home = (Path(gen.OUT) / 'index.html').read_text(encoding='utf-8')
        faq = (Path(gen.OUT) / 'faq' / 'index.html').read_text(encoding='utf-8')
        how = (Path(gen.OUT) / 'how-it-works' / 'index.html').read_text(encoding='utf-8')
        contact = (Path(gen.OUT) / 'contact-us' / 'index.html').read_text(encoding='utf-8')
        own = (Path(gen.OUT) / 'own-faq' / 'index.html').read_text(encoding='utf-8')

        def assert_parity(doc, expected):
            blocks = [b for b in ld_blocks(doc) if b.get('@type') == 'FAQPage']
            self.assertEqual(len(blocks), 1)
            pairs = faq_pairs(doc)
            main = blocks[0]['mainEntity']
            self.assertEqual(len(pairs), len(main))
            self.assertEqual(len(main), len(expected))
            for (q, a), item, src in zip(pairs, main, expected):
                self.assertEqual(q, src['q'])
                self.assertEqual(a, src['a'])
                self.assertEqual(item['@type'], 'Question')
                self.assertEqual(item['name'], html_mod.unescape(q))
                self.assertEqual(item['acceptedAnswer']['@type'], 'Answer')
                self.assertEqual(item['acceptedAnswer']['text'], html_mod.unescape(a))
            self.assertTrue(any(b.get('@type') == 'RealEstateAgent' for b in ld_blocks(doc)))

        assert_parity(home, site['faq'][:5])
        assert_parity(faq, site['faq'])
        assert_parity(how, site['faq'])
        self.assertEqual(len(faq_pairs(contact)), 0)
        self.assertFalse(any(b.get('@type') == 'FAQPage' for b in ld_blocks(contact)))
        assert_parity(own, [{'q': 'Own question?', 'a': 'Own &amp; answer'}])
        legit = next(q for q in ld_blocks(faq)[1]['mainEntity'] if q['name'].startswith('Is this legit'))
        self.assertIn('Fair & Simple', legit['acceptedAnswer']['text'])
        self.assertNotIn('&amp;', legit['acceptedAnswer']['text'])

    def test_canonical_and_og_are_escaped(self):
        self.write('content/pages/special.md', SPECIAL)
        self.build(live=False)
        doc = (Path(gen.OUT) / 'special' / 'index.html').read_text(encoding='utf-8')
        self.assertIn('<title>Tom and &quot;Jerry&quot; &lt;b&gt;</title>', doc)
        self.assertIn('<meta name="description" content="Say &quot;hi&quot; and bye">', doc)
        self.assertIn('<link rel="canonical" href="https://example.com/a?x=1&amp;y=2">', doc)
        self.assertIn('<meta property="og:title" content="OG and &quot;title&quot; &lt;x&gt;">', doc)
        self.assertIn('<meta property="og:description" content="Say &quot;hi&quot; and bye">', doc)
        self.assertIn('<meta property="og:url" content="https://example.com/a?x=1&amp;y=2">', doc)
        self.assertIn('<meta property="og:image" content="https://fsho.co/logo.webp">', doc)
        self.assertIn('<meta name="twitter:card" content="summary_large_image">', doc)
        self.assertIn('<meta name="twitter:title" content="OG and &quot;title&quot; &lt;x&gt;">', doc)
        self.assertNotIn('content="Tom & "Jerry"', doc)
        blocks = ld_blocks(doc)
        faq = next(b for b in blocks if b['@type'] == 'FAQPage')
        self.assertEqual(faq['mainEntity'][0]['acceptedAnswer']['text'], 'Own & answer </script><script>alert(1)')
        raw = re.search(r'<script type="application/ld\+json">(\{"@context":"https://schema.org","@type":"FAQPage".*?)</script>', doc).group(1)
        self.assertNotIn('</script>', raw)
        self.assertIn('<\\/script>', raw)
        # Default page with no og_image uses summary and the title, still escaped.
        home = (Path(gen.OUT) / 'index.html').read_text(encoding='utf-8')
        self.assertIn('twitter:card" content="summary"', home)
        self.assertIn('og:title" content="Sell Your House Fast for Cash | Fair and Simple Home Offer"', home)
        self.assertIn('og:site_name" content="Fair and Simple Home Offer"', home)
        self.assertIn('"name":"Fair and Simple Home Offer"', home)
        self.assertNotIn('property="og:image"', home)

    def test_404_path(self):
        self.build(live=False)
        page = Path(gen.OUT) / '404.html'
        self.assertTrue(page.is_file())
        self.assertFalse((Path(gen.OUT) / '404' / 'index.html').exists())
        doc = page.read_text(encoding='utf-8')
        self.assertIn('noindex,nofollow', doc)
        self.assertIn('href="/"', doc)
        self.assertIn('href="/#offer"', doc)
        self.assertIn('Get My Fair Cash Offer', doc)
        self.assertIn('Back to home', doc)
        self.assertIn('canonical" href="https://fsho.co/404.html"', doc)
        sitemap = (Path(gen.OUT) / 'sitemap.xml').read_text(encoding='utf-8')
        self.assertNotIn('404', sitemap)
        redirects = (Path(gen.OUT) / '_redirects').read_text(encoding='utf-8')
        self.assertTrue(redirects.rstrip().endswith('/* /404.html 404'), redirects[-80:])
        self.assertIn('ErrorDocument 404 /404.html', (Path(gen.OUT) / '.htaccess').read_text(encoding='utf-8'))
        self.assertIn('error_page 404 /404.html;', (Path(gen.OUT) / 'redirects.conf').read_text(encoding='utf-8'))

    def test_form1_schema_and_per_page_cta(self):
        data, path = self.site()
        address = next(f for f in data['form1_fields'] if f['name'] == 'address')
        address['label'] = 'House address'
        self.save_site(data, path)
        self.write('content/pages/cta-page.md', '''---
title: "CTA page"
meta_description: "cta"
template: basic
cta_label: "Page specific heading"
---
{{cta}}

{{cta:Explicit heading}}
''')
        self.build(live=False)
        home = (Path(gen.OUT) / 'index.html').read_text(encoding='utf-8')
        self.assertIn('id="ts-form"', home)
        self.assertIn('<label>Name<input name="name" autocomplete="name" required></label>', home)
        self.assertIn('<label>Property address<input name="address" autocomplete="street-address" required></label>', home)
        self.assertIn('<label>Phone<input name="phone" type="tel" autocomplete="tel" required></label>', home)
        self.assertIn('<label>Email<input name="email" type="email" autocomplete="email" required></label>', home)
        self.assertNotIn('name="form_id" value="1"', home)
        self.assertNotIn('House address', home)
        self.assertIn('var FSHO={endpoint:""', home)
        ohio_form = (Path(gen.OUT) / 'sell-your-house-fast-in-ohio' / 'index.html').read_text(encoding='utf-8')
        self.assertIn('data-public="1"', ohio_form)
        self.assertIn('id="ts-form"', ohio_form)
        self.assertNotIn('action="/step-2/"', ohio_form)
        self.assertNotIn('name="form_id" value="1"', ohio_form)
        self.assertNotIn('House address', ohio_form)
        cta = (Path(gen.OUT) / 'cta-page' / 'index.html').read_text(encoding='utf-8')
        self.assertIn('<h2>Page specific heading</h2>', cta)
        self.assertIn('<h2>Explicit heading</h2>', cta)
        ohio = (Path(gen.OUT) / 'sell-your-house-fast-in-ohio' / 'index.html').read_text(encoding='utf-8')
        self.assertIn('<h2>Get your Ohio cash offer</h2>', ohio)
        plain = (Path(gen.OUT) / 'how-it-works' / 'index.html').read_text(encoding='utf-8')
        self.assertIn('<h2>Ready to see your options?</h2>', plain)

        original = json.loads((ROOT / 'content' / 'site.json').read_text(encoding='utf-8'))

        data = json.loads(json.dumps(original))
        data['form1_fields'] = [f for f in data['form1_fields'] if f['name'] != 'phone']
        self.save_site(data, path)
        errors, _warns = self.check()
        self.assertTrue(any('missing "phone"' in e for e in errors), errors)

        data = json.loads(json.dumps(original))
        for field in data['form1_fields']:
            if field['name'] == 'email':
                field['required'] = 'yes'
        self.save_site(data, path)
        errors, _warns = self.check()
        self.assertTrue(any('email' in e and 'required must be true or false' in e for e in errors), errors)

        data = json.loads(json.dumps(original))
        for field in data['form1_fields']:
            if field['name'] in ('first', 'last', 'phone'):
                field['pair'] = 'broken'
        self.save_site(data, path)
        errors, _warns = self.check()
        self.assertTrue(any('pair "broken" must be exactly two consecutive fields' in e for e in errors), errors)


    def test_public_two_stage_consent_profiles_and_sotellus(self):
        google = 'https://share.google/xhED38I3oGqYAQE21'
        facebook = 'https://www.facebook.com/profile.php?id=61581144807978'
        bbb = 'https://www.bbb.org/us/mi/rockford/profile/real-estate-investing/fair-and-simple-home-offer-0372-38321834'
        bbb_reviews = bbb + '/customer-reviews'
        link = 'target="_blank" rel="noopener noreferrer"'
        disclosure = 'Consent isn\u2019t required to buy or sell'
        self.build(live=False)
        pages = {
            'index.html': Path(gen.OUT) / 'index.html',
            'how-it-works': Path(gen.OUT) / 'how-it-works' / 'index.html',
            'contact-us': Path(gen.OUT) / 'contact-us' / 'index.html',
            'stop-foreclosure': Path(gen.OUT) / 'stop-foreclosure' / 'index.html',
            'north-carolina': Path(gen.OUT) / 'sell-your-house-fast-in-north-carolina' / 'index.html',
            'sell-your-house-as-is': Path(gen.OUT) / 'sell-your-house-as-is' / 'index.html',
            'companies-that-buy-houses': Path(gen.OUT) / 'companies-that-buy-houses' / 'index.html',
            'sell-your-house-fast': Path(gen.OUT) / 'sell-your-house-fast' / 'index.html',
            'selling-a-house-in-pre-foreclosure': Path(gen.OUT) / 'selling-a-house-in-pre-foreclosure' / 'index.html',
            'selling-a-house-in-divorce': Path(gen.OUT) / 'selling-a-house-in-divorce' / 'index.html',
            'selling-an-inherited-house': Path(gen.OUT) / 'selling-an-inherited-house' / 'index.html',
            'selling-a-house-in-probate': Path(gen.OUT) / 'selling-a-house-in-probate' / 'index.html',
            'selling-a-house-with-tenants': Path(gen.OUT) / 'selling-a-house-with-tenants' / 'index.html',
        }
        markets = list((self.root / 'content' / 'markets').glob('*.json'))
        self.assertEqual(len(markets), 39)
        for market in markets:
            slug = json.loads(market.read_text(encoding='utf-8'))['slug']
            pages[slug] = Path(gen.OUT) / slug / 'index.html'
        phone = 'tel:+19106366669'
        for name, path in pages.items():
            html = path.read_text(encoding='utf-8')
            self.assertIn('data-public="1"', html, name)
            self.assertIn('id="ts-form"', html, name)
            self.assertIn('["decision_maker", "I\'m an heir, executor, or have power of attorney"]', html, name)
            self.assertNotIn("I'm an heir, executor, or POA", html, name)
            self.assertIn('is_test: options.isTest === true', html, name)
            self.assertIn('chooseAdapter({ isTest: testOn })', html, name)
            self.assertNotIn('FSHO_CONSENT_PREVIEW', html, name)
            self.assertNotIn('action="/step-2/"', html, name)
            self.assertNotIn('?consent-size', html, name)
            self.assertNotIn('consent-sizes', html, name)
            self.assertNotIn('[PLACEHOLDER:', html, name)
            self.assertNotIn('homes listed with an agent', html, name)
            self.assertNotIn('less than 7 years', html, name)
            self.assertIn('class="mnav"', html, name)
            self.assertIn(phone, html, name)
            box = re.search(r'<label class="consent" data-consent-size="8"><input type="checkbox" name="consent">(.*?)</label>', html)
            self.assertIsNotNone(box, name)
            self.assertNotIn('required', box.group(0).split('</label>')[0].split('<small>')[0], name)
            self.assertNotIn('checked', box.group(0).split('<small>')[0], name)
            self.assertIn(disclosure, box.group(0), name)
            self.assertIn('href="/text-messaging-terms/"', box.group(0), name)
            self.assertIn('href="/privacy/"', box.group(0), name)
            self.assertNotIn('font-size:7px', html, name)
            self.assertNotIn('font-size:7.5px', html, name)
            self.assertIn('font-size:8px', html, name)
            self.assertIn('<title>', html, name)
            self.assertNotIn('&amp;', re.search(r'<title>.*?</title>', html).group(0), name)
            self.assertNotIn('&amp;', re.search(r'property="og:title" content="[^"]*"', html).group(0), name)
            self.assertNotIn('&amp;', re.search(r'property="og:site_name" content="[^"]*"', html).group(0), name)
            self.assertNotIn('&amp;', re.search(r'name="twitter:title" content="[^"]*"', html).group(0), name)
            self.assertIn(f'href="{google}" {link}', html, name)
            self.assertIn(f'href="{facebook}" {link}', html, name)
            self.assertIn(f'href="{bbb}" {link}', html, name)
        quiet = {
            'faq': Path(gen.OUT) / 'faq' / 'index.html',
            'our-company': Path(gen.OUT) / 'our-company' / 'index.html',
            'privacy': Path(gen.OUT) / 'privacy' / 'index.html',
            'step-2': Path(gen.OUT) / 'step-2' / 'index.html',
        }
        for name, path in quiet.items():
            html = path.read_text(encoding='utf-8')
            self.assertNotIn('data-public="1"', html, name)
            self.assertNotIn('id="ts-form"', html, name)
        faq = quiet['faq'].read_text(encoding='utf-8')
        company = quiet['our-company'].read_text(encoding='utf-8')
        for html in (faq, company):
            self.assertIn(f'href="{google}" {link}', html)
            self.assertIn(f'href="{facebook}" {link}', html)
            self.assertIn(f'href="{bbb}" {link}', html)
        step2 = quiet['step-2'].read_text(encoding='utf-8')
        self.assertNotIn('id="qf"', step2)
        self.assertNotIn('We got your info', step2)
        self.assertIn('does not mean we received your information', step2)
        self.assertIn('tel:+19106366669', step2)
        thanks = (Path(gen.OUT) / 'thank-you' / 'index.html').read_text(encoding='utf-8')
        self.assertNotIn('Local demo', thanks)
        self.assertNotIn('Expect a call', thanks)
        self.assertIn('does not confirm a request', thanks)
        self.assertIn('tel:+19106366669', thanks)
        privacy = quiet['privacy'].read_text(encoding='utf-8')
        terms = (Path(gen.OUT) / 'terms-conditions' / 'index.html').read_text(encoding='utf-8')
        sms = (Path(gen.OUT) / 'text-messaging-terms' / 'index.html').read_text(encoding='utf-8')
        help_line = 'email offer@fairandsimplehomeoffer.com.'
        for html in (privacy, terms, sms):
            self.assertNotIn('PLACEHOLDER', html)
            self.assertNotIn('(888) 892-3602', html)
            self.assertNotIn('info@fairandsimplehomeoffer.com', html)
            self.assertNotIn('andrew@fairandsimplehomeoffer.com', html)
            self.assertIn(help_line, html)
            self.assertIn('href="/privacy/"', html)
            self.assertIn('Google Analytics', html) if html is privacy else None
        self.assertEqual(privacy.count(help_line), 1)
        self.assertEqual(terms.count(help_line), 2)
        self.assertEqual(sms.count(help_line), 2)
        self.assertIn('using Google Analytics', privacy)
        self.assertIn('Google Adwords tracking cookie', privacy)
        self.assertIn('Google AdWords remarketing service', privacy)
        self.assertIn('href="/contact-us/"', privacy)
        self.assertIn('https://fsho.co/', terms)
        self.assertNotIn('fairandsimplehomeoffer.com/', terms)
        self.assertIn('href="tel:+19106366669">(910) 636-6669</a>', terms)
        self.assertIn('Text Messaging Terms/ SMS Terms', sms)
        self.assertNotIn('tel:+1888', terms)
        reviews = (Path(gen.OUT) / 'reviews' / 'index.html').read_text(encoding='utf-8')
        self.assertNotIn('id="ts-form"', reviews)
        self.assertIn(f'href="{google}" {link}', reviews)
        self.assertIn(f'href="{facebook}" {link}', reviews)
        self.assertIn(f'href="{bbb}" {link}', reviews)
        self.assertIn(f'href="{bbb_reviews}" {link}', reviews)
        self.assertIn('fair-and-simple-home-offer', reviews)
        self.assertEqual(len(re.findall(r'<iframe\b[^>]*sotellus\.com/widgets/stu-react-reviews-header', reviews)), 1)
        self.assertEqual(len(re.findall(r'<iframe\b[^>]*sotellus\.com/widgets/stu-react-reviews-slider', reviews)), 1)
        self.assertIn('title="Fair and Simple Home Offer review summary"', reviews)
        self.assertIn('title="Fair and Simple Home Offer reviews"', reviews)
        self.assertIn('loading="lazy"', reviews)
        self.assertIn('height="480"', reviews)
        self.assertIn('style="border:0"', reviews)
        self.assertIsNone(re.search(r'<script[^>]+sotellus\.com', reviews))
        self.assertIsNone(re.search(r'<script[^>]+src="https://www\.googletagmanager\.com/gtm\.js', reviews))
        home = pages['index.html'].read_text(encoding='utf-8')
        nc_html = pages['north-carolina'].read_text(encoding='utf-8')
        self.assertNotIn('sotellus.com', home)
        self.assertIn('alt="5-star rated on Google"', home)
        self.assertIn('alt="A+ BBB rating"', home)
        self.assertIn('alt="5-star rated on Facebook"', home)
        self.assertIn('Sell your house as-is · No fees · No repairs', home)
        self.assertNotIn('Family-owned since 2017', home)
        self.assertNotIn('No fees or commissions', home)
        self.assertNotIn('.trust li{background:#ffffff1f;border-radius:99px', home)
        self.assertIn('.trust{list-style:none;padding:0;margin:16px 0 0;display:flex;flex-direction:column;align-items:center;gap:10px}', home)
        self.assertIn('.trust li:has(a.badge){background:none;padding:0;display:flex;flex-wrap:wrap;justify-content:center;align-items:center;gap:10px 12px;max-width:100%}', home)
        for html, name in ((home, 'home'), (reviews, 'reviews'), (nc_html, 'north-carolina')):
            trust_html = re.search(r'<ul class="trust">(.*?)</ul>', html).group(1)
            self.assertIn('<li class="trust-logos">', trust_html, name)
            self.assertEqual(trust_html.count('<li'), 1, name)
            self.assertEqual(trust_html.count('class="badge"'), 3, name)
            self.assertIn('google-ratings.webp', trust_html, name)
            self.assertIn('bbb-white.webp', trust_html, name)
            self.assertIn('fb-white.webp', trust_html, name)
            self.assertNotIn('Family-owned since 2017', trust_html, name)
            self.assertNotIn('No fees or commissions', trust_html, name)
        for html in (home, nc_html):
            self.assertIn('multi-family properties (2–4 units)', html)
            self.assertNotIn('class="ph"', html)
        test_page = (Path(gen.OUT) / 'test-intake' / 'index.html').read_text(encoding='utf-8')
        self.assertNotIn('data-public="1"', test_page)
        test_box = re.search(r'<label class="consent" data-consent-size="8"><input type="checkbox" name="consent">', test_page)
        self.assertIsNotNone(test_box)
        self.assertNotIn('required', test_box.group(0))
        self.assertNotIn('checked', test_box.group(0))
        self.assertIn(disclosure, test_page)

        os.environ['CONTEXT'] = 'deploy-preview'
        self.build(live=False)
        home = (Path(gen.OUT) / 'index.html').read_text(encoding='utf-8')
        preview_test = (Path(gen.OUT) / 'test-intake' / 'index.html').read_text(encoding='utf-8')
        self.assertNotIn('?consent-size', home)
        self.assertNotIn('consent-sizes', home)
        self.assertIn('data-consent-size="8"', home)
        self.assertIn('data-public="1"', home)
        self.assertIn('id="ts-form"', preview_test)
        self.assertIn("<title>This page isn't in use | Fair and Simple Home Offer</title>", preview_test)
        self.assertIn("<h1>This page isn't in use.</h1>", preview_test)
        self.assertIn('Test mode only. Needs ?test=1. This page stays noindex.', preview_test)
        self.assertNotIn("This page isn't used anymore.", preview_test)
        self.assertNotIn('not available on the live site', preview_test)
        self.assertIn('noindex,nofollow', preview_test)
        self.assert_ownership_label(home)
        self.assert_ownership_label(preview_test)
        os.environ['CONTEXT'] = 'production'
        self.build(live=False)
        prod = (Path(gen.OUT) / 'index.html').read_text(encoding='utf-8')
        prod_test = (Path(gen.OUT) / 'test-intake' / 'index.html').read_text(encoding='utf-8')
        self.assertNotIn('?consent-size', prod)
        self.assertNotIn('consent-sizes', prod)
        self.assertIn('data-public="1"', prod)
        self.assertIn('data-consent-size="8"', prod)
        self.assert_ownership_label(prod)
        self.assertNotIn('id="ts-form"', prod_test)
        self.assert_unused_test_page(prod_test)
        self.assertIn('Fair and Simple Home Offer</title>', prod)
        self.assertNotIn('&amp;', re.search(r'<title>.*?</title>', prod).group(0))

    def test_offer_href_follows_the_hero_form(self):
        self.build(live=False)
        out = Path(gen.OUT)
        form_pages = [
            out / 'index.html',
            out / 'how-it-works' / 'index.html',
            out / 'contact-us' / 'index.html',
            out / 'stop-foreclosure' / 'index.html',
        ]
        for spec in AD_LANDINGS:
            form_pages.append(out / spec['slug'] / 'index.html')
        for market in (self.root / 'content' / 'markets').glob('*.json'):
            slug = json.loads(market.read_text(encoding='utf-8'))['slug']
            form_pages.append(out / slug / 'index.html')
        self.assertEqual(len(form_pages), 51)
        cash = re.compile(r'<a class="btn btn-o" href="([^"]+)">Get My Fair Cash Offer</a>')
        sticky = re.compile(r'<a class="sticky s2b" href="([^"]+)">Get Offer</a>')
        for path in form_pages:
            html = path.read_text(encoding='utf-8')
            self.assertEqual(html.count('id="offer"'), 1, path)
            self.assertEqual(html.count('id="ts-form"'), 1, path)
            self.assertEqual(sticky.findall(html), ['#offer'], path)
            self.assertEqual(cash.findall(html), ['#offer'], path)
            self.assertNotIn('href="/#offer"', html, path)
            self.assertIn('Sell your house as-is · No fees · No repairs', html, path)
        home = (out / 'index.html').read_text(encoding='utf-8')
        self.assertIn('<h1>Sell your house fast, for a fair price, on your timeline.</h1>', home)
        self.assertIn('Brett C.', home)
        self.assertIn('Fair &amp; Simple Cash Offer', home)
        self.assertIn('Our Market-Sale Option', home)
        self.assertIn('Traditional Listing', home)
        no_form = {
            'faq': out / 'faq' / 'index.html',
            'our-company': out / 'our-company' / 'index.html',
            'reviews': out / 'reviews' / 'index.html',
            'service-areas': out / 'service-areas' / 'index.html',
            'privacy': out / 'privacy' / 'index.html',
            'terms': out / 'terms-conditions' / 'index.html',
            'sms': out / 'text-messaging-terms' / 'index.html',
            'thank-you': out / 'thank-you' / 'index.html',
            'step-2': out / 'step-2' / 'index.html',
            '404': out / '404.html',
            'test-intake': out / 'test-intake' / 'index.html',
        }
        band_pages = {'faq', 'our-company', 'reviews', 'service-areas', '404'}
        for name, path in no_form.items():
            html = path.read_text(encoding='utf-8')
            self.assertNotIn('id="offer"', html, name)
            self.assertNotIn('data-public="1"', html, name)
            self.assertEqual(sticky.findall(html), ['/#offer'], name)
            self.assertNotIn('href="#offer"', html, name)
            if name == 'test-intake':
                continue
            self.assertNotIn('id="ts-form"', html, name)
            if name in band_pages:
                self.assertEqual(cash.findall(html), ['/#offer'], name)
            else:
                self.assertEqual(cash.findall(html), [], name)
        faq = no_form['faq'].read_text(encoding='utf-8')
        self.assertIn('What types of properties do you buy?', faq)
        self.assertIn('<h1>Straight answers about selling for cash.</h1>', faq)

    def test_whatconverts_profile_is_enabled_on_public_pages(self):
        init = (
            '<script>var $wc_load=function(a){return JSON.parse(JSON.stringify(a))},'
            '$wc_leads=$wc_leads||{doc:{url:$wc_load(document.URL),ref:$wc_load(document.referrer),'
            'search:$wc_load(location.search),hash:$wc_load(location.hash)}};</script>'
        )
        tag = '<script src="//s.ksrndkehqnwntyxlhgto.com/176490.js" defer></script>'
        pair = init + tag
        self.build(live=False)
        out = Path(gen.OUT)
        pages, redirects = [], []
        for path in out.rglob('*.html'):
            text = path.read_text(encoding='utf-8')
            rel = str(path.relative_to(out))
            if 'class="sticky"' in text:
                pages.append((rel, text))
            else:
                redirects.append((rel, text))
        self.assertEqual(len(pages), 62)
        self.assertEqual(len(redirects), 16)
        for rel, text in pages:
            if rel == 'test-intake/index.html':
                self.assertNotIn('$wc_load', text, rel)
                self.assertNotIn('176490', text, rel)
                self.assertNotIn('ksrndkehqnwntyxlhgto', text, rel)
                continue
            self.assertEqual(text.count(pair), 1, rel)
            self.assertLess(text.index(pair), text.index('<style>'), rel)
            self.assertLess(text.index(init), text.index(tag), rel)
            self.assertNotIn('<script src="//s.ksrndkehqnwntyxlhgto.com/176490.js"></script>', text, rel)
            self.assertNotIn('https://s.ksrndkehqnwntyxlhgto.com', text, rel)
            self.assertIn('tracking:false', text, rel)
            self.assertIn('clickcease:""', text, rel)
            self.assertIn('https://www.clickcease.com/monitor/stat.js', text, rel)
            self.assertNotIn('<script src="https://www.clickcease.com/monitor/cccontrack.js"', text, rel)
            self.assertIsNone(re.search(r'<script[^>]+src="https://www\.googletagmanager\.com/gtm\.js', text), rel)
        for rel, text in redirects:
            self.assertIn('Moved here', text, rel)
            self.assertNotIn('$wc_load', text, rel)
            self.assertNotIn('176490', text, rel)
            self.assertNotIn('ksrndkehqnwntyxlhgto', text, rel)

        original = json.loads((ROOT / 'content' / 'site.json').read_text(encoding='utf-8'))
        data, path = self.site()
        data['whatconverts']['enabled'] = False
        self.save_site(data, path)
        self.build(live=False)
        home = (Path(gen.OUT) / 'index.html').read_text(encoding='utf-8')
        faq = (Path(gen.OUT) / 'faq' / 'index.html').read_text(encoding='utf-8')
        self.assertNotIn('$wc_load', home)
        self.assertNotIn('176490', home)
        self.assertNotIn('176490', faq)
        self.assertIn('href="#offer"', home)
        self.assertIn('href="/#offer"', faq)
        self.assertIn('tracking:false', home)
        self.assertFalse(data['lead_form']['enabled'])

        data = json.loads(json.dumps(original))
        data['whatconverts']['profile_id'] = '999999'
        self.save_site(data, path)
        errors, _warns = self.check()
        self.assertTrue(any('profile_id must be 176490' in e for e in errors), errors)

        data = json.loads(json.dumps(original))
        data['whatconverts']['script_host'] = 'https://s.ksrndkehqnwntyxlhgto.com'
        self.save_site(data, path)
        errors, _warns = self.check()
        self.assertTrue(any('script_host must be //s.ksrndkehqnwntyxlhgto.com' in e for e in errors), errors)

        data = json.loads(json.dumps(original))
        data['whatconverts']['enabled'] = 'yes'
        self.save_site(data, path)
        errors, _warns = self.check()
        self.assertTrue(any('whatconverts.enabled must be true or false' in e for e in errors), errors)

    def test_approved_pixels_are_on_public_pages_and_conversions_wait_for_reserve(self):
        curly = re.compile('[\u2018\u2019\u201c\u201d\u2013\u2014]')
        gtm_ns = (
            '<noscript><iframe src="https://www.googletagmanager.com/ns.html?id=GTM-WWPBQGDZ" '
            'height="0" width="0" style="display:none;visibility:hidden"></iframe></noscript>'
        )
        self.build(live=False)
        out = Path(gen.OUT)
        home = (out / 'index.html').read_text(encoding='utf-8')
        faq = (out / 'faq' / 'index.html').read_text(encoding='utf-8')
        step2 = (out / 'step-2' / 'index.html').read_text(encoding='utf-8')
        thanks = (out / 'thank-you' / 'index.html').read_text(encoding='utf-8')
        test_page = (out / 'test-intake' / 'index.html').read_text(encoding='utf-8')
        pixels_js = (ROOT / 'build' / 'pixels.js').read_text(encoding='utf-8')
        two_stage = (ROOT / 'build' / 'two-stage.js').read_text(encoding='utf-8')
        self.assertIsNone(curly.search(pixels_js))
        self.assertIsNone(curly.search(two_stage[two_stage.index('function notifyReservedPixels'):two_stage.index('function fireExit')]))
        self.assertIn('<h1>Sell your house fast, for a fair price, on your timeline.</h1>', home)
        self.assertIn('Fair &amp; Simple Cash Offer', home)
        self.assertIn('Brett C.', home)
        self.assertIn('og:site_name" content="Fair and Simple Home Offer"', home)
        agent = next(b for b in ld_blocks(home) if b['@type'] == 'RealEstateAgent')
        self.assertEqual(agent['name'], 'Fair and Simple Home Offer')
        self.assertNotIn('aggregateRating', json.dumps(ld_blocks(home)))
        self.assertNotIn('google-site-verification', home)
        self.assertNotIn('fairandsimplehomeoffer.com', home.split('<footer', 1)[0])
        for doc, name in ((home, 'home'), (faq, 'faq'), (step2, 'step-2'), (thanks, 'thank-you')):
            head, rest = doc.split('</head>', 1)
            body_open = rest.split('<body>', 1)[1].split('<header', 1)[0]
            self.assertIsNone(curly.search(head[head.index('<meta name="viewport"'):head.index('<title>')]), name)
            self.assertIsNone(curly.search(body_open), name)
            self.assertIn('<body>' + gtm_ns, doc, name)
            self.assertEqual(doc.count('https://www.googletagmanager.com/gtm.js?id='), 2 if 'function armGtm' in doc else 1, name)
            self.assertEqual(doc.count('ns.html?id=GTM-WWPBQGDZ'), 1, name)
            self.assertNotIn('googletagmanager.com/gtag/js', doc, name)
            self.assertNotIn("gtag('config'", doc, name)
            self.assertNotIn('gtag("config"', doc, name)
            self.assertNotIn('G-M60CT888RJ', doc, name)
            self.assertNotIn('rel="preconnect" href="https://www.googletagmanager.com"', doc, name)
            self.assertIn('<link rel="preconnect" href="https://www.clickcease.com">', head, name)
            self.assertIn('<link rel="dns-prefetch" href="//www.clickcease.com">', head, name)
            self.assertIn('https://www.clickcease.com/monitor/stat.js', head, name)
            self.assertIn('src="https://monitor.clickcease.com/stats/stats.aspx"', head, name)
            self.assertNotIn('cccontrack.js', head, name)
            self.assertNotIn('conversions.aspx', head, name)
            self.assertIn('https://www.clickcease.com/monitor/cccontrack.js', body_open, name)
            self.assertIn('https://monitor.clickcease.com/conversions/conversions.aspx?value=0', body_open, name)
            self.assertNotIn('src="https://monitor.clickcease.com/conversions/', doc, name)
            self.assertIn("fbq('init', '959620977142967');", head, name)
            self.assertIn("fbq('track', 'PageView');", head, name)
            self.assertNotIn("fbq('track', 'Lead'", head, name)
            self.assertNotIn('fbq("track", "Lead"', head, name)
            self.assertIn('fbq("track", "Lead"', body_open, name)
            self.assertIn('https://connect.facebook.net/en_US/fbevents.js', head, name)
            self.assertIn('oaiq("init", { pixelId: "AMsRexCaeaxScDiV9SGJcP" });', head, name)
            self.assertIn('https://bzrcdn.openai.com/sdk/oaiq.min.js', head, name)
            self.assertNotIn('oaiq("measure"', head, name)
            self.assertIn('oaiq("measure", "lead_created"', body_open, name)
            self.assertIn('custom_event_name: "seller_form_completed"', body_open, name)
            self.assertIn('window.FSHO_PIXELS=', body_open, name)
            self.assertIn('AW-16781895992/YrLzCKa9g4sdELjSncI-', body_open, name)
            self.assertIn('tracking:false', doc, name)
            self.assertIn('clickcease:""', doc, name)
            self.assertLess(head.index('var $wc_load=function'), head.index('176490.js'), name)
            self.assertLess(head.index('176490.js'), head.index('rel="preconnect"'), name)
        self.assertIn('publicForm: publicForm', home)
        self.assertIn('data-public="1"', home)
        self.assertIn('href="#offer"', home)
        self.assertNotIn('href="/#offer"', home)
        self.assertIn('href="/#offer"', faq)
        self.assertNotIn('id="ts-form"', faq)
        self.assertNotIn('id="offer"', step2)
        self.assertNotIn('id="offer"', thanks)
        self.assertNotIn('data-public="1"', step2)
        self.assertNotIn('data-public="1"', thanks)
        for src in (pixels_js, two_stage[two_stage.index('function notifyReservedPixels'):two_stage.index('function fireExit')]):
            self.assertNotIn('/step-2', src)
            self.assertNotIn('/thank-you', src)
            self.assertNotIn('pagePath', src)
            self.assertNotIn('location.pathname', src)
        self.assertIn('config.publicForm', two_stage[two_stage.index('function fireConversion'):two_stage.index('function fireExit')])
        self.assertNotIn('googletagmanager.com/gtag/js', pixels_js)
        self.assertIn('transport_type: "beacon"', pixels_js)
        self.assertIn('click_to_call', pixels_js)
        self.assertIn('value: 1.0', pixels_js)
        self.assertIn('currency: "USD"', pixels_js)
        self.assertIn('clickcease:""', test_page)
        self.assertIn('tracking:false', test_page)
        self.assertNotIn('data-public="1"', test_page)
        for needle in (
            '176490', 'rel="preconnect" href="https://www.clickcease.com"',
            'monitor.clickcease.com/stats', 'fbevents', 'oaiq', 'ns.html',
            'FSHO_PIXELS', 'cccontrack', "fbq(", 'fbq("',
        ):
            self.assertNotIn(needle, test_page, needle)
        self.assertNotIn('data-public="1"', test_page)
        moved = [p for p in out.rglob('*.html') if 'Moved here' in p.read_text(encoding='utf-8')]
        self.assertEqual(len(moved), 16)
        for path in moved:
            text = path.read_text(encoding='utf-8')
            self.assertNotIn('176490', text)
            self.assertNotIn('clickcease', text.lower())
            self.assertNotIn('fbq', text)
            self.assertNotIn('oaiq', text)
            self.assertNotIn('ns.html', text)
        original = json.loads((ROOT / 'content' / 'site.json').read_text(encoding='utf-8'))
        data, path = self.site()
        data['pixels']['enabled'] = False
        self.save_site(data, path)
        self.build(live=False)
        quiet = (Path(gen.OUT) / 'index.html').read_text(encoding='utf-8')
        self.assertIn('176490.js', quiet)
        self.assertIn('clickcease:""', quiet)
        self.assertNotIn('rel="preconnect" href="https://www.clickcease.com"', quiet)
        self.assertNotIn('monitor.clickcease.com/stats', quiet)
        self.assertNotIn('fbevents.js', quiet)
        self.assertNotIn('oaiq.min.js', quiet)
        self.assertNotIn('ns.html', quiet)
        self.assertNotIn('FSHO_PIXELS', quiet)
        self.assertIn('href="#offer"', quiet)
        data = json.loads(json.dumps(original))
        data['pixels']['meta_pixel_id'] = '1'
        self.save_site(data, path)
        errors, _warns = self.check()
        self.assertTrue(any('meta_pixel_id must be 959620977142967' in e for e in errors), errors)
        data = json.loads(json.dumps(original))
        data['pixels']['openai_pixel_id'] = 'other'
        self.save_site(data, path)
        errors, _warns = self.check()
        self.assertTrue(any('openai_pixel_id must be AMsRexCaeaxScDiV9SGJcP' in e for e in errors), errors)
        data = json.loads(json.dumps(original))
        data['pixels']['ads_call_send_to'] = 'AW-1/label'
        self.save_site(data, path)
        errors, _warns = self.check()
        self.assertTrue(any('ads_call_send_to must be AW-16781895992/YrLzCKa9g4sdELjSncI-' in e for e in errors), errors)
        data = json.loads(json.dumps(original))
        data['gtm_id'] = 'GTM-OTHER'
        self.save_site(data, path)
        errors, _warns = self.check()
        self.assertTrue(any('gtm_id must be GTM-WWPBQGDZ' in e for e in errors), errors)

    def test_ad_landing_pages_are_unique_indexable_and_public(self):
        self.build(live=False)
        out = Path(gen.OUT)
        home = (out / 'index.html').read_text(encoding='utf-8')
        stop = (out / 'stop-foreclosure' / 'index.html').read_text(encoding='utf-8')
        sitemap = (out / 'sitemap.xml').read_text(encoding='utf-8')
        nav_hrefs = {item['href'] for item in json.loads((self.root / 'content' / 'site.json').read_text(encoding='utf-8'))['nav']}
        self.assertIn('<h1>Stop Foreclosure</h1>', stop)
        self.assertIn('If you are behind, you still have choices', stop)
        self.assertIn('href="/selling-a-house-in-pre-foreclosure/"', stop)
        self.assertIn('<h1>Sell your house fast, for a fair price, on your timeline.</h1>', home)
        self.assertNotIn('Sell your house fast, for a fair cash offer, on your timeline.', home)
        self.assertIn('Brett C.', home)
        header = re.search(r'<header class="top">.*?</header>', home, re.S).group(0)
        mains = {}
        titles, metas, h1s = [], [], []
        form = '<div id="ts-app" data-public="1"><form id="ts-form" action="#" method="post">'
        gtm_ns = (
            '<noscript><iframe src="https://www.googletagmanager.com/ns.html?id=GTM-WWPBQGDZ" '
            'height="0" width="0" style="display:none;visibility:hidden"></iframe></noscript>'
        )
        for spec in AD_LANDINGS:
            slug = spec['slug']
            href = f'/{slug}/'
            self.assertNotIn(href, nav_hrefs, slug)
            self.assertNotIn(f'href="{href}"', header, slug)
            html = (out / slug / 'index.html').read_text(encoding='utf-8')
            mains[slug] = re.search(r'<main>(.*)</main>', html, re.S).group(1)
            self.assertNotIn('name="robots" content="noindex,nofollow"', html, slug)
            self.assertIn(f'<loc>https://fsho.co{href}</loc>', sitemap, slug)
            self.assertIn(f'<link rel="canonical" href="https://fsho.co{href}">', html, slug)
            self.assertEqual(re.findall(r'<h1>(.*?)</h1>', html), [spec['h1']], slug)
            title = re.search(r'<title>(.*?)</title>', html).group(1)
            desc = re.search(r'<meta name="description" content="([^"]*)"', html).group(1)
            self.assertEqual(title, gen.link_preview(spec['title']), slug)
            self.assertEqual(html_mod.unescape(desc), gen.link_preview(spec['meta']), slug)
            self.assertLessEqual(len(spec['title']), 60, slug)
            self.assertLessEqual(len(spec['meta']), 155, slug)
            self.assertNotIn('&amp;', title, slug)
            titles.append(title)
            metas.append(html_mod.unescape(desc))
            h1s.append(spec['h1'])
            self.assertIn(form, html, slug)
            self.assertEqual(html.count('id="offer"'), 1, slug)
            self.assertEqual(html.count('id="two-stage"'), 1, slug)
            self.assertEqual(html.count('id="ts-form"'), 1, slug)
            self.assertIn('>Get My Offer</button>', html, slug)
            self.assertIn('href="#offer">Get Offer</a>', html, slug)
            self.assertIn('tel:+19106366669', html, slug)
            self.assertIn('(910) 636-6669', html, slug)
            self.assertIn('/.netlify/functions/intake-producer', html, slug)
            self.assertIn('data-public="1"', html, slug)
            self.assertNotIn('action="/step-2/"', html, slug)
            self.assertNotIn('name="form_id" value="1"', html, slug)
            self.assertNotIn('name="gclid"', html, slug)
            self.assertNotIn('Test mode only', html, slug)
            visible = re.sub(r'<script\b[^>]*>.*?</script>', '', mains[slug], flags=re.S)
            visible = re.sub(r'<style\b[^>]*>.*?</style>', '', visible, flags=re.S)
            self.assertNotIn('Brett C.', visible, slug)
            self.assertNotIn('Sell your house fast, for a fair cash offer', html, slug)
            self.assertNotIn('3–6 months', html, slug)
            for bad in ('lorem', 'tbd', 'placeholder', 'todo', 'fixme'):
                self.assertNotIn(bad, visible.lower(), '%s %s' % (slug, bad))
            self.assertIn('<body>' + gtm_ns, html, slug)
            self.assertEqual(html.count('ns.html?id=GTM-WWPBQGDZ'), 1, slug)
            self.assertNotIn('googletagmanager.com/gtag/js', html, slug)
            self.assertNotIn("gtag('config'", html, slug)
            self.assertNotIn('google-site-verification', html, slug)
            self.assertNotIn('fairandsimplehomeoffer.com', html, slug)
            self.assertIn('https://www.clickcease.com/monitor/stat.js', html, slug)
            self.assertNotIn('<script src="https://www.clickcease.com/monitor/cccontrack.js"', html, slug)
            self.assertIn("fbq('track', 'PageView');", html, slug)
            self.assertIn('oaiq("init", { pixelId: "AMsRexCaeaxScDiV9SGJcP" });', html, slug)
            self.assertIn('window.FSHO_PIXELS=', html, slug)
            self.assertIn('<script src="//s.ksrndkehqnwntyxlhgto.com/176490.js" defer></script>', html, slug)
            self.assertIn('tracking:false', html, slug)
            self.assertIn('clickcease:""', html, slug)
            agent = next(b for b in ld_blocks(html) if b.get('@type') == 'RealEstateAgent')
            self.assertEqual(agent['url'], 'https://fsho.co/', slug)
            self.assertEqual(agent['name'], 'Fair and Simple Home Offer', slug)
            faqs = faq_pairs(html)
            self.assertGreaterEqual(len(faqs), 2, slug)
            self.assertLessEqual(len(faqs), 4, slug)
            self.assertTrue(any(b.get('@type') == 'FAQPage' for b in ld_blocks(html)), slug)
            self.assertEqual(len(faqs), len(next(b for b in ld_blocks(html) if b.get('@type') == 'FAQPage')['mainEntity']), slug)
        self.assertEqual(len(set(titles)), 8)
        self.assertEqual(len(set(metas)), 8)
        self.assertEqual(len(set(h1s)), 8)
        self.assertNotIn(home_h1(home), h1s)
        self.assertNotIn('Stop Foreclosure', h1s)
        for spec in AD_LANDINGS:
            for other, main in mains.items():
                if other == spec['slug']:
                    self.assertIn(spec['only'], main, spec['slug'])
                else:
                    self.assertNotIn(spec['only'], main, '%s leaked into %s' % (spec['slug'], other))
        pre = mains['selling-a-house-in-pre-foreclosure']
        divorce = mains['selling-a-house-in-divorce']
        probate = mains['selling-a-house-in-probate']
        inherited = mains['selling-an-inherited-house']
        tenants = mains['selling-a-house-with-tenants']
        for main in (pre, divorce, probate):
            self.assertIn('We are not attorneys', main)
        self.assertIn('hud.gov/counseling', pre)
        self.assertIn('href="/stop-foreclosure/"', pre)
        self.assertNotIn('<h1>Stop Foreclosure</h1>', pre)
        self.assertIn('href="/selling-a-house-in-probate/"', inherited)
        self.assertIn('href="/selling-an-inherited-house/"', probate)
        self.assertIn('We do not evict tenants', tenants)
        self.assertIn('do not promise the tenants will leave', tenants)
        self.assertNotIn('we will evict', tenants.lower())
        self.assertNotIn('<h1>Sell your house fast, for a fair price, on your timeline.</h1>', mains['sell-your-house-fast'])


def home_h1(html):
    return re.search(r'<h1>(.*?)</h1>', html).group(1)


if __name__ == '__main__':
    unittest.main(verbosity=2, warnings='ignore')
