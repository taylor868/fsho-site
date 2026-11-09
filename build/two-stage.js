/* Test-mode two-stage seller flow. No network. The default adapter only records. */
(function (root, factory) {
  var api = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (root) root.FSHOTwoStage = api;
  if (typeof document !== "undefined") boot(api);
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  var CONTINUE = { sfh: 1, multi_2_4: 1 };
  var OWNERS = { sole_owner: 1, all_agree: 1, decision_maker: 1 };
  var LEGACY = { situation: 1, equity: 1, ability: 1 };
  var ENRICH_STEPS = ["occupancy", "condition", "price_vs_value", "listed", "timeline"];
  var PAYLOAD_FIELDS = ["lead_id", "stage", "gclid", "gbraid", "wbraid", "fbclid", "utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content"];
  var PUBLIC_EVENT_KEYS = { event: 1, transaction_id: 1, reason: 1, property_type: 1 };
  var TRACKING = {
    gtm_id: "GTM-PLACEHOLDER",
    ga4: false,
    meta_pixel: false,
    lazy: true,
    storage_key: "fsho_ts_attr",
    lead_key: "fsho_ts_lead",
    click_ids: ["gclid", "gbraid", "wbraid", "fbclid"],
    utm: ["utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content"]
  };
  var CONFIG = { townhouse_route: "quiet" };
  var NOT_FIT = {
    headline: "Thanks for the details.",
    body: "This one may not be a fit for us right now, but we saved your info and will reach out if anything changes."
  };
  var FOLLOW_UP = {
    headline: "Thanks. We'll follow up.",
    body: "We saved your info and will be in touch."
  };
  var THANKS = {
    headline: "Thanks. We have your info.",
    body: "Your answers are saved with this lead. That's everything we need for now."
  };
  var QUESTIONS = {
    type: ["What kind of property is it?", [["sfh", "Single-family house"], ["townhouse", "Townhouse"], ["multi_2_4", "Multi-family (2-4 units)"], ["condo", "Condo"], ["mobile", "Mobile or manufactured home"], ["land", "Vacant land"]]],
    ownership: ["Are you the owner, or can you make the decision to sell?", [["sole_owner", "Yes, I'm the only owner"], ["all_agree", "Yes, and all owners agree"], ["decision_maker", "I'm an heir, executor, or POA"], ["no", "No, or not everyone agrees"]]],
    occupancy: ["Who is living there?", [["owner", "I live there"], ["tenant", "A tenant lives there"], ["vacant", "It's vacant"]]],
    condition: ["What condition is the property in?", [["move_in", "Move-in ready"], ["wear", "Normal wear"], ["repairs", "Needs repairs"], ["major", "Needs major work"]]],
    price_vs_value: ["How does the asking price compare with the estimated value?", [["under_80", "Under 80% of the value"], ["band_80_100", "80% to 100% of the value"], ["over_100", "Over 100% of the value"], ["not_sure", "Not sure"]]],
    listed: ["Is it listed with an agent?", [["yes", "Yes, it is listed"], ["no", "No, it is not listed"]]],
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
      downstream: function (path) { log.push({ op: "downstream", path: path }); },
      stage: function (payload) { log.push({ op: "stage", payload: payload }); }
    };
  }

  function memoryStorage() {
    var data = {};
    return {
      getItem: function (k) { return Object.prototype.hasOwnProperty.call(data, k) ? data[k] : null; },
      setItem: function (k, v) { data[k] = String(v); }
    };
  }

  function parseQuery(search) {
    var out = {};
    var raw = String(search || "").replace(/^[?#]/, "");
    if (!raw) return out;
    raw.split("&").forEach(function (pair) {
      if (!pair) return;
      var cut = pair.indexOf("=");
      var key = decodeURIComponent((cut < 0 ? pair : pair.slice(0, cut)).replace(/\+/g, " "));
      var val = decodeURIComponent((cut < 0 ? "" : pair.slice(cut + 1)).replace(/\+/g, " "));
      if (key) out[key] = val;
    });
    return out;
  }

  function readJson(storage, key) {
    try {
      var raw = storage.getItem(key);
      if (!raw) return {};
      var obj = JSON.parse(raw);
      return obj && typeof obj === "object" ? obj : {};
    } catch (e) { return {}; }
  }

  function writeJson(storage, key, obj) {
    try { storage.setItem(key, JSON.stringify(obj)); } catch (e) {}
  }

  function project(obj, keys) {
    var out = {};
    keys.forEach(function (k) { out[k] = obj && obj[k] ? String(obj[k]) : ""; });
    return out;
  }

  function trackKeys(tracking) {
    return tracking.click_ids.concat(tracking.utm);
  }

  function captureAttribution(search, storage, tracking) {
    var cfg = Object.assign({}, TRACKING, tracking || {});
    var keys = trackKeys(cfg);
    var store = storage || memoryStorage();
    var existing = readJson(store, cfg.storage_key);
    if (keys.some(function (k) { return existing[k]; })) return project(existing, keys);
    var incoming = project(parseQuery(search), keys);
    if (keys.some(function (k) { return incoming[k]; })) writeJson(store, cfg.storage_key, incoming);
    return incoming;
  }

  function mintLeadId() {
    if (!globalThis.crypto || typeof globalThis.crypto.randomUUID !== "function") throw new Error("crypto.randomUUID is required");
    return globalThis.crypto.randomUUID();
  }

  function loadLeadId(storage, tracking) {
    var key = tracking.lead_key;
    var existing = "";
    try { existing = storage.getItem(key) || ""; } catch (e) { existing = ""; }
    if (existing) return existing;
    var id = mintLeadId();
    try { storage.setItem(key, id); } catch (e) {}
    return id;
  }

  function priorityTier(answers) {
    var a = answers || {};
    if (a.occupancy === "vacant" || a.price_vs_value === "under_80") return "high";
    return "standard";
  }

  function conversionName(answers) {
    var a = answers || {};
    return CONTINUE[a.type] && OWNERS[a.ownership] ? "seller_form_completed" : "";
  }

  function exitEvent(branch, answers) {
    var a = answers || {};
    if (branch === "quiet_property") return { event: "seller_form_disqualified", reason: "quiet_property", property_type: a.type || "" };
    if (branch === "quiet_non_owner") return { event: "seller_form_disqualified", reason: "not_owner" };
    if (branch === "nurture") return { event: "seller_form_disqualified", reason: "nurture" };
    if (branch === "dq") return { event: "seller_form_disqualified", reason: "dq" };
    return null;
  }

  function knownOption(id, value) {
    var spec = QUESTIONS[id];
    if (!spec) return false;
    return spec[1].some(function (opt) { return opt[0] === value; });
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
      screen: state.stage === "enrich" ? ENRICH_STEPS[state.enrichIndex] : state.stage,
      answers: Object.assign({}, state.answers),
      leadId: state.leadId,
      priority: state.priority,
      conversionFired: state.conversionFired
    };
  }

  function pushPublic(dataLayer, event) {
    var clean = {};
    Object.keys(event).forEach(function (k) {
      if (PUBLIC_EVENT_KEYS[k] && event[k]) clean[k] = event[k];
    });
    dataLayer.push(clean);
  }

  function createFlow(adapter, tag, config) {
    var gate = tag || { loaded: false, load: function () { this.loaded = true; } };
    config = config || {};
    var tracking = Object.assign({}, TRACKING, config.tracking || {});
    var townhouseRoute = config.townhouse_route || CONFIG.townhouse_route;
    var localStore = config.localStorage || memoryStorage();
    var sessionStore = config.sessionStorage || memoryStorage();
    var dataLayer = config.dataLayer || [];
    var attr = captureAttribution(config.search || "", localStore, tracking);
    var leadId = loadLeadId(sessionStore, tracking);
    var state = {
      stage: "contact", parked: false, branch: null, googleTagFired: false, downstream: null,
      answers: {}, trace: [], contact: null, sorry: null, followup: null, thanks: null,
      leadId: leadId, attr: attr, priority: "", conversionFired: false, enrichIndex: 0, skipped: {},
      dataLayer: dataLayer
    };
    function goesQuiet(value) {
      if (value === "townhouse") return townhouseRoute !== "hot";
      if (CONTINUE[value]) return false;
      var known = false;
      QUESTIONS.type[1].forEach(function (opt) { if (opt[0] === value) known = true; });
      return known ? true : null;
    }
    function basePayload(stageName) {
      var row = { lead_id: state.leadId, stage: stageName };
      trackKeys(tracking).forEach(function (k) { row[k] = state.attr[k] || ""; });
      return row;
    }
    function emit(stageName, extra) {
      adapter.stage(Object.assign(basePayload(stageName), extra || {}));
    }
    function seenConversion() {
      return dataLayer.some(function (e) {
        return e && e.event === "seller_form_completed" && e.transaction_id === state.leadId;
      });
    }
    function fireConversion() {
      if (state.conversionFired || seenConversion()) { state.conversionFired = true; return; }
      state.conversionFired = true;
      pushPublic(dataLayer, { event: "seller_form_completed", transaction_id: state.leadId });
      note(state, "conversion", "seller_form_completed once. transaction_id is the lead id.");
    }
    function fireExit(branch) {
      var event = exitEvent(branch, state.answers);
      if (!event || state.exitFired) return;
      state.exitFired = true;
      event.transaction_id = state.leadId;
      pushPublic(dataLayer, event);
      note(state, "exit", "seller_form_disqualified (" + event.reason + "). No conversion.");
    }
    function finish(branch, path, googleText) {
      state.branch = branch;
      state.downstream = path;
      state.stage = branch === "hot" ? "enrich" : "done";
      state.enrichIndex = 0;
      state.sorry = branch === "quiet_property" ? NOT_FIT : null;
      state.followup = branch === "quiet_non_owner" ? FOLLOW_UP : null;
      state.thanks = null;
      state.priority = branch === "hot" ? priorityTier(state.answers) : "";
      if (branch === "hot" && conversionName(state.answers)) fireConversion();
      else fireExit(branch);
      adapter.branch(branch);
      adapter.google(state.googleTagFired);
      adapter.downstream(path);
      note(state, "branch", branch === "hot" ? "Hot. This is the form fill." : (branch === "quiet_property" ? "Quiet property branch. Stays parked." : "Quiet non-owner branch. Logged, no conversion."));
      note(state, "google", googleText);
      note(state, "downstream", "Expected path: " + PATHS[path]);
    }
    function advance() {
      state.enrichIndex += 1;
      if (state.enrichIndex < ENRICH_STEPS.length) return;
      state.stage = "thanks";
      state.priority = priorityTier(state.answers);
      state.thanks = THANKS;
      emit("thanks", {
        priority: state.priority,
        occupancy: state.answers.occupancy || "",
        condition: state.answers.condition || "",
        price_vs_value: state.answers.price_vs_value || "",
        listed: state.answers.listed || "",
        timeline: state.answers.timeline || ""
      });
      note(state, "thanks", "Optional questions finished. Priority " + state.priority + ". Conversion already counted.");
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
        adapter.park(Object.assign(basePayload("contact"), { name: name, address: address, phone: phone, email: email, status: "parked" }));
        note(state, "park", "Parked in the staged table. No CRM lead. No Google tag.");
        note(state, "downstream", "Expected path: " + PATHS.staying_parked + " until the next answer, or if they leave.");
        return { ok: true, view: snapshot(state) };
      },
      abandon: function () {
        if (state.stage !== "q_type") return { ok: false, error: "abandon_only_after_stage_1" };
        state.stage = "abandoned";
        state.branch = "abandoned";
        state.downstream = "staying_parked";
        emit("abandoned", {});
        adapter.branch("abandoned");
        adapter.google(false);
        adapter.downstream("staying_parked");
        note(state, "abandon", "Left after stage 1. Stays parked. No sweep, no CRM, no Google tag.");
        note(state, "google", "Google tag not loaded.");
        note(state, "downstream", "Expected path: " + PATHS.staying_parked);
        return { ok: true, view: snapshot(state) };
      },
      skip: function () {
        if (state.stage !== "enrich") return { ok: false, error: "skip_only_during_enrich" };
        var id = ENRICH_STEPS[state.enrichIndex];
        state.skipped[id] = true;
        delete state.answers[id];
        state.priority = priorityTier(state.answers);
        emit("enrich", { question: id, answer: "", skipped: true, priority: state.priority });
        note(state, "skip", "Skipped " + id + ". Priority " + state.priority + ". Conversion unchanged.");
        advance();
        return { ok: true, view: snapshot(state) };
      },
      answer: function (id, value) {
        if (state.stage === "q_type" && id === "type") {
          var quiet = goesQuiet(value);
          if (quiet === null) return { ok: false, error: "unknown_property" };
          state.answers.type = value;
          note(state, "q1", "Q1 property type: " + value + ".");
          if (quiet) {
            emit("property_type", { property_type: value, signal: "seller_form_disqualified", reason: "quiet_property" });
            finish("quiet_property", "pg_cron_sweep", "Google tag not loaded.");
            return { ok: true, view: snapshot(state) };
          }
          emit("property_type", { property_type: value, signal: "" });
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
            emit("ownership", { ownership: value, signal: "seller_form_disqualified", reason: "not_owner" });
            finish("quiet_non_owner", "crm_follow_up", "Google tag not loaded.");
            return { ok: true, view: snapshot(state) };
          }
          state.googleTagFired = true;
          gate.load();
          emit("ownership", { ownership: value, signal: conversionName(state.answers) });
          finish("hot", "zap_hot", "Google tag fired after owner=yes. Dry-run did not request the tag script.");
          return { ok: true, view: snapshot(state) };
        }
        if (state.stage === "enrich" && (ENRICH_STEPS.indexOf(id) >= 0 || LEGACY[id])) {
          if (ENRICH_STEPS.indexOf(id) >= 0 && !knownOption(id, value)) return { ok: false, error: "unknown_option" };
          state.answers[id] = value;
          delete state.skipped[id];
          state.priority = priorityTier(state.answers);
          var listed = id === "listed" ? " Listed homes stay on the hot path." : "";
          emit("enrich", { question: id, answer: value, skipped: false, priority: state.priority });
          note(state, "enrich", "Optional " + id + "=" + value + ". Priority " + state.priority + ". Conversion unchanged." + listed);
          if (id === ENRICH_STEPS[state.enrichIndex]) advance();
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
    captureAttribution: captureAttribution,
    priorityTier: priorityTier,
    conversionName: conversionName,
    exitEvent: exitEvent,
    memoryStorage: memoryStorage,
    CONFIG: CONFIG,
    TRACKING: TRACKING,
    PAYLOAD_FIELDS: PAYLOAD_FIELDS,
    ENRICH_STEPS: ENRICH_STEPS,
    NOT_FIT: NOT_FIT,
    FOLLOW_UP: FOLLOW_UP,
    THANKS: THANKS,
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
  var events = document.getElementById("ts-events");
  var sorry = document.getElementById("ts-sorry");
  var follow = document.getElementById("ts-followup");
  var thanks = document.getElementById("ts-thanks");
  var tag = { loaded: false, load: function () { this.loaded = true; var n = document.createElement("script"); n.id = "fsho-google-gate"; n.type = "application/json"; n.textContent = "{\"event\":\"form_fill\",\"dry_run\":true}"; document.body.appendChild(n); } };
  var dl = globalThis.dataLayer = globalThis.dataLayer || [];
  var flow = api.createFlow(api.createMockAdapter(), tag, {
    search: location.search,
    localStorage: safeStore(localStorage),
    sessionStorage: safeStore(sessionStorage),
    dataLayer: dl
  });
  function box(node, copy) {
    node.replaceChildren();
    if (!copy) return;
    var h = document.createElement("h2");
    h.textContent = copy.headline;
    var p = document.createElement("p");
    p.textContent = copy.body;
    node.appendChild(h);
    node.appendChild(p);
  }
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
    summary.dataset.priority = flow.state.priority || "";
    summary.dataset.lead = flow.state.leadId || "";
    var line = "Branch: " + (flow.state.branch || "not chosen") + ". Google tag: " + (flow.state.googleTagFired ? "fired" : "not loaded") + ". Path: " + (api.PATHS[path] || "not chosen") + ".";
    if (flow.state.priority) line += " Priority: " + flow.state.priority + ".";
    summary.textContent = line;
    var names = (flow.state.dataLayer || []).map(function (e) {
      if (!e || !e.event) return "";
      return e.reason ? e.event + " (" + e.reason + (e.property_type ? ":" + e.property_type : "") + ")" : e.event;
    }).filter(Boolean);
    if (events) events.textContent = "Events: " + (names.length ? names.join(", ") : "none");
    box(sorry, flow.state.sorry);
    box(follow, flow.state.followup);
    box(thanks, flow.state.stage === "thanks" ? flow.state.thanks : null);
    ask.replaceChildren();
    ask.dataset.step = flow.state.stage === "enrich" ? api.ENRICH_STEPS[flow.state.enrichIndex] : "";
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
      var wrap = document.createElement("div");
      var h = document.createElement("h2");
      h.id = "ts-question";
      h.textContent = spec[0];
      wrap.appendChild(h);
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
      wrap.appendChild(row);
      ask.appendChild(wrap);
    }
    if (qid) options(qid);
    if (flow.state.stage === "enrich") {
      var step = api.ENRICH_STEPS[flow.state.enrichIndex];
      var kicker = document.createElement("p");
      kicker.id = "ts-kicker";
      kicker.textContent = "Optional " + (flow.state.enrichIndex + 1) + " of " + api.ENRICH_STEPS.length + ". One tap.";
      ask.appendChild(kicker);
      options(step);
      var skip = document.createElement("button");
      skip.type = "button";
      skip.id = "ts-skip";
      skip.textContent = "Skip";
      skip.setAttribute("aria-label", "Skip this question");
      skip.onclick = function () { flow.skip(); paint(); };
      ask.appendChild(skip);
    }
  }
  form.onsubmit = function (e) {
    e.preventDefault();
    var data = new FormData(form);
    var result = flow.submitContact({ name: data.get("name"), address: data.get("address"), phone: data.get("phone"), email: data.get("email") });
    if (!result.ok) { summary.textContent = "Name, address, phone, and email are required."; return; }
    form.hidden = true;
    paint();
  };
  function safeStore(store) {
    try {
      var key = "__fsho_probe";
      store.setItem(key, "1");
      store.removeItem(key);
      return store;
    } catch (e) { return api.memoryStorage(); }
  }
}

