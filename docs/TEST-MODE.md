# Test mode

The public form stays off (`preview` true, `lead_form.enabled` false, empty endpoint). This page is a separate click-through at `/test-intake/?test=1`.

Test mode is on only when the build context is `local`, `dev`, `deploy-preview`, or `branch-deploy`, and the URL has `?test=1`. A production build (`CONTEXT=production` or `gen.py --live`) bakes `production`, and `?test=1` does not turn it on.

The test page does not call Supabase, Zapier, WhatConverts, CRM, or Slack. The mock adapter is the default and only records. The address field is a plain text input. There is no Google Maps or Places autocomplete. The page script has no network call of its own. A real adapter exists beside the mock and is used only when `adapter` is `"real"`, the build context is non-production, and the caller passes a transport. Its base URL is the placeholder `https://placeholder.invalid/functions/v1`. There is no HMAC key and no Zap token in the source. `sig` is left empty because the Netlify function that holds the key signs the envelope.

## Stage 1 and the two qualifying questions

Stage 1 parks name, address, phone, and email. That records a staged-table insert and does not create a CRM lead, load a Google tag, or fire a conversion. Leaving after that stays parked. No sweep, no disqualified event.

Q1 and Q2 use the live qualifier values: `sfh`, `townhouse`, `multi_2_4`, `condo`, `mobile`, `land`, and ownership `sole_owner`, `all_agree`, `decision_maker`, `no`.

Only `sfh` and `multi_2_4` continue to ownership. Townhouse, condo, mobile, land, and any other listed Q1 value show the sorry screen and stay on the quiet path (`pg_cron` self-serve sweep). No Google tag and no conversion. Those exits push `seller_form_disqualified` with reason `quiet_property` and the property type.

Taylor decided townhouses take that quiet path. `townhouse_route` defaults to `quiet`. Setting it to `hot` is the only switch that lets a townhouse continue to the dry-run tag. It is not the current decision, and it still does not emit `seller_form_completed`, because a townhouse is not the Hot conversion path.

The quiet screen reuses the live qualifier `not_fit` ending, not new copy:

- Headline: “Thanks for the details.”
- Body: “This one may not be a fit for us right now, but we saved your info and will reach out if anything changes.”

Flagged for Taylor: this is the existing qualifier ending. It says “may not be a fit” and mentions a later reach-out. Confirm that is the line he wants, or replace it.

Q1 single-family or multi-family waits for Q2. The tag is still not loaded. The client uses the answers only to choose the next screen. After Q2 it sends the raw ownership answer and calls claim. The claim response decides:

- `tier: "hot"` is the form fill. The dry-run records the tag, then the expected path is the Zap Hot path (WhatConverts, CRM, Slack). The real adapter then builds reserve.
- `tier: "follow_up"` is CRM follow-up. No tag and no conversion. The exit event is `seller_form_disqualified` with reason `not_owner`.
- `already_claimed` stops. No reserve and no Zap.
- `not_qualified` or `not_non_owner` follows the server. The test trace logs the disagreement when that tier differs from the screen the client was about to show.

The mock claim agrees with the requested `by`, so the dry-run still matches the screen hint. A townhouse only continues when `townhouse_route` is `hot`, and that switch still does not emit `seller_form_completed`.

## Click ids, lead id, and tags

Attribution is config-driven on `TRACKING` in `build/two-stage.js`. The page stores `gclid`, `gbraid`, `wbraid`, `fbclid`, `utm_source`, `utm_medium`, `utm_campaign`, `utm_term`, `utm_content`, and `utm_id` in `localStorage` under `fsho_ts_attr`. Each field is write-once: a stored value is never replaced, and a field that is still empty can be filled later. Every stage payload includes the stored fields.

`lead_id` is created with `crypto.randomUUID()` once per browser session and kept in `sessionStorage` under `fsho_ts_lead`. A value already in that key is kept. The same id is sent on every stage. The real adapter also refuses to overwrite a click id, UTM, or lead id it has already sent.

The GTM container id is still undecided. The test-form config value is the placeholder `GTM-PLACEHOLDER`. GA4 is off. The Meta pixel is off. Tags are lazy: nothing is requested at page load, and the only marker is the existing dry-run JSON script, inserted after `owner = yes`. The test form does not load the site container.

## Conversion

`seller_form_completed` is pushed to `dataLayer` exactly once, and only when the property type is `sfh` or `multi_2_4` and the ownership answer is an owner. `transaction_id` is the `lead_id`, so a second Hot completion in the same session does not push again.

It does not fire on stage 1, abandon, a quiet or sorry property type, a non-owner, nurture, or DQ. Those exits (quiet property, non-owner, nurture, DQ) push `seller_form_disqualified` with a reason code: `quiet_property`, `not_owner`, `nurture`, or `dq`. Abandon stays parked and pushes neither event.

`dataLayer` payloads are limited to `event`, `transaction_id`, `reason`, and `property_type`. Name, address, phone, and email never go on the data layer.

## Enrichment and priority

Enrichment starts only after the claim response says Hot, after the conversion has already fired. It never gates the conversion and never disqualifies. Each screen is one tap and can be skipped. Skip is a full-width button labeled “Skip”. Answers are raw values. `/answer` is not used for these, because enrichment on that route is a 400. They go on complete.

Order and wire values. The counter reads “Optional N of 4”. There is no asking-price question.

1. Occupancy: `owner_occupied`, `tenant_occupied`, `vacant`, `unknown`
2. Condition: `excellent`, `good`, `fair`, `needs_work`, `major_repairs`
3. Listed with an agent: `not_listed`, `listed_under_90`, `listed_over_90`, `expired`. A listed home stays on the Hot screen unless the claim response says otherwise.
4. Timeline: `asap`, `30d`, `30_90d`, `over_90d`, `no_rush`

`priority_tier` is server-set (`p1`, `p2`, or `p3`) on Hot rows. The client does not send it, and no payload includes `price_vs_value`. The mock complete response sets the tier from the answers it did receive. `p1` is a vacant home, or an `asap` / `30d` timeline together with condition `needs_work` or `major_repairs`, or listed `expired` or `listed_over_90`. `p2` is any other timeline within 90 days (`asap`, `30d`, or `30_90d`). Everything else is `p3`. The test trace shows that value.

The thank-you screen is the end of the optional questions. Headline: “Thanks. We have your info.”

## Payload fields

Every stage includes:

- `lead_id`
- `stage` (`contact`, `property_type`, `ownership`, `enrich`, `thanks`, `abandoned`)
- `gclid`, `gbraid`, `wbraid`, `fbclid`
- `utm_source`, `utm_medium`, `utm_campaign`, `utm_term`, `utm_content`
- `utm_id` when it has been captured

Stage 1 is the park row and also includes `name`, `address`, `phone`, `email`, and `status` (`parked`). The park record is not a CRM create. Later stage rows are mock `stage` operations. None of these rows carry a client priority.

Property type adds `property_type`. A quiet type also adds `signal` `seller_form_disqualified` and `reason` `quiet_property`.

Ownership adds `ownership`. Hot adds `signal` `seller_form_completed` when the conversion rule matches. A non-owner adds `signal` `seller_form_disqualified` and `reason` `not_owner`.

Each enrich row adds `question`, `answer` (empty when skipped), and `skipped`.

The thanks row adds `occupancy`, `condition`, `listed`, and `timeline`. The server tier comes back on the complete or verify response. It is not a request field. `price_vs_value` is not a field on any stage.

## Real adapter requests

All of these are `POST` with `content-type: application/json`. The placeholder base is `https://placeholder.invalid/functions/v1`. Tests inject a transport. Nothing in the suite calls the network.

| Stage | Path | Envelope stage | Body |
|---|---|---|---|
| Park | `/intake-park/park` | `partial` | `envelope`, `session_binding`, `payload` with `first_name`, `last_name` (when the name has two parts), `phone` digits, `email`, `address`, `is_test: true`, and write-once tracking |
| Answer | `/intake-park/answer` | `partial` | `envelope`, `payload.question`, `payload.answer`, tracking. No enrichment |
| Claim | `/intake-park/claim` | `partial` | `envelope`, `payload.by` of `promote` or `non_owner`, tracking |
| Reserve | `/intake-reserve/reserve` | `final` on the Hot path | `envelope`, `payload` tracking, `session_binding`, `destination: crm_create`, generated `owner_token`, `lease_seconds: 120` |
| Verify | `/intake-reserve/verify` | none | `reservation_id`, optional `intake_id` and `owner_token`. Header `x-intake-zap-token` only when the caller supplies it |
| Complete, HMAC | `/intake-reserve/complete` | `final` | `envelope`, `payload` tracking and `enrichment`, `session_binding`, `owner_token`, `reservation_id`, `reservation_generation` |
| Complete, token | `/intake-reserve/complete` | none | The token-mode body, including `enrichment` and tracking, plus the caller-supplied header |
| Reconcile, token | `/intake-reserve/reconcile` | none | `reservation_id`, `owner_token`, optional `reason`, plus the caller-supplied header |
| Reconcile, HMAC | `/intake-reserve/reconcile` | `final` | `envelope`, `payload.reason`, `session_binding`, `reservation_id`, `owner_token` |

A 400 `bad_input` response is returned as `{ok:false, http:400, status, fields}` and the field names are logged. The owner token is not written into the test trace. `payload_sha256` is the SHA-256 of the canonical payload (sorted keys, no spaces).

## Copy check

`build/test_form_guard.json` is the phrase list. `gen.py --check` fails if the test form (`build/two-stage.js`, `content/pages/test-intake.md`, or the test-intake markup in `gen.py`) contains a closing-day count such as “close in 7 days”, a “by hand” or “person-reviewed” claim, or a Facebook star-rating claim. The check does not scan the rest of the site.

The built test page stays under 100KB transferred and under 10 requests. CSS and the test script are inlined. The usual subresources are the favicon and the logo.
