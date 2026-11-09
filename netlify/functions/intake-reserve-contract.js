"use strict";

const crypto = require("crypto");

// Everything the edge draft pins, plus the unpinned list.
// Swap this file when Sentinel's deployed contract arrives.
// Draft source: intake-reserve-index.ts (not asserted to be the deployed build).

const CANONICAL_ORDER = ["v", "kid", "route", "channel", "intake_id", "event_id", "stage", "ts", "exp", "payload_sha256"];

const DRAFT = {
  version: "1",
  ttl_seconds: 900,
  future_skew_seconds: 60,
  kid_default_in_edge_draft: "sk_prod_website_v1",
  signature_location: "body.envelope.sig",
  digest_draft: "sha256_hex_utf8_raw_request_body",
  stage_map: { partial: "first", complete: "final", first: "first", final: "final" },
  authorize_statuses: ["dispatch_intended_committed", "idempotent_replay", "recovered"],
  max_rate_limit_retries: 1,
  max_backoff_ms: 2000,
};

const PENDING_CONTRACT = [
  "deployed intake-reserve source may differ from the edge draft",
  "INTAKE_RESERVE_URL is a proposed env name, not confirmed",
  "no signature header is defined; draft verifies envelope.sig only",
  "payload_sha256 algorithm is not computed by the edge draft",
  "stage enum is not enforced by the edge draft",
  "429 response body is not defined; only Retry-After was described",
  "Retry-After HTTP-date form is not specified",
  "reserve destination strings are not validated by the edge draft",
];

function canonicalString(fields) {
  return CANONICAL_ORDER.map((key) => key + "=" + (fields[key] == null ? "" : String(fields[key]))).join("\n");
}

function hmacHex(key, canonical) {
  return crypto.createHmac("sha256", key).update(canonical, "utf8").digest("hex");
}

function draftDigest(rawBodyUtf8) {
  return crypto.createHash("sha256").update(String(rawBodyUtf8), "utf8").digest("hex");
}

function draftVerify(key, expectedKid, envelope, nowSec) {
  const fields = {};
  for (const keyName of CANONICAL_ORDER) fields[keyName] = envelope[keyName] == null ? "" : String(envelope[keyName]);
  const sig = String(envelope.sig || "");
  const now = Number(nowSec);
  if (!sig || fields.kid !== expectedKid) return { ok: false, status: "auth_failed" };
  if (Number(fields.exp) < now || Number(fields.ts) > now + DRAFT.future_skew_seconds) {
    return { ok: false, status: "auth_failed" };
  }
  const expected = hmacHex(key, canonicalString(fields));
  if (expected.length !== sig.length) return { ok: false, status: "auth_failed" };
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ sig.charCodeAt(i);
  return diff === 0 ? { ok: true, fields } : { ok: false, status: "auth_failed" };
}

function signEnvelope(key, kid, fields) {
  const envelope = {
    v: DRAFT.version,
    kid,
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
  if (!/^\d+$/.test(String(header).trim())) return { pending: true, reason: "retry_after_http_date_pending" };
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
  CANONICAL_ORDER,
  DRAFT,
  PENDING_CONTRACT,
  canonicalString,
  hmacHex,
  draftDigest,
  draftVerify,
  signEnvelope,
  parseRetryAfterSeconds,
  decide429,
};
