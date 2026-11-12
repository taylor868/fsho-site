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

test("production never enables test mode, and other builds still need test=1", () => {
  assert.equal(flow.testModeAllowed("production", "?test=1"), false);
  assert.equal(flow.testModeAllowed("production", "?x=1&test=1"), false);
  assert.equal(flow.testModeAllowed("production", ""), false);
  assert.equal(flow.testModeAllowed("production", "?test=2"), false);
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

test("quiet property types go to the self-serve sweep after 10 minutes and never load the tag", () => {
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

test("abandoning after stage 1 is tagged timeout for the 10 minute sweep and does not load the tag", () => {
  const { tag, adapter, session } = run();
  session.submitContact(contact);
  const left = session.abandon();
  assert.equal(left.view.branch, "abandoned");
  assert.equal(left.view.downstream, "self_serve_timeout");
  assert.equal(left.view.googleTagFired, false);
  assert.equal(tag.loaded, false);
  assert.equal(session.answer("type", "sfh").error, "unexpected_answer");
  assert.equal(adapter.log.some((row) => row.op === "park"), true);
  assert.equal(adapter.log.some((row) => row.op === "downstream" && row.path === "self_serve_timeout"), true);
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

test("the dry-run source does not call fetch and waits to load the container", () => {
  const src = fs.readFileSync(path.join(__dirname, "two-stage.js"), "utf8");
  assert.equal(src.includes("fetch("), false);
  assert.equal(src.includes("pointerdown"), true);
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
  assert.equal(flow.TRACKING.gtm_id, "GTM-WWPBQGDZ");
  assert.equal(flow.CONFIG.gtm_id, "GTM-WWPBQGDZ");
  assert.equal(flow.CONFIG.use_real_adapter, false);
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
  assert.equal(left.state.downstream, "self_serve_timeout");
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
  assert.equal(done.view.serverTier, "");
  assert.equal(done.view.tierPending, true);
  assert.deepEqual(adapter.log.find((row) => row.op === "enrich").req.enrichment, {});
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
  assert.equal(mock.claim({ by: "promote" }).priority_tier, null);
  assert.equal(mock.enrich({ enrichment: { occupancy: "vacant" } }).priority_tier, "p1");
  assert.equal(mock.enrich({ enrichment: { timeline: "asap", condition: "needs_work" } }).priority_tier, "p1");
  assert.equal(mock.enrich({ enrichment: { timeline: "30d", listed: "expired" } }).priority_tier, "p1");
  assert.equal(mock.enrich({ enrichment: { timeline: "asap", listed: "listed_over_90" } }).priority_tier, "p1");
  assert.equal(mock.enrich({ enrichment: { timeline: "30d", condition: "major_repairs" } }).priority_tier, "p1");
  assert.equal(mock.enrich({ enrichment: { timeline: "30_90d", condition: "excellent" } }).priority_tier, "p2");
  assert.equal(mock.enrich({ enrichment: { timeline: "asap", condition: "good", listed: "not_listed" } }).priority_tier, "p2");
  assert.equal(mock.enrich({ enrichment: { timeline: "no_rush", condition: "needs_work" } }).priority_tier, "p3");
  assert.equal(mock.enrich({ enrichment: {} }).priority_tier, null);
  const { session } = run();
  session.submitContact(contact);
  session.answer("type", "sfh");
  session.answer("ownership", "decision_maker");
  assert.equal(session.state.serverTier, "");
  assert.equal(session.state.tierPending, true);
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
  for (const needle of ["fetch(", "maps.googleapis", "places.googleapis", "google-analytics", "facebook.net", "gtag("]) {
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
  stopped.adapter.claim = () => ({ ok: true, claimed: false, status: "already_claimed", reserved: true });
  stopped.adapter.reserve = () => { throw new Error("reserve"); };
  stopped.submitContact(contact);
  stopped.answer("type", "multi_2_4");
  const held = stopped.answer("ownership", "all_agree");
  assert.equal(held.ok, true);
  assert.equal(held.view.branch, "stopped");
  assert.equal(held.view.stage, "thanks");
  assert.equal(held.view.googleTagFired, false);
  assert.equal(held.view.conversionFired, false);
  assert.equal(stopped.state.thanks.headline, flow.THANKS.headline);
  assert.equal(stopped.state.thanks.body, flow.THANKS.body);
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
  const sent = adapter.log.find((row) => row.op === "enrich");
  assert.equal(sent.req.priority, undefined);
  assert.equal(sent.req.enrichment.occupancy, "vacant");
  assert.equal(Object.prototype.hasOwnProperty.call(sent.req.enrichment, "price_vs_value"), false);
  assert.equal(payloads(adapter).every((row) => row.priority === undefined), true);
  assert.equal(JSON.stringify(adapter.log).includes("price_vs_value"), false);
  assert.equal(JSON.stringify(session.state.trace).includes("price_vs_value"), false);
});

test("the real adapter matches the draft call shapes and never uses the network", async () => {
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
    search: "",
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
  const adapter = flow.createRealAdapter({ transport, uuid, now: () => 1700000000, signer: { client_ip: "203.0.113.7" }, isTest: true });
  const track = { lead_id: "lead-1", gclid: "G-FIRST", gbraid: "GB1", wbraid: "WB1", fbclid: "FB1", utm_source: "google", utm_medium: "cpc", utm_campaign: "sell", utm_term: "cash", utm_content: "ad", utm_id: "u1" };
  const parked = await adapter.park(Object.assign({ name: "TEST LEAD", address: "100 Example Ave", phone: "(555) 010-0199", email: contact.email }, track));
  assert.equal(adapter.intakeId, "intake-from-mint");
  assert.equal(parked.status, "parked");
  assert.equal(parked.owner_token, undefined);
  await adapter.answer(Object.assign({ question: "type", answer: "sfh", gclid: "LATER" }, track));
  await adapter.answer(Object.assign({ question: "ownership", answer: "sole_owner" }, track));
  await adapter.claim(Object.assign({ by: "promote", gclid: "LATER" }, track));
  const reserved = await adapter.reserve(Object.assign({ destination: "crm_create", stage: "final" }, track));
  assert.equal(reserved.owner_token, undefined);
  assert.equal(reserved.reservation_id, "res-1");
  await adapter.complete(Object.assign({ mode: "hmac", enrichment: { occupancy: "vacant", condition: "needs_work", price_vs_value: "under_80", listed: "listed_over_90", timeline: "asap" } }, track));
  const verified = await adapter.verify({ reservation_id: "res-1", intake_id: adapter.intakeId, token: "supplied-for-the-test" });
  assert.equal(verified.status, "saved");
  const noToken = await adapter.verify({ reservation_id: "res-1" });
  assert.equal(noToken.http, 401);
  await adapter.complete(Object.assign({ mode: "token", token: "supplied-for-the-test", remote_id: "crm-1", enrichment: { timeline: "30d", price_vs_value: "80_100" } }, track));
  await adapter.reconcile({ mode: "token", token: "supplied-for-the-test", reason: "check\u0001" });
  const hmacReconcile = await adapter.reconcile({ mode: "hmac", reason: "check\u0007" });
  assert.equal(hmacReconcile.status, "needs_reconcile");
  assert.equal(hmacReconcile.needs_reconcile, true);
  await adapter.reserve(Object.assign({ destination: "crm_create", stage: "first" }, track));
  await adapter.reconcile({ mode: "hmac", reason: "later" });
  const bad = await adapter.park(Object.assign({ name: "TEST LEAD", phone: "000", email: "bad", address: "100 Example Ave" }, track));
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
    const signed = /\/intake-park\/(park|answer|claim|enrich)$/.test(row.url);
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
  assert.equal(completes[0].body.payload.enrichment, undefined);
  assert.equal(completes[0].body.payload.client_ip, undefined);
  assert.equal(completes[0].body.payload.priority_tier, undefined);
  assert.equal(completes[0].body.envelope.stage, "final");
  assert.equal(completes[0].body.reservation_id, "res-1");
  assert.equal(completes[0].body.reservation_generation, 2);
  assert.equal(completes[1].headers["x-intake-zap-token"], "supplied-for-the-test");
  assert.equal(completes[1].body.envelope, undefined);
  assert.equal(completes[1].body.enrichment, undefined);
  assert.equal(completes[1].body.lead_id, "lead-1");
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
  await session.submitContact(contact);
  await session.answer("type", "sfh");
  const overruled = await session.answer("ownership", "sole_owner");
  assert.equal(overruled.view.branch, "quiet_non_owner");
  assert.equal(overruled.view.googleTagFired, false);
  assert.equal(flowCalls.some((url) => url.endsWith("/intake-reserve/mint")), true);
  assert.equal(flowCalls.some((url) => url.endsWith("/reserve")), false);
  assert.equal(JSON.stringify(session.state.trace).includes("OWNER-TOKEN-DO-NOT-LOG"), false);
  assert.equal(usedNetwork, false);
});

test("async and Response-shaped transports set mint ids before every later stage", async () => {
  assert.equal(flow.ENRICH_VIA_PARK, undefined);
  function script(url) {
    if (url.endsWith("/mint")) {
      return { ok: true, intake_id: "async-intake", session_binding: "async-bind", kid: "async-kid" };
    }
    if (url.endsWith("/claim")) return { ok: true, claimed: true, tier: "hot", priority_tier: null, status: "claimed" };
    if (url.endsWith("/reserve")) return { ok: true, status: "dispatch_intended_committed" };
    if (url.endsWith("/enrich")) return { ok: true, status: "saved", priority_tier: "p1" };
    if (url.endsWith("/park")) return { ok: true, status: "parked", intake_id: "async-intake", geocode_status: "ok" };
    return { ok: true, status: "saved" };
  }
  const seen = [];
  const delayed = (url, init) => new Promise((resolve) => {
    setTimeout(() => {
      seen.push(url);
      const payload = script(url);
      resolve({
        status: 200,
        headers: { get: () => "" },
        json: () => new Promise((done) => queueMicrotask(() => done(payload)))
      });
    }, 0);
  });
  const adapter = flow.createRealAdapter({ transport: delayed, signer: { client_ip: "203.0.113.7" }, now: () => 1700000000 });
  let parked;
  const pending = adapter.park({ name: "TEST LEAD", address: "100 Example Ave", phone: "5550100199", email: contact.email, lead_id: "lead-async" });
  assert.equal(adapter.intakeId, "");
  parked = await pending;
  assert.equal(seen[0].endsWith("/intake-reserve/mint"), true);
  assert.equal(seen[1].endsWith("/intake-park/park"), true);
  assert.equal(adapter.intakeId, "async-intake");
  assert.equal(adapter.sessionBinding, "async-bind");
  assert.equal(parked.status, "parked");
  assert.equal(parked.http, 200);
  const answered = await adapter.answer({ question: "type", answer: "sfh", lead_id: "lead-async" });
  const claimed = await adapter.claim({ by: "promote", lead_id: "lead-async" });
  const enriched = await adapter.enrich({ enrichment: { occupancy: "vacant", condition: "good", listed: "not_listed", timeline: "asap" }, lead_id: "lead-async" });
  assert.equal(answered.ok, true);
  assert.equal(claimed.ok, true);
  assert.equal(enriched.priority_tier, "p1");
  const enrichCall = seen.map((url, i) => url.endsWith("/intake-park/enrich") ? i : -1).filter((i) => i >= 0);
  assert.equal(enrichCall.length, 1);
  const tag = { loaded: false, load() { this.loaded = true; } };
  const session = flow.createFlow(adapter, tag);
  await session.submitContact(contact);
  await session.answer("type", "sfh");
  await session.answer("ownership", "sole_owner");
  assert.equal(tag.loaded, true);
  await session.answer("occupancy", "vacant");
  await session.answer("condition", "needs_work");
  await session.answer("listed", "not_listed");
  await session.answer("timeline", "asap");
  assert.equal(session.state.serverTier, "p1");
  assert.equal(seen.some((url) => url.endsWith("/intake-reserve/complete")), false);
  assert.equal(seen.filter((url) => url.endsWith("/intake-park/enrich")).length >= 1, true);
});

test("enrich returns the saved tier, sends {} when skipped, and retries one unavailable response", async () => {
  function mint(url) {
    return url.endsWith("/mint");
  }
  const savedCalls = [];
  const saved = flow.createRealAdapter({
    enrichRetryMs: 0,
    signer: { client_ip: "203.0.113.7" },
    now: () => 1700000000,
    transport(url, init) {
      const body = JSON.parse(init.body);
      savedCalls.push({ url, body });
      if (mint(url)) return { status: 200, body: { ok: true, intake_id: "enrich-intake", session_binding: "enrich-bind", kid: "enrich-kid" } };
      return { status: 200, body: { ok: true, status: "saved", priority_tier: "p1" } };
    }
  });
  const ok = await saved.enrich({ enrichment: { occupancy: "vacant" }, lead_id: "lead-e", gclid: "G-E" });
  assert.equal(ok.priority_tier, "p1");
  const post = savedCalls.find((row) => row.url.endsWith("/intake-park/enrich"));
  assert.equal(post.body.envelope.stage, "partial");
  assert.equal(post.body.envelope.channel, "website");
  assert.equal(post.body.envelope.intake_id, "enrich-intake");
  assert.equal(post.body.session_binding, undefined);
  assert.deepEqual(Object.keys(post.body).sort(), ["envelope", "payload"]);
  assert.equal(post.body.payload.client_ip, "203.0.113.7");
  assert.equal(post.body.payload.lead_id, "lead-e");
  assert.equal(post.body.payload.gclid, "G-E");
  assert.equal(post.body.payload.enrichment.occupancy, "vacant");

  let unavailable = 0;
  const retried = await flow.createRealAdapter({
    enrichRetryMs: 0,
    signer: { client_ip: "203.0.113.7" },
    transport(url) {
      if (mint(url)) return { status: 200, body: { ok: true, intake_id: "i", session_binding: "s", kid: "k" } };
      unavailable += 1;
      if (unavailable === 1) return { status: 503, body: { ok: false, status: "enrich_unavailable" } };
      return { status: 200, body: { ok: true, status: "saved", priority_tier: "p2" } };
    }
  }).enrich({ enrichment: { timeline: "30_90d" } });
  assert.equal(unavailable, 2);
  assert.equal(retried.priority_tier, "p2");

  let gaveUp = 0;
  const failed = await flow.createRealAdapter({
    enrichRetryMs: 0,
    signer: { client_ip: "203.0.113.7" },
    transport(url) {
      if (mint(url)) return { status: 200, body: { ok: true, intake_id: "i", session_binding: "s", kid: "k" } };
      gaveUp += 1;
      return { status: 503, body: { ok: false, status: "enrich_unavailable" } };
    }
  }).enrich({ enrichment: {} });
  assert.equal(gaveUp, 2);
  assert.equal(failed.http, 503);
  const quiet = flow.createFlow(flow.createRealAdapter({
    enrichRetryMs: 0,
    signer: { client_ip: "203.0.113.7" },
    transport(url) {
      if (mint(url)) return { status: 200, body: { ok: true, intake_id: "i", session_binding: "s", kid: "k" } };
      if (url.endsWith("/claim")) return { status: 200, body: { ok: true, claimed: true, tier: "hot", priority_tier: null, status: "claimed" } };
      if (url.endsWith("/reserve")) return { status: 200, body: { ok: true, status: "dispatch_intended_committed" } };
      if (url.endsWith("/enrich")) return { status: 409, body: { ok: false, status: "not_hot" } };
      return { status: 200, body: { ok: true, status: "saved" } };
    }
  }), { loaded: false, load() { this.loaded = true; } });
  await quiet.submitContact(contact);
  await quiet.answer("type", "sfh");
  await quiet.answer("ownership", "sole_owner");
  await quiet.skip();
  await quiet.skip();
  await quiet.skip();
  const done = await quiet.skip();
  assert.equal(done.view.stage, "thanks");
  assert.equal(done.view.serverTier, "");
  assert.equal(done.view.tierPending, false);
  assert.equal(quiet.state.trace.some((row) => row.text.indexOf("No tier.") >= 0), true);
});

test("the public homepage flag is separate from test=1", () => {
  const src = fs.readFileSync(path.join(__dirname, "two-stage.js"), "utf8");
  assert.equal(src.includes('data-public'), true);
  assert.equal(src.includes("fetch("), false);
  assert.equal(flow.testModeAllowed("production", ""), false);
  assert.equal(flow.testModeAllowed("production", "?test=1"), false);
  assert.equal(flow.CONFIG.use_real_adapter, false);
  assert.equal(flow.CONFIG.producer_path, "/.netlify/functions/intake-producer");
  assert.equal(flow.CONFIG.gtm_id, "GTM-WWPBQGDZ");
  assert.equal(flow.TRACKING.gtm_id, "GTM-WWPBQGDZ");
});

test("production does not open the test form, and the real adapter flag still posts", async () => {
  assert.equal(flow.testModeAllowed("production", "?test=1"), false);
  assert.equal(flow.testModeAllowed("production", ""), false);
  const previousFlag = globalThis.FSHO_USE_REAL_ADAPTER;
  const previousFetch = global.fetch;
  const calls = [];
  global.fetch = (url, init) => {
    calls.push({ url, body: JSON.parse(init.body), credentials: init.credentials });
    return { status: 200, body: { ok: true, status: "parked" } };
  };
  globalThis.FSHO_USE_REAL_ADAPTER = "1";
  try {
    const adapter = flow.chooseAdapter();
    await adapter.park({ full_name: "Ada Lovelace", address_line: "1 Main St", phone: "5550100199", email: "ada@example.com" });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, "/.netlify/functions/intake-producer");
    assert.equal(calls[0].body.op, "park");
    assert.equal(calls[0].credentials, "same-origin");
    assert.equal(calls[0].body.client_ip, undefined);
    assert.equal(calls[0].body.is_test, false);
    assert.equal(calls[0].body.consent, false);
  } finally {
    if (previousFlag === undefined) delete globalThis.FSHO_USE_REAL_ADAPTER;
    else globalThis.FSHO_USE_REAL_ADAPTER = previousFlag;
    global.fetch = previousFetch;
  }
  globalThis.FSHO_USE_REAL_ADAPTER = "";
  const mock = flow.chooseAdapter();
  assert.equal(Array.isArray(mock.log), true);
  delete globalThis.FSHO_USE_REAL_ADAPTER;
});

test("public park sends is_test false and the test page sends true", async () => {
  async function park(isTest) {
    const calls = [];
    const adapter = flow.createRealAdapter({
      mode: "producer",
      isTest: isTest,
      baseUrl: "/.netlify/functions/intake-producer",
      transport(url, init) {
        calls.push(JSON.parse(init.body));
        return { status: 200, body: { ok: true, status: "parked" } };
      }
    });
    await adapter.park({ full_name: "Ada Lovelace", address_line: "1 Main St", phone: "5550100199", email: "ada@example.com" });
    return calls[0];
  }
  const pub = await park(false);
  assert.equal(pub.is_test, false);
  assert.equal(pub.consent, false);
  assert.equal(pub.op, "park");
  const testPage = await park(true);
  assert.equal(testPage.is_test, true);
  assert.equal(testPage.consent, false);
  const seen = [];
  const direct = flow.createRealAdapter({
    signer: { client_ip: "203.0.113.7" },
    transport(url, init) {
      seen.push(JSON.parse(init.body));
      if (url.endsWith("/mint")) return { status: 200, body: { ok: true, intake_id: "i", session_binding: "s", kid: "k" } };
      return { status: 200, body: { ok: true, status: "parked" } };
    }
  });
  await direct.park({ name: "Ada Lovelace", address: "1 Main St", phone: "5550100199", email: "ada@example.com" });
  assert.equal(seen.find((row) => row.payload).payload.is_test, false);
  assert.equal(seen.find((row) => row.payload).payload.consent, false);
});

test("unchecked consent still parks and a checked box sends true", async () => {
  const { adapter, session } = run();
  const open = session.submitContact(Object.assign({ consent: false }, contact));
  assert.equal(open.ok, true);
  assert.equal(adapter.log[0].row.consent, false);
  const calls = [];
  const producer = flow.createRealAdapter({
    mode: "producer",
    isTest: false,
    baseUrl: "/.netlify/functions/intake-producer",
    transport(url, init) {
      calls.push(JSON.parse(init.body));
      return { status: 200, body: { ok: true, status: "parked" } };
    }
  });
  await producer.park({ name: "Ada Lovelace", address: "1 Main St", phone: "5550100199", email: "ada@example.com", consent: true });
  assert.equal(calls[0].is_test, false);
  assert.equal(calls[0].consent, true);
  const missing = [];
  const plain = flow.createRealAdapter({
    mode: "producer",
    isTest: false,
    baseUrl: "/.netlify/functions/intake-producer",
    transport(url, init) {
      missing.push(JSON.parse(init.body));
      return { status: 200, body: { ok: true, status: "parked" } };
    }
  });
  await plain.park({ name: "Ada Lovelace", address: "1 Main St", phone: "5550100199", email: "ada@example.com" });
  assert.equal(missing[0].consent, false);
});

test("producer mode posts to the function and does not sign in the browser", async () => {
  const calls = [];
  const adapter = flow.createRealAdapter({
    mode: "producer",
    baseUrl: "/.netlify/functions/intake-producer",
    transport(url, init) {
      calls.push({ url, body: JSON.parse(init.body) });
      return { status: 200, body: { ok: true, status: "parked" } };
    }
  });
  await adapter.park({ full_name: "Ada Lovelace", address_line: "1 Main St", phone: "5550100199", email: "ada@example.com", client_ip: "198.51.100.9", gclid: "click-1", attribution: { landing: "/" } });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "/.netlify/functions/intake-producer");
  assert.equal(calls[0].body.op, "park");
  assert.equal(calls[0].body.client_ip, undefined);
  assert.equal(calls[0].body.sig, undefined);
  assert.equal(calls[0].body.envelope, undefined);
  assert.equal(calls[0].body.gclid, "click-1");
  assert.equal(calls[0].body.full_name, "Ada Lovelace");
  assert.equal(calls[0].body.attribution, undefined);
});

test("park non-2xx stays on contact and asks to try again", () => {
  for (const http of [401, 429, 503]) {
    const { session } = run();
    session.adapter.park = () => ({ ok: false, http: http, status: "auth_failed" });
    const res = session.submitContact(contact);
    assert.equal(res.ok, false);
    assert.equal(res.error, "try_again");
    assert.equal(session.state.stage, "contact");
    assert.equal(session.state.parked, false);
    assert.equal(res.view.stage, "contact");
  }
  const { session } = run();
  session.adapter.park = () => ({ ok: false, http: 400, status: "bad_input", fields: ["email"] });
  const bad = session.submitContact(contact);
  assert.equal(bad.ok, false);
  assert.equal(bad.error, "bad_input");
  assert.equal(session.state.stage, "contact");
  session.adapter.park = () => ({ ok: true, http: 200, status: "parked" });
  const parked = session.submitContact(contact);
  assert.equal(parked.ok, true);
  assert.equal(session.state.stage, "q_type");
  assert.equal(fs.readFileSync(path.join(__dirname, "two-stage.js"), "utf8").includes("You can try again."), true);
});

test("late_hot is a normal hot claim", () => {
  const { tag, adapter, session } = run();
  adapter.claim = () => ({ ok: true, claimed: true, tier: "hot", status: "late_hot", priority_tier: null });
  session.submitContact(contact);
  session.answer("type", "sfh");
  const hot = session.answer("ownership", "sole_owner");
  assert.equal(hot.view.branch, "hot");
  assert.equal(hot.view.googleTagFired, true);
  assert.equal(tag.loaded, true);
  assert.equal(hot.view.downstream, "zap_hot");
});

function blankDone(session, res) {
  return !!(res && res.ok === true && res.view && res.view.stage === "done" && !session.state.sorry && !session.state.followup && !session.state.thanks);
}

test("a declining claim stays on ownership and already_claimed shows thanks", async () => {
  const declines = [
    { ok: false, http: 503, status: "not_configured" },
    { ok: false, http: 401, status: "auth_failed" },
    { ok: false, http: 404, status: "not_found" },
    { ok: false, http: 400, status: "bad_input", fields: ["by"] },
    { ok: false, http: 409, status: "not_qualified" },
    { ok: false, http: 409, status: "not_non_owner" },
    { ok: true, http: 200 },
    { ok: true, status: "claimed" }
  ];
  for (const claim of declines) {
    const { session } = run();
    session.adapter.claim = () => claim;
    session.adapter.reserve = () => { throw new Error("reserve"); };
    session.submitContact(contact);
    session.answer("type", "sfh");
    const res = session.answer("ownership", "sole_owner");
    assert.equal(res.ok, false, JSON.stringify(claim));
    assert.equal(res.error, "try_again");
    assert.equal(session.state.stage, "q_ownership");
    assert.equal(res.view.stage, "q_ownership");
    assert.equal(blankDone(session, res), false);
    const again = session.answer("ownership", "sole_owner");
    assert.equal(again.ok, false);
    assert.equal(session.state.stage, "q_ownership");
  }
  const thrown = run();
  thrown.session.adapter.claim = () => { throw new Error("network"); };
  thrown.session.submitContact(contact);
  thrown.session.answer("type", "sfh");
  const blew = thrown.session.answer("ownership", "sole_owner");
  assert.equal(blew.ok, false);
  assert.equal(blew.error, "try_again");
  assert.equal(thrown.session.state.stage, "q_ownership");
  assert.equal(blankDone(thrown.session, blew), false);

  const rejected = run();
  rejected.session.adapter.claim = () => Promise.reject(new Error("network"));
  rejected.session.submitContact(contact);
  rejected.session.answer("type", "sfh");
  const offline = await rejected.session.answer("ownership", "sole_owner");
  assert.equal(offline.ok, false);
  assert.equal(offline.error, "try_again");
  assert.equal(rejected.session.state.stage, "q_ownership");
  assert.equal(blankDone(rejected.session, offline), false);

  const recovered = run();
  let claims = 0;
  recovered.session.adapter.claim = () => {
    claims += 1;
    if (claims === 1) return { ok: false, http: 503, status: "not_configured" };
    return { ok: true, claimed: true, tier: "hot", status: "claimed", priority_tier: null };
  };
  recovered.session.submitContact(contact);
  recovered.session.answer("type", "sfh");
  assert.equal(recovered.session.answer("ownership", "sole_owner").error, "try_again");
  const hot = recovered.session.answer("ownership", "sole_owner");
  assert.equal(hot.ok, true);
  assert.equal(hot.view.branch, "hot");
  assert.equal(recovered.session.state.stage, "enrich");
  assert.equal(recovered.session.state.enrichIndex, 0);
  assert.equal(blankDone(recovered.session, hot), false);

  const quiet = run();
  quiet.session.submitContact(contact);
  quiet.session.answer("type", "sfh");
  const follow = quiet.session.answer("ownership", "no");
  assert.equal(follow.ok, true);
  assert.equal(follow.view.branch, "quiet_non_owner");
  assert.equal(quiet.session.state.followup.headline, flow.FOLLOW_UP.headline);
  assert.equal(quiet.session.state.followup.body, flow.FOLLOW_UP.body);
  assert.equal(blankDone(quiet.session, follow), false);

  const stopped = run();
  stopped.session.adapter.claim = () => Promise.resolve({ ok: true, claimed: false, status: "already_claimed", reserved: true });
  stopped.session.adapter.reserve = () => { throw new Error("reserve"); };
  stopped.session.submitContact(contact);
  stopped.session.answer("type", "sfh");
  const held = await stopped.session.answer("ownership", "sole_owner");
  assert.equal(held.ok, true);
  assert.equal(held.view.branch, "stopped");
  assert.notEqual(held.view.stage, "done");
  assert.equal(stopped.session.state.thanks.headline, flow.THANKS.headline);
  assert.equal(stopped.session.state.thanks.body, flow.THANKS.body);
  assert.equal(stopped.session.state.googleTagFired, false);
  assert.equal(blankDone(stopped.session, held), false);
});

test("a hot claim waits for reserve before enrich, and already_claimed does not look delivered early", async () => {
  const { tag, adapter, session } = run();
  session.submitContact(contact);
  session.answer("type", "sfh");
  const hot = session.answer("ownership", "sole_owner");
  assert.equal(hot.ok, true);
  assert.equal(hot.view.stage, "enrich");
  assert.equal(hot.view.branch, "hot");
  assert.equal(adapter.log.filter((row) => row.op === "reserve").length, 1);
  assert.equal(adapter.log.find((row) => row.op === "reserve").res.status, "dispatch_intended_committed");
  assert.equal(tag.loaded, true);

  const replay = run();
  replay.session.adapter.reserve = () => ({ ok: true, status: "idempotent_replay" });
  replay.session.submitContact(contact);
  replay.session.answer("type", "multi_2_4");
  const again = replay.session.answer("ownership", "all_agree");
  assert.equal(again.ok, true);
  assert.equal(again.view.stage, "enrich");
  assert.equal(replay.tag.loaded, true);

  const failures = [
    () => ({ ok: false, status: "needs_reconcile" }),
    () => ({ ok: false, status: "reservation_held" }),
    () => ({ ok: true, status: "saved" }),
    () => ({ ok: true, http: 500, status: "dispatch_intended_committed" }),
    () => { throw new Error("reserve"); }
  ];
  for (const reserve of failures) {
    const failed = run();
    failed.session.adapter.reserve = reserve;
    failed.session.submitContact(contact);
    failed.session.answer("type", "sfh");
    const res = failed.session.answer("ownership", "sole_owner");
    assert.equal(res.ok, false, String(reserve));
    assert.equal(res.error, "try_again");
    assert.equal(failed.session.state.stage, "q_ownership");
    assert.equal(res.view.stage, "q_ownership");
    assert.equal(failed.session.state.thanks, null);
    assert.equal(failed.session.state.branch, null);
    assert.equal(failed.tag.loaded, false);
    assert.equal(failed.session.state.conversionFired, false);
    assert.equal(blankDone(failed.session, res), false);
  }

  const rejected = run();
  rejected.session.adapter.reserve = () => Promise.reject(new Error("reserve"));
  rejected.session.submitContact(contact);
  rejected.session.answer("type", "sfh");
  const offline = await rejected.session.answer("ownership", "sole_owner");
  assert.equal(offline.ok, false);
  assert.equal(offline.error, "try_again");
  assert.equal(rejected.session.state.stage, "q_ownership");
  assert.equal(rejected.session.state.thanks, null);
  assert.equal(rejected.tag.loaded, false);

  const missing = run();
  missing.session.adapter.reserve = undefined;
  missing.session.submitContact(contact);
  missing.session.answer("type", "sfh");
  const skipped = missing.session.answer("ownership", "decision_maker");
  assert.equal(skipped.ok, false);
  assert.equal(skipped.error, "try_again");
  assert.equal(missing.session.state.stage, "q_ownership");
  assert.equal(missing.tag.loaded, false);

  const recovered = run();
  let reserves = 0;
  recovered.session.adapter.reserve = () => {
    reserves += 1;
    if (reserves === 1) return { ok: false, status: "needs_reconcile" };
    return { ok: true, status: "reserved" };
  };
  recovered.session.submitContact(contact);
  recovered.session.answer("type", "sfh");
  assert.equal(recovered.session.answer("ownership", "sole_owner").ok, false);
  const next = recovered.session.answer("ownership", "sole_owner");
  assert.equal(next.ok, true);
  assert.equal(next.view.stage, "enrich");
  assert.equal(reserves, 2);
  assert.equal(recovered.tag.loaded, true);

  const held = run();
  let heldReserves = 0;
  held.session.adapter.claim = () => ({ ok: true, claimed: false, status: "already_claimed" });
  held.session.adapter.reserve = () => {
    heldReserves += 1;
    return { ok: false, status: "needs_reconcile" };
  };
  held.session.submitContact(contact);
  held.session.answer("type", "sfh");
  const undelivered = held.session.answer("ownership", "sole_owner");
  assert.equal(undelivered.ok, false);
  assert.equal(undelivered.error, "try_again");
  assert.equal(held.session.state.stage, "q_ownership");
  assert.equal(held.session.state.thanks, null);
  assert.equal(heldReserves, 1);
  assert.notEqual(held.session.state.stage, "thanks");
  held.session.adapter.reserve = () => {
    heldReserves += 1;
    return { ok: true, status: "reserved" };
  };
  const delivered = held.session.answer("ownership", "sole_owner");
  assert.equal(delivered.ok, true);
  assert.equal(delivered.view.stage, "thanks");
  assert.equal(held.session.state.thanks.headline, flow.THANKS.headline);
  assert.equal(heldReserves, 2);
  assert.equal(held.tag.loaded, false);

  const prior = run();
  let priorReserves = 0;
  prior.session.adapter.claim = () => ({ ok: true, claimed: false, status: "already_claimed", reserved: true });
  prior.session.adapter.reserve = () => { priorReserves += 1; throw new Error("reserve"); };
  prior.session.submitContact(contact);
  prior.session.answer("type", "multi_2_4");
  const done = prior.session.answer("ownership", "all_agree");
  assert.equal(done.ok, true);
  assert.equal(done.view.stage, "thanks");
  assert.equal(done.view.branch, "stopped");
  assert.equal(prior.session.state.thanks.body, flow.THANKS.body);
  assert.equal(priorReserves, 0);
  assert.equal(prior.session.state.trace.some((row) => row.text.includes("No reserve")), true);
});

function memoryStore() {
  const data = Object.create(null);
  return {
    getItem(key) { return Object.prototype.hasOwnProperty.call(data, key) ? data[key] : null; },
    setItem(key, value) { data[key] = String(value); },
    removeItem(key) { delete data[key]; }
  };
}

function makeNode(tag) {
  return {
    tagName: tag,
    id: "",
    hidden: false,
    className: "",
    type: "",
    textContent: "",
    value: "",
    disabled: false,
    dataset: {},
    attributes: {},
    childNodes: [],
    parentNode: null,
    onclick: null,
    onsubmit: null,
    getAttribute(name) { return Object.prototype.hasOwnProperty.call(this.attributes, name) ? this.attributes[name] : null; },
    setAttribute(name, value) { this.attributes[name] = String(value); },
    appendChild(child) { this.childNodes.push(child); child.parentNode = this; return child; },
    replaceChildren() { this.childNodes.length = 0; },
    querySelector(sel) { return queryAll(this, sel)[0] || null; },
    querySelectorAll(sel) { return queryAll(this, sel); }
  };
}

function queryAll(node, sel) {
  const out = [];
  (node.childNodes || []).forEach((child) => {
    if (sel === "button,input" && (child.tagName === "button" || child.tagName === "input")) out.push(child);
    const named = /^input\[name="([^"]+)"\]$/.exec(sel);
    if (named && child.tagName === "input" && child.getAttribute("name") === named[1]) out.push(child);
    out.push(...queryAll(child, sel));
  });
  return out;
}

function nodeText(node) {
  let out = node && node.textContent ? node.textContent : "";
  (node && node.childNodes || []).forEach((child) => { out += " " + nodeText(child); });
  return out;
}

function cardText(ui) {
  return [
    ui.form.hidden ? "" : nodeText(ui.form),
    nodeText(ui.sorry),
    nodeText(ui.follow),
    nodeText(ui.thanks),
    nodeText(ui.ask),
    ui.error.hidden ? "" : nodeText(ui.error)
  ].join(" ").replace(/\s+/g, " ").trim();
}

function publicDocument() {
  const byId = {};
  function mount(id, tag, parent) {
    const node = makeNode(tag);
    node.id = id;
    node.setAttribute("id", id);
    byId[id] = node;
    if (parent) parent.appendChild(node);
    return node;
  }
  const app = mount("ts-app", "div");
  app.setAttribute("data-public", "1");
  const form = mount("ts-form", "form", app);
  const values = { name: contact.name, address: contact.address, phone: contact.phone, email: contact.email };
  Object.keys(values).forEach((name) => {
    const input = makeNode("input");
    input.setAttribute("name", name);
    input.value = values[name];
    form.appendChild(input);
  });
  const submit = makeNode("button");
  submit.type = "submit";
  form.appendChild(submit);
  const doc = {
    body: makeNode("body"),
    head: makeNode("head"),
    createElement: makeNode,
    getElementById(id) { return byId[id] || null; }
  };
  return {
    doc,
    app,
    form,
    ask: mount("ts-ask", "div", app),
    sorry: mount("ts-sorry", "div", app),
    follow: mount("ts-followup", "div", app),
    thanks: mount("ts-thanks", "div", app),
    error: mount("ts-error", "p", app),
    summary: mount("ts-summary", "p", app),
    events: mount("ts-events", "p", app),
    trace: mount("ts-trace", "ol", app)
  };
}

function findButton(node, value) {
  return queryAll(node, "button,input").find((button) => button.tagName === "button" && button.dataset.v === value);
}

async function settleUi() {
  for (let i = 0; i < 40; i++) await new Promise((resolve) => setImmediate(resolve));
}

function jsonResponse(status, body) {
  return {
    status,
    headers: { get() { return ""; } },
    json() { return Promise.resolve(body); }
  };
}

function producerFetch(claim, reserve) {
  return (url, init) => {
    const body = JSON.parse(init.body);
    if (body.op === "claim") return Promise.resolve(jsonResponse(claim.status, claim.body));
    if (body.op === "reserve") {
      if (reserve && reserve.throw) return Promise.reject(new Error("reserve"));
      const res = reserve || { status: 200, body: { ok: true, status: "reserved" } };
      return Promise.resolve(jsonResponse(res.status, res.body));
    }
    const status = body.op === "park" ? "parked" : "saved";
    return Promise.resolve(jsonResponse(200, { ok: true, status }));
  };
}

async function withPublicForm(fetchImpl, fn) {
  const prev = {
    document: global.document,
    location: global.location,
    localStorage: global.localStorage,
    sessionStorage: global.sessionStorage,
    addEventListener: global.addEventListener,
    fetch: global.fetch,
    FormData: global.FormData,
    flag: global.FSHO_USE_REAL_ADAPTER
  };
  const ui = publicDocument();
  global.document = ui.doc;
  global.location = { search: "" };
  global.localStorage = memoryStore();
  global.sessionStorage = memoryStore();
  global.addEventListener = () => {};
  global.FormData = class {
    constructor(form) { this.form = form; }
    get(name) {
      const input = queryAll(this.form, "button,input").find((node) => node.tagName === "input" && node.getAttribute("name") === name);
      return input ? input.value : null;
    }
  };
  global.FSHO_USE_REAL_ADAPTER = fetchImpl ? "1" : "";
  if (fetchImpl) global.fetch = fetchImpl;
  const resolved = require.resolve("./two-stage.js");
  delete require.cache[resolved];
  require("./two-stage.js");
  try {
    await fn(ui);
  } finally {
    delete require.cache[resolved];
    global.document = prev.document;
    global.location = prev.location;
    global.localStorage = prev.localStorage;
    global.sessionStorage = prev.sessionStorage;
    global.addEventListener = prev.addEventListener;
    global.fetch = prev.fetch;
    global.FormData = prev.FormData;
    global.FSHO_USE_REAL_ADAPTER = prev.flag;
  }
}

async function clickThrough(ui, property, ownership) {
  ui.form.onsubmit({ preventDefault() {} });
  await settleUi();
  const propertyButton = findButton(ui.ask, property);
  assert.ok(propertyButton, JSON.stringify({ card: cardText(ui), ask: nodeText(ui.ask), err: ui.error.textContent, errHidden: ui.error.hidden, formHidden: ui.form.hidden, summary: nodeText(ui.summary) }));
  propertyButton.onclick();
  await settleUi();
  assert.notEqual(cardText(ui), "");
  findButton(ui.ask, ownership).onclick();
  await settleUi();
  assert.notEqual(cardText(ui), "");
}

test("paint keeps a screen for hot, follow-up, declined, and thrown renders", async () => {
  await withPublicForm(producerFetch({ status: 200, body: { ok: true, claimed: true, tier: "hot", status: "claimed", priority_tier: null } }), async (ui) => {
    await clickThrough(ui, "sfh", "sole_owner");
    assert.equal(ui.form.hidden, true);
    assert.match(nodeText(ui.ask), /Optional 1 of 4/);
    assert.match(nodeText(ui.ask), /Who is living there\?/);
  });

  await withPublicForm(producerFetch({ status: 200, body: { ok: true, claimed: true, tier: "follow_up", status: "claimed" } }), async (ui) => {
    await clickThrough(ui, "sfh", "no");
    assert.match(nodeText(ui.follow), /Thanks\. We'll follow up\./);
    assert.match(nodeText(ui.follow), /We saved your info and will be in touch\./);
    assert.equal(ui.error.hidden, true);
  });

  await withPublicForm(producerFetch({ status: 503, body: { ok: false, status: "not_configured" } }), async (ui) => {
    await clickThrough(ui, "sfh", "sole_owner");
    assert.equal(ui.form.hidden, true);
    assert.match(nodeText(ui.ask), /Are you the owner, or can you make the decision to sell\?/);
    assert.equal(ui.error.hidden, false);
    assert.equal(ui.error.textContent, "That step did not save. You can try again.");
    assert.equal(nodeText(ui.thanks).trim(), "");
  });

  await withPublicForm(producerFetch(
    { status: 200, body: { ok: true, claimed: true, tier: "hot", status: "claimed", priority_tier: null } },
    { status: 200, body: { ok: false, status: "needs_reconcile" } }
  ), async (ui) => {
    await clickThrough(ui, "sfh", "sole_owner");
    assert.equal(ui.form.hidden, true);
    assert.match(nodeText(ui.ask), /Are you the owner, or can you make the decision to sell\?/);
    assert.equal(ui.error.hidden, false);
    assert.equal(ui.error.textContent, "That step did not save. You can try again.");
    assert.equal(nodeText(ui.thanks).trim(), "");
    assert.doesNotMatch(cardText(ui), /Optional 1 of 4/);
    assert.doesNotMatch(cardText(ui), /Thanks\. We have your info/);
  });

  await withPublicForm(producerFetch(
    { status: 200, body: { ok: true, claimed: true, tier: "hot", status: "claimed" } },
    { throw: true }
  ), async (ui) => {
    await clickThrough(ui, "sfh", "decision_maker");
    assert.match(nodeText(ui.ask), /Are you the owner, or can you make the decision to sell\?/);
    assert.equal(ui.error.textContent, "That step did not save. You can try again.");
    assert.equal(nodeText(ui.thanks).trim(), "");
    assert.doesNotMatch(cardText(ui), /Optional 1 of 4/);
  });

  await withPublicForm(producerFetch({ status: 200, body: { ok: true, status: "claimed" } }), async (ui) => {
    await clickThrough(ui, "sfh", "sole_owner");
    assert.match(nodeText(ui.ask), /Are you the owner, or can you make the decision to sell\?/);
    assert.equal(ui.error.textContent, "That step did not save. You can try again.");
    assert.equal(nodeText(ui.thanks).trim(), "");
    assert.doesNotMatch(cardText(ui), /Optional 1 of 4/);
  });

  let reservedClaims = 0;
  await withPublicForm((url, init) => {
    const body = JSON.parse(init.body);
    if (body.op === "reserve") reservedClaims += 1;
    if (body.op === "claim") return Promise.resolve(jsonResponse(200, { ok: true, claimed: false, status: "already_claimed" }));
    if (body.op === "reserve") return Promise.resolve(jsonResponse(200, { ok: true, status: "reserved" }));
    return Promise.resolve(jsonResponse(200, { ok: true, status: body.op === "park" ? "parked" : "saved" }));
  }, async (ui) => {
    await clickThrough(ui, "multi_2_4", "all_agree");
    assert.equal(reservedClaims, 1);
    assert.match(nodeText(ui.thanks), /Thanks\. We have your info\./);
    assert.match(nodeText(ui.thanks), /Your answers are saved with this lead\./);
    assert.equal(ui.error.hidden, true);
    assert.doesNotMatch(cardText(ui), /Optional 1 of 4/);
  });

  await withPublicForm(producerFetch(
    { status: 200, body: { ok: true, claimed: false, status: "already_claimed" } },
    { status: 200, body: { ok: false, status: "needs_reconcile" } }
  ), async (ui) => {
    await clickThrough(ui, "sfh", "sole_owner");
    assert.match(nodeText(ui.ask), /Are you the owner, or can you make the decision to sell\?/);
    assert.equal(ui.error.hidden, false);
    assert.equal(ui.error.textContent, "That step did not save. You can try again.");
    assert.equal(nodeText(ui.thanks).trim(), "");
    assert.doesNotMatch(cardText(ui), /Thanks\. We have your info/);
  });

  let repeatReserves = 0;
  await withPublicForm((url, init) => {
    const body = JSON.parse(init.body);
    if (body.op === "reserve") {
      repeatReserves += 1;
      return Promise.reject(new Error("reserve"));
    }
    if (body.op === "claim") return Promise.resolve(jsonResponse(200, { ok: true, claimed: false, status: "already_claimed", reserved: true }));
    return Promise.resolve(jsonResponse(200, { ok: true, status: body.op === "park" ? "parked" : "saved" }));
  }, async (ui) => {
    await clickThrough(ui, "sfh", "all_agree");
    assert.equal(repeatReserves, 0);
    assert.match(nodeText(ui.thanks), /Thanks\. We have your info\./);
    assert.equal(ui.error.hidden, true);
  });

  await withPublicForm(null, async (ui) => {
    ui.form.onsubmit({ preventDefault() {} });
    await settleUi();
    assert.match(nodeText(ui.ask), /What kind of property is it\?/);
    const orig = ui.ask.replaceChildren.bind(ui.ask);
    let boom = true;
    ui.ask.replaceChildren = function () {
      orig();
      if (boom) {
        boom = false;
        throw new Error("paint failed");
      }
    };
    findButton(ui.ask, "sfh").onclick();
    await settleUi();
    assert.equal(ui.form.hidden, true);
    assert.match(nodeText(ui.ask), /That step did not save\. You can try again\./);
    assert.equal(ui.error.hidden, false);
    assert.equal(ui.error.textContent, "That step did not save. You can try again.");
    assert.notEqual(cardText(ui), "");
  });
});
