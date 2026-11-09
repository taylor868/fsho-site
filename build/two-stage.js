/* Test-mode two-stage seller flow. No network. The default adapter only records. */
(function (root, factory) {
  var api = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (root) root.FSHOTwoStage = api;
  if (typeof document !== "undefined") boot(api);
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  var CONTINUE = { sfh: 1, multi_2_4: 1 };
  var OWNERS = { sole_owner: 1, all_agree: 1, decision_maker: 1 };
  var ENRICH = { timeline: 1, situation: 1, equity: 1, ability: 1 };
  var CONFIG = { townhouse_route: "quiet" };
  var NOT_FIT = {
    headline: "Thanks for the details.",
    body: "This one may not be a fit for us right now, but we saved your info and will reach out if anything changes."
  };
  var QUESTIONS = {
    type: ["What kind of property is it?", [["sfh", "Single-family house"], ["townhouse", "Townhouse"], ["multi_2_4", "Multi-family (2-4 units)"], ["condo", "Condo"], ["mobile", "Mobile or manufactured home"], ["land", "Vacant land"]]],
    ownership: ["Are you the owner, or can you make the decision to sell?", [["sole_owner", "Yes, I'm the only owner"], ["all_agree", "Yes, and all owners agree"], ["decision_maker", "I'm an heir, executor, or POA"], ["no", "No, or not everyone agrees"]]],
    timeline: ["When do you need to sell?", [["asap", "As soon as possible"], ["30d", "Within 30 days"], ["over_90d", "More than 90 days"], ["no_rush", "No rush"]]],
    situation: ["What's the main reason you're selling?", [["behind", "Behind on payments"], ["repairs", "Needs repairs"], ["curious", "Just curious"]]],
    equity: ["Roughly how much is still owed?", [["free_clear", "Paid off"], ["under_half", "Less than half"], ["underwater", "About what it's worth, or more"]]],
    ability: ["Anything that could hold up a sale?", [["ready", "Nothing, ready to go"], ["need_time", "Need a little extra time"], ["cant_move", "Can't move out by closing"]]]
  };
  var PATHS = {
    zap_hot: "Zap Hot path: WhatConverts + CRM + Slack",
    pg_cron_sweep: "pg_cron self-serve sweep after timeout",
    crm_follow_up: "CRM follow-up, logged, no conversion",
    staying_parked: "Stays parked"
  };

  function testModeAllowed(context, search) {
    if (context !== "deploy-preview" && context !== "branch-deploy" && context !== "dev" && context !== "local") return false;
    return /(?:^|[?&])test=1(?:&|$)/.test(String(search || ""));
  }

  function createMockAdapter() {
    var log = [];
    return {
      log: log,
      park: function (row) { log.push({ op: "park", crm: false, google: false, row: row }); },
      branch: function (name) { log.push({ op: "branch", name: name }); },
      google: function (fired) { log.push({ op: "google", fired: fired === true }); },
      downstream: function (path) { log.push({ op: "downstream", path: path }); }
    };
  }

  function note(state, id, text) {
    state.trace.push({ id: id, text: text });
  }

  function snapshot(state) {
    return {
      parked: state.parked,
      branch: state.branch,
      googleTagFired: state.googleTagFired,
      downstream: state.downstream,
      stage: state.stage,
      answers: Object.assign({}, state.answers)
    };
  }

  function createFlow(adapter, tag, config) {
    var gate = tag || { loaded: false, load: function () { this.loaded = true; } };
    var townhouseRoute = (config && config.townhouse_route) || CONFIG.townhouse_route;
    var state = { stage: "contact", parked: false, branch: null, googleTagFired: false, downstream: null, answers: {}, trace: [], contact: null };
    function goesQuiet(value) {
      if (value === "townhouse") return townhouseRoute !== "hot";
      if (CONTINUE[value]) return false;
      var known = false;
      QUESTIONS.type[1].forEach(function (opt) { if (opt[0] === value) known = true; });
      return known ? true : null;
    }
    function finish(branch, path, googleText) {
      state.branch = branch;
      state.downstream = path;
      state.stage = branch === "hot" ? "enrich" : "done";
      state.sorry = branch === "quiet_property" ? NOT_FIT : null;
      adapter.branch(branch);
      adapter.google(state.googleTagFired);
      adapter.downstream(path);
      note(state, "branch", branch === "hot" ? "Hot. This is the form fill." : (branch === "quiet_property" ? "Quiet property branch. Stays parked." : "Quiet non-owner branch. Logged, no conversion."));
      note(state, "google", googleText);
      note(state, "downstream", "Expected path: " + PATHS[path]);
    }
    return {
      state: state,
      adapter: adapter,
      submitContact: function (contact) {
        if (state.stage !== "contact") return { ok: false, error: "already_parked" };
        var name = contact && String(contact.name || "").trim();
        var address = contact && String(contact.address || "").trim();
        var phone = contact && String(contact.phone || "").trim();
        var email = contact && String(contact.email || "").trim();
        if (!name || !address || !phone || !email) return { ok: false, error: "contact_required" };
        state.contact = { name: name, address: address, phone: phone, email: email };
        state.parked = true;
        state.stage = "q_type";
        state.downstream = "staying_parked";
        adapter.park({ name: name, address: address, phone: phone, email: email, status: "parked" });
        note(state, "park", "Parked in the staged table. No CRM lead. No Google tag.");
        note(state, "downstream", "Expected path: " + PATHS.staying_parked + " until the next answer, or if they leave.");
        return { ok: true, view: snapshot(state) };
      },
      abandon: function () {
        if (state.stage !== "q_type") return { ok: false, error: "abandon_only_after_stage_1" };
        state.stage = "abandoned";
        state.branch = "abandoned";
        state.downstream = "staying_parked";
        adapter.branch("abandoned");
        adapter.google(false);
        adapter.downstream("staying_parked");
        note(state, "abandon", "Left after stage 1. Stays parked. No sweep, no CRM, no Google tag.");
        note(state, "google", "Google tag not loaded.");
        note(state, "downstream", "Expected path: " + PATHS.staying_parked);
        return { ok: true, view: snapshot(state) };
      },
      answer: function (id, value) {
        if (state.stage === "q_type" && id === "type") {
          var quiet = goesQuiet(value);
          if (quiet === null) return { ok: false, error: "unknown_property" };
          state.answers.type = value;
          note(state, "q1", "Q1 property type: " + value + ".");
          if (quiet) {
            finish("quiet_property", "pg_cron_sweep", "Google tag not loaded.");
            return { ok: true, view: snapshot(state) };
          }
          state.stage = "q_ownership";
          note(state, "google", "Google tag not loaded. Waiting for an owner answer.");
          return { ok: true, view: snapshot(state) };
        }
        if (state.stage === "q_ownership" && id === "ownership") {
          var owner = !!OWNERS[value];
          if (!owner && value !== "no") return { ok: false, error: "unknown_ownership" };
          state.answers.ownership = value;
          note(state, "q2", "Q2 ownership: " + value + ".");
          if (!owner) {
            finish("quiet_non_owner", "crm_follow_up", "Google tag not loaded.");
            return { ok: true, view: snapshot(state) };
          }
          state.googleTagFired = true;
          gate.load();
          finish("hot", "zap_hot", "Google tag fired after owner=yes. Dry-run did not request the tag script.");
          return { ok: true, view: snapshot(state) };
        }
        if (state.stage === "enrich" && ENRICH[id]) {
          state.answers[id] = value;
          note(state, "enrich", "Q " + id + "=" + value + " enriches the hot lead. Branch stays hot. Tag is not loaded again.");
          return { ok: true, view: snapshot(state) };
        }
        return { ok: false, error: "unexpected_answer" };
      }
    };
  }

  return {
    testModeAllowed: testModeAllowed,
    createMockAdapter: createMockAdapter,
    createFlow: createFlow,
    CONFIG: CONFIG,
    NOT_FIT: NOT_FIT,
    QUESTIONS: QUESTIONS,
    PATHS: PATHS
  };
});

function boot(api) {
  var off = document.getElementById("ts-off");
  var app = document.getElementById("ts-app");
  if (!off || !app) return;
  var on = api.testModeAllowed(globalThis.FSHO_DEPLOY_CONTEXT || "", location.search);
  if (!on) { off.hidden = false; return; }
  app.hidden = false;
  var form = document.getElementById("ts-form");
  var ask = document.getElementById("ts-ask");
  var trace = document.getElementById("ts-trace");
  var summary = document.getElementById("ts-summary");
  var tag = { loaded: false, load: function () { this.loaded = true; var n = document.createElement("script"); n.id = "fsho-google-gate"; n.type = "application/json"; n.textContent = "{\"event\":\"form_fill\",\"dry_run\":true}"; document.body.appendChild(n); } };
  var flow = api.createFlow(api.createMockAdapter(), tag);
  function paint() {
    trace.replaceChildren();
    flow.state.trace.forEach(function (row) {
      var li = document.createElement("li");
      li.dataset.id = row.id;
      li.textContent = row.text;
      trace.appendChild(li);
    });
    var path = flow.state.downstream || "none";
    summary.dataset.downstream = path;
    summary.dataset.google = flow.state.googleTagFired ? "fired" : "not-loaded";
    summary.dataset.branch = flow.state.branch || "";
    summary.textContent = "Branch: " + (flow.state.branch || "not chosen") + ". Google tag: " + (flow.state.googleTagFired ? "fired" : "not loaded") + ". Path: " + (api.PATHS[path] || "not chosen");
    var sorry = document.getElementById("ts-sorry");
    sorry.replaceChildren();
    if (flow.state.sorry) {
      var sh = document.createElement("h2");
      sh.textContent = flow.state.sorry.headline;
      var sp = document.createElement("p");
      sp.textContent = flow.state.sorry.body;
      sorry.appendChild(sh);
      sorry.appendChild(sp);
    }
    ask.replaceChildren();
    var qid = flow.state.stage === "q_type" ? "type" : (flow.state.stage === "q_ownership" ? "ownership" : "");
    if (flow.state.stage === "q_type") {
      var leave = document.createElement("button");
      leave.type = "button";
      leave.className = "bk";
      leave.id = "ts-abandon";
      leave.textContent = "Leave it parked";
      leave.onclick = function () { flow.abandon(); paint(); };
      ask.appendChild(leave);
    }
    function options(id) {
      var spec = api.QUESTIONS[id];
      var box = document.createElement("div");
      var h = document.createElement("h2");
      h.textContent = spec[0];
      box.appendChild(h);
      var row = document.createElement("div");
      row.className = "ts-choices";
      spec[1].forEach(function (opt) {
        var b = document.createElement("button");
        b.type = "button";
        b.className = "qo";
        b.dataset.q = id;
        b.dataset.v = opt[0];
        b.textContent = opt[1];
        b.onclick = function () { flow.answer(id, opt[0]); paint(); };
        row.appendChild(b);
      });
      box.appendChild(row);
      ask.appendChild(box);
    }
    if (qid) options(qid);
    if (flow.state.stage === "enrich") ["timeline", "situation", "equity", "ability"].forEach(options);
  }
  form.onsubmit = function (e) {
    e.preventDefault();
    var data = new FormData(form);
    var result = flow.submitContact({ name: data.get("name"), address: data.get("address"), phone: data.get("phone"), email: data.get("email") });
    if (!result.ok) { summary.textContent = "Name, address, phone, and email are required."; return; }
    form.hidden = true;
    paint();
  };
}
