# fsho-site

Lean static rebuild of fairandsimplehomeoffer.com (53 pages + 16 301 redirects). Content lives in `content/`; `build/gen.py` turns it into plain HTML in `dist/`. No framework, no client bundle: CSS is inlined, one small inline script, GTM/ClickCease load only after window load (and only when `tracking` is true).

```bash
python3 build/gen.py --check   # validate content, exits 1 on errors
python3 build/gen.py           # build dist/ (preview guards on while site.json "preview" is true)
python3 build/gen.py --wc-review  # blocked WhatConverts review in preview/whatconverts/ (not dist/)
python3 build/test_parity.py   # regression tests for drafts, SEO, media, FAQ, 404, form 1, WhatConverts
```

- Content schema for editors (Sentinel console Website tab): [docs/CONTENT_SCHEMA.md](docs/CONTENT_SCHEMA.md)
- Deploys: Netlify site `fsho-site`, **draft deploys only** until Taylor approves cutover. No DNS changes away from Carrot.
- Lead form stays disabled on this branch. Routing is on `cursor/carrot-lead-routing-f5f7` and is awaiting verified CRM mapping.
- WhatConverts profile 176490 is supported and **off** (`whatconverts.enabled` false). Ordinary preview and production output do not include the script. Carrot at fairandsimplehomeoffer.com already runs that profile and is not modified. `--wc-review` is a blocked local preview only.
- Phone: (910) 636-6669.
