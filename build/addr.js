/* fsho.co address lookup: a WCAG combobox on the seller form's address field.
   Loaded lazily by the inline boot in gen.py (public_intake) on the first focus or tap of the
   address field, so it adds nothing to page load. It only changes the text in
   input[name="address"]; the form, payload, GTM events, dedupe, and WhatConverts are untouched.
   Providers: "google" = Places API (New) Autocomplete + Place Details on one session token.
   "demo" = Photon (OpenStreetMap), keyless, for deploy previews with ?addrdemo=1 only.
   Any error turns the lookup off for the page and the plain field keeps working. */
(function (root) {
  "use strict";
  var US_BBOX = "-125,24,-66.9,49.5";
  var GOOGLE_TYPES = ["street_address", "premise", "subpremise"];
  var NO_MATCH = "We couldn't confirm that address. Check it, or continue anyway.";

  function parseBias(s) {
    var p = String(s || "").split(",").map(Number);
    if (p.length !== 4 || p.some(function (n) { return !isFinite(n); })) return null;
    return { s: p[0], w: p[1], n: p[2], e: p[3] };
  }
  function trimUSA(t) { return String(t || "").replace(/,\s*(USA|United States)$/i, ""); }
  function googleSuggestions(json) {
    return ((json && json.suggestions) || []).filter(function (x) { return x.placePrediction; }).slice(0, 5).map(function (x) {
      var p = x.placePrediction, sf = p.structuredFormat || {};
      var main = (sf.mainText && sf.mainText.text) || (p.text && p.text.text) || "";
      var rest = trimUSA(sf.secondaryText && sf.secondaryText.text);
      return { id: p.placeId, main: main, rest: rest, full: trimUSA(p.text && p.text.text) || (rest ? main + ", " + rest : main) };
    });
  }
  function componentsFromGoogle(json) {
    var out = { line1: "", city: "", state: "", postal: "" }, num = "", route = "", sub = "";
    ((json && json.addressComponents) || []).forEach(function (c) {
      var t = c.types || [];
      if (t.indexOf("street_number") > -1) num = c.longText;
      else if (t.indexOf("route") > -1) route = c.shortText || c.longText;
      else if (t.indexOf("subpremise") > -1) sub = c.longText;
      else if (t.indexOf("locality") > -1) out.city = c.longText;
      else if (t.indexOf("postal_town") > -1 && !out.city) out.city = c.longText;
      else if (t.indexOf("sublocality") > -1 && !out.city) out.city = c.longText;
      else if (t.indexOf("administrative_area_level_1") > -1) out.state = c.shortText;
      else if (t.indexOf("postal_code") > -1) out.postal = c.longText;
    });
    out.line1 = [num, route].filter(Boolean).join(" ") + (sub ? " #" + sub : "");
    out.full = trimUSA(json && json.formattedAddress);
    return out;
  }
  var STATES = { "Alabama": "AL", "Alaska": "AK", "Arizona": "AZ", "Arkansas": "AR", "California": "CA", "Colorado": "CO", "Connecticut": "CT", "Delaware": "DE", "District of Columbia": "DC", "Florida": "FL", "Georgia": "GA", "Hawaii": "HI", "Idaho": "ID", "Illinois": "IL", "Indiana": "IN", "Iowa": "IA", "Kansas": "KS", "Kentucky": "KY", "Louisiana": "LA", "Maine": "ME", "Maryland": "MD", "Massachusetts": "MA", "Michigan": "MI", "Minnesota": "MN", "Mississippi": "MS", "Missouri": "MO", "Montana": "MT", "Nebraska": "NE", "Nevada": "NV", "New Hampshire": "NH", "New Jersey": "NJ", "New Mexico": "NM", "New York": "NY", "North Carolina": "NC", "North Dakota": "ND", "Ohio": "OH", "Oklahoma": "OK", "Oregon": "OR", "Pennsylvania": "PA", "Rhode Island": "RI", "South Carolina": "SC", "South Dakota": "SD", "Tennessee": "TN", "Texas": "TX", "Utah": "UT", "Vermont": "VT", "Virginia": "VA", "Washington": "WA", "West Virginia": "WV", "Wisconsin": "WI", "Wyoming": "WY" };
  function photonSuggestions(json) {
    var seen = {}, out = [];
    ((json && json.features) || []).forEach(function (f) {
      var p = f.properties || {};
      if (p.countrycode !== "US" || out.length >= 5) return;
      var street = p.street || (p.type === "street" ? p.name : "");
      if (!street) return;
      var line1 = (p.housenumber ? p.housenumber + " " : "") + street;
      var st = STATES[p.state] || p.state || "";
      var city = p.city || p.town || p.village || p.district || p.county || "";
      var rest = [city, [st, p.postcode].filter(Boolean).join(" ")].filter(Boolean).join(", ");
      var full = rest ? line1 + ", " + rest : line1;
      if (seen[full]) return;
      seen[full] = 1;
      out.push({ id: "", main: line1, rest: rest, full: full, parts: { line1: line1, city: city, state: st, postal: p.postcode || "", full: full } });
    });
    return out;
  }
  function token() {
    var c = root.crypto;
    if (c && c.randomUUID) return c.randomUUID();
    return "t" + Date.now().toString(36) + Math.random().toString(36).slice(2);
  }

  function googleProvider(key, bias) {
    var session = token();
    return {
      name: "google",
      search: function (q, signal) {
        var body = { input: q, includedRegionCodes: ["us"], includedPrimaryTypes: GOOGLE_TYPES, languageCode: "en", sessionToken: session };
        if (bias) body.locationBias = { rectangle: { low: { latitude: bias.s, longitude: bias.w }, high: { latitude: bias.n, longitude: bias.e } } };
        return fetch("https://places.googleapis.com/v1/places:autocomplete", {
          method: "POST", signal: signal,
          headers: { "Content-Type": "application/json", "X-Goog-Api-Key": key,
            "X-Goog-FieldMask": "suggestions.placePrediction.placeId,suggestions.placePrediction.text.text,suggestions.placePrediction.structuredFormat" },
          body: JSON.stringify(body)
        }).then(ok).then(googleSuggestions);
      },
      details: function (item) {
        var url = "https://places.googleapis.com/v1/places/" + encodeURIComponent(item.id) + "?languageCode=en&sessionToken=" + encodeURIComponent(session);
        session = token();
        return fetch(url, { headers: { "X-Goog-Api-Key": key, "X-Goog-FieldMask": "formattedAddress,addressComponents" } })
          .then(ok).then(componentsFromGoogle);
      }
    };
  }
  function demoProvider(bias) {
    return {
      name: "demo",
      search: function (q, signal) {
        var u = "https://photon.komoot.io/api/?limit=10&lang=en&layer=house&layer=street&bbox=" + US_BBOX + "&q=" + encodeURIComponent(q);
        if (bias) u += "&lat=" + ((bias.s + bias.n) / 2).toFixed(3) + "&lon=" + ((bias.w + bias.e) / 2).toFixed(3);
        return fetch(u, { signal: signal }).then(ok).then(photonSuggestions);
      },
      details: function (item) { return Promise.resolve(item.parts); }
    };
  }
  function ok(r) { if (!r.ok) throw new Error("http " + r.status); return r.json(); }

  var CSS = ".fa-list{position:absolute;left:0;right:0;z-index:30;margin:4px 0 0;padding:0;list-style:none;background:#fff;border:1.5px solid #c8d1da;border-radius:12px;box-shadow:0 12px 30px #0003;overflow:hidden;text-align:left}" +
    ".fa-list[hidden]{display:none}.fa-opt{display:flex;align-items:center;gap:12px;min-height:52px;padding:8px 14px;cursor:pointer;border-top:1px solid #eef1f4;color:#1F3C56;font-size:16px;line-height:1.25}" +
    ".fa-opt:first-child{border-top:0}.fa-opt[aria-selected=true],.fa-opt:hover{background:#f2f5f8}.fa-opt svg{flex:0 0 22px;width:22px;height:22px}" +
    ".fa-opt b{display:block;font-weight:700}.fa-opt small{display:block;font-size:14px;color:#556;margin-top:2px}" +
    ".fa-man{font-weight:700;color:#1F3C56}.fa-man small{font-weight:400}.fa-msg{padding:12px 14px;font-size:14px;color:#556;border-bottom:1px solid #eef1f4}.fa-msg[hidden]{display:none}" +
    ".fa-foot{display:flex;justify-content:flex-end;align-items:center;gap:8px;padding:6px 12px;border-top:1px solid #eef1f4;background:#fafbfc}" +
    ".fa-gmp{font-family:Roboto,Sans-Serif;font-style:normal;font-weight:400;font-size:12px;letter-spacing:normal;white-space:nowrap;color:#5e5e5e}" +
    ".fa-demo{margin-right:auto;font-size:11px;font-weight:800;letter-spacing:.04em;text-transform:uppercase;white-space:nowrap;color:#a04a00;background:#fff1e6;border-radius:6px;padding:2px 6px}" +
    ".fa-sr{position:absolute!important;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}";
  var PIN = '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path fill="#1F3C56" d="M12 2a7 7 0 0 0-7 7c0 5.2 7 13 7 13s7-7.8 7-13a7 7 0 0 0-7-7zm0 9.5A2.5 2.5 0 1 1 12 6.5a2.5 2.5 0 0 1 0 5z"/></svg>';
  var EDIT = '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path fill="#1F3C56" d="M3 17.3V21h3.7L17.8 9.9l-3.7-3.7L3 17.3zM20.7 7a1 1 0 0 0 0-1.4l-2.3-2.3a1 1 0 0 0-1.4 0l-1.8 1.8 3.7 3.7L20.7 7z"/></svg>';
  function esc(t) { return String(t).replace(/[&<>"]/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]; }); }

  function attach(input, provider, opts) {
    if (!input || input.getAttribute("data-fa")) return null;
    input.setAttribute("data-fa", provider.name);
    opts = opts || {};
    var doc = input.ownerDocument, form = input.form || input.parentNode, id = "fa-" + Math.random().toString(36).slice(2, 8);
    if (!doc.getElementById("fa-css")) { var st = doc.createElement("style"); st.id = "fa-css"; st.textContent = CSS; doc.head.appendChild(st); }
    if (root.getComputedStyle && root.getComputedStyle(form).position === "static") form.style.position = "relative";
    var list = doc.createElement("ul"), foot = doc.createElement("div"), live = doc.createElement("div"), box = doc.createElement("div");
    list.id = id + "-list"; list.className = "fa-list"; list.setAttribute("role", "listbox"); list.setAttribute("aria-label", "Address suggestions");
    var msg = doc.createElement("div"); msg.className = "fa-msg"; msg.hidden = true;
    box.className = "fa-list"; box.hidden = true; box.appendChild(msg); box.appendChild(list); list.className = "";
    list.style.cssText = "list-style:none;margin:0;padding:0";
    foot.className = "fa-foot";
    foot.innerHTML = (provider.name === "demo" ? '<span class="fa-demo">Demo preview only</span><span class="fa-gmp">© OpenStreetMap contributors</span>'
      : '<span class="fa-gmp" translate="no" aria-label="Google Maps">Google Maps</span>');
    box.appendChild(foot);
    live.className = "fa-sr"; live.setAttribute("aria-live", "polite"); live.setAttribute("role", "status");
    var label = input.closest ? (input.closest("label") || input) : input;
    label.parentNode.insertBefore(box, label.nextSibling);
    box.parentNode.insertBefore(live, box.nextSibling);
    input.setAttribute("role", "combobox");
    input.setAttribute("aria-autocomplete", "list");
    input.setAttribute("aria-expanded", "false");
    input.setAttribute("aria-controls", list.id);
    input.setAttribute("autocomplete", "off");
    var items = [], active = -1, timer = 0, ctl = null, seq = 0, dead = false, picked = "";

    function place() {
      var top = 0, el = input;
      while (el && el !== form) { top += el.offsetTop; el = el.offsetParent; }
      if (el !== form) top = input.getBoundingClientRect().top - form.getBoundingClientRect().top;
      box.style.top = (top + input.offsetHeight) + "px";
    }
    function open(on) {
      box.hidden = !on;
      input.setAttribute("aria-expanded", on ? "true" : "false");
      if (on) { place(); reveal(); } else setActive(-1);
    }
    function reveal() {
      var vv = root.visualViewport, h = vv ? vv.height : root.innerHeight;
      if (!h || !box.getBoundingClientRect) return;
      var over = box.getBoundingClientRect().bottom - h + 8, room = input.getBoundingClientRect().top - 8;
      if (over > 0 && room > 0) root.scrollBy(0, Math.min(over, room));
    }
    function setActive(i) {
      var opts2 = list.querySelectorAll("[role=option]");
      active = i;
      for (var k = 0; k < opts2.length; k++) opts2[k].setAttribute("aria-selected", k === i ? "true" : "false");
      if (i >= 0 && opts2[i]) { input.setAttribute("aria-activedescendant", opts2[i].id); if (opts2[i].scrollIntoView) opts2[i].scrollIntoView({ block: "nearest" }); }
      else input.removeAttribute("aria-activedescendant");
    }
    function render(q) {
      var html = items.map(function (it, i) {
        return '<li role="option" class="fa-opt" id="' + id + "-" + i + '" aria-selected="false">' + PIN + '<span><b>' + esc(it.main) + "</b>" + (it.rest ? "<small>" + esc(it.rest) + "</small>" : "") + "</span></li>";
      }).join("");
      msg.hidden = !!items.length; msg.textContent = items.length ? "" : NO_MATCH;
      html += '<li role="option" class="fa-opt fa-man" id="' + id + '-m" aria-selected="false" data-manual="1">' + EDIT + '<span>Add manually<small>Keep "' + esc(q) + '" as typed</small></span></li>';
      list.innerHTML = html;
      live.textContent = items.length ? items.length + (items.length === 1 ? " address" : " addresses") + " found. Use up and down arrows to choose." : NO_MATCH;
      open(true);
    }
    function off() { dead = true; clearTimeout(timer); if (ctl) ctl.abort(); open(false); live.textContent = ""; }
    function choose(i) {
      var el = list.querySelectorAll("[role=option]")[i];
      if (!el) return;
      if (el.getAttribute("data-manual")) { open(false); picked = ""; input.focus(); return; }
      var it = items[i];
      input.value = it.full; picked = it.full;
      open(false);
      live.textContent = "Address filled: " + it.full;
      provider.details(it).then(function (parts) {
        if (!parts || picked !== it.full) return;
        if (parts.full) { input.value = parts.full; picked = parts.full; }
        ["line1", "city", "state", "postal"].forEach(function (k) { input.setAttribute("data-addr-" + k, parts[k] || ""); });
      }, function () { /* keep the suggestion text; nothing else to do */ });
      if (opts.onPick) opts.onPick(it);
    }
    function query() {
      var q = input.value.trim();
      if (dead) return;
      if (q.length < 3 || q === picked) { if (ctl) ctl.abort(); open(false); return; }
      if (ctl) ctl.abort();
      ctl = root.AbortController ? new AbortController() : null;
      var mine = ++seq;
      provider.search(q, ctl && ctl.signal).then(function (res) {
        if (mine !== seq || dead || doc.activeElement !== input) return;
        items = res; render(q);
      }, function (e) { if (e && e.name === "AbortError") return; off(); });
    }
    input.addEventListener("input", function () {
      ["line1", "city", "state", "postal"].forEach(function (k) { input.removeAttribute("data-addr-" + k); });
      clearTimeout(timer); timer = setTimeout(query, 200);
    });
    input.addEventListener("keydown", function (e) {
      if (dead) return;
      var n = list.querySelectorAll("[role=option]").length;
      if (e.key === "ArrowDown") { e.preventDefault(); if (box.hidden) { query(); return; } setActive(active + 1 >= n ? 0 : active + 1); }
      else if (e.key === "ArrowUp") { if (box.hidden) return; e.preventDefault(); setActive(active <= 0 ? n - 1 : active - 1); }
      else if (e.key === "Enter") { if (!box.hidden && active >= 0) { e.preventDefault(); choose(active); } else if (!box.hidden) open(false); }
      else if (e.key === "Escape") { if (!box.hidden) { e.preventDefault(); open(false); } }
      else if (e.key === "Tab") open(false);
    });
    input.addEventListener("blur", function () { setTimeout(function () { if (doc.activeElement !== input) open(false); }, 150); });
    list.addEventListener("mousedown", function (e) { e.preventDefault(); });
    list.addEventListener("click", function (e) {
      var li = e.target.closest ? e.target.closest("[role=option]") : null;
      if (!li) return;
      var all = list.querySelectorAll("[role=option]");
      for (var k = 0; k < all.length; k++) if (all[k] === li) choose(k);
    });
    if (root.addEventListener) root.addEventListener("resize", function () { if (!box.hidden) place(); });
    if (input.value.trim().length >= 3 && doc.activeElement === input) query();
    return { off: off, query: query };
  }

  function boot(cfg) {
    cfg = cfg || root.FSHO_ADDR || {};
    var provider = null, bias = parseBias(cfg.bias);
    if (cfg.key) provider = googleProvider(cfg.key, bias);
    else if (cfg.demo) provider = demoProvider(bias);
    if (!provider || !root.fetch) return 0;
    var inputs = root.document.querySelectorAll(cfg.selector || 'form input[name="address"]:not([type=hidden])'), n = 0;
    for (var i = 0; i < inputs.length; i++) if (attach(inputs[i], provider)) n++;
    return n;
  }

  var api = { parseBias: parseBias, googleSuggestions: googleSuggestions, componentsFromGoogle: componentsFromGoogle, photonSuggestions: photonSuggestions, NO_MATCH: NO_MATCH, boot: boot, attach: attach };
  if (typeof module === "object" && module.exports) module.exports = api;
  else { root.FSHO_ADDR_API = api; boot(); }
})(typeof window !== "undefined" ? window : globalThis);
