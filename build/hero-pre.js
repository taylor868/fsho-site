/* Hero personalization (gen.py inlines this right after the hero copy, so it runs before first paint:
   no flash, no layout shift). Server HTML keeps each page's own H1 for crawlers and no-JS visitors.
   Text only via textContent. Sends nothing, adds no tracking, never touches the form's submit. */
(function (D) {
  "use strict";
  var d = document, s = d.currentScript, col = s && s.parentNode, q, ls = null;
  if (!col) return;
  try { q = new URLSearchParams(location.search); } catch (e) { return; }
  try { ls = window.localStorage; } catch (e) {}
  function get(k) { return String(q.get(k) || ""); }
  function show(el, t) { if (el) { el.textContent = t; el.hidden = false; } }
  /* 1. Search-matched headline (only on pages built with personalize: true). */
  if (D.b) {
    var src = D.src.map(get).join(" ").toLowerCase().replace(/[+_\-]+/g, " ").replace(/\s+/g, " ").trim();
    var force = get("fsho_intent").toLowerCase(), hit = null;
    for (var i = 0; i < D.b.length && !hit; i++) {
      var b = D.b[i];
      if (force ? b.id === force : (src && new RegExp(b.m, "i").test(src))) hit = b;
    }
    if (hit) {
      var h1 = col.querySelector("h1"), lede = col.querySelector(".lede");
      if (h1) h1.textContent = hit.h;
      if (lede) lede.textContent = hit.s;
      d.documentElement.setAttribute("data-intent", hit.id);
    }
  }
  /* 3. Local line: ?city= / allowlisted param, else the city from an address typed earlier. */
  function clean(v) {
    v = String(v || "").replace(/[+_]/g, " ").replace(/\s+/g, " ").trim();
    if (v.length < 2 || v.length > 30 || !/^[A-Za-z][A-Za-z -]*$/.test(v)) return "";
    return v.toLowerCase().replace(/(^|[ -])([a-z])/g, function (m, a, c) { return a + c.toUpperCase(); });
  }
  var city = "";
  for (var j = 0; j < D.cp.length && !city; j++) city = clean(get(D.cp[j]));
  if (!city) { try { city = clean(window.sessionStorage.getItem("fsho_city")); } catch (e) {} }
  /* 4. Resume prompt, this browser only, 7 days. */
  var K = "fsho_resume_v1", R = null, now = Date.now();
  try { R = JSON.parse((ls && ls.getItem(K)) || "null"); } catch (e) { R = null; }
  if (R && (typeof R.a !== "string" || R.a.length < 3 || R.a.length > 200 || typeof R.t !== "number" || now - R.t > 6048e5 || R.t - now > 6e4)) {
    try { ls.removeItem(K); } catch (e) {}
    R = null;
  }
  if (!city && R && R.c) city = clean(R.c);
  if (city) show(col.querySelector(".hcity"), D.ct.split("{city}").join(city));
  /* 2b. After-hours note: outside staff days/hours in ET (weekends included). ?fsho_ah=1 / 0 forces it (only flips this note). */
  function offHours() {
    try {
      var p = new Intl.DateTimeFormat("en-US", { timeZone: D.hr.tz, weekday: "short", hour: "numeric", hourCycle: "h23" }).formatToParts(new Date()), wd = "", hr = -1;
      for (var k = 0; k < p.length; k++) { if (p[k].type === "weekday") wd = p[k].value; if (p[k].type === "hour") hr = (+p[k].value) % 24; }
      var day = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].indexOf(wd) + 1;
      if (!day || hr < 0) return false;
      return D.hr.days.indexOf(day) < 0 || hr < D.hr.open || hr >= D.hr.close;
    } catch (e) { return false; }
  }
  var f = get("fsho_ah");
  var after = f === "1" ? true : f === "0" ? false : offHours();
  if (after) { d.documentElement.classList.add("after-hours"); show(col.querySelector(".ah-note"), D.ah); }
  var rp = col.querySelector(".ts-resume");
  if (R && rp && d.getElementById("offer")) {
    show(rp.querySelector(".ts-resume-a"), R.a);
    rp.hidden = false;
    var go = rp.querySelector(".ts-resume-go"), over = rp.querySelector(".ts-resume-over");
    if (go) go.addEventListener("click", function () {
      var form = d.getElementById("ts-form"), s1 = d.getElementById("ts-s1");
      var a = form && form.querySelector('input[name="address"]');
      rp.hidden = true;
      if (!a || !s1 || s1.hidden) return;
      a.value = R.a;
      var btn = s1.querySelector('button[type="submit"]');
      /* Same as the visitor pressing "Get My Offer" on Step 1: the form's own handler runs unchanged. */
      if (form.requestSubmit && btn) form.requestSubmit(btn); else if (btn) btn.click();
    });
    if (over) over.addEventListener("click", function () {
      try { ls.removeItem(K); } catch (e) {}
      rp.hidden = true;
      var form = d.getElementById("ts-form"), a = form && form.querySelector('input[name="address"]');
      if (a) { a.value = ""; try { a.focus(); } catch (e) {} }
    });
  }
})(__FSHO_P__);
