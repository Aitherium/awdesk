"use strict";

/**
 * avatar-library-seed-worker -- ONE avatar-library seed pass, in an Electron UTILITY
 * PROCESS (electron/avatar-seed-runner.cjs forks this; main.cjs wires it).
 *
 * Why a separate process: the seed reads every roster model to hash it, and bytes again
 * to upload the ones the library lacks. On the owner's desk that is 92 files / 2.0 GB
 * (largest 63 MiB). In the main process that work (a) held hundreds of MB of Buffers in
 * the desk's own heap -- measured 2026-11-20: main 150 -> 655 MB in one pass -- and
 * (b) tripped the resource watchdog's 400 MB/minute "runaway" rule, which restarts (and
 * after two in an hour quits) the desk. A utility process has its own heap and pid, so
 * the desk's main process stays flat; a crash here costs one retry, never the desk.
 *
 * Protocol (parentPort): in {type:"seed"}; out {type:"log", message, detail} and
 * exactly one {type:"done", out}. The seed itself is avatar-catalog-sync.cjs.
 */

const seedModule = require("./avatar-catalog-sync.cjs");

function post(message) {
  try {
    if (process.parentPort && typeof process.parentPort.postMessage === "function") {
      process.parentPort.postMessage(message);
    }
  } catch { /* the parent is gone: the pass is abandoned */ }
}

async function runSeed() {
  try {
    const out = await seedModule.seedLibraryFromDesk({
      log: (message, detail) => post({ type: "log", message: String(message || ""), detail }),
    });
    post({ type: "done", out });
  } catch (error) {
    post({ type: "done", out: { ok: false, reason: String((error && error.message) || error) } });
  } finally {
    // Nothing left to do in this process: exit so its heap is returned to the OS.
    setTimeout(() => { try { process.exit(0); } catch { /* gone */ } }, 0);
  }
}

if (process.parentPort && typeof process.parentPort.on === "function") {
  process.parentPort.on("message", (event) => {
    const msg = event && event.data !== undefined ? event.data : event;
    if (!msg || typeof msg !== "object" || msg.type !== "seed") return;
    void runSeed();
  });
} else if (require.main === module) {
  // `node electron/avatar-library-seed-worker.cjs` -- one pass to stdout, for support.
  runSeed().then((out) => {
    process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
    process.exit(out.ok ? 0 : 1);
  });
}

module.exports = { runSeed };
