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
  // The original leak grew ~5 GB/min from an already-big desk: the floor is crossed
  // before the growth is counted, so this is still a runaway.
  const { calls, step } = harness([[wd.RUNAWAY_FLOOR_MB], [wd.RUNAWAY_FLOOR_MB + 450]]);
  step(15_000);
  step(15_000);
  assert.ok(calls.some((c) => c[0] === "restart"), JSON.stringify(calls));
});

test("a start-up/bulk ramp from a small main process is NOT a runaway (2026-11-20)", () => {
  // Measured on 0.1.35: the avatar-library seed carried main 150 -> 655 MB in a pass.
  // That restarted the desk twice and then (restart cap) quit it. It is not the leak.
  const { calls, step } = harness([[150], [420], [650], [660]]);
  for (let k = 0; k < 4; k += 1) step(15_000);
  assert.ok(!calls.some((c) => c[0] === "restart" || c[0] === "quit"), JSON.stringify(calls));
});

test("hold: deliberate bulk work reclaims but never restarts or quits", () => {
  const hard = wd.BUDGETS.customer.mainHardMb + 500;
  const { calls, step } = harness([[hard], [hard], [hard]], { hold: () => "avatar library seed" });
  step();
  step();
  step();
  assert.ok(!calls.some((c) => c[0] === "restart" || c[0] === "quit"), JSON.stringify(calls));
  assert.ok(calls.some((c) => c[0] === "reclaim"), "still reclaims while held");
});

test("hold is released: the same desk is restarted once the bulk work ends", () => {
  const hard = wd.BUDGETS.customer.mainHardMb + 500;
  let busy = true;
  const { calls, step } = harness([[hard], [hard], [hard]], { hold: () => (busy ? "seed" : false) });
  step();
  step();
  busy = false;
  step();
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
  // Silent past the limit, cheap cure not tried yet.
  assert.equal(wd.hangAction({ ...base, lastBeatAt: 0, now: 46_000 }), "recover");
  // GPU child restarted 3 s ago: give the main thread its grace.
  assert.equal(wd.hangAction({ ...base, lastBeatAt: 0, now: 49_000, gpuKilledAt: 46_000 }), "wait");
  // Still silent past the grace: the block is not the GPU child.
  assert.equal(wd.hangAction({ ...base, lastBeatAt: 0, now: 57_000, gpuKilledAt: 46_000 }), "kill");
  // No beat yet: still starting, never act.
  assert.equal(wd.hangAction({ ...base, lastBeatAt: null, now: 999_999 }), "ok");
});

test("startHangWatchdog hands the GPU child's pid to the watchdog on start and every beat", () => {
  const { EventEmitter } = require("node:events");
  const child = new EventEmitter();
  const posts = [];
  child.postMessage = (m) => posts.push(m);
  child.kill = () => {};
  const utilityProcess = { fork: () => child };
  const dog = wd.startHangWatchdog({ utilityProcess, gpuPid: () => 4242, beatMs: 1 });
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

// ── the GPU child guard (2026-11-07: the GPU process reached 9.2 GB) ────────

test("gpuVerdict names the GPU child and only asks to kill it past the line", () => {
  const below = wd.gpuVerdict(metrics(200, wd.GPU_LIMIT_MB - 1));
  assert.deepEqual(below, { pid: 2, mb: wd.GPU_LIMIT_MB - 1, kill: false });
  const above = wd.gpuVerdict(metrics(200, wd.GPU_LIMIT_MB + 1));
  assert.equal(above.pid, 2);
  assert.equal(above.kill, true);
  assert.deepEqual(wd.gpuVerdict([]), { pid: 0, mb: 0, kill: false });
  assert.deepEqual(wd.gpuVerdict([{ pid: 9, type: "Browser", memory: { privateBytes: 99 * MB } }]),
    { pid: 0, mb: 0, kill: false }, "never acts on a process it cannot identify");
});

function gpuHarness(seq) {
  let t = 0;
  let i = 0;
  const killed = [];
  const guard = wd.createGpuGuard({
    sample: () => metrics(200, seq[Math.min(i++, seq.length - 1)]),
    kill: (pid) => killed.push(pid),
    now: () => t,
    log: () => {},
  });
  return { guard, killed, step: (ms = 15_000) => { t += ms; return guard.tick(); } };
}

test("gpu guard kills the GPU child once per pid, and only the GPU child", () => {
  const { killed, step } = gpuHarness([wd.GPU_LIMIT_MB + 500, wd.GPU_LIMIT_MB + 500, 100]);
  const first = step();
  assert.equal(first.action, "killed");
  assert.deepEqual(killed, [2]);
  assert.equal(step().action, "already", "a stale sample cannot kill the same pid twice");
  assert.equal(killed.length, 1);
});

test("gpu guard cools down before killing a fresh GPU process, then kills it", () => {
  let t = 0;
  let pid = 2;
  let mb = wd.GPU_LIMIT_MB + 500;
  const killed = [];
  const guard = wd.createGpuGuard({
    sample: () => [{ pid, type: "Browser", memory: { privateBytes: 200 * MB } },
      { pid, type: "GPU", memory: { privateBytes: mb * MB } }],
    kill: (p) => killed.push(p),
    now: () => t,
    log: () => {},
  });
  assert.equal(guard.tick().action, "killed");
  pid = 3; // Electron respawned it and it ballooned within the cooldown
  t += 30_000;
  assert.equal(guard.tick().action, "cooldown");
  assert.equal(killed.length, 1);
  t += wd.GPU_COOLDOWN_MS;
  assert.equal(guard.tick().action, "killed");
  assert.deepEqual(killed, [2, 3]);
});

test("gpu guard stops after the hourly cap", () => {
  let t = 0;
  let pid = 10;
  const killed = [];
  const guard = wd.createGpuGuard({
    sample: () => [{ pid, type: "GPU", memory: { privateBytes: (wd.GPU_LIMIT_MB + 1) * MB } }],
    kill: (p) => killed.push(p),
    now: () => t,
    cooldownMs: 1, // all of these fall inside one hour
    log: () => {},
  });
  for (let k = 0; k < wd.GPU_MAX_KILLS_PER_HOUR + 2; k += 1) {
    guard.tick();
    pid += 1;
    t += 2;
  }
  assert.equal(killed.length, wd.GPU_MAX_KILLS_PER_HOUR);
  assert.equal(guard.kills().length, wd.GPU_MAX_KILLS_PER_HOUR);
});

test("the watchdog wiring starts the GPU guard too", () => {
  const calls = [];
  const app = {
    getPath: () => require("node:os").tmpdir(),
    getAppMetrics: () => [{ pid: 7, type: "GPU", memory: { privateBytes: (wd.GPU_LIMIT_MB + 1) * MB } }],
    relaunch: () => calls.push("relaunch"),
    exit: () => calls.push("exit"),
  };
  const w = wd.startResourceWatchdog({
    app, posture: { customer: false }, reclaim: () => {}, notify: () => {}, log: () => {},
    intervalMs: 60_000,
  });
  assert.equal(typeof w.gpuTick, "function");
  const verdict = w.gpuTick();
  assert.equal(verdict.kill, true);
  w.stop();
});
