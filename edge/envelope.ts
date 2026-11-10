// SINGLE SHARED envelope module for intake-park AND intake-reserve v6 (Sentinel Dev). Both import this file, so they cannot drift.
// Logic = the helpers of the intake-reserve v5 draft (/workspace/fsho-runtime-reservations-v1/edge-intake-reserve-draft/index.ts),
// proven by edge/intake-reserve-v6/: the v5 test suites run unchanged against v6, which imports this file.

export const MAX_TTL = 900;
const MAX_SKEW = 60;
const REQUIRED = ["kid", "route", "channel", "intake_id", "event_id", "stage", "ts", "exp", "payload_sha256", "sig"];


const enc = new TextEncoder();

export function canonicalLines(fields: Record<string, string>): string {
  // Must match auth.py: v,kid,route,channel,intake_id,event_id,stage,ts,exp,payload_sha256
  const order = ["v", "kid", "route", "channel", "intake_id", "event_id", "stage", "ts", "exp", "payload_sha256"];
  return order.map((k) => `${k}=${fields[k] ?? ""}`).join("\n");
}

export async function hmacHex(key: string, msg: string): Promise<string> {
  const k = await crypto.subtle.importKey("raw", enc.encode(key), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", k, enc.encode(msg));
  return Array.from(new Uint8Array(sig)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function timingSafeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let ok = 0;
  for (let i = 0; i < a.length; i++) ok |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return ok === 0;
}

export function clientIp(req: Request): string {
  const cf = req.headers.get("cf-connecting-ip")?.trim();
  if (cf) return cf.slice(0, 64);
  const xff = req.headers.get("x-forwarded-for");
  if (xff) {
    const first = xff.split(",")[0].trim();
    if (first) return first.slice(0, 64);
  }
  return req.headers.get("x-real-ip")?.trim().slice(0, 64) || "unknown";
}

/** Read body with a hard byte cap. Returns null if over cap. */
export async function readCapped(req: Request, cap: number): Promise<string | null> {
  if (!req.body) return "";
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > cap) {
      try { await reader.cancel(); } catch { /* ignore */ }
      return null;
    }
    chunks.push(value);
  }
  const buf = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) { buf.set(c, off); off += c.byteLength; }
  return new TextDecoder().decode(buf);
}

/** Validate envelope shape + time window. Pure; no secrets. */
export function checkEnvelope(env: Record<string, unknown>, kid: string, nowSec: number):
  { ok: true; fields: Record<string, string>; sig: string } | { ok: false; reason: string } {
  for (const k of REQUIRED) {
    const v = env[k];
    if (typeof v !== "string" && typeof v !== "number") return { ok: false, reason: "missing_field" };
    if (String(v).length === 0 || String(v).length > 256) return { ok: false, reason: "bad_field" };
  }
  const fields: Record<string, string> = {
    v: String(env.v ?? "1"),
    kid: String(env.kid),
    route: String(env.route),
    channel: String(env.channel),
    intake_id: String(env.intake_id),
    event_id: String(env.event_id),
    stage: String(env.stage),
    ts: String(env.ts),
    exp: String(env.exp),
    payload_sha256: String(env.payload_sha256),
  };
  const sig = String(env.sig).toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(sig)) return { ok: false, reason: "bad_sig_format" };
  if (fields.kid !== kid) return { ok: false, reason: "bad_kid" };
  if (!/^\d{1,12}$/.test(fields.ts) || !/^\d{1,12}$/.test(fields.exp)) return { ok: false, reason: "bad_time" };
  const ts = Number(fields.ts), exp = Number(fields.exp);
  if (exp <= ts || exp - ts > MAX_TTL) return { ok: false, reason: "bad_ttl" };
  if (exp < nowSec) return { ok: false, reason: "expired" };
  if (ts > nowSec + MAX_SKEW) return { ok: false, reason: "future_ts" };
  if (ts < nowSec - MAX_TTL - MAX_SKEW) return { ok: false, reason: "stale_ts" };
  return { ok: true, fields, sig };
}


export class PayloadError extends Error {
  constructor(public code: string) { super(code); }
}

function cpCompare(a: string, b: string): number {
  // Python sorts str keys by code point; JS default sort uses UTF-16 code units.
  const A = Array.from(a), B = Array.from(b);
  const n = Math.min(A.length, B.length);
  for (let i = 0; i < n; i++) {
    const x = A[i].codePointAt(0)!, y = B[i].codePointAt(0)!;
    if (x !== y) return x - y;
  }
  return A.length - B.length;
}

const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

/** Python json.dumps(v, sort_keys=True, separators=(",",":"), ensure_ascii=False) equivalent. */
export function canonicalPayloadJson(v: unknown, depth = 0): string {
  if (depth > 32) throw new PayloadError("payload_too_deep");
  if (v === null) return "null";
  if (v === true) return "true";
  if (v === false) return "false";
  if (typeof v === "number") {
    if (!Number.isSafeInteger(v) || Object.is(v, -0)) throw new PayloadError("payload_unsupported_number");
    return String(v);
  }
  if (typeof v === "string") {
    if (LONE_SURROGATE.test(v)) throw new PayloadError("payload_invalid_string");
    return JSON.stringify(v); // same escapes as Python ensure_ascii=False for well-formed strings
  }
  if (Array.isArray(v)) return "[" + v.map((x) => canonicalPayloadJson(x, depth + 1)).join(",") + "]";
  if (typeof v === "object") {
    const o = v as Record<string, unknown>;
    const keys = Object.keys(o).sort(cpCompare);
    return "{" + keys.map((k) => {
      if (LONE_SURROGATE.test(k)) throw new PayloadError("payload_invalid_string");
      return JSON.stringify(k) + ":" + canonicalPayloadJson(o[k], depth + 1);
    }).join(",") + "}";
  }
  throw new PayloadError("payload_unsupported_type");
}

export async function payloadDigest(payload: unknown): Promise<string> {
  const p = payload === undefined || payload === null ? {} : payload;
  if (typeof p !== "object" || Array.isArray(p)) throw new PayloadError("payload_not_object");
  const bytes = enc.encode(canonicalPayloadJson(p));
  const d = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(d)).map((b) => b.toString(16).padStart(2, "0")).join("");
}


export function clampInt(v: string | number | undefined | null, def: number, min: number, max: number): number {
  const n = typeof v === "number" ? v : v == null || v === "" ? NaN : Number(v);
  if (!Number.isFinite(n) || !Number.isInteger(n)) return def;
  return Math.min(Math.max(n, min), max);
}

/** Constant-time compare for arbitrary strings (Zap token). Length leak only via the xor of lengths. */
export function timingSafeEqualStr(a: string, b: string): boolean {
  const ea = enc.encode(a), eb = enc.encode(b);
  let diff = ea.length ^ eb.length;
  for (let i = 0; i < Math.max(ea.length, eb.length); i++) diff |= (ea[i] ?? 0) ^ (eb[i] ?? 0);
  return diff === 0;
}
