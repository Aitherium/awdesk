"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { isOwnWindow, rightNowGroup } = require("./launcher-context.cjs");
const { chatPrompt } = require("./universal-search.cjs");

const code = { ok: true, platform: "win32", app: "Code", title: "main.py - repo", pid: 7 };
const has = (ids) => (id) => ids.includes(id);

test("the empty launcher offers to ask about the foreground window", () => {
  const { group, status } = rightNowGroup(code, has([]));
  assert.equal(group.label, "Right now");
  assert.equal(group.items[0].kind, "agent");
  assert.match(group.items[0].title, /Ask Aither about Code/);
  assert.match(status, /Looking at Code — main\.py/);
});

test("only actions the registry really has are offered", () => {
  const { items } = rightNowGroup(code, has(["snip.region"]));
  assert.deepEqual(items.map((i) => i.key), ["ctx:ask", "ctx:snip.region"]);
});

test("an unreadable host is NO row, and the status says why", () => {
  const { group, status } = rightNowGroup({ ok: false, reason: "Wayland session" }, has(["snip.region"]));
  assert.equal(group, null);
  assert.match(status, /Wayland session/);
});

test("the launcher never offers to ask about ITSELF", () => {
  assert.equal(isOwnWindow({ ok: true, app: "electron", title: "Aither launcher" }), true);
  assert.equal(rightNowGroup({ ok: true, app: "electron", title: "x", pid: 1 }).group, null);
  assert.equal(isOwnWindow(code), false);
});

test("the ask row's prompt reaches chat naming the window", () => {
  const row = rightNowGroup(code).items[0];
  const text = chatPrompt(row.prompt, row);
  assert.match(text, /I'm looking at Code — main\.py - repo/);
  assert.match(text, /agent "aither"/);
});
