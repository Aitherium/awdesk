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
// After the restart cap Desk used to quit FOR GOOD: on 2026-11-09 it restarted at
// 13:30 and 13:51, hit the cap, quit, and stayed down -- the Startup .vbs only runs
// at logon and the awrise keepalive was starved behind slow jobs -- so every card,
// the fleet's awdesk_* tools and the desk browser went dark until a human noticed.
// Now the cap means "stop looping, cool down, come back": a detached helper
// relaunches Desk after this long.
const COOLDOWN_RELAUNCH_MS = 10 * 60_000;
const HANG_BEAT_MS = 5_000;
const HANG_TIMEOUT_MS = 45_000;
// The GPU process is the one child that can balloon on its own (software present +
// a giant transparent window, 2026-11-07: 9.2 GB private). Restarting Desk for it is
// a sledgehammer -- it interrupted the owner twice -- but killing the GPU child makes
// Electron respawn a clean one in under a second, with no visible re-layout.
const GPU_LIMIT_MB = 3000;
const GPU_SAMPLE_MS = 15_000;
// The leak this guards measured ~5 GB/min, so a five-minute cooldown would let the
// next regression reach the 12 GB total budget and force a full app relaunch -- the
// outcome the guard exists to avoid. One kill a minute, six an hour, is enough.
const GPU_COOLDOWN_MS = 60_000;
const GPU_MAX_KILLS_PER_HOUR = 6;

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
  restartsInLastHour = () => 0, log = () => {}, hold = () => false }) {
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
    // The owner is mid-approval (the passkey window): a restart destroys it under
    // their hand (owner, 2026-11-10: "I was about to, then it was killed" -- the
    // approve page loading read as +400 MB). Reclaim instead; judge again next tick.
    let held;
    try { held = Boolean(hold()); } catch { held = false; }
    if (held) {
      lastReclaimAt = t;
      log(`held: the owner is mid-approval -- reclaiming instead of restarting`);
      reclaim({ pressure: true });
      return { ...a, level: "held" };
    }
    acted = true;
    const why = runaway ? `its memory grew ${RUNAWAY_MB} MB in under a minute` : `it was using ${a.totalMb} MB`;
    if (restartsInLastHour() >= MAX_RESTARTS_PER_HOUR) {
      log(`hard again after ${MAX_RESTARTS_PER_HOUR} restarts this hour -- quitting`);
      notify(`Aither closed itself: ${why}, again. It starts again in ${Math.round(COOLDOWN_RELAUNCH_MS / 60_000)} minutes.`);
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

/** Pure: one argv element quoted for the Windows CRT parser (CommandLineToArgvW rules). */
function winQuoteArg(arg) {
  const s = String(arg);
  if (s && !/[\s"]/.test(s)) return s;
  let out = '"';
  let slashes = 0;
  for (const ch of s) {
    if (ch === "\\") { slashes += 1; continue; }
    if (ch === '"') { out += "\\".repeat(slashes * 2 + 1) + '"'; slashes = 0; continue; }
    out += "\\".repeat(slashes) + ch;
    slashes = 0;
  }
  return out + "\\".repeat(slashes * 2) + '"';
}

/**
 * Pure: the detached helper that starts Desk again after `delayMs`. It is the OS
 * shell, never the Desk binary run as Node: a packaged Desk has the RunAsNode fuse
 * OFF (electron-fuses.test.cjs), so a "-e" script through it would start a full Desk
 * at once -- a relaunch loop. PowerShell on Windows, /bin/sh elsewhere; both sleep,
 * then start `execPath args` in `cwd`, and outlive the Desk that is quitting.
 */
function delayedRelaunchSpec({ execPath, args = [], delayMs = COOLDOWN_RELAUNCH_MS, cwd = process.cwd(),
  platform = process.platform }) {
  const secs = Math.max(0, Math.ceil((Number(delayMs) || 0) / 1000));
  if (platform === "win32") {
    const q = (v) => `'${String(v).split("'").join("''")}'`;
    // Windows PowerShell 5.1 joins an -ArgumentList array with bare spaces, so
    // "C:\Program Files\x" would split in two: hand it ONE pre-quoted line instead.
    const argList = args.length ? ` -ArgumentList ${q(args.map(winQuoteArg).join(" "))}` : "";
    const command = `Start-Sleep -Seconds ${secs}; `
      + `Start-Process -FilePath ${q(execPath)}${argList} -WorkingDirectory ${q(cwd)}`;
    return { command: "powershell.exe", args: ["-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden",
      "-Command", command], cwd };
  }
  return { command: "/bin/sh", args: ["-c", `sleep ${secs}; exec "$0" "$@"`, execPath, ...args], cwd };
}

/** Start the helper; never throws (a failed helper just means a manual start). */
function relaunchAfterCooldown({ execPath = process.execPath, args = process.argv.slice(1),
  delayMs = COOLDOWN_RELAUNCH_MS, spawn = require("node:child_process").spawn, log = () => {} } = {}) {
  try {
    const spec = delayedRelaunchSpec({ execPath, args, delayMs });
    const child = spawn(spec.command, spec.args, { detached: true, stdio: "ignore", cwd: spec.cwd, windowsHide: true });
    if (child && typeof child.unref === "function") child.unref();
    log(`cooldown: Desk starts again in ${Math.round(delayMs / 1000)} s`);
    return true;
  } catch (error) {
    log(`cooldown relaunch helper failed: ${error?.message || error}`);
    return false;
  }
}

/** Electron wiring for the memory guard. */
function startResourceWatchdog({ app, posture, reclaim, notify = () => {}, hold = () => false, log = (l) => console.log(`[desk] watchdog: ${l}`),
  intervalMs = SAMPLE_MS }) {
  const budget = posture && posture.customer ? BUDGETS.customer : BUDGETS.owner;
  const restarts = restartLog(path.join(app.getPath("userData"), "self-restarts.json"));
  const dog = createWatchdog({
    budget,
    sample: () => app.getAppMetrics(),
    reclaim,
    notify,
    hold,
    log,
    restartsInLastHour: () => restarts.inLastHour(),
    restart: () => {
      restarts.record();
      app.relaunch();
      app.exit(0);
    },
    quit: () => {
      relaunchAfterCooldown({ log });
      app.exit(0);
    },
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
  BUDGETS, COOLDOWN_RELAUNCH_MS, GPU_LIMIT_MB, GPU_MAX_KILLS_PER_HOUR, HANG_TIMEOUT_MS, MAX_RESTARTS_PER_HOUR,
  RUNAWAY_MB, SAMPLE_MS,
  assess, createGpuGuard, delayedRelaunchSpec, winQuoteArg, relaunchAfterCooldown, createWatchdog, gpuProcess, gpuVerdict, hangVerdict, restartLog,
  startHangWatchdog, startResourceWatchdog,
};
