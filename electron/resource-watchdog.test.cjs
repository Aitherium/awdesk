"use strict";

// Garg, 2026-10-16: Desk's main process reached 6 GB and stopped answering; the customer
// had to kill it from Task Manager. Desk now watches its own memory, reclaims under
// pressure, restarts itself when it is past a hard budget, and a separate watchdog
// process ends a main process that has stopped answering at all.

const test = require("node:test");
const assert = require("node:assert/strict");
const wd = require("./resource-watchdog.cjs");

const MB = 1024; // getAppMetrics reports KB
function metrics(mainMb, otherMb = 100) {
  return [
    { pid: 1, type: "Browser", memory: { privateBytes: mainMb * MB, workingSetSize: mainMb * MB } },
    { pid: 2, type: "GPU", memory: { privateBytes: otherMb * MB, workingSetSize: otherMb * MB } },
  ];
}

test("assess reads private bytes (KB) and grades against the budget", () => {
  const b = wd.BUDGETS.customer;
  assert.deepEqual(wd.assess(metrics(150, 200), b), { mainMb: 150, totalMb: 350, level: "ok" });
  assert.equal(wd.assess(metrics(b.mainSoftMb + 1), b).level, "soft");
  assert.equal(wd.assess(metrics(100, b.totalSoftMb), b).level, "soft");
  assert.equal(wd.assess(metrics(b.mainHardMb + 1), b).level, "hard");
  assert.equal(wd.assess([], b).level, "ok");
});

test("customer budgets meet the targets: the whole desk well under a gigabyte before anything acts", () => {
  assert.ok(wd.BUDGETS.customer.totalSoftMb <= 900);
  assert.ok(wd.BUDGETS.customer.mainHardMb <= 1500);
  assert.ok(wd.BUDGETS.owner.mainHardMb > wd.BUDGETS.customer.mainHardMb);
});

function harness(seq, over = {}) {
  let t = 0;
  let i = 0;
  const calls = [];
  const dog = wd.createWatchdog({
    budget: wd.BUDGETS.customer,
    sample: () => metrics(...seq[Math.min(i++, seq.length - 1)]),
    reclaim: (o) => calls.push(["reclaim", o.pressure]),
    restart: () => calls.push(["restart"]),
    quit: () => calls.push(["quit"]),
    notify: (msg) => calls.push(["notify", msg]),
    now: () => t,
    restartsInLastHour: () => 0,
    ...over,
  });
  return { dog, calls, step: (ms = 15_000) => { t += ms; return dog.tick(); } };
}

test("ok: nothing happens", () => {
  const { calls, step } = harness([[150]]);
  for (let k = 0; k < 10; k += 1) step();
  assert.deepEqual(calls, []);
});

test("soft: reclaim (discard hidden tabs, drop caches), at most once a minute", () => {
  const { calls, step } = harness([[wd.BUDGETS.customer.mainSoftMb + 50]]);
  for (let k = 0; k < 5; k += 1) step(15_000); // t = 15..75 s: reclaims at 15 s and 75 s
  assert.deepEqual(calls.filter((c) => c[0] === "reclaim"), [["reclaim", false], ["reclaim", false]]);
  assert.ok(!calls.some((c) => c[0] === "restart"));
});

test("hard twice in a row: reclaim hard, then restart Desk -- never wait for Task Manager", () => {
  const hard = wd.BUDGETS.customer.mainHardMb + 500;
  const { calls, step } = harness([[hard], [hard], [hard]]);
  step();
  step();
  assert.deepEqual(calls.map((c) => c[0]), ["reclaim", "notify", "restart"]);
});

test("a runaway (main +400 MB inside a minute) restarts without waiting for the hard line", () => {
  const { calls, step } = harness([[200], [500], [800]]);
  step(15_000);
  step(15_000);
  step(15_000);
  assert.ok(calls.some((c) => c[0] === "restart"), JSON.stringify(calls));
});

test("restarted twice in the last hour already: quit instead of looping", () => {
  const hard = wd.BUDGETS.customer.mainHardMb + 500;
  const { calls, step } = harness([[hard]], { restartsInLastHour: () => 2 });
  step();
  step();
  assert.ok(calls.some((c) => c[0] === "quit"));
  assert.ok(!calls.some((c) => c[0] === "restart"));
});

test("hang verdict: a main process silent past the limit is ended", () => {
  assert.equal(wd.hangVerdict({ lastBeatAt: 0, now: 44_000, timeoutMs: 45_000 }), "ok");
  assert.equal(wd.hangVerdict({ lastBeatAt: 0, now: 46_000, timeoutMs: 45_000 }), "kill");
  assert.equal(wd.hangVerdict({ lastBeatAt: null, now: 999_999, timeoutMs: 45_000 }), "ok", "no beat yet: still starting");
});

test("main.cjs starts both watchdogs", () => {
  const src = require("node:fs").readFileSync(require("node:path").join(__dirname, "main.cjs"), "utf8");
  assert.match(src, /startResourceWatchdog\(/);
  assert.match(src, /startHangWatchdog\(/);
});

// ── the hang ladder (2026-11-22: AppHangXProcB1 ended the whole desk) ───────

test("hang action: silent -> restart the GPU child first, end the desk only after the grace", () => {
  const base = { timeoutMs: 45_000, recoverMs: 10_000 };
  assert.equal(wd.hangAction({ ...base, lastBeatAt: 0, now: 44_000 }), "ok");
  assert.equal(wd.hangAction({ ...base, lastBeatAt: 0, now: 46_000 }), "recover");
  assert.equal(wd.hangAction({ ...base, lastBeatAt: 0, now: 49_000, gpuKilledAt: 46_000 }), "wait");
  assert.equal(wd.hangAction({ ...base, lastBeatAt: 0, now: 57_000, gpuKilledAt: 46_000 }), "kill");
  assert.equal(wd.hangAction({ ...base, lastBeatAt: null, now: 999_999 }), "ok", "no beat yet: still starting");
});

test("gpuProcess names the GPU child so the hang ladder can restart it", () => {
  assert.deepEqual(wd.gpuProcess([{ pid: 2, type: "GPU", memory: { privateBytes: 99 * 1024 } }]), { pid: 2, mb: 99 });
  assert.equal(wd.gpuProcess([]), null);
  assert.equal(wd.gpuProcess([{ pid: 9, type: "Browser", memory: {} }]), null);
});

test("startHangWatchdog hands the GPU child's pid to the watchdog on start and every beat", () => {
  const { EventEmitter } = require("node:events");
  const child = new EventEmitter();
  const posts = [];
  child.postMessage = (m) => posts.push(m);
  child.kill = () => {};
  const dog = wd.startHangWatchdog({ utilityProcess: { fork: () => child }, gpuPid: () => 4242, beatMs: 1 });
  assert.equal(posts[0].type, "start");
  assert.equal(posts[0].gpuPid, 4242);
  assert.ok(Number.isFinite(posts[0].recoverMs) && posts[0].recoverMs >= 1000, "the grace rides on start");
  return new Promise((resolve) => setTimeout(() => {
    dog.stop();
    const beats = posts.filter((p) => p.type === "beat");
    assert.ok(beats.length >= 1, "at least one beat fired");
    assert.equal(beats[0].gpuPid, 4242, "the pid rides on every beat");
    resolve();
  }, 30));
});

test("main.cjs gives the hang watchdog the GPU pid and reloads a dead renderer, not the desk", () => {
  const src = require("node:fs").readFileSync(require("node:path").join(__dirname, "main.cjs"), "utf8");
  assert.match(src, /startHangWatchdog\(\s*\{[\s\S]{0,400}?gpuPid:/, "the GPU pid reaches the watchdog");
  assert.match(src, /gpuProcess\(app\.getAppMetrics\(\)\)/, "the pid comes from the real metrics");
  assert.match(src, /render-process-gone[\s\S]{0,400}?webContents\.reload\(\)/, "a dead renderer reloads itself");
});
