"""Seller personalization guards: python3 build/test_personalize.py"""
import json, os, re, subprocess, sys, unittest
from pathlib import Path
ROOT = Path(__file__).resolve().parent.parent
PZ = json.loads((ROOT / 'content' / 'personalize.json').read_text(encoding='utf-8'))
PERSONALIZED = ('', 'sell-your-house-fast', 'sell-your-house-for-cash', 'companies-that-buy-houses', 'sell-your-house-as-is')

class PersonalizeTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        subprocess.run([sys.executable, str(ROOT / 'build' / 'gen.py')], cwd=ROOT, check=True, capture_output=True)
        cls.out = ROOT / 'dist'

    def html(self, slug):
        return (self.out / (slug + '/index.html' if slug else 'index.html')).read_text(encoding='utf-8')

    def test_bucket_copy_keeps_the_site_claims(self):
        ids = [b['id'] for b in PZ['buckets']]
        self.assertEqual(ids, ['foreclosure', 'probate', 'divorce', 'landlord', 'repairs', 'fast'])
        for b in PZ['buckets']:
            re.compile(b['match'])
            self.assertTrue(b['sub'].startswith('Get a fair cash offer in 24 hours'), b['id'])
            self.assertIn('we cover closing costs', b['sub'], b['id'])
            for banned in ('guarantee', 'stop foreclosure', 'within days', 'highest', 'best price', 'any condition', '%'):
                self.assertNotIn(banned, (b['h1'] + ' ' + b['sub']).lower(), b['id'])

    def test_buckets_ship_only_on_personalized_pages_and_server_h1_is_unchanged(self):
        for slug in PERSONALIZED:
            t = self.html(slug)
            self.assertIn('"b":[{"id":"foreclosure"', t, slug)
        self.assertIn('<h1>Sell your house fast, for a fair cash offer, on your timeline.</h1>', self.html(''))
        for slug in ('selling-a-house-in-probate', 'selling-a-house-in-divorce', 'stop-foreclosure', 'contact-us'):
            self.assertNotIn('"b":[{"id"', self.html(slug), slug)
        self.assertNotIn('"b":[{"id"', self.html('faq'))

    def test_city_rule_and_text_only_rendering(self):
        for name in ('hero-pre.js', 'mbar.js'):
            src = (ROOT / 'build' / name).read_text(encoding='utf-8')
            self.assertIn('/^[A-Za-z][A-Za-z -]*$/', src, name)
            self.assertIn('v.length > 30', src, name)
            self.assertNotIn('innerHTML', src, name)
            self.assertNotIn('fetch(', src, name)
            self.assertNotIn('sendBeacon', src, name)
            self.assertNotIn('dataLayer', src, name)

    def test_no_after_hours_display_anywhere(self):
        # Taylor 11/24 10:08 PM ET: no after-hours / closed messaging on the site at any time.
        site = json.loads((ROOT / 'content' / 'site.json').read_text(encoding='utf-8'))
        self.assertNotIn('phone_hours', site)
        self.assertNotIn('after_hours_text', site)
        srcs = [(ROOT / 'build' / n).read_text(encoding='utf-8') for n in ('hero-pre.js', 'mbar.js', 'style.css', 'gen.py')]
        srcs.append((ROOT / 'content' / 'personalize.json').read_text(encoding='utf-8'))
        for t in srcs:
            for bad in ('fsho_ah', 'ah-note', 'mbar-ah', 'after-hours', 'offHours', 'Intl.DateTimeFormat'):
                self.assertNotIn(bad, t)
        for page in self.out.rglob('*.html'):
            t = page.read_text(encoding='utf-8').lower()
            for bad in ("it's after hours", 'after-hours', 'ah-note', 'mbar-ah', 'fsho_ah', "we're closed", 'first thing in the morning'):
                self.assertNotIn(bad, t, str(page))

    def test_mobile_bar_and_resume_slots(self):
        home = self.html('')
        self.assertEqual(home.count('<div class="mbar" id="mbar">'), 1)
        # Default number on purpose: WhatConverts DNI (176490.js) swaps every (910) 636-6669 href and text node.
        self.assertIn('<a class="sticky" href="tel:+19106366669"><span aria-hidden="true">📞 </span>Call or text<span class="sr-only"> (910) 636-6669</span></a>', home)
        self.assertIn('class="ts-resume"', home)
        self.assertIn('class="tbl" tabindex="0" role="region" aria-label=', home)
        self.assertNotIn('Mobile Call / Get Offer bar', self.html('test-intake'))

if __name__ == '__main__':
    unittest.main(verbosity=1)
