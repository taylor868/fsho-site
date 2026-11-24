"use strict";
/* Address-first form (Andrew + Taylor, Nov 23, 2026):
   Step 1 address -> Step 2 contact + required consent -> Step 3 qualifying questions -> thanks.
   The only conversion (seller_form_completed, which GTM maps to Google Ads / GA4 generate_lead, and the
   WhatConverts form lead) fires after contact AND the qualifying questions. Address-only partials go to
   the producer as op "park_address" with full attribution and never count. No network: every fetch is a stub. */

const assert = require("node:assert/strict");
const test = require("node:test");
const flow = require("./two-stage.js");
const producer = require("../netlify/functions/intake-producer.js");

const ADDRESS = "100 Example Ave, Springfield, IL 62701";
const CONTACT = { name: "ZZTEST Address First", phone: "5550100199", email: "zztest.address@example.com", consent: true };
const SEARCH = "?gclid=TeSt-GcLiD_1&utm_source=google&utm_medium=cpc&utm_campaign=hot_markets&utm_term=we+buy+houses";

function memory() {
  const data = Object.create(null);
  return { getItem: (k) => (k in data ? data[k] : null), setItem: (k, v) => { data[k] = String(v); }, removeItem: (k) => { delete data[k]; } };
}

function session(opts) {
  opts = opts || {};
  const adapter = opts.adapter || flow.createMockAdapter();
  const tag = { loaded: false, load() { this.loaded = true; } };
  const dataLayer = [];
  const wcCalls = [];
  const s = flow.createFlow(adapter, tag, {
    search: SEARCH,
    localStorage: memory(),
    sessionStorage: memory(),
    dataLayer,
    publicForm: true,
    wcFormSetId: "209270",
    wcHost: { $wc_leads: { track: { form(id, fields) { wcCalls.push({ id, fields }); } } } },
    page: { href: "https://fsho.co/" + SEARCH, path: "/" + SEARCH, hostname: "fsho.co", referrer: "https://www.google.com/", now: 1700000000000 }
  });
  return { s, adapter, tag, dataLayer, wcCalls };
}

const events = (dl) => dl.map((e) => e.event);
const CONVERSION = "seller_form_completed";

test("the flow starts on the address step", () => {
  const { s } = session();
  assert.equal(s.state.stage, "address");
});

test("Step 1 address-only: saves a partial with full attribution and fires no event, tag, or WhatConverts", () => {
  const { s, adapter, tag, dataLayer, wcCalls } = session();
  const res = s.submitAddress({ address: "  " + ADDRESS + "  " });
  assert.equal(res.ok, true);
  assert.equal(s.state.stage, "contact");
  assert.equal(s.state.address, ADDRESS);
  assert.deepEqual(dataLayer, [], "no dataLayer push of any kind on the address step");
  assert.equal(tag.loaded, false);
  assert.equal(s.state.googleTagFired, false);
  assert.equal(s.state.conversionFired, false);
  assert.equal(wcCalls.length, 0);
  const parks = adapter.log.filter((r) => r.op === "park_address");
  assert.equal(parks.length, 1);
  const row = parks[0].row;
  assert.equal(parks[0].google, false);
  assert.equal(row.address, ADDRESS);
  assert.equal(row.stage, "address");
  assert.equal(row.status, "address_only");
  assert.equal(row.gclid, "TeSt-GcLiD_1");
  assert.equal(row.utm_source, "google");
  assert.equal(row.utm_medium, "cpc");
  assert.equal(row.utm_campaign, "hot_markets");
  assert.equal(row.utm_term, "we buy houses");
  assert.match(row.lead_id, /^[0-9a-f-]{36}$/);
  assert.equal(row.touch.lead_id, row.lead_id);
  assert.equal(row.touch.visits[0].h, "https://fsho.co/" + SEARCH, "landing page rides on the partial");
  assert.equal(row.touch.visits[0].r, "https://www.google.com/");
  assert.equal(row.name, undefined);
  assert.equal(row.phone, undefined);
  assert.equal(row.email, undefined);
  assert.ok(!adapter.log.some((r) => r.op === "park" || r.op === "reserve" || r.op === "claim"));
});

test("Step 1 rejects a blank or too-short address and stays put", () => {
  const { s, adapter } = session();
  assert.deepEqual(s.submitAddress({ address: " " }), { ok: false, error: "address_required" });
  assert.deepEqual(s.submitAddress("ab"), { ok: false, error: "address_required" });
  assert.deepEqual(s.submitAddress("x".repeat(201)), { ok: false, error: "address_required" });
  assert.equal(s.state.stage, "address");
  assert.equal(adapter.log.length, 0);
});

test("a failed or thrown address save never blocks the visitor and still fires nothing", async () => {
  for (const parkAddress of [
    () => ({ ok: false, http: 503, status: "edge_unavailable" }),
    () => { throw new Error("down"); },
    () => Promise.reject(new Error("down")),
    () => Promise.resolve({ ok: false, http: 400, status: "bad_input", fields: ["full_name", "phone", "email"] })
  ]) {
    const adapter = flow.createMockAdapter();
    adapter.parkAddress = parkAddress;
    const { s, dataLayer } = session({ adapter });
    const res = await s.submitAddress(ADDRESS);
    assert.equal(res.ok, true);
    assert.equal(s.state.stage, "contact");
    assert.equal(s.state.addressParked, false);
    assert.deepEqual(dataLayer, []);
  }
});

test("Back from Step 2 edits the address; only before the contact park", () => {
  const { s, adapter } = session();
  assert.equal(s.editAddress().ok, false);
  s.submitAddress(ADDRESS);
  assert.equal(s.editAddress().ok, true);
  assert.equal(s.state.stage, "address");
  s.submitAddress("200 Other St, Springfield, IL");
  assert.equal(adapter.log.filter((r) => r.op === "park_address").length, 2);
  s.submitContact(CONTACT);
  assert.equal(s.editAddress().ok, false);
  const park = adapter.log.find((r) => r.op === "park");
  assert.equal(park.row.address, "200 Other St, Springfield, IL");
});

test("Step 2 contact parks with the Step 1 address and is still not a conversion", () => {
  const { s, adapter, tag, dataLayer, wcCalls } = session();
  s.submitAddress(ADDRESS);
  assert.deepEqual(s.submitContact({ name: "", phone: CONTACT.phone, email: CONTACT.email }).error, "contact_required");
  assert.equal(s.state.stage, "contact");
  const res = s.submitContact(CONTACT);
  assert.equal(res.ok, true);
  assert.equal(s.state.stage, "q_type");
  const park = adapter.log.find((r) => r.op === "park");
  assert.equal(park.row.address, ADDRESS);
  assert.equal(park.row.name, CONTACT.name);
  assert.equal(park.row.consent, true);
  assert.equal(park.row.gclid, "TeSt-GcLiD_1");
  assert.ok(!events(dataLayer).includes(CONVERSION), "no conversion after contact only");
  assert.deepEqual(events(dataLayer), ["seller_form_partial"], "only the reporting-only partial");
  assert.equal(tag.loaded, false);
  assert.equal(s.state.conversionFired, false);
  assert.equal(wcCalls.length, 0);
});

test("the conversion fires once, only after contact AND the qualifying questions", async () => {
  const { s, tag, dataLayer, wcCalls, adapter } = session();
  s.submitAddress(ADDRESS);
  assert.ok(!events(dataLayer).includes(CONVERSION));
  s.submitContact(CONTACT);
  assert.ok(!events(dataLayer).includes(CONVERSION));
  await s.answer("type", "sfh");
  assert.ok(!events(dataLayer).includes(CONVERSION), "no conversion after property type alone");
  assert.equal(tag.loaded, false);
  assert.equal(wcCalls.length, 0);
  await s.answer("ownership", "sole_owner");
  assert.deepEqual(events(dataLayer), ["seller_form_partial", CONVERSION]);
  const conv = dataLayer.find((e) => e.event === CONVERSION);
  assert.equal(conv.transaction_id, s.state.leadId);
  assert.equal(conv.gclid, "TeSt-GcLiD_1");
  assert.equal(tag.loaded, true);
  assert.equal(wcCalls.length, 1, "one WhatConverts lead, after the questions");
  assert.equal(wcCalls[0].fields["Street Address"], ADDRESS);
  assert.equal(wcCalls[0].fields["Ownership"], "sole_owner");
  const order = adapter.log.map((r) => r.op).filter((op) => ["park_address", "park", "answer", "claim", "reserve"].includes(op));
  assert.deepEqual(order.slice(0, 2), ["park_address", "park"]);
  assert.ok(order.indexOf("reserve") > order.indexOf("park"));
  // optional follow-ups never fire it again
  for (let i = 0; i < 4; i++) await s.skip();
  assert.equal(events(dataLayer).filter((e) => e === CONVERSION).length, 1);
});

test("non-owner and quiet property exits never convert after the address-first steps", async () => {
  for (const [type, owner] of [["sfh", "no"], ["land", null], ["mobile", null]]) {
    const { s, dataLayer, wcCalls, tag } = session();
    s.submitAddress(ADDRESS);
    s.submitContact(CONTACT);
    await s.answer("type", type);
    if (owner) await s.answer("ownership", owner);
    assert.ok(!events(dataLayer).includes(CONVERSION), type + "/" + owner);
    assert.equal(wcCalls.length, 0);
    assert.equal(tag.loaded, false);
  }
});

test("abandon after Step 1 or Step 2 sends nothing to Google", () => {
  const a = session();
  a.s.submitAddress(ADDRESS);
  assert.deepEqual(a.dataLayer, []);
  const b = session();
  b.s.submitAddress(ADDRESS);
  b.s.submitContact(CONTACT);
  b.s.abandon();
  assert.ok(!events(b.dataLayer).includes(CONVERSION));
});

test("the producer-mode adapter posts op park_address with the address and attribution only", async () => {
  const calls = [];
  const adapter = flow.createRealAdapter({
    mode: "producer",
    baseUrl: "/.netlify/functions/intake-producer",
    transport: (url, init) => { calls.push({ url, body: JSON.parse(init.body) }); return Promise.resolve({ status: 200, headers: { get() { return ""; } }, json: () => Promise.resolve({ ok: true, status: "address_held" }) }); }
  });
  const { s } = session({ adapter });
  await s.submitAddress(ADDRESS);
  assert.equal(calls.length, 1);
  const body = calls[0].body;
  assert.equal(calls[0].url, "/.netlify/functions/intake-producer");
  assert.equal(body.op, "park_address");
  assert.equal(body.address_line, ADDRESS);
  assert.equal(body.is_test, false);
  assert.equal(body.gclid, "TeSt-GcLiD_1");
  assert.equal(body.utm_campaign, "hot_markets");
  assert.ok(body.lead_id);
  assert.equal(body.touch.visits[0].h, "https://fsho.co/" + SEARCH);
  for (const k of ["full_name", "phone", "email", "consent", "name"]) assert.equal(body[k], undefined, k);
  assert.equal(s.state.addressParked, true);
});

/* ---------- Netlify producer function ---------- */

function producerDeps(capture, extraEnv) {
  const env = Object.assign({
    INTAKE_HMAC_KEY_V1: "dummy-hmac-key",
    INTAKE_HMAC_KID: "kid-test",
    INTAKE_EDGE_BASE_URL: "https://edge.example.test/functions/v1",
    INTAKE_ZAP_HOOK_URL: "https://hooks.example.test/catch"
  }, extraEnv || {});
  const fetchImpl = async (url, init) => {
    const target = String(url);
    if (/zapier\.com|supabase\.co|whatconverts|fsho\.co|fairandsimplehomeoffer\.com/i.test(target)) throw new Error("live call blocked");
    const body = init && init.body ? JSON.parse(init.body) : {};
    capture.push({ url: target, body });
    const json = (status, payload) => ({ status, headers: { get() { return ""; } }, json: async () => payload });
    if (target.endsWith("/mint")) return json(200, { ok: true, intake_id: "11111111-1111-4111-8111-111111111111", session_binding: "22222222-2222-4222-8222-222222222222", kid: "kid-test" });
    if (target.endsWith("/reserve")) return json(200, { ok: true, status: "dispatch_intended_committed", reservation_id: "44444444-4444-4444-8444-444444444444", reservation_generation: 1 });
    return json(200, { ok: true, status: target.endsWith("/park") ? "parked" : "saved" });
  };
  return { env, fetch: fetchImpl, now: () => 1700000000000, retryMs: 0 };
}

async function steps(list, extraEnv) {
  const capture = [];
  const deps = producerDeps(capture, extraEnv);
  let jar = "";
  const responses = [];
  for (const step of list) {
    const res = await producer.handle({ httpMethod: "POST", headers: { cookie: jar, "x-nf-client-connection-ip": "203.0.113.7" }, body: JSON.stringify(step) }, deps);
    const next = String(res.headers["set-cookie"] || "").split(";")[0];
    if (next) jar = next;
    responses.push({ status: res.statusCode, body: JSON.parse(res.body) });
  }
  return { capture, responses };
}

const PARK_ADDRESS = { op: "park_address", address_line: ADDRESS, is_test: false, gclid: "TeSt-GcLiD_1", utm_source: "google", utm_campaign: "hot_markets", lead_id: "lead-abc_123" };
const PARK_CONTACT = { op: "park", full_name: CONTACT.name, phone: CONTACT.phone, email: CONTACT.email, consent: true, is_test: false, lead_id: "lead-abc_123" };

test("producer: park_address with the flag off holds the address (no edge, no CRM, no hook) and rides on the contact park", async () => {
  const { capture, responses } = await steps([PARK_ADDRESS, PARK_CONTACT]);
  assert.equal(responses[0].status, 200);
  assert.deepEqual(responses[0].body, { ok: true, status: "address_held" });
  assert.equal(capture.filter((c) => c.url.includes("/intake-park/") || c.url.endsWith("/mint")).length >= 1, true);
  // first request made no network call at all
  const firstParkIdx = capture.findIndex((c) => c.url.endsWith("/intake-park/park"));
  assert.equal(capture[0].url.endsWith("/mint"), true, "mint happens on the contact park, not the address step");
  const park = capture[firstParkIdx].body.payload;
  assert.equal(park.address_line, ADDRESS, "held Step 1 address used when Step 2 omits it");
  assert.equal(park.full_name, CONTACT.name);
  assert.equal(park.phone, CONTACT.phone);
  assert.equal(park.gclid, "TeSt-GcLiD_1", "Step 1 attribution sticks");
  assert.equal(park.utm_campaign, "hot_markets");
  assert.equal(park.partial, undefined);
  assert.ok(!capture.some((c) => c.url.includes("hooks.example.test")), "no Zap hook on address or contact");
  assert.equal(responses[1].status, 200);
});

test("producer: park_address with INTAKE_ADDRESS_PARTIALS=1 parks an address-only row, then the contact park reuses the intake", async () => {
  const { capture, responses } = await steps([PARK_ADDRESS, PARK_CONTACT], { INTAKE_ADDRESS_PARTIALS: "1" });
  assert.equal(responses[0].status, 200);
  const parks = capture.filter((c) => c.url.endsWith("/intake-park/park"));
  assert.equal(parks.length, 2);
  const first = parks[0].body;
  assert.equal(first.payload.partial, "address");
  assert.equal(first.payload.address_line, ADDRESS);
  assert.equal(first.payload.client_ip, "203.0.113.7");
  assert.equal(first.payload.gclid, "TeSt-GcLiD_1");
  assert.equal(first.payload.utm_source, "google");
  assert.equal(first.payload.lead_id, "lead-abc_123");
  for (const k of ["full_name", "phone", "email"]) assert.equal(first.payload[k], undefined, k);
  assert.equal(first.envelope.stage, "partial");
  assert.equal(first.session_binding, "22222222-2222-4222-8222-222222222222");
  const second = parks[1].body;
  assert.equal(second.envelope.intake_id, first.envelope.intake_id, "same intake: the server upsert fills contact on the address-only row");
  assert.equal(second.payload.full_name, CONTACT.name);
  assert.equal(second.payload.address_line, ADDRESS);
  assert.equal(capture.filter((c) => c.url.endsWith("/mint")).length, 1);
  assert.ok(!capture.some((c) => c.url.includes("hooks.example.test")));
});

test("producer: park_address validates the address and attribution", async () => {
  for (const env of [{}, { INTAKE_ADDRESS_PARTIALS: "1" }]) {
    const bad = await steps([{ op: "park_address", address_line: "x" }], env);
    assert.equal(bad.responses[0].status, 400);
    assert.deepEqual(bad.responses[0].body.fields, ["address_line"]);
    const badTrack = await steps([{ op: "park_address", address_line: ADDRESS, gclid: "bad gclid!" }], env);
    assert.equal(badTrack.responses[0].status, 400);
    const badTest = await steps([{ op: "park_address", address_line: ADDRESS, is_test: "yes" }], env);
    assert.equal(badTest.responses[0].status, 400);
  }
});

/* ---------- Public page: the three steps in the browser shell ---------- */

function node(tag) {
  return {
    tagName: tag, id: "", hidden: false, disabled: false, className: "", type: "", textContent: "", value: "", required: false, checked: false,
    dataset: {}, attributes: {}, childNodes: [], parentNode: null, onclick: null, onsubmit: null, listeners: {},
    getAttribute(n) { return n in this.attributes ? this.attributes[n] : null; },
    setAttribute(n, v) { this.attributes[n] = String(v); },
    addEventListener(n, fn) { (this.listeners[n] = this.listeners[n] || []).push(fn); },
    appendChild(c) { this.childNodes.push(c); c.parentNode = this; return c; },
    replaceChildren() { this.childNodes.length = 0; },
    focus() { this.focused = true; },
    querySelector(sel) { return all(this, sel)[0] || null; },
    querySelectorAll(sel) { return all(this, sel); }
  };
}
function all(n, sel) {
  const out = [];
  (n.childNodes || []).forEach((c) => {
    if (sel === "button,input" && (c.tagName === "button" || c.tagName === "input")) out.push(c);
    const named = /^input\[name="([^"]+)"\]$/.exec(sel);
    if (named && c.tagName === "input" && c.getAttribute("name") === named[1]) out.push(c);
    if (sel === ".consent-err" && c.className === "consent-err") out.push(c);
    out.push(...all(c, sel));
  });
  return out;
}
function text(n) { let t = n.textContent || ""; (n.childNodes || []).forEach((c) => { t += " " + text(c); }); return t; }
async function settle() { for (let i = 0; i < 40; i++) await new Promise((r) => setImmediate(r)); }

function steppedDocument() {
  const byId = {};
  const mk = (id, tag, parent) => { const n = node(tag); if (id) { n.id = id; byId[id] = n; } if (parent) parent.appendChild(n); return n; };
  const app = mk("ts-app", "div"); app.setAttribute("data-public", "1");
  const form = mk("ts-form", "form", app);
  const prog = mk("ts-prog", "p", form);
  const s1 = mk("ts-s1", "fieldset", form);
  const address = mk("", "input", s1); address.setAttribute("name", "address"); address.required = true;
  mk("", "button", s1).type = "submit";
  const s2 = mk("ts-s2", "fieldset", form); s2.hidden = true; s2.disabled = true;
  mk("ts-addr-echo", "b", s2);
  const back = mk("ts-back", "button", s2); back.type = "button";
  const inputs = {};
  for (const name of ["name", "phone", "email"]) { const i = mk("", "input", s2); i.setAttribute("name", name); i.required = true; inputs[name] = i; }
  const consent = mk("", "input", s2); consent.setAttribute("name", "consent"); consent.type = "checkbox"; consent.required = true;
  const err = mk("consent-err", "p", s2); err.className = "consent-err";
  mk("", "button", s2).type = "submit";
  const ui = { app, form, prog, s1, s2, address, back, consent, err, inputs };
  for (const id of ["ts-ask", "ts-sorry", "ts-followup", "ts-thanks", "ts-error", "ts-summary", "ts-events", "ts-trace"]) ui[id] = mk(id, id === "ts-trace" ? "ol" : "div", app);
  ui.doc = { body: node("body"), head: node("head"), createElement: node, getElementById: (id) => byId[id] || null };
  return ui;
}

async function withStepped(fn) {
  const keys = ["document", "location", "localStorage", "sessionStorage", "addEventListener", "fetch", "FormData", "FSHO_USE_REAL_ADAPTER", "dataLayer"];
  const prev = {}; keys.forEach((k) => { prev[k] = global[k]; });
  const ui = steppedDocument();
  const ops = [];
  global.document = ui.doc;
  global.location = { search: SEARCH, pathname: "/", href: "https://fsho.co/" + SEARCH, hostname: "fsho.co" };
  global.localStorage = memory();
  global.sessionStorage = memory();
  global.addEventListener = () => {};
  global.dataLayer = [];
  global.FormData = class { constructor(f) { this.f = f; } get(n) { const i = all(this.f, "button,input").find((x) => x.tagName === "input" && x.getAttribute("name") === n); return i ? i.value : null; } };
  global.FSHO_USE_REAL_ADAPTER = "1";
  global.fetch = (url, init) => {
    const body = JSON.parse(init.body);
    ops.push(body);
    const res = (status, b) => Promise.resolve({ status, headers: { get() { return ""; } }, json: () => Promise.resolve(b) });
    if (body.op === "park_address") return res(200, { ok: true, status: "address_held" });
    if (body.op === "park") return res(200, { ok: true, status: "parked" });
    if (body.op === "claim") return res(200, { ok: true, claimed: true, tier: "hot", status: "claimed", priority_tier: null });
    if (body.op === "reserve") return res(200, { ok: true, status: "reserved" });
    return res(200, { ok: true, status: "saved" });
  };
  const resolved = require.resolve("./two-stage.js");
  delete require.cache[resolved];
  require("./two-stage.js");
  try { await fn(ui, ops, global.dataLayer); }
  finally { delete require.cache[resolved]; keys.forEach((k) => { global[k] = prev[k]; }); }
}

function choice(ui, v) { return all(ui["ts-ask"], "button,input").find((b) => b.tagName === "button" && b.dataset.v === v); }

test("public page: Step 1 shows only the address, Step 2 contact + consent, Step 3 questions; conversion only at the end", async () => {
  await withStepped(async (ui, ops, dl) => {
    assert.equal(ui.s1.hidden, false);
    assert.equal(ui.s2.hidden, true);
    assert.equal(ui.s2.disabled, true, "Step 2 required fields are disabled so they cannot block Step 1");
    assert.match(ui.prog.textContent, /Step 1 of 3/);
    // blank address
    ui.form.onsubmit({ preventDefault() {} });
    await settle();
    assert.equal(ui.s1.hidden, false);
    assert.match(ui["ts-error"].textContent, /property address/);
    assert.equal(ops.length, 0);
    // Step 1
    ui.address.value = ADDRESS;
    ui.form.onsubmit({ preventDefault() {} });
    await settle();
    assert.deepEqual(ops.map((o) => o.op), ["park_address"]);
    assert.equal(ops[0].address_line, ADDRESS);
    assert.equal(ops[0].gclid, "TeSt-GcLiD_1");
    assert.equal(ui.form.hidden, false);
    assert.equal(ui.s1.hidden, true);
    assert.equal(ui.s2.hidden, false);
    assert.equal(ui.s2.disabled, false);
    assert.match(ui.prog.textContent, /Step 2 of 3/);
    assert.equal(ui.doc.getElementById("ts-addr-echo").textContent, ADDRESS);
    assert.equal(ui.inputs.name.focused, true);
    assert.deepEqual(dl.filter((e) => e.event && e.event !== "gtm.js"), [], "nothing on the dataLayer after Step 1");
    // Step 2 without consent: blocked, nothing sent
    ui.inputs.name.value = CONTACT.name; ui.inputs.phone.value = CONTACT.phone; ui.inputs.email.value = CONTACT.email;
    ui.form.onsubmit({ preventDefault() {} });
    await settle();
    assert.deepEqual(ops.map((o) => o.op), ["park_address"]);
    assert.equal(ui.consent.getAttribute("aria-invalid"), "true");
    assert.match(ui.err.textContent, /check the box/);
    assert.equal(ui.consent.focused, true);
    // Step 2 with consent
    ui.consent.checked = true;
    ui.form.onsubmit({ preventDefault() {} });
    await settle();
    assert.deepEqual(ops.map((o) => o.op), ["park_address", "park"]);
    assert.equal(ops[1].address_line, ADDRESS);
    assert.equal(ops[1].consent, true);
    assert.equal(ui.form.hidden, true);
    assert.match(text(ui["ts-ask"]), /Step 3 of 3/);
    assert.match(text(ui["ts-ask"]), /What kind of property is it\?/);
    assert.ok(!dl.some((e) => e.event === CONVERSION), "no conversion after contact");
    // Step 3
    choice(ui, "sfh").onclick();
    await settle();
    assert.ok(!dl.some((e) => e.event === CONVERSION), "no conversion after Q1");
    choice(ui, "sole_owner").onclick();
    await settle();
    assert.equal(dl.filter((e) => e.event === CONVERSION).length, 1, "conversion after the qualifying questions");
    assert.match(text(ui["ts-ask"]), /Optional 1 of 4/);
  });
});

test("public page: Edit goes back to the address step", async () => {
  await withStepped(async (ui, ops) => {
    ui.address.value = ADDRESS;
    ui.form.onsubmit({ preventDefault() {} });
    await settle();
    ui.back.onclick();
    assert.equal(ui.s1.hidden, false);
    assert.equal(ui.s2.hidden, true);
    assert.equal(ui.s2.disabled, true);
    assert.equal(ui.address.focused, true);
    ui.address.value = "200 Other St";
    ui.form.onsubmit({ preventDefault() {} });
    await settle();
    assert.deepEqual(ops.map((o) => o.address_line), [ADDRESS, "200 Other St"]);
  });
});
