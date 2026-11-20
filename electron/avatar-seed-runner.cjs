"use strict";

/**
 * avatar-seed-runner -- run one avatar-library seed pass in a separate Electron
 * utility process, and hand back its result.
 *
 * `fork` is injected (main.cjs passes `(script, args, options) => utilityProcess.fork(...)`)
 * so this module stays Electron-free and testable under `node --test` with a fake child.
 *
 * Contract of `run()`:
 *   - resolves the seed result object ({ok, uploaded, ...}) when the worker answered;
 *   - resolves `null` when it could not start, died without an answer, or timed out --
 *     the caller then runs the bounded in-process seed instead (never a lost pass);
 *   - never throws.
 *
 * One pass at a time: a second call while one is running returns null immediately.
 */

const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;

/** Event payloads differ between Electron's UtilityProcess ('message' = message) and a
 *  MessageEvent-shaped emitter ({data}): accept both. */
function payload(event) {
  if (event && typeof event === "object" && "data" in event && event.data !== undefined) return event.data;
  return event;
}

function createSeedRunner({ fork, scriptPath, timeoutMs = DEFAULT_TIMEOUT_MS, log = () => {} } = {}) {
  let child = null;

  function stop() {
    const running = child;
    child = null;
    if (!running) return;
    try { if (typeof running.kill === "function") running.kill(); } catch { /* already gone */ }
  }

  async function run() {
    if (child) return null; // one pass at a time
    if (typeof fork !== "function" || !scriptPath) return null;
    let proc;
    try {
      proc = fork(scriptPath, [], { serviceName: "Aither avatar library seed" });
    } catch (error) {
      log("avatar seed runner could not start", String((error && error.message) || error));
      return null;
    }
    if (!proc || typeof proc.on !== "function") return null;
    child = proc;
    return await new Promise((resolve) => {
      let settled = false;
      const finish = (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (child === proc) child = null;
        resolve(value);
      };
      const timer = setTimeout(() => {
        log(`avatar seed worker exceeded ${Math.round(timeoutMs / 1000)} s -- ending it`);
        try { if (typeof proc.kill === "function") proc.kill(); } catch { /* gone */ }
        finish(null);
      }, timeoutMs);
      if (typeof timer.unref === "function") timer.unref();
      proc.on("message", (event) => {
        const msg = payload(event);
        if (!msg || typeof msg !== "object") return;
        if (msg.type === "log") {
          log(String(msg.message || "avatar library seed"), msg.detail);
          return;
        }
        if (msg.type === "done") {
          const out = msg.out && typeof msg.out === "object" ? msg.out : { ok: false, reason: "the seed worker answered nothing" };
          finish(out);
        }
      });
      proc.on("exit", (code) => {
        finish(null);
        if (code !== 0) log(`avatar seed worker exited with ${code}`);
      });
      try {
        proc.postMessage({ type: "seed" });
      } catch (error) {
        log("avatar seed worker could not be asked", String((error && error.message) || error));
        finish(null);
      }
    });
  }

  return { run, stop, busy: () => Boolean(child) };
}

module.exports = { createSeedRunner, DEFAULT_TIMEOUT_MS };
