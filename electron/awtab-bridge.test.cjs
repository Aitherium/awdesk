"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { createAwtabBridge } = require("./awtab-bridge.cjs");

const snap = (extra = {}) => ({
  browser: "chrome",
  profile: "Default",
  at: 1,
  windows: [{ id: 1, active: true, tabs: [{ id: "a", url: "https://github.com/a", title: "A", active: true, index: 0, groupId: 3 }] }],
  groups: [{ id: 3, windowId: 1, title: "GitHub", color: "blue" }],
  ...extra,
});

test("a push becomes groups, is applied, and the status carries counts only", () => {
  const seen = [];
  const bridge = createAwtabBridge({ apply: (groups, ctx) => { seen.push({ groups, ctx }); return { ok: true }; } });
  const r = bridge.push(snap());
  assert.equal(r.ok, true);
  assert.equal(r.groups, 1);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].groups[0].name, "GitHub");
  assert.equal(seen[0].ctx.browser, "chrome");
  const status = bridge.status();
  assert.deepEqual(status.browsers.map((b) => [b.browser, b.groups, b.tabs]), [["chrome", 1, 1]]);
  assert.ok(!JSON.stringify(status).includes("github.com/a"), "status never leaks URLs");
});

test("a disabled browser is acknowledged and mirrors nothing", () => {
  const seen = [];
  const bridge = createAwtabBridge({ apply: (g) => seen.push(g), enabled: () => false });
  const r = bridge.push(snap());
  assert.equal(r.ok, true);
  assert.equal(r.skipped, true);
  assert.equal(r.groups, 0);
  assert.deepEqual(seen.at(-1), [], "the mirror is cleared");
});

test("a snapshot that is not ours is refused, never applied", () => {
  const bridge = createAwtabBridge({ apply: () => assert.fail("must not apply") });
  assert.equal(bridge.push({ browser: "netscape" }).ok, false);
  assert.equal(bridge.push(null).ok, false);
});

test("commands ride the next push, per browser", () => {
  const bridge = createAwtabBridge({ apply: () => ({}) });
  bridge.push(snap());
  bridge.queue("refresh", "chrome");
  const r = bridge.push(snap());
  assert.deepEqual(r.commands, ["refresh"]);
  assert.deepEqual(bridge.push(snap()).commands, [], "delivered once");
});

test("forget removes one group and re-applies the rest; drop clears a whole browser", () => {
  const applied = [];
  const bridge = createAwtabBridge({ apply: (g, ctx) => applied.push({ g, ctx }) });
  bridge.push(snap());
  const key = bridge.groups()[0].key;
  assert.equal(bridge.forget(key).ok, true);
  assert.equal(bridge.groups().length, 0);
  assert.deepEqual(applied.at(-1).g, []);
  bridge.push(snap());
  assert.equal(bridge.drop("chrome").ok, true);
  assert.equal(bridge.status().total, 0);
});
