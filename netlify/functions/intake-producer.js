"use strict";

// Signs edge calls with HMAC-SHA256 over canonicalLines from edge/envelope.ts.
// The line order is fixed: v, kid, route, channel, intake_id, event_id, stage, ts, exp, payload_sha256.
// payload_sha256 is SHA-256 of canonical JSON (sorted keys, no spaces).
// session_binding is sent only on park and reserve. Answer, claim, and enrich are {envelope, payload}.
// A 503 on enrich is retried once. A Catch Hook failure is retried once, then reconciled.

const crypto = require("crypto");

const CLICKS = ["gclid", "gbraid", "wbraid", "fbclid"];
const EXTRA_CLICKS = ["msclkid", "ttclid", "li_fat_id"];
const UTMS = ["utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content", "utm_id"];
const VALUE_TRACK = ["campaignid", "adgroupid", "keyword", "matchtype", "network", "device", "creative", "placement", "loc_physical_ms", "gad_source"];
const SIGNALS = CLICKS.concat(EXTRA_CLICKS, UTMS, VALUE_TRACK);
const TRACK_KEYS = CLICKS.concat(UTMS).concat(["lead_id"]);
const CLICK_MAX = 256;
const TEXT_MAX = 200;
const URL_MAX = 500;
const PATH_MAX = 180;
const HOST_MAX = 253;
const COOKIE_MAX = 200;
const COOKIE_BUDGET = 3600;
const HOOK_CONTEXT_KEYS = [
  "attr_landing_page", "attr_ft_landing_page", "attr_lt_landing_page",
  "attr_landing_path", "attr_ft_landing_path", "attr_lt_landing_path",
  "attr_hostname", "attr_ft_hostname", "attr_lt_hostname",
  "attr_referrer", "attr_ft_referrer", "attr_lt_referrer",
  "attr_first_seen", "attr_last_seen",
  "attr_submit_path", "attr_submit_hostname", "attr_submit_ts",
  "attr_device", "attr_lead_id", "attr_transaction_id",
  "attr_ga_client_id", "attr_gcl_aw", "attr_gcl_gb", "attr_fbp", "attr_fbc"
];
const HOOK_ATTR_KEYS = SIGNALS.reduce((keys, key) => {
  if (key !== "device") keys.push("attr_" + key);
  keys.push("attr_ft_" + key);
  keys.push("attr_lt_" + key);
  return keys;
}, []).concat(HOOK_CONTEXT_KEYS);
const CLICK_RE = /^[A-Za-z0-9._~-]{1,256}$/;
const UTM_RE = /^[^\u0000-\u001f\u007f<>]{1,200}$/;
const LEAD_RE = /^[A-Za-z0-9_-]{1,64}$/;
const ANSWER_RE = /^[a-z0-9_]{1,64}$/;
const QUESTIONS = { type: 1, ownership: 1, timeline: 1, situation: 1, equity: 1, ability: 1 };
const ENRICH = {
  occupancy: { owner_occupied: 1, tenant_occupied: 1, vacant: 1, unknown: 1 },
  condition: { excellent: 1, good: 1, fair: 1, needs_work: 1, major_repairs: 1 },
  listed: { not_listed: 1, listed_under_90: 1, listed_over_90: 1, expired: 1 },
  timeline: { asap: 1, "30d": 1, "30_90d": 1, over_90d: 1, no_rush: 1 }
};
const COOKIE = "fsho_intake";

function canonicalJson(value, depth) {
  if (value === null) return "null";
  const kind = typeof value;
  if (kind === "number") {
    if (!Number.isFinite(value) || Math.floor(value) !== value) throw new Error("canonical_number");
    return String(value);
  }
  if (kind === "boolean") return value ? "true" : "false";
  if (kind === "string") return JSON.stringify(value);
  const level = depth || 0;
  if (level > 32) throw new Error("canonical_depth");
  if (Array.isArray(value)) return "[" + value.map((item) => canonicalJson(item, level + 1)).join(",") + "]";
  const keys = Object.keys(value).filter((key) => value[key] !== undefined).sort();
  return "{" + keys.map((key) => JSON.stringify(key) + ":" + canonicalJson(value[key], level + 1)).join(",") + "}";
}

const LINE_ORDER = ["v", "kid", "route", "channel", "intake_id", "event_id", "stage", "ts", "exp", "payload_sha256"];

function canonicalLines(fields) {
  return LINE_ORDER.map((key) => key + "=" + (fields[key] == null ? "" : String(fields[key]))).join("\n");
}

function stripControls(value) {
  return String(value == null ? "" : value).replace(/[\u0000-\u001f\u007f]/g, "").slice(0, 200);
}

function sha256(text) {
  return crypto.createHash("sha256").update(text).digest("hex");
}

function signFields(fields, key) {
  return crypto.createHmac("sha256", key).update(canonicalLines(fields)).digest("hex");
}

function isIp(value) {
  if (typeof value !== "string") return false;
  const ip = value.trim();
  if (!ip || ip.length > 45 || ip.indexOf("%") >= 0 || ip.indexOf("/") >= 0) return false;
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(ip)) {
    return ip.split(".").every((part) => {
      if (part.length > 1 && part[0] === "0") return false;
      const n = Number(part);
      return n >= 0 && n <= 255;
    });
  }
  if (ip.indexOf(":") < 0 || ip.indexOf(".") >= 0) return false;
  if (!/^[0-9a-fA-F:]+$/.test(ip)) return false;
  return ip.split("::").length <= 2;
}

function clientIp(headers) {
  const raw = headers["x-nf-client-connection-ip"] || headers["X-NF-Client-Connection-IP"] || "";
  const ip = String(raw).split(",")[0].trim();
  return isIp(ip) ? ip : "";
}

function cookies(header) {
  const out = {};
  String(header || "").split(";").forEach((part) => {
    const cut = part.indexOf("=");
    if (cut > 0) out[part.slice(0, cut).trim()] = decodeURIComponent(part.slice(cut + 1).trim());
  });
  return out;
}

function cookieKey(env) {
  if (env && env.INTAKE_COOKIE_KEY) return crypto.createHash("sha256").update(String(env.INTAKE_COOKIE_KEY), "utf8").digest();
  return crypto.hkdfSync("sha256", Buffer.from(String(env.INTAKE_HMAC_KEY_V1), "utf8"), Buffer.alloc(0), Buffer.from("fsho-intake-cookie-v1", "utf8"), 32);
}

function seal(obj, key) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const body = Buffer.concat([cipher.update(JSON.stringify(obj), "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, body]).toString("base64url");
}

function open(token, key) {
  try {
    const buf = Buffer.from(String(token || ""), "base64url");
    if (buf.length < 29) return null;
    const iv = buf.subarray(0, 12);
    const tag = buf.subarray(12, 28);
    const body = buf.subarray(28);
    const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAuthTag(tag);
    const json = Buffer.concat([decipher.update(body), decipher.final()]).toString("utf8");
    const obj = JSON.parse(json);
    return obj && typeof obj === "object" ? obj : null;
  } catch (e) {
    return null;
  }
}

function cookieHeader(token) {
  return COOKIE + "=" + token + "; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=86400";
}

function bad(status, body, extra) {
  return {
    statusCode: status,
    headers: Object.assign({ "content-type": "application/json" }, extra || {}),
    body: JSON.stringify(body)
  };
}

function trackingErrors(input) {
  const fields = [];
  const out = {};
  CLICKS.forEach((key) => {
    if (input[key] == null || input[key] === "") return;
    if (typeof input[key] === "string" && CLICK_RE.test(input[key])) out[key] = input[key];
    else fields.push(key);
  });
  UTMS.forEach((key) => {
    if (input[key] == null || input[key] === "") return;
    if (typeof input[key] === "string" && UTM_RE.test(input[key])) out[key] = input[key];
    else fields.push(key);
  });
  if (input.lead_id != null && input.lead_id !== "") {
    if (typeof input.lead_id === "string" && LEAD_RE.test(input.lead_id)) out.lead_id = input.lead_id;
    else fields.push("lead_id");
  }
  return { fields, tracking: out };
}

function stick(state, incoming) {
  state.tracking = state.tracking || {};
  TRACK_KEYS.forEach((key) => {
    if (!state.tracking[key] && incoming[key]) state.tracking[key] = incoming[key];
  });
}

function plain(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value;
}

function own(obj, key) {
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return undefined;
  if (!Object.prototype.hasOwnProperty.call(obj, key)) return undefined;
  return obj[key];
}

function cleanText(value, max) {
  if (typeof value !== "string") return "";
  return value.replace(/[\u0000-\u001f\u007f<>]/g, "").trim().slice(0, max);
}

function cleanClick(value) {
  if (typeof value !== "string") return "";
  const trimmed = value.trim();
  if (!/^[A-Za-z0-9._~-]+$/.test(trimmed)) return "";
  return trimmed.slice(0, CLICK_MAX);
}

function cleanUrl(value) {
  const text = cleanText(value, URL_MAX);
  if (!text) return "";
  if (/^[a-z][a-z0-9+.-]*:/i.test(text) && !/^https?:/i.test(text)) return "";
  return text;
}

function cleanPath(value) {
  const text = cleanText(value, PATH_MAX);
  if (!text || text[0] !== "/" || text.indexOf("//") === 0) return "";
  return text;
}

function cleanHost(value) {
  let text = cleanText(value, HOST_MAX).toLowerCase();
  if (!text) return "";
  const colon = text.indexOf(":");
  if (colon >= 0) text = text.slice(0, colon);
  text = text.replace(/\.$/, "");
  if (!/^[a-z0-9.-]{1,253}$/.test(text) || text.indexOf("..") >= 0) return "";
  return text;
}

function cleanDevice(value) {
  const text = cleanText(value, 16).toLowerCase();
  return text === "mobile" || text === "desktop" || text === "tablet" ? text : "";
}

function cleanStamp(value) {
  if (typeof value !== "string") return "";
  const text = value.trim();
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(text) ? text : "";
}

function cleanLead(value) {
  if (typeof value !== "string") return "";
  const text = value.trim();
  return LEAD_RE.test(text) ? text : "";
}

function gaClientId(value) {
  const text = cleanText(value, 80);
  const match = text.match(/(\d+\.\d+)$/);
  return match ? match[1].slice(0, 40) : "";
}

function cleanCookie(value) {
  return cleanText(value, COOKIE_MAX);
}

function signalValue(key, value) {
  if (CLICKS.indexOf(key) >= 0 || EXTRA_CLICKS.indexOf(key) >= 0) return cleanClick(value);
  return cleanText(value, TEXT_MAX);
}

function sanitizeTouch(input) {
  const src = plain(input);
  const ftIn = plain(own(src, "ft"));
  const ltIn = plain(own(src, "lt"));
  const ft = {};
  const lt = {};
  SIGNALS.forEach((key) => {
    const first = signalValue(key, own(ftIn, key));
    const last = signalValue(key, own(ltIn, key));
    if (first) ft[key] = first;
    if (last) lt[key] = last;
  });
  const ctx = {};
  function set(key, value) { if (value) ctx[key] = value; }
  set("landing_page", cleanUrl(own(src, "landing_page")));
  set("landing_path", cleanPath(own(src, "landing_path")));
  set("lt_landing_page", cleanUrl(own(src, "lt_landing_page")));
  set("lt_landing_path", cleanPath(own(src, "lt_landing_path")));
  set("hostname", cleanHost(own(src, "hostname")));
  set("lt_hostname", cleanHost(own(src, "lt_hostname")));
  set("referrer", cleanUrl(own(src, "referrer")));
  set("lt_referrer", cleanUrl(own(src, "lt_referrer")));
  set("first_seen", cleanStamp(own(src, "first_seen")));
  set("last_seen", cleanStamp(own(src, "last_seen")));
  set("submit_path", cleanPath(own(src, "submit_path")));
  set("submit_hostname", cleanHost(own(src, "submit_hostname")));
  set("ua_device", cleanDevice(own(src, "ua_device")));
  set("lead_id", cleanLead(own(src, "lead_id")));
  set("ga_client_id", gaClientId(own(src, "ga_client_id")));
  set("gcl_aw", cleanCookie(own(src, "gcl_aw")));
  set("gcl_gb", cleanCookie(own(src, "gcl_gb")));
  set("fbp", cleanCookie(own(src, "fbp")));
  set("fbc", cleanCookie(own(src, "fbc")));
  return { ft, lt, ctx };
}

function deviceCategory(ua) {
  const text = String(ua || "");
  if (!text) return "";
  if (/iPad|Tablet|PlayBook|Silk|Kindle|Android(?!.*Mobile)/i.test(text)) return "tablet";
  return /Mobi|iPhone|iPod|Windows Phone|IEMobile|webOS|BlackBerry/i.test(text) ? "mobile" : "desktop";
}

function readCookieValue(jar, name) {
  const match = String(jar || "").match(new RegExp("(?:^|;\\s*)" + name + "=([^;]*)"));
  if (!match) return "";
  try { return decodeURIComponent(match[1]); } catch (e) { return match[1]; }
}

function hostFromHref(href) {
  const match = String(href || "").match(/^https?:\/\/([^/?#]+)/i);
  return match ? cleanHost(match[1]) : "";
}

function pathFromHref(href) {
  const match = String(href || "").match(/^https?:\/\/[^/?#]+([^#]*)/i);
  if (!match || !match[1]) return "";
  const path = match[1][0] === "/" ? match[1] : "/" + match[1];
  return cleanPath(path);
}

function touchFromVisits(visits, leadId) {
  const ft = {};
  const lt = {};
  const ctx = {};
  (Array.isArray(visits) ? visits : []).slice(-8).forEach((visit) => {
    const row = plain(visit);
    const query = plain(row.q);
    SIGNALS.forEach((key) => {
      const value = signalValue(key, own(query, key));
      if (!value) return;
      if (!ft[key]) ft[key] = value;
      lt[key] = value;
    });
    const href = cleanUrl(row.h);
    const path = cleanPath(row.p) || pathFromHref(href);
    const host = cleanHost(row.o) || hostFromHref(href);
    const referrer = cleanUrl(row.r);
    if (href && !ctx.landing_page) ctx.landing_page = href;
    if (path && !ctx.landing_path) ctx.landing_path = path;
    if (host && !ctx.hostname) ctx.hostname = host;
    if (referrer && !ctx.referrer) ctx.referrer = referrer;
    if (href) ctx.lt_landing_page = href;
    if (path) ctx.lt_landing_path = path;
    if (host) ctx.lt_hostname = host;
    if (referrer) ctx.lt_referrer = referrer;
    if (path) ctx.submit_path = path;
    if (host) ctx.submit_hostname = host;
    const device = cleanDevice(deviceCategory(row.u));
    if (device) ctx.ua_device = device;
    const stamp = cleanStamp(typeof row.t === "number" && Number.isFinite(row.t) ? new Date(row.t).toISOString() : row.t);
    if (stamp && !ctx.first_seen) ctx.first_seen = stamp;
    if (stamp) ctx.last_seen = stamp;
    const jar = typeof row.c === "string" ? row.c : "";
    const ga = gaClientId(readCookieValue(jar, "_ga"));
    if (ga) ctx.ga_client_id = ga;
    [["_gcl_aw", "gcl_aw"], ["_gcl_gb", "gcl_gb"], ["_fbp", "fbp"], ["_fbc", "fbc"]].forEach((pair) => {
      const value = cleanCookie(readCookieValue(jar, pair[0]));
      if (value) ctx[pair[1]] = value;
    });
  });
  const lead = cleanLead(leadId);
  if (lead) ctx.lead_id = lead;
  return { ft, lt, ctx };
}

function mergeTouch(state, inputTouch) {
  const src = plain(inputTouch);
  const incoming = sanitizeTouch(src);
  if (Array.isArray(src.visits)) {
    const visited = touchFromVisits(src.visits, own(src, "lead_id"));
    SIGNALS.forEach((key) => {
      if (!incoming.ft[key] && visited.ft[key]) incoming.ft[key] = visited.ft[key];
      if (!incoming.lt[key] && visited.lt[key]) incoming.lt[key] = visited.lt[key];
    });
    Object.keys(visited.ctx).forEach((key) => {
      if (!incoming.ctx[key]) incoming.ctx[key] = visited.ctx[key];
    });
  }
  const prev = plain(state.touch);
  const ft = Object.assign({}, plain(prev.ft));
  const lt = Object.assign({}, plain(prev.lt));
  const ctx = Object.assign({}, plain(prev.ctx));
  SIGNALS.forEach((key) => {
    if (!ft[key] && incoming.ft[key]) ft[key] = incoming.ft[key];
    if (incoming.lt[key]) lt[key] = incoming.lt[key];
  });
  ["landing_page", "landing_path", "hostname", "referrer", "first_seen"].forEach((key) => {
    if (!ctx[key] && incoming.ctx[key]) ctx[key] = incoming.ctx[key];
  });
  ["lt_landing_page", "lt_landing_path", "lt_hostname", "lt_referrer", "last_seen", "submit_path", "submit_hostname", "ua_device", "lead_id", "ga_client_id", "gcl_aw", "gcl_gb", "fbp", "fbc"].forEach((key) => {
    if (incoming.ctx[key]) ctx[key] = incoming.ctx[key];
  });
  state.touch = { ft, lt, ctx };
}

function alignTouch(state) {
  const tracking = plain(state.tracking);
  const touch = plain(state.touch);
  const ft = Object.assign({}, plain(touch.ft));
  const ctx = Object.assign({}, plain(touch.ctx));
  CLICKS.concat(UTMS).forEach((key) => {
    if (tracking[key]) ft[key] = tracking[key];
  });
  if (tracking.lead_id) ctx.lead_id = tracking.lead_id;
  state.touch = { ft, lt: plain(touch.lt), ctx };
}

function hookFields(state, jar, nowMs) {
  const out = {};
  HOOK_ATTR_KEYS.forEach((key) => { out[key] = ""; });
  const touch = plain(state && state.touch);
  const ft = plain(touch.ft);
  const lt = plain(touch.lt);
  const ctx = plain(touch.ctx);
  SIGNALS.forEach((key) => {
    const first = typeof ft[key] === "string" ? ft[key] : "";
    const last = typeof lt[key] === "string" && lt[key] ? lt[key] : first;
    if (key !== "device") out["attr_" + key] = first;
    out["attr_ft_" + key] = first;
    out["attr_lt_" + key] = last;
  });
  const landing = ctx.landing_page || "";
  const landingPath = ctx.landing_path || "";
  const host = ctx.hostname || "";
  const referrer = ctx.referrer || "";
  const submitHost = ctx.submit_hostname || ctx.lt_hostname || host;
  out.attr_landing_page = landing;
  out.attr_ft_landing_page = landing;
  out.attr_lt_landing_page = ctx.lt_landing_page || landing;
  out.attr_landing_path = landingPath;
  out.attr_ft_landing_path = landingPath;
  out.attr_lt_landing_path = ctx.lt_landing_path || landingPath;
  out.attr_ft_hostname = host;
  out.attr_lt_hostname = ctx.lt_hostname || host;
  out.attr_hostname = submitHost;
  out.attr_submit_hostname = ctx.submit_hostname || ctx.lt_hostname || host;
  out.attr_referrer = referrer;
  out.attr_ft_referrer = referrer;
  out.attr_lt_referrer = ctx.lt_referrer || referrer;
  out.attr_first_seen = ctx.first_seen || "";
  out.attr_last_seen = ctx.last_seen || "";
  out.attr_submit_path = ctx.submit_path || "";
  out.attr_device = ctx.ua_device || "";
  const lead = (state && state.tracking && state.tracking.lead_id) || ctx.lead_id || "";
  out.attr_lead_id = lead;
  out.attr_transaction_id = lead;
  const cookies = jar || {};
  out.attr_ga_client_id = gaClientId(cookies._ga) || ctx.ga_client_id || "";
  out.attr_gcl_aw = cleanCookie(cookies._gcl_aw) || ctx.gcl_aw || "";
  out.attr_gcl_gb = cleanCookie(cookies._gcl_gb) || ctx.gcl_gb || "";
  out.attr_fbp = cleanCookie(cookies._fbp) || ctx.fbp || "";
  out.attr_fbc = cleanCookie(cookies._fbc) || ctx.fbc || "";
  const ms = typeof nowMs === "number" && Number.isFinite(nowMs) ? nowMs : Date.now();
  out.attr_submit_ts = new Date(ms).toISOString();
  return out;
}

function shrinkTouch(state, env) {
  if (!state || !state.touch) return;
  const size = () => {
    try { return seal(state, cookieKey(env)).length; } catch (e) { return COOKIE_BUDGET + 1; }
  };
  if (size() <= COOKIE_BUDGET) return;
  const ft = plain(state.touch.ft);
  const lt = plain(state.touch.lt);
  const ctx = plain(state.touch.ctx);
  state.touch.ft = ft;
  state.touch.lt = lt;
  state.touch.ctx = ctx;
  const signals = VALUE_TRACK.concat(EXTRA_CLICKS, UTMS, CLICKS);
  for (const key of signals) {
    if (!lt[key]) continue;
    delete lt[key];
    if (size() <= COOKIE_BUDGET) return;
  }
  for (const key of ["gcl_aw", "gcl_gb", "fbp", "fbc", "ga_client_id", "lt_referrer", "referrer", "lt_landing_page", "landing_page", "lt_landing_path", "landing_path", "last_seen"]) {
    if (!ctx[key]) continue;
    delete ctx[key];
    if (size() <= COOKIE_BUDGET) return;
  }
  for (const key of VALUE_TRACK.concat(EXTRA_CLICKS)) {
    if (!ft[key]) continue;
    delete ft[key];
    if (size() <= COOKIE_BUDGET) return;
  }
  state.touch.lt = {};
  if (size() <= COOKIE_BUDGET) return;
  const kept = {};
  CLICKS.forEach((key) => { if (ft[key]) kept[key] = ft[key]; });
  const keptCtx = {};
  if (ctx.first_seen) keptCtx.first_seen = ctx.first_seen;
  if (ctx.hostname) keptCtx.hostname = ctx.hostname;
  if (ctx.submit_hostname) keptCtx.submit_hostname = ctx.submit_hostname;
  state.touch = { ft: kept, lt: {}, ctx: keptCtx };
  if (size() <= COOKIE_BUDGET) return;
  delete state.touch;
}

function banned(input) {
  const found = [];
  function walk(value, depth) {
    if (!value || typeof value !== "object" || depth > 6) return;
    Object.keys(value).forEach((key) => {
      if (key === "attribution" || key === "price_vs_value") found.push(key);
      else walk(value[key], depth + 1);
    });
  }
  walk(input, 0);
  return found;
}

function parkContact(input) {
  const full = typeof input.full_name === "string" ? input.full_name.trim() : "";
  const line = typeof input.address_line === "string" ? input.address_line.trim() : "";
  const phone = String(input.phone || "").replace(/\D/g, "");
  const email = typeof input.email === "string" ? input.email.trim() : "";
  const fields = [];
  if (!full || full.length > 160) fields.push("full_name");
  if (line.length < 3 || line.length > 200) fields.push("address_line");
  if (phone.length < 10 || phone.length > 11) fields.push("phone");
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) || email.length > 200) fields.push("email");
  if (input.is_test != null && typeof input.is_test !== "boolean") fields.push("is_test");
  if (input.consent != null && typeof input.consent !== "boolean") fields.push("consent");
  return { fields, full, line, phone, email };
}

function intakeClosed(state) {
  return !!(state && state.intake_id && (state.zap_sent === true || state.claim_status === "already_claimed"));
}

function enrichmentOf(input) {
  if (input == null) return { fields: ["enrichment"], enrichment: null };
  if (typeof input !== "object" || Array.isArray(input)) return { fields: ["enrichment"], enrichment: null };
  const enrichment = {};
  const fields = [];
  Object.keys(input).forEach((key) => {
    if (!ENRICH[key]) { fields.push("enrichment." + key); return; }
    if (input[key] == null || input[key] === "") return;
    if (typeof input[key] !== "string" || !ENRICH[key][input[key]]) fields.push("enrichment." + key);
    else enrichment[key] = input[key];
  });
  return { fields, enrichment };
}

function envelopeFor(env, state, stage, payload, now) {
  const ts = Math.floor(now() / 1000);
  const fields = {
    v: "1",
    kid: env.INTAKE_HMAC_KID,
    route: "ppc_inhouse",
    channel: "website",
    intake_id: state.intake_id,
    event_id: crypto.randomUUID(),
    stage,
    ts,
    exp: ts + 900,
    payload_sha256: sha256(canonicalJson(payload))
  };
  fields.sig = signFields(fields, env.INTAKE_HMAC_KEY_V1);
  return fields;
}

function publicBody(edge) {
  const out = {};
  ["ok", "status", "tier", "priority_tier", "claimed", "fields", "geocode_status"].forEach((key) => {
    if (edge[key] !== undefined) out[key] = edge[key];
  });
  if (out.status === "late_hot" && (out.tier === "hot" || out.tier == null)) {
    out.status = "claimed";
    out.tier = "hot";
    out.claimed = true;
    out.ok = out.ok !== false;
  }
  return out;
}

function stampHotClaim(out, by) {
  if (!out || typeof out !== "object" || out.ok === false) return out;
  if (out.tier === "hot" || out.tier === "follow_up") return out;
  if (out.status === "already_claimed" || out.status === "not_qualified" || out.status === "not_non_owner" || out.status === "bad_input") return out;
  const priorityHot = out.priority_tier === "p1" || out.priority_tier === "p2" || out.priority_tier === "p3";
  const openClaim = out.status == null || out.status === "" || out.status === "claimed";
  const claimed = out.claimed !== false && (out.status === "claimed" || out.claimed === true);
  if (!(priorityHot || (by === "promote" && claimed && openClaim))) return out;
  out.tier = "hot";
  out.claimed = true;
  out.ok = true;
  if (out.status == null || out.status === "") out.status = "claimed";
  return out;
}

async function readEdge(res) {
  const status = res && res.status ? res.status : 0;
  let body = {};
  try { body = await res.json(); } catch (e) { body = { status: "bad_json" }; }
  if (!body || typeof body !== "object") body = {};
  const retry = res.headers && res.headers.get ? (res.headers.get("retry-after") || "") : "";
  return { status, body, retry };
}

async function handle(event, deps) {
  const env = (deps && deps.env) || process.env;
  const doFetch = deps && deps.fetch;
  const now = (deps && deps.now) || Date.now;
  const method = String((event && event.httpMethod) || "").toUpperCase();
  if (method !== "POST") return bad(405, { ok: false, status: "method_not_allowed" });
  if (!env.INTAKE_HMAC_KEY_V1 || !env.INTAKE_HMAC_KID || !env.INTAKE_EDGE_BASE_URL || !env.INTAKE_ZAP_HOOK_URL || typeof doFetch !== "function") {
    return bad(503, { ok: false, status: "not_configured" });
  }
  let input = {};
  try { input = JSON.parse(event.body || ""); } catch (e) { return bad(400, { ok: false, status: "bad_json" }); }
  if (!input || typeof input !== "object" || Array.isArray(input)) return bad(400, { ok: false, status: "bad_json" });
  const refused = banned(input);
  if (refused.length) return bad(400, { ok: false, status: "bad_input", fields: refused });
  const op = String(input.op || "");
  const ops = { mint: 1, park: 1, answer: 1, claim: 1, enrich: 1, reserve: 1 };
  if (!ops[op]) return bad(404, { ok: false, status: "unknown_op" });
  const headers = event.headers || {};
  const jar = cookies(headers.cookie || headers.Cookie || "");
  const ckey = cookieKey(env);
  let state = open(jar[COOKIE], ckey) || {};
  const base = String(env.INTAKE_EDGE_BASE_URL).replace(/\/$/, "");
  const ip = clientIp(headers);

  async function edge(path, body) {
    let res;
    try {
      res = await doFetch(base + path, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body)
      });
    } catch (e) {
      return { status: 503, body: { ok: false, status: "edge_unavailable" }, retry: "" };
    }
    return readEdge(res);
  }

  async function mint() {
    const minted = await edge("/intake-reserve/mint", {});
    if (minted.status !== 200 || !minted.body.intake_id || !minted.body.session_binding) return minted;
    state.intake_id = minted.body.intake_id;
    state.session_binding = minted.body.session_binding;
    state.kid = minted.body.kid || env.INTAKE_HMAC_KID;
    return minted;
  }

  // A later contact submit on an intake that already reserved or was already claimed
  // starts a new intake. An in-progress intake that has not been reserved stays put.
  // Resume without a new park still uses the closed intake, so thanks can still show.
  if (op === "park" && intakeClosed(state)) {
    const tracked = trackingErrors(input);
    const contact = parkContact(input);
    if (!tracked.fields.length && !contact.fields.length) {
      const previous = state.tracking;
      const touch = state.touch;
      const tracking = previous && typeof previous === "object" && !Array.isArray(previous) ? previous : {};
      state = { tracking: tracking };
      if (touch && typeof touch === "object" && !Array.isArray(touch)) state.touch = touch;
    }
  }

  if (!state.intake_id) {
    const minted = await mint();
    if (!state.intake_id) {
      const fail = publicBody(Object.assign({ ok: false, status: minted.body.status || "not_configured" }, minted.body));
      return bad(minted.status || 503, fail, minted.retry ? { "retry-after": minted.retry } : null);
    }
  }
  if (op === "mint") return respond(env, state, 200, { ok: true, status: "minted" });

  const tracked = trackingErrors(input);
  if (tracked.fields.length) return respond(env, state, 400, { ok: false, status: "bad_input", fields: tracked.fields });
  stick(state, tracked.tracking);
  mergeTouch(state, input.touch);
  alignTouch(state);
  const needsIp = op === "park" || op === "answer" || op === "claim" || op === "enrich";
  if (needsIp && !ip) return respond(env, state, 400, { ok: false, status: "bad_input", fields: ["client_ip"] });

  let payload = Object.assign({}, state.tracking);
  if (needsIp) payload.client_ip = ip;
  if (op === "park") {
    const contact = parkContact(input);
    if (contact.fields.length) return respond(env, state, 400, { ok: false, status: "bad_input", fields: contact.fields });
    payload.full_name = contact.full;
    payload.address_line = contact.line;
    payload.phone = contact.phone;
    payload.email = contact.email;
    // intake-park stores is_test only when the boolean is true (p.is_test === true).
    // false, including when the client omits the flag, is a real lead.
    payload.is_test = input.is_test === true;
    // consent is not an edge column. Unknown park keys are ignored, except attribution and price_vs_value.
    payload.consent = input.consent === true;
    state.contact = { full_name: contact.full, phone: contact.phone, email: contact.email, address_line: contact.line, consent: payload.consent };
  } else if (op === "answer") {
    const fields = [];
    if (!QUESTIONS[input.question]) fields.push("question");
    if (typeof input.answer !== "string" || !ANSWER_RE.test(input.answer)) fields.push("answer");
    if (fields.length) return respond(env, state, 400, { ok: false, status: "bad_input", fields });
    payload.question = input.question;
    payload.answer = input.answer;
  } else if (op === "claim") {
    if (input.by !== "promote" && input.by !== "non_owner") return respond(env, state, 400, { ok: false, status: "bad_input", fields: ["by"] });
    payload.by = input.by;
  } else if (op === "enrich") {
    const checked = enrichmentOf(input.enrichment);
    if (checked.fields.length) return respond(env, state, 400, { ok: false, status: "bad_input", fields: checked.fields });
    payload.enrichment = checked.enrichment;
  } else if (op === "reserve") {
    if (!state.contact) return respond(env, state, 400, { ok: false, status: "bad_input", fields: ["contact"] });
    if (state.zap_sent === true) return respond(env, state, 200, { ok: true, status: "idempotent_replay" });
    payload = Object.assign({}, state.tracking);
  }

  const stage = op === "reserve" ? (input.stage === "first" ? "first" : "final") : "partial";
  const envFields = envelopeFor(env, state, stage, payload, now);
  const edgeBody = { envelope: envFields, payload };
  if (op === "park" || op === "reserve") edgeBody.session_binding = state.session_binding;
  if (op === "reserve") {
    state.owner_token = state.owner_token || crypto.randomUUID();
    edgeBody.destination = input.destination === "crm_update" ? "crm_update" : "crm_create";
    edgeBody.owner_token = state.owner_token;
    edgeBody.lease_seconds = 120;
    state.reserve_stage = stage;
  }
  const path = op === "reserve" ? "/intake-reserve/reserve" : "/intake-park/" + op;
  let result = await edge(path, edgeBody);
  if (op === "enrich" && result.status === 503) {
    await new Promise((resolve) => setTimeout(resolve, deps && deps.retryMs != null ? deps.retryMs : 40));
    result = await edge(path, envelopeRetry(env, state, payload, now));
  }
  const committed = result.body.status === "dispatch_intended_committed" || result.body.status === "idempotent_replay";
  if (op === "reserve" && result.status === 200 && result.body.ok !== false && committed) {
    state.reservation_id = result.body.reservation_id || state.reservation_id || "";
    state.reservation_generation = result.body.reservation_generation || state.reservation_generation || 1;
    if (result.body.owner_token) state.owner_token = result.body.owner_token;
    if (!state.zap_sent) {
      const hookBody = JSON.stringify(Object.assign({
        intake_id: state.intake_id,
        reservation_id: state.reservation_id,
        reservation_generation: state.reservation_generation,
        session_binding: state.session_binding,
        owner_token: state.owner_token,
        full_name: state.contact.full_name,
        phone: state.contact.phone,
        email: state.contact.email,
        address_line: state.contact.address_line,
        consent: state.contact.consent === true
      }, hookFields(state, jar, now())));
      let hook = await postHook(doFetch, env.INTAKE_ZAP_HOOK_URL, hookBody);
      if (!hookOk(hook)) hook = await postHook(doFetch, env.INTAKE_ZAP_HOOK_URL, hookBody);
      if (!hookOk(hook)) {
        const reason = stripControls("hook_uncertain");
        const payload = { reason: reason };
        const stage = state.reserve_stage === "first" ? "first" : "final";
        const envFields = envelopeFor(env, state, stage, payload, now);
        await edge("/intake-reserve/reconcile", { envelope: envFields, payload: payload, reservation_id: state.reservation_id });
        console.log(String(state.reservation_id || ""));
        return respond(env, state, 200, { ok: false, status: "needs_reconcile" });
      }
      state.zap_sent = true;
    }
  }
  const extra = {};
  if (result.retry) extra["retry-after"] = result.retry;
  let published = publicBody(result.body);
  if (op === "claim" && (result.status || 0) === 200) published = stampHotClaim(published, input.by);
  if (op === "claim" && (result.status || 0) === 200 && published.status === "already_claimed") {
    state.claim_status = "already_claimed";
    if (state.zap_sent === true) published.reserved = true;
  }
  return respond(env, state, result.status || 502, published, extra);
}

function hookOk(hook) {
  return !!(hook && hook.status >= 200 && hook.status < 300);
}

async function postHook(doFetch, url, body) {
  try {
    return await doFetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: body });
  } catch (e) {
    return null;
  }
}

function envelopeRetry(env, state, payload, now) {
  const envFields = envelopeFor(env, state, "partial", payload, now);
  return { envelope: envFields, payload: payload };
}

function respond(env, state, status, body, extra) {
  shrinkTouch(state, env);
  const headers = Object.assign({ "content-type": "application/json", "set-cookie": cookieHeader(seal(state, cookieKey(env))) }, extra || {});
  return { statusCode: status, headers, body: JSON.stringify(body) };
}

exports.handle = handle;
exports.handler = (event) => handle(event, { env: process.env, fetch: global.fetch });
exports.canonicalJson = canonicalJson;
exports.canonicalLines = canonicalLines;
exports.signFields = signFields;
exports.cookieKey = cookieKey;
exports.stripControls = stripControls;
exports.HOOK_ATTR_KEYS = HOOK_ATTR_KEYS;
exports.SIGNALS = SIGNALS;
exports.hookFields = hookFields;
exports.mergeTouch = mergeTouch;
exports.alignTouch = alignTouch;
exports.sanitizeTouch = sanitizeTouch;
exports.gaClientId = gaClientId;
exports.deviceCategory = deviceCategory;
