"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const hold = require("./ink-hold.cjs");

function harness() {
  const timers = [];
  const log = [];
  const w = hold.createHoldWatch({
    source: null,
    onHold: () => log.push("hold"),
    onRelease: () => log.push("release"),
    setTimer: (fn, ms) => { const t = { fn, ms, live: true }; timers.push(t); return t; },
    clearTimer: (t) => { if (t) t.live = false; },
    env: {},
  });
  const elapse = () => { for (const t of timers.splice(0)) if (t.live) t.fn(); };
  return { w, log, elapse };
}

test("a hold past HOLD_MS draws; releasing hands the desktop back", () => {
  const { w, log, elapse } = harness();
  w.__feed(true);
  assert.deepEqual(log, [], "nothing before the threshold");
  elapse();
  assert.deepEqual(log, ["hold"]);
  w.__feed(false);
  assert.deepEqual(log, ["hold", "release"]);
});

test("a quick tap of the chord never draws", () => {
  const { w, log, elapse } = harness();
  w.__feed(true);
  w.__feed(false);
  elapse();
  assert.deepEqual(log, []);
});

test("a desk hotkey during the hold is a chord: no hold, or the hold ends at once", () => {
  const a = harness();
  a.w.__feed(true);
  a.w.cancel(); // Ctrl+Alt+Q fired before 250 ms
  a.elapse();
  a.w.__feed(false);
  assert.deepEqual(a.log, []);
  const b = harness();
  b.w.__feed(true);
  b.elapse();
  b.w.cancel(); // fired after the hold began
  b.w.__feed(false);
  assert.deepEqual(b.log, ["hold", "release"], "exactly one release");
});

test("the chord is configurable and can be turned off", () => {
  assert.equal(hold.chordFromEnv({}), "ctrl+alt");
  assert.equal(hold.chordFromEnv({ AWDESK_INK_HOLD: "Ctrl+Shift" }), "ctrl+shift");
  assert.equal(hold.chordFromEnv({ AWDESK_INK_HOLD: "off" }), null);
  assert.equal(hold.chordFromEnv({ AWDESK_INK_HOLD: "bogus" }), "ctrl+alt");
  assert.equal(hold.createHoldWatch({ env: { AWDESK_INK_HOLD: "off" }, onHold() {}, onRelease() {} }).state().active, false);
});

test("the poller script reads key STATE only (GetAsyncKeyState), watches its parent, and prints 0/1", () => {
  const s = hold.pollerScript("ctrl+alt", 4242);
  assert.match(s, /GetAsyncKeyState\(17\)/);
  assert.match(s, /GetAsyncKeyState\(18\)/);
  assert.match(s, /GetProcessById\(4242\)/);
  assert.match(s, /HasExited\) \{ exit 0 \}/);
  assert.doesNotMatch(s, /SetWindowsHookEx|ReadKey|GetKeyboardState/, "no hook, no key stream");
  assert.equal(hold.powershellSource({ platform: "linux" }), null);
});
