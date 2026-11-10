/**
 * intake-park — stage-1 park + park-time geocode (Sentinel Dev, DRAFT, NOT DEPLOYED).
 * Ships only inside Taylor's single bundled final review (A0: GEOCODIO_API_KEY secret + 315a + this fn + site).
 *
 * Canonical paths (bare /intake-park is 404):
 * POST /functions/v1/intake-park/park    payload {full_name|first_name(+last_name?), phone, email, address_line, line1?, city?, state?,
 *                                                 postal?, client_ip, is_test?, tracking?, enrichment?} + top-level session_binding
 * POST /functions/v1/intake-park/answer  payload {question, answer, client_ip, tracking?}         -> stage_intake_answer
 * POST /functions/v1/intake-park/claim   payload {by:"promote"|"non_owner", client_ip, tracking?} -> claim_intake_graded
 *   All: HMAC envelope (stage "partial", channel "website"), payload bound by payload_sha256. Shapes: ../CALL-SHAPES.md.
 * client_ip is REQUIRED (the request IP is the producer's): validated as an IP literal, HMAC'd for the limiter, never stored.
 * No free-form attribution: only the tracking fields in ../_shared/intake_fields.ts are accepted.
 * Durable rate limit (311b pattern, 315a intake_park_rate_limit_hit): after auth, before any write. Fails closed (503).
 * Order (README of ../../geocode): verify HMAC → validate → stage_intake_contact (row written, geocode_status='pending')
 *   → geocode() [cache → geocode_take_quota → Geocodio, 2.5 s] → stage_intake_geocode. Geocode NEVER fails park.
 * Response never contains contact data or geocode coordinates: {ok, status:"parked", intake_id, geocode_status}.
 * Secrets are read only via the injected env (Deno.env in index.ts). Nothing here logs a secret.
 */
import { checkEnvelope, canonicalLines, hmacHex, timingSafeEqualHex, readCapped, payloadDigest, PayloadError } from "../_shared/envelope.ts";
import { checkOptionalFields } from "../_shared/intake_fields.ts";
import { isIpLiteral, parseFormattedAddress, splitFullName } from "../_shared/address_name.ts";
import { geocode, redactSecrets, type GeocodeResult, type GeocodeCache } from "../_shared/geocode.ts";

export type RpcResult = { data: unknown; error: { message: string } | null };
export interface ParkDeps {
  hmacKey: string;
  kid: string;
  geocodioKey: string;                 // may be "" → geocode_status "failed", park still succeeds
  rpc: (fn: string, args: Record<string, unknown>) => Promise<RpcResult>;
  cache?: GeocodeCache;
  geoFetch: typeof fetch;              // only used by geocode() for Geocodio
  now?: () => number;
  log?: (line: string) => void;        // structured, secret-free
  geocodeTimeoutMs?: number;           // default 2500
  dailyLimit?: number;                 // default 800
  maxBodyBytes?: number;               // default 16384
  parkPerIpPerMin?: number;            // default 30 (one visit = park + ~6 answers + claim)
  parkGlobalPerMin?: number;           // default 300
}

// qualifier.json v3 question ids (MWD). Answers are the option values (lowercase snake), graded server-side.
const QUESTIONS = new Set(["type", "ownership", "timeline", "situation", "equity", "ability"]);
const CORS = { "access-control-allow-origin": "*" };
function json(body: unknown, status = 200, extra: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...CORS, ...extra } });
}

const STR = (v: unknown, min: number, max: number) => typeof v === "string" && v.trim().length >= min && v.trim().length <= max;
export function validatePayload(p: unknown): { ok: true; v: Record<string, unknown> } | { ok: false; fields: string[] } {
  if (!p || typeof p !== "object" || Array.isArray(p)) return { ok: false, fields: ["payload"] };
  const o = p as Record<string, unknown>; const bad: string[] = [];
  // Name: full_name (one form field) OR first_name; last_name optional. Server splits full_name when first is absent.
  if (o.full_name !== undefined && !STR(o.full_name, 1, 160)) bad.push("full_name");
  if (o.first_name !== undefined && !STR(o.first_name, 1, 80)) bad.push("first_name");
  if (o.last_name !== undefined && !STR(o.last_name, 1, 80)) bad.push("last_name");
  if (o.full_name === undefined && o.first_name === undefined) bad.push("full_name");
  const digits = typeof o.phone === "string" ? o.phone.replace(/\D/g, "") : "";
  if (!(digits.length === 10 || (digits.length === 11 && digits.startsWith("1")))) bad.push("phone");
  if (!(typeof o.email === "string" && o.email.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(o.email))) bad.push("email");
  // Address: address_line (single line, required); line1/city/state/postal optional, validated when sent.
  if (!STR(o.address_line, 3, 200)) bad.push("address_line");
  if (o.line1 !== undefined && !STR(o.line1, 1, 200)) bad.push("line1");
  if (o.city !== undefined && !STR(o.city, 1, 80)) bad.push("city");
  if (o.state !== undefined && !(typeof o.state === "string" && /^[A-Za-z]{2}$/.test(o.state))) bad.push("state");
  if (o.postal !== undefined && !(typeof o.postal === "string" && /^\d{5}(-\d{4})?$/.test(o.postal))) bad.push("postal");
  // attribution / price_vs_value -> 400 via checkOptionalFields (shared with intake-reserve v6)
  if (o.is_test !== undefined && typeof o.is_test !== "boolean") bad.push("is_test");
  if (!isIpLiteral(o.client_ip)) bad.push("client_ip");          // REQUIRED: visitor IP from the producer (request IP is Netlify)
  const opt = checkOptionalFields(o);
  if (!opt.ok) bad.push(...opt.fields);
  return bad.length ? { ok: false, fields: bad } : { ok: true, v: o };
}

export function makeParkHandler(d: ParkDeps) {
  const now = d.now ?? (() => Date.now());
  const log = d.log ?? ((l: string) => console.log(l));
  const safeLog = (o: Record<string, unknown>) => log(redactSecrets(redactSecrets(JSON.stringify(o), d.geocodioKey), d.hmacKey));
  const maxBody = d.maxBodyBytes ?? 16384;
  const configured = typeof d.hmacKey === "string" && d.hmacKey.length >= 32;


  async function rateLimit(p: Record<string, unknown>, req: Request, intake_id: string): Promise<Response | null> {
    void req;   // the request IP is the producer's (Netlify), never the visitor's — not used
    const ip = String(p.client_ip);             // validated isIpLiteral before we get here
    let rl: RpcResult;
    try {
      rl = await d.rpc("intake_park_rate_limit_hit", { p_doc: { client_key: await hmacHex(d.hmacKey, "park-rl:" + ip),
        per_ip_limit: d.parkPerIpPerMin ?? 30, global_limit: d.parkGlobalPerMin ?? 300 } });
    } catch { rl = { data: null, error: { message: "rpc_threw" } }; }
    const rld = rl.data as { allowed?: boolean; retry_after?: number } | null;
    if (rl.error || !rld) return json({ ok: false, status: "limiter_unavailable" }, 503, { "retry-after": "30" });
    if (rld.allowed === true) return null;
    if (typeof rld.retry_after === "number") {
      safeLog({ evt: "park_rate_limited", intake_id });
      return json({ ok: false, status: "rate_limited" }, 429, { "retry-after": String(Math.min(3600, Math.max(1, Math.floor(rld.retry_after)))) });
    }
    return json({ ok: false, status: "limiter_unavailable" }, 503, { "retry-after": "30" });
  }

  // /answer {question, answer, client_ip, +tracking}   -> stage_intake_answer
  // /claim  {by: "promote"|"non_owner", client_ip, +tracking} -> claim_intake_graded (server grades from stored answers)
  async function answerOrClaim(op: string, intake_id: string, payload: unknown, req: Request): Promise<Response> {
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) return json({ ok: false, status: "bad_input", fields: ["payload"] }, 400);
    const p = payload as Record<string, unknown>; const bad: string[] = [];
    if (!isIpLiteral(p.client_ip)) bad.push("client_ip");
    let doc: Record<string, unknown>;
    if (op === "answer") {
      if (!(typeof p.question === "string" && QUESTIONS.has(p.question))) bad.push("question");
      if (!(typeof p.answer === "string" && /^[a-z0-9_]{1,64}$/.test(p.answer))) bad.push("answer");
      const opt = checkOptionalFields(p);
      if (!opt.ok) bad.push(...opt.fields);
      else if (Object.keys(opt.enrichment).length) bad.push("enrichment");   // enrichment goes on /complete (post-Hot), not /answer
      if (bad.length) return json({ ok: false, status: "bad_input", fields: bad }, 400);
      doc = { intake_id, question: p.question, answer: p.answer, ...(opt as { tracking: Record<string, string> }).tracking };
    } else {
      if (!(p.by === "promote" || p.by === "non_owner")) bad.push("by");
      const opt = checkOptionalFields(p);
      if (!opt.ok) bad.push(...opt.fields);
      else if (Object.keys(opt.enrichment).length) bad.push("enrichment");   // enrichment goes on /complete (post-Hot)
      if (bad.length) return json({ ok: false, status: "bad_input", fields: bad }, 400);
      doc = { intake_id, by: p.by, ...(opt as { tracking: Record<string, string> }).tracking };
    }
    const limited = await rateLimit(p, req, intake_id);
    if (limited) return limited;
    let r: RpcResult;
    try { r = await d.rpc(op === "answer" ? "stage_intake_answer" : "claim_intake_graded", { p_doc: doc }); }
    catch { r = { data: null, error: { message: "rpc_threw" } }; }
    if (r.error || !r.data) { safeLog({ evt: op + "_failed", intake_id }); return json({ ok: false, status: op + "_unavailable" }, 503, { "retry-after": "5" }); }
    const out = r.data as Record<string, unknown>;
    const code = out.ok === true ? 200 : out.status === "unknown_intake" ? 404 : out.status === "bad_input" ? 400 : 409;
    safeLog({ evt: op, intake_id, status: out.status ?? null });
    return json(out, code);
  }

  // /enrich {enrichment, client_ip, +tracking} -> stage_intake_enrich(require_hot). Post-Hot answers from the site.
  // Writes ONLY staging enrichment/priority_tier (+ write-once tracking). Never touches reservation, effect or ledger,
  // so it is safe before or after the Zap's /complete. Idempotent: same answers -> same row, same tier (latest-wins merge).
  async function enrichOp(intake_id: string, payload: unknown, req: Request): Promise<Response> {
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) return json({ ok: false, status: "bad_input", fields: ["payload"] }, 400);
    const p = payload as Record<string, unknown>; const bad: string[] = [];
    if (!isIpLiteral(p.client_ip)) bad.push("client_ip");
    if (!p.enrichment || typeof p.enrichment !== "object" || Array.isArray(p.enrichment)) bad.push("enrichment");
    const opt = checkOptionalFields(p);
    if (!opt.ok) bad.push(...opt.fields.filter((f) => !bad.includes(f)));
    if (bad.length) return json({ ok: false, status: "bad_input", fields: bad }, 400);
    const o = opt as { tracking: Record<string, string>; enrichment: Record<string, string> };
    const limited = await rateLimit(p, req, intake_id);
    if (limited) return limited;
    let r: RpcResult;
    try { r = await d.rpc("stage_intake_enrich", { p_doc: { intake_id, require_hot: true, ...o.tracking, enrichment: o.enrichment } }); }
    catch { r = { data: null, error: { message: "rpc_threw" } }; }
    if (r.error || !r.data) { safeLog({ evt: "enrich_failed", intake_id }); return json({ ok: false, status: "enrich_unavailable" }, 503, { "retry-after": "5" }); }
    const out = r.data as Record<string, unknown>;
    safeLog({ evt: "enrich", intake_id, status: out.status ?? null });
    if (out.ok === true) return json({ ok: true, status: "saved", priority_tier: out.priority_tier ?? null });
    const code = out.status === "unknown_intake" ? 404 : out.status === "bad_input" ? 400 : 409;   // not_hot -> 409
    return json({ ok: false, status: out.status, ...(out.fields ? { fields: out.fields } : {}) }, code);
  }

  return async function handler(req: Request): Promise<Response> {
    if (req.method === "OPTIONS") return new Response(null, { headers: { ...CORS, "access-control-allow-headers": "content-type", "access-control-allow-methods": "POST, OPTIONS" } });
    if (req.method !== "POST") return json({ ok: false, status: "method_not_allowed" }, 405, { allow: "POST, OPTIONS" });
    const last = new URL(req.url).pathname.split("/").filter(Boolean).pop() ?? "";
    // Canonical paths only: /intake-park/park | /intake-park/answer | /intake-park/claim (bare /intake-park is 404).
    const parts = new URL(req.url).pathname.split("/").filter(Boolean);
    const op = parts.length >= 2 && parts[parts.length - 2] === "intake-park" ? last : "";
    if (op !== "park" && op !== "answer" && op !== "claim" && op !== "enrich") return json({ ok: false, status: "unknown_op" }, 404);
    if (!configured) return json({ ok: false, status: "not_configured" }, 503);

    const text = await readCapped(req, maxBody);
    if (text === null) return json({ ok: false, status: "payload_too_large" }, 413);
    let body: Record<string, unknown>;
    try { const b = JSON.parse(text || "{}"); if (!b || typeof b !== "object" || Array.isArray(b)) throw 0; body = b; }
    catch { return json({ ok: false, status: "bad_json" }, 400); }

    // 1) Auth before anything touches the DB.
    const env = (body.envelope && typeof body.envelope === "object" ? body.envelope : {}) as Record<string, unknown>;
    const chk = checkEnvelope(env, d.kid, Math.floor(now() / 1000));
    if (!chk.ok) { safeLog({ evt: "park_auth_failed", reason: chk.reason }); return json({ ok: false, status: "auth_failed" }, 401); }
    const expected = await hmacHex(d.hmacKey, canonicalLines(chk.fields));
    if (!timingSafeEqualHex(expected, chk.sig)) { safeLog({ evt: "park_auth_failed", reason: "bad_sig" }); return json({ ok: false, status: "auth_failed" }, 401); }
    if (chk.fields.stage !== "partial") return json({ ok: false, status: "bad_stage" }, 400);
    if (chk.fields.channel !== "website") return json({ ok: false, status: "bad_channel" }, 400);
    try {
      if ((await payloadDigest(body.payload)) !== chk.fields.payload_sha256) {
        safeLog({ evt: "park_auth_failed", reason: "payload_digest_mismatch" });
        return json({ ok: false, status: "payload_digest_mismatch" }, 401);
      }
    } catch (e) { return json({ ok: false, status: e instanceof PayloadError ? e.code : "bad_payload" }, 400); }

    if (op === "enrich") return await enrichOp(chk.fields.intake_id, body.payload, req);
    if (op !== "park") return await answerOrClaim(op, chk.fields.intake_id, body.payload, req);

    // 2) Input validation.
    if (typeof body.session_binding !== "string" || !/^[0-9a-f-]{36}$/i.test(body.session_binding))
      return json({ ok: false, status: "bad_input", fields: ["session_binding"] }, 400);
    const val = validatePayload(body.payload);
    if (!val.ok) return json({ ok: false, status: "bad_input", fields: val.fields }, 400);
    const p = val.v;
    const intake_id = chk.fields.intake_id;
    const opt = checkOptionalFields(p) as { ok: true; tracking: Record<string, string>; enrichment: Record<string, string> };

    // 2b) Durable rate limit (311b pattern). Key = HMAC(visitor IP); raw IP never leaves this function.
    const limited = await rateLimit(p, req, intake_id);
    if (limited) return limited;

    const split = typeof p.full_name === "string" ? splitFullName(p.full_name) : null;
    const name = { full: typeof p.full_name === "string" ? p.full_name.trim().replace(/\s+/g, " ") : null,
      first: typeof p.first_name === "string" ? p.first_name.trim() : (split?.first || null),
      last: typeof p.last_name === "string" ? p.last_name.trim() : (typeof p.first_name === "string" ? null : split?.last ?? null) };

    // 3) Park: the row is written (geocode_status='pending') BEFORE any geocode work.
    let parked: RpcResult;
    try {
      parked = await d.rpc("stage_intake_contact", { p_doc: {
        intake_id, session_binding: body.session_binding, route_id: chk.fields.route, intake_channel: chk.fields.channel,
        full_name: name.full, first_name: name.first, last_name: name.last, phone: p.phone, email: String(p.email).trim(),
        address_line: String(p.address_line).trim(), line1: p.line1 ? String(p.line1).trim() : null, city: p.city ? String(p.city).trim() : null,
        state: p.state ? String(p.state).toUpperCase() : null, postal: p.postal ?? null,
        payload_sha256: chk.fields.payload_sha256, is_test: p.is_test === true,
        ...opt.tracking,
      } });
    } catch { parked = { data: null, error: { message: "rpc_threw" } }; }
    const pd = parked.data as { ok?: boolean; status?: string } | null;
    if (parked.error || !pd || pd.ok !== true) {
      safeLog({ evt: "park_failed", intake_id, status: pd?.status ?? "rpc_error" });
      return json({ ok: false, status: "park_unavailable" }, 503, { "retry-after": "5" });
    }

    // 3b) Optional enrichment at park: stored only (priority tier is set only once the row is Hot). Never fails park.
    if (Object.keys(opt.enrichment).length) {
      try { await d.rpc("stage_intake_enrich", { p_doc: { intake_id, enrichment: opt.enrichment } }); } catch { /* best effort */ }
    }

    // 4) Geocode — never fails park.
    let g: GeocodeResult | null = null;
    try {
      g = await geocode({ q: String(p.address_line).trim() }, {   // Geocodio q= on the single line as typed
        fetch: d.geoFetch, apiKey: d.geocodioKey, timeoutMs: d.geocodeTimeoutMs ?? 2500, dailyLimit: d.dailyLimit ?? 800,
        cache: d.cache,
        takeQuota: async () => {
          const r = await d.rpc("geocode_take_quota", { p_limit: d.dailyLimit ?? 800 });
          return !r.error && r.data === true;
        },
      });
    } catch { g = null; }
    const geocode_status = g?.status ?? "failed";
    const parsed = geocode_status === "ok" ? parseFormattedAddress(g?.formatted_address) : null;
    try {
      await d.rpc("stage_intake_geocode", { p_doc: {
        intake_id, geocode_status, lat: g?.lat ?? null, lng: g?.lng ?? null, accuracy: g?.accuracy ?? null,
        accuracy_type: g?.accuracy_type ?? null, county: g?.county ?? null, formatted_address: g?.formatted_address ?? null,
        provider: "geocodio", geocoded_at: g?.geocoded_at ?? new Date(now()).toISOString(), cache_key: g?.cache_key ?? null,
        // parsed parts (from formatted_address; SQL fills only parts the visitor did not send). status ok only.
        ...(parsed ? { parsed_line1: parsed.line1, parsed_city: parsed.city, parsed_state: parsed.state, parsed_postal: parsed.postal } : {}),
      } });
    } catch { /* geocode bookkeeping never blocks park */ }
    safeLog({ evt: "parked", intake_id, geocode_status, from_cache: g?.from_cache ?? false, detail: g?.detail ?? null });
    return json({ ok: true, status: "parked", intake_id, geocode_status });
  };
}
