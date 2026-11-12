# fsho-site

Lean static rebuild of fairandsimplehomeoffer.com (53 pages + 16 301 redirects). Content lives in `content/`; `build/gen.py` turns it into plain HTML in `dist/`. No framework, no client bundle: CSS is inlined, one small inline script, GTM/ClickCease load only after window load (and only when `tracking` is true). WhatConverts profile 176490 is on for public pages: the official inline snapshot runs in the head, and `176490.js` is deferred. `tracking` stays false, so this build does not load GTM or ClickCease.

```bash
python3 build/gen.py --check   # validate content, exits 1 on errors
python3 build/gen.py           # build dist/ (public while site.json "preview" is false; Netlify runs this with no --live flag)
python3 build/test_parity.py   # regression tests for drafts, SEO, media, FAQ, 404, form 1, offer links, WhatConverts
```

- Content schema for editors (Sentinel console Website tab): [docs/CONTENT_SCHEMA.md](docs/CONTENT_SCHEMA.md)
- Deploys: Netlify site `fsho-site`. `content/site.json` `"preview"` is false, so the production command `python3 build/gen.py` is indexable. No DNS changes in this repo.
- Public heroes use the two-stage form. It posts to `/.netlify/functions/intake-producer` when the build env `FSHO_USE_REAL_ADAPTER` is `1`. The older `lead_form` endpoint stays empty. That create-lead path is on `cursor/carrot-lead-routing-f5f7` and is awaiting verified CRM mapping.
- Phone: (910) 636-6669.
