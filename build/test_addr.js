"use strict";
const assert = require("node:assert/strict");
const test = require("node:test");
const addr = require("./addr.js");

test("bias parses s,w,n,e and rejects junk", () => {
  assert.deepEqual(addr.parseBias("33.753,-84.322,36.588,-75.4"), { s: 33.753, w: -84.322, n: 36.588, e: -75.4 });
  assert.equal(addr.parseBias(""), null);
  assert.equal(addr.parseBias("1,2,3"), null);
});

test("google predictions become two-line rows without USA", () => {
  const rows = addr.googleSuggestions({ suggestions: [{ placePrediction: { placeId: "abc", text: { text: "3240 Oakfields Road, New Hill, NC, USA" },
    structuredFormat: { mainText: { text: "3240 Oakfields Road" }, secondaryText: { text: "New Hill, NC, USA" } } } }, { queryPrediction: {} }] });
  assert.deepEqual(rows, [{ id: "abc", main: "3240 Oakfields Road", rest: "New Hill, NC", full: "3240 Oakfields Road, New Hill, NC" }]);
});

test("google place details give street, city, state, zip", () => {
  const parts = addr.componentsFromGoogle({ formattedAddress: "3240 Oakfields Rd, New Hill, NC 27562, USA", addressComponents: [
    { longText: "3240", shortText: "3240", types: ["street_number"] },
    { longText: "Oakfields Road", shortText: "Oakfields Rd", types: ["route"] },
    { longText: "New Hill", shortText: "New Hill", types: ["locality", "political"] },
    { longText: "North Carolina", shortText: "NC", types: ["administrative_area_level_1", "political"] },
    { longText: "27562", shortText: "27562", types: ["postal_code"] }] });
  assert.deepEqual(parts, { line1: "3240 Oakfields Rd", city: "New Hill", state: "NC", postal: "27562", full: "3240 Oakfields Rd, New Hill, NC 27562" });
});

test("demo (Photon) rows are US-only, deduped, and capped at 5", () => {
  const f = (p) => ({ properties: p });
  const rows = addr.photonSuggestions({ features: [
    f({ countrycode: "US", type: "house", housenumber: "3240", street: "Oakfields Road", city: "Apex", state: "North Carolina" }),
    f({ countrycode: "US", type: "house", housenumber: "3240", street: "Oakfields Road", city: "Apex", state: "North Carolina" }),
    f({ countrycode: "CA", type: "house", housenumber: "123", street: "Main Street", city: "Winnipeg", state: "Manitoba" }),
    f({ countrycode: "US", type: "street", name: "Raleigh Street", city: "Rochester", state: "New York", postcode: "14620" })] });
  assert.equal(rows.length, 2);
  assert.equal(rows[0].full, "3240 Oakfields Road, Apex, NC");
  assert.equal(rows[1].full, "Raleigh Street, Rochester, NY 14620");
});

test("the lookup never touches GTM, dataLayer, or WhatConverts", () => {
  const src = require("fs").readFileSync(require("path").join(__dirname, "addr.js"), "utf8");
  for (const needle of ["dataLayer", "gtag(", "$wc_", "whatconverts", "seller_form"]) assert.equal(src.includes(needle), false, needle);
});
