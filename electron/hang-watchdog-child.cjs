"use strict";

/**
 * hang-watchdog-child -- runs in an Electron utility process (resource-watchdog.cjs
 * startHangWatchdog). The main process sends {type:"start", pid, timeoutMs} once and
 * {type:"beat"} every few seconds. If the beats stop for longer than timeoutMs the main
 * thread is stuck (Garg 2026-10-16: a layout loop held it until the customer used Task
 * Manager), and this ends it so the user is never left with a frozen Desk on screen.
 * The next start of Desk is a clean one.
 */

const { hangVerdict } = require("./resource-watchdog.cjs");

let target = null;
let timeoutMs = 45_000;
let lastBeatAt = null;

process.parentPort.on("message", (event) => {
  const msg = event && event.data;
  if (!msg || typeof msg !== "object") return;
  if (msg.type === "start" && Number.isInteger(msg.pid)) {
    target = msg.pid;
    if (Number.isFinite(msg.timeoutMs) && msg.timeoutMs >= 10_000) timeoutMs = msg.timeoutMs;
    lastBeatAt = Date.now();
  } else if (msg.type === "beat") {
    lastBeatAt = Date.now();
  }
});

let lastTickAt = Date.now();
setInterval(() => {
  const now = Date.now();
  // This process was not running either (sleep, hibernate, a debugger, a starved box):
  // the silence is the machine's, not a hang. Start counting again from now.
  if (now - lastTickAt > 15_000) lastBeatAt = lastBeatAt == null ? null : now;
  lastTickAt = now;
  if (target == null) return;
  if (hangVerdict({ lastBeatAt, now, timeoutMs }) !== "kill") return;
  console.error(`[desk] hang-watchdog: main process ${target} silent for ${Math.round((Date.now() - lastBeatAt) / 1000)} s -- ending it`);
  try { process.kill(target, "SIGKILL"); } catch { /* already gone */ }
  process.exit(0);
}, 5_000);
