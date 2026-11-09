"use strict";

// Server-side only. Query strings and request bodies cannot select these.
// UNVERIFIED-pending-Taylor: campaign rows exist; source_key on the campaign
// row was null. These lead_source values are the proposed create_lead keys.

const BINDINGS = {
  hesel_fb: {
    campaign_id: "f84d5fc2-03c4-48e6-91dd-def271108f95",
    lead_source_key: "facebook",
    wc_action: "reuse",
    verification: "UNVERIFIED-pending-Taylor",
  },
  ppc_inhouse: {
    campaign_id: "1f149598-c1f7-4bf9-a0c2-6687428e09c7",
    lead_source_key: "ppc",
    wc_action: "create_once",
    verification: "UNVERIFIED-pending-Taylor",
  },
};

function routeFromEnv(value) {
  if (!Object.prototype.hasOwnProperty.call(BINDINGS, value)) {
    return { route_id: "unknown_vendor", blocked: true, wc_action: "none", verification: "UNVERIFIED-pending-Taylor" };
  }
  return Object.assign({ route_id: value, blocked: false }, BINDINGS[value]);
}

module.exports = { BINDINGS, routeFromEnv };
