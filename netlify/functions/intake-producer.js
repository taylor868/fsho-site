"use strict";

// Signs edge calls with HMAC-SHA256 over canonicalLines from edge/envelope.ts.
// The line order is fixed: v, kid, route, channel, intake_id, event_id, stage, ts, exp, payload_sha256.
// payload_sha256 is SHA-256 of canonical JSON (sorted keys, no spaces).
// session_binding is sent only on park and reserve. Answer, claim, and enrich are {envelope, payload}.
// A 503 on enrich is retried once. A Catch Hook failure is retried once, then reconciled.

const crypto = require("crypto");

const CLICKS = ["gclid", "gbraid", "wbraid", "fbclid"];
const UTMS = ["utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content", "utm_id"];
const TRACK_KEYS = CLICKS.concat(UTMS).concat(["lead_id"]);
const CLICK_RE = /^[A-Za-z0-9._~-]{1,256}$/;
const UTM_RE = /^[^\u0000-\u001f\u007f<>]{1,200}$/;
const LEAD_RE = /^[A-Za-z0-9_-]{1,64}$/;
const ANSWER_RE = /^[a-z0-9_]{1,64}$/;
const QUESTIONS = { type: 1, ownership: 1, timeline: 1, situation: 1, equity: 1, ability: 1 };
const ENRICH = {
  occupancy: { owner_occupied: 1, tenant_occupied: 1, vacant: 1, unknown: 1 },
  condition: { excellent: 1, good: 1, fair: 1, needs_work: 1, major_repairs: 1 },
  listed: { not_listed: 1, listed_under_90: 1, listed_over_90: 1, expired: 1 },
  timeline: { asap: 1, "30d": 1, "30_90d": 1, over_90d: 1, no_rush: 1 }
};
const COOKIE = "fsho_intake";

function canonicalJson(value, depth) {
  if (value === null) return "null";
  const kind = typeof value;
  if (kind === "number") {
    if (!Number.isFinite(value) || Math.floor(value) !== value) throw new Error("canonical_number");
    return String(value);
  }
  if (kind === "boolean") return value ? "true" : "false";
  if (kind === "string") return JSON.stringify(value);
  const level = depth || 0;
  if (level > 32) throw new Error("canonical_depth");
  if (Array.isArray(value)) return "[" + value.map((item) => canonicalJson(item, level + 1)).join(",") + "]";
  const keys = Object.keys(value).filter((key) => value[key] !== undefined).sort();
  return "{" + keys.map((key) => JSON.stringify(key) + ":" + canonicalJson(value[key], level + 1)).join(",") + "}";
}

const LINE_ORDER = ["v", "kid", "route", "channel", "intake_id", "event_id", "stage", "ts", "exp", "payload_sha256"];

function canonicalLines(fields) {
  return LINE_ORDER.map((key) => key + "=" + (fields[key] == null ? "" : String(fields[key]))).join("\n");
}

function stripControls(value) {
  return String(value == null ? "" : value).replace(/[\u0000-\u001f\u007f]/g, "").slice(0, 200);
}

function sha256(text) {
  return crypto.createHash("sha256").update(text).digest("hex");
}

function signFields(fields, key) {
  return crypto.createHmac("sha256", key).update(canonicalLines(fields)).digest("hex");
}

function isIp(value) {
  if (typeof value !== "string") return false;
  const ip = value.trim();
  if (!ip || ip.length > 45 || ip.indexOf("%") >= 0 || ip.indexOf("/") >= 0) return false;
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(ip)) {
    return ip.split(".").every((part) => {
      if (part.length > 1 && part[0] === "0") return false;
      const n = Number(part);
      return n >= 0 && n <= 255;
    });
  }
  if (ip.indexOf(":") < 0 || ip.indexOf(".") >= 0) return false;
  if (!/^[0-9a-fA-F:]+$/.test(ip)) return false;
  return ip.split("::").length <= 2;
}

function clientIp(headers) {
  const raw = headers["x-nf-client-connection-ip"] || headers["X-NF-Client-Connection-IP"] || "";
  const ip = String(raw).split(",")[0].trim();
  return isIp(ip) ? ip : "";
}

function cookies(header) {
  const out = {};
  String(header || "").split(";").forEach((part) => {
    const cut = part.indexOf("=");
    if (cut > 0) out[part.slice(0, cut).trim()] = decodeURIComponent(part.slice(cut + 1).trim());
  });
  return out;
}

function cookieKey(env) {
  if (env && env.INTAKE_COOKIE_KEY) return crypto.createHash("sha256").update(String(env.INTAKE_COOKIE_KEY), "utf8").digest();
  return crypto.hkdfSync("sha256", Buffer.from(String(env.INTAKE_HMAC_KEY_V1), "utf8"), Buffer.alloc(0), Buffer.from("fsho-intake-cookie-v1", "utf8"), 32);
}

function seal(obj, key) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const body = Buffer.concat([cipher.update(JSON.stringify(obj), "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, body]).toString("base64url");
}

function open(token, key) {
  try {
    const buf = Buffer.from(String(token || ""), "base64url");
    if (buf.length < 29) return null;
    const iv = buf.subarray(0, 12);
    const tag = buf.subarray(12, 28);
    const body = buf.subarray(28);
    const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAuthTag(tag);
    const json = Buffer.concat([decipher.update(body), decipher.final()]).toString("utf8");
    const obj = JSON.parse(json);
    return obj && typeof obj === "object" ? obj : null;
  } catch (e) {
    return null;
  }
}

function cookieHeader(token) {
  return COOKIE + "=" + token + "; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=86400";
}

function bad(status, body, extra) {
  return {
    statusCode: status,
    headers: Object.assign({ "content-type": "application/json" }, extra || {}),
    body: JSON.stringify(body)
  };
}

function trackingErrors(input) {
  const fields = [];
  const out = {};
  CLICKS.forEach((key) => {
    if (input[key] == null || input[key] === "") return;
    if (typeof input[key] === "string" && CLICK_RE.test(input[key])) out[key] = input[key];
    else fields.push(key);
  });
  UTMS.forEach((key) => {
    if (input[key] == null || input[key] === "") return;
    if (typeof input[key] === "string" && UTM_RE.test(input[key])) out[key] = input[key];
    else fields.push(key);
  });
  if (input.lead_id != null && input.lead_id !== "") {
    if (typeof input.lead_id === "string" && LEAD_RE.test(input.lead_id)) out.lead_id = input.lead_id;
    else fields.push("lead_id");
  }
  return { fields, tracking: out };
}

function stick(state, incoming) {
  state.tracking = state.tracking || {};
  TRACK_KEYS.forEach((key) => {
    if (!state.tracking[key] && incoming[key]) state.tracking[key] = incoming[key];
  });
}

function banned(input) {
  const found = [];
  function walk(value, depth) {
    if (!value || typeof value !== "object" || depth > 6) return;
    Object.keys(value).forEach((key) => {
      if (key === "attribution" || key === "price_vs_value") found.push(key);
      else walk(value[key], depth + 1);
    });
  }
  walk(input, 0);
  return found;
}

function enrichmentOf(input) {
  if (input == null) return { fields: ["enrichment"], enrichment: null };
  if (typeof input !== "object" || Array.isArray(input)) return { fields: ["enrichment"], enrichment: null };
  const enrichment = {};
  const fields = [];
  Object.keys(input).forEach((key) => {
    if (!ENRICH[key]) { fields.push("enrichment." + key); return; }
    if (input[key] == null || input[key] === "") return;
    if (typeof input[key] !== "string" || !ENRICH[key][input[key]]) fields.push("enrichment." + key);
    else enrichment[key] = input[key];
  });
  return { fields, enrichment };
}

function envelopeFor(env, state, stage, payload, now) {
  const ts = Math.floor(now() / 1000);
  const fields = {
    v: "1",
    kid: env.INTAKE_HMAC_KID,
    route: "ppc_inhouse",
    channel: "website",
    intake_id: state.intake_id,
    event_id: crypto.randomUUID(),
    stage,
    ts,
    exp: ts + 900,
    payload_sha256: sha256(canonicalJson(payload))
  };
  fields.sig = signFields(fields, env.INTAKE_HMAC_KEY_V1);
  return fields;
}

function publicBody(edge) {
  const out = {};
  ["ok", "status", "tier", "priority_tier", "claimed", "fields", "geocode_status"].forEach((key) => {
    if (edge[key] !== undefined) out[key] = edge[key];
  });
  if (out.status === "late_hot" && (out.tier === "hot" || out.tier == null)) {
    out.status = "claimed";
    out.tier = "hot";
    out.claimed = true;
    out.ok = out.ok !== false;
  }
  return out;
}

async function readEdge(res) {
  const status = res && res.status ? res.status : 0;
  let body = {};
  try { body = await res.json(); } catch (e) { body = { status: "bad_json" }; }
  if (!body || typeof body !== "object") body = {};
  const retry = res.headers && res.headers.get ? (res.headers.get("retry-after") || "") : "";
  return { status, body, retry };
}

async function handle(event, deps) {
  const env = (deps && deps.env) || process.env;
  const doFetch = deps && deps.fetch;
  const now = (deps && deps.now) || Date.now;
  const method = String((event && event.httpMethod) || "").toUpperCase();
  if (method !== "POST") return bad(405, { ok: false, status: "method_not_allowed" });
  if (!env.INTAKE_HMAC_KEY_V1 || !env.INTAKE_HMAC_KID || !env.INTAKE_EDGE_BASE_URL || !env.INTAKE_ZAP_HOOK_URL || typeof doFetch !== "function") {
    return bad(503, { ok: false, status: "not_configured" });
  }
  let input = {};
  try { input = JSON.parse(event.body || ""); } catch (e) { return bad(400, { ok: false, status: "bad_json" }); }
  if (!input || typeof input !== "object" || Array.isArray(input)) return bad(400, { ok: false, status: "bad_json" });
  const refused = banned(input);
  if (refused.length) return bad(400, { ok: false, status: "bad_input", fields: refused });
  const op = String(input.op || "");
  const ops = { mint: 1, park: 1, answer: 1, claim: 1, enrich: 1, reserve: 1 };
  if (!ops[op]) return bad(404, { ok: false, status: "unknown_op" });
  const headers = event.headers || {};
  const jar = cookies(headers.cookie || headers.Cookie || "");
  const ckey = cookieKey(env);
  let state = open(jar[COOKIE], ckey) || {};
  const base = String(env.INTAKE_EDGE_BASE_URL).replace(/\/$/, "");
  const ip = clientIp(headers);

  async function edge(path, body) {
    let res;
    try {
      res = await doFetch(base + path, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body)
      });
    } catch (e) {
      return { status: 503, body: { ok: false, status: "edge_unavailable" }, retry: "" };
    }
    return readEdge(res);
  }

  async function mint() {
    const minted = await edge("/intake-reserve/mint", {});
    if (minted.status !== 200 || !minted.body.intake_id || !minted.body.session_binding) return minted;
    state.intake_id = minted.body.intake_id;
    state.session_binding = minted.body.session_binding;
    state.kid = minted.body.kid || env.INTAKE_HMAC_KID;
    return minted;
  }

  if (!state.intake_id) {
    const minted = await mint();
    if (!state.intake_id) {
      const fail = publicBody(Object.assign({ ok: false, status: minted.body.status || "not_configured" }, minted.body));
      return bad(minted.status || 503, fail, minted.retry ? { "retry-after": minted.retry } : null);
    }
  }
  if (op === "mint") return respond(env, state, 200, { ok: true, status: "minted" });

  const tracked = trackingErrors(input);
  if (tracked.fields.length) return respond(env, state, 400, { ok: false, status: "bad_input", fields: tracked.fields });
  stick(state, tracked.tracking);
  const needsIp = op === "park" || op === "answer" || op === "claim" || op === "enrich";
  if (needsIp && !ip) return respond(env, state, 400, { ok: false, status: "bad_input", fields: ["client_ip"] });

  let payload = Object.assign({}, state.tracking);
  if (needsIp) payload.client_ip = ip;
  if (op === "park") {
    const full = typeof input.full_name === "string" ? input.full_name.trim() : "";
    const line = typeof input.address_line === "string" ? input.address_line.trim() : "";
    const phone = String(input.phone || "").replace(/\D/g, "");
    const email = typeof input.email === "string" ? input.email.trim() : "";
    const fields = [];
    if (!full || full.length > 160) fields.push("full_name");
    if (line.length < 3 || line.length > 200) fields.push("address_line");
    if (phone.length < 10 || phone.length > 11) fields.push("phone");
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) || email.length > 200) fields.push("email");
    if (input.is_test != null && typeof input.is_test !== "boolean") fields.push("is_test");
    if (input.consent != null && typeof input.consent !== "boolean") fields.push("consent");
    if (fields.length) return respond(env, state, 400, { ok: false, status: "bad_input", fields });
    payload.full_name = full;
    payload.address_line = line;
    payload.phone = phone;
    payload.email = email;
    // intake-park stores is_test only when the boolean is true (p.is_test === true).
    // false, including when the client omits the flag, is a real lead.
    payload.is_test = input.is_test === true;
    // consent is not an edge column. Unknown park keys are ignored, except attribution and price_vs_value.
    payload.consent = input.consent === true;
    state.contact = { full_name: full, phone, email, address_line: line, consent: payload.consent };
  } else if (op === "answer") {
    const fields = [];
    if (!QUESTIONS[input.question]) fields.push("question");
    if (typeof input.answer !== "string" || !ANSWER_RE.test(input.answer)) fields.push("answer");
    if (fields.length) return respond(env, state, 400, { ok: false, status: "bad_input", fields });
    payload.question = input.question;
    payload.answer = input.answer;
  } else if (op === "claim") {
    if (input.by !== "promote" && input.by !== "non_owner") return respond(env, state, 400, { ok: false, status: "bad_input", fields: ["by"] });
    payload.by = input.by;
  } else if (op === "enrich") {
    const checked = enrichmentOf(input.enrichment);
    if (checked.fields.length) return respond(env, state, 400, { ok: false, status: "bad_input", fields: checked.fields });
    payload.enrichment = checked.enrichment;
  } else if (op === "reserve") {
    if (!state.contact) return respond(env, state, 400, { ok: false, status: "bad_input", fields: ["contact"] });
    payload = Object.assign({}, state.tracking);
  }

  const stage = op === "reserve" ? (input.stage === "first" ? "first" : "final") : "partial";
  const envFields = envelopeFor(env, state, stage, payload, now);
  const edgeBody = { envelope: envFields, payload };
  if (op === "park" || op === "reserve") edgeBody.session_binding = state.session_binding;
  if (op === "reserve") {
    state.owner_token = state.owner_token || crypto.randomUUID();
    edgeBody.destination = input.destination === "crm_update" ? "crm_update" : "crm_create";
    edgeBody.owner_token = state.owner_token;
    edgeBody.lease_seconds = 120;
    state.reserve_stage = stage;
  }
  const path = op === "reserve" ? "/intake-reserve/reserve" : "/intake-park/" + op;
  let result = await edge(path, edgeBody);
  if (op === "enrich" && result.status === 503) {
    await new Promise((resolve) => setTimeout(resolve, deps && deps.retryMs != null ? deps.retryMs : 40));
    result = await edge(path, envelopeRetry(env, state, payload, now));
  }
  const committed = result.body.status === "dispatch_intended_committed" || result.body.status === "idempotent_replay";
  if (op === "reserve" && result.status === 200 && result.body.ok !== false && committed) {
    state.reservation_id = result.body.reservation_id || state.reservation_id || "";
    state.reservation_generation = result.body.reservation_generation || state.reservation_generation || 1;
    if (result.body.owner_token) state.owner_token = result.body.owner_token;
    if (!state.zap_sent) {
      const hookBody = JSON.stringify({
        intake_id: state.intake_id,
        reservation_id: state.reservation_id,
        reservation_generation: state.reservation_generation,
        session_binding: state.session_binding,
        owner_token: state.owner_token,
        full_name: state.contact.full_name,
        phone: state.contact.phone,
        email: state.contact.email,
        address_line: state.contact.address_line,
        consent: state.contact.consent === true
      });
      let hook = await postHook(doFetch, env.INTAKE_ZAP_HOOK_URL, hookBody);
      if (!hookOk(hook)) hook = await postHook(doFetch, env.INTAKE_ZAP_HOOK_URL, hookBody);
      if (!hookOk(hook)) {
        const reason = stripControls("hook_uncertain");
        const payload = { reason: reason };
        const stage = state.reserve_stage === "first" ? "first" : "final";
        const envFields = envelopeFor(env, state, stage, payload, now);
        await edge("/intake-reserve/reconcile", { envelope: envFields, payload: payload, reservation_id: state.reservation_id });
        console.log(String(state.reservation_id || ""));
        return respond(env, state, 200, { ok: false, status: "needs_reconcile" });
      }
      state.zap_sent = true;
    }
  }
  const extra = {};
  if (result.retry) extra["retry-after"] = result.retry;
  return respond(env, state, result.status || 502, publicBody(result.body), extra);
}

function hookOk(hook) {
  return !!(hook && hook.status >= 200 && hook.status < 300);
}

async function postHook(doFetch, url, body) {
  try {
    return await doFetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: body });
  } catch (e) {
    return null;
  }
}

function envelopeRetry(env, state, payload, now) {
  const envFields = envelopeFor(env, state, "partial", payload, now);
  return { envelope: envFields, payload: payload };
}

function respond(env, state, status, body, extra) {
  const headers = Object.assign({ "content-type": "application/json", "set-cookie": cookieHeader(seal(state, cookieKey(env))) }, extra || {});
  return { statusCode: status, headers, body: JSON.stringify(body) };
}

exports.handle = handle;
exports.handler = (event) => handle(event, { env: process.env, fetch: global.fetch });
exports.canonicalJson = canonicalJson;
exports.canonicalLines = canonicalLines;
exports.signFields = signFields;
exports.cookieKey = cookieKey;
exports.stripControls = stripControls;
