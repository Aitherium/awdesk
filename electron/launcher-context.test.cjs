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

const { needsYouGroup } = require("./launcher-context.cjs");

function cardRow(id, extra = {}) {
  return {
    id,
    title: `Card ${id}`,
    kind: "decision",
    urgency: "normal",
    summary: "",
    defaultKey: "",
    needsYou: false,
    stale: false,
    options: [{ index: 1, key: "ack", label: "Ack", recommended: true }],
    ...extra,
  };
}

test("the empty launcher leads with the open cards, in the order it was given", () => {
  const { group, items } = needsYouGroup([cardRow("d-b"), cardRow("d-a")]);
  assert.equal(group.id, "needs-you");
  assert.equal(group.label, "Needs you", "the count is the badge, not the label");
  assert.equal(group.total, 2);
  assert.deepEqual(items.map((i) => i.key), ["card:d-b", "card:d-a"], "no second ranking");
  assert.equal(items[0].kind, "card");
  assert.equal(items[0].target, "d-b");
});

test("needsYouGroup caps the glance and reports the real remainder", () => {
  const rows = [1, 2, 3, 4, 5, 6, 7, 8].map((n) => cardRow(`d-${n}`));
  const { group } = needsYouGroup(rows);
  // Collapsed the overlay draws `shown` (5); expanding it draws `items`, which
  // is the same rows plus the rest -- never a different set, so no row moves.
  assert.equal(group.shown.length, 5);
  assert.equal(group.items.length, 8, "expanding a glance of 8 shows all 8");
  assert.equal(group.shown[0].key, group.items[0].key);
  assert.equal(group.total, 8);
  assert.equal(group.more, 3, "no fake 'N more' -- the exact count");
  // A store far larger than the overlay can draw stays bounded.
  const many = Array.from({ length: 300 }, (_, i) => cardRow(`d-${i}`));
  const big = needsYouGroup(many).group;
  assert.equal(big.items.length, 40, "the overlay never builds the whole store");
  assert.equal(big.total, 300);
  assert.equal(big.more, 295);
});

test("a credential card says so, and a recommendation comes through", () => {
  const { items } = needsYouGroup([
    cardRow("d-c", { kind: "credential", needsYou: true, summary: "Proton Bridge", options: [
      { index: 1, key: "paste", label: "I pasted it", recommended: true },
      { index: 2, key: "later", label: "Not now" },
    ] }),
  ]);
  assert.match(items[0].subtitle, /credential/);
  assert.match(items[0].subtitle, /2 options/);
  assert.match(items[0].subtitle, /Proton Bridge/);
  assert.equal(items[0].defaultKey, "");
  assert.equal(items[0].options[0].recommended, true);
});

test("no open cards is no group at all, never an empty heading", () => {
  assert.equal(needsYouGroup([]).group, null);
  assert.equal(needsYouGroup(null).group, null);
  assert.equal(needsYouGroup([{ title: "no id" }]).group, null);
});

test("fairyGroup: one 'Ask the fairy about' row while a nudge is up, nothing when none is", () => {
  const { fairyGroup } = require("./launcher-context.cjs");
  const built = fairyGroup({ id: "d-abc1", title: "Claude Code needs you: Desktop canvas layout" });
  assert.equal(built.items.length, 1);
  const row = built.group.shown[0];
  assert.equal(row.key, "fairy:d-abc1");
  assert.equal(row.kind, "fairy");
  assert.equal(row.title, "Ask the fairy about: Desktop canvas layout");
  assert.equal(built.group.id, "fairy");
  assert.equal(fairyGroup(null).group, null, "no nudge: the empty box is exactly as before");
  assert.equal(fairyGroup({ title: "no id" }).group, null);
  assert.ok(fairyGroup({ id: "d-x2", title: "x".repeat(200) }).items[0].title.length < 90, "the row stays one line");
});
