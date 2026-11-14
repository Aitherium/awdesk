"use strict";

// Every Aither Browser tab kept a live renderer for as long as it existed, hidden or not.
// A hidden owner web tab is DISCARDED (its renderer closed, its address kept) after it
// has sat unseen for a long while, or at once under memory pressure, and reloads when
// shown. The first limits (10 minutes, 3 kept live) reloaded pages the owner had only
// just left; they are now about two hours and twelve, and a site that may notify, a
// page with the camera or microphone and a page with unsaved input are never discarded.

const test = require("node:test");
const assert = require("node:assert/strict");
const vm = require("node:vm");
const { pickDiscards, discardUnlessUnsaved, keepReason, IDLE_MS, KEEP_LIVE, MIN_HIDDEN_MS, UNSAVED_SCRIPT } = require("./tab-discard.cjs");

const MIN = 60_000;
const NOW = 1000 * MIN;

function tab(id, over = {}) {
  return { id, by: "you", kind: "web", pinned: false, active: false, popped: false, audible: false, discarded: false,
    shownAt: NOW - 3 * 60 * MIN, ...over };
}

test("a hidden web tab unseen for longer than the idle limit is discarded; the one on screen never is", () => {
  const out = pickDiscards([tab(1, { active: true, shownAt: NOW - 5 * 60 * MIN }), tab(2), tab(3, { shownAt: NOW - 30 * MIN })], { now: NOW });
  assert.deepEqual(out, [2], "30 minutes hidden is not idle any more");
});

test("pinned, popped-out, playing, agent-driven and Aither pages are never discarded", () => {
  const out = pickDiscards([
    tab(1, { pinned: true }), tab(2, { popped: true }), tab(3, { audible: true }),
    tab(4, { by: "agent" }), tab(5, { kind: "internal" }), tab(6, { discarded: true }), tab(7, { kind: "hosted" }),
  ], { now: NOW });
  assert.deepEqual(out, [7], "a hosted (signed-in aitherium) tab reloads fine");
});

test("more than KEEP_LIVE hidden tabs: the oldest go before the idle limit, but never one seen in the last ten minutes", () => {
  const tabs = [tab(1, { active: true })];
  for (let i = 2; i <= KEEP_LIVE + 6; i += 1) tabs.push(tab(i, { shownAt: NOW - i * 10 * MIN }));
  const out = pickDiscards(tabs, { now: NOW, idleMs: 24 * 60 * MIN });
  assert.equal(tabs.length - 1 - out.length, KEEP_LIVE);
  assert.ok(!out.includes(2), "the most recent hidden tab stays");
  assert.ok(out.includes(KEEP_LIVE + 6), "the oldest goes");
  // All seen in the last ten minutes: over the limit, yet none goes.
  const fresh = [tab(1, { active: true })];
  for (let i = 2; i <= KEEP_LIVE + 6; i += 1) fresh.push(tab(i, { shownAt: NOW - 5 * MIN }));
  assert.deepEqual(pickDiscards(fresh, { now: NOW }), []);
});

test("twelve hidden tabs an hour old all stay live (the old limits discarded nine of them)", () => {
  const tabs = [tab(1, { active: true })];
  for (let i = 2; i <= 13; i += 1) tabs.push(tab(i, { shownAt: NOW - 60 * MIN }));
  assert.deepEqual(pickDiscards(tabs, { now: NOW }), []);
});

test("memory pressure discards every eligible hidden tab not seen in the last 30 s", () => {
  const out = pickDiscards([tab(1, { active: true }), tab(2, { shownAt: NOW - 40_000 }), tab(3, { shownAt: NOW - 10_000 })],
    { now: NOW, pressure: true, idleMs: 60 * MIN });
  assert.deepEqual(out, [2]);
});

test("a site the owner allowed to notify is never discarded, idle or under pressure", () => {
  const tabs = [tab(1, { active: true }), tab(2, { notifies: true }), tab(3)];
  assert.deepEqual(pickDiscards(tabs, { now: NOW }), [3]);
  assert.deepEqual(pickDiscards(tabs, { now: NOW, pressure: true }), [3]);
  assert.equal(keepReason(tabs[1]), "notifies");
});

test("a tab with the camera or the microphone is never discarded, idle or under pressure", () => {
  const tabs = [tab(1, { active: true }), tab(2, { capturing: true }), tab(3)];
  assert.deepEqual(pickDiscards(tabs, { now: NOW }), [3]);
  assert.deepEqual(pickDiscards(tabs, { now: NOW, pressure: true }), [3]);
  assert.equal(keepReason(tabs[1]), "capturing");
});

test("a tab known to hold unsaved input is never discarded, and an exempt tab does not count against the live limit", () => {
  const tabs = [tab(1, { active: true }), tab(2, { unsaved: true }), tab(3)];
  assert.deepEqual(pickDiscards(tabs, { now: NOW }), [3]);
  assert.deepEqual(pickDiscards(tabs, { now: NOW, pressure: true }), [3]);
  assert.equal(keepReason(tabs[1]), "unsaved");
  assert.equal(keepReason(tabs[2]), null);
  // KEEP_LIVE ordinary tabs plus five exempt ones, all an hour old: nothing goes.
  const many = [tab(1, { active: true })];
  for (let i = 2; i <= KEEP_LIVE + 1; i += 1) many.push(tab(i, { shownAt: NOW - 60 * MIN }));
  for (let i = 100; i < 105; i += 1) many.push(tab(i, { shownAt: NOW - 60 * MIN, notifies: true }));
  assert.deepEqual(pickDiscards(many, { now: NOW }), []);
});

test("the page is asked about unsaved input once, right before its discard, and is kept when it says yes", async () => {
  const asked = [];
  const gone = [];
  const result = await discardUnlessUnsaved([4, 5, 6, 7], async (id) => {
    asked.push(id);
    if (id === 5) return true;
    if (id === 6) throw new Error("renderer gone");
    return id === 7 ? "yes" : false; // only a real `true` keeps a tab
  }, (id) => gone.push(id));
  assert.deepEqual(asked, [4, 5, 6, 7]);
  assert.deepEqual(gone, [4, 6, 7], "the page that cannot answer has nothing to lose");
  assert.deepEqual(result, { discarded: [4, 6, 7], kept: [5] });
  assert.deepEqual(await discardUnlessUnsaved(null, async () => true, () => { throw new Error("never"); }), { discarded: [], kept: [] });
});

/** Run UNSAVED_SCRIPT against a stand-in document. */
function unsaved({ fields = [], active = null } = {}) {
  const document = { querySelectorAll: () => fields, activeElement: active };
  return vm.runInNewContext(UNSAVED_SCRIPT, { document });
}
const field = (over = {}) => ({ tagName: "INPUT", disabled: false, readOnly: false, value: "", defaultValue: "", getAttribute: () => over.type ?? "text", ...over });

test("the unsaved-input check: typed text counts; untouched, password, hidden, search and read-only fields do not", () => {
  assert.equal(unsaved(), false);
  assert.equal(unsaved({ fields: [field({ value: "Dear Anna," })] }), true);
  assert.equal(unsaved({ fields: [field({ tagName: "TEXTAREA", value: "a draft", getAttribute: () => null })] }), true);
  assert.equal(unsaved({ fields: [field({ value: "prefilled", defaultValue: "prefilled" })] }), false, "the value the page loaded with");
  assert.equal(unsaved({ fields: [field({ value: "   " })] }), false);
  assert.equal(unsaved({ fields: [field({ type: "password", value: "hunter2" })] }), false);
  assert.equal(unsaved({ fields: [field({ type: "hidden", value: "token" })] }), false);
  assert.equal(unsaved({ fields: [field({ type: "search", value: "shoes" })] }), false);
  assert.equal(unsaved({ fields: [field({ type: "checkbox", value: "on" })] }), false);
  assert.equal(unsaved({ fields: [field({ value: "x", readOnly: true })] }), false);
  assert.equal(unsaved({ fields: [field({ value: "x", disabled: true })] }), false);
});

test("the unsaved-input check: an editor with the focus and text in it counts; an empty or unfocused one does not", () => {
  assert.equal(unsaved({ active: { isContentEditable: true, textContent: "Meeting notes" } }), true);
  assert.equal(unsaved({ active: { isContentEditable: true, textContent: " \n" } }), false);
  assert.equal(unsaved({ active: { isContentEditable: false, textContent: "body text" } }), false);
  assert.equal(vm.runInNewContext(UNSAVED_SCRIPT, { document: { querySelectorAll: () => { throw new Error("boom"); } } }), false, "a broken page has nothing to lose");
});

test("defaults: about two hours idle, twelve kept live, never one seen in the last ten minutes", () => {
  assert.equal(IDLE_MS, 120 * MIN);
  assert.equal(KEEP_LIVE, 12);
  assert.equal(MIN_HIDDEN_MS, 10 * MIN);
  assert.deepEqual(pickDiscards(null, { now: NOW }), []);
});

test("browser-window restores a discarded tab when it is shown and wires the discard", () => {
  const src = require("node:fs").readFileSync(require("node:path").join(__dirname, "browser-window.cjs"), "utf8");
  assert.match(src, /require\("\.\/tab-discard\.cjs"\)/);
  const layout = src.slice(src.indexOf("function layout() {"), src.indexOf("function currentRects() {"));
  assert.match(layout, /restoreDiscarded\(tabs\.active\)/, "the tab put on screen is brought back first");
  assert.match(src, /function discardHiddenTabs\(/);
  const discard = src.slice(src.indexOf("function discardHiddenTabs("), src.indexOf("function restoreDiscarded("));
  assert.match(discard, /tabDiscard\.discardUnlessUnsaved\(picked, pageHasUnsaved,/, "every discard goes through the unsaved-input check");
  assert.match(src, /isolated\(view\.webContents, tabDiscard\.UNSAVED_SCRIPT\)/, "asked in the isolated world");
  assert.match(src, /notifies:/);
  assert.match(src, /capturing:/);
});
