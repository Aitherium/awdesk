"use strict";

// The watermark's pure half: what it says, the document main writes for it (no script,
// nothing a page name can inject) and the rectangle it covers.

const test = require("node:test");
const assert = require("node:assert/strict");
const W = require("./browser-watermark.cjs");

const NOW = new Date(2026, 10, 13, 9, 30).getTime();

test("the label names the signed-in user, the workspace and the day", () => {
  assert.equal(W.label({ user: "david", tenant: "acme", now: NOW }), "david · acme · 2026-11-13");
  assert.equal(W.label({ user: "", tenant: "acme", now: NOW }), "not signed in · acme · 2026-11-13");
  assert.equal(W.label({ user: "a\nb\u0007", tenant: "", now: NOW }), "ab · 2026-11-13", "control characters are dropped");
  assert.ok(W.label({ user: "x".repeat(500), now: NOW }).length < 110);
  assert.equal(W.dateOf(NOW), "2026-11-13");
});

test("the document is main's own: escaped text, no script, click-through styling", () => {
  const url = W.page("<script>alert(1)</script> & \"david\"");
  assert.ok(url.startsWith("data:text/html;charset=utf-8,"));
  const html = decodeURIComponent(url.slice(url.indexOf(",") + 1));
  assert.ok(!/<script/i.test(html), "nothing injected");
  assert.ok(html.includes("&lt;script&gt;alert(1)&lt;/script&gt; &amp; &quot;david&quot;"));
  assert.match(html, /pointer-events:none/);
  assert.match(html, /background:transparent/);
  assert.ok((html.match(/<span>/g) || []).length >= 100, "tiled across the page");
});

test("only an app that asks for it gets the overlay", () => {
  assert.equal(W.wanted({ watermark: true }), true);
  assert.equal(W.wanted({ watermark: false }), false);
  assert.equal(W.wanted({}), false);
  assert.equal(W.wanted(null), false);
});

test("the overlay covers the page view, in screen coordinates", () => {
  assert.deepEqual(W.screenRect({ x: 100, y: 50, width: 1320, height: 880 }, { x: 220, y: 78, width: 800, height: 760 }), { x: 320, y: 128, width: 800, height: 760 });
  assert.equal(W.screenRect({ x: 0, y: 0, width: 10, height: 10 }, null), null);
  assert.equal(W.screenRect(null, { x: 0, y: 0, width: 10, height: 10 }), null);
  assert.equal(W.screenRect({ x: 0, y: 0, width: 10, height: 10 }, { x: 0, y: 0, width: 0, height: 10 }), null, "a hidden view has no overlay");
});
