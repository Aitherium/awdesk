"use strict";

/* terminal-strip -- the pure half of the awsh terminal strip.
   The page had one chip per daemon session; twelve identical
   "resumed: credential stored" tabs made the strip unreadable. */

const test = require("node:test");
const assert = require("node:assert");

// The strip's contract is the global a classic <script> sets (package.json is
// "type": "module", so requiring the file classifies it as ESM and its
// module.exports is detached). Requiring it still RUNS it, which is what the
// page does.
require("./terminal-strip.js");
const { groupTabs } = globalThis.TerminalStrip;

/** The shape terminal-page.js hands to groupTabs: `{ info }` rows. */
const tab = (id, label) => ({ info: { id, label, harness: "claude", state: "running" } });

test("12 identical labels collapse into ONE group that counts them all", () => {
  const tabs = Array.from({ length: 12 }, (_, i) => tab(`s${i}`, "resumed: credential stored"));
  const groups = groupTabs(tabs);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].label, "resumed: credential stored");
  assert.equal(groups[0].count, 12);
  assert.deepEqual(groups[0].ids, Array.from({ length: 12 }, (_, i) => `s${i}`));
});

test("the strip shows at most 5 slots and folds the rest into +N", () => {
  const tabs = ["a", "b", "c", "d", "e", "f", "g"].map((label, i) => tab(`t${i}`, label));
  const groups = groupTabs(tabs);
  assert.equal(groups.length, 5);
  assert.equal(groups[4].label, "+3");
  assert.deepEqual(groups[4].ids, ["t4", "t5", "t6"]);
  assert.equal(groups[4].count, 3);
  // The page turns THIS chip into "show the rest"; every other chip is a session.
  assert.equal(groups[4].overflow, true);
  assert.deepEqual(groups.slice(0, 4).map((g) => g.overflow), [false, false, false, false]);
});

test("distinct labels keep their order and hide nothing", () => {
  const groups = groupTabs([tab("x", "one"), tab("y", "two")]);
  assert.deepEqual(groups.map((g) => g.label), ["one", "two"]);
  assert.deepEqual(groups.map((g) => g.hidden), [0, 0]);
  assert.deepEqual(groups.map((g) => g.ids), [["x"], ["y"]]);
});

test("a group of many says how many its chip stands in for", () => {
  const groups = groupTabs([tab("a", "same"), tab("b", "same"), tab("c", "same")]);
  assert.equal(groups[0].count, 3);
  assert.equal(groups[0].hidden, 2);
});

test("a custom key and cap are honoured; nothing is ever dropped", () => {
  const groups = groupTabs(
    [tab("a", "x"), tab("b", "y"), tab("c", "z")],
    (t) => t.info.harness,
    1,
  );
  assert.equal(groups.length, 1);
  assert.equal(groups[0].label, "claude");
  assert.equal(groups[0].count, 3);
});

test("bad input never throws and never invents a tab", () => {
  assert.deepEqual(groupTabs(undefined), []);
  assert.deepEqual(groupTabs([]), []);
  const groups = groupTabs([{ info: {} }]);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].label, "untitled");
  assert.equal(groups[0].count, 0);
});
