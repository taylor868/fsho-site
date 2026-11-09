"use strict";

// Server-side only. Query strings and request bodies cannot select these.
// Taylor verified these two campaign and lead_source pairs on 2026-11-09, relayed via Scoot.

const VERIFIED = "VERIFIED-Taylor-2026-11-09";

const BINDINGS = {
  hesel_fb: {
    campaign_id: "f84d5fc2-03c4-48e6-91dd-def271108f95",
    lead_source_key: "facebook",
    wc_action: "reuse",
    verification: VERIFIED,
  },
  ppc_inhouse: {
    campaign_id: "1f149598-c1f7-4bf9-a0c2-6687428e09c7",
    lead_source_key: "ppc",
    wc_action: "create_once",
    verification: VERIFIED,
  },
};

function routeFromEnv(value) {
  if (!Object.prototype.hasOwnProperty.call(BINDINGS, value)) {
    return { route_id: "unknown_vendor", blocked: true, wc_action: "none", verification: "blocked" };
  }
  return Object.assign({ route_id: value, blocked: false }, BINDINGS[value]);
}

module.exports = { BINDINGS, routeFromEnv };
