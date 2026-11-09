# Test mode

The public form stays off (`preview` true, `lead_form.enabled` false, empty endpoint). This page is a separate click-through at `/test-intake/?test=1`.

Test mode is on only when the build context is `local`, `dev`, `deploy-preview`, or `branch-deploy`, and the URL has `?test=1`. A production build (`CONTEXT=production` or `gen.py --live`) bakes `production`, and `?test=1` does not turn it on.

The test page does not call Supabase, intake-reserve, Zapier, WhatConverts, CRM, or Slack. The mock adapter only records. It never calls fetch. The address field is a plain text input. There is no Google Maps or Places autocomplete.

## Stage 1 and the two qualifying questions

Stage 1 parks name, address, phone, and email. That records a staged-table insert and does not create a CRM lead, load a Google tag, or fire a conversion. Leaving after that stays parked. No sweep, no disqualified event.

Q1 and Q2 use the live qualifier values: `sfh`, `townhouse`, `multi_2_4`, `condo`, `mobile`, `land`, and ownership `sole_owner`, `all_agree`, `decision_maker`, `no`.

Only `sfh` and `multi_2_4` continue to ownership. Townhouse, condo, mobile, land, and any other listed Q1 value show the sorry screen and stay on the quiet path (`pg_cron` self-serve sweep). No Google tag and no conversion. Those exits push `seller_form_disqualified` with reason `quiet_property` and the property type.

Taylor decided townhouses take that quiet path. `townhouse_route` defaults to `quiet`. Setting it to `hot` is the only switch that lets a townhouse continue to the dry-run tag. It is not the current decision, and it still does not emit `seller_form_completed`, because a townhouse is not the Hot conversion path.

The quiet screen reuses the live qualifier `not_fit` ending, not new copy:

- Headline: “Thanks for the details.”
- Body: “This one may not be a fit for us right now, but we saved your info and will reach out if anything changes.”

Flagged for Taylor: this is the existing qualifier ending. It says “may not be a fit” and mentions a later reach-out. Confirm that is the line he wants, or replace it.

Q1 single-family or multi-family waits for Q2. The tag is still not loaded. An owner answer (`sole_owner`, `all_agree`, or `decision_maker`) is the form fill: the dry-run records the tag, then the expected path is the Zap Hot path (WhatConverts, CRM, Slack).

Q2 `no` (not an owner, or not everyone agrees) on a hot property type is logged as CRM follow-up. No tag and no conversion. The exit event is `seller_form_disqualified` with reason `not_owner`.

## Click ids, lead id, and tags

Attribution is config-driven on `TRACKING` in `build/two-stage.js`. On the first request that carries any of them, the page stores `gclid`, `gbraid`, `wbraid`, `fbclid`, `utm_source`, `utm_medium`, `utm_campaign`, `utm_term`, and `utm_content` in `localStorage` under `fsho_ts_attr`. A later click does not overwrite that first touch. Every stage payload includes those fields (empty string when absent).

`lead_id` is created with `crypto.randomUUID()` once per browser session and kept in `sessionStorage` under `fsho_ts_lead`. The same id is sent on every stage of that session. A new session gets a new id.

The GTM container id is still undecided. The test-form config value is the placeholder `GTM-PLACEHOLDER`. GA4 is off. The Meta pixel is off. Tags are lazy: nothing is requested at page load, and the only marker is the existing dry-run JSON script, inserted after `owner = yes`. The test form does not load the site container.

## Conversion

`seller_form_completed` is pushed to `dataLayer` exactly once, and only when the property type is `sfh` or `multi_2_4` and the ownership answer is an owner. `transaction_id` is the `lead_id`, so a second Hot completion in the same session does not push again.

It does not fire on stage 1, abandon, a quiet or sorry property type, a non-owner, nurture, or DQ. Those exits (quiet property, non-owner, nurture, DQ) push `seller_form_disqualified` with a reason code: `quiet_property`, `not_owner`, `nurture`, or `dq`. Abandon stays parked and pushes neither event.

`dataLayer` payloads are limited to `event`, `transaction_id`, `reason`, and `property_type`. Name, address, phone, and email never go on the data layer.

## Enrichment and priority

Enrichment starts only after the Hot decision, after the conversion has already fired. It never gates the conversion and never disqualifies. Each screen is one tap and can be skipped. Skip is a full-width button labeled “Skip”.

Order:

1. Occupancy: `owner`, `tenant`, `vacant`
2. Condition: `move_in`, `wear`, `repairs`, `major`
3. Asking price vs estimated value: `under_80` (under 80%), `band_80_100` (80% to 100%), `over_100` (over 100%), `not_sure`
4. Listed with an agent: `yes` or `no`. A listed home stays Hot.
5. Timeline: `asap`, `30d`, `over_90d`, `no_rush`

Priority is `high` when occupancy is `vacant` or the price band is `under_80`. Every other combination, including a skip, is `standard`. The tier is stored on the enrich and thanks payloads for that same `lead_id`. The branch stays `zap_hot`.

The thank-you screen is the end of the optional questions. Headline: “Thanks. We have your info.”

## Payload fields

Every stage includes:

- `lead_id`
- `stage` (`contact`, `property_type`, `ownership`, `enrich`, `thanks`, `abandoned`)
- `gclid`, `gbraid`, `wbraid`, `fbclid`
- `utm_source`, `utm_medium`, `utm_campaign`, `utm_term`, `utm_content`

Stage 1 is the park row and also includes `name`, `address`, `phone`, `email`, and `status` (`parked`). The park record is not a CRM create. Later stage rows are mock `stage` operations.

Property type adds `property_type`. A quiet type also adds `signal` `seller_form_disqualified` and `reason` `quiet_property`.

Ownership adds `ownership`. Hot adds `signal` `seller_form_completed` when the conversion rule matches. A non-owner adds `signal` `seller_form_disqualified` and `reason` `not_owner`.

Each enrich row adds `question`, `answer` (empty when skipped), `skipped`, and `priority`.

The thanks row adds `priority` plus `occupancy`, `condition`, `price_vs_value`, `listed`, and `timeline`.

## Copy check

`build/test_form_guard.json` is the phrase list. `gen.py --check` fails if the test form (`build/two-stage.js`, `content/pages/test-intake.md`, or the test-intake markup in `gen.py`) contains a closing-day count such as “close in 7 days”, a “by hand” or “person-reviewed” claim, or a Facebook star-rating claim. The check does not scan the rest of the site.

The built test page stays under 100KB transferred and under 10 requests. CSS and the test script are inlined. The usual subresources are the favicon and the logo.
