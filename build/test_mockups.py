#!/usr/bin/env python3
"""Mockups must never reach production, and must never load tracking or a real form. Run: python3 build/test_mockups.py"""
import os, re, subprocess, sys, unittest
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DIST = os.path.join(ROOT, 'dist')
def build(env_extra, *args):
    env = {k: v for k, v in os.environ.items() if k not in ('CONTEXT', 'FSHO_MOCKUPS')}; env.update(env_extra)
    subprocess.run([sys.executable, 'build/gen.py', *args], cwd=ROOT, env=env, check=True, capture_output=True)
class MockupTests(unittest.TestCase):
    def test_never_in_production(self):
        for env, args in (({'CONTEXT': 'production', 'FSHO_MOCKUPS': '1'}, ()), ({'FSHO_MOCKUPS': '1'}, ('--live',)), ({}, ())):
            build(env, *args)
            self.assertFalse(os.path.exists(os.path.join(DIST, 'mockups')), (env, args))
    def test_preview_pages_are_safe(self):
        build({'CONTEXT': 'deploy-preview'})
        for rel in ('mockups/index.html', 'mockups/seller/index.html'):
            raw = open(os.path.join(DIST, rel), encoding='utf-8').read()
            self.assertIn('<meta name="robots" content="noindex,nofollow">', raw)
            self.assertIn('MOCKUP', raw)
            code = re.sub(r'<style[^>]*>.*?</style>', '', raw, flags=re.S)
            for bad in ('googletagmanager', 'GTM-', 'ksrndkehqnwntyxlhgto', 'fbevents', 'clickcease', 'oaiq', 'intake-producer', 'FSHO_USE_REAL_ADAPTER'):
                self.assertNotIn(bad, code, (rel, bad))
        sitemap = open(os.path.join(DIST, 'sitemap.xml'), encoding='utf-8').read()
        self.assertNotIn('/mockups/', sitemap)
        build({})
if __name__ == '__main__':
    unittest.main()
