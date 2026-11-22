"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const T = require("./browser-tracking.cjs");

test("click identifiers and campaign tags are removed; everything else is left byte for byte", () => {
  assert.equal(T.stripTrackingParams("https://shop.test/item?id=7&utm_source=news&utm_medium=email&fbclid=AbC#reviews"),
    "https://shop.test/item?id=7#reviews");
  assert.equal(T.stripTrackingParams("https://shop.test/item?gclid=1"), "https://shop.test/item");
  assert.equal(T.stripTrackingParams("https://shop.test/?q=a%20b+c&msclkid=9&x=%E2%9C%93"), "https://shop.test/?q=a%20b+c&x=%E2%9C%93");
  assert.equal(T.stripTrackingParams("https://shop.test/?UTM_Campaign=x&keep"), "https://shop.test/?keep");
  assert.equal(T.stripTrackingParams("http://a.test/p?a=1&_hsenc=zz&b=2&mc_eid=3"), "http://a.test/p?a=1&b=2");
});

test("an address with nothing to remove comes back as null (no redirect)", () => {
  for (const url of ["https://shop.test/item?id=7", "https://shop.test/", "https://shop.test/?", "https://shop.test/#utm_source=x",
    "https://shop.test/?utm=1", "https://shop.test/?utm_=1", "https://shop.test/?reference=utm_source", "", null,
    "aither://settings?utm_source=x", "file:///c:/x?fbclid=1"]) {
    assert.equal(T.stripTrackingParams(url), null, String(url));
  }
});

test("cleaning is stable: a cleaned address is never cleaned again", () => {
  const once = T.stripTrackingParams("https://a.test/?utm_source=x&id=1&fbclid=2");
  assert.equal(once, "https://a.test/?id=1");
  assert.equal(T.stripTrackingParams(once), null);
});

test("only names that are identifiers match", () => {
  for (const n of ["utm_source", "utm_id", "fbclid", "gclid", "msclkid", "mc_eid", "_ga", "igshid", "pk_campaign"]) {
    assert.equal(T.isTrackingParam(n), true, n);
  }
  for (const n of ["id", "q", "page", "ref", "source", "utm", "token", "state", "code", "v", "t", "si"]) {
    assert.equal(T.isTrackingParam(n), false, n);
  }
});

test("the privacy headers are added without touching the others", () => {
  const before = { "User-Agent": "x", Accept: "*/*" };
  const after = T.withPrivacyHeaders(before);
  assert.deepEqual(after, { "User-Agent": "x", Accept: "*/*", "Sec-GPC": "1", DNT: "1" });
  assert.deepEqual(before, { "User-Agent": "x", Accept: "*/*" });
});
