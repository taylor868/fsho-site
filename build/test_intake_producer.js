"use strict";

const assert = require("node:assert/strict");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const test = require("node:test");

function load(name) {
  const local = path.join(__dirname, name + ".js");
  return require(fs.existsSync(local) ? local : path.join(__dirname, "../netlify/functions", name + ".js"));
}

const contract = load("intake-reserve-contract");
const { handle } = load("intake-producer");

const KEY = "ab".repeat(32);
const INTAKE = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const SESSION = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const NOW = 1700000000000;
const RESERVE = "https://reserve.example.test/intake-reserve";

const env = {
  INTAKE_HMAC_KEY_V1: KEY,
  INTAKE_HMAC_KID: "v1",
  FSHO_INTAKE_ROUTE: "ppc_inhouse",
  FSHO_CORE_ZAP_WEBHOOK_URL: "https://hooks.example.test/unit",
};

function lead(extra) {
  return Object.assign({
    stage: "partial",
    first: "TEST",
    last: "LEAD",
    phone: "5550000000",
    email: "test.lead@example.com",
    address: "100 Example Ave",
    source: "hesel_fb",
    intake_id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
    price: 12.5,
  }, extra || {});
}

function post(body, cookie) {
  return { httpMethod: "POST", body: JSON.stringify(body), headers: cookie ? { cookie } : {} };
}

function run(event, extraEnv, extra) {
  return handle(event, Object.assign({
    env: Object.assign({}, env, extraEnv || {}),
    reserveUrl: RESERVE,
    now: NOW,
  }, extra || {}));
}

function mock(sequence) {
  const calls = [];
  let i = 0;
  const fetchImpl = async (url, opts) => {
    const next = sequence[Math.min(i, sequence.length - 1)];
    i += 1;
    calls.push({ url, body: JSON.parse(opts.body), count: i });
    return {
      status: next.status,
      headers: { get: (name) => next.headers && next.headers[name.toLowerCase()] },
      text: async () => JSON.stringify(next.body || {}),
    };
  };
  return { fetchImpl, calls };
}

test("golden HMAC uses the utf8 hex string and kid v1", () => {
  assert.equal(contract.REQUIRED_KID, "v1");
  assert.equal(contract.RESERVE_BASE, "https://ruedjugpbuagyapunytd.supabase.co/functions/v1/intake-reserve");
  assert.equal(contract.OPS.indexOf("sign"), -1);
  assert.equal(contract.keyIsUtf8Hex(KEY), true);
  assert.equal(contract.keyIsUtf8Hex(KEY.toUpperCase()), false);
  const fields = {
    v: "1", kid: "v1", route: "ppc_inhouse", channel: "website",
    intake_id: INTAKE, event_id: "22222222-2222-4222-8222-222222222222",
    stage: "first", ts: "1700000000", exp: "1700000900",
    payload_sha256: "abc123",
  };
  const canonical = contract.canonicalString(fields);
  assert.equal(canonical, [
    "v=1", "kid=v1", "route=ppc_inhouse", "channel=website",
    "intake_id=" + INTAKE, "event_id=22222222-2222-4222-8222-222222222222",
    "stage=first", "ts=1700000000", "exp=1700000900", "payload_sha256=abc123",
  ].join("\n"));
  const utf8 = crypto.createHmac("sha256", Buffer.from(KEY, "utf8")).update(canonical, "utf8").digest("hex");
  const decoded = crypto.createHmac("sha256", Buffer.from(KEY, "hex")).update(canonical, "utf8").digest("hex");
  assert.equal(contract.hmacHex(KEY, canonical), utf8);
  assert.notEqual(utf8, decoded);
  const signed = contract.signEnvelope(KEY, "v1", fields);
  assert.equal(signed.sig, utf8);
  assert.equal(signed.kid, "v1");
});

test("a missing or default kid does not call the edge", async () => {
  const { fetchImpl, calls } = mock([]);
  const missing = await run(post(lead()), { INTAKE_HMAC_KEY_V1: "", INTAKE_HMAC_KID: "" }, { fetch: fetchImpl });
  assert.equal(missing.statusCode, 503);
  assert.equal(JSON.parse(missing.body).block, "BLOCKED_NETLIFY_ENV");
  const rejected = await run(post(lead()), { INTAKE_HMAC_KID: "sk_prod_website_v1" }, { fetch: fetchImpl });
  assert.equal(rejected.statusCode, 503);
  assert.equal(JSON.parse(rejected.body).error, "intake_key_rejected");
  assert.equal(calls.length, 0);
});

test("429 and 503 limiter_unavailable stay inside the backoff bound", async () => {
  const high = mock([{ status: 429, headers: { "retry-after": "30" }, body: { status: "rate_limited" } }]);
  const slept = [];
  const stopped = await run(post(lead()), {}, { fetch: high.fetchImpl, sleep: async (ms) => slept.push(ms) });
  assert.equal(stopped.statusCode, 429);
  assert.equal(JSON.parse(stopped.body).form_state, "kept");
  assert.equal(JSON.parse(stopped.body).retry_after_seconds, 30);
  assert.equal(high.calls.length, 1);
  assert.equal(slept.length, 0);

  const low = mock([
    { status: 503, headers: { "retry-after": "1" }, body: { status: "limiter_unavailable" } },
    { status: 200, body: { ok: true, intake_id: INTAKE, session_binding: SESSION } },
    { status: 200, body: { ok: true, status: "dispatch_intended_committed", reservation_generation: 1, reservation_id: "11111111-1111-4111-8111-111111111111" } },
    { status: 200, body: {} },
  ]);
  const waits = [];
  const resumed = await run(post(lead()), {}, { fetch: low.fetchImpl, sleep: async (ms) => waits.push(ms) });
  assert.equal(resumed.statusCode, 200);
  assert.deepEqual(waits, [1000]);
  assert.equal(low.calls.filter((call) => call.url.endsWith("/mint")).length, 2);
  assert.equal(low.calls.some((call) => call.url.endsWith("/sign")), false);
});

test("partial reserves a server id and complete reuses it", async () => {
  const { fetchImpl, calls } = mock([
    { status: 200, body: { ok: true, intake_id: INTAKE, session_binding: SESSION } },
    { status: 200, body: { ok: true, status: "dispatch_intended_committed", reservation_generation: 1, reservation_id: "11111111-1111-4111-8111-111111111111" } },
    { status: 200, body: {} },
    { status: 200, body: { ok: true, status: "recovered", ledger: { reservation_generation: 1 } } },
    { status: 200, body: { ok: true, status: "dispatch_intended_committed", reservation_generation: 1, reservation_id: "11111111-1111-4111-8111-111111111111" } },
    { status: 200, body: {} },
  ]);
  const first = await run(post(lead()), {}, { fetch: fetchImpl });
  const cookie = first.headers["set-cookie"];
  const body = JSON.parse(first.body);
  assert.equal(body.intake_id, INTAKE);
  assert.equal(body.wc_action, "create_once");
  assert.notEqual(body.intake_id, lead().intake_id);
  assert.equal(calls[1].body.destination, "wc_create");
  assert.equal(calls[1].body.route, "ppc_inhouse");
  assert.equal(calls[1].body.kid, "v1");
  assert.equal(calls[1].body.sig.length, 64);
  assert.equal(calls[1].body.payload.price, "12.5");
  assert.equal(calls[1].body.payload.source, undefined);
  assert.equal(calls[1].body.payload.intake_id, undefined);
  assert.equal(calls[1].body.payload_sha256, contract.payloadSha256(calls[1].body.payload));
  assert.equal(calls[2].url, env.FSHO_CORE_ZAP_WEBHOOK_URL);
  assert.equal(JSON.stringify(calls[2].body).includes(KEY), false);
  assert.equal(calls[2].body.route_binding.campaign_id, "1f149598-c1f7-4bf9-a0c2-6687428e09c7");
  assert.equal(calls[2].body.route_binding.lead_source_key, "ppc");
  assert.equal(calls.some((call) => call.url.endsWith("/sign")), false);
  const again = await run(post(lead({ stage: "complete" }), cookie), {}, { fetch: fetchImpl });
  assert.equal(JSON.parse(again.body).intake_id, INTAKE);
  const finalReserve = calls.filter((call) => call.url.endsWith("/reserve")).pop();
  assert.equal(finalReserve.body.intake_id, INTAKE);
  assert.equal(finalReserve.body.stage, "final");
  assert.equal(finalReserve.body.destination, "crm_update");
});

test("retry with the cookie does not mint and a reset does", async () => {
  const { fetchImpl, calls } = mock([
    { status: 200, body: { ok: true, intake_id: INTAKE, session_binding: SESSION } },
    { status: 200, body: { ok: true, status: "dispatch_intended_committed", reservation_generation: 1 } },
    { status: 200, body: {} },
    { status: 200, body: { ok: true, status: "recovered", reservation_generation: 1 } },
    { status: 200, body: { ok: true, intake_id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd", session_binding: SESSION } },
    { status: 200, body: { ok: true, status: "dispatch_intended_committed", reservation_generation: 1 } },
    { status: 200, body: {} },
  ]);
  const first = await run(post(lead()), {}, { fetch: fetchImpl });
  const cookie = first.headers["set-cookie"];
  const n = calls.length;
  const retry = await run(post(lead({ recover: true, intake_id: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee" }), cookie), {}, { fetch: fetchImpl });
  assert.equal(JSON.parse(retry.body).intake_id, INTAKE);
  assert.equal(calls.length, n + 1);
  assert.equal(calls[n].url.endsWith("/recover"), true);
  const reset = await run(post(lead({ reset: true }), cookie), { FSHO_INTAKE_ROUTE: "hesel_fb" }, { fetch: fetchImpl });
  assert.equal(JSON.parse(reset.body).intake_id, "dddddddd-dddd-4ddd-8ddd-dddddddddddd");
  assert.equal(JSON.parse(reset.body).wc_action, "reuse");
  assert.equal(calls[calls.length - 2].body.destination, "wc_update");
});

test("an unbound route does not call the edge or the hook", async () => {
  const { fetchImpl, calls } = mock([]);
  const res = await run(post(lead()), { FSHO_INTAKE_ROUTE: "seo" }, { fetch: fetchImpl });
  assert.equal(res.statusCode, 409);
  assert.equal(JSON.parse(res.body).error, "unknown_vendor");
  assert.equal(calls.length, 0);
});

test("a failed hook reconciles and does not call sign", async () => {
  const { fetchImpl, calls } = mock([
    { status: 200, body: { ok: true, intake_id: INTAKE, session_binding: SESSION } },
    { status: 200, body: { ok: true, status: "dispatch_intended_committed", reservation_id: "11111111-1111-4111-8111-111111111111", reservation_generation: 1 } },
    { status: 404, body: {} },
    { status: 200, body: { ok: true, status: "needs_reconcile" } },
  ]);
  const res = await run(post(lead()), {}, { fetch: fetchImpl });
  assert.equal(res.statusCode, 502);
  assert.equal(JSON.parse(res.body).needs_reconcile, true);
  assert.equal(calls[3].url.endsWith("/reconcile"), true);
  assert.equal(calls[3].body.reservation_id, "11111111-1111-4111-8111-111111111111");
  assert.equal(calls[3].body.reason, "hook_uncertain");
  assert.equal(calls.some((call) => call.url.endsWith("/sign")), false);
});
