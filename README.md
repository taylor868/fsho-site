# fsho-site

Lean static rebuild of fairandsimplehomeoffer.com (62 pages + 16 301 redirects). Content lives in `content/`; `build/gen.py` turns it into plain HTML in `dist/`. No framework, no client bundle: CSS is inlined, one small inline script. WhatConverts profile 176490 is on for public pages: the official inline snapshot runs in the head, and `176490.js` is deferred. ClickCease visitor monitoring, the GTM-TM6JSDLB noscript iframe, Meta Pixel PageView, and OpenAI Pixel init are on those same pages. `tracking` stays false, so the footer demo does not load a second `gtm.js` or `stat.js`. GTM's container script still waits for the first pointer or key on pages that include the two-stage form. ClickCease, Meta, and OpenAI conversions fire after a reserved public form completion, not on a view of `/step-2` or `/thank-you`.

```bash
python3 build/gen.py --check   # validate content, exits 1 on errors
python3 build/gen.py           # build dist/ (public while site.json "preview" is false; Netlify runs this with no --live flag)
python3 build/test_parity.py   # regression tests for drafts, SEO, media, FAQ, 404, form 1, offer links, WhatConverts, pixels
```

- Content schema for editors (Sentinel console Website tab): [docs/CONTENT_SCHEMA.md](docs/CONTENT_SCHEMA.md)
- Deploys: Netlify site `fsho-site`. `content/site.json` `"preview"` is false, so the production command `python3 build/gen.py` is indexable. No DNS changes in this repo.
- Public heroes use the two-stage form. It posts to `/.netlify/functions/intake-producer` when the build env `FSHO_USE_REAL_ADAPTER` is `1`. The older `lead_form` endpoint stays empty. That create-lead path is on `cursor/carrot-lead-routing-f5f7` and is awaiting verified CRM mapping.
- The Catch Hook POST includes the contact fields plus a stable list of `attr_*` strings (first touch, last touch, landing page, host, referrer, cookies, device, and lead id). The signed edge payload still keeps first-touch `gclid`, `gbraid`, and `wbraid` for Zap verify `campaign_id`. The key list is in [docs/TEST-MODE.md](docs/TEST-MODE.md).
- Phone: (910) 636-6669. Email: offer@fsho.co (`dist/llms.txt`, footer, and LocalBusiness JSON-LD).

## Forms and consent (required on every form)

Every form on the site gets the same consent checkbox from `consent_label()` in `build/gen.py`. Don't hand-write a consent box in a page or a new form; call `consent_label()` inside the `<form>`.

- The text is `content/site.json` `consent`, then `consent_google` (the Google Maps line for address suggestions, linking Google's Terms of Service and Privacy Policy in a new tab), then the Text Terms and Privacy links.
- The box is `required` and never pre-checked. The public form JS (`build/two-stage.js`) also blocks the submit when it's unchecked. It shows "Please check the box to continue." in `#consent-err` (role=alert), marks the box `aria-invalid`, moves focus to it, and sends nothing.
- **Build guard:** after every build, `check_forms()` scans every generated page. The build fails if any `<form>` is missing a required, unchecked consent checkbox, the Google Maps line with both Google links, or the error slot. `build/test_parity.py` (`test_consent_guard_fails_a_form_without_required_consent`) covers the guard, and `build/test_two_stage.js` covers the JS block.
- The intake payload is unchanged. `consent` is still sent as a boolean, and it's now always `true` because the form can't be sent unchecked.

## Seller personalization (hero + mobile bar)

All client-side, text only, and it never touches the form's submit, the intake functions, GTM/GA4 events, WhatConverts or the Zaps. A conversion still fires only on `seller_form_completed`.

- **Search-matched headline:** pages with `personalize: true` in front matter (home, Sell Fast, Sell For Cash, Companies, As-Is) swap the hero H1 + lede from `content/personalize.json` when `utm_term`, `keyword` or `utm_campaign` matches a bucket. No match keeps the page's own copy, which is also what the server HTML always carries. `build/hero-pre.js` is inlined right after the hero copy so the swap happens before first paint (no flash, CLS 0). `?fsho_intent=<bucket id>` forces a bucket for demos.
- **Local line:** `?city=` or `?utm_city=` (letters, spaces, hyphens, 2–30 chars, otherwise ignored), else the city from an address typed on Step 1 earlier in the session. Rendered with `textContent` in a hidden subhead slot.
- **After hours:** `site.json` `phone_hours` (placeholder 8 AM–8 PM ET until confirmed) and `after_hours_text`. `?fsho_ah=1|0` forces the note on or off; it only flips that note.
- **Mobile bar:** one fixed Call or text / Get Offer bar (`build/mbar.js`), hidden while the hero form is on screen or the keyboard is open.
- **Pick up where you left off:** when Step 2 opens, `{address, city, time}` is kept in `localStorage` `fsho_resume_v1` for 7 days and cleared once contact info is sent or the visitor taps Start over. Continue fills the address and presses the form's own Step 1 button.
- Tests: `python3 build/test_personalize.py`.
