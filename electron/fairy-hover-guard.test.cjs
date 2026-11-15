"use strict";

// fairy-hover-guard: the fairy's tip hides itself and its windows go back to
// click-through, whatever the page reports (owner 2026-11-14: "these little tooltips
// get stuck and stay in the way constantly").

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { createHoverGuard } = require("./fairy-hover-guard.cjs");

function harness(opts = {}) {
  const timers = [];
  const ticks = [];
  let cursor = { x: 500, y: 400 };
  const calls = { hidden: 0, through: [], released: [] };
  const guard = createHoverGuard({
    cursor: () => cursor,
    hideTip: () => { calls.hidden += 1; },
    setClickThrough: (key, through) => calls.through.push([key, through]),
    released: (key) => calls.released.push(key),
    setTimer: (fn, ms) => { const t = { fn, ms, live: true }; timers.push(t); return t; },
    clearTimer: (t) => { if (t) t.live = false; },
    setTick: (fn, ms) => { const t = { fn, ms, live: true }; ticks.push(t); return t; },
    clearTick: (t) => { if (t) t.live = false; },
    ...opts,
  });
  return {
    guard, calls, timers, ticks,
    move(x, y) { cursor = { x, y }; },
    fire() { for (const t of timers.filter((x) => x.live)) { t.live = false; t.fn(); } },
    tick() { for (const t of ticks.filter((x) => x.live)) t.fn(); },
    polling() { return ticks.some((t) => t.live); },
  };
}

test("a tip hides on its own after the timeout, even if the pointer never moves", () => {
  const h = harness();
  h.guard.tipShown({ x: 500, y: 400 });
  assert.equal(h.timers[0].ms, 4000);
  assert.equal(h.calls.hidden, 0);
  h.fire();
  assert.equal(h.calls.hidden, 1, "auto-hidden");
  assert.equal(h.guard.state().tip, null);
  assert.equal(h.polling(), false, "nothing to watch: no timer left running");
});

test("a tip hides as soon as the pointer leaves its fairy, without any mouseleave", () => {
  const h = harness();
  h.guard.tipShown({ x: 500, y: 400 });
  h.move(510, 405);
  h.tick();
  assert.equal(h.calls.hidden, 0, "a small wobble on the fairy keeps it");
  h.move(700, 400);
  h.tick();
  assert.equal(h.calls.hidden, 1);
});

test("one tip at a time: a new tip replaces the old one and its timer", () => {
  const h = harness();
  h.guard.tipShown({ x: 500, y: 400 });
  h.guard.tipShown({ x: 520, y: 400 });
  assert.equal(h.timers.filter((t) => t.live).length, 1);
  assert.deepEqual(h.guard.state().tip, { x: 520, y: 400 });
});

test("click-through while no fairy is hovered: a held window is given back when the pointer is off it", () => {
  const h = harness();
  const rect = { x: 460, y: 360, width: 72, height: 72 };
  h.guard.hit("orb", true, () => rect);
  assert.deepEqual(h.calls.through.pop(), ["orb", false], "the pointer on the fairy: clickable");
  h.tick();
  assert.deepEqual(h.guard.state().held, ["orb"], "still on it: kept");
  h.move(900, 900); // left, and the page never said so
  h.tick();
  assert.deepEqual(h.calls.through.pop(), ["orb", true], "back to click-through");
  assert.deepEqual(h.calls.released, ["orb"], "the page is told to re-arm its hover");
  assert.equal(h.polling(), false);
});

test("the page letting go is click-through at once and needs no reset back", () => {
  const h = harness();
  h.guard.hit("swarm", true, () => ({ x: 0, y: 0, width: 10, height: 10 }));
  h.guard.hit("swarm", false);
  assert.deepEqual(h.calls.through.pop(), ["swarm", true]);
  assert.deepEqual(h.calls.released, []);
  // A stray "not inside" for a window never held is still click-through.
  h.guard.hit("orb", false);
  assert.deepEqual(h.calls.through.pop(), ["orb", true]);
});

test("release drops the tip and hands every window back", () => {
  const h = harness();
  h.guard.tipShown({ x: 1, y: 1 });
  h.guard.hit("orb", true, () => ({ x: 0, y: 0, width: 72, height: 72 }));
  h.guard.hit("swarm", true, () => ({ x: 0, y: 0, width: 200, height: 200 }));
  h.guard.release();
  assert.equal(h.calls.hidden, 1);
  assert.deepEqual(h.guard.state(), { tip: null, held: [], polling: false });
  assert.deepEqual(h.calls.released.sort(), ["orb", "swarm"]);
});

test("an unreadable cursor or a vanished window never throws out of the poll", () => {
  const h = harness({ cursor: () => { throw new Error("no screen"); } });
  h.guard.hit("orb", true, () => { throw new Error("destroyed"); });
  assert.doesNotThrow(() => h.tick());
});
