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

Attribution is config-driven on `TRACKING` in `build/two-stage.js`. The page stores first-touch click ids and UTMs in `localStorage` under `fsho_ts_attr`, and appends a visit record for each page view (query, URL, path, hostname, referrer, user agent, cookie jar, and time). First-touch fields are write-once: a stored value is never replaced, and a field that is still empty can be filled later. The signed edge payload still sends only the original first-touch `gclid`, `gbraid`, `wbraid`, `fbclid`, UTMs, and `lead_id`. The producer turns the visit list into the Catch Hook fields below. Cookies `_ga`, `_gcl_aw`, `_gcl_gb`, `_fbp`, and `_fbc` are read when present and are never set by this script.

`lead_id` is created with `crypto.randomUUID()` once per browser session and kept in `sessionStorage` under `fsho_ts_lead`. A value already in that key is kept. The same id is sent on every stage. The real adapter also refuses to overwrite a click id, UTM, or lead id it has already sent.

`CONFIG.gtm_id` and `TRACKING.gtm_id` are `GTM-WWPBQGDZ`. GA4 is off. The Meta pixel is off. The container script is not in the HTML and is not requested at page load. The first `pointerdown` or `keydown` inserts one async `gtm.js` script. The dry-run Google marker is still the JSON script inserted after `owner = yes`. Site-wide tracking stays off, so the shared pages do not load this container.

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

The browser sends `{op, ...whitelisted fields}`. Park includes `is_test` and `consent`. Public forms send `is_test: false`. A production build does not serve a working `/test-intake/` form, including with `?test=1`. On a deploy preview, branch deploy, dev, or local build, `/test-intake/?test=1` sends `true`. The function forwards that boolean and treats a missing flag as `false`. Edge intake-park stores a test row only when `is_test === true`, so `false` is a real lead. A non-boolean `is_test` is `400 bad_input`. `consent` is a boolean on the park payload and the Catch Hook. Missing consent is `false`. A non-boolean `consent` is `400 bad_input`. The edge ignores that unknown park key, so it does not fail intake. The function mints when the session cookie is empty. A later park also mints when that cookie intake is already reserved (`zap_sent`) or already claimed, and parks the new contact on the new intake. A later park on an in-progress intake that has not been reserved keeps the same intake. The function signs park, answer, claim, enrich, and reserve. `session_binding` goes on park and reserve only. Answer, claim, and enrich are exactly `{envelope, payload}`. Session state, including `session_binding` and `owner_token`, stays in an opaque HttpOnly cookie. The cookie key is SHA-256 of `INTAKE_COOKIE_KEY` when that is set, otherwise HKDF-SHA256 of the signing key with info `fsho-intake-cookie-v1`. `attribution` and `price_vs_value` are rejected. Tracking is write-once. After a reserve that commits, the function POSTs the Catch Hook with the contact and reservation fields plus every `attr_*` key in the list below. That POST is server-side only. The signed edge payload is unchanged: first-touch `gclid`, `gbraid`, and `wbraid` are still what Zap verify uses for `campaign_id`. If the hook fails, it is retried once. If it still fails, the function signs `POST /intake-reserve/reconcile` with the reservation's own stage and reason `hook_uncertain`, and logs only the reservation id. The browser gets `{ok:false, status:"needs_reconcile"}`.

Stage 1 advances only when park returns 200. Any other producer or park status stays on the contact step and the page says to try again.

Enrich `503` is retried once. `409` and `429` are not retried. A second enrich `503` is returned with no tier.

A 400 `bad_input` response is returned as `{ok:false, http:400, status, fields}` and the field names are logged. The owner token is not written into the test trace. `payload_sha256` is the SHA-256 of the canonical payload (sorted keys, no spaces).

## Catch Hook fields

Every reserve that commits POSTs one JSON object. These ten fields are unchanged:

| Key | Meaning |
|---|---|
| `intake_id` | Intake id from mint. |
| `reservation_id` | Reservation id from reserve. |
| `reservation_generation` | Number. Generation from reserve. |
| `session_binding` | Session binding from mint. |
| `owner_token` | Owner token for the Zap. |
| `full_name` | Name from the form. |
| `phone` | Digits from the form. |
| `email` | Email from the form. |
| `address_line` | Address line from the form. |
| `consent` | Boolean. Unchecked is `false`. |

Every `attr_*` key below is a string. A missing value is `""`, so the Zap field list stays stable. For `gclid`, `gbraid`, `wbraid`, `fbclid`, and the six UTMs, `attr_<name>` and `attr_ft_<name>` match the signed edge payload (first value wins). `attr_lt_<name>` is the latest value and can differ. The producer strips control characters and `<>`, drops values that fail the click-id or URL rules, and caps length. It does not copy environment variables into the body.

`attr_device` is the browser's mobile, desktop, or tablet category. Google's ValueTrack `device` parameter is only `attr_ft_device` and `attr_lt_device`. `attr_hostname` and `attr_submit_hostname` are the host that submitted the form (`fsho.co` or `fairandsimplehomeoffer.com`). `attr_ft_hostname` is the first host.

| Key | Meaning |
|---|---|
| `attr_gclid` | First-touch Google click id. Same as `attr_ft_gclid`. |
| `attr_ft_gclid` | First-touch Google click id. |
| `attr_lt_gclid` | Latest Google click id. |
| `attr_gbraid` | First-touch Google app click id. |
| `attr_ft_gbraid` | First-touch Google app click id. |
| `attr_lt_gbraid` | Latest Google app click id. |
| `attr_wbraid` | First-touch Google web-to-app click id. |
| `attr_ft_wbraid` | First-touch Google web-to-app click id. |
| `attr_lt_wbraid` | Latest Google web-to-app click id. |
| `attr_fbclid` | First-touch Meta click id. |
| `attr_ft_fbclid` | First-touch Meta click id. |
| `attr_lt_fbclid` | Latest Meta click id. |
| `attr_msclkid` | First-touch Microsoft Ads click id. |
| `attr_ft_msclkid` | First-touch Microsoft Ads click id. |
| `attr_lt_msclkid` | Latest Microsoft Ads click id. |
| `attr_ttclid` | First-touch TikTok click id. |
| `attr_ft_ttclid` | First-touch TikTok click id. |
| `attr_lt_ttclid` | Latest TikTok click id. |
| `attr_li_fat_id` | First-touch LinkedIn ad tracking id. |
| `attr_ft_li_fat_id` | First-touch LinkedIn ad tracking id. |
| `attr_lt_li_fat_id` | Latest LinkedIn ad tracking id. |
| `attr_utm_source` | First-touch `utm_source`. |
| `attr_ft_utm_source` | First-touch `utm_source`. |
| `attr_lt_utm_source` | Latest `utm_source`. |
| `attr_utm_medium` | First-touch `utm_medium`. |
| `attr_ft_utm_medium` | First-touch `utm_medium`. |
| `attr_lt_utm_medium` | Latest `utm_medium`. |
| `attr_utm_campaign` | First-touch `utm_campaign`. |
| `attr_ft_utm_campaign` | First-touch `utm_campaign`. |
| `attr_lt_utm_campaign` | Latest `utm_campaign`. |
| `attr_utm_term` | First-touch `utm_term`. |
| `attr_ft_utm_term` | First-touch `utm_term`. |
| `attr_lt_utm_term` | Latest `utm_term`. |
| `attr_utm_content` | First-touch `utm_content`. |
| `attr_ft_utm_content` | First-touch `utm_content`. |
| `attr_lt_utm_content` | Latest `utm_content`. |
| `attr_utm_id` | First-touch `utm_id`. |
| `attr_ft_utm_id` | First-touch `utm_id`. |
| `attr_lt_utm_id` | Latest `utm_id`. |
| `attr_campaignid` | First-touch Google Ads campaign id. |
| `attr_ft_campaignid` | First-touch Google Ads campaign id. |
| `attr_lt_campaignid` | Latest Google Ads campaign id. |
| `attr_adgroupid` | First-touch Google Ads ad group id. |
| `attr_ft_adgroupid` | First-touch Google Ads ad group id. |
| `attr_lt_adgroupid` | Latest Google Ads ad group id. |
| `attr_keyword` | First-touch Google Ads keyword. |
| `attr_ft_keyword` | First-touch Google Ads keyword. |
| `attr_lt_keyword` | Latest Google Ads keyword. |
| `attr_matchtype` | First-touch Google Ads match type. |
| `attr_ft_matchtype` | First-touch Google Ads match type. |
| `attr_lt_matchtype` | Latest Google Ads match type. |
| `attr_network` | First-touch Google Ads network. |
| `attr_ft_network` | First-touch Google Ads network. |
| `attr_lt_network` | Latest Google Ads network. |
| `attr_ft_device` | First-touch Google Ads ValueTrack device code. |
| `attr_lt_device` | Latest Google Ads ValueTrack device code. |
| `attr_creative` | First-touch Google Ads creative id. |
| `attr_ft_creative` | First-touch Google Ads creative id. |
| `attr_lt_creative` | Latest Google Ads creative id. |
| `attr_placement` | First-touch Google Ads placement. |
| `attr_ft_placement` | First-touch Google Ads placement. |
| `attr_lt_placement` | Latest Google Ads placement. |
| `attr_loc_physical_ms` | First-touch Google Ads physical location id. |
| `attr_ft_loc_physical_ms` | First-touch Google Ads physical location id. |
| `attr_lt_loc_physical_ms` | Latest Google Ads physical location id. |
| `attr_gad_source` | First-touch Google Ads `gad_source`. |
| `attr_ft_gad_source` | First-touch Google Ads `gad_source`. |
| `attr_lt_gad_source` | Latest Google Ads `gad_source`. |
| `attr_landing_page` | First landing page URL. |
| `attr_ft_landing_page` | First landing page URL. |
| `attr_lt_landing_page` | Latest page URL. |
| `attr_landing_path` | First path, including its query string. |
| `attr_ft_landing_path` | First path, including its query string. |
| `attr_lt_landing_path` | Latest path, including its query string. |
| `attr_hostname` | Hostname of the page that submitted the form. |
| `attr_ft_hostname` | Hostname of the first page. |
| `attr_lt_hostname` | Hostname of the latest page. |
| `attr_referrer` | First referrer. |
| `attr_ft_referrer` | First referrer. |
| `attr_lt_referrer` | Latest referrer. |
| `attr_first_seen` | ISO time of the first captured visit. |
| `attr_last_seen` | ISO time of the latest captured visit. |
| `attr_submit_path` | Path of the page that submitted the form. |
| `attr_submit_hostname` | Hostname of the page that submitted the form. |
| `attr_submit_ts` | Server time of this Catch Hook POST, ISO-8601 UTC. |
| `attr_device` | `mobile`, `desktop`, or `tablet` from the user agent. |
| `attr_lead_id` | Site lead id. Same value as the conversion `transaction_id`. |
| `attr_transaction_id` | Same as `attr_lead_id`. |
| `attr_ga_client_id` | Google Analytics client id parsed from `_ga`. |
| `attr_gcl_aw` | Value of the `_gcl_aw` cookie, when the browser sent it. |
| `attr_gcl_gb` | Value of the `_gcl_gb` cookie, when the browser sent it. |
| `attr_fbp` | Value of the `_fbp` cookie, when the browser sent it. |
| `attr_fbc` | Value of the `_fbc` cookie, when the browser sent it. |

Map each new key to its own CRM field in the Zap. Leave `campaign_id` on the value Zap verify already returns. An empty string means the signal was not present.

## Copy check

`build/test_form_guard.json` is the phrase list. `gen.py --check` fails if the test form (`build/two-stage.js`, `content/pages/test-intake.md`, or the test-intake markup in `gen.py`) contains a closing-day count such as “close in 7 days”, a “by hand” or “person-reviewed” claim, or a Facebook star-rating claim. The check does not scan the rest of the site.

The built test page stays under 100KB transferred and under 10 requests. CSS and the test script are inlined. The usual subresources are the favicon and the logo.
