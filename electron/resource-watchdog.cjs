"use strict";

/**
 * resource-watchdog -- Desk keeps its own weight bounded, and never needs Task Manager.
 *
 * Garg, 2026-10-16: Desk's main process grew to 6 GB in a layout loop, its tray stopped
 * answering, and the customer had to end it from Task Manager. Two guards now:
 *
 *   memory   every 15 s Desk sums its own processes (app.getAppMetrics, private bytes):
 *              soft  -> reclaim: discard hidden browser tabs, drop HTTP caches (<= 1/min)
 *              hard  twice in a row, or the main process +400 MB inside a minute
 *                    -> reclaim under pressure, tell the user, RESTART Desk
 *              more than 2 restarts in an hour -> quit instead of looping
 *   hang     a small utility process (hang-watchdog-child.cjs) receives a heartbeat from
 *            the main process every 5 s; silent for 45 s, it ends the main process. A
 *            stuck main thread cannot run any guard of its own.
 *
 * Budgets: a customer desk is held to the light posture (desk-posture.cjs); the owner's
 * box, which runs the fleet's tools in Desk, gets more room. Pure apart from what is
 * injected; startResourceWatchdog/startHangWatchdog are the Electron wiring.
 */

const fs = require("node:fs");
const path = require("node:path");

const BUDGETS = Object.freeze({
  customer: Object.freeze({ mainSoftMb: 350, mainHardMb: 1500, totalSoftMb: 900, totalHardMb: 3000 }),
  owner: Object.freeze({ mainSoftMb: 1200, mainHardMb: 4000, totalSoftMb: 4000, totalHardMb: 12000 }),
});
const SAMPLE_MS = 15_000;
const RECLAIM_EVERY_MS = 60_000;
const RUNAWAY_MB = 400;
const RUNAWAY_WINDOW_MS = 60_000;
const MAX_RESTARTS_PER_HOUR = 2;
const HANG_BEAT_MS = 5_000;
const HANG_TIMEOUT_MS = 45_000;
// After the hang watchdog restarts the GPU child it waits this long for the heartbeat to
// return before it ends the main process. Chromium's browser process talks to its GPU
// process synchronously, so a wedged GPU child (a driver stall, kernel-pool pressure, a
// 3 GB child) reads to Windows as "Aither is not responding" -- AppHangXProcB1, measured
// 2026-11-22. Respawning that ONE child takes under a second and is invisible; ending the
// whole desk is the last resort, not the first.
const HANG_RECOVER_MS = 10_000;

/** KB (Electron's unit) -> MB, private bytes when the platform has them. */
function procMb(m) {
  const mem = (m && m.memory) || {};
  const kb = Number(mem.privateBytes) > 0 ? Number(mem.privateBytes) : Number(mem.workingSetSize) || 0;
  return Math.round(kb / 1024);
}

function assess(metrics, budget) {
  const list = Array.isArray(metrics) ? metrics : [];
  const main = list.find((m) => m && m.type === "Browser");
  const mainMb = main ? procMb(main) : 0;
  const totalMb = list.reduce((sum, m) => sum + procMb(m), 0);
  let level = "ok";
  if (mainMb > budget.mainSoftMb || totalMb > budget.totalSoftMb) level = "soft";
  if (mainMb > budget.mainHardMb || totalMb > budget.totalHardMb) level = "hard";
  return { mainMb, totalMb, level };
}

/**
 * @param deps.sample () => app.getAppMetrics()-shaped list
 * @param deps.reclaim ({pressure}) => void
 * @param deps.restart () => void   relaunch Desk
 * @param deps.quit () => void
 * @param deps.notify (text) => void
 * @param deps.restartsInLastHour () => number
 */
function createWatchdog({ budget, sample, reclaim, restart, quit, notify = () => {}, now = Date.now,
  restartsInLastHour = () => 0, log = () => {} }) {
  let lastReclaimAt = -Infinity;
  let hardRun = 0;
  const history = []; // [at, mainMb]
  let acted = false;

  function tick() {
    if (acted) return { level: "acted" };
    const t = now();
    const a = assess(sample(), budget);
    history.push([t, a.mainMb]);
    while (history.length && history[0][0] < t - RUNAWAY_WINDOW_MS) history.shift();
    const runaway = history.length > 1 && a.mainMb - history[0][1] >= RUNAWAY_MB;
    hardRun = a.level === "hard" ? hardRun + 1 : 0;
    if (a.level === "ok" && !runaway) return a;
    if (a.level === "soft" && !runaway) {
      if (t - lastReclaimAt >= RECLAIM_EVERY_MS) {
        lastReclaimAt = t;
        log(`soft: main ${a.mainMb} MB, total ${a.totalMb} MB -- reclaiming`);
        reclaim({ pressure: false });
      }
      return a;
    }
    // hard or runaway
    if (hardRun < 2 && !runaway) {
      lastReclaimAt = t;
      log(`hard: main ${a.mainMb} MB, total ${a.totalMb} MB -- reclaiming under pressure`);
      reclaim({ pressure: true });
      return a;
    }
    acted = true;
    const why = runaway ? `its memory grew ${RUNAWAY_MB} MB in under a minute` : `it was using ${a.totalMb} MB`;
    if (restartsInLastHour() >= MAX_RESTARTS_PER_HOUR) {
      log(`hard again after ${MAX_RESTARTS_PER_HOUR} restarts this hour -- quitting`);
      notify(`Aither closed itself: ${why}, again. Start it from the Start menu when you need it.`);
      quit();
    } else {
      log(`hard: restarting Desk (${why})`);
      notify(`Aither restarted itself: ${why}.`);
      restart();
    }
    return { ...a, level: "acted" };
  }

  return { tick };
}

/** "ok" while the main process has beaten within `timeoutMs`; "kill" once it has not. */
function hangVerdict({ lastBeatAt, now, timeoutMs = HANG_TIMEOUT_MS }) {
  if (lastBeatAt == null) return "ok"; // never beat yet: still starting
  return now - lastBeatAt > timeoutMs ? "kill" : "ok";
}

/**
 * Two-stage hang ladder -- "restart the child, not the desk".
 *
 *   "ok"      the main thread beat within `timeoutMs`
 *   "recover" the main thread is silent, and the cheap cure (restart the GPU child) has
 *              not been tried yet for THIS silence
 *   "wait"    the GPU child was restarted `recoverMs` ago or less; give the main thread
 *              that grace to come back before doing anything more
 *   "kill"    still silent past the grace: the block is not the GPU child, so end it
 *
 * `gpuKilledAt` is cleared whenever a beat arrives (the child does that), so a fresh
 * silence is always offered the cheap cure first. Pure; the child process owns the clock.
 */
function hangAction({ lastBeatAt, now, timeoutMs = HANG_TIMEOUT_MS, gpuKilledAt = null, recoverMs = HANG_RECOVER_MS }) {
  if (lastBeatAt == null) return "ok"; // never beat yet: still starting
  if (now - lastBeatAt <= timeoutMs) return "ok";
  if (gpuKilledAt == null) return "recover";
  return now - gpuKilledAt > recoverMs ? "kill" : "wait";
}

/** The GPU child's pid and private bytes, from an app.getAppMetrics()-shaped list. */
function gpuProcess(metrics) {
  const list = Array.isArray(metrics) ? metrics : [];
  const gpu = list.find((m) => m && (m.type === "GPU" || m.type === "GPU Process"));
  if (!gpu) return null;
  return { pid: Number(gpu.pid) || 0, mb: procMb(gpu) };
}

/** Restart bookkeeping in userData: the times of recent self-restarts. */
function restartLog(file) {
  const read = () => {
    try {
      const v = JSON.parse(fs.readFileSync(file, "utf8"));
      return Array.isArray(v) ? v.filter((n) => typeof n === "number") : [];
    } catch {
      return [];
    }
  };
  return {
    inLastHour: (now = Date.now()) => read().filter((at) => at > now - 3600_000).length,
    record: (now = Date.now()) => {
      try {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, JSON.stringify(read().filter((at) => at > now - 3600_000).concat([now])));
      } catch { /* a read-only profile: the cap just does not persist */ }
    },
  };
}

/** Electron wiring for the memory guard. */
function startResourceWatchdog({ app, posture, reclaim, notify = () => {}, log = (l) => console.log(`[desk] watchdog: ${l}`),
  intervalMs = SAMPLE_MS }) {
  const budget = posture && posture.customer ? BUDGETS.customer : BUDGETS.owner;
  const restarts = restartLog(path.join(app.getPath("userData"), "self-restarts.json"));
  const dog = createWatchdog({
    budget,
    sample: () => app.getAppMetrics(),
    reclaim,
    notify,
    log,
    restartsInLastHour: () => restarts.inLastHour(),
    restart: () => {
      restarts.record();
      app.relaunch();
      app.exit(0);
    },
    quit: () => app.exit(0),
  });
  const timer = setInterval(() => {
    try { dog.tick(); } catch (error) { log(`tick failed: ${error?.message || error}`); }
  }, intervalMs);
  if (typeof timer.unref === "function") timer.unref();
  return { budget, tick: dog.tick, stop: () => clearInterval(timer) };
}

/** Electron wiring for the hang guard: a utility process that outlives a stuck main thread. */
function startHangWatchdog({ utilityProcess, log = (l) => console.log(`[desk] hang-watchdog: ${l}`),
  beatMs = HANG_BEAT_MS, timeoutMs = HANG_TIMEOUT_MS, recoverMs = HANG_RECOVER_MS, gpuPid = () => 0 }) {
  if (!utilityProcess || typeof utilityProcess.fork !== "function") return null;
  let child;
  try {
    child = utilityProcess.fork(path.join(__dirname, "hang-watchdog-child.cjs"), [], { serviceName: "Aither watchdog" });
  } catch (error) {
    log(`not started: ${error?.message || error}`);
    return null;
  }
  // The GPU child's pid rides on every beat so the watchdog can restart THAT process
  // when the main thread goes silent, instead of ending the whole desk. A caller that
  // cannot answer (or an older main) sends 0 and the watchdog keeps its old behaviour.
  const currentGpuPid = () => { try { return Number(gpuPid()) || 0; } catch { return 0; } };
  child.postMessage({ type: "start", pid: process.pid, timeoutMs, recoverMs, gpuPid: currentGpuPid() });
  const beat = setInterval(() => {
    try { child.postMessage({ type: "beat", gpuPid: currentGpuPid() }); } catch { /* exited */ }
  }, beatMs);
  if (typeof beat.unref === "function") beat.unref();
  return { child, stop: () => { clearInterval(beat); try { child.kill(); } catch { /* gone */ } } };
}

module.exports = {
  BUDGETS, HANG_RECOVER_MS, HANG_TIMEOUT_MS, MAX_RESTARTS_PER_HOUR, RUNAWAY_MB, SAMPLE_MS,
  assess, createWatchdog, gpuProcess, hangAction, hangVerdict, restartLog, startHangWatchdog,
  startResourceWatchdog,
};
