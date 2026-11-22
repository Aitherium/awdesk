"use strict";

// avatar-seed-runner: the avatar-library seed runs in its own utility process so its
// 2 GB of model reads never become the desk's main-process heap (2026-11-20).

const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { createSeedRunner } = require("./avatar-seed-runner.cjs");

function fakeChild() {
  const child = new EventEmitter();
  child.posted = [];
  child.postMessage = (msg) => { child.posted.push(msg); };
  child.kill = () => { child.killed = true; child.emit("exit", 0); };
  return child;
}

test("runs the worker once and resolves its result", async () => {
  const child = fakeChild();
  const forks = [];
  const runner = createSeedRunner({
    scriptPath: "worker.cjs",
    fork: (script, args, options) => { forks.push({ script, args, options }); return child; },
  });
  const pending = runner.run();
  assert.equal(forks.length, 1);
  assert.equal(forks[0].script, "worker.cjs");
  assert.equal(forks[0].options.serviceName, "Aither avatar library seed");
  assert.deepEqual(child.posted, [{ type: "seed" }]);
  child.emit("message", { type: "log", message: "avatar library seeded", detail: { uploaded: 2 } });
  child.emit("message", { type: "done", out: { ok: true, uploaded: 2, present: 7 } });
  assert.deepEqual(await pending, { ok: true, uploaded: 2, present: 7 });
  assert.equal(runner.busy(), false);
});

test("a MessageEvent-shaped message ({data}) is understood too", async () => {
  const child = fakeChild();
  const runner = createSeedRunner({ scriptPath: "w", fork: () => child });
  const pending = runner.run();
  child.emit("message", { data: { type: "done", out: { ok: true, uploaded: 0 } } });
  assert.deepEqual(await pending, { ok: true, uploaded: 0 });
});

test("a worker that dies without an answer resolves null, so the in-process seed runs", async () => {
  const child = fakeChild();
  const runner = createSeedRunner({ scriptPath: "w", fork: () => child });
  const pending = runner.run();
  child.emit("exit", 3);
  assert.equal(await pending, null);
  assert.equal(runner.busy(), false);
});

test("a fork that throws resolves null instead of taking the desk down", async () => {
  const runner = createSeedRunner({ scriptPath: "w", fork: () => { throw new Error("no utility process"); } });
  assert.equal(await runner.run(), null);
});

test("a worker that never answers is killed at the timeout", async () => {
  const child = fakeChild();
  const runner = createSeedRunner({ scriptPath: "w", fork: () => child, timeoutMs: 30 });
  const pending = runner.run();
  assert.equal(await pending, null);
  assert.equal(child.killed, true);
});

test("one pass at a time: a second run while busy answers null immediately", async () => {
  const child = fakeChild();
  let made = 0;
  const runner = createSeedRunner({ scriptPath: "w", fork: () => { made += 1; return child; } });
  const first = runner.run();
  assert.equal(await runner.run(), null);
  assert.equal(made, 1);
  child.emit("message", { type: "done", out: { ok: true } });
  assert.deepEqual(await first, { ok: true });
});
