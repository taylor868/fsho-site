/* Mobile Call / Get Offer bar: hides while the hero form is on screen (and, via sticky_guard, while the
   keyboard is open); shows the after-hours line outside staff hours (ET). Also keeps the
   "pick up where you left off" record: saved when Step 2 opens, cleared once contact info is sent.
   Reads form state only. Sends nothing, adds no tracking, never touches the form's submit. */
(function (D) {
  "use strict";
  var d = document, h = d.documentElement, bar = d.getElementById("mbar");
  var q; try { q = new URLSearchParams(location.search); } catch (e) { q = { get: function () { return null; } }; }
  function etHour() {
    try {
      var p = new Intl.DateTimeFormat("en-US", { timeZone: D.hr.tz, hour: "numeric", hourCycle: "h23" }).formatToParts(new Date());
      for (var k = 0; k < p.length; k++) if (p[k].type === "hour") return (+p[k].value) % 24;
    } catch (e) {}
    return -1;
  }
  var f = q.get("fsho_ah"), hr = etHour();
  var after = f === "1" ? true : f === "0" ? false : (hr >= 0 && (hr < D.hr.open || hr >= D.hr.close));
  var ah = bar && bar.querySelector(".mbar-ah");
  if (after && ah) { ah.textContent = D.ah; ah.hidden = false; h.classList.add("after-hours"); }
  var formBox = d.getElementById("two-stage");
  if (formBox && "IntersectionObserver" in window) {
    new IntersectionObserver(function (es) {
      var e = es[es.length - 1];
      h.classList.toggle("form-vis", !!(e && e.isIntersecting));
    }, { threshold: 0.2 }).observe(formBox);
  }
  var form = d.getElementById("ts-form"), s2 = d.getElementById("ts-s2"), echo = d.getElementById("ts-addr-echo");
  if (!form || !s2 || !echo || !("MutationObserver" in window)) return;
  var K = "fsho_resume_v1", ls = null;
  try { ls = window.localStorage; } catch (e) {}
  function clean(v) {
    v = String(v || "").replace(/\s+/g, " ").trim();
    if (v.length < 2 || v.length > 30 || !/^[A-Za-z][A-Za-z -]*$/.test(v)) return "";
    return v;
  }
  function cityOf(a, input) {
    var c = clean(input && input.getAttribute("data-addr-city"));
    if (c) return c;
    var parts = a.split(",").map(function (x) { return x.trim(); });
    if (parts.length >= 3) return clean(parts[1]);
    if (parts.length === 2) return clean(parts[1].replace(/\s+[A-Za-z]{2}(\s+\d{5}(-\d{4})?)?$/, ""));
    return "";
  }
  function sync() {
    if (form.hidden) { try { ls.removeItem(K); } catch (e) {} return; }
    if (s2.hidden) return;
    var a = String(echo.textContent || "").trim();
    if (a.length < 3 || a.length > 200) return;
    var c = cityOf(a, form.querySelector('input[name="address"]'));
    try { ls.setItem(K, JSON.stringify({ a: a, c: c, t: Date.now() })); } catch (e) {}
    if (c) { try { window.sessionStorage.setItem("fsho_city", c); } catch (e) {} }
  }
  new MutationObserver(sync).observe(form, { attributes: true, subtree: true, attributeFilter: ["hidden"] });
})(__FSHO_B__);
