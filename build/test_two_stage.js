"use strict";

const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const test = require("node:test");
const flow = require("./two-stage.js");

const contact = { name: "TEST LEAD", address: "100 Example Ave", phone: "5550100199", email: "test.lead@example.com" };

function run() {
  const tag = { loaded: false, load: function () { this.loaded = true; } };
  const adapter = flow.createMockAdapter();
  return { tag, adapter, session: flow.createFlow(adapter, tag) };
}

test("test mode cannot be enabled for production", () => {
  assert.equal(flow.testModeAllowed("production", "?test=1"), false);
  assert.equal(flow.testModeAllowed("production", ""), false);
  assert.equal(flow.testModeAllowed("local", ""), false);
  assert.equal(flow.testModeAllowed("deploy-preview", "?test=1"), true);
  assert.equal(flow.testModeAllowed("branch-deploy", "?x=1&test=1"), true);
  assert.equal(flow.testModeAllowed("denied", "?test=1"), false);
});

test("hot single-family and multi-family owners fire the tag only after owner=yes", () => {
  for (const property of ["sfh", "multi_2_4"]) {
    for (const owner of ["sole_owner", "all_agree", "decision_maker"]) {
      const { tag, adapter, session } = run();
      assert.equal(session.submitContact(contact).ok, true);
      assert.equal(tag.loaded, false);
      assert.equal(session.state.googleTagFired, false);
      session.answer("type", property);
      assert.equal(tag.loaded, false);
      assert.equal(session.state.downstream, "staying_parked");
      const hot = session.answer("ownership", owner);
      assert.equal(hot.view.branch, "hot");
      assert.equal(hot.view.googleTagFired, true);
      assert.equal(tag.loaded, true);
      assert.equal(hot.view.downstream, "zap_hot");
      session.answer("timeline", "asap");
      assert.equal(session.state.downstream, "zap_hot");
      assert.equal(adapter.log.filter((row) => row.op === "google" && row.fired).length, 1);
      assert.equal(adapter.log[0].op, "park");
      assert.equal(adapter.log[0].crm, false);
    }
  }
});

test("quiet property types stay parked for the sweep and never load the tag", () => {
  const qualifier = require("../content/forms/qualifier.json");
  assert.equal(flow.NOT_FIT.headline, qualifier.endings.not_fit.headline);
  assert.equal(flow.NOT_FIT.body, qualifier.endings.not_fit.body);
  assert.equal(flow.CONFIG.townhouse_route, "quiet");
  for (const property of ["townhouse", "condo", "mobile", "land"]) {
    const { tag, session } = run();
    session.submitContact(contact);
    const done = session.answer("type", property);
    assert.equal(done.view.branch, "quiet_property");
    assert.equal(done.view.downstream, "pg_cron_sweep");
    assert.equal(done.view.googleTagFired, false);
    assert.equal(session.state.sorry.headline, flow.NOT_FIT.headline);
    assert.equal(session.state.sorry.body, flow.NOT_FIT.body);
    assert.equal(tag.loaded, false);
    assert.equal(session.answer("ownership", "sole_owner").error, "unexpected_answer");
  }
});

test("a non-owner is logged with no conversion", () => {
  const { tag, session } = run();
  session.submitContact(contact);
  session.answer("type", "sfh");
  assert.equal(tag.loaded, false);
  const done = session.answer("ownership", "no");
  assert.equal(done.view.branch, "quiet_non_owner");
  assert.equal(done.view.downstream, "crm_follow_up");
  assert.equal(done.view.googleTagFired, false);
  assert.equal(tag.loaded, false);
});

test("abandoning after stage 1 stays parked and does not load the tag", () => {
  const { tag, adapter, session } = run();
  session.submitContact(contact);
  const left = session.abandon();
  assert.equal(left.view.branch, "abandoned");
  assert.equal(left.view.downstream, "staying_parked");
  assert.equal(left.view.googleTagFired, false);
  assert.equal(tag.loaded, false);
  assert.equal(session.answer("type", "sfh").error, "unexpected_answer");
  assert.equal(adapter.log.some((row) => row.op === "park"), true);
  assert.equal(adapter.log.some((row) => row.op === "downstream" && row.path === "staying_parked"), true);
});

test("townhouse stays listed and is quiet unless townhouse_route is hot", () => {
  assert.deepEqual(flow.QUESTIONS.type[1].map(function (opt) { return opt[0]; }), ["sfh", "townhouse", "multi_2_4", "condo", "mobile", "land"]);
  assert.deepEqual(flow.QUESTIONS.ownership[1].map(function (opt) { return opt[0]; }), ["sole_owner", "all_agree", "decision_maker", "no"]);
  const flipped = run();
  flipped.session = flow.createFlow(flipped.adapter, flipped.tag, { townhouse_route: "hot" });
  flipped.session.submitContact(contact);
  flipped.session.answer("type", "townhouse");
  assert.equal(flipped.tag.loaded, false);
  const hot = flipped.session.answer("ownership", "sole_owner");
  assert.equal(hot.view.branch, "hot");
  assert.equal(hot.view.downstream, "zap_hot");
  assert.equal(flipped.tag.loaded, true);
});

test("the dry-run source does not call fetch or name a Google host", () => {
  const src = fs.readFileSync(path.join(__dirname, "two-stage.js"), "utf8");
  assert.equal(src.includes("fetch("), false);
  assert.equal(src.includes("googletagmanager"), false);
  assert.equal(src.includes("supabase"), false);
  global.fetch = function () { throw new Error("network"); };
  const { session } = run();
  session.submitContact(contact);
  session.answer("type", "sfh");
  session.answer("ownership", "sole_owner");
  session.answer("situation", "repairs");
});

function memory() {
  return flow.memoryStorage();
}

function payloads(adapter) {
  const rows = [];
  adapter.log.forEach((row) => {
    if (row.op === "park") rows.push(row.row);
    if (row.op === "stage") rows.push(row.payload);
  });
  return rows;
}

const CLICK = "?test=1&gclid=G-FIRST&gbraid=GB1&wbraid=WB1&fbclid=FB1&utm_source=google&utm_medium=cpc&utm_campaign=sell&utm_term=cash-offer&utm_content=ad1";

test("click ids and UTMs stick on first touch and ride every stage payload", () => {
  assert.equal(flow.TRACKING.gtm_id, "GTM-PLACEHOLDER");
  assert.equal(flow.TRACKING.ga4, false);
  assert.equal(flow.TRACKING.meta_pixel, false);
  assert.equal(flow.TRACKING.lazy, true);
  assert.deepEqual(flow.PAYLOAD_FIELDS, ["lead_id", "stage", "gclid", "gbraid", "wbraid", "fbclid", "utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content"]);
  const local = memory();
  const sessionStore = memory();
  const first = flow.captureAttribution(CLICK, local);
  assert.equal(first.gclid, "G-FIRST");
  assert.equal(first.gbraid, "GB1");
  assert.equal(first.wbraid, "WB1");
  assert.equal(first.fbclid, "FB1");
  assert.equal(first.utm_source, "google");
  assert.equal(first.utm_medium, "cpc");
  assert.equal(first.utm_campaign, "sell");
  assert.equal(first.utm_term, "cash-offer");
  assert.equal(first.utm_content, "ad1");
  const again = flow.captureAttribution("?gclid=LATER&utm_source=facebook&fbclid=NEW", local);
  assert.equal(again.gclid, "G-FIRST");
  assert.equal(again.fbclid, "FB1");
  assert.equal(again.utm_source, "google");
  const ids = [];
  const orig = crypto.randomUUID;
  crypto.randomUUID = () => { const id = orig.call(crypto); ids.push(id); return id; };
  try {
    const tag = { loaded: false, load() { this.loaded = true; } };
    const adapter = flow.createMockAdapter();
    const session = flow.createFlow(adapter, tag, { search: "?gclid=LATER", localStorage: local, sessionStorage: sessionStore, dataLayer: [] });
    session.submitContact(contact);
    session.answer("type", "sfh");
    session.answer("ownership", "sole_owner");
    const same = flow.createFlow(flow.createMockAdapter(), tag, { search: "", localStorage: local, sessionStorage: sessionStore, dataLayer: [] });
    assert.equal(ids.length, 1);
    assert.match(session.state.leadId, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    assert.equal(same.state.leadId, session.state.leadId);
    const other = flow.createFlow(flow.createMockAdapter(), tag, { localStorage: memory(), sessionStorage: memory(), dataLayer: [] });
    assert.notEqual(other.state.leadId, session.state.leadId);
    assert.equal(ids.length, 2);
    for (const row of payloads(adapter)) {
      for (const key of flow.PAYLOAD_FIELDS) assert.equal(typeof row[key], "string", key);
      assert.equal(row.lead_id, session.state.leadId);
      assert.equal(row.gclid, "G-FIRST");
      assert.equal(row.gbraid, "GB1");
      assert.equal(row.wbraid, "WB1");
      assert.equal(row.fbclid, "FB1");
      assert.equal(row.utm_campaign, "sell");
    }
    assert.equal(payloads(adapter).some((row) => row.stage === "contact" && row.name === contact.name), true);
    assert.equal(adapter.log[0].crm, false);
  } finally {
    crypto.randomUUID = orig;
  }
});

test("the hot path records one seller_form_completed and dedupes on lead id", () => {
  const dataLayer = [];
  const local = memory();
  const sessionStore = memory();
  const { tag, adapter, session } = run();
  const hot = flow.createFlow(adapter, tag, { search: CLICK, localStorage: local, sessionStorage: sessionStore, dataLayer });
  hot.submitContact(contact);
  hot.answer("type", "sfh");
  assert.equal(dataLayer.length, 0);
  assert.equal(tag.loaded, false);
  hot.answer("ownership", "sole_owner");
  assert.equal(tag.loaded, true);
  assert.deepEqual(dataLayer.map((e) => e.event), ["seller_form_completed"]);
  assert.equal(dataLayer[0].transaction_id, hot.state.leadId);
  assert.equal(JSON.stringify(dataLayer).includes(contact.email), false);
  assert.equal(JSON.stringify(dataLayer).includes(contact.phone), false);
  assert.equal(JSON.stringify(dataLayer).includes(contact.name), false);
  assert.equal(JSON.stringify(dataLayer).includes("Example"), false);
  hot.answer("occupancy", "owner");
  hot.answer("condition", "wear");
  hot.answer("listed", "yes");
  hot.answer("timeline", "asap");
  assert.equal(dataLayer.filter((e) => e.event === "seller_form_completed").length, 1);
  const second = flow.createFlow(flow.createMockAdapter(), { loaded: false, load() { this.loaded = true; } }, {
    search: CLICK, localStorage: local, sessionStorage: sessionStore, dataLayer
  });
  second.submitContact(contact);
  second.answer("type", "multi_2_4");
  second.answer("ownership", "all_agree");
  assert.equal(dataLayer.filter((e) => e.event === "seller_form_completed").length, 1);
  assert.equal(second.state.leadId, hot.state.leadId);
});

test("non-hot paths never convert and exits carry a reason code", () => {
  assert.equal(flow.conversionName({ type: "sfh", ownership: "sole_owner" }), "seller_form_completed");
  assert.equal(flow.conversionName({ type: "multi_2_4", ownership: "decision_maker" }), "seller_form_completed");
  for (const property of ["townhouse", "condo", "mobile", "land"]) {
    assert.equal(flow.conversionName({ type: property, ownership: "sole_owner" }), "");
  }
  assert.equal(flow.conversionName({ type: "sfh", ownership: "no" }), "");
  assert.equal(flow.exitEvent("quiet_property", { type: "condo" }).reason, "quiet_property");
  assert.equal(flow.exitEvent("quiet_non_owner", {}).reason, "not_owner");
  assert.equal(flow.exitEvent("nurture", {}).reason, "nurture");
  assert.equal(flow.exitEvent("dq", {}).reason, "dq");
  assert.equal(flow.exitEvent("abandoned", {}), null);
  assert.equal(flow.exitEvent("hot", {}), null);
  const quiet = ["townhouse", "condo", "mobile", "land"];
  for (const property of quiet) {
    const dataLayer = [];
    const { tag, session } = run();
    const routed = flow.createFlow(session.adapter, tag, { dataLayer });
    routed.submitContact(contact);
    routed.answer("type", property);
    assert.equal(tag.loaded, false);
    assert.deepEqual(dataLayer.map((e) => e.event), ["seller_form_disqualified"]);
    assert.equal(dataLayer[0].reason, "quiet_property");
    assert.equal(dataLayer[0].property_type, property);
    assert.equal(dataLayer[0].transaction_id, routed.state.leadId);
    assert.equal(JSON.stringify(dataLayer).includes(contact.email), false);
  }
  const dataLayer = [];
  const { tag, session } = run();
  const owner = flow.createFlow(session.adapter, tag, { dataLayer });
  owner.submitContact(contact);
  assert.equal(dataLayer.length, 0);
  owner.answer("type", "sfh");
  owner.answer("ownership", "no");
  assert.equal(tag.loaded, false);
  assert.equal(owner.state.downstream, "crm_follow_up");
  assert.deepEqual(dataLayer.map((e) => e.reason), ["not_owner"]);
  const leftLayer = [];
  const left = flow.createFlow(flow.createMockAdapter(), { loaded: false, load() { this.loaded = true; } }, { dataLayer: leftLayer });
  left.submitContact(contact);
  left.abandon();
  assert.equal(leftLayer.length, 0);
  assert.equal(left.state.downstream, "staying_parked");
});

test("enrichment is skippable, stays on the hot lead, and does not move the conversion", () => {
  const dataLayer = [];
  const { tag, adapter, session } = run();
  const hot = flow.createFlow(adapter, tag, { dataLayer });
  hot.submitContact(contact);
  hot.answer("type", "multi_2_4");
  hot.answer("ownership", "all_agree");
  assert.equal(dataLayer.length, 1);
  assert.equal(hot.state.stage, "enrich");
  assert.equal(hot.skip().view.screen, "condition");
  assert.equal(hot.skip().view.screen, "listed");
  assert.equal(hot.skip().view.screen, "timeline");
  const done = hot.skip();
  assert.equal(done.view.stage, "thanks");
  assert.equal(done.view.branch, "hot");
  assert.equal(done.view.downstream, "zap_hot");
  assert.equal(done.view.googleTagFired, true);
  assert.equal(done.view.priority, "");
  assert.equal(done.view.serverTier, "p3");
  assert.equal(dataLayer.filter((e) => e.event === "seller_form_completed").length, 1);
  assert.equal(adapter.log.filter((row) => row.op === "google" && row.fired).length, 1);
  assert.equal(payloads(adapter).filter((row) => row.stage === "enrich" && row.skipped === true).length, 4);
  assert.equal(payloads(adapter).every((row) => row.lead_id === hot.state.leadId), true);
  const answered = flow.createFlow(flow.createMockAdapter(), { loaded: false, load() { this.loaded = true; } }, { dataLayer: [] });
  answered.submitContact(contact);
  answered.answer("type", "sfh");
  answered.answer("ownership", "sole_owner");
  const before = answered.state.dataLayer.length;
  answered.answer("occupancy", "tenant");
  answered.answer("condition", "repairs");
  const listed = answered.answer("listed", "yes");
  assert.equal(listed.view.branch, "hot");
  assert.equal(listed.view.downstream, "zap_hot");
  assert.equal(listed.view.screen, "timeline");
  answered.answer("timeline", "30d");
  assert.equal(answered.state.stage, "thanks");
  assert.equal(answered.state.dataLayer.length, before);
  assert.equal(answered.state.answers.listed, "yes");
  const thanks = payloads(answered.adapter).find((row) => row.stage === "thanks");
  assert.equal(thanks.lead_id, answered.state.leadId);
  assert.equal(thanks.listed, "yes");
  assert.equal(thanks.occupancy, "tenant");
});

test("the mock tier comes only from the claim and complete responses", () => {
  assert.equal(flow.priorityTier, undefined);
  assert.equal(flow.serverPriorityTier, undefined);
  const mock = flow.createMockAdapter();
  assert.equal(mock.claim({ by: "promote" }).priority_tier, "p3");
  assert.equal(mock.complete({ enrichment: { occupancy: "vacant" } }).priority_tier, "p1");
  assert.equal(mock.complete({ enrichment: { timeline: "asap", condition: "needs_work" } }).priority_tier, "p1");
  assert.equal(mock.complete({ enrichment: { timeline: "30d", listed: "expired" } }).priority_tier, "p1");
  assert.equal(mock.complete({ enrichment: { timeline: "asap", listed: "listed_over_90" } }).priority_tier, "p1");
  assert.equal(mock.complete({ enrichment: { timeline: "30d", condition: "major_repairs" } }).priority_tier, "p1");
  assert.equal(mock.complete({ enrichment: { timeline: "30_90d", condition: "excellent" } }).priority_tier, "p2");
  assert.equal(mock.complete({ enrichment: { timeline: "asap", condition: "good", listed: "not_listed" } }).priority_tier, "p2");
  assert.equal(mock.complete({ enrichment: { timeline: "no_rush", condition: "needs_work" } }).priority_tier, "p3");
  const { session } = run();
  session.submitContact(contact);
  session.answer("type", "sfh");
  session.answer("ownership", "decision_maker");
  assert.equal(session.state.serverTier, "p3");
  assert.equal(session.state.priority, "");
  session.answer("occupancy", "vacant");
  session.answer("condition", "good");
  session.answer("listed", "not_listed");
  session.answer("timeline", "no_rush");
  assert.equal(session.state.serverTier, "p1");
  assert.equal(session.state.branch, "hot");
  assert.equal(session.state.downstream, "zap_hot");
  const priced = flow.createFlow(flow.createMockAdapter(), { loaded: false, load() { this.loaded = true; } });
  priced.submitContact(contact);
  priced.answer("type", "multi_2_4");
  priced.answer("ownership", "sole_owner");
  priced.skip();
  priced.skip();
  priced.answer("listed", "not_listed");
  priced.answer("timeline", "no_rush");
  assert.equal(priced.state.stage, "thanks");
  assert.equal(priced.state.serverTier, "p3");
  assert.equal(priced.state.priority, "");
  assert.equal(priced.state.downstream, "zap_hot");
  const quiet = flow.createFlow(flow.createMockAdapter(), { loaded: false, load() { this.loaded = true; } });
  quiet.submitContact(contact);
  quiet.answer("type", "land");
  assert.equal(quiet.answer("occupancy", "vacant").error, "unexpected_answer");
  assert.equal(quiet.state.branch, "quiet_property");
});

test("banned phrases fail the test-form check", () => {
  const { execFileSync } = require("node:child_process");
  const root = path.join(__dirname, "..");
  const samples = {
    close: "We can close in 7 days.",
    days: "A 7 days to close promise.",
    closing: "Closing in 14 days is not allowed.",
    hand: "Every file is reviewed by hand.",
    person: "These are person-reviewed offers.",
    person2: "Each one is personally reviewed.",
    stars: "5-star rated on Facebook.",
    stars2: "Facebook star rating.",
    ok: "Within 30 days is a timeline answer, not a promise."
  };
  const report = JSON.parse(execFileSync("python3", ["-c", `
import json, sys
sys.path.insert(0, "build")
import gen
samples = json.loads(sys.stdin.read())
out = {name: gen.banned_test_form_hits(text) for name, text in samples.items()}
errors = []
gen.check_test_form(errors)
out["check"] = errors
print(json.dumps(out))
`], { cwd: root, input: JSON.stringify(samples), encoding: "utf8" }));
  assert.ok(report.close.includes("close_in_days"));
  assert.ok(report.days.includes("days_to_close"));
  assert.ok(report.closing.includes("closing_in_days"));
  assert.ok(report.hand.includes("by_hand"));
  assert.ok(report.person.includes("person_reviewed"));
  assert.ok(report.person2.includes("person_reviewed"));
  assert.ok(report.stars.includes("facebook_stars"));
  assert.ok(report.stars2.includes("facebook_stars"));
  assert.deepEqual(report.ok, []);
  assert.deepEqual(report.check, []);
  const src = fs.readFileSync(path.join(__dirname, "two-stage.js"), "utf8");
  for (const needle of ["fetch(", "googletagmanager", "maps.googleapis", "places.googleapis", "google-analytics", "facebook.net", "gtag("]) {
    assert.equal(src.includes(needle), false, needle);
  }
});

test("click ids, utms, and lead id are write-once per field", () => {
  const local = memory();
  const first = flow.captureAttribution("?gclid=G-FIRST&utm_source=google", local);
  assert.equal(first.gclid, "G-FIRST");
  assert.equal(first.fbclid, "");
  const added = flow.captureAttribution("?gclid=LATER&fbclid=FB-NEW&utm_source=facebook&utm_id=camp-1", local);
  assert.equal(added.gclid, "G-FIRST");
  assert.equal(added.utm_source, "google");
  assert.equal(added.fbclid, "FB-NEW");
  assert.equal(added.utm_id, "camp-1");
  const sessionStore = memory();
  sessionStore.setItem(flow.TRACKING.lead_key, "lead_already_set");
  const calls = [];
  const orig = crypto.randomUUID;
  crypto.randomUUID = () => { calls.push("mint"); return orig.call(crypto); };
  try {
    const session = flow.createFlow(flow.createMockAdapter(), { loaded: false, load() {} }, { sessionStorage: sessionStore, localStorage: local });
    assert.equal(session.state.leadId, "lead_already_set");
    assert.equal(calls.length, 0);
  } finally {
    crypto.randomUUID = orig;
  }
});

test("a disagreeing claim response decides the screen and blocks reserve", () => {
  const { tag, adapter, session } = run();
  adapter.claim = (req) => {
    adapter.log.push({ op: "claim", req });
    return { ok: true, claimed: true, tier: "follow_up", status: "claimed" };
  };
  adapter.reserve = () => { throw new Error("reserve"); };
  session.submitContact(contact);
  session.answer("type", "sfh");
  const done = session.answer("ownership", "sole_owner");
  assert.equal(done.view.branch, "quiet_non_owner");
  assert.equal(done.view.googleTagFired, false);
  assert.equal(tag.loaded, false);
  assert.equal(done.view.conversionFired, false);
  assert.equal(session.state.trace.some((row) => row.id === "server" && row.text.includes("overrides")), true);
  const stopped = flow.createFlow(flow.createMockAdapter(), { loaded: false, load() { this.loaded = true; } });
  stopped.adapter.claim = () => ({ ok: true, claimed: false, status: "already_claimed" });
  stopped.adapter.reserve = () => { throw new Error("reserve"); };
  stopped.submitContact(contact);
  stopped.answer("type", "multi_2_4");
  const held = stopped.answer("ownership", "all_agree");
  assert.equal(held.view.branch, "stopped");
  assert.equal(held.view.googleTagFired, false);
  assert.equal(held.view.conversionFired, false);
  assert.equal(stopped.state.trace.some((row) => row.text.includes("No reserve")), true);
});

test("server priority_tier is shown from the response and is not sent by the client", () => {
  const { adapter, session } = run();
  session.submitContact(contact);
  session.answer("type", "sfh");
  session.answer("ownership", "sole_owner");
  session.answer("occupancy", "vacant");
  session.answer("condition", "needs_work");
  session.answer("listed", "not_listed");
  session.answer("timeline", "asap");
  assert.equal(session.state.serverTier, "p1");
  assert.equal(session.state.trace.some((row) => row.id === "tier" && row.text.includes("p1")), true);
  const sent = adapter.log.find((row) => row.op === "complete");
  assert.equal(sent.req.priority, undefined);
  assert.equal(sent.req.enrichment.occupancy, "vacant");
  assert.equal(Object.prototype.hasOwnProperty.call(sent.req.enrichment, "price_vs_value"), false);
  assert.equal(payloads(adapter).every((row) => row.priority === undefined), true);
  assert.equal(JSON.stringify(adapter.log).includes("price_vs_value"), false);
  assert.equal(JSON.stringify(session.state.trace).includes("price_vs_value"), false);
});

test("the real adapter matches the draft call shapes and never uses the network", () => {
  const src = fs.readFileSync(path.join(__dirname, "two-stage.js"), "utf8");
  assert.equal(src.includes("fetch("), false);
  assert.equal(src.includes("INTAKE_HMAC_KEY"), false);
  assert.equal(src.includes("INTAKE_ZAP_TOKEN"), false);
  assert.equal(flow.REAL_ADAPTER.enabled, false);
  assert.equal(flow.REAL_ADAPTER.base_url, "https://placeholder.invalid/functions/v1");
  assert.equal(flow.PRICE_VS_VALUE_WIRE, undefined);
  assert.deepEqual(flow.ENRICH_STEPS, ["occupancy", "condition", "listed", "timeline"]);
  let usedNetwork = false;
  global.fetch = () => { usedNetwork = true; throw new Error("network"); };
  let calls = 0;
  const blocked = flow.selectAdapter({
    adapter: "real",
    context: "production",
    search: "?test=1",
    transport() { calls += 1; throw new Error("network"); }
  });
  blocked.park({ name: "TEST LEAD", address: "100 Example Ave", phone: "5550100199", email: contact.email });
  assert.equal(calls, 0);
  assert.equal(blocked.log[0].op, "park");
  const noTransport = flow.selectAdapter({ adapter: "real", context: "local", search: "?test=1" });
  noTransport.park({ name: "A", address: "B", phone: "5550100199", email: "a@b.co" });
  assert.equal(noTransport.log[0].op, "park");

  const seen = [];
  let n = 0;
  function uuid() {
    n += 1;
    return "00000000-0000-4000-8000-" + String(n).padStart(12, "0");
  }
  const transport = (url, init) => {
    const body = JSON.parse(init.body);
    seen.push({ url, method: init.method, headers: init.headers, body });
    if (url.endsWith("/mint")) {
      return { status: 200, body: { ok: true, intake_id: "intake-from-mint", session_binding: "bind-from-mint", kid: "kid-from-mint" } };
    }
    if (body.payload && body.payload.phone === "000") {
      return { status: 400, body: { status: "bad_input", fields: ["phone", "email"] } };
    }
    if (url.endsWith("/claim") && body.payload && body.payload.by === "promote" && body.payload.lead_id === "lead-disagree") {
      return { status: 200, body: { ok: true, claimed: true, tier: "follow_up", priority_tier: "p3", status: "claimed" } };
    }
    if (url.endsWith("/reserve")) {
      return { status: 200, body: { ok: true, status: "dispatch_intended_committed", reservation_id: "res-1", reservation_generation: 2, session_binding: body.session_binding, execution_requested: false, exactly_once_external: false, owner_token: "OWNER-TOKEN-DO-NOT-LOG", owner_token_issued: true } };
    }
    if (url.endsWith("/complete")) return { status: 200, body: { ok: true, status: "delivered", priority_tier: "p1" } };
    if (url.endsWith("/reconcile") && body.envelope) {
      return { status: 200, body: { ok: true, status: "needs_reconcile", needs_reconcile: true } };
    }
    if (url.endsWith("/park")) return { status: 200, body: { ok: true, status: "parked", intake_id: "intake-1", geocode_status: "ok" } };
    return { status: 200, body: { ok: true, status: "saved" } };
  };
  const adapter = flow.createRealAdapter({ transport, uuid, now: () => 1700000000, signer: { client_ip: "203.0.113.7" } });
  const track = { lead_id: "lead-1", gclid: "G-FIRST", gbraid: "GB1", wbraid: "WB1", fbclid: "FB1", utm_source: "google", utm_medium: "cpc", utm_campaign: "sell", utm_term: "cash", utm_content: "ad", utm_id: "u1" };
  const parked = adapter.park(Object.assign({ name: "TEST LEAD", address: "100 Example Ave", phone: "(555) 010-0199", email: contact.email }, track));
  assert.equal(parked.status, "parked");
  assert.equal(parked.owner_token, undefined);
  adapter.answer(Object.assign({ question: "type", answer: "sfh", gclid: "LATER" }, track));
  adapter.answer(Object.assign({ question: "ownership", answer: "sole_owner" }, track));
  adapter.claim(Object.assign({ by: "promote", gclid: "LATER" }, track));
  const reserved = adapter.reserve(Object.assign({ destination: "crm_create", stage: "final" }, track));
  assert.equal(reserved.owner_token, undefined);
  assert.equal(reserved.reservation_id, "res-1");
  adapter.complete(Object.assign({ mode: "hmac", enrichment: { occupancy: "vacant", condition: "needs_work", price_vs_value: "under_80", listed: "listed_over_90", timeline: "asap" } }, track));
  const verified = adapter.verify({ reservation_id: "res-1", intake_id: adapter.intakeId, token: "supplied-for-the-test" });
  assert.equal(verified.status, "saved");
  const noToken = adapter.verify({ reservation_id: "res-1" });
  assert.equal(noToken.http, 401);
  adapter.complete(Object.assign({ mode: "token", token: "supplied-for-the-test", remote_id: "crm-1", enrichment: { timeline: "30d", price_vs_value: "80_100" } }, track));
  adapter.reconcile({ mode: "token", token: "supplied-for-the-test", reason: "check\u0001" });
  const hmacReconcile = adapter.reconcile({ mode: "hmac", reason: "check\u0007" });
  assert.equal(hmacReconcile.status, "needs_reconcile");
  assert.equal(hmacReconcile.needs_reconcile, true);
  adapter.reserve(Object.assign({ destination: "crm_create", stage: "first" }, track));
  adapter.reconcile({ mode: "hmac", reason: "later" });
  const bad = adapter.park(Object.assign({ name: "TEST LEAD", phone: "000", email: "bad", address: "100 Example Ave" }, track));
  assert.equal(bad.ok, false);
  assert.equal(bad.http, 400);
  assert.deepEqual(bad.fields, ["phone", "email"]);
  assert.equal(usedNetwork, false);

  function call(path) { return seen.filter((row) => row.url === flow.REAL_ADAPTER.base_url + path); }
  const paths = ["/intake-reserve/mint", "/intake-park/park", "/intake-park/answer", "/intake-park/claim", "/intake-reserve/reserve", "/intake-reserve/verify", "/intake-reserve/complete", "/intake-reserve/reconcile"];
  paths.forEach((path) => assert.ok(call(path).length > 0, path));
  seen.forEach((row) => {
    assert.equal(row.method, "POST");
    assert.equal(row.headers["content-type"], "application/json");
    assert.equal(row.url.startsWith("https://placeholder.invalid/"), true);
    const signed = /\/intake-park\/(park|answer|claim)$/.test(row.url);
    const ip = row.body && row.body.payload ? row.body.payload.client_ip : undefined;
    assert.equal(ip, signed ? "203.0.113.7" : undefined, row.url);
    assert.equal(row.body && row.body.payload ? row.body.payload.attribution : undefined, undefined);
  });
  const mint = call("/intake-reserve/mint")[0];
  assert.deepEqual(mint.body, {});
  assert.equal(mint.body.envelope, undefined);
  assert.equal(seen[0].url.endsWith("/intake-reserve/mint"), true);
  const park = call("/intake-park/park")[0].body;
  assert.equal(park.envelope.stage, "partial");
  assert.equal(park.envelope.v, "1");
  assert.equal(park.envelope.kid, "kid-from-mint");
  assert.equal(park.envelope.intake_id, "intake-from-mint");
  assert.equal(park.envelope.route, "ppc_inhouse");
  assert.equal(park.envelope.channel, "website");
  assert.equal(park.envelope.sig, "");
  assert.equal(park.envelope.exp, park.envelope.ts + 900);
  assert.equal(park.envelope.payload_sha256, flow.sha256Hex(flow.canonicalJson(park.payload)));
  assert.equal(park.session_binding, "bind-from-mint");
  assert.equal(adapter.intakeId, "intake-from-mint");
  assert.equal(adapter.sessionBinding, "bind-from-mint");
  assert.equal(park.payload.full_name, "TEST LEAD");
  assert.equal(park.payload.first_name, undefined);
  assert.equal(park.payload.last_name, undefined);
  assert.equal(park.payload.address_line, "100 Example Ave");
  assert.equal(park.payload.address, undefined);
  assert.equal(park.payload.client_ip, "203.0.113.7");
  assert.equal(park.payload.phone, "5550100199");
  assert.equal(park.payload.email, contact.email);
  assert.equal(park.payload.is_test, true);
  assert.equal(park.payload.gclid, "G-FIRST");
  assert.equal(park.payload.lead_id, "lead-1");
  assert.equal(park.payload.utm_id, "u1");
  assert.equal(park.payload.enrichment, undefined);
  assert.equal(park.payload.attribution, undefined);
  const answers = call("/intake-park/answer").map((row) => row.body);
  assert.deepEqual(answers.map((row) => row.payload.question), ["type", "ownership"]);
  assert.equal(answers[0].payload.answer, "sfh");
  assert.equal(answers[0].payload.gclid, "G-FIRST");
  assert.equal(answers[0].payload.client_ip, "203.0.113.7");
  assert.equal(answers[0].payload.enrichment, undefined);
  assert.equal(answers[0].envelope.intake_id, "intake-from-mint");
  assert.equal(answers[0].envelope.stage, "partial");
  const claim = call("/intake-park/claim")[0].body;
  assert.equal(claim.payload.by, "promote");
  assert.equal(claim.payload.lead_id, "lead-1");
  assert.equal(claim.payload.client_ip, "203.0.113.7");
  assert.equal(claim.envelope.stage, "partial");
  const reserve = call("/intake-reserve/reserve")[0].body;
  assert.equal(reserve.envelope.stage, "final");
  assert.equal(reserve.destination, "crm_create");
  assert.equal(reserve.lease_seconds, 120);
  assert.equal(reserve.session_binding, adapter.sessionBinding);
  assert.match(reserve.owner_token, /^[0-9a-f-]{36}$/);
  assert.equal(reserve.payload.gclid, "G-FIRST");
  assert.equal(reserve.payload.client_ip, undefined);
  assert.equal(reserve.envelope.intake_id, "intake-from-mint");
  const verify = call("/intake-reserve/verify");
  assert.equal(verify.length, 1);
  assert.equal(verify[0].headers["x-intake-zap-token"], "supplied-for-the-test");
  assert.equal(verify[0].body.reservation_id, "res-1");
  assert.equal(verify[0].body.envelope, undefined);
  const completes = call("/intake-reserve/complete");
  assert.equal(completes[0].body.payload.enrichment.occupancy, "vacant");
  assert.equal(completes[0].body.payload.client_ip, undefined);
  assert.equal(completes[0].body.payload.priority_tier, undefined);
  assert.equal(completes[0].body.envelope.stage, "final");
  assert.equal(completes[0].body.reservation_id, "res-1");
  assert.equal(completes[0].body.reservation_generation, 2);
  assert.equal(completes[1].headers["x-intake-zap-token"], "supplied-for-the-test");
  assert.equal(completes[1].body.envelope, undefined);
  assert.equal(completes[1].body.enrichment.timeline, "30d");
  assert.equal(completes[1].body.enrichment.timeline, "30d");
  assert.equal(completes[1].body.client_ip, undefined);
  assert.equal(completes[1].body.intake_id, adapter.intakeId);
  assert.equal(src.includes("price_vs_value"), false);
  assert.equal(JSON.stringify(seen).includes("price_vs_value"), false);
  assert.equal(JSON.stringify(seen).includes("attribution"), false);
  const reconciles = call("/intake-reserve/reconcile");
  assert.equal(reconciles[0].headers["x-intake-zap-token"], "supplied-for-the-test");
  assert.equal(reconciles[0].body.reason, "check");
  assert.equal(reconciles[0].body.envelope, undefined);
  assert.equal(reconciles[1].body.envelope.stage, "final");
  assert.equal(reconciles[1].body.envelope.intake_id, "intake-from-mint");
  assert.equal(reconciles[1].body.payload.reason, "check");
  assert.equal(reconciles[1].body.owner_token, undefined);
  assert.equal(reconciles[1].body.session_binding, undefined);
  assert.equal(reconciles[1].body.payload.client_ip, undefined);
  assert.equal(reconciles[2].body.envelope.stage, "first");
  assert.equal(reconciles[2].body.envelope.intake_id, "intake-from-mint");
  assert.equal(reconciles[2].body.owner_token, undefined);
  assert.equal(reconciles[2].body.session_binding, undefined);

  const flowCalls = [];
  const live = flow.createRealAdapter({
    transport(url, init) {
      const body = JSON.parse(init.body);
      flowCalls.push(url);
      if (url.endsWith("/mint")) return { status: 200, body: { ok: true, intake_id: "minted-intake", session_binding: "minted-binding", kid: "kid-from-mint" } };
      if (url.endsWith("/claim")) return { status: 200, body: { ok: true, claimed: true, tier: "follow_up", priority_tier: "p3", status: "claimed" } };
      if (url.endsWith("/park")) return { status: 200, body: { ok: true, status: "parked", intake_id: "i", geocode_status: "ok" } };
      return { status: 200, body: { ok: true, status: "saved" } };
    }
  });
  const session = flow.createFlow(live, { loaded: false, load() { this.loaded = true; } });
  session.submitContact(contact);
  session.answer("type", "sfh");
  const overruled = session.answer("ownership", "sole_owner");
  assert.equal(overruled.view.branch, "quiet_non_owner");
  assert.equal(overruled.view.googleTagFired, false);
  assert.equal(flowCalls.some((url) => url.endsWith("/intake-reserve/mint")), true);
  assert.equal(flowCalls.some((url) => url.endsWith("/reserve")), false);
  assert.equal(JSON.stringify(session.state.trace).includes("OWNER-TOKEN-DO-NOT-LOG"), false);
  assert.equal(usedNetwork, false);
});
