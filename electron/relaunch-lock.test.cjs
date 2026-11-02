"use strict";

// 2026-11-01: "Restart Aither" left no desk twice -- the relaunched process saw the
// old one's single-instance lock and quit. These pin the retry and its bounds.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { RELAUNCH_FLAG, singleInstanceLock } = require("./relaunch-lock.cjs");

function fakeApp(freeAfterCalls) {
  let calls = 0;
  return { requestSingleInstanceLock: () => (calls += 1) > freeAfterCalls, get calls() { return calls; } };
}

function clock() {
  let t = 0;
  return { now: () => t, sleep: (ms) => { t += ms; } };
}

test("a free lock is taken at once, flag or not", () => {
  const app = fakeApp(0);
  assert.equal(singleInstanceLock(app, []), true);
  assert.equal(app.calls, 1);
});

test("a second launch WITHOUT the flag hands over at once (no waiting)", () => {
  const app = fakeApp(Infinity);
  const c = clock();
  assert.equal(singleInstanceLock(app, ["desk"], c), false);
  assert.equal(app.calls, 1);
});

test("a relaunch waits for the old process to release the lock", () => {
  const app = fakeApp(5); // the old desk lets go on the 6th try
  const c = clock();
  assert.equal(singleInstanceLock(app, ["desk", RELAUNCH_FLAG], { ...c, retryMs: 200, waitMs: 10_000 }), true);
  assert.equal(app.calls, 6);
});

test("a relaunch gives up after waitMs when the old desk never exits", () => {
  const app = fakeApp(Infinity);
  const c = clock();
  assert.equal(singleInstanceLock(app, [RELAUNCH_FLAG], { ...c, retryMs: 200, waitMs: 1_000 }), false);
  assert.ok(app.calls <= 7, `bounded tries, got ${app.calls}`);
});

test("restartDesk relaunches WITH the flag, and the lock check uses the helper", () => {
  const src = fs.readFileSync(path.join(__dirname, "main.cjs"), "utf8");
  assert.match(src, /app\.relaunch\(\{ args: \[\.\.\.process\.argv\.slice\(1\)\.filter\(\(a\) => a !== RELAUNCH_FLAG\), RELAUNCH_FLAG\] \}\)/);
  assert.match(src, /if \(!smokeIsRequested && !singleInstanceLock\(app, process\.argv\)\) \{/);
});
