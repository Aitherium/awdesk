"use strict";

/**
 * hang-watchdog-child -- runs in an Electron utility process (resource-watchdog.cjs
 * startHangWatchdog). The main process sends {type:"start", pid, timeoutMs, gpuPid} once
 * and {type:"beat", gpuPid} every few seconds. If the beats stop for longer than
 * timeoutMs the main thread is stuck (Garg 2026-10-16: a layout loop held it until the
 * customer used Task Manager).
 *
 * It is a LADDER, not a single sledgehammer (2026-11-22: AppHangXProcB1 -- Windows saw
 * "Electron is not responding" because the browser process was blocked in a synchronous
 * wait on its GPU child, and the old code ended the whole desk):
 *
 *   1. silent past timeoutMs  -> respawn the GPU child (one kill; Chromium makes a new
 *      one in under a second, no visible re-layout) and keep watching.
 *   2. a beat arrives         -> the cheap cure worked; forget the hang, log it.
 *   3. still silent past the grace -> the block is not the GPU child, so end the main
 *      process so the user is never left with a frozen Desk on screen.
 *
 * A hang caused by a wedged CHILD now costs a fraction of a second and no window; only a
 * hang inside the main thread itself costs the app.
 */

const { hangAction } = require("./resource-watchdog.cjs");

let target = null;
let timeoutMs = 45_000;
let recoverMs = 10_000;
let lastBeatAt = null;
let gpuPid = 0;
let gpuKilledAt = null;

process.parentPort.on("message", (event) => {
  const msg = event && event.data;
  if (!msg || typeof msg !== "object") return;
  if (msg.type === "start" && Number.isInteger(msg.pid)) {
    target = msg.pid;
    if (Number.isFinite(msg.timeoutMs) && msg.timeoutMs >= 10_000) timeoutMs = msg.timeoutMs;
    if (Number.isFinite(msg.recoverMs) && msg.recoverMs >= 1_000) recoverMs = msg.recoverMs;
    gpuPid = Number.isInteger(msg.gpuPid) && msg.gpuPid > 0 ? msg.gpuPid : 0;
    lastBeatAt = Date.now();
    gpuKilledAt = null;
  } else if (msg.type === "beat") {
    lastBeatAt = Date.now();
    if (Number.isInteger(msg.gpuPid) && msg.gpuPid > 0) gpuPid = msg.gpuPid;
    if (gpuKilledAt != null) {
      console.error(`[desk] hang-watchdog: heartbeat back ${Math.round((Date.now() - gpuKilledAt) / 1000)} s after restarting the GPU child -- recovered without ending the desk`);
      gpuKilledAt = null;
    }
  }
});

function endMain(why) {
  console.error(`[desk] hang-watchdog: main process ${target} silent for ${Math.round((Date.now() - lastBeatAt) / 1000)} s -- ${why}`);
  try { process.kill(target, "SIGKILL"); } catch { /* already gone */ }
  process.exit(0);
}

let lastTickAt = Date.now();
setInterval(() => {
  const now = Date.now();
  // This process was not running either (sleep, hibernate, a debugger, a starved box):
  // the silence is the machine's, not a hang. Start counting again from now.
  if (now - lastTickAt > 15_000) {
    lastBeatAt = lastBeatAt == null ? null : now;
    gpuKilledAt = null;
  }
  lastTickAt = now;
  if (target == null) return;
  const action = hangAction({ lastBeatAt, now, timeoutMs, gpuKilledAt, recoverMs });
  if (action === "recover") {
    // Nothing cheaper to restart, or the pid we know is the main process itself: the
    // only remaining cure is the old one.
    if (!gpuPid || gpuPid === target) { endMain("no GPU child to restart -- ending it"); return; }
    gpuKilledAt = now;
    console.error(`[desk] hang-watchdog: main silent for ${Math.round((now - lastBeatAt) / 1000)} s -- restarting GPU child ${gpuPid} instead of the desk`);
    try { process.kill(gpuPid, "SIGKILL"); } catch { /* already gone: the beat may resume anyway */ }
    return;
  }
  if (action === "kill") endMain("still silent after restarting the GPU child -- ending it");
}, 5_000);
