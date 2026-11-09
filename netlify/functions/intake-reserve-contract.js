"use strict";

const crypto = require("crypto");

// Live edge is payload-bind v5. /sign returns 410 and is never called.
// KID is the literal v1. The HMAC key is the UTF-8 bytes of a 64-char lowercase hex
// string, not the decoded hex. Netlify has the env names set; the Free plan exposes
// them to all scopes and does not mark them secret.

const RESERVE_BASE = "https://ruedjugpbuagyapunytd.supabase.co/functions/v1/intake-reserve";
const REQUIRED_KID = "v1";
const NETLIFY_ENV_STATUS = "all-scopes, not marked secret (Free plan)";
const MAX_DEPTH = 32;
const CANONICAL_ORDER = ["v", "kid", "route", "channel", "intake_id", "event_id", "stage", "ts", "exp", "payload_sha256"];
const OPS = ["mint", "reserve", "complete", "recover", "reconcile"];
const TTL_SECONDS = 900;
const KEY_HEX = /^[0-9a-f]{64}$/;

const DRAFT = {
  version: "1",
  ttl_seconds: TTL_SECONDS,
  future_skew_seconds: 60,
  signature_location: "body.sig",
  payload_location: "body.payload",
  digest: "sha256_hex_utf8_python_canonical_json",
  payload_bind: "v5",
  max_depth: MAX_DEPTH,
  stage_map: { partial: "first", complete: "final", first: "first", final: "final" },
  authorize_statuses: ["dispatch_intended_committed", "idempotent_replay", "recovered"],
  max_rate_limit_retries: 1,
  max_backoff_ms: 2000,
};

const PENDING = [
  "reservation lookup mode is PENDING_DEPLOY",
];

const STRIP = {
  source: 1, source_tag: 1, detected_source: 1, intake_id: 1, session_binding: 1,
  continuation: 1, wc_lead_id: 1, wc_profile_id: 1, crm_lead_id: 1, p_lead: 1,
  reset: 1, recover: 1, company_website: 1,
};

function keyIsUtf8Hex(key) {
  return typeof key === "string" && KEY_HEX.test(key);
}

function canonicalString(fields) {
  return CANONICAL_ORDER.map((key) => key + "=" + (fields[key] == null ? "" : String(fields[key]))).join("\n");
}

function hmacHex(key, canonical) {
  return crypto.createHmac("sha256", Buffer.from(key, "utf8")).update(canonical, "utf8").digest("hex");
}

function reject(code) {
  const error = new Error(code);
  error.code = code;
  throw error;
}

function quote(value) {
  let out = "\"";
  for (const ch of value) {
    const cp = ch.codePointAt(0);
    if (cp >= 0xd800 && cp <= 0xdfff) reject("lone_surrogate");
    if (ch === "\"") out += "\\\"";
    else if (ch === "\\") out += "\\\\";
    else if (ch === "\b") out += "\\b";
    else if (ch === "\f") out += "\\f";
    else if (ch === "\n") out += "\\n";
    else if (ch === "\r") out += "\\r";
    else if (ch === "\t") out += "\\t";
    else if (cp < 0x20) out += "\\u" + cp.toString(16).padStart(4, "0");
    else out += ch;
  }
  return out + "\"";
}

function compareKeys(a, b) {
  const left = Array.from(a);
  const right = Array.from(b);
  const n = Math.min(left.length, right.length);
  for (let i = 0; i < n; i++) {
    const diff = left[i].codePointAt(0) - right[i].codePointAt(0);
    if (diff) return diff;
  }
  return left.length - right.length;
}

function canonicalJson(value, depth) {
  const level = depth == null ? 1 : depth;
  if (value === null) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") {
    if (Object.is(value, -0)) reject("negative_zero");
    if (!Number.isFinite(value) || !Number.isInteger(value)) reject("decimal_rejected");
    if (!Number.isSafeInteger(value)) reject("integer_unsafe");
    return String(value);
  }
  if (typeof value === "string") return quote(value);
  if (Array.isArray(value) || typeof value === "object") {
    if (level > MAX_DEPTH) reject("depth_rejected");
    const next = level + 1;
    if (Array.isArray(value)) return "[" + value.map((item) => canonicalJson(item, next)).join(",") + "]";
    const keys = Object.keys(value).sort(compareKeys);
    return "{" + keys.map((key) => quote(key) + ":" + canonicalJson(value[key], next)).join(",") + "}";
  }
  reject("unsupported_type");
}

function sanitizeValue(value, depth) {
  if (value == null) return undefined;
  if (typeof value === "string") {
    quote(value);
    return value;
  }
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") {
    if (Object.is(value, -0)) reject("negative_zero");
    if (Number.isSafeInteger(value)) return value;
    if (Number.isFinite(value) && !Number.isInteger(value)) return String(value);
    reject("number_rejected");
  }
  if (Array.isArray(value) || typeof value === "object") {
    if (depth > MAX_DEPTH) reject("depth_rejected");
    const next = depth + 1;
    if (Array.isArray(value)) {
      const items = [];
      for (const item of value) {
        const child = sanitizeValue(item, next);
        if (child !== undefined) items.push(child);
      }
      return items;
    }
    const out = {};
    for (const key of Object.keys(value)) {
      quote(key);
      const child = sanitizeValue(value[key], next);
      if (child !== undefined) out[key] = child;
    }
    return out;
  }
  return String(value);
}

function leadPayload(input) {
  const out = {};
  for (const key of Object.keys(input || {})) {
    if (STRIP[key]) continue;
    quote(key);
    const value = sanitizeValue(input[key], 2);
    if (value !== undefined) out[key] = value;
  }
  return out;
}

function payloadSha256(payload) {
  return crypto.createHash("sha256").update(Buffer.from(canonicalJson(payload), "utf8")).digest("hex");
}

function signEnvelope(key, kid, fields) {
  const envelope = {
    v: DRAFT.version,
    kid: String(kid),
    route: String(fields.route || ""),
    channel: String(fields.channel || ""),
    intake_id: String(fields.intake_id || ""),
    event_id: String(fields.event_id || ""),
    stage: String(fields.stage || ""),
    ts: String(fields.ts),
    exp: String(fields.exp),
    payload_sha256: String(fields.payload_sha256 || ""),
  };
  envelope.sig = hmacHex(key, canonicalString(envelope));
  return envelope;
}

function parseRetryAfterSeconds(header) {
  if (header == null || String(header).trim() === "") return { pending: true, reason: "retry_after_missing" };
  if (!/^\d+$/.test(String(header).trim())) return { pending: true, reason: "retry_after_not_seconds" };
  return { seconds: Number(header) };
}

function decide429(attempt, retryAfter) {
  if (retryAfter.pending) return { action: "stop", form_state: "kept", reason: retryAfter.reason };
  if (attempt >= DRAFT.max_rate_limit_retries) return { action: "stop", form_state: "kept", reason: "retry_budget" };
  if (retryAfter.seconds * 1000 > DRAFT.max_backoff_ms) {
    return { action: "stop", form_state: "kept", reason: "retry_after_exceeds_bound", retry_after_seconds: retryAfter.seconds };
  }
  return { action: "wait", ms: retryAfter.seconds * 1000, form_state: "kept" };
}

module.exports = {
  RESERVE_BASE,
  REQUIRED_KID,
  NETLIFY_ENV_STATUS,
  CANONICAL_ORDER,
  OPS,
  TTL_SECONDS,
  DRAFT,
  PENDING,
  PENDING_CONTRACT: PENDING,
  keyIsUtf8Hex,
  canonicalString,
  hmacHex,
  canonicalJson,
  sanitizeValue,
  leadPayload,
  payloadSha256,
  signEnvelope,
  parseRetryAfterSeconds,
  decide429,
};
