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
  var ENRICH_STEPS = ["occupancy", "condition", "listed", "timeline"];
  var PAYLOAD_FIELDS = ["lead_id", "stage", "gclid", "gbraid", "wbraid", "fbclid", "utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content"];
  var PUBLIC_EVENT_KEYS = { event: 1, transaction_id: 1, reason: 1, property_type: 1 };
  var TRACKING = {
    gtm_id: "GTM-TM6JSDLB",
    ga4: false,
    meta_pixel: false,
    lazy: true,
    storage_key: "fsho_ts_attr",
    lead_key: "fsho_ts_lead",
    click_ids: ["gclid", "gbraid", "wbraid", "fbclid"],
    utm: ["utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content", "utm_id"]
  };
  var REAL_ADAPTER = {
    enabled: false,
    base_url: "https://placeholder.invalid/functions/v1",
    kid: "KID-PLACEHOLDER",
    route: "ppc_inhouse",
    channel: "website"
  };
  var LEGACY_VALUES = {
    occupancy: { owner: 1, tenant: 1 },
    condition: { move_in: 1, wear: 1, repairs: 1, major: 1 },
    listed: { yes: 1, no: 1 }
  };
  var CONFIG = {
    townhouse_route: "quiet",
    use_real_adapter: false,
    producer_path: "/.netlify/functions/intake-producer",
    gtm_id: "GTM-TM6JSDLB"
  };
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
    body: "Thanks for filling out your info. Our team will reach out soon."
  };
  var QUESTIONS = {
    type: ["What kind of property is it?", [["sfh", "Single-family house"], ["townhouse", "Townhouse"], ["multi_2_4", "Multi-family (2-4 units)"], ["condo", "Condo"], ["mobile", "Mobile or manufactured home"], ["land", "Vacant land"]]],
    ownership: ["Are you the owner, or can you make the decision to sell?", [["sole_owner", "Yes, I'm the only owner"], ["all_agree", "Yes, and all owners agree"], ["decision_maker", "I'm an heir, executor, or have power of attorney"], ["no", "No, or not everyone agrees"]]],
    occupancy: ["Who is living there?", [["owner_occupied", "I live there"], ["tenant_occupied", "A tenant lives there"], ["vacant", "It's vacant"], ["unknown", "Not sure"]]],
    condition: ["What condition is the property in?", [["excellent", "Excellent"], ["good", "Good"], ["fair", "Fair"], ["needs_work", "Needs work"], ["major_repairs", "Major repairs"]]],
    listed: ["Is it listed with an agent?", [["not_listed", "Not listed"], ["listed_under_90", "Listed under 90 days"], ["listed_over_90", "Listed 90 days or more"], ["expired", "Listing expired"]]],
    timeline: ["When do you need to sell?", [["asap", "As soon as possible"], ["30d", "Within 30 days"], ["30_90d", "In 30 to 90 days"], ["over_90d", "More than 90 days"], ["no_rush", "No rush"]]],
    situation: ["What's the main reason you're selling?", [["behind", "Behind on payments"], ["repairs", "Needs repairs"], ["curious", "Just curious"]]],
    equity: ["Roughly how much is still owed?", [["free_clear", "Paid off"], ["under_half", "Less than half"], ["underwater", "About what it's worth, or more"]]],
    ability: ["Anything that could hold up a sale?", [["ready", "Nothing, ready to go"], ["need_time", "Need a little extra time"], ["cant_move", "Can't move out by closing"]]]
  };
  var PATHS = {
    zap_hot: "Zap Hot path: WhatConverts + CRM + Slack",
    pg_cron_sweep: "Self-serve sweep after 10 minutes, tagged q1_decline",
    crm_follow_up: "CRM follow-up, logged, no conversion",
    staying_parked: "Parked until the next answer, or if they leave",
    self_serve_timeout: "Self-serve sweep after 10 minutes, tagged timeout"
  };

  function testModeAllowed(context, search) {
    if (context === "production") return false;
    if (context !== "deploy-preview" && context !== "branch-deploy" && context !== "dev" && context !== "local") return false;
    return /(?:^|[?&])test=1(?:&|$)/.test(String(search || ""));
  }

  function createMockAdapter() {
    var log = [];
    function tierFrom(e) {
      e = e || {};
      var fast = e.timeline === "asap" || e.timeline === "30d";
      var distress = e.condition === "needs_work" || e.condition === "major_repairs" || e.listed === "expired" || e.listed === "listed_over_90";
      if (e.occupancy === "vacant" || (fast && distress)) return "p1";
      if (fast || e.timeline === "30_90d") return "p2";
      return "p3";
    }
    function tierOrNull(e) {
      if (!e || !Object.keys(e).length) return null;
      return tierFrom(e);
    }
    return {
      log: log,
      park: function (row) {
        log.push({ op: "park", crm: false, google: false, row: row });
        return { ok: true, http: 200, status: "parked" };
      },
      branch: function (name) { log.push({ op: "branch", name: name }); },
      google: function (fired) { log.push({ op: "google", fired: fired === true }); },
      downstream: function (path) { log.push({ op: "downstream", path: path }); },
      stage: function (payload) { log.push({ op: "stage", payload: payload }); },
      answer: function (req) { log.push({ op: "answer", req: req }); return { ok: true, status: "saved" }; },
      claim: function (req) {
        var tier = req && req.by === "non_owner" ? "follow_up" : "hot";
        var res = { ok: true, claimed: true, tier: tier, priority_tier: tierOrNull(req && req.enrichment), status: "claimed" };
        log.push({ op: "claim", req: req, res: res });
        return res;
      },
      complete: function (req) {
        var res = { ok: true, status: "delivered" };
        log.push({ op: "complete", req: req, res: res });
        return res;
      },
      enrich: function (req) {
        var enrichment = (req && req.enrichment) || {};
        var res = { ok: true, status: "saved", priority_tier: tierOrNull(enrichment) };
        log.push({ op: "enrich", req: Object.assign({}, req, { enrichment: enrichment }), res: res });
        return res;
      },
      reserve: function (req) {
        var res = { ok: true, status: "dispatch_intended_committed" };
        log.push({ op: "reserve", req: req, res: res });
        return res;
      }
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
    var incoming = project(parseQuery(search), keys);
    var changed = false;
    keys.forEach(function (k) {
      if (!existing[k] && incoming[k]) { existing[k] = incoming[k]; changed = true; }
    });
    if (changed) writeJson(store, cfg.storage_key, existing);
    return project(existing, keys);
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
    if (spec && spec[1].some(function (opt) { return opt[0] === value; })) return true;
    return !!(LEGACY_VALUES[id] && LEGACY_VALUES[id][value]);
  }

  function canonicalJson(value, depth) {
    if (value === null) return "null";
    var kind = typeof value;
    if (kind === "number") {
      if (!isFinite(value) || Math.floor(value) !== value) throw new Error("canonical_number");
      return String(value);
    }
    if (kind === "boolean") return value ? "true" : "false";
    if (kind === "string") return JSON.stringify(value);
    if (depth === undefined) depth = 0;
    if (depth > 32) throw new Error("canonical_depth");
    if (Array.isArray(value)) return "[" + value.map(function (item) { return canonicalJson(item, depth + 1); }).join(",") + "]";
    var keys = Object.keys(value).filter(function (key) { return value[key] !== undefined; }).sort();
    return "{" + keys.map(function (key) { return JSON.stringify(key) + ":" + canonicalJson(value[key], depth + 1); }).join(",") + "}";
  }

  function sha256Hex(message) {
    var K = [1116352408,1899447441,3049323471,3921009573,961987163,1508970993,2453635748,2870763221,3624381080,310598401,607225278,1426881987,1925078388,2162078206,2614888103,3248222580,3835390401,4022224774,264347078,604807628,770255983,1249150122,1555081692,1996064986,2554220882,2821834349,2952996808,3210313671,3336571891,3584528711,113926993,338241895,666307205,773529912,1294757372,1396182291,1695183700,1986661051,2177026350,2456956037,2730485921,2820302411,3259730800,3345764771,3516065817,3600352804,4094571909,275423344,430227734,506948616,659060556,883997877,958139571,1322822218,1537002063,1747873779,1955562222,2024104815,2227730452,2361852424,2428436474,2756734187,3204031479,3329325298];
    function rr(n, x) { return (x >>> n) | (x << (32 - n)); }
    var bytes = unescape(encodeURIComponent(message));
    var bits = bytes.length * 8;
    bytes += String.fromCharCode(128);
    while ((bytes.length % 64) !== 56) bytes += String.fromCharCode(0);
    var hi = Math.floor(bits / 4294967296);
    var lo = bits >>> 0;
    for (var i = 3; i >= 0; i--) bytes += String.fromCharCode((hi >>> (i * 8)) & 255);
    for (var j = 3; j >= 0; j--) bytes += String.fromCharCode((lo >>> (j * 8)) & 255);
    var H = [1779033703,3144134277,1013904242,2773480762,1359893119,2600822924,528734635,1541459225];
    var w = new Array(64);
    for (var o = 0; o < bytes.length; o += 64) {
      for (var t = 0; t < 16; t++) w[t] = ((bytes.charCodeAt(o + t * 4) & 255) << 24) | ((bytes.charCodeAt(o + t * 4 + 1) & 255) << 16) | ((bytes.charCodeAt(o + t * 4 + 2) & 255) << 8) | (bytes.charCodeAt(o + t * 4 + 3) & 255);
      for (var u = 16; u < 64; u++) {
        var s0 = rr(7, w[u - 15]) ^ rr(18, w[u - 15]) ^ (w[u - 15] >>> 3);
        var s1 = rr(17, w[u - 2]) ^ rr(19, w[u - 2]) ^ (w[u - 2] >>> 10);
        w[u] = (w[u - 16] + s0 + w[u - 7] + s1) | 0;
      }
      var a = H[0], b = H[1], c = H[2], d = H[3], e = H[4], f = H[5], g = H[6], h = H[7];
      for (var n = 0; n < 64; n++) {
        var S1 = rr(6, e) ^ rr(11, e) ^ rr(25, e);
        var ch = (e & f) ^ (~e & g);
        var t1 = (h + S1 + ch + K[n] + w[n]) | 0;
        var S0 = rr(2, a) ^ rr(13, a) ^ rr(22, a);
        var maj = (a & b) ^ (a & c) ^ (b & c);
        var t2 = (S0 + maj) | 0;
        h = g; g = f; f = e; e = (d + t1) | 0; d = c; c = b; b = a; a = (t1 + t2) | 0;
      }
      H[0] = (H[0] + a) | 0; H[1] = (H[1] + b) | 0; H[2] = (H[2] + c) | 0; H[3] = (H[3] + d) | 0;
      H[4] = (H[4] + e) | 0; H[5] = (H[5] + f) | 0; H[6] = (H[6] + g) | 0; H[7] = (H[7] + h) | 0;
    }
    var hex = "";
    for (var z = 0; z < 8; z++) hex += ("00000000" + (H[z] >>> 0).toString(16)).slice(-8);
    return hex;
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
      serverTier: state.serverTier,
      tierPending: state.tierPending,
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
      leadId: leadId, attr: attr, priority: "", serverTier: "", conversionFired: false, enrichIndex: 0, skipped: {},
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
    function notifyReservedPixels(leadId) {
      var hook = globalThis.FSHOPixels;
      if (!hook || typeof hook.onReserved !== "function") return;
      try { hook.onReserved(leadId); } catch (e) {}
    }
    function fireConversion() {
      if (state.conversionFired || seenConversion()) { state.conversionFired = true; return; }
      state.conversionFired = true;
      pushPublic(dataLayer, { event: "seller_form_completed", transaction_id: state.leadId });
      note(state, "conversion", "seller_form_completed once. transaction_id is the lead id.");
      if (config.publicForm) notifyReservedPixels(state.leadId);
    }
    function fireExit(branch) {
      var event = exitEvent(branch, state.answers);
      if (!event || state.exitFired) return;
      state.exitFired = true;
      event.transaction_id = state.leadId;
      pushPublic(dataLayer, event);
      note(state, "exit", "seller_form_disqualified (" + event.reason + "). No conversion.");
    }
    function trackingFields() {
      var row = { lead_id: state.leadId };
      trackKeys(tracking).forEach(function (k) { if (state.attr[k]) row[k] = state.attr[k]; });
      return row;
    }
    function chain(value, fn) {
      if (value && typeof value.then === "function") return value.then(fn);
      return fn(value);
    }
    function settle(value, fn, onError) {
      if (value && typeof value.then === "function") return value.then(fn, onError);
      return fn(value);
    }
    function retryOwnership() {
      state.stage = "q_ownership";
      state.googleTagFired = false;
      state.sorry = null;
      state.followup = null;
      state.thanks = null;
      return { ok: false, error: "try_again", view: snapshot(state) };
    }
    function showClaimedThanks(alreadyReserved) {
      state.branch = "stopped";
      state.downstream = "staying_parked";
      state.stage = "thanks";
      state.sorry = null;
      state.followup = null;
      state.thanks = THANKS;
      state.googleTagFired = false;
      adapter.branch("stopped");
      adapter.google(false);
      adapter.downstream("staying_parked");
      note(state, "google", "Google tag not loaded.");
      note(state, "downstream", "Expected path: " + PATHS.staying_parked);
      note(state, "thanks", alreadyReserved ? "Already claimed and already reserved. Thanks screen. No reserve and no Zap." : "Already claimed. Reserve succeeded. Thanks screen.");
      return { ok: true, view: snapshot(state) };
    }
    function recordAnswer(question, value) {
      if (typeof adapter.answer !== "function") return { ok: true };
      return adapter.answer(Object.assign(trackingFields(), { question: question, answer: value })) || { ok: true };
    }
    function rejected(res) {
      return !!(res && res.ok === false && (res.http === 400 || res.status === "bad_input"));
    }
    function decideClaim(hint, by) {
      if (typeof adapter.claim !== "function") return hint;
      return chain(adapter.claim(Object.assign(trackingFields(), { by: by })), function (res) {
      res = res || {};
      if (res.status === "late_hot") {
        res.tier = "hot";
        res.claimed = true;
        res.ok = res.ok !== false;
        res.status = "claimed";
        note(state, "server", "Claim returned late_hot. Treated as a Hot claim.");
      }
      state.claimStatus = res.status || "";
      if (res.priority_tier) { state.serverTier = res.priority_tier; state.tierPending = false; }
      else if (res.priority_tier === null) { state.serverTier = ""; state.tierPending = true; }
      if (res.status === "already_claimed") {
        if (res.reserved === true || state.reserveCommitted) {
          note(state, "server", "Server already claimed this lead. Reserve already succeeded. Stop. No reserve and no Zap.");
          return "stopped";
        }
        note(state, "server", "Server already claimed this lead. Reserve has not succeeded.");
        return "reserve_again";
      }
      if (res.ok === false && (res.status === "not_qualified" || res.status === "not_non_owner" || res.status === "bad_input")) {
        note(state, "server", "Server said " + res.status + ". The client screen hint was " + hint + ". Following the server.");
        if (res.fields && res.fields.length) note(state, "fields", "Claim fields: " + res.fields.join(", ") + ".");
        return "server_declined";
      }
      var serverBranch = res.tier === "hot" ? "hot" : (res.tier === "follow_up" ? "quiet_non_owner" : "");
      if (!serverBranch) {
        note(state, "server", "Claim returned " + (res.status || "no tier") + ". Following the server.");
        return "server_declined";
      }
      if (serverBranch !== hint) note(state, "server", "Server tier " + res.tier + " overrides the client screen hint " + hint + ".");
      else note(state, "server", "Claim returned tier " + res.tier + ".");
      return serverBranch;
      });
    }
    function reserveAccepted(res) {
      if (!res || res.ok === false) return false;
      if (typeof res.http === "number" && (res.http < 200 || res.http >= 300)) return false;
      var status = String(res.status || "");
      return status === "dispatch_intended_committed" || status === "idempotent_replay" || status === "reserved";
    }
    function sendReserve() {
      if (typeof adapter.reserve !== "function") {
        note(state, "reserve", "Reserve was not called.");
        return false;
      }
      var pending;
      try {
        pending = adapter.reserve(Object.assign(trackingFields(), { destination: "crm_create", stage: "final" }));
      } catch (e) {
        note(state, "reserve", "Reserve did not finish.");
        return false;
      }
      return settle(pending, function (res) {
        var accepted = reserveAccepted(res);
        if (accepted) {
          state.reserveCommitted = true;
          note(state, "reserve", "Reserve committed. Owner token stays off this trace.");
        } else {
          note(state, "reserve", "Reserve returned " + ((res && res.status) || "held") + ".");
        }
        return accepted;
      }, function () {
        note(state, "reserve", "Reserve did not finish.");
        return false;
      });
    }
    function applyTier(res) {
      res = res || {};
      if (res.http === 409 || res.status === "not_hot") {
        state.serverTier = "";
        state.tierPending = false;
        note(state, "tier", "Enrich was not applied. No tier.");
        return;
      }
      if (res.http === 503 || res.status === "enrich_unavailable") {
        state.serverTier = "";
        state.tierPending = false;
        note(state, "tier", "Enrich was unavailable. No tier.");
        return;
      }
      if (res.priority_tier) {
        state.serverTier = res.priority_tier;
        state.tierPending = false;
        note(state, "tier", "Server priority_tier " + res.priority_tier + ".");
      } else if (res.priority_tier === null || res.status === "saved") {
        state.serverTier = "";
        state.tierPending = true;
        note(state, "tier", "Server priority_tier none.");
      }
      if (rejected(res)) note(state, "fields", "Enrich rejected: " + (res.fields || []).join(", ") + ".");
    }
    function sendEnrichment() {
      if (typeof adapter.enrich !== "function") return;
      var enrichment = {};
      ENRICH_STEPS.forEach(function (key) { if (state.answers[key]) enrichment[key] = state.answers[key]; });
      return chain(adapter.enrich(Object.assign(trackingFields(), { enrichment: enrichment })), function (res) {
        applyTier(res);
      });
    }
    function finish(branch, path, googleText) {
      state.branch = branch;
      state.downstream = path;
      state.stage = branch === "hot" ? "enrich" : "done";
      state.enrichIndex = 0;
      state.sorry = branch === "quiet_property" ? NOT_FIT : null;
      state.followup = branch === "quiet_non_owner" ? FOLLOW_UP : null;
      state.thanks = null;
      if (branch === "hot" && conversionName(state.answers)) fireConversion();
      else fireExit(branch);
      adapter.branch(branch);
      adapter.google(state.googleTagFired);
      adapter.downstream(path);
      note(state, "branch", branch === "hot" ? "Hot. This is the form fill." : (branch === "quiet_property" ? "Quiet property branch. The sweep moves this to self-serve after 10 minutes, tagged q1_decline." : "Quiet non-owner branch. Logged, no conversion."));
      note(state, "google", googleText);
      note(state, "downstream", "Expected path: " + PATHS[path]);
    }
    function advance() {
      state.enrichIndex += 1;
      if (state.enrichIndex < ENRICH_STEPS.length) return;
      state.stage = "thanks";
      state.thanks = THANKS;
      emit("thanks", {
        occupancy: state.answers.occupancy || "",
        condition: state.answers.condition || "",
        listed: state.answers.listed || "",
        timeline: state.answers.timeline || ""
      });
      return chain(sendEnrichment(), function () {
        note(state, "thanks", "Optional questions finished. Conversion already counted.");
      });
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
        var consent = contact.consent === true;
        state.contact = { name: name, address: address, phone: phone, email: email, consent: consent };
        return chain(adapter.park(Object.assign(basePayload("contact"), { name: name, address: address, phone: phone, email: email, consent: consent, status: "parked" })), function (parked) {
          if (parked && (parked.ok === false || (typeof parked.http === "number" && (parked.http < 200 || parked.http >= 300)))) {
            state.parked = false;
            state.stage = "contact";
            if (rejected(parked)) {
              note(state, "fields", "Park rejected: " + (parked.fields || []).join(", ") + ".");
              return { ok: false, error: "bad_input", fields: parked.fields, view: snapshot(state) };
            }
            note(state, "park", "Park returned " + ((parked && parked.status) || "error") + ". Nothing was saved.");
            return { ok: false, error: "try_again", view: snapshot(state) };
          }
          state.parked = true;
          state.stage = "q_type";
          state.downstream = "staying_parked";
          note(state, "park", "Parked in the staged table. No CRM lead. No Google tag.");
          note(state, "downstream", "Expected path: " + PATHS.staying_parked + ".");
          return { ok: true, view: snapshot(state) };
        });
      },
      abandon: function () {
        if (state.stage !== "q_type") return { ok: false, error: "abandon_only_after_stage_1" };
        state.stage = "abandoned";
        state.branch = "abandoned";
        state.downstream = "self_serve_timeout";
        emit("abandoned", {});
        adapter.branch("abandoned");
        adapter.google(false);
        adapter.downstream("self_serve_timeout");
        note(state, "abandon", "Left after stage 1. The sweep moves this to self-serve after 10 minutes, tagged timeout. No CRM lead and no Google tag.");
        note(state, "google", "Google tag not loaded.");
        note(state, "downstream", "Expected path: " + PATHS.self_serve_timeout);
        return { ok: true, view: snapshot(state) };
      },
      skip: function () {
        if (state.stage !== "enrich") return { ok: false, error: "skip_only_during_enrich" };
        var id = ENRICH_STEPS[state.enrichIndex];
        state.skipped[id] = true;
        delete state.answers[id];
        emit("enrich", { question: id, answer: "", skipped: true });
        note(state, "skip", "Skipped " + id + ". Conversion unchanged.");
        return chain(advance(), function () { return { ok: true, view: snapshot(state) }; });
      },
      answer: function (id, value) {
        if (state.stage === "q_type" && id === "type") {
          var quiet = goesQuiet(value);
          if (quiet === null) return { ok: false, error: "unknown_property" };
          state.answers.type = value;
          note(state, "q1", "Q1 property type: " + value + ".");
          return chain(recordAnswer("type", value), function (typed) {
            if (rejected(typed)) {
              note(state, "fields", "Answer rejected: " + (typed.fields || []).join(", ") + ".");
              return { ok: false, error: "bad_input", fields: typed.fields, view: snapshot(state) };
            }
            if (quiet) {
              emit("property_type", { property_type: value, signal: "seller_form_disqualified", reason: "quiet_property" });
              finish("quiet_property", "pg_cron_sweep", "Google tag not loaded.");
              return { ok: true, view: snapshot(state) };
            }
            emit("property_type", { property_type: value, signal: "" });
            state.stage = "q_ownership";
            note(state, "google", "Google tag not loaded. Waiting for an owner answer.");
            return { ok: true, view: snapshot(state) };
          });
        }
        if (state.stage === "q_ownership" && id === "ownership") {
          var owner = !!OWNERS[value];
          if (!owner && value !== "no") return { ok: false, error: "unknown_ownership" };
          state.answers.ownership = value;
          note(state, "q2", "Q2 ownership: " + value + ".");
          return chain(recordAnswer("ownership", value), function (owned) {
            if (rejected(owned)) {
              note(state, "fields", "Answer rejected: " + (owned.fields || []).join(", ") + ".");
              return { ok: false, error: "bad_input", fields: owned.fields, view: snapshot(state) };
            }
            var hint = owner ? "hot" : "quiet_non_owner";
            var decidedClaim;
            try { decidedClaim = decideClaim(hint, owner ? "promote" : "non_owner"); }
            catch (e) { return retryOwnership(); }
            return settle(decidedClaim, function (decided) {
              if (decided === "hot" || decided === "reserve_again") {
                return chain(sendReserve(), function (committed) {
                  if (!committed) return retryOwnership();
                  if (decided === "reserve_again") return showClaimedThanks(false);
                  state.googleTagFired = true;
                  gate.load();
                  emit("ownership", { ownership: value, signal: conversionName(state.answers) });
                  finish("hot", "zap_hot", "Google tag fired after owner=yes. Dry-run did not request the tag script.");
                  return { ok: true, view: snapshot(state) };
                });
              }
              if (decided === "quiet_non_owner") {
                emit("ownership", { ownership: value, signal: "seller_form_disqualified", reason: "not_owner" });
                finish("quiet_non_owner", "crm_follow_up", "Google tag not loaded.");
                return { ok: true, view: snapshot(state) };
              }
              if (decided === "stopped") return showClaimedThanks(true);
              return retryOwnership();
            }, retryOwnership);
          });
        }
        if (state.stage === "enrich" && (ENRICH_STEPS.indexOf(id) >= 0 || LEGACY[id])) {
          if (ENRICH_STEPS.indexOf(id) >= 0 && !knownOption(id, value)) return { ok: false, error: "unknown_option" };
          state.answers[id] = value;
          delete state.skipped[id];
          var listed = id === "listed" ? " Listed homes stay on the hot path." : "";
          emit("enrich", { question: id, answer: value, skipped: false });
          note(state, "enrich", "Optional " + id + "=" + value + ". Conversion unchanged." + listed);
          if (id === ENRICH_STEPS[state.enrichIndex]) return chain(advance(), function () { return { ok: true, view: snapshot(state) }; });
          return { ok: true, view: snapshot(state) };
        }
        return { ok: false, error: "unexpected_answer" };
      }
    };
  }

  var WIRE_KEYS = ["gclid", "gbraid", "wbraid", "fbclid", "utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content", "utm_id", "lead_id"];

  function createRealAdapter(options) {
    options = options || {};
    var send = options.transport;
    var base = String(options.baseUrl || REAL_ADAPTER.base_url).replace(/\/$/, "");
    var signer = options.signer || {};
    var stuck = {};
    var ownerToken = "";
    var reservationId = "";
    var reservationGeneration = 1;
    var reservation = { stage: "", intake: "" };
    var ids = { intake: "", binding: "", kid: options.kid || REAL_ADAPTER.kid };
    var mintedOnce = false;
    function eventId() {
      if (typeof options.uuid === "function") return options.uuid();
      return mintLeadId();
    }
    function nowSec() {
      return typeof options.now === "function" ? options.now() : Math.floor(Date.now() / 1000);
    }
    function ensureMint() {
      if (mintedOnce) return Promise.resolve();
      mintedOnce = true;
      return Promise.resolve(send(base + "/intake-reserve/mint", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).then(normalize).then(function (minted) {
        ids.intake = minted.intake_id || "";
        ids.binding = minted.session_binding || "";
        if (minted.kid) ids.kid = minted.kid;
      });
    }
    function remember(row) {
      WIRE_KEYS.forEach(function (key) {
        if (!stuck[key] && row && row[key]) stuck[key] = String(row[key]);
      });
    }
    function tracking(row) {
      remember(row);
      var out = {};
      WIRE_KEYS.forEach(function (key) { if (stuck[key]) out[key] = stuck[key]; });
      return out;
    }
    function envelope(stage, payload, intake) {
      return ensureMint().then(function () {
        var ts = nowSec();
        return {
          v: "1", kid: ids.kid, route: REAL_ADAPTER.route, channel: REAL_ADAPTER.channel,
          intake_id: intake || ids.intake, event_id: eventId(), stage: stage, ts: ts, exp: ts + 900,
          payload_sha256: sha256Hex(canonicalJson(payload)), sig: ""
        };
      });
    }
    function signedIp(payload) {
      if (signer.client_ip) payload.client_ip = signer.client_ip;
      return payload;
    }
    function cleanReason(reason) {
      if (!reason) return "";
      return String(reason).replace(/[\u0000-\u001f\u007f]/g, "").slice(0, 200);
    }
    function mapEnrichment(source) {
      var out = {};
      ENRICH_STEPS.forEach(function (key) { if (source && source[key]) out[key] = source[key]; });
      return out;
    }
    function headerValue(res, name) {
      var headers = res && res.headers;
      if (!headers) return "";
      if (typeof headers.get === "function") return headers.get(name) || "";
      return headers[name] || headers[name.toLowerCase()] || "";
    }
    function readBody(res) {
      if (res && typeof res.json === "function") {
        return Promise.resolve(res.json()).then(function (body) { return body || {}; }, function () { return { status: "bad_json" }; });
      }
      var body = res && res.body;
      if (typeof body === "string") {
        try { body = JSON.parse(body); } catch (e) { body = { status: "bad_json" }; }
      }
      return Promise.resolve(body || {});
    }
    function normalize(res) {
      return readBody(res).then(function (body) {
      var status = res && typeof res.status === "number" ? res.status : 0;
      var retry = headerValue(res, "retry-after");
      if (body.reservation_id) reservationId = body.reservation_id;
      if (body.reservation_generation) reservationGeneration = body.reservation_generation;
      if (body.owner_token && !ownerToken) ownerToken = body.owner_token;
      if (status === 400) return { ok: false, http: 400, status: body.status || "bad_input", fields: body.fields || [] };
      if (status === 401) return { ok: false, http: 401, status: body.status || "auth_failed" };
      if (status === 404) return { ok: false, http: 404, status: body.status || "not_found" };
      if (status === 405) return { ok: false, http: 405, status: body.status || "method_not_allowed" };
      if (status === 409) return { ok: false, http: 409, status: body.status || "not_qualified", claimed: false };
      if (status === 413) return { ok: false, http: 413, status: body.status || "payload_too_large" };
      if (status === 429) return { ok: false, http: 429, status: body.status || "rate_limited", retryAfter: retry };
      if (status === 503) return { ok: false, http: 503, status: body.status || "not_configured", retryAfter: retry };
      if (status === 200) {
        var copy = { ok: body.ok !== false, http: 200 };
        Object.keys(body).forEach(function (key) { if (key !== "owner_token") copy[key] = body[key]; });
        return copy;
      }
      return { ok: false, http: status, status: body.status || "bad_response", fields: body.fields || [] };
      });
    }
    if (options.mode === "producer") {
      function producerCall(op, fields) {
        var body = { op: op };
        Object.keys(fields || {}).forEach(function (key) {
          if (key === "client_ip" || key === "attribution" || key === "envelope" || key === "session_binding" || key === "owner_token" || key === "sig") return;
          if (fields[key] !== undefined && fields[key] !== "") body[key] = fields[key];
        });
        return post("", body);
      }
      return {
        get intakeId() { return ""; },
        get sessionBinding() { return ""; },
        park: function (row) {
          row = row || {};
          return producerCall("park", Object.assign(tracking(row), {
            full_name: row.full_name || row.name || "",
            address_line: row.address_line || row.address || "",
            phone: row.phone || "",
            email: row.email || "",
            is_test: options.isTest === true,
            consent: row.consent === true
          }));
        },
        answer: function (req) {
          req = req || {};
          return producerCall("answer", Object.assign(tracking(req), { question: req.question, answer: req.answer }));
        },
        claim: function (req) {
          req = req || {};
          return producerCall("claim", Object.assign(tracking(req), { by: req.by }));
        },
        enrich: function (req) {
          req = req || {};
          return producerCall("enrich", Object.assign(tracking(req), { enrichment: mapEnrichment(req.enrichment) }));
        },
        reserve: function (req) {
          req = req || {};
          return producerCall("reserve", Object.assign(tracking(req), { destination: req.destination || "crm_create", stage: req.stage === "first" ? "first" : "final" }));
        },
        branch: function () {},
        google: function () {},
        downstream: function () {},
        stage: function () {}
      };
    }
    function post(path, body, extraHeaders) {
      var headers = { "content-type": "application/json" };
      if (extraHeaders) Object.keys(extraHeaders).forEach(function (key) { if (extraHeaders[key]) headers[key] = extraHeaders[key]; });
      return Promise.resolve(send(base + path, { method: "POST", headers: headers, body: JSON.stringify(body == null ? {} : body) })).then(normalize);
    }
    function tokenHeader(req) {
      if (!req || !req.token) return null;
      return { "x-intake-zap-token": req.token };
    }
    return {
      get intakeId() { return ids.intake; },
      get sessionBinding() { return ids.binding; },
      park: function (row) {
        row = row || {};
        var payload = Object.assign(tracking(row), { is_test: options.isTest === true });
        var full = String(row.full_name || row.name || "").slice(0, 160);
        var line = String(row.address_line || row.address || "").slice(0, 200);
        if (full) payload.full_name = full;
        if (line) payload.address_line = line;
        var phone = String(row.phone || "").replace(/\D/g, "");
        if (phone) payload.phone = phone;
        if (row.email) payload.email = row.email;
        payload.consent = row.consent === true;
        signedIp(payload);
        return envelope("partial", payload).then(function (env) {
          return post("/intake-park/park", { envelope: env, session_binding: ids.binding, payload: payload });
        });
      },
      answer: function (req) {
        req = req || {};
        var payload = signedIp(Object.assign({ question: req.question, answer: req.answer }, tracking(req)));
        return envelope("partial", payload).then(function (env) {
          return post("/intake-park/answer", { envelope: env, payload: payload });
        });
      },
      claim: function (req) {
        req = req || {};
        var payload = signedIp(Object.assign({ by: req.by }, tracking(req)));
        return envelope("partial", payload).then(function (env) {
          return post("/intake-park/claim", { envelope: env, payload: payload });
        });
      },
      enrich: function (req) {
        req = req || {};
        var waitMs = options.enrichRetryMs == null ? 40 : options.enrichRetryMs;
        function once() {
          var payload = signedIp(Object.assign(tracking(req), { enrichment: mapEnrichment(req.enrichment) }));
          return envelope("partial", payload).then(function (env) {
            return post("/intake-park/enrich", { envelope: env, payload: payload });
          });
        }
        function wait() {
          return new Promise(function (resolve) { setTimeout(resolve, waitMs); });
        }
        return once().then(function (res) {
          if (res && res.http === 503) return wait().then(once);
          return res;
        });
      },
      reserve: function (req) {
        req = req || {};
        if (!ownerToken) ownerToken = req.owner_token || eventId();
        var payload = tracking(req);
        delete payload.enrichment;
        var stage = req.stage === "first" ? "first" : "final";
        return envelope(stage, payload).then(function (env) {
          reservation.stage = stage;
          reservation.intake = ids.intake;
          return post("/intake-reserve/reserve", {
            envelope: env, payload: payload, session_binding: ids.binding,
            destination: req.destination || "crm_create", owner_token: ownerToken, lease_seconds: req.lease_seconds || 120
          });
        });
      },
      verify: function (req) {
        req = req || {};
        var header = tokenHeader(req);
        if (!header) return { ok: false, http: 401, status: "auth_failed", fields: [] };
        var body = { reservation_id: req.reservation_id };
        if (req.intake_id) body.intake_id = req.intake_id;
        if (req.owner_token) body.owner_token = req.owner_token;
        return post("/intake-reserve/verify", body, header);
      },
      complete: function (req) {
        req = req || {};
        if (req.mode === "token") {
          var header = tokenHeader(req);
          if (!header) return { ok: false, http: 401, status: "auth_failed", fields: [] };
          var tokenBody = {
            reservation_id: req.reservation_id || reservationId,
            owner_token: req.owner_token || ownerToken,
            reservation_generation: req.reservation_generation || reservationGeneration,
            session_binding: req.session_binding || ids.binding,
            intake_id: req.intake_id || ids.intake
          };
          if (req.remote_id) tokenBody.remote_id = req.remote_id;
          Object.assign(tokenBody, tracking(req));
          delete tokenBody.enrichment;
          return post("/intake-reserve/complete", tokenBody, header);
        }
        if (!ownerToken) ownerToken = req.owner_token || eventId();
        var payload = tracking(req);
        delete payload.enrichment;
        return envelope("final", payload).then(function (env) {
        var hmacBody = {
          envelope: env, payload: payload, session_binding: ids.binding,
          owner_token: ownerToken, reservation_id: req.reservation_id || reservationId,
          reservation_generation: req.reservation_generation || reservationGeneration
        };
        if (req.remote_id) hmacBody.remote_id = req.remote_id;
        return post("/intake-reserve/complete", hmacBody);
        });
      },
      reconcile: function (req) {
        req = req || {};
        var reason = cleanReason(req.reason);
        if (req.mode === "hmac") {
          var payload = reason ? { reason: reason } : {};
          var stage = reservation.stage === "first" || reservation.stage === "final" ? reservation.stage : (req.stage === "first" ? "first" : req.stage);
          return envelope(stage, payload, reservation.intake).then(function (env) {
            return post("/intake-reserve/reconcile", { envelope: env, payload: payload, reservation_id: req.reservation_id || reservationId });
          });
        }
        var header = tokenHeader(req);
        if (!header) return { ok: false, http: 401, status: "auth_failed", fields: [] };
        var body = { reservation_id: req.reservation_id || reservationId, owner_token: req.owner_token || ownerToken };
        if (reason) body.reason = reason;
        return post("/intake-reserve/reconcile", body, header);
      },
      branch: function () {},
      google: function () {},
      downstream: function () {},
      stage: function () {}
    };
  }

  function chooseAdapter(options) {
    options = options || {};
    var real = CONFIG.use_real_adapter === true;
    try { if (String(globalThis.FSHO_USE_REAL_ADAPTER || "") === "1") real = true; } catch (e) {}
    var net = globalThis.fetch;
    if (!real || typeof net !== "function") return createMockAdapter();
    return createRealAdapter({
      mode: "producer",
      isTest: options.isTest === true,
      baseUrl: CONFIG.producer_path,
      transport: function (url, init) {
        var opts = {};
        if (init) Object.keys(init).forEach(function (key) { opts[key] = init[key]; });
        opts.credentials = "same-origin";
        return net.call(globalThis, url, opts);
      }
    });
  }

  function selectAdapter(config) {
    config = config || {};
    if (config.adapter !== "real") return createMockAdapter();
    if (!testModeAllowed(config.context || "", config.search || "")) return createMockAdapter();
    if (typeof config.transport !== "function") return createMockAdapter();
    var real = {};
    Object.keys(config).forEach(function (key) { real[key] = config[key]; });
    real.isTest = true;
    return createRealAdapter(real);
  }

  return {
    testModeAllowed: testModeAllowed,
    createMockAdapter: createMockAdapter,
    createRealAdapter: createRealAdapter,
    selectAdapter: selectAdapter,
    chooseAdapter: chooseAdapter,
    createFlow: createFlow,
    captureAttribution: captureAttribution,
    canonicalJson: canonicalJson,
    sha256Hex: sha256Hex,
    REAL_ADAPTER: REAL_ADAPTER,
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
  if (!app) return;
  var publicForm = app.getAttribute("data-public") === "1";
  var testOn = false;
  if (!publicForm) {
    if (!off) return;
    testOn = api.testModeAllowed(globalThis.FSHO_DEPLOY_CONTEXT || "", location.search);
    if (!testOn) { off.hidden = false; return; }
  }
  app.hidden = false;
  var form = document.getElementById("ts-form");
  var ask = document.getElementById("ts-ask");
  var trace = document.getElementById("ts-trace");
  var summary = document.getElementById("ts-summary");
  var events = document.getElementById("ts-events");
  var sorry = document.getElementById("ts-sorry");
  var follow = document.getElementById("ts-followup");
  var thanks = document.getElementById("ts-thanks");
  var error = document.getElementById("ts-error");
  var pending = false;
  var tryAgain = "That step did not save. You can try again.";
  var tag = { loaded: false, load: function () { this.loaded = true; var n = document.createElement("script"); n.id = "fsho-google-gate"; n.type = "application/json"; n.textContent = "{\"event\":\"form_fill\",\"dry_run\":true}"; document.body.appendChild(n); } };
  var dl = globalThis.dataLayer = globalThis.dataLayer || [];
  var flow = api.createFlow(api.chooseAdapter({ isTest: testOn }), tag, {
    search: location.search,
    localStorage: safeStore(localStorage),
    sessionStorage: safeStore(sessionStorage),
    dataLayer: dl,
    publicForm: publicForm
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
  function paintScreen() {
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
    summary.dataset.priority = flow.state.serverTier || (flow.state.tierPending ? "none" : "");
    summary.dataset.lead = flow.state.leadId || "";
    var line = "Branch: " + (flow.state.branch || "not chosen") + ". Google tag: " + (flow.state.googleTagFired ? "fired" : "not loaded") + ". Path: " + (api.PATHS[path] || "not chosen") + ".";
    if (flow.state.serverTier) line += " Server tier: " + flow.state.serverTier + ".";
    else if (flow.state.tierPending) line += " Server tier: none.";
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
    if (flow.state.stage === "q_type" && !publicForm) {
      var leave = document.createElement("button");
      leave.type = "button";
      leave.className = "bk";
      leave.id = "ts-abandon";
      leave.textContent = "Leave it parked";
      leave.onclick = function () { runStep(function () { return flow.abandon(); }); };
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
        b.onclick = function () { runStep(function () { return flow.answer(id, opt[0]); }); };
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
      skip.onclick = function () { runStep(function () { return flow.skip(); }); };
      ask.appendChild(skip);
    }
  }
  function hasNodes(node) {
    return !!(node && node.childNodes && node.childNodes.length);
  }
  function hasScreen() {
    return hasNodes(ask) || hasNodes(sorry) || hasNodes(follow) || hasNodes(thanks);
  }
  function paintFallback() {
    try {
      ask.replaceChildren();
      var h = document.createElement("h2");
      h.id = "ts-fallback";
      h.textContent = tryAgain;
      ask.appendChild(h);
    } catch (e) {}
    showError(tryAgain);
  }
  function paint() {
    var threw = false;
    try { paintScreen(); }
    catch (e) { threw = true; }
    if (form.hidden && !hasScreen() && (threw || flow.state.stage !== "abandoned")) paintFallback();
  }
  function setBusy(on) {
    pending = on;
    var nodes = app.querySelectorAll("button,input");
    for (var i = 0; i < nodes.length; i++) nodes[i].disabled = on;
  }
  function showError(message) {
    if (!error) return;
    error.hidden = !message;
    error.textContent = message || "";
  }
  function runStep(work) {
    if (pending) return;
    showError("");
    setBusy(true);
    Promise.resolve().then(work).then(function (result) {
      setBusy(false);
      if (result && result.ok) form.hidden = true;
      paint();
      if (result && result.ok === false) {
        if (result.error === "contact_required") {
          var need = "Name, address, phone, and email are required.";
          if (publicForm) showError(need);
          else summary.textContent = need;
        }
        else showError(tryAgain);
      }
    }, function () {
      setBusy(false);
      showError(tryAgain);
      paint();
    });
  }
  form.onsubmit = function (e) {
    e.preventDefault();
    var data = new FormData(form);
    var box = form.querySelector('input[name="consent"]');
    runStep(function () {
      return flow.submitContact({ name: data.get("name"), address: data.get("address"), phone: data.get("phone"), email: data.get("email"), consent: !!(box && box.checked) });
    });
  };
  armGtm(api.CONFIG.gtm_id || api.TRACKING.gtm_id);
  function armGtm(id) {
    if (!id || id === "GTM-PLACEHOLDER") return;
    var started = false;
    function load() {
      if (started) return;
      started = true;
      globalThis.dataLayer = globalThis.dataLayer || [];
      globalThis.dataLayer.push({ "gtm.start": Date.now(), event: "gtm.js" });
      var s = document.createElement("script");
      s.async = true;
      s.src = "https://www.googletagmanager.com/gtm.js?id=" + encodeURIComponent(id);
      document.head.appendChild(s);
    }
    addEventListener("pointerdown", load, { once: true, passive: true });
    addEventListener("keydown", load, { once: true, passive: true });
  }
  function safeStore(store) {
    try {
      var key = "__fsho_probe";
      store.setItem(key, "1");
      store.removeItem(key);
      return store;
    } catch (e) { return api.memoryStorage(); }
  }
}

