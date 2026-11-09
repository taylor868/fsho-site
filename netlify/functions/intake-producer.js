"use strict";

const crypto = require("crypto");
const contract = require("./intake-reserve-contract");
const { routeFromEnv } = require("./intake-route-bindings");

const COOKIE = "fsho_intake";

function json(status, body, extraHeaders) {
  return {
    statusCode: status,
    headers: Object.assign({ "content-type": "application/json", "cache-control": "no-store" }, extraHeaders || {}),
    body: JSON.stringify(body),
  };
}

function cookieCanonical(fields) {
  return ["v=1", "intake_id=" + fields.intake_id, "session_binding=" + fields.session_binding, "generation=" + fields.generation, "route=" + fields.route, "channel=" + fields.channel].join("\n");
}

function sealCookie(key, fields) {
  const body = Buffer.from(JSON.stringify(fields)).toString("base64url");
  const sig = contract.hmacHex(key, cookieCanonical(fields));
  return COOKIE + "=" + body + "." + sig + "; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=7200";
}

function openCookie(key, header) {
  if (!header) return null;
  const match = String(header).split(/;\s*/).find((part) => part.indexOf(COOKIE + "=") === 0);
  if (!match) return null;
  const token = match.slice(COOKIE.length + 1);
  const dot = token.lastIndexOf(".");
  if (dot < 0) return null;
  let fields;
  try { fields = JSON.parse(Buffer.from(token.slice(0, dot), "base64url").toString("utf8")); } catch (e) { return null; }
  const sig = token.slice(dot + 1);
  const expected = contract.hmacHex(key, cookieCanonical(fields));
  if (expected.length !== sig.length) return null;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ sig.charCodeAt(i);
  return diff === 0 ? fields : null;
}

async function edgeCall(fetchImpl, sleep, base, op, payload) {
  let attempt = 0;
  for (;;) {
    const res = await fetchImpl(base.replace(/\/$/, "") + "/" + op, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify(payload),
    });
    if (res.status !== 429) {
      const text = await res.text();
      let parsed = null;
      try { parsed = text ? JSON.parse(text) : null; } catch (e) { parsed = null; }
      return { status: res.status, body: parsed };
    }
    const decision = contract.decide429(attempt, contract.parseRetryAfterSeconds(res.headers && res.headers.get ? res.headers.get("retry-after") : res.headers["retry-after"]));
    if (decision.action !== "wait") return { status: 429, rate_limited: decision, body: null };
    await sleep(decision.ms);
    attempt += 1;
  }
}

function publicLead(payload) {
  const copy = Object.assign({}, payload);
  delete copy.source;
  delete copy.source_tag;
  delete copy.detected_source;
  delete copy.intake_id;
  delete copy.session_binding;
  delete copy.continuation;
  delete copy.wc_lead_id;
  delete copy.wc_profile_id;
  delete copy.crm_lead_id;
  delete copy.p_lead;
  return copy;
}

async function handle(event, deps) {
  const env = (deps && deps.env) || {};
  const fetchImpl = deps && deps.fetch;
  const sleep = (deps && deps.sleep) || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const now = deps && typeof deps.now === "number" ? deps.now : Date.now();
  if (!event || event.httpMethod !== "POST") return json(405, { ok: false, error: "method_not_allowed" });
  let payload;
  try { payload = JSON.parse(event.body || ""); } catch (e) { payload = null; }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return json(400, { ok: false, error: "invalid_json" });
  if (typeof payload.company_website === "string" && payload.company_website.trim()) {
    return json(400, { ok: false, error: "rejected", form_state: "kept" });
  }
  const key = env.INTAKE_HMAC_KEY_V1;
  const kid = env.INTAKE_HMAC_KID;
  const reserveUrl = env.INTAKE_RESERVE_URL;
  if (!key || !kid || !reserveUrl) {
    return json(503, { ok: false, error: "intake_unconfigured", missing: ["INTAKE_HMAC_KEY_V1", "INTAKE_HMAC_KID", "INTAKE_RESERVE_URL"].filter((name) => !env[name]) });
  }
  const bound = routeFromEnv(env.FSHO_INTAKE_ROUTE);
  if (bound.blocked) {
    return json(409, { ok: false, error: "unknown_vendor", wc_action: "none", execution_requested: false, form_state: "kept" });
  }
  const stage = contract.DRAFT.stage_map[payload.stage];
  if (!stage) return json(400, { ok: false, error: "stage_required", form_state: "kept" });
  const held = payload.reset === true ? null : openCookie(key, event.headers && (event.headers.cookie || event.headers.Cookie));
  if ((stage === "final" || payload.recover === true) && !held) {
    return json(401, { ok: false, error: "continuation_required", form_state: "kept" });
  }
  let session = held;
  if (session && (payload.recover === true || stage === "first" || stage === "final")) {
    const recovered = await edgeCall(fetchImpl, sleep, reserveUrl, "recover", {
      envelope: signFor(key, kid, session, stage, event.body, now),
      session_binding: session.session_binding,
      expected_generation: session.generation,
    });
    if (recovered.rate_limited) return json(429, { ok: false, status: "rate_limited", form_state: "kept", retry_after_seconds: recovered.rate_limited.retry_after_seconds || null });
    if (!recovered.body || recovered.body.ok !== true) {
      return json(409, { ok: false, error: recovered.body && recovered.body.status || "recover_failed", form_state: "kept" });
    }
    if (typeof recovered.body.reservation_generation === "number") session.generation = recovered.body.reservation_generation;
    if (stage === "first") {
      return json(200, {
        ok: true,
        intake_id: session.intake_id,
        generation: session.generation,
        route_id: bound.route_id,
        wc_action: bound.wc_action,
        status: "recovered",
        execution_requested: false,
        form_state: "kept",
      }, { "set-cookie": sealCookie(key, session) });
    }
  }
  if (!session) {
    const minted = await edgeCall(fetchImpl, sleep, reserveUrl, "mint", {});
    if (minted.rate_limited) return json(429, { ok: false, status: "rate_limited", form_state: "kept", retry_after_seconds: minted.rate_limited.retry_after_seconds || null });
    if (!minted.body || minted.body.ok !== true || !minted.body.intake_id || !minted.body.session_binding) {
      return json(502, { ok: false, error: "mint_failed", form_state: "kept" });
    }
    session = { v: 1, intake_id: minted.body.intake_id, session_binding: minted.body.session_binding, generation: 1, route: bound.route_id, channel: "website" };
  }
  const envelope = signFor(key, kid, session, stage, event.body, now);
  const reserved = await edgeCall(fetchImpl, sleep, reserveUrl, "reserve", {
    envelope,
    session_binding: session.session_binding,
    destination: bound.wc_action === "reuse" ? "wc_update" : (stage === "final" ? "crm_update" : "wc_create"),
  });
  if (reserved.rate_limited) return json(429, { ok: false, status: "rate_limited", form_state: "kept", retry_after_seconds: reserved.rate_limited.retry_after_seconds || null });
  if (!reserved.body || reserved.body.ok !== true || contract.DRAFT.authorize_statuses.indexOf(reserved.body.status) < 0) {
    return json(409, { ok: false, error: reserved.body && reserved.body.status || "reserve_failed", form_state: "kept" });
  }
  if (typeof reserved.body.reservation_generation === "number") session.generation = reserved.body.reservation_generation;
  const hook = env.FSHO_CORE_ZAP_WEBHOOK_URL;
  if (!hook) return json(503, { ok: false, error: "hook_unconfigured", form_state: "kept" });
  const forwarded = await fetchImpl(hook, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      envelope,
      payload: publicLead(payload),
      route_binding: {
        route_id: bound.route_id,
        campaign_id: bound.campaign_id || null,
        lead_source_key: bound.lead_source_key || null,
        wc_action: bound.wc_action,
        verification: bound.verification,
      },
      execution_requested: false,
    }),
  });
  if (forwarded.status < 200 || forwarded.status >= 300) {
    return json(502, { ok: false, error: "hook_uncertain", needs_reconcile: true, form_state: "kept" });
  }
  return json(200, {
    ok: true,
    intake_id: session.intake_id,
    generation: session.generation,
    route_id: bound.route_id,
    wc_action: bound.wc_action,
    execution_requested: false,
    form_state: "kept",
  }, { "set-cookie": sealCookie(key, session) });
}

function signFor(key, kid, session, stage, rawBody, nowMs) {
  const ts = Math.floor(nowMs / 1000);
  return contract.signEnvelope(key, kid, {
    route: session.route,
    channel: session.channel,
    intake_id: session.intake_id,
    event_id: crypto.randomUUID(),
    stage,
    ts,
    exp: ts + contract.DRAFT.ttl_seconds,
    payload_sha256: contract.draftDigest(rawBody),
  });
}

exports.handle = handle;
exports.handler = handle;
exports.PENDING_CONTRACT = contract.PENDING_CONTRACT;
