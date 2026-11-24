# Address-first form: address-only partials and conversion gating

Andrew + Taylor, Nov 23, 2026. Hot Markets 50/50 split test (fsho.co vs fairandsimplehomeoffer.com) runs Nov 24 to Dec 14.

## Steps

1. **Address** (`#ts-s1`). Only the property address. Google Places autocomplete (addr.js) attaches on first focus; if it fails or the visitor types by hand, the typed line is used. `autocomplete="address-line1"` keeps the browser's own autofill menu from covering the Places list (addr.js sets `off` once Places attaches).
2. **Contact + consent** (`#ts-s2`). Name, phone, email, then the one required, unchecked consent box right above the button. The submit is blocked until the box is checked. An "Edit" button goes back to Step 1.
3. **Qualifying questions** (`#ts-ask`). Property type, then owner/decision-maker. Then the four optional follow-ups (skippable) and the thank-you screen.

## What fires when

| Moment | dataLayer | Google tag | WhatConverts | Server |
|---|---|---|---|---|
| Step 1 address | nothing | not loaded | nothing | producer `park_address` (see below) |
| Step 2 contact | `seller_form_partial` (reporting only, not a conversion) | not loaded | nothing | producer `park` (staged row, no CRM lead yet) |
| Step 3: type | nothing new | not loaded | nothing | `answer` |
| Step 3: owner = yes, sfh / 2-4 units, reserve OK | `seller_form_completed` (**the only conversion**) | loaded | one form lead | `claim`, `reserve`, Zap hook (CRM + Slack) |
| Quiet property / non-owner | `seller_form_disqualified` | not loaded | nothing | sweep / follow-up |

So the Google Ads conversion, GA4 `generate_lead` (GTM maps it from `seller_form_completed`), Meta/OpenAI pixels, and the WhatConverts lead all fire only after contact info **and** the qualifying questions (type + ownership). The optional follow-ups after that never fire it again.

## Address-only partials to the CRM

The front end always sends Step 1 to the producer as `op: "park_address"` with `address_line`, `is_test`, `lead_id`, the click ids and UTMs, and the `touch` bundle (landing page, referrer, first/last touch). The producer then does one of two things, set by the Netlify env var `INTAKE_ADDRESS_PARTIALS`:

- **Unset (default, safe today).** The producer validates the address and attribution, holds them in its sealed `fsho_intake` cookie, and returns `200 {ok:true,status:"address_held"}`. No mint, no edge call, no CRM row, no hook. The address rides on the Step 2 contact park exactly like the old one-screen form, so nothing changes server side. **Gap:** a visitor who leaves after Step 1 is not in the CRM yet.
- **`"1"`.** The producer mints an intake and calls `POST /intake-park/park` with `payload.partial = "address"` (address + attribution + client_ip, no name/phone/email). Step 2 then re-parks the same `intake_id` with the contact fields. This needs the Supabase changes below first. Without them the deployed intake-park answers 400 (`full_name`, `phone`, `email` required). The visitor still moves on, and the address rides on Step 2, so nothing breaks. But no address-only row is stored.

### Supabase changes needed before turning the flag on (not in this repo, not deployed)

1. **Edge `intake-park` `validatePayload`** (source: `fsho-two-stage-intake/edge/intake-park/handler.ts`): when `payload.partial === "address"`, skip the `full_name` / `phone` / `email` requirement (still validate `address_line`, `client_ip`, tracking). Pass `partial` through to `stage_intake_contact`. `checkOptionalFields` must allow the `partial` key.
2. **SQL `stage_intake_contact(jsonb)`**: today it ends with `on conflict (intake_id) do nothing`, so the Step 2 re-park would be ignored. Change it to fill the contact fields on the address-only row:
   ```sql
   on conflict (intake_id) do update set
     full_name  = coalesce(funnel_intake_staging.full_name,  excluded.full_name),
     first_name = coalesce(funnel_intake_staging.first_name, excluded.first_name),
     last_name  = coalesce(funnel_intake_staging.last_name,  excluded.last_name),
     phone_raw  = coalesce(funnel_intake_staging.phone_raw,  excluded.phone_raw),
     phone_norm = coalesce(funnel_intake_staging.phone_norm, excluded.phone_norm),
     email_raw  = coalesce(funnel_intake_staging.email_raw,  excluded.email_raw),
     email_norm = coalesce(funnel_intake_staging.email_norm, excluded.email_norm),
     tags = array_remove(funnel_intake_staging.tags, 'address_only'),
     last_activity_at = now(), updated_at = now()
   where funnel_intake_staging.crm_lead_uuid is null;
   ```
   Tag address-only inserts with `tags = '{address_only}'`. The staging columns for name, phone, and email are already nullable, and `address_raw` needs 3 to 200 characters, so no table change is needed.
3. **Sweep `sweep_intake_timeouts`**: an address-only row has no phone, so the self-serve bot cannot text it. Route `'address_only' = any(tags)` rows to `website_insert_lead(intake_id, 'follow_up', 'daily_follow_up')` (or a new nurture stage) instead of `self_serve`. Consider a longer idle window for them (for example 10 minutes) so a slow Step 2 is not swept first. `website_insert_lead` already accepts a row with only an address (it requires only `address_line1`/`address_raw`). `find_contact_for` and the `contact` insert get nulls; confirm the `contact` table accepts a null `full_name`/`phone`.
4. **Late contact after a sweep**: if Step 2 arrives after an address-only row was already routed (`crm_lead_uuid` set), attach the contact to that CRM lead (update its `contact`). Otherwise the CRM lead stays address-only.

### Zapier / GTM

- **Zap 386035932** fires only from the producer's reserve hook after a Hot owner answer. Address-only and contact-only partials never call it. No Zap change is needed.
- **GTM-TM6JSDLB**: the Google Ads conversion tag and GA4 `generate_lead` must trigger on the exact custom event `seller_form_completed`, never `seller_form_.*` or All Custom Events. Confirm no tag counts `seller_form_partial` as a conversion. Nothing new is pushed on Step 1.
- **WhatConverts**: do not add `#ts-form` as a WhatConverts web form. Its native listener would count Step 1 and Step 2 submits.
