"use strict";

const fs = require("fs");
const path = require("path");
const assert = require("node:assert/strict");
const test = require("node:test");
const fn = require("../netlify/functions/create-lead.js");

const CAMPAIGN = "11111111-1111-4111-8111-111111111111";
const ASSIGNED = "22222222-2222-4222-8222-222222222222";
const EXISTING = "33333333-3333-4333-8333-333333333333";
const TOKEN = "unit-test-token";

function env(extra) {
  return Object.assign({
    FSHO_CRM_CREATE_LEAD_TOKEN: TOKEN,
    FSHO_CRM_CAMPAIGN_ID: CAMPAIGN,
    FSHO_CRM_SOURCE_KEY: "google-ads",
  }, extra || {});
}

function post(body) {
  return { httpMethod: "POST", body: JSON.stringify(body) };
}

const partial = {
  form: "qualifier",
  stage: "partial",
  lead_id: "abc123",
  first: "Pat",
  last: "Seller",
  phone: "(330) 555-1234",
  email: "pat@example.com",
  address: "123 Main St, Akron, OH 44308",
  consent: false,
  gclid: "g1",
  utm_source: "google",
  utm_medium: "cpc",
  utm_campaign: "hot",
  utm_term: "sell house",
  page: "/",
  form_id: "1",
};

function callsOf(fetchImpl) {
  return fetchImpl.calls;
}

function mockFetch(routes) {
  const calls = [];
  const fetchImpl = async (url, opts) => {
    calls.push({ url, opts });
    const name = String(url).split("/rpc/")[1];
    const route = routes[name] || { status: 200, body: null };
    if (route.throw) throw new Error("network down at " + url);
    return {
      status: route.status == null ? 200 : route.status,
      text: async () => (route.raw != null ? route.raw : JSON.stringify(route.body)),
    };
  };
  fetchImpl.calls = calls;
  return fetchImpl;
}

const OPEN = { assignmentNullable: true };

async function run(event, fetchImpl, extraEnv, deps) {
  const logs = [];
  const orig = console.log;
  console.log = (...a) => logs.push(a.join(" "));
  try {
    const res = await fn.handle(event, Object.assign({ env: env(extraEnv), fetch: fetchImpl }, deps || {}));
    return { res, body: JSON.parse(res.body), logs, calls: callsOf(fetchImpl) };
  } finally {
    console.log = orig;
  }
}

function completeLead(extra) {
  return Object.assign({}, partial, {
    stage: "complete",
    form_version: 3,
    page: "/step-2/",
    answers: { type: "sfh", equity: "free_clear" },
    emota: { E: true, M: false, O: true, T: true, A: true },
    failed: ["M"],
    tags: ["emota-fail-M"],
    tier: "nurture",
    cadence: "60day",
    conversion: "none",
  }, extra || {});
}

test("source has no token prefix and no hardcoded CRM uuids", () => {
  const src = fs.readFileSync(path.join(__dirname, "../netlify/functions/create-lead.js"), "utf8");
  assert.equal(/\bfsh_[A-Za-z0-9]/.test(src), false);
  assert.equal(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i.test(src), false);
});

test("parses a one-line US address without dropping the raw line", () => {
  assert.deepEqual(fn.parseAddress("123 Main St, Akron, OH 44308"), {
    raw: "123 Main St, Akron, OH 44308",
    street: "123 Main St", city: "Akron", state: "OH", postal: "44308",
  });
  assert.deepEqual(fn.parseAddress("10 Oak Ave, Apt 4, Columbus, Ohio 43215-1234"), {
    raw: "10 Oak Ave, Apt 4, Columbus, Ohio 43215-1234",
    street: "10 Oak Ave, Apt 4", city: "Columbus", state: "OH", postal: "43215-1234",
  });
  const loose = fn.parseAddress("123 Main St Akron OH 44308");
  assert.equal(loose.city, "Akron");
  assert.equal(loose.state, "OH");
  assert.equal(loose.postal, "44308");
  assert.equal(loose.raw, "123 Main St Akron OH 44308");
  assert.equal(fn.parseAddress("123 Main St, St. Louis, MO 63101").city, "St. Louis");
  assert.equal(fn.parseAddress("123 Main St, Akron, OH").postal, "");
});

test("honeypot rejects without calling CRM", async () => {
  const fetchImpl = mockFetch({});
  const { res, body, calls } = await run(post(Object.assign({}, partial, { company_website: "http://spam" })), fetchImpl);
  assert.equal(res.statusCode, 400);
  assert.equal(body.error, "rejected");
  assert.equal(calls.length, 0);
  assert.equal(JSON.stringify(body).includes(TOKEN), false);
});

test("blank honeypot is not a reject", () => {
  assert.equal(fn.honeypotFilled({ company_website: "  " }), false);
  assert.equal(fn.honeypotFilled({ Company_Website: "x" }), true);
});

test("missing CRM env returns 503 and does not call CRM", async () => {
  const fetchImpl = mockFetch({});
  const { res, body, calls } = await run(post(partial), fetchImpl, {
    FSHO_CRM_CAMPAIGN_ID: "",
    FSHO_CRM_ASSIGNED_TO: "not-a-uuid",
    FSHO_CRM_SOURCE_KEY: "",
  });
  assert.equal(res.statusCode, 503);
  assert.equal(body.error, "lead_routing_unconfigured");
  assert.deepEqual(body.missing, ["FSHO_CRM_CAMPAIGN_ID", "FSHO_CRM_SOURCE_KEY"]);
  assert.deepEqual(body.invalid, ["FSHO_CRM_ASSIGNED_TO"]);
  assert.equal(calls.length, 0);
  assert.equal(JSON.stringify(body).includes("not-a-uuid"), false);
  assert.equal(JSON.stringify(body).includes(TOKEN), false);
});

test("missing token is named and not echoed", async () => {
  const fetchImpl = mockFetch({});
  const { body, calls } = await run(post(partial), fetchImpl, { FSHO_CRM_CREATE_LEAD_TOKEN: "" });
  assert.deepEqual(body.missing, ["FSHO_CRM_CREATE_LEAD_TOKEN"]);
  assert.equal(calls.length, 0);
});

test("configured unassigned routing sends explicit null and no default assignee", async () => {
  const fetchImpl = mockFetch({
    lead_for_phone: { body: null },
    lead_for_email: { body: null },
    create_lead: { body: { ok: true, data: { id: "new" } } },
  });
  const partialRes = await run(post(partial), fetchImpl);
  assert.equal(partialRes.res.statusCode, 409);
  assert.equal(partialRes.body.error, "partial_deferred");
  assert.equal(partialRes.calls.length, 0);
  const completeRes = await run(post(completeLead()), fetchImpl, {
    FSHO_CRM_CAMPAIGN_ID: CAMPAIGN,
    FSHO_CRM_SOURCE_KEY: "unit-source-key",
  });
  assert.equal(completeRes.body.ok, true);
  assert.equal(completeRes.body.routed, true);
  const raw = completeRes.calls[2].opts.body;
  const crm = JSON.parse(raw);
  assert.equal(Object.hasOwn(crm, "p_assigned_to"), true);
  assert.equal(crm.p_assigned_to, null);
  assert.match(raw, /"p_assigned_to":null/);
  assert.equal(crm.p_campaign_id, CAMPAIGN);
  assert.equal(crm.p_source_key, "unit-source-key");
  assert.deepEqual(raw.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi), [CAMPAIGN]);
});

test("partial does not create a row once unassigned create is allowed", async () => {
  const fetchImpl = mockFetch({ create_lead: { body: { ok: true, data: { id: "nope" } } } });
  const { res, body, calls } = await run(post(partial), fetchImpl, {}, OPEN);
  assert.equal(res.statusCode, 409);
  assert.equal(body.ok, false);
  assert.equal(body.routed, false);
  assert.equal(body.error, "partial_deferred");
  assert.equal(calls.length, 0);
});

test("create_lead maps a complete lead, stays unassigned, and keeps the full address", async () => {
  const fetchImpl = mockFetch({
    lead_for_phone: { body: null },
    lead_for_email: { body: { ok: true, data: null } },
    create_lead: { status: 200, body: { ok: true, data: { id: EXISTING } } },
  });
  const { res, body, calls } = await run(post(completeLead()), fetchImpl, {
    FSHO_CRM_CAMPAIGN_ID: CAMPAIGN,
    FSHO_CRM_SOURCE_KEY: "unit-source-key",
  }, OPEN);
  assert.equal(res.statusCode, 200);
  assert.equal(body.ok, true);
  assert.equal(body.routed, true);
  assert.equal(calls.length, 3);
  assert.equal(calls[0].url, fn.DEFAULT_API_BASE + "/rpc/lead_for_phone");
  assert.equal(calls[1].url, fn.DEFAULT_API_BASE + "/rpc/lead_for_email");
  assert.equal(calls[2].url, fn.DEFAULT_API_BASE + "/rpc/create_lead");
  for (const call of calls) {
    assert.equal(call.opts.headers.Authorization, "Bearer " + TOKEN);
    assert.equal(call.opts.redirect, "error");
    assert.equal(JSON.stringify(call.opts.headers).includes(TOKEN), true);
  }
  assert.deepEqual(JSON.parse(calls[0].opts.body), { p: "(330) 555-1234" });
  assert.deepEqual(JSON.parse(calls[1].opts.body), { p: "pat@example.com" });
  const crm = JSON.parse(calls[2].opts.body);
  assert.equal(crm.p_address, "123 Main St, Akron, OH 44308");
  assert.equal(crm.p_city, "Akron");
  assert.equal(crm.p_state, "OH");
  assert.equal(crm.p_postal, "44308");
  assert.equal(crm.p_seller_name, "Pat Seller");
  assert.equal(crm.p_phone, "(330) 555-1234");
  assert.equal(crm.p_email, "pat@example.com");
  assert.equal(crm.p_source_key, "unit-source-key");
  assert.equal(crm.p_campaign_id, CAMPAIGN);
  assert.equal(Object.hasOwn(crm, "p_assigned_to"), true);
  assert.equal(crm.p_assigned_to, null);
  assert.match(calls[2].opts.body, /"p_assigned_to":null/);
  assert.equal(JSON.stringify(crm).includes(ASSIGNED), false);
  assert.equal(crm.company_website, undefined);
  assert.equal(crm.lead_id, undefined);
  const note = JSON.parse(crm.p_motivation);
  assert.equal(note.campaign_name, undefined);
  assert.equal(note.lead_id, "abc123");
  assert.equal(note.stage, "complete");
  assert.deepEqual(note.emota, { E: true, M: false, O: true, T: true, A: true });
  assert.equal(note.gclid, "g1");
  assert.deepEqual(note.utm, { source: "google", medium: "cpc", campaign: "hot", term: "sell house" });
  assert.equal(note.page, "/step-2/");
  assert.equal(crm.p_consent_text, undefined);
  assert.equal(body.data.id, EXISTING);
});

test("complete qualifier packs EMOTA and consent", async () => {
  const fetchImpl = mockFetch({
    lead_for_phone: { body: null },
    lead_for_email: { body: null },
    create_lead: { body: { ok: true, data: { id: "new" } } },
  });
  const complete = Object.assign({}, partial, {
    stage: "complete",
    form_version: 3,
    consent: true,
    consent_text: "You agree to texts.",
    page: "/step-2/",
    answers: { type: "sfh", equity: "free_clear" },
    emota: { E: true, M: false, O: true, T: true, A: true },
    failed: ["M"],
    tags: ["emota-fail-M"],
    tier: "nurture",
    cadence: "60day",
    conversion: "none",
  });
  const { calls } = await run(post(complete), fetchImpl, {}, OPEN);
  const crm = JSON.parse(calls[2].opts.body);
  const note = JSON.parse(crm.p_motivation);
  assert.equal(note.form_version, 3);
  assert.deepEqual(note.emota, complete.emota);
  assert.deepEqual(note.failed, ["M"]);
  assert.deepEqual(note.tags, ["emota-fail-M"]);
  assert.equal(note.tier, "nurture");
  assert.equal(note.cadence, "60day");
  assert.equal(note.conversion, "none");
  assert.equal(crm.p_consent_text, "You agree to texts.");
  assert.equal(crm.p_consent_url, "https://fairandsimplehomeoffer.com/step-2/");
});

test("existing phone does not look like a saved EMOTA update", async () => {
  const fetchImpl = mockFetch({
    lead_for_phone: { body: EXISTING },
    create_lead: { body: { ok: true, data: { id: "should-not" } } },
  });
  const { res, body, calls } = await run(post(completeLead()), fetchImpl, {}, OPEN);
  assert.equal(res.statusCode, 409);
  assert.equal(body.ok, false);
  assert.equal(body.routed, false);
  assert.equal(body.error, "update_unavailable");
  assert.equal(body.data, undefined);
  assert.equal(calls.length, 1);
});

test("existing email does not look like a saved EMOTA update", async () => {
  const fetchImpl = mockFetch({
    lead_for_phone: { body: { ok: true, data: null } },
    lead_for_email: { body: { ok: true, data: EXISTING } },
  });
  const { body, calls } = await run(post(completeLead()), fetchImpl, {}, OPEN);
  assert.equal(body.ok, false);
  assert.equal(body.error, "update_unavailable");
  assert.equal(calls.length, 2);
});

test("lookup 404 still creates an unassigned complete lead", async () => {
  const fetchImpl = mockFetch({
    lead_for_phone: { status: 404, body: { error: "not_found" } },
    lead_for_email: { status: 404, body: { error: "not_found" } },
    create_lead: { body: { ok: true, data: null } },
  });
  const { res, calls } = await run(post(completeLead()), fetchImpl, {}, OPEN);
  assert.equal(res.statusCode, 200);
  assert.equal(calls[2].url.endsWith("/rpc/create_lead"), true);
  assert.equal(JSON.parse(calls[2].opts.body).p_assigned_to, null);
});

test("CRM 401 is relayed without the token or upstream body dump", async () => {
  const secret = "fsh_" + "hiddenvalue";
  const fetchImpl = mockFetch({
    lead_for_phone: { status: 401, body: { error: "bad " + secret } },
  });
  const { res, body, calls, logs } = await run(post(completeLead()), fetchImpl, { FSHO_CRM_CREATE_LEAD_TOKEN: secret }, OPEN);
  assert.equal(res.statusCode, 401);
  assert.equal(body.error, "crm_rejected");
  assert.equal(JSON.stringify(body).includes(secret), false);
  assert.equal(logs.join("\n").includes(secret), false);
  assert.equal(calls.length, 1);
});

test("address without ZIP does not call CRM", async () => {
  const fetchImpl = mockFetch({});
  const lead = Object.assign({}, partial, { address: "123 Main St, Akron, OH" });
  const { res, body, calls } = await run(post(lead), fetchImpl);
  assert.equal(res.statusCode, 400);
  assert.equal(body.error, "incomplete_lead");
  assert.deepEqual(body.missing, ["p_postal"]);
  assert.equal(calls.length, 0);
});

test("custom API base is used when it is https and has no query", async () => {
  const fetchImpl = mockFetch({
    lead_for_phone: { body: null },
    lead_for_email: { body: null },
    create_lead: { body: { ok: true, data: null } },
  });
  const base = "https://example.test/functions/v1/fsho-api";
  const { calls } = await run(post(completeLead()), fetchImpl, { FSHO_API_BASE: base + "/" }, OPEN);
  assert.equal(calls[2].url, base + "/rpc/create_lead");
});

test("bad API base is 503 and does not call CRM", async () => {
  const fetchImpl = mockFetch({});
  const { res, body, calls } = await run(post(partial), fetchImpl, { FSHO_API_BASE: "http://insecure.example/api" });
  assert.equal(res.statusCode, 503);
  assert.deepEqual(body.invalid, ["FSHO_API_BASE"]);
  assert.equal(calls.length, 0);
  assert.equal(JSON.stringify(body).includes("insecure"), false);
});

test("network failure is 502 and does not include the URL", async () => {
  const fetchImpl = mockFetch({ lead_for_phone: { throw: true } });
  const { res, body } = await run(post(completeLead()), fetchImpl, {}, OPEN);
  assert.equal(res.statusCode, 502);
  assert.equal(body.error, "crm_unreachable");
  assert.equal(JSON.stringify(body).includes("supabase"), false);
  assert.equal(JSON.stringify(body).includes(TOKEN), false);
});

test("GET is 405", async () => {
  const fetchImpl = mockFetch({});
  const { res, body, calls } = await run({ httpMethod: "GET", body: "" }, fetchImpl);
  assert.equal(res.statusCode, 405);
  assert.equal(body.error, "method_not_allowed");
  assert.equal(calls.length, 0);
});

test("a CRM rejection of a null assignee is not retried and is not success", async () => {
  const fetchImpl = mockFetch({
    lead_for_phone: { body: null },
    lead_for_email: { body: null },
    create_lead: { status: 400, body: { error: "assigned_to required" } },
  });
  const { res, body, calls } = await run(post(completeLead()), fetchImpl, {}, OPEN);
  assert.equal(res.statusCode, 400);
  assert.equal(body.ok, false);
  assert.equal(body.routed, false);
  assert.equal(calls.length, 3);
  assert.match(calls[2].opts.body, /"p_assigned_to":null/);
  assert.equal(JSON.stringify(calls).includes(ASSIGNED), false);
});

test("missing campaign or source is not an explicit null create", async () => {
  const fetchImpl = mockFetch({ create_lead: { body: { ok: true, data: { id: "nope" } } } });
  const noCampaign = await run(post(completeLead()), fetchImpl, { FSHO_CRM_CAMPAIGN_ID: "" }, OPEN);
  const noSource = await run(post(completeLead()), fetchImpl, { FSHO_CRM_SOURCE_KEY: "" }, OPEN);
  assert.equal(noCampaign.res.statusCode, 503);
  assert.equal(noCampaign.body.error, "lead_routing_unconfigured");
  assert.deepEqual(noCampaign.body.missing, ["FSHO_CRM_CAMPAIGN_ID"]);
  assert.equal(noCampaign.body.ok, false);
  assert.equal(noSource.body.error, "lead_routing_unconfigured");
  assert.deepEqual(noSource.body.missing, ["FSHO_CRM_SOURCE_KEY"]);
  assert.equal(noCampaign.calls.length + noSource.calls.length, 0);
  assert.equal(JSON.stringify(noCampaign.body).includes("p_assigned_to"), false);
});

test("invalid campaign uuid and a configured assignee fail closed", async () => {
  const fetchImpl = mockFetch({ create_lead: { body: { ok: true, data: { id: "nope" } } } });
  const badCampaign = await run(post(completeLead()), fetchImpl, { FSHO_CRM_CAMPAIGN_ID: "not-a-uuid" }, OPEN);
  assert.equal(badCampaign.res.statusCode, 503);
  assert.equal(badCampaign.body.error, "lead_routing_unconfigured");
  assert.deepEqual(badCampaign.body.invalid, ["FSHO_CRM_CAMPAIGN_ID"]);
  assert.equal(badCampaign.calls.length, 0);
  const assigned = await run(post(completeLead()), fetchImpl, { FSHO_CRM_ASSIGNED_TO: ASSIGNED }, OPEN);
  assert.equal(assigned.res.statusCode, 503);
  assert.equal(assigned.body.ok, false);
  assert.equal(assigned.body.routed, false);
  assert.equal(assigned.body.error, "lead_routing_unconfigured");
  assert.deepEqual(assigned.body.invalid, ["FSHO_CRM_ASSIGNED_TO"]);
  assert.equal(assigned.calls.length, 0);
  assert.equal(JSON.stringify(assigned.body).includes(ASSIGNED), false);
  const garbage = await run(post(completeLead()), fetchImpl, { FSHO_CRM_ASSIGNED_TO: "not-a-person" });
  assert.deepEqual(garbage.body.invalid, ["FSHO_CRM_ASSIGNED_TO"]);
  assert.equal(garbage.body.error, "lead_routing_unconfigured");
  assert.notEqual(garbage.body.error, "assignment_unconfirmed");
  assert.equal(garbage.calls.length, 0);
});

test("no-comma address is still mappable and keeps the full line", () => {
  const mapped = fn.mapLead(completeLead({ address: "123 Main St Akron OH 44308" }));
  assert.equal(mapped.ok, true);
  assert.equal(mapped.body.p_address, "123 Main St Akron OH 44308");
  assert.equal(mapped.body.p_city, "Akron");
  assert.equal(mapped.body.p_state, "OH");
  assert.equal(mapped.body.p_postal, "44308");
});

test("client does not treat a failed save as success", () => {
  const app = fs.readFileSync(path.join(__dirname, "app.js"), "utf8");
  const qualifier = fs.readFileSync(path.join(__dirname, "qualifier.js"), "utf8");
  assert.equal(app.includes(".then(go,go)"), false);
  assert.equal(app.includes('b.error==="partial_deferred"'), true);
  assert.equal(app.includes("b&&b.ok"), true);
  assert.equal(qualifier.includes("keepalive:true"), false);
  assert.ok(qualifier.indexOf("function saved") < qualifier.indexOf("fetch(u"));
  assert.equal(qualifier.includes("b&&b.ok?saved():failed()"), true);
});

test("qualifier pass, fail, and hard-decline endings keep EMOTA, UTM, and gclid", () => {
  const base = {
    stage: "complete", form_version: 3, lead_id: "abc123", first: "Pat", last: "Seller",
    phone: "(330) 555-1234", email: "pat@example.com", address: "123 Main St, Akron, OH 44308",
    page: "/step-2/", gclid: "g1",
    utm_source: "google", utm_medium: "cpc", utm_campaign: "hot", utm_term: "sell house",
    answers: { type: "sfh", ownership: "sole_owner", timeline: "asap", situation: "repairs", equity: "free_clear", ability: "ready" },
    tags: ["emota-fail-M"],
  };
  function noteOf(extra) {
    const mapped = fn.mapLead(Object.assign({}, base, extra));
    assert.equal(mapped.ok, true);
    const raw = mapped.body.p_motivation;
    const note = JSON.parse(raw);
    assert.equal(note.gclid, "g1");
    assert.deepEqual(note.utm, { source: "google", medium: "cpc", campaign: "hot", term: "sell house" });
    assert.equal(note.form_version, 3);
    assert.equal(typeof note.answers.type, "string");
    return { raw, note };
  }
  const pass = noteOf({
    emota: { E: true, M: true, O: true, T: true, A: true }, failed: [], tags: [],
    tier: "hot", cadence: "speed-to-lead", conversion: "qualified_lead",
  });
  assert.match(pass.raw, /"emota":\{"E":true,"M":true,"O":true,"T":true,"A":true\}/);
  assert.equal(pass.note.tier, "hot");
  assert.equal(pass.note.cadence, "speed-to-lead");
  assert.equal(pass.note.conversion, "qualified_lead");
  const fail = noteOf({
    emota: { E: true, M: false, O: true, T: true, A: true }, failed: ["M"],
    tier: "nurture", cadence: "60day", conversion: "none",
  });
  assert.deepEqual(fail.note.failed, ["M"]);
  assert.equal(fail.note.tier, "nurture");
  assert.equal(fail.note.cadence, "60day");
  assert.equal(fail.note.conversion, "none");
  const stop = noteOf({
    emota: null, failed: null, tags: ["no-condo"], answers: { type: "condo" },
    tier: "disqualified", cadence: "none", conversion: "none",
  });
  assert.equal(stop.note.emota, null);
  assert.equal(stop.note.failed, null);
  assert.equal(stop.note.tier, "disqualified");
  assert.equal(stop.note.cadence, "none");
  assert.equal(stop.note.conversion, "none");
});
