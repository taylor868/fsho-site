"use strict";

const assert = require("assert");
const crypto = require("crypto");
const producer = require("../netlify/functions/intake-producer.js");

const KEY = "dummy-hmac-key";
const KID = "kid-test";
const EDGE = "https://edge.example.test/functions/v1";
const HOOK = "https://hooks.example.test/catch";
const INTAKE = "11111111-1111-4111-8111-111111111111";
const BINDING = "22222222-2222-4222-8222-222222222222";
const OWNER = "33333333-3333-4333-8333-333333333333";
const RES = "44444444-4444-4444-8444-444444444444";
const IP = "203.0.113.7";

const env = {
  INTAKE_HMAC_KEY_V1: KEY,
  INTAKE_HMAC_KID: KID,
  INTAKE_EDGE_BASE_URL: EDGE,
  INTAKE_ZAP_HOOK_URL: HOOK
};

function canonicalJson(value) {
  if (value === null) return "null";
  if (typeof value === "number") return String(value);
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "string") return JSON.stringify(value);
  if (Array.isArray(value)) return "[" + value.map(canonicalJson).join(",") + "]";
  const keys = Object.keys(value).filter((key) => value[key] !== undefined).sort();
  return "{" + keys.map((key) => JSON.stringify(key) + ":" + canonicalJson(value[key])).join(",") + "}";
}

const LINE_ORDER = ["v", "kid", "route", "channel", "intake_id", "event_id", "stage", "ts", "exp", "payload_sha256"];

function lines(fields) {
  return LINE_ORDER.map((key) => key + "=" + (fields[key] == null ? "" : String(fields[key]))).join("\n");
}

function expectSig(envelope, payload) {
  const digest = crypto.createHash("sha256").update(canonicalJson(payload)).digest("hex");
  assert.equal(envelope.payload_sha256, digest);
  const mac = crypto.createHmac("sha256", KEY).update(lines(envelope)).digest("hex");
  assert.equal(envelope.sig, mac);
  assert.equal(envelope.kid, KID);
  assert.equal(envelope.v, "1");
  assert.equal(envelope.channel, "website");
  assert.equal(envelope.route, "ppc_inhouse");
}

function json(status, body, headers) {
  const map = {};
  Object.keys(headers || {}).forEach((key) => { map[key.toLowerCase()] = String(headers[key]); });
  return { status, headers: { get: (name) => map[String(name).toLowerCase()] || "" }, json: async () => body };
}

function cookie(res) {
  return String(res.headers["set-cookie"] || "").split(";")[0];
}

function event(op, fields, jar) {
  return {
    httpMethod: "POST",
    headers: { cookie: jar || "", "x-nf-client-connection-ip": IP },
    body: JSON.stringify(Object.assign({ op }, fields || {}))
  };
}

function spyLogs() {
  const rows = [];
  const saved = {};
  ["log", "info", "warn", "error", "debug"].forEach((name) => {
    saved[name] = console[name];
    console[name] = (...args) => rows.push(args.map(String).join(" "));
  });
  rows.restore = () => { Object.keys(saved).forEach((name) => { console[name] = saved[name]; }); };
  return rows;
}

function assertQuiet(res, rows) {
  const blob = res.body + "\n" + JSON.stringify(res.headers) + "\n" + rows.join("\n");
  for (const secret of [KEY, BINDING, OWNER, HOOK, EDGE]) assert.equal(blob.includes(secret), false, secret);
  const body = JSON.parse(res.body);
  for (const key of ["owner_token", "session_binding", "sig", "envelope"]) assert.equal(body[key], undefined);
}

async function main() {
  const src = require("fs").readFileSync(require("path").join(__dirname, "../netlify/functions/intake-producer.js"), "utf8");
  assert.equal(src.includes("console.log(String(state.reservation_id || \"\"))"), true);
  assert.equal(src.split("console.").length, 2);
  const vectorPayload = "{\"address_line\":\"1 Main St, Akron, OH 44301\",\"client_ip\":\"203.0.113.10\",\"email\":\"a@example.com\",\"full_name\":\"Ann Lee\",\"gclid\":\"G1\",\"phone\":\"5550100100\"}";
  const vectorFields = {
    v: "1", kid: "kid_test", route: "ppc_inhouse", channel: "website",
    intake_id: "11111111-1111-4111-8111-111111111111",
    event_id: "22222222-2222-4222-8222-222222222222",
    stage: "partial", ts: 1800000000, exp: 1800000600,
    payload_sha256: "bcc2b32f5acba2edac404465a98b9037f7d1c2b8de43a2f97e89a27d4c97cf4c"
  };
  assert.equal(crypto.createHash("sha256").update(vectorPayload).digest("hex"), vectorFields.payload_sha256);
  assert.equal(producer.canonicalJson(JSON.parse(vectorPayload)), vectorPayload);
  const vectorLines = lines(vectorFields);
  assert.equal(producer.canonicalLines(vectorFields), vectorLines);
  assert.notEqual(Object.keys(vectorFields).sort().map((key) => key + "=" + vectorFields[key]).join("\n"), vectorLines);
  const vectorSig = crypto.createHmac("sha256", "test_key_not_secret").update(vectorLines).digest("hex");
  assert.equal(vectorSig, "48cd219081d7bf501b8467454242d98557bf5c93b1ea61f1968e9f8ee496ee57");
  assert.equal(producer.signFields(vectorFields, "test_key_not_secret"), vectorSig);
  assert.equal(producer.stripControls("hook_\u0000uncertain\n"), "hook_uncertain");
  const derived = Buffer.from(producer.cookieKey({ INTAKE_HMAC_KEY_V1: KEY }));
  const rawHash = crypto.createHash("sha256").update(KEY).digest();
  assert.equal(derived.equals(rawHash), false);
  assert.equal(derived.equals(Buffer.from(crypto.hkdfSync("sha256", Buffer.from(KEY), Buffer.alloc(0), Buffer.from("fsho-intake-cookie-v1"), 32))), true);
  const separate = Buffer.from(producer.cookieKey({ INTAKE_HMAC_KEY_V1: KEY, INTAKE_COOKIE_KEY: "cookie-material" }));
  assert.equal(separate.equals(crypto.createHash("sha256").update("cookie-material").digest()), true);
  assert.equal(separate.equals(derived), false);
  assert.equal(src.includes(KEY), false);
  assert.equal(src.includes("hooks.zapier.com"), false);
  global.fetch = () => { throw new Error("live fetch is not allowed"); };
  const logs = spyLogs();
  const calls = [];
  let enrichFails = 1;
  const fake = async (url, init) => {
    const body = init && init.body ? JSON.parse(init.body) : {};
    calls.push({ url, body });
    if (String(url).endsWith("/mint")) return json(200, { ok: true, intake_id: INTAKE, session_binding: BINDING, kid: KID });
    if (url === HOOK) return json(200, { ok: true });
    if (String(url).endsWith("/claim")) {
      return json(200, { ok: true, claimed: true, tier: "hot", status: "late_hot", priority_tier: null, owner_token: OWNER, session_binding: BINDING });
    }
    if (String(url).endsWith("/reserve")) {
      return json(200, { ok: true, status: "dispatch_intended_committed", reservation_id: RES, reservation_generation: 2, owner_token: OWNER, session_binding: BINDING });
    }
    if (String(url).endsWith("/enrich") && enrichFails > 0) {
      enrichFails -= 1;
      return json(503, { ok: false, status: "enrich_unavailable" }, { "retry-after": "5" });
    }
    return json(200, { ok: true, status: url.endsWith("/park") ? "parked" : "saved", geocode_status: "ok" });
  };
  const deps = { env, fetch: fake, now: () => 1700000000000, retryMs: 0 };

  const refused = await producer.handle(event("park", { attribution: { landing: "/" }, full_name: "Ada" }), deps);
  assert.equal(refused.statusCode, 400);
  assert.deepEqual(JSON.parse(refused.body).fields, ["attribution"]);
  assert.equal(calls.length, 0);

  const priced = await producer.handle(event("enrich", { enrichment: { price_vs_value: "below" } }), deps);
  assert.equal(priced.statusCode, 400);
  assert.equal(JSON.parse(priced.body).fields.includes("price_vs_value"), true);
  assert.equal(calls.length, 0);

  let jar = "";
  const parked = await producer.handle(event("park", {
    full_name: "Ada Lovelace",
    address_line: "1 Main St",
    phone: "(555) 010-0199",
    email: "ada@example.com",
    client_ip: "198.51.100.9",
    gclid: "click-a",
    utm_source: "google"
  }, jar), deps);
  assert.equal(parked.statusCode, 200);
  assertQuiet(parked, logs);
  jar = cookie(parked);
  const mint = calls.find((row) => row.url.endsWith("/mint"));
  const park = calls.find((row) => row.url.endsWith("/park"));
  assert.deepEqual(mint.body, {});
  assert.equal(park.body.session_binding, BINDING);
  assert.equal(park.body.payload.client_ip, IP);
  assert.equal(park.body.payload.phone, "5550100199");
  assert.equal(park.body.payload.gclid, "click-a");
  assert.equal(park.body.payload.address_line, "1 Main St");
  assert.equal(park.body.payload.full_name, "Ada Lovelace");
  assert.equal(park.body.envelope.stage, "partial");
  expectSig(park.body.envelope, park.body.payload);
  assert.deepEqual(Object.keys(park.body).sort(), ["envelope", "payload", "session_binding"]);

  const again = await producer.handle(event("park", {
    full_name: "Ada Lovelace",
    address_line: "1 Main St",
    phone: "5550100199",
    email: "ada@example.com",
    gclid: "click-b"
  }, jar), deps);
  assert.equal(again.statusCode, 200);
  jar = cookie(again);
  const parks = calls.filter((row) => row.url.endsWith("/park"));
  assert.equal(parks[1].body.payload.gclid, "click-a");

  const answered = await producer.handle(event("answer", { question: "type", answer: "sfh" }, jar), deps);
  assert.equal(answered.statusCode, 200);
  jar = cookie(answered);
  const answer = calls.find((row) => row.url.endsWith("/answer"));
  assert.equal(answer.body.payload.client_ip, IP);
  assert.equal(answer.body.payload.question, "type");
  expectSig(answer.body.envelope, answer.body.payload);
  assert.deepEqual(Object.keys(answer.body).sort(), ["envelope", "payload"]);

  const claimed = await producer.handle(event("claim", { by: "promote" }, jar), deps);
  assert.equal(claimed.statusCode, 200);
  const claimBody = JSON.parse(claimed.body);
  assert.equal(claimBody.status, "claimed");
  assert.equal(claimBody.tier, "hot");
  assert.equal(claimBody.claimed, true);
  assertQuiet(claimed, logs);
  jar = cookie(claimed);
  const claim = calls.find((row) => row.url.endsWith("/claim"));
  assert.equal(claim.body.payload.client_ip, IP);
  assert.equal(claim.body.payload.by, "promote");
  expectSig(claim.body.envelope, claim.body.payload);
  assert.deepEqual(Object.keys(claim.body).sort(), ["envelope", "payload"]);

  const enriched = await producer.handle(event("enrich", { enrichment: { occupancy: "vacant" } }, jar), deps);
  assert.equal(enriched.statusCode, 200);
  assert.equal(JSON.parse(enriched.body).priority_tier, undefined);
  const enrichCalls = calls.filter((row) => row.url.endsWith("/enrich"));
  assert.equal(enrichCalls.length, 2);
  enrichCalls.forEach((row) => {
    assert.equal(row.body.payload.client_ip, IP);
    assert.equal(row.body.payload.enrichment.occupancy, "vacant");
    assert.deepEqual(Object.keys(row.body).sort(), ["envelope", "payload"]);
    expectSig(row.body.envelope, row.body.payload);
  });
  jar = cookie(enriched);

  const reserved = await producer.handle(event("reserve", { stage: "final", destination: "crm_create" }, jar), deps);
  assert.equal(reserved.statusCode, 200);
  assertQuiet(reserved, logs);
  const reserve = calls.find((row) => row.url.endsWith("/reserve"));
  assert.equal(reserve.body.payload.client_ip, undefined);
  assert.equal(reserve.body.destination, "crm_create");
  assert.equal(reserve.body.lease_seconds, 120);
  assert.equal(reserve.body.envelope.stage, "final");
  expectSig(reserve.body.envelope, reserve.body.payload);
  assert.deepEqual(Object.keys(reserve.body).sort(), ["destination", "envelope", "lease_seconds", "owner_token", "payload", "session_binding"]);
  const hook = calls.find((row) => row.url === HOOK);
  assert.deepEqual(Object.keys(hook.body).sort(), ["address_line", "email", "full_name", "intake_id", "owner_token", "phone", "reservation_generation", "reservation_id", "session_binding"]);
  assert.equal(hook.body.intake_id, INTAKE);
  assert.equal(hook.body.reservation_id, RES);
  assert.equal(hook.body.reservation_generation, 2);
  assert.equal(hook.body.session_binding, BINDING);
  assert.equal(hook.body.owner_token, OWNER);
  assert.equal(hook.body.full_name, "Ada Lovelace");
  assert.equal(hook.body.phone, "5550100199");
  assert.equal(hook.body.email, "ada@example.com");
  assert.equal(hook.body.address_line, "1 Main St");

  const limited = await producer.handle(event("answer", { question: "ownership", answer: "sole_owner" }, jar), {
    env,
    now: () => 1700000000000,
    retryMs: 0,
    fetch: async () => json(429, { ok: false, status: "rate_limited" }, { "retry-after": "30" })
  });
  assert.equal(limited.statusCode, 429);
  assert.equal(limited.headers["retry-after"], "30");
  assert.equal(JSON.parse(limited.body).status, "rate_limited");

  let conflictCalls = 0;
  const conflict = await producer.handle(event("claim", { by: "promote" }, jar), {
    env,
    now: () => 1700000000000,
    fetch: async () => { conflictCalls += 1; return json(409, { ok: false, status: "not_qualified", claimed: false }); }
  });
  assert.equal(conflict.statusCode, 409);
  assert.equal(conflictCalls, 1);
  assert.equal(JSON.parse(conflict.body).status, "not_qualified");

  let downCalls = 0;
  const down = await producer.handle(event("enrich", { enrichment: {} }, jar), {
    env,
    now: () => 1700000000000,
    retryMs: 0,
    fetch: async (url) => {
      downCalls += 1;
      if (String(url).endsWith("/mint")) return json(200, { ok: true, intake_id: INTAKE, session_binding: BINDING });
      return json(503, { ok: false, status: "enrich_unavailable" });
    }
  });
  assert.equal(down.statusCode, 503);
  assert.equal(JSON.parse(down.body).status, "enrich_unavailable");
  assert.equal(downCalls, 2);

  const beforeHookLog = logs.length;
  let hookTries = 0;
  let reconciles = [];
  const failed = await producer.handle(event("reserve", { stage: "final" }, jar), {
    env, now: () => 1700000000000, retryMs: 0,
    fetch: async (url, init) => {
      const body = init && init.body ? JSON.parse(init.body) : {};
      if (url === HOOK) { hookTries += 1; return json(500, {}); }
      if (String(url).endsWith("/reconcile")) { reconciles.push(body); return json(200, { ok: true, status: "needs_reconcile", needs_reconcile: true, session_binding: BINDING, owner_token: OWNER }); }
      return json(200, { ok: true, status: "idempotent_replay", reservation_id: RES, reservation_generation: 2 });
    }
  });
  assert.equal(hookTries, 2);
  assert.equal(reconciles.length, 1);
  assert.deepEqual(Object.keys(reconciles[0]).sort(), ["envelope", "payload", "reservation_id"]);
  assert.equal(reconciles[0].reservation_id, RES);
  assert.equal(reconciles[0].payload.reason, "hook_uncertain");
  assert.equal(reconciles[0].session_binding, undefined);
  assert.equal(reconciles[0].owner_token, undefined);
  assert.equal(reconciles[0].envelope.stage, "final");
  assert.equal(reconciles[0].envelope.intake_id, INTAKE);
  expectSig(reconciles[0].envelope, reconciles[0].payload);
  assert.equal(failed.statusCode, 200);
  assert.deepEqual(JSON.parse(failed.body), { ok: false, status: "needs_reconcile" });
  assertQuiet(failed, logs);
  assert.deepEqual(logs.slice(beforeHookLog), [RES]);

  let recoveredHooks = 0;
  let recoveredReconcile = 0;
  const recovered = await producer.handle(event("reserve", { stage: "final" }, jar), {
    env, now: () => 1700000000000,
    fetch: async (url) => {
      if (url === HOOK) { recoveredHooks += 1; if (recoveredHooks === 1) throw new Error(HOOK); return json(200, { ok: true }); }
      if (String(url).endsWith("/reconcile")) { recoveredReconcile += 1; return json(200, { ok: true }); }
      return json(200, { ok: true, status: "idempotent_replay", reservation_id: RES, reservation_generation: 2 });
    }
  });
  assert.equal(recovered.statusCode, 200);
  assert.equal(recoveredHooks, 2);
  assert.equal(recoveredReconcile, 0);
  assert.equal(JSON.parse(recovered.body).status, "idempotent_replay");

  function sealWith(obj, key) {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
    const body = Buffer.concat([cipher.update(JSON.stringify(obj), "utf8"), cipher.final()]);
    return "fsho_intake=" + Buffer.concat([iv, cipher.getAuthTag(), body]).toString("base64url");
  }
  let rawMints = 0;
  const rawCookie = sealWith({ intake_id: INTAKE, session_binding: BINDING, tracking: { gclid: "from-raw-key" } }, rawHash);
  const rawPark = await producer.handle({
    httpMethod: "POST",
    headers: { cookie: rawCookie, "x-nf-client-connection-ip": IP },
    body: JSON.stringify({ op: "park", full_name: "Ada Lovelace", address_line: "1 Main St", phone: "5550100199", email: "ada@example.com", gclid: "from-request" })
  }, {
    env, now: () => 1700000000000,
    fetch: async (url, init) => {
      const body = JSON.parse(init.body);
      if (String(url).endsWith("/mint")) { rawMints += 1; return json(200, { ok: true, intake_id: INTAKE, session_binding: BINDING, kid: KID }); }
      assert.equal(body.payload.gclid, "from-request");
      return json(200, { ok: true, status: "parked" });
    }
  });
  assert.equal(rawPark.statusCode, 200);
  assert.equal(rawMints, 1);

  const cookieEnv = Object.assign({}, env, { INTAKE_COOKIE_KEY: "cookie-material" });
  const kept = sealWith({
    intake_id: INTAKE, session_binding: BINDING, tracking: { gclid: "cookie-kept" },
    contact: { full_name: "Ada Lovelace", phone: "5550100199", email: "ada@example.com", address_line: "1 Main St" }
  }, separate);
  let cookieMints = 0;
  const keptPark = await producer.handle({
    httpMethod: "POST",
    headers: { cookie: kept, "x-nf-client-connection-ip": IP },
    body: JSON.stringify({ op: "park", full_name: "Ada Lovelace", address_line: "1 Main St", phone: "5550100199", email: "ada@example.com", gclid: "other" })
  }, {
    env: cookieEnv, now: () => 1700000000000,
    fetch: async (url, init) => {
      const body = JSON.parse(init.body);
      if (String(url).endsWith("/mint")) { cookieMints += 1; return json(200, { ok: true, intake_id: INTAKE, session_binding: BINDING, kid: KID }); }
      assert.equal(body.payload.gclid, "cookie-kept");
      return json(200, { ok: true, status: "parked" });
    }
  });
  assert.equal(keptPark.statusCode, 200);
  assert.equal(cookieMints, 0);

  logs.restore();
  console.log("producer tests passed");
}

main().catch((err) => {
  process.stderr.write(String(err && err.stack || err) + "\n");
  process.exit(1);
});
