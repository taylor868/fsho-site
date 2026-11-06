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
| `lead_form.enabled` | bool | false = submit is blocked client-side, nothing is sent. Stays false on this branch. The create-lead function is on `cursor/carrot-lead-routing-f5f7`, awaiting verified CRM mapping (campaign, assignee, source). |
| `lead_form.endpoint` | string | Serverless endpoint URL (only used when enabled). |
| `gtm_id` | string | e.g. `GTM-WWPBQGDZ`. |
| `clickcease_id` | string | Empty until supplied. |
| `tracking` | bool | Loads GTM + ClickCease after window load. Default false. |
| `nav[]` | `{label, href}` | Header nav and footer "Company" column. |
| `footer.about` | HTML | Footer blurb. |
| `footer.company_extra[]` | `{label, href}` | Extra links after nav in footer. |
| `footer.legal[]` | `{label, href}` | Legal column. |
| `footer.copyright` | HTML | Bottom line. |
| `trust_badges[]` | HTML string, or `{text, href?, label?}` | Hero trust list, also `{{trust}}`. A string is plain text (family-owned, no fees). An object with `href` (https only) is the whole badge as one link: `target="_blank"` and `rel="noopener noreferrer"`. `label` is the accessible name; the generator adds “opens in a new tab” when that phrase is not already there. `text` is HTML. |
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

Fails (`ERROR`, exit 1) on: missing required fields, bad template, bad slug characters, duplicate slugs across pages and markets, bad colors/phone, malformed FAQ/testimonials/reviews/trust badges/form1 fields, a trust badge `href` that is not an https URL, `draft` other than `true`, `draft` on the home page, a bad `canonical`, bad redirects, images over 200 KB or not .webp (except `favicon.png`), a media.json row that is not a real WebP, and a referenced image with no media.json row.

Warns (`WARN`, exit 0) on: `title` longer than 60 characters, `meta_description` longer than 155, a duplicate `title`, a media.json row with no alt, and a WebP that is not listed in media.json.

## Qualifier form: `content/forms/qualifier.json` (EMOTA, version 3)

This is the lead qualifier on `/step-2/` (shortcode `{{qualifier_form}}`). It is graded on Taylor's **EMOTA** framework: **E**quity, **M**otivation, **O**wnership, **T**imeframe, **A**bility. A lead is **Hot only if all 5 pass**. Hot is the only result that fires a Google Ads conversion (`qualified_lead`).

1. The hero form on every landing page collects the address and name / phone / email. It sends a **partial lead** (`stage: "partial"`, `lead_id`) and goes to `/step-2/`.
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

**Payload.** It is POSTed to `site.json` `lead_form.endpoint` (FSHO CRM `create_lead`) when `lead_form.enabled`; until then it only goes to `console.info`. The CRM should upsert on `lead_id`.

```json
{"form":"qualifier","form_version":3,"stage":"complete","lead_id":"t1","first":"Pat","phone":"3305551234",
 "answers":{"type":"sfh","ownership":"sole_owner","timeline":"asap","situation":"listed_under_90","equity":"free_clear","ability":"ready"},
 "emota":{"E":true,"M":false,"O":true,"T":true,"A":true},"failed":["M"],
 "tags":["listed-under-90","emota-fail-M","emota-4of5"],"tier":"nurture","cadence":"60day","conversion":"none",
 "page":"/step-2/","ts":"...","gclid":"","utm_campaign":"","utm_term":"","utm_source":"","utm_medium":""}
```

Hard declines send `emota: null`, `failed: null`, `tier: "disqualified"`, `cadence: "none"`, `conversion: "none"`.

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
