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
