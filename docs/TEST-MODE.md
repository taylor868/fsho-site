# Test mode

The homepage hero is the two-stage form. It submits through `/.netlify/functions/intake-producer` when the build env `FSHO_USE_REAL_ADAPTER` is `1`. `/test-intake/` stays `noindex` and out of the sitemap. A production build does not include a working test form. A deploy preview, branch deploy, dev, or local build still has the labeled test form at `/test-intake/?test=1`. `preview` is false, so a normal `python3 build/gen.py` build has no PREVIEW banner and is indexable. Slack and CRM TEST prefixes are unchanged.

Test mode is on when the build context is `local`, `dev`, `deploy-preview`, or `branch-deploy`, and the URL has `?test=1`. A production build (`CONTEXT=production` or `gen.py --live`) bakes `production` and does not enable `?test=1`. The homepage form does not use that query. It boots from `data-public="1"` and uses the same real-adapter flag.

The test page does not call Supabase, Zapier, WhatConverts, CRM, or Slack. The mock adapter is the default and only records. The address field is a plain text input. There is no Google Maps or Places autocomplete. The page script has no network call of its own. A real adapter exists beside the mock and is used only when `adapter` is `"real"`, the build context is non-production, and the caller passes a transport. Its base URL is the placeholder `https://placeholder.invalid/functions/v1`. There is no HMAC key and no Zap token in the source. `sig` is left empty because the Netlify function that holds the key signs the envelope.

## Stage 1 and the two qualifying questions

Stage 1 parks name, address, phone, and email. That records a staged-table insert and does not create a CRM lead, load a Google tag, or fire a conversion. Leaving after stage 1 does not fire a conversion. The sweep moves that lead to self-serve after 10 minutes, tagged timeout.

Q1 and Q2 use the live qualifier values: `sfh`, `townhouse`, `multi_2_4`, `condo`, `mobile`, `land`, and ownership `sole_owner`, `all_agree`, `decision_maker`, `no`.

Only `sfh` and `multi_2_4` continue to ownership. Townhouse, condo, mobile, land, and any other listed Q1 value show the sorry screen. No Google tag and no conversion. The sweep moves that quiet lead to self-serve after 10 minutes, tagged q1_decline. Those exits push `seller_form_disqualified` with reason `quiet_property` and the property type.

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

`CONFIG.gtm_id` and `TRACKING.gtm_id` are `GTM-TM6JSDLB`. GA4 is off. The Meta pixel is off. The container script is not in the HTML and is not requested at page load. The first `pointerdown` or `keydown` inserts one async `gtm.js` script. The dry-run Google marker is still the JSON script inserted after `owner = yes`. Site-wide tracking stays off, so the shared pages do not load this container.

## Conversion

`seller_form_completed` is pushed to `dataLayer` exactly once, and only when the property type is `sfh` or `multi_2_4` and the ownership answer is an owner. `transaction_id` is the `lead_id`, so a second Hot completion in the same session does not push again.

It does not fire on stage 1, abandon, a quiet or sorry property type, a non-owner, nurture, or DQ. Those exits (quiet property, non-owner, nurture, DQ) push `seller_form_disqualified` with a reason code: `quiet_property`, `not_owner`, `nurture`, or `dq`. Abandon pushes neither conversion event. The sweep moves an abandoned lead to self-serve after 10 minutes, tagged timeout, and a quiet property lead to self-serve after 10 minutes, tagged q1_decline.

`dataLayer` payloads are limited to `event`, `transaction_id`, `reason`, and `property_type`. Name, address, phone, and email never go on the data layer.

## Enrichment and priority

Enrichment starts only after the claim response says Hot, after the conversion has already fired. It never gates the conversion and never disqualifies. Each screen is one tap and can be skipped. Skip is a full-width button labeled “Skip”. Answers are raw values. `/answer` is not used for these, because enrichment on that route is a 400. They go on complete.

Order and wire values. The counter reads “Optional N of 4”. There is no asking-price question.

1. Occupancy: `owner_occupied`, `tenant_occupied`, `vacant`, `unknown`
2. Condition: `excellent`, `good`, `fair`, `needs_work`, `major_repairs`
3. Listed with an agent: `not_listed`, `listed_under_90`, `listed_over_90`, `expired`. A listed home stays on the Hot screen unless the claim response says otherwise.
4. Timeline: `asap`, `30d`, `30_90d`, `over_90d`, `no_rush`

`priority_tier` is server-set (`p1`, `p2`, `p3`, or `null`). The browser does not calculate it. Claim returns `null` when enrichment is not stored yet, and the trace shows that as none. After the optional screens, including when every one was skipped, the page posts `/intake-park/enrich`. A saved `priority_tier` is shown. `null` stays none. `not_hot` and a failed enrich show the thank-you with no tier. The site never sends enrichment on complete or reserve. The Zap is the only completer. The mock enrich rule is: `p1` when the home is vacant, or when the timeline is `asap` or `30d` and the condition is `needs_work` or `major_repairs` or the listing is `expired` or `listed_over_90`. `p2` is any other timeline within 90 days (`asap`, `30d`, or `30_90d`). Any other non-empty answer set is `p3`. An empty object is `null`.

The thank-you screen is the end of the optional questions. Headline: “Thanks. We have your info.” Body: “Thanks for filling out your info. Our team will reach out soon.”

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

The thanks row adds `occupancy`, `condition`, `listed`, and `timeline`. The server tier comes back on the claim and complete responses. It is not a request field.

## Real adapter requests

All of these are `POST` with `content-type: application/json`. The placeholder base is `https://placeholder.invalid/functions/v1`. Tests inject a transport. Nothing in the suite calls the network.

| Stage | Path | Envelope stage | Body |
|---|---|---|---|
| Mint | `/intake-reserve/mint` | none | `{}`. Response supplies `intake_id`, `session_binding`, and `kid`. The browser does not mint those ids |
| Park | `/intake-park/park` | `partial` | `envelope`, `session_binding`, `payload` with `full_name` (max 160), `address_line` (the single address line, max 200), digit `phone`, `email`, `consent` (boolean; unchecked is `false` and does not block submit), `is_test` (`true` only for `/test-intake/?test=1`; public forms send `false`), signer `client_ip`, and write-once tracking. No `attribution` |
| Answer | `/intake-park/answer` | `partial` | `envelope`, `payload.question`, `payload.answer`, `client_ip`, tracking. No enrichment |
| Claim | `/intake-park/claim` | `partial` | `envelope`, `payload.by` of `promote` or `non_owner`, `client_ip`, tracking. Response includes `tier` and `priority_tier` |
| Reserve | `/intake-reserve/reserve` | `first` or `final` (Hot uses `final`) | `envelope`, tracking `payload`, `session_binding`, `destination: crm_create`, generated `owner_token`, `lease_seconds: 120`. No `client_ip` |
| Verify | `/intake-reserve/verify` | none | `reservation_id`, optional `intake_id` and `owner_token`. Header `x-intake-zap-token` only when the caller supplies it |
| Enrich | `/intake-park/enrich` | `partial` | Exactly `{envelope, payload}`. `payload` is `{enrichment, client_ip, tracking}`. No `session_binding`. `enrichment` is a required object: `{occupancy?, condition?, listed?, timeline?}`, or `{}` when every question was skipped. `channel` is `website`. Idempotent, and valid before or after the Zap's complete. `200 {ok:true, status:"saved", priority_tier}` shows that tier, including `null` as none. `409 not_hot` writes nothing and shows no tier. `404 unknown_intake`. `400 bad_input {fields}`. `401` is a bad signature. `429` is the shared 30 per visitor per minute limit with park, answer, and claim. `503 enrich_unavailable` is retried once after a short backoff, then the thank-you is shown with no tier |
| Complete, HMAC | `/intake-reserve/complete` | `final` | Zap completer only. The test page does not call it. `envelope`, tracking `payload` with no `enrichment`, `session_binding`, `owner_token`, `reservation_id`, `reservation_generation`. No `client_ip` |
| Complete, token | `/intake-reserve/complete` | none | Token-mode body and the caller-supplied header. No `enrichment` |
| Reconcile, token | `/intake-reserve/reconcile` | none | `reservation_id`, `owner_token`, optional `reason` with control characters removed, plus the caller-supplied header |
| Reconcile, HMAC | `/intake-reserve/reconcile` | the reservation's own `first` or `final` | `envelope` (that reservation's `intake_id`), `payload` of `{reason}` or `{}`, `reservation_id`. No `owner_token`, `session_binding`, or `client_ip`. Response `{ok, status:"needs_reconcile", needs_reconcile:true}` |

`client_ip` is a strict IP literal with no port. The browser does not look it up. The Netlify producer reads it from the `x-nf-client-connection-ip` header and puts it inside the signed payload on park, answer, claim, and enrich. The Ads `lead_id` is still a client `crypto.randomUUID()` and is the conversion `transaction_id`.

A claim response of `status: "late_hot"` with `tier: "hot"` is a normal Hot claim. The producer rewrites it to `status: "claimed"` before the browser sees it, and the flow treats a raw `late_hot` the same way.

## Producer

`netlify/functions/intake-producer.js` is the server-side signer. The browser calls it only when `CONFIG.use_real_adapter` is true or the build env `FSHO_USE_REAL_ADAPTER` is `1`. `gen.py` bakes that flag into `window.FSHO_USE_REAL_ADAPTER`. When it is unset, the page keeps the mock. The default remains the mock, which never calls the network. The function reads `INTAKE_HMAC_KEY_V1`, `INTAKE_HMAC_KID`, `INTAKE_EDGE_BASE_URL`, and `INTAKE_ZAP_HOOK_URL` from the environment. `INTAKE_COOKIE_KEY` is optional. Those values are not hardcoded or returned.

Signatures use the fixed `canonicalLines` order from `edge/envelope.ts`: `v`, `kid`, `route`, `channel`, `intake_id`, `event_id`, `stage`, `ts`, `exp`, `payload_sha256`. The reference copies are `docs/CALL-SHAPES.md`, `edge/envelope.ts`, `edge/intake-park/handler.ts`, and `edge/intake-reserve/index.ts`.

The browser sends `{op, ...whitelisted fields}`. Park includes `is_test` and `consent`. Public forms send `is_test: false`. A production build does not serve a working `/test-intake/` form, including with `?test=1`. On a deploy preview, branch deploy, dev, or local build, `/test-intake/?test=1` sends `true`. The function forwards that boolean and treats a missing flag as `false`. Edge intake-park stores a test row only when `is_test === true`, so `false` is a real lead. A non-boolean `is_test` is `400 bad_input`. `consent` is a boolean on the park payload and the Catch Hook. Missing consent is `false`. A non-boolean `consent` is `400 bad_input`. The edge ignores that unknown park key, so it does not fail intake. The function mints when the session cookie is empty. A later park also mints when that cookie intake is already reserved (`zap_sent`) or already claimed, and parks the new contact on the new intake. A later park on an in-progress intake that has not been reserved keeps the same intake. The function signs park, answer, claim, enrich, and reserve. `session_binding` goes on park and reserve only. Answer, claim, and enrich are exactly `{envelope, payload}`. Session state, including `session_binding` and `owner_token`, stays in an opaque HttpOnly cookie. The cookie key is SHA-256 of `INTAKE_COOKIE_KEY` when that is set, otherwise HKDF-SHA256 of the signing key with info `fsho-intake-cookie-v1`. `attribution` and `price_vs_value` are rejected. Tracking is write-once. After a reserve that commits, the function POSTs the Catch Hook with `intake_id`, `reservation_id`, `reservation_generation`, `session_binding`, `owner_token`, `full_name`, `phone`, `email`, `address_line`, and `consent`. That POST is server-side only. If the hook fails, it is retried once. If it still fails, the function signs `POST /intake-reserve/reconcile` with the reservation's own stage and reason `hook_uncertain`, and logs only the reservation id. The browser gets `{ok:false, status:"needs_reconcile"}`.

Stage 1 advances only when park returns 200. Any other producer or park status stays on the contact step and the page says to try again.

Enrich `503` is retried once. `409` and `429` are not retried. A second enrich `503` is returned with no tier.

A 400 `bad_input` response is returned as `{ok:false, http:400, status, fields}` and the field names are logged. The owner token is not written into the test trace. `payload_sha256` is the SHA-256 of the canonical payload (sorted keys, no spaces).

## Copy check

`build/test_form_guard.json` is the phrase list. `gen.py --check` fails if the test form (`build/two-stage.js`, `content/pages/test-intake.md`, or the test-intake markup in `gen.py`) contains a closing-day count such as “close in 7 days”, a “by hand” or “person-reviewed” claim, or a Facebook star-rating claim. The check does not scan the rest of the site.

The built test page stays under 100KB transferred and under 10 requests. CSS and the test script are inlined. The usual subresources are the favicon and the logo.
