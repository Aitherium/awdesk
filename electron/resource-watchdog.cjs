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
// The GPU process is the one child that can balloon on its own (software present +
// a giant transparent window, 2026-11-07: 9.2 GB private). Restarting Desk for it is
// a sledgehammer -- it interrupted the owner twice -- but killing the GPU child makes
// Electron respawn a clean one in under a second, with no visible re-layout.
const GPU_LIMIT_MB = 3000;
const GPU_SAMPLE_MS = 15_000;
const GPU_COOLDOWN_MS = 5 * 60_000;
const GPU_MAX_KILLS_PER_HOUR = 3;

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

/** The GPU child's pid and private bytes, from an app.getAppMetrics()-shaped list. */
function gpuProcess(metrics) {
  const list = Array.isArray(metrics) ? metrics : [];
  const gpu = list.find((m) => m && (m.type === "GPU" || m.type === "GPU Process"));
  if (!gpu) return null;
  return { pid: Number(gpu.pid) || 0, mb: procMb(gpu) };
}

/**
 * Pure verdict for one sample. `kill` is true only for a real GPU child above the line;
 * a missing metric or a zero pid is "ok" (we cannot identify it, so we do not act).
 */
function gpuVerdict(metrics, { limitMb = GPU_LIMIT_MB } = {}) {
  const gpu = gpuProcess(metrics);
  if (!gpu || !gpu.pid) return { pid: 0, mb: 0, kill: false };
  return { pid: gpu.pid, mb: gpu.mb, kill: gpu.mb > limitMb };
}

/**
 * Kills ONLY the verified GPU child when it passes `limitMb`; Electron respawns it.
 * Idempotent by pid (a stale metric cannot kill the same process twice), rate-limited
 * (cooldown + a per-hour cap) and logged on every decision.
 *
 * @param deps.sample () => app.getAppMetrics()-shaped list
 * @param deps.kill (pid) => void
 */
function createGpuGuard({ sample, kill, limitMb = GPU_LIMIT_MB, cooldownMs = GPU_COOLDOWN_MS,
  maxPerHour = GPU_MAX_KILLS_PER_HOUR, now = Date.now, log = () => {} }) {
  let lastKillAt = -Infinity;
  let killedPid = 0;
  let kills = [];

  function tick() {
    const verdict = gpuVerdict(sample(), { limitMb });
    if (!verdict.kill) {
      if (killedPid && verdict.pid && verdict.pid !== killedPid) killedPid = 0;
      return verdict;
    }
    if (verdict.pid === killedPid) return { ...verdict, action: "already" };
    const t = now();
    if (t - lastKillAt < cooldownMs) {
      log(`gpu-guard: pid ${verdict.pid} at ${verdict.mb} MB -- cooling down, not killing`);
      return { ...verdict, action: "cooldown" };
    }
    kills = kills.filter((at) => at > t - 3600_000);
    if (kills.length >= maxPerHour) {
      log(`gpu-guard: pid ${verdict.pid} at ${verdict.mb} MB -- ${maxPerHour} kills this hour, not killing`);
      return { ...verdict, action: "capped" };
    }
    kills.push(t);
    lastKillAt = t;
    killedPid = verdict.pid;
    log(`gpu-guard: pid ${verdict.pid} at ${verdict.mb} MB (limit ${limitMb}) -- restarting the GPU process`);
    try {
      kill(verdict.pid);
    } catch (error) {
      log(`gpu-guard: kill ${verdict.pid} failed: ${error?.message || error}`);
    }
    return { ...verdict, action: "killed" };
  }

  return { tick, kills: () => kills.slice() };
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
  // The GPU child has its own guard: killing it is cheap, restarting Desk is not.
  const gpu = createGpuGuard({
    sample: () => app.getAppMetrics(),
    kill: (pid) => {
      if (!pid || pid === process.pid) return; // never the main process
      process.kill(pid);
    },
    log,
  });
  const gpuTimer = setInterval(() => {
    try { gpu.tick(); } catch (error) { log(`gpu-guard failed: ${error?.message || error}`); }
  }, GPU_SAMPLE_MS);
  if (typeof gpuTimer.unref === "function") gpuTimer.unref();
  return {
    budget,
    tick: dog.tick,
    gpuTick: gpu.tick,
    stop: () => { clearInterval(timer); clearInterval(gpuTimer); },
  };
}

/** Electron wiring for the hang guard: a utility process that outlives a stuck main thread. */
function startHangWatchdog({ utilityProcess, log = (l) => console.log(`[desk] hang-watchdog: ${l}`),
  beatMs = HANG_BEAT_MS, timeoutMs = HANG_TIMEOUT_MS }) {
  if (!utilityProcess || typeof utilityProcess.fork !== "function") return null;
  let child;
  try {
    child = utilityProcess.fork(path.join(__dirname, "hang-watchdog-child.cjs"), [], { serviceName: "Aither watchdog" });
  } catch (error) {
    log(`not started: ${error?.message || error}`);
    return null;
  }
  child.postMessage({ type: "start", pid: process.pid, timeoutMs });
  const beat = setInterval(() => { try { child.postMessage({ type: "beat" }); } catch { /* exited */ } }, beatMs);
  if (typeof beat.unref === "function") beat.unref();
  return { child, stop: () => { clearInterval(beat); try { child.kill(); } catch { /* gone */ } } };
}

module.exports = {
  BUDGETS, GPU_LIMIT_MB, GPU_MAX_KILLS_PER_HOUR, HANG_TIMEOUT_MS, MAX_RESTARTS_PER_HOUR,
  RUNAWAY_MB, SAMPLE_MS,
  assess, createGpuGuard, createWatchdog, gpuProcess, gpuVerdict, hangVerdict, restartLog,
  startHangWatchdog, startResourceWatchdog,
};
