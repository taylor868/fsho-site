# Carrot → fsho-site parity checklist

Sources: `/workspace/fsho/audit.md` (live-site audit) and the Carrot site-manager inventory (Form 1 main = 1,723 entries, Form 6 Step 2 = 651 entries, other forms unused; leads → Twilio SMS + Carrot CRM, 1,080 leads mostly Google Ads "HotMarkets"; GA4/GTM fields in Carrot settings empty; no call tracking configured; dashboard shows no active subscription; account edits 2 sites: FSHO and Motivated House Sellers).

Status key:
- **Covered**: works today via `content/` + `build/gen.py`.
- **Schema**: needs a schema + gen.py change (this repo).
- **Sentinel**: lives in the Sentinel console (UI, auth, revisions via git, publish button).
- **Drop**: unused fat; not rebuilding.

| # | Carrot feature | Status | How it works here |
|---|---|---|---|
| 1 | Page builder: create/edit pages | Covered | One `content/pages/<slug>.md` per page; frontmatter + HTML/markdown body. |
| 2 | Page builder: reusable sections/blocks | Covered | Shortcodes (`{{steps}}`, `{{faq}}`, `{{cta}}`, …) backed by `site.json` blocks. |
| 3 | Page builder: drag-and-drop visual layout | Sentinel | Editor offers a fixed section palette that writes shortcodes/HTML; no free-form drag-and-drop. |
| 4 | Page templates (home/landing/basic) | Covered | `template: home \| situation \| basic`; markets via `market` JSON. |
| 5 | Hero headline/sub per page | Covered | `hero_headline`, `hero_sub` frontmatter. |
| 6 | Per-page CTA heading | Covered | `cta_label` is the default `{{cta}}` heading on that page. `{{cta:Custom}}` still overrides. Markets pass `cta_label` the same way. Falls back to `site.json` `cta.heading`. |
| 7 | Page duplication | Sentinel | "Duplicate" = copy the .md/.json with a new slug; `--check` blocks duplicate slugs. |
| 8 | Page delete / unpublish | Sentinel | Delete file + add a 301 in `redirects.json` (editor prompts for target). |
| 9 | Drafts (unpublished pages) | Covered | `draft: true` on a page or market. Omit the key when published (never `draft: false`). Preview builds and Netlify deploy-preview/branch-deploy/`netlify dev` include them; `gen.py --live`, Netlify production, and `preview: false` skip them. Drafts are noindex and left out of the sitemap. `--check` rejects `draft` on the home page (empty slug) because the site would have no index. |
| 10 | Scheduled publishing | Drop | Never used; publishing is a manual yes from Taylor. |
| 11 | Revisions / rollback | Sentinel | Every save is a git commit; rollback = revert commit + new draft deploy. |
| 12 | Blog: posts list + post pages | Schema | Live blog is empty (now 301 → /). Add `content/posts/*.md` + `template: post` + `/blog/` index only when first post exists. |
| 13 | Blog: categories/tags, authors, comments | Drop | Unused; no posts exist. |
| 14 | RSS feed | Drop | No blog content. |
| 15 | Gravity Form 1 (main lead form) | Covered | Two-step form in hero; gclid/UTM capture; locked until routing decided. |
| 16 | Gravity Form 6 (Step 2) | Covered | `step2_fields[]` in `site.json`; fields are placeholders until real Form 6 fields confirmed. |
| 17 | Other Gravity Forms (contact, etc.) | Drop | Inventory shows only Forms 1 and 6 in real use. |
| 18 | Form field editing | Covered | `form1_fields[]` in `site.json` (name, label, type, required, step) validated by `--check`. Form stays disabled until lead routing exists. |
| 19 | Form entries / lead inbox | Sentinel | Leads land in FSHO CRM; not stored in the site. |
| 20 | Lead routing: CRM | Schema | Not in this branch. `cursor/carrot-lead-routing-f5f7` maps the site payload to FSHO CRM `create_lead` and adds the honeypot. Awaiting verified CRM mapping (campaign, assignee, source). The create_lead token is not the blocker. Form stays disabled here. |
| 21 | Lead routing: SMS alert via Twilio | Sentinel | Done by the CRM/serverless side after create_lead (A2P 10DLC registration applies); not in site code. |
| 22 | TCPA/SMS consent text | Covered | `site.json consent`; legal sign-off required to change. |
| 23 | Thank-you / redirect after submit | Covered | `/step-2/` then `/thank-you/` (both noindex). |
| 24 | Spam protection (honeypot/captcha) | Schema | Add honeypot field + server-side check in the function; no captcha script. |
| 25 | Media library: upload images | Sentinel | Upload converts to WebP < 200 KB into `content/media/`; `--check` enforces. |
| 26 | Media: alt text, dimensions | Covered | `content/media/media.json` array of `{file, alt, width, height}`. `file` is a WebP basename under 200 KB. gen.py emits width/height. Missing alt warns. A referenced WebP with no row errors. `favicon.png` stays the one non-WebP exception and is not a row. |
| 27 | SEO: title tag | Covered | `title` frontmatter. `--check` warns (exit 0) when a title is longer than 60 characters or duplicated. |
| 28 | SEO: meta description | Covered | `meta_description`. `--check` warns when it is longer than 155 characters. |
| 29 | SEO: canonical | Covered | Auto from `domain` + slug. Optional `canonical` frontmatter (absolute https URL) overrides it. |
| 30 | SEO: noindex | Covered | Per-page `noindex` + global `preview`. |
| 31 | SEO: Open Graph / Twitter cards | Covered | Optional `og_image` and `og_title` (defaults to title). Head emits og: and twitter: tags. No extra scripts. |
| 32 | SEO: schema.org JSON-LD | Covered | RealEstateAgent sitewide, plus FAQPage JSON-LD when the page has `faq` items or renders `{{faq}}` and falls back to the site FAQ (capped by `{{faq:N}}`). |
| 33 | XML sitemap | Covered | `dist/sitemap.xml` from pages that are not `noindex` and not `draft`. |
| 34 | robots.txt | Covered | Preview: Disallow all; live: disallow step-2/thank-you. |
| 35 | Redirects (301) | Covered | `content/redirects.json` → forced Netlify rules + stubs. |
| 36 | Scripts: GTM | Covered | `gtm_id`, loads after window load when `tracking: true`. |
| 37 | Scripts: second GTM container (GTM-WWPZRDH) | Drop | Duplicate container; consolidate into one (confirm with Ads owner). |
| 38 | Scripts: ClickCease | Covered | `clickcease_id` (empty, ID TBD). |
| 39 | Scripts: GA4 | Covered | Via GTM (Carrot GA4 field was empty). |
| 40 | Scripts: Google Ads tag AW-16781895992 / Meta Pixel | Covered | Via GTM, not hardcoded. Needs confirmation they exist in the container. |
| 41 | Arbitrary header/footer script injection | Drop | Speed risk; changes go through GTM with approval. |
| 42 | Call tracking / dynamic number swap | Schema | Live site swaps to (910) 227-3134 via JS. Add optional `tracking_phone` swap only if approved; default (910) 636-6669. |
| 43 | Testimonials (text) | Covered | `site.json testimonials`; per-market overrides. |
| 44 | Video testimonials (YouTube) | Covered | `video_ids[]`, click-to-load thumbnails (no iframes on load). |
| 45 | Reviews widget (Google/Facebook) | Covered | Optional `reviews[]` stays static. `/reviews/` also embeds the official SoTellUs header and slider iframes (no extra third-party script). |
| 46 | FAQs | Covered | `site.json faq` + per-page `faq` override. |
| 47 | Trust badges / "As Seen On" ribbon | Covered | `trust_badges[]` link out to the Google, Facebook, and BBB profiles. Logo ribbon dropped (unsubstantiated "#1" claim also dropped). |
| 48 | Market/state pages (39) | Covered | `content/markets/<slug>.json`. |
| 49 | Duplicate "for-cash-in" + "-2" state pages | Covered | Consolidated; 301s in `redirects.json`. |
| 50 | City pages | Schema | `cities[]` renders a line now; add `content/cities/<slug>.json` + `template: city` linked from its state, only with real local content. |
| 51 | Menus / nav | Covered | `site.json nav[]`. |
| 52 | Footer | Covered | `site.json footer` (about, company_extra, legal, copyright). |
| 53 | Header phone / CTA buttons | Covered | `phone`, `tel` sitewide. |
| 54 | Brand colors | Covered | `brand.orange` / `brand.navy`; orange #B8501C pending approval. |
| 55 | Logo / favicon | Covered | `logo`, `favicon` in `content/media/`. |
| 56 | Fonts / theme picker | Drop | System fonts only (speed). |
| 57 | Popups / exit-intent / sticky bars | Covered (sticky) / Drop (popups) | Mobile sticky Call/Offer bar built in; no popups. |
| 58 | Live chat widget | Drop | Not used; heavy third-party script. |
| 59 | A/B split testing | Drop | Not used; revisit via Ads experiments if needed. |
| 60 | Legal pages (privacy, terms, SMS terms) | Covered | Verbatim old-site copy on `/privacy/`, `/terms-conditions/`, and `/text-messaging-terms/`. Website line is https://fsho.co/. Phone is (910) 636-6669. SMS help email is offer@fairandsimplehomeoffer.com. |
| 61 | 404 page | Covered | `content/pages/404.md` builds to `dist/404.html` (noindex) with a home link and a get-offer CTA. `dist/_redirects` ends with `/* /404.html 404`. |
| 62 | Multiple sites (FSHO + Motivated House Sellers) | Schema + Sentinel | Add `sites/<site>/content/` support (`gen.py --site`); Sentinel site switcher. Second site out of scope until asked. |
| 63 | User roles (owner/editor) | Sentinel | Sentinel console login/roles (Andrew = editor, Taylor = publisher). |
| 64 | Publish to live | Sentinel | Branch → PR → draft deploy → Taylor's explicit yes → prod. |
| 65 | Custom domain / SSL / DNS | Sentinel (later) | Netlify handles SSL; DNS cutover from Carrot only with Taylor's yes. |
| 66 | Site analytics dashboard (Carrot stats) | Drop | Use GA4/Ads; Sentinel can show Lighthouse + lead counts. |
| 67 | Email notifications to owner on lead | Sentinel | CRM-side notification, alongside Twilio SMS. |
| 68 | Carrot CRM / lead pipeline | Drop | Replaced by FSHO CRM. |
| 69 | Carrot content/marketing extras (Content Pro, SEO reports) | Drop | Unused; no subscription active. |
| 70 | Speed/caching/CDN | Covered | Static files on Netlify CDN; Lighthouse 100 perf. |

## Counts

- Covered by content/ now: 41 (incl. #57 sticky bar)
- Needs schema + gen.py change: 6 (incl. #62, shared with Sentinel)
- Sentinel-side: 12 (incl. #62)
- Drop (unused fat): 13 (incl. #57 popups)

(70 features; #57 and #62 are split across two statuses.)

## Prioritized schema / gen.py changes

Done (preview is off; the homepage two-stage form posts through intake-producer when FSHO_USE_REAL_ADAPTER is 1):

2. **Drafts** (#9): `draft: true`, skipped in live/prod builds, included in preview builds. Home page cannot be draft.
3. **SEO length checks + OG tags** (#27, #28, #31): warnings for title > 60 / meta > 155 and duplicate titles; `og_image` / `og_title`.
4. **FAQPage JSON-LD** (#32) from each page's FAQ (or the site FAQ when that page renders it).
5. **Media manifest** (#26): `content/media/media.json` with alt/width/height. gen.py emits width/height. Upload-to-WebP stays a Sentinel step.
6. **404 page** (#61): `dist/404.html`.
7. **Form 1 fields in schema** (#18). Real Form 6 fields (#16) still wait until confirmed.
8. **Static reviews** (#45): `reviews[]` + `{{reviews}}`. No quotes invented.
9. **Per-page CTA wiring** (#6) and optional `canonical` override (#29).

Still open:

1. **Lead routing** (#20, #24): on `cursor/carrot-lead-routing-f5f7`, not this branch. Awaiting verified CRM mapping (campaign, assignee, source). Do not treat the create_lead token as missing, and do not invent mapping values here.
10. **City pages** (#50), only with real local content.
11. **Call-tracking number swap** (#42), only if approved.
12. **Blog** (#12), only when the first post exists.
13. **Multi-site** (#62), only when Motivated House Sellers is requested.
