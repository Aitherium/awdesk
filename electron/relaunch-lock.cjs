"use strict";

/**
 * relaunch-lock.cjs -- the single-instance lock, survivable across a Restart.
 *
 * Measured twice on 2026-11-01: tray/palette "Restart Aither" (main.cjs restartDesk:
 * app.relaunch() + app.exit(0)) left NO desk running. The relaunched process starts
 * while the old one still holds the single-instance lock; it saw the lock, took
 * itself for a second copy, and quit -- and the old one was already exiting.
 *
 * restartDesk now relaunches with RELAUNCH_FLAG. A process carrying the flag that
 * finds the lock held retries for up to `waitMs` (the old process releases it as it
 * exits) before giving up like any second copy. Without the flag nothing changes:
 * a genuine second launch still hands over to the running desk at once.
 */

const RELAUNCH_FLAG = "--relaunched";
const RELAUNCH_WAIT_MS = 10_000;
const RETRY_MS = 200;

function sleepSync(ms) {
  try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.max(1, ms | 0)); } catch { /* no wait */ }
}

/**
 * True when this process owns the single-instance lock.
 *
 * @param {{requestSingleInstanceLock: () => boolean}} app
 * @param {string[]} argv
 * @param {{waitMs?: number, retryMs?: number, sleep?: (ms: number) => void, now?: () => number}} [opts]
 */
function singleInstanceLock(app, argv = [], { waitMs = RELAUNCH_WAIT_MS, retryMs = RETRY_MS, sleep = sleepSync, now = () => Date.now() } = {}) {
  if (app.requestSingleInstanceLock()) return true;
  if (!Array.isArray(argv) || !argv.includes(RELAUNCH_FLAG)) return false;
  const deadline = now() + waitMs;
  while (now() < deadline) {
    sleep(retryMs);
    if (app.requestSingleInstanceLock()) return true;
  }
  return false;
}

module.exports = { RELAUNCH_FLAG, RELAUNCH_WAIT_MS, singleInstanceLock };
