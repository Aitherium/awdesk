"use strict";

// fairy-drop.cjs under `node --test`: the corner a drop picks, a followed window
// that moves/resizes/minimises/closes, and the three post-drop modes.

const test = require("node:test");
const assert = require("node:assert/strict");
const drop = require("./fairy-drop.cjs");

const SIZE = { width: 72, height: 72 };
const WIN = { x: 100, y: 200, width: 1000, height: 800 };

test("nearestCorner picks each corner from a drop near it", () => {
  assert.equal(drop.nearestCorner(WIN, { x: 120, y: 220 }), "nw");
  assert.equal(drop.nearestCorner(WIN, { x: 1080, y: 220 }), "ne");
  assert.equal(drop.nearestCorner(WIN, { x: 120, y: 980 }), "sw");
  assert.equal(drop.nearestCorner(WIN, { x: 1080, y: 980 }), "se");
  // A point outside the window still resolves to the closest corner.
  assert.equal(drop.nearestCorner(WIN, { x: 5000, y: -5000 }), "ne");
});

test("dockFor with a drop point docks to that nearest corner, inside the window", () => {
  const sw = drop.dockFor(WIN, SIZE, { dropPoint: { x: 200, y: 900 } });
  assert.equal(sw.corner, "sw");
  assert.deepEqual({ x: sw.x, y: sw.y }, { x: 100 + drop.GAP, y: 200 + 800 - 72 - drop.GAP });
  const ne = drop.dockFor(WIN, SIZE, { dropPoint: { x: 1000, y: 260 } });
  assert.equal(ne.corner, "ne");
  assert.deepEqual({ x: ne.x, y: ne.y }, { x: 100 + 1000 - 72 - drop.GAP, y: 200 + drop.GAP });
  // No drop point: the old default is kept, so existing callers do not move.
  assert.deepEqual(drop.dockFor(WIN, SIZE), { corner: "ne", x: 100 + 1000 - 72 - 14, y: 200 + 14 });
});

test("a remembered corner survives a move and a resize (multi-monitor, negative x)", () => {
  const second = { x: -1920, y: 0, width: 1920, height: 1080 };
  const first = drop.dockFor(second, SIZE, { dropPoint: { x: -1900, y: 1000 } });
  assert.equal(first.corner, "sw");
  // The window moved to another display and doubled in height: same corner.
  const moved = { x: -3000, y: 200, width: 2000, height: 1600 };
  const again = drop.dockFor(moved, SIZE, { corner: first.corner });
  assert.equal(again.corner, "sw");
  assert.equal(again.x, -3000 + 14);
  assert.equal(again.y, 200 + 1600 - 72 - 14);
});

test("a window smaller than the orb centres instead of pushing the fairy outside", () => {
  const tiny = { x: 500, y: 500, width: 60, height: 60 };
  const at = drop.dockFor(tiny, SIZE, { dropPoint: { x: 500, y: 500 } });
  assert.deepEqual({ x: at.x, y: at.y }, { x: 494, y: 494 });
});

test("windowState: live, minimised (off-screen / not visible) and gone (closed)", () => {
  assert.equal(drop.windowState(WIN), "live");
  assert.equal(drop.windowState({ x: -32000, y: -32000, width: 160, height: 28 }), "minimised");
  assert.equal(drop.windowState(WIN, { visible: false }), "minimised");
  assert.equal(drop.windowState(null), "gone");
  assert.equal(drop.windowState({ width: 0, height: 0 }), "gone");
});

test("the timer modes: pin stays, timed returns after N seconds, return is immediate", () => {
  assert.deepEqual(drop.decideDrop({ mode: "pin" }), { mode: "pin", seconds: 10, dock: true, returnAfterMs: null });
  assert.deepEqual(drop.decideDrop({ mode: "timed", seconds: 15 }), { mode: "timed", seconds: 15, dock: true, returnAfterMs: 15000 });
  assert.deepEqual(drop.decideDrop({ mode: "return" }), { mode: "return", seconds: 10, dock: false, returnAfterMs: 0 });
});

test("normalizeDrop clamps seconds and falls back to pin", () => {
  assert.deepEqual(drop.normalizeDrop({ mode: "timed", seconds: 1 }), { mode: "timed", seconds: drop.MIN_SECONDS });
  assert.deepEqual(drop.normalizeDrop({ mode: "timed", seconds: 9999 }), { mode: "timed", seconds: drop.MAX_SECONDS });
  assert.deepEqual(drop.normalizeDrop({ mode: "nonsense" }), { mode: "pin", seconds: drop.DEFAULT_SECONDS });
  assert.deepEqual(drop.normalizeDrop(null), { mode: "pin", seconds: drop.DEFAULT_SECONDS });
});

test("behaviourFor: a per-fairy override wins over the global default", () => {
  const state = { drop: { mode: "timed", seconds: 5 }, dropBy: { slot7: { mode: "pin" } } };
  assert.deepEqual(drop.behaviorFor(state, "slot7"), { mode: "pin", seconds: 10 });
  assert.deepEqual(drop.behaviorFor(state, "orb"), { mode: "timed", seconds: 5 });
  assert.deepEqual(drop.behaviorFor({}, ""), { mode: "pin", seconds: 10 });
  // withBehavior stores one fairy without touching the others.
  const next = drop.withBehavior(state, "orb", { mode: "return" });
  assert.deepEqual(drop.behaviorFor(next, "orb"), { mode: "return", seconds: 10 });
  assert.deepEqual(drop.behaviorFor(next, "slot7"), { mode: "pin", seconds: 10 });
});

test("behaviorLabel speaks the owner's words", () => {
  assert.match(drop.behaviorLabel({ mode: "pin" }), /Pin/);
  assert.match(drop.behaviorLabel({ mode: "timed", seconds: 5 }), /5 seconds/);
  assert.match(drop.behaviorLabel({ mode: "return" }), /home/);
});

test("menuRows offers the three drop answers, only the one in force marked", () => {
  const rows = drop.menuRows({ mode: "timed", seconds: 10 });
  assert.deepEqual(rows.map((r) => r.id), ["fc:drop:pin", "fc:drop:timed:10", "fc:drop:return"]);
  assert.match(rows[1].label, /✓/);
  assert.doesNotMatch(rows[0].label, /✓/);
  assert.doesNotMatch(rows[2].label, /✓/);
});
