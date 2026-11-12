/**
 * intake-reserve v6 — DRAFT / NOT DEPLOYED / ships only in Taylor's bundled final review. Rollback = v5 source
 * (/workspace/fsho-runtime-reservations-v1/edge-intake-reserve-draft/index.ts, unchanged). Sentinel Dev, Nov 9 2026.
 *
 * Everything v5 does is unchanged (HMAC ops reserve/complete/recover/reconcile, mint, /sign 410, limits) — proven by
 * running the v5 test suites unchanged against this file (v5_index_test.ts, v5_payload-bind_test.ts).
 * Envelope/HMAC/payload-digest helpers come from ../_shared/envelope.ts (same module intake-park uses).
 *
 * NEW in v6
 *  A) Token mode for the Zap (header `x-intake-zap-token`, secret INTAKE_ZAP_TOKEN, >=32 chars). The Zap never holds
 *     INTAKE_HMAC_KEY_V1 or the service-role key. Allowed ops ONLY: /verify, /complete, /reconcile.
 *       /verify    {reservation_id, intake_id?, owner_token?}  -> lookup_intake_checkpoint (315d; no PII, never owner_token)
 *       /complete  {reservation_id, owner_token, reservation_generation, session_binding, remote_id?, intake_id?, +optional fields}
 *                  -> complete_checkpoint (CAS on owner_token, unchanged) then, if optional fields, stage_intake_enrich
 *       /reconcile {reservation_id, owner_token, reason?} -> mark_reconcile_owned (315d; owner must match)
 *     Token unset -> token mode answers 503 zap_mode_not_configured; HMAC mode unaffected. Wrong token -> 401 and
 *     counts toward the bad-auth limiter. Any other op with the header -> 403. /verify without the header -> 401.
 *  B) owner_token fix: on HMAC /reserve with no owner_token, the edge mints one (UUID), passes it to reserve_intake
 *     and returns it ONCE to the HMAC-authenticated producer (only on dispatch_intended_committed) so it can hand
 *     it to the Zap. A supplied owner_token must be 1-128 printable chars. Never logged.
 *  C) Optional write-once tracking on /reserve and /complete. Post-Hot enrichment is NOT accepted here any more
 *     (400 `enrichment`, C1 fix 5:02 PM ET): the site sends it to /intake-park/enrich; the Zap is the only completer.
 *     Older text:
 *     (edge/_shared/intake_fields.ts; HMAC: inside the signed payload; token: in the body). /complete returns
 *     priority_tier (from complete_checkpoint, 315d; refreshed by stage_intake_enrich when enrichment is sent).
 *     HMAC /reconcile also reads `reason` from the signed payload (v5 read only top-level body.reason).
 *     Validated (400 bad_input on bad values) BEFORE any DB call; stored via
 *     stage_intake_enrich only after complete succeeds (best effort, reported as enrich_status).
 *  D) complete_checkpoint delivered_stage fix is SQL-only (315d), signature unchanged — v5 benefits too.
 */

import {
  canonicalLines, canonicalPayloadJson, checkEnvelope, clampInt, clientIp, hmacHex, payloadDigest, PayloadError,
  readCapped, timingSafeEqualHex, timingSafeEqualStr,
} from "../_shared/envelope.ts";
import { checkOptionalFields } from "../_shared/intake_fields.ts";
export { canonicalLines, canonicalPayloadJson, checkEnvelope, payloadDigest, PayloadError, readCapped, timingSafeEqualHex };
const MAX_TTL = 900; void MAX_TTL;
type Rpc = (fn: string, args: Record<string, unknown>) => Promise<{ data: unknown; error: { message: string } | null }>;

export interface Cfg {
  hmacKey: string;
  kid: string;
  rpc: Rpc;
  now?: () => number; // ms
  perIpPerMin?: number;
  globalPerMin?: number;
  memPerIpPerMin?: number;
  badSigPer10Min?: number;
  maxBodyBytes?: number;
  zapToken?: string;   // INTAKE_ZAP_TOKEN; unset/short -> token mode disabled (503)
}

const OPS = new Set(["mint", "reserve", "complete", "recover", "reconcile", "verify"]);
const ZAP_TOKEN_OPS = new Set(["verify", "complete", "reconcile"]);
const DISABLED_OPS = new Set(["sign"]);
const SIGNED_OPS = new Set(["reserve", "complete", "recover", "reconcile"]);

const PAYLOAD_REQUIRED_OPS = new Set(["reserve", "complete"]);

/** Per-isolate best-effort limiter (no DB). Bounded map size. */
export class MemLimiter {
  private m = new Map<string, { win: number; n: number; badWin: number; bad: number }>();
  constructor(private perMin: number, private badPer10: number, private maxKeys = 5000) {}
  private get(ip: string, nowMs: number) {
    let e = this.m.get(ip);
    if (!e) {
      if (this.m.size >= this.maxKeys) this.m.clear();
      e = { win: Math.floor(nowMs / 60000), n: 0, badWin: Math.floor(nowMs / 600000), bad: 0 };
      this.m.set(ip, e);
    }
    const w = Math.floor(nowMs / 60000), bw = Math.floor(nowMs / 600000);
    if (e.win !== w) { e.win = w; e.n = 0; }
    if (e.badWin !== bw) { e.badWin = bw; e.bad = 0; }
    return e;
  }
  /** Returns retry-after seconds if blocked, else 0. */
  hit(ip: string, nowMs: number): number {
    const e = this.get(ip, nowMs);
    if (e.bad >= this.badPer10) return Math.max(1, Math.ceil(((e.badWin + 1) * 600000 - nowMs) / 1000));
    e.n++;
    if (e.n > this.perMin) return Math.max(1, Math.ceil(((e.win + 1) * 60000 - nowMs) / 1000));
    return 0;
  }
  bad(ip: string, nowMs: number) { this.get(ip, nowMs).bad++; }
}

const CORS = { "access-control-allow-origin": "*" };

function json(body: unknown, status = 200, extra: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...CORS, ...extra },
  });
}

function rpcDocFromVerified(verified: Record<string, string>, extra: Record<string, unknown> = {}) {
  return {
    intake_id: verified.intake_id,
    session_binding: String(extra.session_binding ?? ""),
    stage: verified.stage,
    destination: String(extra.destination ?? ""),
    event_id: verified.event_id,
    payload_sha256: verified.payload_sha256,
    route_id: verified.route,
    key_id: verified.kid,
    intake_channel: verified.channel,
    ...extra,
  };
}

export function makeHandler(cfg: Cfg) {
  const now = cfg.now ?? (() => Date.now());
  const perIp = clampInt(cfg.perIpPerMin, 30, 1, 10000);
  const glob = clampInt(cfg.globalPerMin, 300, 1, 100000);
  const maxBody = clampInt(cfg.maxBodyBytes, 16384, 1024, 1048576);
  const mem = new MemLimiter(clampInt(cfg.memPerIpPerMin, 60, 1, 10000), clampInt(cfg.badSigPer10Min, 10, 1, 1000));
  const configured = typeof cfg.hmacKey === "string" && cfg.hmacKey.length >= 32;
  const zapConfigured = typeof cfg.zapToken === "string" && cfg.zapToken.length >= 32;

  async function durableLimit(ip: string): Promise<Response | null> {
    const client_key = await hmacHex(cfg.hmacKey, "rl:" + ip);
    let res;
    try {
      res = await cfg.rpc("intake_rate_limit_hit", { p_doc: { client_key, per_ip_limit: perIp, global_limit: glob } });
    } catch {
      return json({ ok: false, status: "limiter_unavailable" }, 503, { "retry-after": "30" });
    }
    const d = res.data as { allowed?: boolean; retry_after?: number } | null;
    if (res.error || !d) return json({ ok: false, status: "limiter_unavailable" }, 503, { "retry-after": "30" });
    if (d.allowed === true) return null;
    if (typeof d.retry_after === "number") {
      const ra = String(clampInt(d.retry_after, 60, 1, 3600));
      return json({ ok: false, status: "rate_limited" }, 429, { "retry-after": ra });
    }
    return json({ ok: false, status: "limiter_unavailable" }, 503, { "retry-after": "30" });
  }

  function ownerTokenOk(v: unknown): v is string {
    return typeof v === "string" && v.length >= 1 && v.length <= 128 && !/[\u0000-\u001f\u007f]/.test(v);
  }
  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const SHORT = (v: unknown, max: number) => typeof v === "string" && v.length >= 1 && v.length <= max && !/[\u0000-\u001f\u007f]/.test(v);

  async function enrich(intake_id: string, o: { tracking: Record<string, string>; enrichment: Record<string, string> }):
      Promise<{ enrich_status: string; priority_tier?: string | null }> {
    try {
      const r = await cfg.rpc("stage_intake_enrich", { p_doc: { intake_id, ...o.tracking,
        ...(Object.keys(o.enrichment).length ? { enrichment: o.enrichment } : {}) } });
      const d = r.data as { status?: string; priority_tier?: string | null } | null;
      if (r.error || !d) return { enrich_status: "enrich_error" };
      // stage_intake_enrich returns the fresh priority_tier (null unless the row is Hot) -> it wins over complete's value.
      return d.status === "saved" ? { enrich_status: "saved", priority_tier: d.priority_tier ?? null } : { enrich_status: String(d.status ?? "enrich_error") };
    } catch { return { enrich_status: "enrich_error" }; }
  }

  // Token-mode ops. Inputs are plain body fields (no envelope); every field is shape-checked before any RPC.
  async function tokenOp(op: string, body: Record<string, unknown>): Promise<Response> {
    const bad: string[] = [];
    if (!(typeof body.reservation_id === "string" && UUID_RE.test(body.reservation_id))) bad.push("reservation_id");
    if (body.intake_id !== undefined && !SHORT(body.intake_id, 128)) bad.push("intake_id");
    if (op === "verify") {
      if (body.owner_token !== undefined && !ownerTokenOk(body.owner_token)) bad.push("owner_token");
      if (bad.length) return json({ ok: false, status: "bad_input", fields: bad }, 400);
      const { data, error } = await cfg.rpc("lookup_intake_checkpoint", { p_doc: {
        reservation_id: body.reservation_id, ...(body.intake_id ? { intake_id: body.intake_id } : {}),
        ...(body.owner_token ? { owner_token: body.owner_token } : {}) } });
      if (error) return json({ ok: false, status: "lookup_unavailable" }, 503, { "retry-after": "5" });
      const d = (data ?? {}) as Record<string, unknown>;
      const ALLOWED = ["ok", "status", "intake_id", "reservation_id", "stage", "destination", "reservation_state",
        "reservation_generation", "effect_delivery_state", "remote_id_present", "ledger_delivered_stage", "staging_tier",
        "priority_tier", "owner_match", "fields", "execution_requested", "exactly_once_external",
        // Nov 10: Hot path data for the Zap, only filled by 315d when owner_match is true and the row is Hot:
        "late_hot", "crm_lead_uuid", "campaign_id", "hot_alert"];
      const safe: Record<string, unknown> = {};
      for (const k of ALLOWED) if (k in d) safe[k] = d[k];
      return json(safe, d.ok === true ? 200 : d.status === "not_found" ? 404 : 400);
    }
    if (!ownerTokenOk(body.owner_token)) bad.push("owner_token");
    if (op === "reconcile") {
      if (body.reason !== undefined && !SHORT(body.reason, 200)) bad.push("reason");
      if (bad.length) return json({ ok: false, status: "bad_input", fields: bad }, 400);
      const { data, error } = await cfg.rpc("mark_reconcile_owned", { p_doc: {
        reservation_id: body.reservation_id, owner_token: body.owner_token, reason: body.reason ?? "zap_reported_uncertain" } });
      if (error) return json({ ok: false, status: "reconcile_unavailable" }, 503, { "retry-after": "5" });
      return json(data ?? { ok: false });
    }
    // complete
    if (!(Number.isInteger(body.reservation_generation) && (body.reservation_generation as number) >= 0)) bad.push("reservation_generation");
    if (!SHORT(body.session_binding, 128)) bad.push("session_binding");
    if (body.remote_id !== undefined && body.remote_id !== null && !SHORT(body.remote_id, 128)) bad.push("remote_id");
    // Enrichment is never accepted on complete (C1 fix): the site sends it to /intake-park/enrich; the Zap only completes.
    if (body.enrichment !== undefined) bad.push("enrichment");
    const oc = checkOptionalFields({ ...body, enrichment: undefined });
    if (!oc.ok) bad.push(...oc.fields);
    const wantsEnrich = oc.ok && (Object.keys(oc.tracking).length > 0 || Object.keys(oc.enrichment).length > 0);
    if (wantsEnrich && !body.intake_id) bad.push("intake_id");
    if (bad.length) return json({ ok: false, status: "bad_input", fields: bad }, 400);
    const { data, error } = await cfg.rpc("complete_checkpoint", { p_doc: {
      reservation_id: body.reservation_id, owner_token: body.owner_token, reservation_generation: body.reservation_generation,
      session_binding: body.session_binding, ...(body.remote_id ? { remote_id: body.remote_id } : {}) } });
    if (error) return json({ ok: false, status: "complete_unavailable", needs_reconcile: true }, 503, { "retry-after": "5" });
    const out = (data ?? { ok: false }) as Record<string, unknown>;
    if (out.ok === true && wantsEnrich && oc.ok) {
      // Bind enrichment to the reservation's own intake: owner must match the intake the Zap named.
      const lk = await cfg.rpc("lookup_intake_checkpoint", { p_doc: { reservation_id: body.reservation_id, intake_id: body.intake_id, owner_token: body.owner_token } });
      const l = lk.data as { ok?: boolean; owner_match?: boolean } | null;
      const e = !lk.error && l?.ok === true && l.owner_match === true ? await enrich(String(body.intake_id), oc) : { enrich_status: "enrich_skipped_intake_mismatch" };
      return json({ ...out, ...e });
    }
    return json(out);
  }

  return async function handler(req: Request): Promise<Response> {
    if (req.method === "OPTIONS") {
      return new Response(null, {
        headers: {
          ...CORS,
          "access-control-allow-headers": "authorization, content-type, x-intake-zap-token",
          "access-control-allow-methods": "POST, OPTIONS",
        },
      });
    }
    if (req.method !== "POST") return json({ error: "POST only" }, 405, { allow: "POST, OPTIONS" });

    const op = new URL(req.url).pathname.split("/").filter(Boolean).pop() ?? "";
    if (DISABLED_OPS.has(op)) return json({ ok: false, status: "gone", error: "/sign is disabled" }, 410);
    if (!OPS.has(op)) {
      return json({ error: "unknown op", routes: ["POST /mint", "POST /reserve", "POST /complete", "POST /recover", "POST /reconcile", "POST /verify (zap token)"] }, 404);
    }
    if (!configured) return json({ ok: false, status: "not_configured" }, 503);

    const cl = req.headers.get("content-length");
    if (cl !== null && (!/^\d+$/.test(cl) || Number(cl) > maxBody)) {
      return json({ ok: false, status: "payload_too_large" }, 413);
    }

    const ip = clientIp(req);
    const nowMs = now();
    const memRetry = mem.hit(ip, nowMs);
    if (memRetry > 0) return json({ ok: false, status: "rate_limited" }, 429, { "retry-after": String(memRetry) });

    const text = await readCapped(req, maxBody);
    if (text === null) return json({ ok: false, status: "payload_too_large" }, 413);
    let body: Record<string, unknown> = {};
    if (text.trim().length > 0) {
      try {
        const parsed = JSON.parse(text);
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("x");
        body = parsed as Record<string, unknown>;
      } catch {
        return json({ ok: false, status: "bad_json" }, 400);
      }
    }

    // ---- v6 token mode (Zap). Header presence selects the mode; HMAC mode is untouched when absent. ----
    const zapHdr = req.headers.get("x-intake-zap-token");
    if (zapHdr !== null) {
      if (!ZAP_TOKEN_OPS.has(op)) return json({ ok: false, status: "op_not_allowed_in_token_mode" }, 403);
      if (!zapConfigured) return json({ ok: false, status: "zap_mode_not_configured" }, 503);
      if (!timingSafeEqualStr(zapHdr, cfg.zapToken as string)) { mem.bad(ip, nowMs); return json({ ok: false, status: "auth_failed" }, 401); }
      const limited = await durableLimit(ip);
      if (limited) return limited;
      return await tokenOp(op, body);
    }
    if (op === "verify") { mem.bad(ip, nowMs); return json({ ok: false, status: "auth_failed" }, 401); }

    if (SIGNED_OPS.has(op)) {
      const env = (body.envelope && typeof body.envelope === "object" ? body.envelope : body) as Record<string, unknown>;
      const chk = checkEnvelope(env, cfg.kid, Math.floor(nowMs / 1000));
      if (!chk.ok) { mem.bad(ip, nowMs); return json({ ok: false, status: "auth_failed" }, 401); }
      const expected = await hmacHex(cfg.hmacKey, canonicalLines(chk.fields));
      if (!timingSafeEqualHex(expected, chk.sig)) { mem.bad(ip, nowMs); return json({ ok: false, status: "auth_failed" }, 401); }

      // Payload binding (no DB): recompute digest from body.payload and compare to signed value.
      if (PAYLOAD_REQUIRED_OPS.has(op) || (body.payload !== undefined && body.payload !== null)) {
        let actual: string;
        try {
          actual = await payloadDigest(body.payload);
        } catch (e) {
          mem.bad(ip, nowMs);
          return json({ ok: false, status: e instanceof PayloadError ? e.code : "payload_invalid" }, 400);
        }
        if (!timingSafeEqualHex(actual, chk.fields.payload_sha256.toLowerCase())) {
          mem.bad(ip, nowMs);
          return json({ ok: false, status: "payload_digest_mismatch" }, 401);
        }
      }

      // v6: optional tracking/enrichment inside the signed payload (complete), owner_token shape (reserve). No DB yet.
      // Write-once tracking is accepted on reserve AND complete (inside the signed payload); enrichment only on complete.
      let opt: { tracking: Record<string, string>; enrichment: Record<string, string> } | null = null;
      const pl = body.payload && typeof body.payload === "object" && !Array.isArray(body.payload) ? body.payload as Record<string, unknown> : null;
      if ((op === "complete" || op === "reserve") && pl) {
        // Enrichment is never accepted on reserve or complete: the site sends it to /intake-park/enrich (C1 fix, 5:02 PM ET).
        if (pl.enrichment !== undefined) return json({ ok: false, status: "bad_input", fields: ["enrichment"] }, 400);
        const oc = checkOptionalFields(pl);
        if (!oc.ok) return json({ ok: false, status: "bad_input", fields: oc.fields }, 400);
        if (Object.keys(oc.tracking).length || Object.keys(oc.enrichment).length) opt = oc;
      }
      // HMAC reconcile: reason may be top-level (v5) or inside the signed payload (preferred); <=200 printable chars.
      const reason = body.reason !== undefined ? body.reason : pl?.reason;
      if (op === "reconcile" && reason !== undefined && !SHORT(reason, 200)) return json({ ok: false, status: "bad_input", fields: ["reason"] }, 400);
      let mintedOwner: string | null = null;
      if (op === "reserve") {
        if (body.owner_token === undefined || body.owner_token === null || body.owner_token === "") mintedOwner = crypto.randomUUID();
        else if (!ownerTokenOk(body.owner_token)) return json({ ok: false, status: "bad_input", fields: ["owner_token"] }, 400);
      }

      const limited = await durableLimit(ip);
      if (limited) return limited;

      const fields = chk.fields;
      if (op === "recover") {
        const { data, error } = await cfg.rpc("recover_intake", {
          p_intake_id: fields.intake_id,
          p_session_binding: String(body.session_binding ?? ""),
          p_expected_generation: body.expected_generation,
        });
        if (error) return json({ error: error.message }, 400);
        return json(data ?? { ok: false });
      }
      const rpcMap: Record<string, string> = { reserve: "reserve_intake", complete: "complete_checkpoint", reconcile: "mark_reconcile" };
      const doc = rpcDocFromVerified(fields, {
        session_binding: body.session_binding,
        destination: body.destination,
        owner_token: mintedOwner ?? body.owner_token,
        reservation_id: body.reservation_id,
        reservation_generation: body.reservation_generation,
        remote_id: body.remote_id,
        lease_seconds: body.lease_seconds,
        reason,
      });
      const { data, error } = await cfg.rpc(rpcMap[op], { p_doc: doc });
      if (error) return json({ error: error.message }, 400);
      const out = (data ?? { ok: false }) as Record<string, unknown>;
      const committed = op === "reserve" && out.ok === true && out.status === "dispatch_intended_committed";
      const extra: Record<string, unknown> = {};
      if (committed && mintedOwner) Object.assign(extra, { owner_token: mintedOwner, owner_token_issued: true });
      if (opt && ((op === "complete" && out.ok === true) || committed)) {
        const e = await enrich(fields.intake_id, opt);
        extra.enrich_status = e.enrich_status;
        if (op === "complete" && "priority_tier" in e) extra.priority_tier = e.priority_tier;
      }
      if (Object.keys(extra).length) return json({ ...out, ...extra });
      return json(out);
    }

    // mint: unauthenticated; returns random UUIDs + kid only (no signature, no key material).
    const limited = await durableLimit(ip);
    if (limited) return limited;
    return json({
      ok: true,
      intake_id: crypto.randomUUID(),
      session_binding: crypto.randomUUID(),
      kid: cfg.kid,
      intake_id_producer: "intake-reserve",
      execution_requested: false,
      exactly_once_external: false,
    });
  };
}

if (Deno.env.get("INTAKE_RESERVE_TEST") !== "1") {
  const { createClient } = await import("https://esm.sh/@supabase/supabase-js@2");
  const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
    auth: { persistSession: false },
  });
  const e = (k: string) => Deno.env.get(k);
  const handler = makeHandler({
    hmacKey: e("INTAKE_HMAC_KEY_V1") ?? "",
    kid: e("INTAKE_HMAC_KID") ?? "sk_prod_website_v1",
    rpc: (fn, args) => admin.rpc(fn, args) as unknown as ReturnType<Rpc>,
    perIpPerMin: clampInt(e("INTAKE_RL_PER_IP_PER_MIN"), 30, 1, 10000),
    globalPerMin: clampInt(e("INTAKE_RL_GLOBAL_PER_MIN"), 300, 1, 100000),
    memPerIpPerMin: clampInt(e("INTAKE_RL_MEM_PER_IP_PER_MIN"), 60, 1, 10000),
    badSigPer10Min: clampInt(e("INTAKE_RL_BADSIG_PER_10MIN"), 10, 1, 1000),
    maxBodyBytes: clampInt(e("INTAKE_MAX_BODY_BYTES"), 16384, 1024, 1048576),
    zapToken: e("INTAKE_ZAP_TOKEN") ?? "",
  });
  Deno.serve(handler);
}
