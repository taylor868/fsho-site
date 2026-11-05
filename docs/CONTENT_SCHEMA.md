# FSHO content schema

Everything an editor can change lives under `content/`. The build (`python3 build/gen.py`) never needs code edits for copy, pages, markets, redirects, colors, or tracking IDs. Always run `python3 build/gen.py --check` before committing; it exits non-zero and prints `ERROR <file>: <problem>` lines the editor UI can show verbatim.

HTML is allowed (and expected) in text fields; values are inserted as-is, so use `&amp;` for a literal `&` inside HTML-rendered fields. Page `title` is raw text.

```
content/
  site.json            global settings + shared blocks
  pages/<slug>.md      one file per page (home.md = "/")
  markets/<slug>.json  one file per state landing page
  redirects.json       301s
  media/media.json     alt text and pixel size for each WebP
  media/*.webp         images, each < 200 KB
  media/favicon.png    the only non-WebP file; not a media.json row
```

## content/site.json

| Field | Type | Notes |
|---|---|---|
| `company` | string | Plain name, used in JSON-LD. |
| `company_html` | string | Same name HTML-escaped, used in logo alt. |
| `legal_name` | string | "Andrew Collier LLC". |
| `domain` | string | Canonical origin, no trailing slash. |
| `phone` | string | Display phone, `(910) 636-6669`. |
| `tel` | string | E.164, `+19106366669`. Validated `+1XXXXXXXXXX`. |
| `brand.orange` | `#RRGGBB` | Accent/CTA color. `#B8501C` is the darkened accessible version **pending approval** (original `#E67A45`). Swap here only. |
| `brand.navy` | `#RRGGBB` | Primary text/heading color. |
| `logo`, `favicon` | path | Files in `content/media/`, copied to site root. |
| `preview` | bool | **true until cutover is approved.** Adds `noindex,nofollow` to every page, a red PREVIEW banner, `robots.txt Disallow: /`, and an `X-Robots-Tag` header. |
| `lead_form.enabled` | bool | **Stays false until Taylor explicitly approves.** While false, `gen.py` leaves the browser endpoint empty: preview builds log the payload with `console.info` and send nothing. A non-preview build with enabled false also blocks submit. |
| `lead_form.endpoint` | string | `/.netlify/functions/create-lead`. Used only when `enabled` is true. |
| `lead_form.endpoint_planned` | string | Same path. Documented target; not read by the build. |
| `gtm_id` | string | e.g. `GTM-WWPBQGDZ`. |
| `clickcease_id` | string | Empty until supplied. |
| `tracking` | bool | Loads GTM + ClickCease after window load. Default false. |
| `nav[]` | `{label, href}` | Header nav and footer "Company" column. |
| `footer.about` | HTML | Footer blurb. |
| `footer.company_extra[]` | `{label, href}` | Extra links after nav in footer. |
| `footer.legal[]` | `{label, href}` | Legal column. |
| `footer.copyright` | HTML | Bottom line. |
| `trust_badges[]` | HTML string | Hero trust list. |
| `hero_eyebrow` | string | Small line above every hero H1. |
| `consent` | HTML | TCPA/SMS consent text in the lead form. Legal copy: change only with sign-off. |
| `qualifier` | HTML | "Quick check" box (what we don't buy). |
| `situations[]` | `{icon, title, text}` | "Every situation" cards. |
| `steps[]` | `{n, title, text}` | 3-step process cards. |
| `comparison` | `{headers[3], rows[[label, us, market, listing]], note}` | Comparison table. |
| `testimonials[]` | `{quote, name}` | Default testimonials (quote without curly quotes). |
| `reviews[]` | `{quote, name, source, date}` | Optional static reviews for `{{reviews}}`. Leave `[]` until a real review is pasted with permission. No third-party widget. |
| `video_ids[]` | string | YouTube IDs; click-to-load thumbnails. |
| `faq[]` | `{q, a}` | Site-wide FAQ. |
| `cta` | `{heading, text, button}` | Bottom call-to-action band default. |
| `form1_fields[]` | `{name, label, type, required, step, autocomplete?, placeholder?, pair?}` | Hero form (Carrot Form 1). `type` is `text`, `tel`, or `email`. `required` is a boolean. `step` is `1` (property) or `2` (contact). Two consecutive fields may share `pair` (the first/last name row). Must include `address` (step 1) and `first`, `phone`, `email` (step 2). gclid/UTM hidden fields stay in the generator. The form stays off while `lead_form.enabled` is false. |
| `step2_fields[]` | `{name, label, type: select\|textarea, options[]}` | Step 2 form. Placeholder until the real Carrot Form 6 fields are confirmed. |

## content/pages/&lt;slug&gt;.md

YAML frontmatter, then the body.

```markdown
---
title: "FAQ | Fair & Simple Home Offer"      # required, <title>; warn if longer than 60
meta_description: "Answers about ..."        # required (may be ""); warn if longer than 155
template: basic                              # required: home | situation | basic
slug: faq                                    # optional, defaults to filename; home.md -> ""
hero_headline: "..."                         # required for home/situation
hero_sub: "..."                              # required for home/situation (HTML ok)
cta_label: "Ready to see your options?"      # optional; default heading for {{cta}} on this page
noindex: false                               # true = always noindex + left out of sitemap
sitemap: true                                # optional, false = left out of sitemap
# draft: true                                # optional; omit the line when published (never write draft: false)
# canonical: "https://fairandsimplehomeoffer.com/faq/"  # optional absolute https URL
# og_title: "FAQ"                            # optional; defaults to title
# og_image: "/logo.webp"                     # optional path or https URL; file must be in media.json
faq:                                         # optional; overrides site.json faq for {{faq}} and FAQPage JSON-LD
  - q: "Question?"
    a: "Answer."
---
<section class="wrap pad">{{faq}}</section>

{{cta}}
```

Templates:
- `home` / `situation`: hero with headline, sub, trust badges and the 2-step lead form (`id="offer"`), then the body.
- `basic`: body only (body usually starts with its own `<section class="hero sm">`).
- `market`: generated from `content/markets/*.json`, not from .md files.

Body: blocks separated by blank lines. A block starting with `<` or `{{` is passed through as HTML. Otherwise it's minimal markdown: `#`/`##` headings, `- ` bullet lists, `**bold**`, `[link](/url/)`, and paragraphs.

Shortcodes: `{{qualifier}}` `{{situations}}` `{{steps}}` `{{comparison}}` `{{videos}}` `{{testimonials}}` `{{reviews}}` `{{trust}}` `{{faq}}` `{{faq:5}}` (first N) `{{cta}}` `{{cta:Custom heading}}` `{{states}}` (links to every market that this build includes) `{{step2_form}}` `{{qualifier_form}}` `{{phone}}`. Unknown shortcodes fail the build.

`{{cta}}` uses this page's `cta_label` when set, otherwise `site.json` `cta.heading`. `{{cta:Custom heading}}` still wins. Market pages pass `cta_label` the same way.

`draft` (pages and markets):
- The key is exactly `draft`. The only allowed value is boolean `true`.
- Omit the key when the page is published. `--check` rejects `draft: false` and any other value.
- Preview builds include drafts: a normal `gen.py` run while `site.json` `preview` is true, and Netlify `deploy-preview`, `branch-deploy`, and `netlify dev` (`CONTEXT`).
- Live/prod builds skip drafts: `gen.py --live`, Netlify production (`CONTEXT=production`), and any run with `preview` false (Netlify preview contexts still include drafts so an editor can see them before publish).
- Drafts are `noindex` and left out of the sitemap even when the preview build emits them.
- The home page (empty slug, `content/pages/home.md`) cannot be `draft`. `--check` errors with `home page cannot be draft; the site would have no index`.

`slug: 404` is special: that page is written to `dist/404.html` (not `dist/404/index.html`), forced `noindex`, and wired as the host 404 (`dist/_redirects` ends with `/* /404.html 404`, plus Apache `ErrorDocument` and nginx `error_page`).

Open Graph / Twitter: every page emits `og:title`, `og:description`, `og:url`, `og:type`, `og:site_name`, `twitter:card`, `twitter:title`, and `twitter:description`. `og_title` defaults to `title`. `og_image` is emitted only when set (absolute URL, or a root path such as `/logo.webp`). `twitter:card` is `summary_large_image` when an image is set, otherwise `summary`.

FAQPage JSON-LD is emitted next to the sitewide RealEstateAgent block when the page has its own `faq` items, or when the body renders `{{faq}}` / `{{faq:N}}` and falls back to `site.json` `faq`. A capped shortcode (`{{faq:5}}` with no unlimited `{{faq}}` on the same page) limits the schema to those items. Text is JSON-escaped.

## content/markets/&lt;slug&gt;.json

```json
{
  "state": "Ohio",
  "slug": "sell-your-house-fast-in-ohio",
  "title": "Sell Your House Fast in Ohio | Fair & Simple Home Offer",
  "meta_description": "...",
  "headline": "Sell your Ohio house fast, as-is, for a fair price.",
  "hero_sub": "...",
  "cta_label": "Get your Ohio cash offer",
  "cities": [],
  "local_note": "",
  "testimonials": [],
  "noindex": false
}
```

Required: `state, slug, title, meta_description, headline, hero_sub`. `cities` (strings) renders a "Cities we buy in" line when non-empty. `local_note` (HTML) replaces the placeholder box. `testimonials` (`{quote,name}`) replaces the site default when non-empty. Market order on /service-areas/ = filename order. Optional `draft: true` follows the same rule as pages (omit the key when the state page is published; never write `draft: false`). Optional `canonical` (absolute https URL), `og_title`, and `og_image` work the same as page frontmatter.

## content/redirects.json

`[{"from": "/old-path/", "to": "/new-path/", "code": 301}]`. Both paths start with `/`. Each produces a forced Netlify rule (with and without trailing slash), Apache/nginx copies, and a noindex meta-refresh stub. `--check` rejects a redirect whose `from` is a live page.

## content/media/media.json

Array of objects. One row per content image:

```json
[
  { "file": "logo.webp", "alt": "Fair & Simple Home Offer", "width": 320, "height": 122 }
]
```

- `file` is the basename under `content/media/`. WebP only, under 200 KB. No folders.
- `width` and `height` are the image's pixel size (positive integers). The generator writes those attributes on `<img>` tags for that file. Header/footer CSS still controls how big the logo looks.
- `alt` is required for a clean check. A missing or blank `alt` prints `WARN` and does not fail `--check`. The header logo uses this alt. A footer or other tag that already has `alt=""` keeps it.
- A WebP referenced by `site.json` `logo`, an `<img src>`, or `og_image` with no row is an `ERROR`. `favicon.png` is the only image that is not a media.json row.
- A WebP sitting in the folder with no row prints `WARN`.
- `media.json` is editor data. It is not copied to `dist/`.

## Validation (`--check`)

Fails (`ERROR`, exit 1) on: missing required fields, bad template, bad slug characters, duplicate slugs across pages and markets, bad colors/phone, malformed FAQ/testimonials/reviews/form1 fields, `draft` other than `true`, `draft` on the home page, a bad `canonical`, bad redirects, images over 200 KB or not .webp (except `favicon.png`), a media.json row that is not a real WebP, and a referenced image with no media.json row.

Warns (`WARN`, exit 0) on: `title` longer than 60 characters, `meta_description` longer than 155, a duplicate `title`, a media.json row with no alt, and a WebP that is not listed in media.json.

## Qualifier form: `content/forms/qualifier.json` (EMOTA, version 3)

This is the lead qualifier on `/step-2/` (shortcode `{{qualifier_form}}`). It is graded on Taylor's **EMOTA** framework: **E**quity, **M**otivation, **O**wnership, **T**imeframe, **A**bility. A lead is **Hot only if all 5 pass**. Hot is the only result that fires a Google Ads conversion (`qualified_lead`).

1. The hero form on every landing page collects the address and name / phone / email. It builds a **partial lead** (`stage: "partial"`, `lead_id`) and goes to `/step-2/`. That partial payload is not written to the CRM (there is no update call, so writing it would block the EMOTA answers). The CRM write, when routing is actually allowed, is the complete qualifier submit.
2. A property gate comes first. Condo, townhouse, mobile/manufactured home and vacant land go to `not_fit`, the lead is saved and tagged, and no conversion fires. (Townhouse declined: confirmed by Taylor.)
3. Then one one-tap question per letter, in the order O, T, M, E, A. Letters are internal and never shown to sellers.
4. `@score` grades the letters. All pass gives Hot (`speed-to-lead`, `qualified_lead`). Any fail gives Nurture (`60day`, **no conversion**) with tags `emota-fail-<L>` for each failed letter, plus `emota-4of5` when exactly one letter failed (the old "Warm", now a tag only). Every outcome is still sent to the CRM.

`build/qualifier.js` (about 2.7 KB, budget 3.5 KB) and the JSON are inlined into `/step-2/` only.

| Key | Meaning |
|---|---|
| `id`, `version` | Sent as `form` / `form_version`. Bump `version` when questions change. |
| `start` | First question id. |
| `categories` | `{"property": ..., "E": "Equity", "M": ..., "O": ..., "T": ..., "A": ...}`. `property` is a gate and isn't graded. |
| `questions[]` | `{id, category, label, options[]}`. `category` is required and must be a key of `categories`. |
| `options[]` | `{label, value, pass, tag?, next}`. `pass` is `true`/`false` for the question's own letter, or an object such as `{"M": false}` / `{"M": true, "T": true}` for an answer that counts toward several letters. A letter passes only if **every** graded answer in it passed. Gate answers have no `pass`. `next` is a question id, `@score`, or `@end:<ending>`. |
| `result.all_pass` | `{tier, ending, cadence}`. Hot. |
| `result.any_fail` | `{tier, ending, cadence, fail_tag, near_miss_tag}`. Nurture, 60-day. |
| `endings{}` | `{headline, body, conversion, tier?, cadence?}`. Only the all-pass ending may have a `conversion` other than `"none"`. Stop endings (`not_fit`) set their own tier/cadence. |
| `consent` | `{enabled, required, field, text}`. **Off for now.** `--check` refuses `enabled: true` while the text is a placeholder. |

### Questions and pass rules (version 3: 6 one-tap questions after contact info)

Order (Taylor): property type > Ownership > Timeline > Motivation > Equity > Ability.

| # | Letter | Question (`id`) | Pass | Fail |
|---|---|---|---|---|
| 1 | Gate | What kind of property is it? (`type`) | Single-family, multi-family 2-4 | Condo, townhouse, mobile/manufactured, vacant land: `not_fit` |
| 2 | O | Are you the owner, or can you make the decision to sell? (`ownership`) | Only owner; all owners agree; heir/executor/POA | No, or not everyone agrees |
| 3 | T | When do you need to sell? (`timeline`) | ASAP, 30 days, 30-90 days | Over 90 days, no rush |
| 4 | M | What's the main reason you're selling? (`situation`) | Behind on payments, inherited/probate, repairs/damage, tenants, life change, listed 90+ days or expired | Listed under 90 days, just curious |
| 5 | E | Roughly how much is still owed? (`equity`) | Paid off, under half, over half of value | About what it's worth or more |
| 6 | A | Anything that could hold up a sale? (`ability`) | Nothing; liens the sale covers; probate open; needs a little extra time to move | Probate not started or liens bigger than value; can't move out by closing |

Tags: `no-condo`, `no-townhouse`, `no-mobile`, `no-land`, `not-decision-maker`, `long-term`, `listed-over-90`, `listed-under-90`, `liens`, `probate-open`, `needs-extra-time`, `probate-or-liens-over`, `cant-move-out`, plus `emota-fail-<L>` and `emota-4of5`.

**`gen.py --check` rules:**
- every question has a valid category, and all 5 EMOTA letters exist
- at most one question per category (one tap per step)
- every graded answer has a valid `pass`, and gate answers have none
- `pass` objects can't be empty and must include the question's own letter
- only `@end:not_fit` may stop the form; every other result comes from `@score`
- v1 keys (`points`, `force_tier`, `tiers`) are rejected
- payload `emota` keys are always ordered E, M, O, T, A
- every path to `@score` asks all 5 letters
- only the all-pass ending carries a conversion, and nothing can `@end` straight to it
- no dead ends, loops, or unreachable questions
- `result` endings exist and have a tier and cadence
- Fair Housing word list
- consent placeholder guard
- JSON ≤ 20 KB, JS ≤ 3.5 KB

**Payload.** When `lead_form.enabled` is true it is POSTed to `lead_form.endpoint` (`/.netlify/functions/create-lead`). Until then it only goes to `console.info`. The browser posts this site payload, not the CRM body. The function maps it to `create_lead`.

The hero form, the qualifier, and the optional step-2 form include a hidden honeypot, `company_website`. Leave it blank. The function rejects a filled honeypot and does not call the CRM. There is no captcha script.

The address line should include street, city, state, and ZIP. Commas are optional (`123 Main St Akron OH 44308` is accepted). `p_address` is the seller's full line, not only the street. City, state, and ZIP are filled when they can be read. If one of those is still missing, the function returns 400 and the page shows an error instead of a success message.

```json
{"form":"qualifier","form_version":3,"stage":"complete","lead_id":"t1","first":"Pat","phone":"3305551234",
 "answers":{"type":"sfh","ownership":"sole_owner","timeline":"asap","situation":"listed_under_90","equity":"free_clear","ability":"ready"},
 "emota":{"E":true,"M":false,"O":true,"T":true,"A":true},"failed":["M"],
 "tags":["listed-under-90","emota-fail-M","emota-4of5"],"tier":"nurture","cadence":"60day","conversion":"none",
 "page":"/step-2/","ts":"...","gclid":"","utm_campaign":"","utm_term":"","utm_source":"","utm_medium":""}
```

Hard declines send `emota: null`, `failed: null`, `tier: "disqualified"`, `cadence: "none"`, `conversion: "none"`.

### Lead routing function

`netlify/functions/create-lead.js` is the only place that talks to FSHO CRM. The browser never sees the token.

`POST {FSHO_API_BASE}/rpc/create_lead` with `Authorization: Bearer <FSHO_CRM_CREATE_LEAD_TOKEN>` and `Content-Type: application/json`. The code default for `FSHO_API_BASE`, when the env var is unset, is the public base `https://ruedjugpbuagyapunytd.supabase.co/functions/v1/fsho-api`.

CRM body (the function builds this; do not post it from the browser):

| CRM arg | From the site payload |
|---|---|
| `p_address` | The seller's full address line. City/state/ZIP are not stripped out of this field. |
| `p_city`, `p_state`, `p_postal` | Parsed when present (commas optional; full state names accepted). Explicit `city` / `state` / `postal` or `zip` win. |
| `p_seller_name` | `first` + `last` |
| `p_phone`, `p_email` | Phone and email. The CRM keeps the last 10 digits of the phone. |
| `p_campaign_id` | Env `FSHO_CRM_CAMPAIGN_ID` only. No default uuid in the repo. Sentinel has named the live In House PPC campaign; set that uuid in Netlify, not here. |
| `p_source_key` | Env `FSHO_CRM_SOURCE_KEY` only. No default in the repo. |
| `p_assigned_to` | Explicit JSON `null` on every `create_lead` call. The key is never omitted. `FSHO_CRM_ASSIGNED_TO`, if set to anything, is invalid and the CRM is not called. There is no default rep. |
| `p_motivation` | Compact JSON: `lead_id`, `stage`, `form_version`, EMOTA (`emota`, `failed`, `tags`, `answers`), `tier`, `cadence`, `conversion`, `gclid`, UTM, `page`. The CRM has no columns for these, and this token cannot write activity notes. |
| `p_consent_text` | `consent_text`, when present |
| `p_consent_url` | `consent_url` when it is https, otherwise the canonical page when consent was given |

**This is not end-to-end routing.**

- Unassigned create is the configured mode. Sentinel reported the contract from acq-command-center (those files are not in this repo): `db/006_functions.sql` `create_lead` argument `p_assigned_to uuid` has no DEFAULT and the function inserts that argument; `db/001_core.sql` `assigned_user_id uuid` is a nullable foreign key; `supabase/functions/fsho-api/index.ts` forwards the request args to `asAccount.rpc` with no null check; `supabase/functions/lead-intake/index.ts` sets `assignedTo` to `null` on purpose ("NOBODY") and calls `create_lead` with `p_assigned_to: assignedTo`. In that schema, "Required" means the argument has no DEFAULT, not that the column is NOT NULL. This function therefore sends `"p_assigned_to": null` and does not drop the key. A configured `FSHO_CRM_ASSIGNED_TO` is **503** `lead_routing_unconfigured` with `invalid: ["FSHO_CRM_ASSIGNED_TO"]`, which is a different failure from a missing campaign or source key.
**Two-step capture.** The hero submit is `stage: "partial"`. If that phone and email are new, the function calls `create_lead` once with explicit `p_assigned_to: null` and returns a signed continuation. The qualifier is `stage: "complete"`. It calls `update_lead_details` with `{ "p_lead": "<uuid from the signature>", "p_patch": { "seller_motivation": "<full json>" } }`. Sentinel reported this from acq-command-center `db/070_lead_edit.sql`: `seller_motivation` is allowlisted and the new text replaces the old text, while the patch leaves owner and stage untouched. The replacement therefore includes EMOTA and the original gclid/UTM/page/`lead_id`, not a delta. The patch has no owner and no pipeline stage. The site does not call `claim_lead`.

The continuation is HMAC-SHA256 over the lead uuid, phone, email, attribution, and expiry. The browser cannot substitute another uuid. A bad, expired, or mismatched proof does not update anything. A partial retry of a still-valid proof does not create a second row. A phone or email that already exists, and was not just created for this signed proof, returns **409** `duplicate_existing` with no continuation.

Signing needs Netlify env `FSHO_LEAD_CONTINUATION_SECRET` (at least 16 characters). Optional `FSHO_LEAD_CONTINUATION_TTL_SECONDS` defaults to 7200 and must be from 60 to 86400. Do not commit or log the secret. If it is missing, the function returns 503 and does not call the CRM.

**Notification.** Website leads should show up in the existing acquisitions Slack chat once, the same way other lead forms do. This repo does not add a Slack token or webhook. `create_lead` may skip the side effect that the built-in intake path uses to post that chat. The partial create is the only new-lead event; the qualifier update must not send a second notice or claim the lead. How to hook the existing notifier stays with the CRM trace. Do not turn the form on until that is confirmed, or the first contact may be saved with no Slack message.
- A CRM error or a network failure is `ok: false`. The hero form stays put and shows "We couldn't save that." The qualifier shows "We couldn't save your answers." A Google Ads conversion fires only after `ok: true`.

A successful hero response is `{ "ok": true, "routed": true, "continuation": "<signed token>" }`. It does not include a bare lead uuid for the browser to send back. CRM errors are `{ "error": "..." }` with HTTP 400, 401, 403, or 500; the function relays those statuses and replaces any error text that could carry a secret.

If `FSHO_CRM_CREATE_LEAD_TOKEN`, `FSHO_CRM_CAMPAIGN_ID`, `FSHO_CRM_SOURCE_KEY`, or `FSHO_LEAD_CONTINUATION_SECRET` is missing or unusable, the function returns **503** `{ "ok": false, "routed": false, "error": "lead_routing_unconfigured", "missing": [...], "invalid": [...] }` and does not call the CRM. Names only; values are never included.

Netlify env var names (set in the Netlify UI, never in git):

| Name | Required | Notes |
|---|---|---|
| `FSHO_CRM_CREATE_LEAD_TOKEN` | yes | Bearer token. Never commit, log, or paste it. |
| `FSHO_API_BASE` | no | Overrides the public default above. https, no userinfo, no query string. |
| `FSHO_CRM_CAMPAIGN_ID` | yes | uuid. No default in git. |
| `FSHO_CRM_SOURCE_KEY` | yes | text. No default in git. |
| `FSHO_LEAD_CONTINUATION_SECRET` | yes | HMAC secret, at least 16 characters. Never commit or log it. |
| `FSHO_LEAD_CONTINUATION_TTL_SECONDS` | no | Default 7200. Allowed range 60 to 86400. |
| `FSHO_CRM_ASSIGNED_TO` | no | Do not set. Any value is invalid and blocks the CRM call. |

`lead_form.enabled` stays **false** and `preview` stays **true** until Taylor explicitly approves turning the form on. Setting the campaign uuid and source key in Netlify does not by itself publish the form. While the form is off, the browser does not call this function.

**Editor notes (Website tab):**
- Questions are grouped under E / M / O / T / A headers, plus the property gate.
- Each answer row has a Pass/Fail toggle, with an "also counts for" letter picker for multi-letter answers.
- Each answer has a "goes to" dropdown: a question, `@score`, or `@end:*`.
- Result settings: Hot / Nurture cadence and tags.
- Endings, where conversion can be set only on Hot.
- Consent toggle.
- A flow preview with lines coloured by letter.
- A test mode that shows the EMOTA grid and the payload.
- Always run `gen.py --check` before saving.
