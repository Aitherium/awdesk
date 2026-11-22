"use strict";

// Every Aither Browser tab kept a live renderer for as long as it existed, hidden or not.
// A hidden owner web tab is now DISCARDED (its renderer closed, its address kept) after it
// has sat unseen for a while, or at once under memory pressure, and reloads when shown.

const test = require("node:test");
const assert = require("node:assert/strict");
const { pickDiscards, IDLE_MS, KEEP_LIVE } = require("./tab-discard.cjs");

const MIN = 60_000;
const NOW = 100 * MIN;

function tab(id, over = {}) {
  return { id, by: "you", kind: "web", pinned: false, active: false, popped: false, audible: false, discarded: false,
    shownAt: NOW - 30 * MIN, ...over };
}

test("a hidden web tab unseen for longer than the idle limit is discarded; the one on screen never is", () => {
  const out = pickDiscards([tab(1, { active: true, shownAt: NOW - 60 * MIN }), tab(2), tab(3, { shownAt: NOW - MIN })], { now: NOW });
  assert.deepEqual(out, [2]);
});

test("pinned, popped-out, playing, agent-driven and Aither pages are never discarded", () => {
  const out = pickDiscards([
    tab(1, { pinned: true }), tab(2, { popped: true }), tab(3, { audible: true }),
    tab(4, { by: "agent" }), tab(5, { kind: "internal" }), tab(6, { discarded: true }), tab(7, { kind: "hosted" }),
  ], { now: NOW });
  assert.deepEqual(out, [7], "a hosted (signed-in aitherium) tab reloads fine");
});

test("more than KEEP_LIVE hidden tabs: the oldest go even before the idle limit (but never one seen in the last minute)", () => {
  const tabs = [tab(1, { active: true })];
  for (let i = 2; i <= 9; i += 1) tabs.push(tab(i, { shownAt: NOW - i * 30_000 }));
  const out = pickDiscards(tabs, { now: NOW, idleMs: 60 * MIN });
  assert.equal(tabs.length - 1 - out.length, KEEP_LIVE);
  assert.ok(!out.includes(2), "the most recent hidden tab stays");
  assert.ok(out.includes(9), "the oldest goes");
});

test("memory pressure discards every eligible hidden tab not seen in the last 30 s", () => {
  const out = pickDiscards([tab(1, { active: true }), tab(2, { shownAt: NOW - 40_000 }), tab(3, { shownAt: NOW - 10_000 })],
    { now: NOW, pressure: true, idleMs: 60 * MIN });
  assert.deepEqual(out, [2]);
});

test("defaults are bounded", () => {
  assert.ok(IDLE_MS <= 15 * MIN);
  assert.ok(KEEP_LIVE <= 4);
  assert.deepEqual(pickDiscards(null, { now: NOW }), []);
});

test("browser-window restores a discarded tab when it is shown and wires the discard", () => {
  const src = require("node:fs").readFileSync(require("node:path").join(__dirname, "browser-window.cjs"), "utf8");
  assert.match(src, /require\("\.\/tab-discard\.cjs"\)/);
  const layout = src.slice(src.indexOf("function layout() {"), src.indexOf("function currentRects() {"));
  assert.match(layout, /restoreDiscarded\(tabs\.active\)/, "the tab put on screen is brought back first");
  assert.match(src, /function discardHiddenTabs\(/);
});
