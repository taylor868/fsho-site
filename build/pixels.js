/* Public-page pixels. Init snippets live in the head. This file only handles events.
   ClickCease cccontrack.js records a conversion as soon as it loads, using window.ccConVal.
   Loading it on every page would count a page view, so it is injected from onReserved.
   The official no-JS image is the same conversion:
   https://monitor.clickcease.com/conversions/conversions.aspx?value=0
   That image is not requested. The public form cannot finish without JS, and requesting
   the image after cccontrack.js loads would count the same lead twice.
   Meta Lead, OpenAI lead_created, and the OpenAI custom seller_form_completed event
   run from FSHOPixels.onReserved. two-stage.js calls that only after a reserved public
   seller_form_completed, once per lead id. This file does not read the page path.
   Click-to-call calls gtag only when gtag is already a function. It does not load gtag.js
   and it does not call gtag config. */
(function (root, factory) {
  var api = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (root && root.document) api.start(root);
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  var GUARD_KEY = "fsho_px_done";

  function safeStore(store) {
    try {
      var key = "__fsho_px_probe";
      store.setItem(key, "1");
      store.removeItem(key);
      return store;
    } catch (e) {
      var data = {};
      return {
        getItem: function (k) { return Object.prototype.hasOwnProperty.call(data, k) ? data[k] : null; },
        setItem: function (k, v) { data[k] = String(v); }
      };
    }
  }

  function createTracker(config, host) {
    var cfg = config || {};
    var win = (host && host.window) || globalThis;
    var storage = host && host.sessionStorage;
    var memory = Object.create(null);
    var queue = [];
    var watchTimer = 0;
    var ccStarted = false;

    function readDone() {
      if (!storage || typeof storage.getItem !== "function") return {};
      try {
        var raw = storage.getItem(GUARD_KEY);
        if (!raw) return {};
        var obj = JSON.parse(raw);
        return obj && typeof obj === "object" ? obj : {};
      } catch (e) { return {}; }
    }

    function writeDone(done) {
      if (!storage || typeof storage.setItem !== "function") return;
      try { storage.setItem(GUARD_KEY, JSON.stringify(done)); } catch (e) {}
    }

    function callPayload() {
      return {
        send_to: cfg.adsCallSendTo,
        value: 1.0,
        currency: "USD",
        transport_type: "beacon"
      };
    }

    function flush() {
      if (typeof win.gtag !== "function" || !queue.length) return;
      while (queue.length) win.gtag("event", "conversion", queue.shift());
    }

    function watch() {
      if (watchTimer) return;
      var setTimer = (host && host.setInterval) || globalThis.setInterval;
      var clearTimer = (host && host.clearInterval) || globalThis.clearInterval;
      if (typeof setTimer !== "function") return;
      var tries = 0;
      watchTimer = setTimer(function () {
        tries += 1;
        if (typeof win.gtag === "function" || tries >= 240) {
          if (typeof clearTimer === "function") clearTimer(watchTimer);
          watchTimer = 0;
          flush();
        }
      }, 250);
    }

    function loadClickCease() {
      if (ccStarted || !cfg.clickceaseConversion) return;
      ccStarted = true;
      win.ccConVal = 0;
      var doc = win.document;
      if (!doc || !doc.head || typeof doc.createElement !== "function") return;
      var script = doc.createElement("script");
      script.async = true;
      script.type = "text/javascript";
      script.src = cfg.clickceaseConversion;
      doc.head.appendChild(script);
    }

    function onReserved(leadId) {
      leadId = String(leadId || "");
      if (!leadId || memory[leadId]) return;
      var done = readDone();
      if (done[leadId]) {
        memory[leadId] = 1;
        return;
      }
      memory[leadId] = 1;
      done[leadId] = 1;
      writeDone(done);
      try { loadClickCease(); } catch (e) {}
      try {
        if (typeof win.fbq === "function") win.fbq("track", "Lead", {}, { eventID: leadId });
      } catch (e) {}
      try {
        if (typeof win.oaiq === "function") {
          win.oaiq("measure", "lead_created", { type: "customer_action" }, { event_id: leadId });
          win.oaiq("measure", "custom", { type: "custom" }, { custom_event_name: "seller_form_completed", event_id: leadId + ":seller_form_completed" });
        }
      } catch (e) {}
    }

    function onClick(event) {
      var target = event && event.target;
      var link = target && target.closest ? target.closest("a") : null;
      if (!link || typeof link.getAttribute !== "function") return;
      var href = link.getAttribute("href") || "";
      if (href.slice(0, 4).toLowerCase() !== "tel:") return;
      var dl = win.dataLayer = win.dataLayer || [];
      dl.push({ event: "click_to_call" });
      if (typeof win.gtag === "function") win.gtag("event", "conversion", callPayload());
      else {
        queue.push(callPayload());
        watch();
      }
    }

    return { onReserved: onReserved, onClick: onClick, flush: flush };
  }

  function start(win) {
    win = win || globalThis;
    var tracker = createTracker(win.FSHO_PIXELS || {}, {
      window: win,
      sessionStorage: safeStore(win.sessionStorage)
    });
    win.FSHOPixels = { onReserved: tracker.onReserved };
    if (win.document && typeof win.document.addEventListener === "function") {
      win.document.addEventListener("click", tracker.onClick, true);
    }
    return tracker;
  }

  return { createTracker: createTracker, start: start };
});
