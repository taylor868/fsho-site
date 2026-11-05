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

    def test_repo_check_and_settings_stay_preview(self):
        env = os.environ.copy()
        env.pop('CONTEXT', None)
        proc = subprocess.run([sys.executable, 'build/gen.py', '--check'], cwd=ROOT, env=env, capture_output=True, text=True)
        self.assertEqual(proc.returncode, 0, proc.stdout + proc.stderr)
        self.assertIn('OK: 14 pages, 39 markets, 16 redirects', proc.stdout)
        for name in ('california', 'connecticut', 'massachusetts', 'mississippi', 'north-carolina', 'pennsylvania', 'rhode-island', 'washington'):
            self.assertIn(f'content/markets/{name}.json: title is ', proc.stdout)
        self.assertNotIn('ERROR', proc.stdout)
        site = json.loads((ROOT / 'content' / 'site.json').read_text(encoding='utf-8'))
        self.assertTrue(site['preview'])
        self.assertFalse(site['lead_form']['enabled'])
        self.assertEqual(site['lead_form']['endpoint'], '/.netlify/functions/create-lead')
        self.assertEqual(site['lead_form']['endpoint_planned'], '/.netlify/functions/create-lead')
        toml = (ROOT / 'netlify.toml').read_text(encoding='utf-8')
        self.assertNotIn('--live', toml)
        joined = '\n'.join([
            (ROOT / 'docs' / 'CARROT_PARITY.md').read_text(encoding='utf-8'),
            (ROOT / 'docs' / 'CONTENT_SCHEMA.md').read_text(encoding='utf-8'),
            (ROOT / 'README.md').read_text(encoding='utf-8'),
            site['lead_form']['_note'],
        ])
        self.assertIn('p_assigned_to', joined)
        self.assertIn('lead_form.enabled', joined)
        self.assertNotIn('until the narrow create_lead token exists', joined)
        self.assertNotIn('Blocked on the narrow', joined)
        self.assertNotIn('blocked only on the narrow token', joined)
        self.assertNotIn('awaiting verified CRM mapping', joined)
        self.assertNotIn('not in this branch', joined.lower())

    def test_drafts_preview_included_live_and_production_skipped(self):
        self.add_drafts()
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
        self.assertEqual(prod['home'], preview_guards['home'])
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
        self.assertEqual(manifest, [{'file': 'logo.webp', 'alt': 'Fair & Simple Home Offer', 'width': width, 'height': height}])
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
        self.assertIn('<title>Tom &amp; &quot;Jerry&quot; &lt;b&gt;</title>', doc)
        self.assertIn('<meta name="description" content="Say &quot;hi&quot; &amp; bye">', doc)
        self.assertIn('<link rel="canonical" href="https://example.com/a?x=1&amp;y=2">', doc)
        self.assertIn('<meta property="og:title" content="OG &amp; &quot;title&quot; &lt;x&gt;">', doc)
        self.assertIn('<meta property="og:description" content="Say &quot;hi&quot; &amp; bye">', doc)
        self.assertIn('<meta property="og:url" content="https://example.com/a?x=1&amp;y=2">', doc)
        self.assertIn('<meta property="og:image" content="https://fairandsimplehomeoffer.com/logo.webp">', doc)
        self.assertIn('<meta name="twitter:card" content="summary_large_image">', doc)
        self.assertIn('<meta name="twitter:title" content="OG &amp; &quot;title&quot; &lt;x&gt;">', doc)
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
        self.assertIn('og:title" content="Sell Your House Fast for Cash | Fair &amp; Simple Home Offer"', home)
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
        self.assertIn('canonical" href="https://fairandsimplehomeoffer.com/404.html"', doc)
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
        self.assertIn('<label>House address<input name="address" type="text" autocomplete="street-address" placeholder="123 Main St, City, ST 12345" required></label>', home)
        self.assertIn('name="company_website"', home)
        self.assertIn('<div class="row"><label>First name<input name="first" type="text" autocomplete="given-name" required></label><label>Last name<input name="last" type="text" autocomplete="family-name"></label></div>', home)
        self.assertIn('<label>Phone<input name="phone" type="tel" autocomplete="tel" required></label>', home)
        self.assertIn('<label>Email<input name="email" type="email" autocomplete="email" required></label>', home)
        self.assertIn('name="form_id" value="1"', home)
        self.assertIn('var FSHO={endpoint:""', home)
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


if __name__ == '__main__':
    unittest.main(verbosity=2, warnings='ignore')
