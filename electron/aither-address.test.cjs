"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const addr = require("./aither-address.cjs");

const res = (status, body) => ({ status, ok: status >= 200 && status < 300, json: async () => body });

test("keyword detection: only <name>.aither hosts", () => {
  assert.equal(addr.aitherKeyword("https://wiby.aither/"), "wiby.aither");
  assert.equal(addr.aitherKeyword("wiby.aither"), "wiby.aither");
  assert.equal(addr.aitherKeyword("http://Wiby.Aither/x?q=1"), "wiby.aither");
  assert.equal(addr.aitherKeyword("https://example.com/x.aither"), "");
  assert.equal(addr.aitherKeyword(".aither"), "");
  assert.equal(addr.aitherKeyword(""), "");
});

test("an indexed web route is followed; plain URLs never touch the index", async () => {
  const seen = [];
  const fetchImpl = async (u) => { seen.push(u); return res(200, { type: "web", target: "https://wiby.me" }); };
  assert.equal(await addr.resolveAitherUrl("https://wiby.aither/", { fetchImpl }), "https://wiby.me/");
  assert.equal(await addr.resolveAitherUrl("https://wiby.aither/?q=cats", { fetchImpl }), "https://wiby.me/?q=cats");
  assert.match(seen[0], /index\.aitherium\.com\/n\/wiby\.aither\.json$/);
  const boom = async () => { throw new Error("index consulted for a normal URL"); };
  assert.equal(await addr.resolveAitherUrl("https://wiby.me/", { fetchImpl: boom }), "https://wiby.me/");
});

test("missing, non-web, non-https and unreachable all fail with a reason", async () => {
  await assert.rejects(addr.resolveAitherUrl("x.aither", { fetchImpl: async () => res(404, {}) }), /not in the AitherNet Index/);
  await assert.rejects(addr.resolveAitherUrl("x.aither", { fetchImpl: async () => res(200, { type: "relay-gate", target: "aithernet://x" }) }), /not a web address/);
  await assert.rejects(addr.resolveAitherUrl("x.aither", { fetchImpl: async () => res(200, { type: "web", target: "http://plain" }) }), /not a web address/);
  await assert.rejects(addr.resolveAitherUrl("x.aither", { fetchImpl: async () => { throw new Error("ENOTFOUND"); } }), /could not be reached/);
});

test("the error page is dark, escaped, and says why", () => {
  const u = addr.errorPageUrl("https://x.aither/<script>", "x.aither is not in the AitherNet Index");
  const html = decodeURIComponent(u.replace(/^data:text\/html;charset=utf-8,/, ""));
  assert.match(html, /color-scheme:dark/);
  assert.match(html, /not in the AitherNet Index/);
  assert.ok(!html.includes("<script>"));
});
