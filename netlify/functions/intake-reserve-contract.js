"use strict";

const crypto = require("crypto");

// Frozen target is deployed intake-reserve v3. /sign returns 410 and is never called.
// KID is the literal v1. The HMAC key is the UTF-8 bytes of a 64-char lowercase hex
// string, not the decoded hex. Netlify cannot scope that secret to functions yet.

const RESERVE_BASE = "https://ruedjugpbuagyapunytd.supabase.co/functions/v1/intake-reserve";
const REQUIRED_KID = "v1";
const NETLIFY_ENV_STATUS = "BLOCKED_NETLIFY_ENV";
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
  payload_bind: "pending_not_approved",
  stage_map: { partial: "first", complete: "final", first: "first", final: "final" },
  authorize_statuses: ["dispatch_intended_committed", "idempotent_replay", "recovered"],
  max_rate_limit_retries: 1,
  max_backoff_ms: 2000,
};

const PENDING = [
  "BLOCKED_NETLIFY_ENV: INTAKE_HMAC_KEY_V1 and INTAKE_HMAC_KID stay the env names, and the key is not set on Netlify Free",
  "index.payload-bind.ts is not approved; body.payload and the canonical digest are already what that patch would recompute",
  "reservation lookup mode is PENDING_DEPLOY",
  "hesel_fb and ppc_inhouse bindings are UNVERIFIED-pending-Taylor",
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

function quote(value) {
  let out = "\"";
  for (const ch of value) {
    const cp = ch.codePointAt(0);
    if (cp >= 0xd800 && cp <= 0xdfff) {
      const error = new Error("lone_surrogate");
      error.code = "lone_surrogate";
      throw error;
    }
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

function canonicalJson(value) {
  if (value === null) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") {
    if (!Number.isFinite(value) || !Number.isInteger(value)) {
      const error = new Error("decimal_rejected");
      error.code = "decimal_rejected";
      throw error;
    }
    if (!Number.isSafeInteger(value)) {
      const error = new Error("integer_unsafe");
      error.code = "integer_unsafe";
      throw error;
    }
    return String(value);
  }
  if (typeof value === "string") return quote(value);
  if (Array.isArray(value)) return "[" + value.map(canonicalJson).join(",") + "]";
  if (typeof value === "object") {
    const keys = Object.keys(value).sort(compareKeys);
    return "{" + keys.map((key) => quote(key) + ":" + canonicalJson(value[key])).join(",") + "}";
  }
  const error = new Error("unsupported_type");
  error.code = "unsupported_type";
  throw error;
}

function sanitizeValue(value) {
  if (value == null) return undefined;
  if (typeof value === "string") return value;
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") {
    if (Number.isSafeInteger(value)) return value;
    if (Number.isFinite(value)) return String(value);
    const error = new Error("number_rejected");
    error.code = "number_rejected";
    throw error;
  }
  if (Array.isArray(value)) {
    const items = [];
    for (const item of value) {
      const next = sanitizeValue(item);
      if (next !== undefined) items.push(next);
    }
    return items;
  }
  if (typeof value === "object") {
    const out = {};
    for (const key of Object.keys(value)) {
      const next = sanitizeValue(value[key]);
      if (next !== undefined) out[key] = next;
    }
    return out;
  }
  return String(value);
}

function leadPayload(input) {
  const out = {};
  for (const key of Object.keys(input || {})) {
    if (STRIP[key]) continue;
    const value = sanitizeValue(input[key]);
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
