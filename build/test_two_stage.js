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
  for (const property of ["condo", "mobile", "land"]) {
    const { tag, session } = run();
    session.submitContact(contact);
    const done = session.answer("type", property);
    assert.equal(done.view.branch, "quiet_property");
    assert.equal(done.view.downstream, "pg_cron_sweep");
    assert.equal(done.view.googleTagFired, false);
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

test("a townhouse owner is hot until townhouse_route is flipped to quiet", () => {
  assert.equal(flow.CONFIG.townhouse_route, "hot");
  assert.deepEqual(flow.QUESTIONS.type[1].map(function (opt) { return opt[0]; }), ["sfh", "townhouse", "multi_2_4", "condo", "mobile", "land"]);
  assert.deepEqual(flow.QUESTIONS.ownership[1].map(function (opt) { return opt[0]; }), ["sole_owner", "all_agree", "decision_maker", "no"]);
  const hot = run();
  hot.session.submitContact(contact);
  hot.session.answer("type", "townhouse");
  assert.equal(hot.tag.loaded, false);
  const done = hot.session.answer("ownership", "sole_owner");
  assert.equal(done.view.branch, "hot");
  assert.equal(done.view.googleTagFired, true);
  assert.equal(done.view.downstream, "zap_hot");
  assert.equal(hot.tag.loaded, true);
  const quiet = run();
  quiet.session = flow.createFlow(quiet.adapter, quiet.tag, { townhouse_route: "quiet" });
  quiet.session.submitContact(contact);
  const parked = quiet.session.answer("type", "townhouse");
  assert.equal(parked.view.branch, "quiet_property");
  assert.equal(parked.view.downstream, "pg_cron_sweep");
  assert.equal(quiet.tag.loaded, false);
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
