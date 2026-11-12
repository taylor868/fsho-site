# Call shapes for MWD's real adapter — mint, park, answer, claim, enrich, reserve, verify, complete, reconcile

DRAFT, Sentinel Dev, Nov 9 2026 (ET), revised 4:39 PM ET for MWD's 8 adapter gaps (`build/two-stage.js` @ 6ae20fc4) and Taylor's 4:44 PM ET removal of the price question; revised 5:02 PM ET for the C1 fix (`/intake-park/enrich`, complete takes no enrichment); revised Tue Nov 10 2026 (ET) for Taylor's decisions: campaign choice, the Slack Hot alert, late Hot (#8), and the sweep's non-owner/stale paths. Nothing here is deployed. Everything ships in Taylor's one bundled final review (`../REVIEW-PACKAGE.md`).
Sources: `intake-park/handler.ts`, `intake-reserve-v6/index.ts`, `_shared/envelope.ts`, `_shared/intake_fields.ts`, `../db/315a`, `../db/315d`.
All bodies are JSON `POST`s. Every response carries `content-type: application/json`. No response contains coordinates, the HMAC key, the Zap token, a raw IP, phone, email or name. The one exception: Zap `verify` with a matching `owner_token` on a Hot row returns `hot_alert`, which includes the property address so the Slack alert can show it (Taylor, Nov 10).

## 0. Common rules

**Who calls what.** Every call except Zap `verify`/token `complete`/token `reconcile` is made **server-side by the Netlify producer** (the function that holds `INTAKE_HMAC_KEY_V1`). The browser never calls Supabase and never mints ids.

**HMAC envelope.** Used on park, answer, claim, reserve, HMAC complete and HMAC reconcile.

```json
"envelope": { "v":"1", "kid":"<INTAKE_HMAC_KID>", "route":"ppc_inhouse", "channel":"website",
              "intake_id":"<uuid from /mint>", "event_id":"<unique per call>", "stage":"partial|first|final",
              "ts":"<unix s>", "exp":"<ts+<=900>", "payload_sha256":"<sha256 of canonical payload>", "sig":"<hex hmac>" }
```

- `sig` = HMAC-SHA256 over `canonicalLines(fields)` from `_shared/envelope.ts`. intake-park and intake-reserve v6 both import that file.
- **Exact `canonicalLines` (Nov 10, after the producer contract test):** ten lines in this **fixed order**, not sorted:
  `v`, `kid`, `route`, `channel`, `intake_id`, `event_id`, `stage`, `ts`, `exp`, `payload_sha256`.
  - Each line is `key=value`, with `String(value)`; a missing field gives an empty value. Lines are joined with `\n`, with no trailing newline.
  - `sig` is lowercase hex of HMAC-SHA256(key, lines).
  - Sorting the keys alphabetically gives a different string, and every signed call gets 401 `auth_failed`.
- **Test vector** (key `test_key_not_secret`, not a real key):
  - payload `{"address_line":"1 Main St, Akron, OH 44301","client_ip":"203.0.113.10","email":"a@example.com","full_name":"Ann Lee","gclid":"G1","phone":"5550100100"}`
  - payload_sha256 `bcc2b32f5acba2edac404465a98b9037f7d1c2b8de43a2f97e89a27d4c97cf4c`
  - envelope `v=1, kid=kid_test, route=ppc_inhouse, channel=website, intake_id=11111111-1111-4111-8111-111111111111, event_id=22222222-2222-4222-8222-222222222222, stage=partial, ts=1800000000, exp=1800000600`
  - sig `48cd219081d7bf501b8467454242d98557bf5c93b1ea61f1968e9f8ee496ee57`
- `ts` and `exp` may be sent as JSON numbers or digit strings.
- Only `envelope` and `payload` (plus `session_binding` on park and reserve) are read. Any other top-level key, such as `session_binding` on answer, claim or enrich, is ignored and never stored.
- `payload_sha256` is computed from the canonical JSON of `payload`: keys sorted, no spaces, integers only, at most 32 levels deep. The edge recomputes it and answers 401 `payload_digest_mismatch` if it doesn't match.
- Optional fields, `client_ip` and `reason` therefore have to be inside `payload` so they are signed.

**Optional tracking fields.** Accepted on park, answer, claim, reserve and complete (HMAC and token). They are validated identically in the edge (`_shared/intake_fields.ts`) and in SQL (`intake_tracking_errors` plus column CHECKs).

| Field | Rule | Stored as |
|---|---|---|
| `gclid`, `gbraid`, `wbraid`, `fbclid` | string, 1–256 chars, `[A-Za-z0-9._~-]` | staging columns, **first-touch** (a later stage never overwrites) |
| `utm_source`, `utm_medium`, `utm_campaign`, `utm_term`, `utm_content`, `utm_id` | string, ≤200 chars, no control chars, no `<` or `>` | staging columns, first-touch |
| `lead_id` (site/WC lead id) | string, 1–64 chars, `[A-Za-z0-9_-]` | `site_lead_id`, first-touch |

- Empty string or `null` means "not sent".
- An invalid value gets 400 `{status:"bad_input", fields:[...names]}` and nothing is written.
- **Write-once:** each column is set by the first call that carries a valid value; later calls never overwrite it (no error, the first value wins).
- Unknown top-level keys are ignored and never stored, **except** these, which get 400 naming the field: `attribution` (free-form attribution is not accepted; send only the defined fields above) and `price_vs_value` (removed by Taylor, 4:44 PM ET).

**Optional post-Hot enrichment.** `payload.enrichment` is an object. Every key is optional, and an unknown key or value gets 400 `enrichment.<key>`.

| Key | Allowed values |
|---|---|
| `occupancy` | `owner_occupied` `tenant_occupied` `vacant` `unknown` (DRAFT, pending MWD form values) |
| `condition` | `excellent` `good` `fair` `needs_work` `major_repairs` (DRAFT) |
| `listed` | `not_listed` `listed_under_90` `listed_over_90` `expired` (DRAFT) |
| `timeline` | `asap` `30d` `30_90d` `over_90d` `no_rush` (= qualifier.json v3) |

- Enrichment only sets `priority_tier`, and only on Hot rows (`status='promoted'`). It never changes Hot, tier, or routing.
- The DRAFT tier rule (Taylor to confirm):
  - `p1`: occupancy `vacant` on its own, **or** timeline `asap`/`30d` plus at least one distress signal: condition `needs_work`/`major_repairs`, listed `expired`/`listed_over_90`. Listed over 90 days counts as higher intent and under 90 as lower (Taylor's 11/03 rule), so only `listed_over_90` counts.
  - `p2`: any other timeline of `asap`, `30d`, or `30_90d`.
  - `p3`: everything else.
- There is **no price question**. `enrichment.price_vs_value` (any value) gets 400 `enrichment.price_vs_value`; a top-level `price_vs_value` gets 400 `price_vs_value`. Nothing is written.
- Keys merge latest-wins.
- **Send it only to `POST /intake-park/enrich`** (section 3b). Park also accepts it, but only stores it. On answer, claim, reserve and complete (HMAC and token), any `enrichment` gets 400 `enrichment`. The Zap's complete is the only completer.

**`client_ip`** is **REQUIRED** inside `payload` on park, answer, claim and enrich. It is the visitor IP as the Netlify producer saw it (`x-nf-client-connection-ip`). Because it is inside `payload` it is bound by `payload_sha256` and the signature.
- Validated as a strict IPv4 or IPv6 literal: no port, brackets, zone id, or leading zeros. A missing or bad value gets 400 `client_ip`.
- Used only as `HMAC("park-rl:"+ip)` for the rate limit. It is never stored, logged, or sent to the DB raw.
- Request headers are **never** used. The edge sees Netlify's IP, not the visitor's.

**Errors common to every op:**

| Code | Status values |
|---|---|
| 405 | `method_not_allowed` |
| 404 | `unknown_op` |
| 413 | `payload_too_large` (over 16 KiB) |
| 400 | `bad_json` |
| 401 | `auth_failed` (envelope, kid, window, or sig), `payload_digest_mismatch` |
| 429 | `rate_limited`, with `retry-after` |
| 503 | `not_configured`, `limiter_unavailable` (fails closed, `retry-after: 30`) |

## 0b. intake-reserve, `POST /functions/v1/intake-reserve/mint` (v5, unchanged in v6)

The **Netlify producer** calls this server-side once per visit, before park. It needs no auth and no envelope. The body is ignored, so send `{}`.

- **200** `{ "ok":true, "intake_id":"<uuid>", "session_binding":"<uuid>", "kid":"<INTAKE_HMAC_KID>", "intake_id_producer":"intake-reserve", "execution_requested":false, "exactly_once_external":false }`
- It is stateless: nothing is written. Use `intake_id` in every envelope and `session_binding` on park and reserve/complete. Keep both server-side (in the producer's session), not in the browser.
- **429** `rate_limited` (`retry-after`): 60/min per isolate in memory, plus the durable limiter at 30/min, keyed on the **caller IP**. Here the caller is Netlify, so all visitors share it. That is fine at form volume; Taylor can raise it at deploy if needed. **503** `limiter_unavailable`.
- The browser must **not** mint ids (no `crypto.randomUUID()` in the page).

## 1. intake-park, `POST /functions/v1/intake-park/park`

Canonical paths are `/functions/v1/intake-park/park`, `/answer` and `/claim`. The bare `/functions/v1/intake-park` and any other path get **404** `unknown_op`.

`envelope.stage="partial"`, `channel="website"`.

```json
{ "envelope": {…}, "session_binding": "<uuid from /mint>",
  "payload": { "full_name":"Mary Ann Smith", "first_name"?:"…", "last_name"?:"…",
               "phone":"10 or 11 digits", "email":"…",
               "address_line":"1109 N Highland St, Arlington, VA 22201",
               "line1"?:"…", "city"?:"…", "state"?:"VA", "postal"?:"12345[-6789]",
               "client_ip":"203.0.113.10", "is_test"?: false, "consent"?: false,
               "gclid"?:"…", "gbraid"?:"…", "wbraid"?:"…", "fbclid"?:"…", "utm_source"?:"…", …, "lead_id"?:"…", "enrichment"?: {…} } }
```

| Field | Rule |
|---|---|
| `full_name` | 1–160 chars. Required unless `first_name` is sent. The server splits it: first word to `first_name`, the rest to `last_name`. An explicitly sent `first_name`/`last_name` wins. |
| `first_name`, `last_name` | optional, 1–80 chars |
| `address_line` | **required**, 3–200 chars, the visitor's single address line. Stored as `address_raw`. Geocoded with Geocodio `q=<address_line>`. |
| `line1`, `city`, `state`, `postal` | optional, validated when sent (`state` 2 letters, upper-cased; `postal` `12345` or `12345-6789`) |
| `client_ip` | **required** (see section 0) |
| `consent` | boolean the site sends. Not an edge column. Unknown park keys are ignored, so this does not fail park. Unchecked is `false`. |

**Parsed parts.** When the geocode status is `ok`, the edge parses Geocodio's `formatted_address` (`"<line1>, <city>, <ST> <zip>"`) and stores `address_line1`, `city`, `state` and `postal`. It fills **only** the parts the visitor did not send, and malformed parts are dropped. No parts are stored on `low_accuracy`, `no_match`, `failed`, `capped` or `timeout`; `address_raw` is always kept. The CRM insert (315b) uses `address_line1`, falling back to `address_raw`.

Order of work: auth, validate, durable limit (`intake_park_rate_limit_hit`; 30 per visitor per minute and 300 per minute globally), `stage_intake_contact` (row written with `geocode_status='pending'`), `stage_intake_enrich` (only if enrichment was sent), geocode (cache, then quota, then Geocodio with a 2.5 s timeout), `stage_intake_geocode`.

- **200** `{ok:true, status:"parked", intake_id, geocode_status:"ok|no_match|low_accuracy|failed|capped|timeout"}`. Geocode never fails park, and re-parking the same `intake_id` is idempotent.
- **400** `bad_input {fields}`, `bad_stage`, `bad_channel`. **503** `park_unavailable` (`retry-after: 5`).

## 2. intake-park, `POST /functions/v1/intake-park/answer`

`stage="partial"`. Send one call per question.

```json
{ "envelope": {…}, "payload": { "question":"type|ownership|timeline|situation|equity|ability", "answer":"<option value, [a-z0-9_]{1,64}>",
                                "client_ip":"…", "gclid"?:"…", "utm_*"?:"…", "lead_id"?:"…" } }
```

Calls `stage_intake_answer({intake_id, question, answer, …tracking})`.

- **200** `{ok:true, status:"saved"}`.
- **200** `{ok:true, status:"late_answer_saved", row_status}`: the row was already claimed (for example by the sweep). The answer is kept in `late_answers` and the row is never re-routed.
- **404** `unknown_intake`. **400** `bad_input`. **503** `answer_unavailable`.

## 3. intake-park, `POST /functions/v1/intake-park/claim`

`stage="partial"`.

```json
{ "envelope": {…}, "payload": { "by":"promote|non_owner", "client_ip":"…", "gclid"?:"…", "utm_*"?:"…", "lead_id"?:"…" } }
```

Tracking is write-once, as in section 0. Enrichment on claim gets 400 `enrichment`; send it to `/intake-park/enrich`.

Calls `claim_intake_graded`. The server grades from the stored answers, so the browser never decides Hot:

- `promote` needs `type ∈ {sfh, multi_2_4}` and `ownership ∈ {sole_owner, all_agree, decision_maker}`. The row becomes `status promoted, tier hot`.
- `non_owner` needs `ownership = no`. The row becomes `status follow_up, tier follow_up`.

Responses:

- **200** `{ok:true, claimed:true, tier:"hot"|"follow_up", priority_tier:"p1"|"p2"|"p3"|null, status:"claimed"}`.
  - `priority_tier` is non-null only when the row is Hot (promoted) **and** has enrichment, for example from park. It is always `null` for `follow_up`. **Use this value; don't compute a tier in the site.**
- **200** `{ok:true, claimed:true, tier:"hot", status:"late_hot", priority_tier}` (Nov 10, #8): a Hot owner answer arrived **after** the sweep had put the lead in self_serve. The server grades the stored answers plus `late_answers` and gets Hot. It moves the CRM lead from Self-Serve back to New Lead, unassigned. It notifies the previous rep and Kekoa, and logs one activity note. **The site treats this exactly like `claimed`**: it fires the conversion once, reserves, and the Zap posts the Slack alert. A repeat returns the same response plus `replay:true`.
- **200** `{ok:true, claimed:false, status:"already_claimed"}`: the sweep or an earlier claim won. This includes a late Hot where the lead has already left Self-Serve (a rep took it, it is dead or terminal), in which case the response adds `late_hot_status`. **Stop**: don't reserve and don't call the Zap. A late **non-owner** answer gets 409 `not_non_owner` and stays where the existing rules put it.
- **409** `{ok:false, status:"not_qualified"|"not_non_owner", claimed:false}`.
- **404** `unknown_intake`. **400** `bad_input {fields:["by"]}`. **503** `claim_unavailable`.

## 3b. intake-park, `POST /functions/v1/intake-park/enrich` (C1 fix, 5:02 PM ET)

The site sends the post-Hot optional answers here, once the visitor reaches the thank-you screen (answered or skipped). This replaces the site's old HMAC `complete`. Send it from the **Netlify producer**, with the same HMAC envelope and signer as park/answer/claim. `stage="partial"`, `channel="website"`, `intake_id` from mint.

```json
{ "envelope": {…stage:"partial"},
  "payload": { "enrichment": { "occupancy"?:"…", "condition"?:"…", "listed"?:"…", "timeline"?:"…" },
               "client_ip":"203.0.113.10",
               "gclid"?:"…", "gbraid"?:"…", "wbraid"?:"…", "fbclid"?:"…", "utm_*"?:"…", "lead_id"?:"…" } }
```

- `enrichment` is **required** and must be an object. `{}` is valid (every question skipped). Values follow section 0; unknown keys or values get 400 `enrichment.<key>`. `price_vs_value` gets 400.
- Calls `stage_intake_enrich({intake_id, require_hot:true, …tracking, enrichment})`.
- **It writes only:** the staging `enrichment` (merged latest-wins per key), `priority_tier`, `enriched_at`, and write-once tracking.
- **It never touches:** the reservation, effect, ledger, `status`, `tier` or routing. So it is safe **before or after** the Zap's complete, and it never changes or blocks it.
- **Idempotent:** repeating the same call returns the same response and leaves the row unchanged, so it is safe to retry on timeout or 503.
- Responses:
  - **200** `{ok:true, status:"saved", priority_tier:"p1"|"p2"|"p3"|null}`. This is the server tier: show it and don't compute one.
  - **409** `{ok:false, status:"not_hot"}`: the row isn't Hot (promoted). Nothing is written.
  - **404** `unknown_intake`. **400** `bad_input {fields}`, before any write. **401** `auth_failed` / `payload_digest_mismatch`. **429** `rate_limited` (it counts toward the same 30-per-visitor-per-minute budget as park/answer/claim). **503** `enrich_unavailable` (`retry-after: 5`; safe to retry).

## 4. intake-reserve v6, `POST /functions/v1/intake-reserve/reserve` (HMAC; v5 plus owner_token and tracking)

```json
{ "envelope": {…stage:"first|final"}, "payload": {…, "gclid"?:"…", "utm_*"?:"…", "lead_id"?:"…"}, "session_binding":"<uuid>", "destination":"crm_create|crm_update|wc_create|wc_update",
  "owner_token"?: "<1–128 printable; RECOMMENDED: producer generates a UUID>", "lease_seconds"?: 120 }
```

- **200** `{ok:true, status:"dispatch_intended_committed", reservation_id, reservation_generation, session_binding, execution_requested:false, exactly_once_external:false}`.
  - If you sent no `owner_token`, the edge mints one and adds `owner_token` plus `owner_token_issued:true`, this one time only. Hand it to the Zap and never log it.
  - If the signed payload carried tracking, it is stored write-once after the commit, and the response adds `enrich_status:"saved|unknown_intake|enrich_error"`. Reserve never returns `priority_tier`.
- **400** `bad_input {fields}` for bad tracking, any `enrichment` (send it to `/intake-park/enrich`), or `price_vs_value`. This is checked **before** any RPC.
- **200** `{ok:true, status:"idempotent_replay"}`.
- **200** `{ok:false, status:"reservation_held"|"ownership_denied"|"event_identity_conflict"|"route_change_rejected"|"needs_reconcile"}`. A minted token is not returned on these.
- **400** `bad_input {fields:["owner_token"]}`, or `{error}` from the RPC.

## 5. intake-reserve v6, `POST /intake-reserve/verify` (Zap only; header `x-intake-zap-token: <INTAKE_ZAP_TOKEN>`)

```json
{ "reservation_id":"<uuid>", "intake_id"?:"…", "owner_token"?:"…" }
```

Calls `lookup_intake_checkpoint` (315d, read-only).

**200** returns only these fields:

```json
{ "ok":true, "status":"lookup_ok", "intake_id", "reservation_id", "stage", "destination", "reservation_state", "reservation_generation",
  "effect_delivery_state", "remote_id_present", "ledger_delivered_stage", "staging_tier":"hot|follow_up|self_serve|null", "priority_tier":"p1|p2|p3|null",
  "owner_match": true|false|null, "late_hot": true|false, "crm_lead_uuid": "<uuid>|null", "campaign_id": "<uuid>|null",
  "hot_alert": { "channel_id":"C09SVSMBYQ7", "source":"Google|Facebook|Website", "address_source":"geocoded|as_typed",
                 "text":"<!here> NEW RESIDENTIAL DEAL from Google\n\nLocated at <address>\n\n✅ FIRST TO CLAIM WINS THE DEAL ✅",
                 "plain":"@here …same…", "late_hot": false } | null,
  "execution_requested":false, "exactly_once_external":false }
```

- `campaign_id`, `hot_alert`: only when `owner_token` matches and the tier is Hot, otherwise null. `campaign_id` is In House PPC `1f149598-…` when the lead has gclid, gbraid or wbraid, otherwise Website / Inbound Call `90f30919-…` (both are `funnel_intake_config` columns). The Zap maps it into create_lead.
- `hot_alert.text` is the exact Slack message: the source word, then the Geocodio formatted address (the address line as typed if geocoding failed). The Zap posts it **after** a `delivered` complete, so a replayed run cannot post twice.
- `late_hot:true` plus `crm_lead_uuid` (#8): the CRM lead already exists. The Zap **skips create_lead** and completes with `remote_id = crm_lead_uuid`.

- Zap Paths branch on `staging_tier`. Hot goes to the Slack path; everything else goes quiet.
- **404** `not_found` (also returned when `intake_id` doesn't match). **400** `bad_input`. **503** `lookup_unavailable`.
- Without the header: 401. With the header on any op other than verify, complete, or reconcile: 403 `op_not_allowed_in_token_mode`. Token unset: 503 `zap_mode_not_configured`.

## 6. intake-reserve v6, `POST /intake-reserve/complete`

Complete runs in one of two modes.

**Only the Zap completes a reservation.** The site must **not** call complete; its post-Hot answers go to `/intake-park/enrich`. `complete_checkpoint` is a single-use CAS, so a second completer would get `needs_reconcile`; that was bug C1.

**HMAC mode (producer).** This is kept for v5 compatibility and is not used by the site: envelope plus `payload`, `session_binding`, `owner_token`, `reservation_id`, `reservation_generation`, and `remote_id?`. Tracking may go inside the signed `payload`. Any `enrichment` gets 400 `enrichment`.

**Token mode (Zap).** Send the header `x-intake-zap-token` and this body:

```json
{ "reservation_id":"<uuid>", "owner_token":"…", "reservation_generation": 1, "session_binding":"…", "remote_id"?:"<crm lead uuid / wc id>",
  "intake_id"?:"… (REQUIRED if any tracking is sent)", "gclid"?:"…", "utm_*"?:"…", "lead_id"?:"…" }   // no "enrichment" (400)
```

- `complete_checkpoint` does a CAS on owner_token, generation, session, and state.
- With the 315d fix, the ledger's `delivered_stage` advances `none` → `first` → `final` and never moves backwards.
- If tracking was sent and the complete succeeded: in token mode, the edge first checks with `lookup_intake_checkpoint` that `owner_match` is true for that `intake_id`, and then calls `stage_intake_enrich`.

Responses:

- **200** `{ok:true, status:"delivered", reservation_id, …, priority_tier:"p1"|"p2"|"p3"|null, enrich_status?:"saved|unknown_intake|enrich_error|enrich_skipped_intake_mismatch"}`.
  - `priority_tier` comes from the staging row (315d `complete_checkpoint`): non-null only when the row is Hot. If the site's `/enrich` ran first, this already reflects it. If `/enrich` runs after the Zap, the fresh tier comes back from `/enrich`. **The Zap and site use this value; don't compute a tier locally.**
- **200** `{ok:false, status:"needs_reconcile"|"cas_update_failed"|"envelope_incomplete"}`.
- **400** `bad_input {fields}`: bad optional fields, or any `enrichment` (`fields:["enrichment"]`). These are rejected **before** complete runs, so nothing changes.
- **503** `complete_unavailable, needs_reconcile:true` (token mode).

## 7. intake-reserve v6, `POST /intake-reserve/reconcile`

- **HMAC mode (producer):** exact shape below.

```json
{ "envelope": { "v":"1", "kid":"…", "route":"ppc_inhouse", "channel":"website", "intake_id":"<same intake>", "event_id":"<unique>",
                "stage":"first|final  (the stage of the reservation being reconciled)", "ts":"…", "exp":"…", "payload_sha256":"<sha256 of payload>", "sig":"…" },
  "payload": { "reason"?: "≤200 printable chars" },      // or {} — still signed
  "reservation_id": "<uuid>" }
```

- `reason` is read from the signed `payload.reason` (preferred). A top-level `reason` is still accepted for v5 compatibility and wins if both are sent. A bad `reason` gets 400 before any RPC. If no reason is sent, the live `mark_reconcile` default `uncertain_dispatch` applies.
- Calls the live `mark_reconcile`, which reads only `reservation_id` and `reason`. It moves the reservation to `reconcile_hold` (only from `dispatch_intended`/`processing`) and marks the effect `uncertain`.
- HMAC mode does **no owner check**: the HMAC key holder is trusted. `owner_token` and `session_binding` are not needed and are not checked.
- The envelope's `intake_id`/`stage` are verified as part of the signature but **not** cross-checked against the reservation, so always send the reservation's own values.
- **200** `{ok:true, status:"needs_reconcile", needs_reconcile:true}`. This is also returned for an unknown or already-final reservation, where nothing changes. `{ok:false, status:"envelope_incomplete"}` means no `reservation_id`. **401** for a bad signature or a tampered payload.
- **Token mode:** `{reservation_id, owner_token, reason?(≤200)}` calls `mark_reconcile_owned`. The owner must match.
  - **200** `{ok:true, status:"needs_reconcile"}`.
  - **200** `{ok:false, status:"ownership_denied"|"envelope_incomplete"}`.

## Sequence (Hot)

1. `mint` (producer, server-side)
2. `park`
3. `answer` × n
4. `claim{by:promote}` returns `tier hot` and `priority_tier`
5. `reserve{final, crm_create, owner_token}`
6. The Catch Hook body to the Zap is `{intake_id, reservation_id, reservation_generation, session_binding, owner_token}`. Contact fields go only if Taylor's Zap needs them.
7. Zap `verify`
8. Zap `create_lead`
9. Zap `complete{remote_id}` returns `priority_tier`. **The Zap is the only completer.**
10. Site: after the optional questions, `enrich{enrichment}` returns `priority_tier`. It can run before or after step 9; neither order affects the other.

The self-serve, timeout, and Q1 decline paths never reach reserve or the Zap. The 315c sweep (cron, every minute) does three things:
1. Timeout and Q1 decline rows go to `website_insert_lead(…, 'self_serve')`, or `self_serve_overflow` once John's cap is reached.
2. Non-owner rows (`follow_up` / `non_owner`, no CRM lead yet) go to `website_insert_lead(…, 'follow_up', 'daily_follow_up')`. The site never reserves non-owners, so this is how they reach the CRM.
3. Website leads that have sat in Self-Serve for `self_serve_stale_days` (10) with no outcome go to **daily_follow_up** via `ss_handoff_core(…, 'ai_follow_up', …)`. They never go to dead. The staleness test mirrors live `ss_is_stale`: the seller has been quiet 48 hours, and photos got no reply or an offer was sent and not chosen. The sweep runs 5 minutes ahead of Koa's hourly weekly-exit cron so website leads land in daily follow-up rather than weekly.
