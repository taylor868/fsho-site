"use strict";

const crypto = require("crypto");

// Browser posts the site qualifier / Form 1 JSON here.
// This maps that payload toward FSHO CRM create_lead. It does not claim
// end-to-end routing works:
// - Campaign name is "In House PPC". The uuid comes only from
//   FSHO_CRM_CAMPAIGN_ID. There is no default uuid in this file.
// - Leads are unassigned on purpose. create_lead is called with an explicit
//   JSON null for p_assigned_to (the key is never omitted). Sentinel reported
//   this from acq-command-center: db/006_functions.sql defines p_assigned_to
//   uuid with no DEFAULT and inserts that argument; db/001_core.sql
//   assigned_user_id is a nullable uuid FK; fsho-api/index.ts forwards the
//   args with no null check; lead-intake/index.ts sets assignedTo to null
//   ("NOBODY") and passes p_assigned_to: assignedTo. "Required" there means
//   no DEFAULT, not NOT NULL. FSHO_CRM_ASSIGNED_TO is invalid if set: there
//   is no default rep.
// - Campaign id and source key come only from FSHO_CRM_CAMPAIGN_ID and
//   FSHO_CRM_SOURCE_KEY. There is no default uuid or source key in this file.
// - Two steps: the hero partial calls create_lead once (explicit null
//   assignee). The qualifier calls update_lead_details on that same lead.
//   The browser gets a signed continuation, not a trusted lead uuid.
//   A phone or email that already exists is not updated.
// - update_lead_details replaces seller_motivation, so the patch is the full
//   text (EMOTA plus attribution), not a delta. The patch has no owner or
//   stage field. claim_lead is never called.
// - Slack: this file does not notify. create_lead may skip the intake
//   side effect that posts to the acquisitions chat. That hook is not
//   reimplemented here. The partial create is the only new-lead event;
//   the qualifier update must not send a second notification.

const DEFAULT_API_BASE = "https://ruedjugpbuagyapunytd.supabase.co/functions/v1/fsho-api";
const CONTINUATION_TTL_DEFAULT = 7200;
const CONTINUATION_TTL_MAX = 86400;
const HONEYPOT = "company_website";
const STREET_SUFFIX = /^(st|street|ave|avenue|rd|road|dr|drive|ln|lane|blvd|boulevard|ct|court|cir|circle|pl|place|way|ter|terrace|pkwy|parkway|hwy|highway)$/i;
const MAX_BODY = 32 * 1024;
const RPC_TIMEOUT_MS = 2500;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const STATES = {
  alabama: "AL", alaska: "AK", arizona: "AZ", arkansas: "AR", california: "CA",
  colorado: "CO", connecticut: "CT", delaware: "DE", "district of columbia": "DC",
  florida: "FL", georgia: "GA", hawaii: "HI", idaho: "ID", illinois: "IL",
  indiana: "IN", iowa: "IA", kansas: "KS", kentucky: "KY", louisiana: "LA",
  maine: "ME", maryland: "MD", massachusetts: "MA", michigan: "MI", minnesota: "MN",
  mississippi: "MS", missouri: "MO", montana: "MT", nebraska: "NE", nevada: "NV",
  "new hampshire": "NH", "new jersey": "NJ", "new mexico": "NM", "new york": "NY",
  "north carolina": "NC", "north dakota": "ND", ohio: "OH", oklahoma: "OK",
  oregon: "OR", pennsylvania: "PA", "rhode island": "RI", "south carolina": "SC",
  "south dakota": "SD", tennessee: "TN", texas: "TX", utah: "UT", vermont: "VT",
  virginia: "VA", washington: "WA", "west virginia": "WV", wisconsin: "WI", wyoming: "WY",
};
const ABBR = new Set(Object.keys(STATES).map((name) => STATES[name]));

function hiddenValues(hidden) {
  if (hidden && typeof hidden === "object") return [hidden.token, hidden.secret];
  return [hidden];
}

function log(fields, token) {
  const safe = {};
  for (const key of Object.keys(fields)) {
    if (/token|authorization|secret|phone|email|address|body|continuation/i.test(key)) continue;
    safe[key] = fields[key];
  }
  const line = JSON.stringify(safe);
  const hidden = hiddenValues(token);
  for (const item of hidden) {
    if (item && line.indexOf(item) !== -1) return;
  }
  if (/bearer\s+\S+/i.test(line)) return;
  console.log(line);
}

function json(status, obj) {
  return {
    statusCode: status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Robots-Tag": "noindex",
    },
    body: JSON.stringify(obj),
  };
}

function rawBody(event) {
  if (!event || event.body == null) return "";
  if (event.isBase64Encoded) return Buffer.from(event.body, "base64").toString("utf8");
  return String(event.body);
}

function pick(v) {
  return typeof v === "string" ? v.trim() : "";
}

function honeypotValue(body) {
  if (!body || typeof body !== "object") return undefined;
  for (const key of Object.keys(body)) {
    if (String(key).toLowerCase() === HONEYPOT) return body[key];
  }
  return undefined;
}

function honeypotFilled(body) {
  const v = honeypotValue(body);
  if (v == null || v === false) return false;
  if (typeof v === "string") return v.trim() !== "";
  if (typeof v === "number") return true;
  if (Array.isArray(v)) return v.length > 0;
  if (typeof v === "object") return Object.keys(v).length > 0;
  return true;
}

function normalizeState(raw) {
  const s = pick(raw).replace(/\./g, "").replace(/\s+/g, " ");
  if (!s) return "";
  if (s.length === 2 && ABBR.has(s.toUpperCase())) return s.toUpperCase();
  return STATES[s.toLowerCase()] || "";
}

function stripTrailingState(s) {
  const lower = s.toLowerCase();
  const names = Object.keys(STATES).sort((a, b) => b.length - a.length);
  for (const name of names) {
    if (lower === name) return { state: STATES[name], rest: "" };
    const idx = lower.length - name.length;
    if (idx > 0 && lower.endsWith(name) && /[\s,]/.test(lower.charAt(idx - 1))) {
      return { state: STATES[name], rest: s.slice(0, idx).replace(/[,\s]+$/, "").trim() };
    }
  }
  const sm = s.match(/^(.*?)[,\s]+([A-Za-z]{2})$/);
  if (sm && ABBR.has(sm[2].toUpperCase())) {
    return { state: sm[2].toUpperCase(), rest: sm[1].replace(/[,\s]+$/, "").trim() };
  }
  return { state: "", rest: s };
}

function parseAddress(raw) {
  const original = pick(raw).replace(/\u00a0/g, " ").replace(/\s+/g, " ");
  const empty = { raw: original, street: "", city: "", state: "", postal: "" };
  if (!original) return empty;
  let s = original;
  let postal = "";
  const zm = s.match(/\b(\d{5}(?:-\d{4})?)\s*$/);
  if (zm) {
    postal = zm[1];
    s = s.slice(0, zm.index).replace(/[,\s]+$/, "").trim();
  }
  const stripped = stripTrailingState(s);
  s = stripped.rest;
  let city = "";
  let street = s;
  const parts = s.split(",").map((p) => p.trim()).filter(Boolean);
  if (parts.length >= 2) {
    city = parts[parts.length - 1];
    street = parts.slice(0, -1).join(", ");
  } else if (stripped.state && s) {
    const bits = s.split(/\s+/);
    const last = bits[bits.length - 1];
    if (bits.length >= 3 && last && !STREET_SUFFIX.test(last.replace(/\./g, ""))) {
      city = last;
      street = bits.slice(0, -1).join(" ");
    }
  }
  return { raw: original, street, city, state: stripped.state, postal };
}

function locationOf(lead) {
  const parsed = parseAddress(lead.address || "");
  return {
    // Keep the seller's full line. A split city/state is extra, not a replacement.
    address: parsed.raw || pick(lead.address),
    city: pick(lead.city) || parsed.city,
    state: normalizeState(lead.state) || parsed.state,
    postal: pick(lead.postal) || pick(lead.zip) || parsed.postal,
  };
}

function sellerName(lead) {
  const named = pick(lead.seller_name) || pick(lead.name);
  if (named) return named;
  return [pick(lead.first), pick(lead.last)].filter(Boolean).join(" ");
}

function digits(v) {
  return String(v || "").replace(/\D/g, "");
}

function omitEmpty(obj) {
  const out = {};
  for (const key of Object.keys(obj)) {
    const v = obj[key];
    if (v == null || v === "") continue;
    if (Array.isArray(v) && !v.length) continue;
    if (typeof v === "object" && !Array.isArray(v) && !Object.keys(v).length) continue;
    out[key] = v;
  }
  return out;
}

function motivation(lead) {
  const utm = omitEmpty({
    source: pick(lead.utm_source),
    medium: pick(lead.utm_medium),
    campaign: pick(lead.utm_campaign),
    term: pick(lead.utm_term),
  });
  const m = omitEmpty({
    lead_id: pick(lead.lead_id),
    stage: pick(lead.stage),
    form_version: lead.form_version == null || lead.form_version === "" ? "" : lead.form_version,
    page: pick(lead.page),
    tier: pick(lead.tier),
    cadence: pick(lead.cadence),
    conversion: pick(lead.conversion),
    gclid: pick(lead.gclid),
    consent_text: pick(lead.consent_text),
    utm,
    tags: Array.isArray(lead.tags) ? lead.tags.slice(0, 40) : "",
    answers: lead.answers && typeof lead.answers === "object" ? lead.answers : "",
  });
  if (Object.prototype.hasOwnProperty.call(lead, "emota")) m.emota = lead.emota;
  if (Object.prototype.hasOwnProperty.call(lead, "failed")) m.failed = lead.failed;
  let text = JSON.stringify(m);
  if (text.length > 2000 && m.answers) {
    delete m.answers;
    text = JSON.stringify(m);
  }
  if (text.length > 2000 && m.tags) {
    delete m.tags;
    text = JSON.stringify(m);
  }
  if (text.length > 2000) return "";
  return text === "{}" ? "" : text;
}

function consented(lead) {
  if (lead.consent === true || lead.sms_consent === true) return true;
  return !!pick(lead.consent_text);
}

function consentUrl(lead) {
  const explicit = pick(lead.consent_url);
  if (/^https:\/\//i.test(explicit)) return explicit;
  if (!consented(lead)) return "";
  const page = pick(lead.page);
  if (/^https:\/\//i.test(page)) return page;
  if (page.startsWith("/") && page.indexOf("//") !== 0) return "https://fairandsimplehomeoffer.com" + page;
  return "";
}

// Map a site payload to create_lead args, excluding the three env-backed ids.
function mapLead(lead) {
  lead = lead || {};
  const loc = locationOf(lead);
  const name = sellerName(lead);
  const phone = pick(lead.phone);
  const email = pick(lead.email);
  const missing = [];
  if (!loc.address) missing.push("p_address");
  if (!loc.city) missing.push("p_city");
  if (!loc.state) missing.push("p_state");
  if (!loc.postal) missing.push("p_postal");
  if (!name) missing.push("p_seller_name");
  if (digits(phone).length < 10) missing.push("p_phone");
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) missing.push("p_email");
  const tooLong = [loc.address, loc.city, name].some((v) => v.length > 500) || email.length > 320;
  if (tooLong) return { ok: false, error: "field_too_long", missing: [] };
  if (missing.length) return { ok: false, error: "incomplete_lead", missing };
  const body = {
    p_address: loc.address,
    p_city: loc.city,
    p_state: loc.state,
    p_postal: loc.postal,
    p_seller_name: name,
    p_phone: phone,
    p_email: email,
  };
  const note = motivation(lead);
  if (note) body.p_motivation = note;
  const consentText = pick(lead.consent_text);
  if (consentText) body.p_consent_text = consentText.slice(0, 2000);
  const url = consentUrl(lead);
  if (url) body.p_consent_url = url;
  return { ok: true, body };
}

function isUuid(v) {
  return typeof v === "string" && UUID.test(v.trim());
}

function apiBase(env) {
  const raw = pick(env.FSHO_API_BASE) || DEFAULT_API_BASE;
  let url;
  try { url = new URL(raw); } catch (e) { return { ok: false }; }
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) return { ok: false };
  return { ok: true, base: raw.replace(/\/$/, "") };
}

function loadConfig(env) {
  const missing = [];
  const invalid = [];
  const token = typeof env.FSHO_CRM_CREATE_LEAD_TOKEN === "string" ? env.FSHO_CRM_CREATE_LEAD_TOKEN.trim() : "";
  if (!token) missing.push("FSHO_CRM_CREATE_LEAD_TOKEN");
  else if (/[\r\n]/.test(token)) invalid.push("FSHO_CRM_CREATE_LEAD_TOKEN");
  const campaign = pick(env.FSHO_CRM_CAMPAIGN_ID);
  const source = pick(env.FSHO_CRM_SOURCE_KEY);
  // Any configured assignee is invalid. The only legal value is an explicit
  // null, and only after the RPC contract is verified. Never send this env.
  const assignedRaw = env.FSHO_CRM_ASSIGNED_TO;
  const assignedSet = assignedRaw == null ? "" : String(assignedRaw).trim();
  if (!campaign) missing.push("FSHO_CRM_CAMPAIGN_ID");
  else if (!isUuid(campaign)) invalid.push("FSHO_CRM_CAMPAIGN_ID");
  if (!source) missing.push("FSHO_CRM_SOURCE_KEY");
  else if (source.length > 200 || /[\r\n]/.test(source)) invalid.push("FSHO_CRM_SOURCE_KEY");
  if (assignedSet) invalid.push("FSHO_CRM_ASSIGNED_TO");
  const secret = typeof env.FSHO_LEAD_CONTINUATION_SECRET === "string" ? env.FSHO_LEAD_CONTINUATION_SECRET.trim() : "";
  if (!secret) missing.push("FSHO_LEAD_CONTINUATION_SECRET");
  else if (secret.length < 16 || /[\r\n]/.test(secret)) invalid.push("FSHO_LEAD_CONTINUATION_SECRET");
  let ttl = CONTINUATION_TTL_DEFAULT;
  const ttlRaw = env.FSHO_LEAD_CONTINUATION_TTL_SECONDS;
  if (ttlRaw != null && String(ttlRaw).trim() !== "") {
    const n = Number(ttlRaw);
    if (!Number.isFinite(n) || n < 60 || n > CONTINUATION_TTL_MAX) invalid.push("FSHO_LEAD_CONTINUATION_TTL_SECONDS");
    else ttl = Math.floor(n);
  }
  const base = apiBase(env);
  if (!base.ok) invalid.push("FSHO_API_BASE");
  return {
    ok: !missing.length && !invalid.length && base.ok,
    missing,
    invalid,
    token,
    secret,
    ttl,
    base: base.base || "",
    campaign,
    source,
  };
}

function phoneKey(v) {
  const d = digits(v);
  return d.length >= 10 ? d.slice(-10) : "";
}

function emailKey(v) {
  return pick(v).toLowerCase();
}

function b64url(buf) {
  return Buffer.from(buf).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function fromB64url(s) {
  const pad = s.length % 4 === 0 ? "" : "=".repeat(4 - (s.length % 4));
  return Buffer.from(String(s).replace(/-/g, "+").replace(/_/g, "/") + pad, "base64");
}

function attrOf(lead) {
  return {
    gclid: pick(lead.gclid),
    utm_source: pick(lead.utm_source),
    utm_medium: pick(lead.utm_medium),
    utm_campaign: pick(lead.utm_campaign),
    utm_term: pick(lead.utm_term),
    page: pick(lead.page),
    lead_id: pick(lead.lead_id),
  };
}

function signContinuation(secret, claims) {
  const body = b64url(JSON.stringify(claims));
  const sig = b64url(crypto.createHmac("sha256", secret).update(body).digest());
  return body + "." + sig;
}

function verifyContinuation(secret, token, now) {
  if (typeof token !== "string" || token.length < 20 || token.length > 4000) return { error: "continuation_invalid" };
  const dot = token.indexOf(".");
  if (dot <= 0 || token.indexOf(".", dot + 1) !== -1) return { error: "continuation_invalid" };
  const body = token.slice(0, dot);
  let given;
  try { given = fromB64url(token.slice(dot + 1)); } catch (e) { return { error: "continuation_invalid" }; }
  const expected = crypto.createHmac("sha256", secret).update(body).digest();
  if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) return { error: "continuation_invalid" };
  let claims;
  try { claims = JSON.parse(fromB64url(body).toString("utf8")); } catch (e) { return { error: "continuation_invalid" }; }
  if (!claims || claims.v !== 1 || !isUuid(claims.lead) || !claims.phone || !claims.email || typeof claims.exp !== "number") {
    return { error: "continuation_invalid" };
  }
  if (claims.exp * 1000 <= now) return { error: "continuation_expired" };
  return { claims };
}

function identityMatches(payload, claims) {
  return phoneKey(payload.phone) === claims.phone && emailKey(payload.email) === claims.email;
}

function leadUuidFromCreate(data) {
  if (typeof data === "string" && isUuid(data)) return data.trim();
  if (!data || typeof data !== "object" || Array.isArray(data)) return "";
  for (const key of ["id", "lead", "lead_id", "uuid", "p_lead"]) {
    if (typeof data[key] === "string" && isUuid(data[key])) return data[key].trim();
  }
  return "";
}

function mergedForUpdate(payload, claims) {
  const lead = Object.assign({}, payload);
  const attr = claims && claims.attr || {};
  for (const key of Object.keys(attr)) {
    if (!pick(lead[key]) && attr[key]) lead[key] = attr[key];
  }
  delete lead.continuation;
  delete lead.p_lead;
  delete lead.lead;
  lead.stage = "complete";
  return lead;
}

function publicError(parsed, token) {
  const msg = parsed && typeof parsed.error === "string" ? parsed.error : "";
  if (!msg || msg.length > 120 || !/^[A-Za-z0-9 _.:-]+$/.test(msg)) return "crm_rejected";
  if (/bearer|fsh_|token|secret/i.test(msg)) return "crm_rejected";
  if (token && msg.indexOf(token) !== -1) return "crm_rejected";
  return msg;
}

function relayStatus(status) {
  if (status === 400 || status === 401 || status === 403 || status === 500) return status;
  return 502;
}

function interpretLookup(status, parsed) {
  if (status === 404) return { found: false, skipped: true };
  if (status < 200 || status >= 300) return { error: true, status };
  if (parsed == null) return { found: false };
  if (typeof parsed === "string") {
    return isUuid(parsed) ? { found: true, id: parsed.trim() } : { found: false };
  }
  if (typeof parsed === "object" && !Array.isArray(parsed)) {
    if (typeof parsed.error === "string" && parsed.ok !== true) return { error: true, status: status >= 400 ? status : 400 };
    const data = Object.prototype.hasOwnProperty.call(parsed, "data") ? parsed.data : null;
    if (data == null || data === "") return { found: false };
    if (typeof data === "string" && isUuid(data)) return { found: true, id: data.trim() };
    return { error: true, status: 502 };
  }
  return { found: false };
}

async function rpc(fetchImpl, base, name, body, token) {
  const res = await fetchImpl(base + "/rpc/" + name, {
    method: "POST",
    redirect: "error",
    cache: "no-store",
    signal: AbortSignal.timeout(RPC_TIMEOUT_MS),
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      Authorization: "Bearer " + token,
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let parsed = null;
  if (text) {
    try { parsed = JSON.parse(text); } catch (e) { parsed = null; }
  }
  return { status: res.status, parsed };
}

async function handle(event, deps) {
  const env = (deps && deps.env) || process.env;
  const fetchImpl = (deps && deps.fetch) || fetch;
  if (!event || event.httpMethod !== "POST") {
    return json(405, { ok: false, error: "method_not_allowed" });
  }
  const raw = rawBody(event);
  if (raw.length > MAX_BODY) return json(413, { ok: false, error: "payload_too_large" });
  let payload;
  try { payload = JSON.parse(raw || ""); } catch (e) { payload = null; }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return json(400, { ok: false, error: "invalid_json" });
  }
  if (honeypotFilled(payload)) {
    log({ fn: "create-lead", result: "rejected" });
    return json(400, { ok: false, routed: false, error: "rejected" });
  }

  const stage = pick(payload.stage);
  if (stage !== "partial" && stage !== "complete") {
    return json(400, { ok: false, routed: false, error: "stage_required" });
  }

  const mapped = mapLead(payload);
  if (!mapped.ok) {
    const body = { ok: false, routed: false, error: mapped.error };
    if (mapped.missing && mapped.missing.length) body.missing = mapped.missing;
    log({ fn: "create-lead", result: mapped.error, missing: mapped.missing || [] });
    return json(400, body);
  }

  const cfg = loadConfig(env);
  if (!cfg.ok) {
    const body = { ok: false, routed: false, error: "lead_routing_unconfigured" };
    if (cfg.missing.length) body.missing = cfg.missing;
    if (cfg.invalid.length) body.invalid = cfg.invalid;
    log({ fn: "create-lead", result: "unconfigured", missing: cfg.missing, invalid: cfg.invalid }, cfg);
    return json(503, body);
  }

  const now = deps && typeof deps.now === "number" ? deps.now : Date.now();
  const proof = typeof payload.continuation === "string" ? payload.continuation : "";
  let checked = null;
  if (proof) checked = verifyContinuation(cfg.secret, proof, now);

  if (stage === "complete") {
    if (!proof) return json(401, { ok: false, routed: false, error: "continuation_required" });
    if (!checked.claims) {
      const status = checked.error === "continuation_expired" ? 401 : 400;
      return json(status, { ok: false, routed: false, error: checked.error });
    }
    if (!identityMatches(payload, checked.claims)) {
      return json(403, { ok: false, routed: false, error: "continuation_mismatch" });
    }
    const text = motivation(mergedForUpdate(payload, checked.claims));
    if (!text) return json(400, { ok: false, routed: false, error: "field_too_long" });
    const updateBody = { p_lead: checked.claims.lead, p_patch: { seller_motivation: text } };
    try {
      const updated = await rpc(fetchImpl, cfg.base, "update_lead_details", updateBody, cfg.token);
      if (updated.status >= 200 && updated.status < 300 && updated.parsed && updated.parsed.ok === true) {
        log({ fn: "create-lead", result: "updated", status: updated.status }, cfg);
        return json(200, { ok: true, routed: true, continuation: proof });
      }
      log({ fn: "create-lead", result: "crm_error", status: updated.status }, cfg);
      return json(relayStatus(updated.status), { ok: false, routed: false, error: publicError(updated.parsed, cfg.token) });
    } catch (e) {
      log({ fn: "create-lead", result: "unreachable" }, cfg);
      return json(502, { ok: false, routed: false, error: "crm_unreachable" });
    }
  }

  if (checked && checked.claims && identityMatches(payload, checked.claims)) {
    log({ fn: "create-lead", result: "partial_retry" }, cfg);
    return json(200, { ok: true, routed: true, continuation: proof });
  }

  const crmBody = Object.assign({}, mapped.body, {
    p_source_key: cfg.source,
    p_campaign_id: cfg.campaign,
    p_assigned_to: null,
  });
  if (!Object.prototype.hasOwnProperty.call(crmBody, "p_assigned_to") || crmBody.p_assigned_to !== null) {
    return json(500, { ok: false, routed: false, error: "server_error" });
  }

  try {
    const found = await findExisting(fetchImpl, cfg, crmBody);
    if (found.error) return found.error;
    if (found.id) {
      log({ fn: "create-lead", result: "duplicate_existing" }, cfg);
      return json(409, { ok: false, routed: false, error: "duplicate_existing" });
    }
    // One new-lead event. Do not also call claim_lead. A later qualifier
    // update must not create a second row or send another notification.
    const created = await rpc(fetchImpl, cfg.base, "create_lead", crmBody, cfg.token);
    if (!(created.status >= 200 && created.status < 300 && created.parsed && created.parsed.ok === true)) {
      log({ fn: "create-lead", result: "crm_error", status: created.status }, cfg);
      return json(relayStatus(created.status), { ok: false, routed: false, error: publicError(created.parsed, cfg.token) });
    }
    const leadId = leadUuidFromCreate(created.parsed.data);
    if (!leadId) {
      log({ fn: "create-lead", result: "created_without_id", status: created.status }, cfg);
      return json(502, { ok: false, routed: false, error: "crm_rejected" });
    }
    const continuation = signContinuation(cfg.secret, {
      v: 1,
      lead: leadId,
      phone: phoneKey(payload.phone),
      email: emailKey(payload.email),
      attr: attrOf(payload),
      exp: Math.floor(now / 1000) + cfg.ttl,
    });
    log({ fn: "create-lead", result: "created", status: created.status }, cfg);
    return json(200, { ok: true, routed: true, continuation });
  } catch (e) {
    log({ fn: "create-lead", result: "unreachable" }, cfg);
    return json(502, { ok: false, routed: false, error: "crm_unreachable" });
  }
}

async function findExisting(fetchImpl, cfg, crmBody) {
  const byPhone = await rpc(fetchImpl, cfg.base, "lead_for_phone", { p: crmBody.p_phone }, cfg.token);
  const phoneHit = interpretLookup(byPhone.status, byPhone.parsed);
  if (phoneHit.error) {
    log({ fn: "create-lead", result: "crm_error", status: byPhone.status }, cfg);
    return { error: json(relayStatus(phoneHit.status), { ok: false, routed: false, error: publicError(byPhone.parsed, cfg.token) }) };
  }
  if (phoneHit.found) return { id: phoneHit.id };
  const byEmail = await rpc(fetchImpl, cfg.base, "lead_for_email", { p: crmBody.p_email }, cfg.token);
  const emailHit = interpretLookup(byEmail.status, byEmail.parsed);
  if (emailHit.error) {
    log({ fn: "create-lead", result: "crm_error", status: byEmail.status }, cfg);
    return { error: json(relayStatus(emailHit.status), { ok: false, routed: false, error: publicError(byEmail.parsed, cfg.token) }) };
  }
  if (emailHit.found) return { id: emailHit.id };
  return { id: "" };
}

exports.handler = async (event) => {
  try {
    return await handle(event);
  } catch (e) {
    return json(500, { ok: false, error: "server_error" });
  }
};
exports.handle = handle;
exports.mapLead = mapLead;
exports.parseAddress = parseAddress;
exports.honeypotFilled = honeypotFilled;
exports.signContinuation = signContinuation;
exports.DEFAULT_API_BASE = DEFAULT_API_BASE;
