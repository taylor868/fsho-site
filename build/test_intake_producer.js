"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const contract = require("../netlify/functions/intake-reserve-contract");
const { handle } = require("../netlify/functions/intake-producer");

const KEY = "unit-test-hmac-key-v1-32";
const KID = "kid-test";
const INTAKE = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const SESSION = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const NOW = 1700000000000;

const env = {
  INTAKE_HMAC_KEY_V1: KEY,
  INTAKE_HMAC_KID: KID,
  INTAKE_RESERVE_URL: "https://reserve.example.test/intake-reserve",
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
  }, extra || {});
}

function post(body, cookie) {
  return { httpMethod: "POST", body: JSON.stringify(body), headers: cookie ? { cookie } : {} };
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

test("golden HMAC matches the edge draft canonical verify", () => {
  const fields = {
    v: "1", kid: KID, route: "ppc_inhouse", channel: "website",
    intake_id: INTAKE, event_id: "22222222-2222-4222-8222-222222222222",
    stage: "first", ts: "1700000000", exp: "1700000900", payload_sha256: "abc123",
  };
  const canonical = contract.canonicalString(fields);
  assert.equal(canonical, [
    "v=1", "kid=" + KID, "route=ppc_inhouse", "channel=website",
    "intake_id=" + INTAKE, "event_id=22222222-2222-4222-8222-222222222222",
    "stage=first", "ts=1700000000", "exp=1700000900", "payload_sha256=abc123",
  ].join("\n"));
  const sig = contract.hmacHex(KEY, canonical);
  assert.equal(contract.draftVerify(KEY, KID, Object.assign({ sig }, fields), 1700000000).ok, true);
  assert.equal(contract.draftVerify(KEY, KID, Object.assign({}, fields, { sig: sig.slice(0, -1) + (sig.endsWith("0") ? "1" : "0") }), 1700000000).ok, false);
  assert.equal(contract.draftVerify(KEY, "other", Object.assign({ sig }, fields), 1700000000).ok, false);
  assert.ok(contract.PENDING_CONTRACT.length >= 5);
});

test("429 above the bound does not loop and keeps form state", async () => {
  const { fetchImpl, calls } = mock([{ status: 429, headers: { "retry-after": "30" }, body: {} }]);
  const slept = [];
  const res = await handle(post(lead()), { env, fetch: fetchImpl, sleep: async (ms) => slept.push(ms), now: NOW });
  const body = JSON.parse(res.body);
  assert.equal(res.statusCode, 429);
  assert.equal(body.form_state, "kept");
  assert.equal(body.retry_after_seconds, 30);
  assert.equal(calls.length, 1);
  assert.equal(slept.length, 0);
});

test("429 within the bound waits once and does not tight-loop", async () => {
  const { fetchImpl, calls } = mock([
    { status: 429, headers: { "retry-after": "1" }, body: {} },
    { status: 200, body: { ok: true, intake_id: INTAKE, session_binding: SESSION } },
    { status: 200, body: { ok: true, status: "dispatch_intended_committed", reservation_generation: 1 } },
    { status: 200, body: {} },
  ]);
  const slept = [];
  const res = await handle(post(lead()), { env, fetch: fetchImpl, sleep: async (ms) => slept.push(ms), now: NOW });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(slept, [1000]);
  assert.equal(calls.filter((call) => call.url.endsWith("/mint")).length, 2);
});

test("partial reserves a server id and complete reuses it", async () => {
  const { fetchImpl, calls } = mock([
    { status: 200, body: { ok: true, intake_id: INTAKE, session_binding: SESSION } },
    { status: 200, body: { ok: true, status: "dispatch_intended_committed", reservation_generation: 1 } },
    { status: 200, body: {} },
    { status: 200, body: { ok: true, status: "recovered", reservation_generation: 1 } },
    { status: 200, body: { ok: true, status: "dispatch_intended_committed", reservation_generation: 1 } },
    { status: 200, body: {} },
  ]);
  const first = await handle(post(lead()), { env, fetch: fetchImpl, now: NOW });
  const cookie = first.headers["set-cookie"];
  const body = JSON.parse(first.body);
  assert.equal(body.intake_id, INTAKE);
  assert.equal(body.wc_action, "create_once");
  assert.notEqual(body.intake_id, lead().intake_id);
  assert.equal(calls[1].body.destination, "wc_create");
  assert.equal(calls[1].body.envelope.route, "ppc_inhouse");
  assert.equal(calls[2].url, env.FSHO_CORE_ZAP_WEBHOOK_URL);
  assert.equal(JSON.stringify(calls[2].body).includes(KEY), false);
  assert.equal(calls[2].body.route_binding.campaign_id, "1f149598-c1f7-4bf9-a0c2-6687428e09c7");
  assert.equal(calls[2].body.route_binding.lead_source_key, "ppc");
  assert.equal(calls[2].body.payload.source, undefined);
  assert.equal(calls[2].body.payload.intake_id, undefined);
  const again = await handle(post(lead({ stage: "complete" }), cookie), { env, fetch: fetchImpl, now: NOW });
  assert.equal(JSON.parse(again.body).intake_id, INTAKE);
  const finalReserve = calls.filter((call) => call.url.endsWith("/reserve")).pop();
  assert.equal(finalReserve.body.envelope.intake_id, INTAKE);
  assert.equal(finalReserve.body.envelope.stage, "final");
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
  const first = await handle(post(lead()), { env, fetch: fetchImpl, now: NOW });
  const cookie = first.headers["set-cookie"];
  const n = calls.length;
  const retry = await handle(post(lead({ recover: true, intake_id: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee" }), cookie), { env, fetch: fetchImpl, now: NOW });
  assert.equal(JSON.parse(retry.body).intake_id, INTAKE);
  assert.equal(calls.length, n + 1);
  assert.equal(calls[n].url.endsWith("/recover"), true);
  const reset = await handle(post(lead({ reset: true }), cookie), { env: Object.assign({}, env, { FSHO_INTAKE_ROUTE: "hesel_fb" }), fetch: fetchImpl, now: NOW });
  assert.equal(JSON.parse(reset.body).intake_id, "dddddddd-dddd-4ddd-8ddd-dddddddddddd");
  assert.equal(JSON.parse(reset.body).wc_action, "reuse");
  assert.equal(calls[calls.length - 2].body.destination, "wc_update");
});

test("an unbound route does not call the edge or the hook", async () => {
  const { fetchImpl, calls } = mock([]);
  const res = await handle(post(lead()), { env: Object.assign({}, env, { FSHO_INTAKE_ROUTE: "seo" }), fetch: fetchImpl, now: NOW });
  assert.equal(res.statusCode, 409);
  assert.equal(JSON.parse(res.body).error, "unknown_vendor");
  assert.equal(calls.length, 0);
});
