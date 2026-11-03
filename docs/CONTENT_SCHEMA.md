# FSHO content schema

Everything an editor can change lives under `content/`. The build (`python3 build/gen.py`) never needs code edits for copy, pages, markets, redirects, colors, or tracking IDs. Always run `python3 build/gen.py --check` before committing; it exits non-zero and prints `ERROR <file>: <problem>` lines the editor UI can show verbatim.

HTML is allowed (and expected) in text fields; values are inserted as-is, so use `&amp;` for a literal `&` inside HTML-rendered fields. Page `title` is raw text.

```
content/
  site.json            global settings + shared blocks
  pages/<slug>.md      one file per page (home.md = "/")
  markets/<slug>.json  one file per state landing page
  redirects.json       301s
  media/               images (.webp, each < 200 KB; favicon.png allowed)
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
| `lead_form.enabled` | bool | false = submit is blocked client-side, nothing is sent. Stays false until lead routing is decided. |
| `lead_form.endpoint` | string | Serverless endpoint URL (only used when enabled). |
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
| `video_ids[]` | string | YouTube IDs; click-to-load thumbnails. |
| `faq[]` | `{q, a}` | Site-wide FAQ. |
| `cta` | `{heading, text, button}` | Bottom call-to-action band default. |
| `step2_fields[]` | `{name, label, type: select\|textarea, options[]}` | Step 2 form. Placeholder until the real Carrot Form 6 fields are confirmed. |

## content/pages/&lt;slug&gt;.md

YAML frontmatter, then the body.

```markdown
---
title: "FAQ | Fair & Simple Home Offer"      # required, <title>
meta_description: "Answers about ..."        # required (may be "")
template: basic                              # required: home | situation | basic
slug: faq                                    # optional, defaults to filename; home.md -> ""
hero_headline: "..."                         # required for home/situation
hero_sub: "..."                              # required for home/situation (HTML ok)
cta_label: "Ready to see your options?"      # optional, informational
noindex: false                               # true = always noindex + left out of sitemap
sitemap: true                                # optional, false = left out of sitemap
faq:                                         # optional; overrides site.json faq for {{faq}} on this page
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

Shortcodes: `{{qualifier}}` `{{situations}}` `{{steps}}` `{{comparison}}` `{{videos}}` `{{testimonials}}` `{{trust}}` `{{faq}}` `{{faq:5}}` (first N) `{{cta}}` `{{cta:Custom heading}}` `{{states}}` (links to every market) `{{step2_form}}` `{{phone}}`. Unknown shortcodes fail the build.

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

Required: `state, slug, title, meta_description, headline, hero_sub`. `cities` (strings) renders a "Cities we buy in" line when non-empty. `local_note` (HTML) replaces the placeholder box. `testimonials` (`{quote,name}`) replaces the site default when non-empty. Market order on /service-areas/ = filename order.

## content/redirects.json

`[{"from": "/old-path/", "to": "/new-path/", "code": 301}]`. Both paths start with `/`. Each produces a forced Netlify rule (with and without trailing slash), Apache/nginx copies, and a noindex meta-refresh stub. `--check` rejects a redirect whose `from` is a live page.

## Validation (`--check`)

Fails on: missing required fields, bad template, bad slug characters, duplicate slugs across pages and markets, bad colors/phone, malformed FAQ/testimonials, bad redirects, images over 200 KB or not .webp.

## Qualifier form: `content/forms/qualifier.json` (EMOTA, version 2)

This is the lead qualifier on `/step-2/` (shortcode `{{qualifier_form}}`). It is graded on Taylor's **EMOTA** framework: **E**quity, **M**otivation, **O**wnership, **T**imeframe, **A**bility. A lead is **Hot only if all 5 pass**. Hot is the only result that fires a Google Ads conversion (`qualified_lead`).

1. The hero form on every landing page collects the address and name / phone / email. It sends a **partial lead** (`stage: "partial"`, `lead_id`) and goes to `/step-2/`.
2. A property gate comes first. Condo, townhouse, mobile/manufactured home and vacant land go to `not_fit`, the lead is saved and tagged, and no conversion fires. (Townhouse is declined pending Taylor's confirmation.)
3. Then 1-2 one-tap questions per letter follow. Letters are internal and never shown to sellers.
4. `@score` grades the letters. All pass gives Hot (`speed-to-lead`, `qualified_lead`). Any fail gives Nurture (`60day`, **no conversion**) with tags `emota-fail-<L>` for each failed letter, plus `emota-4of5` when exactly one letter failed (the old "Warm", now a tag only). Every outcome is still sent to the CRM.

`build/qualifier.js` (about 2.7 KB, budget 3.5 KB) and the JSON are inlined into `/step-2/` only.

| Key | Meaning |
|---|---|
| `id`, `version` | Sent as `form` / `form_version`. Bump `version` when questions change. |
| `start` | First question id. |
| `categories` | `{"property": ..., "E": "Equity", "M": ..., "O": ..., "T": ..., "A": ...}`. `property` is a gate and isn't graded. |
| `questions[]` | `{id, category, label, options[]}`. `category` is required and must be a key of `categories`. |
| `options[]` | `{label, value, pass, tag?, next}`. `pass` is `true`/`false` for the question's own letter, or an object such as `{"M": false}` / `{"M": true, "T": true}` for an answer that counts toward several letters. A letter passes only if **every** graded answer in it passed. Gate answers have no `pass`. An answer can skip `pass` only if it leads to another question of the same letter (e.g. "Yes, it's listed" leads to "How long?"). `next` is a question id, `@score`, or `@end:<ending>`. |
| `result.all_pass` | `{tier, ending, cadence}`. Hot. |
| `result.any_fail` | `{tier, ending, cadence, fail_tag, near_miss_tag}`. Nurture, 60-day. |
| `endings{}` | `{headline, body, conversion, tier?, cadence?}`. Only the all-pass ending may have a `conversion` other than `"none"`. Stop endings (`not_fit`) set their own tier/cadence. |
| `consent` | `{enabled, required, field, text}`. **Off for now.** `--check` refuses `enabled: true` while the text is a placeholder. |

### Questions and pass rules

| Letter | Question | Pass | Fail |
|---|---|---|---|
| Gate | Property type | Single-family, multi-family 2-4 | Condo, townhouse, mobile/manufactured, vacant land: `not_fit` |
| M (+T) | Listed with an agent? | Not listed, expired | (Listed: asks how long) |
| M | How long listed? | 90 days or more | Under 90 days |
| E | How much is owed? | Paid off, under half, over half of value | About what it's worth or more |
| M | Main reason for selling | Probate, behind on payments, code violations, damage, tenants, repairs, life change | Something else / just curious |
| O | On title or legal decision-maker? | On title; executor/POA/heir | No |
| O | Everyone on title on board? | Yes / only owner | No, not sure |
| T | When do you need to sell? | ASAP, 30 days, 30-90 days | Over 90 days, no rush |
| A | Anything that could hold up a sale? | Nothing; liens the sale covers; probate open; not sure (tag `check-title`) | Liens bigger than the value; probate not started |
| A | Moved out by closing? | Yes / empty; yes with extra time (tag `needs-extra-time`) | No |

**`gen.py --check` rules:**
- every question has a valid category, and all 5 EMOTA letters exist
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
{"form":"qualifier","form_version":2,"stage":"complete","lead_id":"t1","first":"Pat","phone":"3305551234",
 "answers":{"type":"sfh","listed":"listed","listed_days":"under_90","equity":"free_clear","situation":"behind","title":"owner","owners_agree":"yes","timeline":"asap","issues":"none","move_out":"yes"},
 "emota":{"M":false,"E":true,"O":true,"T":true,"A":true},"failed":["M"],
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
