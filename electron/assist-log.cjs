"use strict";

/**
 * assist-log.cjs -- the append-only action log (owner: "every action is logged").
 *
 * One JSON object per line in <userData>/assist-log.jsonl. Written BEFORE a model or
 * agent call (outcome "started"), then again with the outcome, so a crash still leaves
 * the intent on disk. Records carry counts and short hashes, never the text, unless the
 * owner turned `logText` on (assist-core.logRecord). Capped: past MAX_BYTES the file
 * rotates to .1 (one generation); the log never grows without bound.
 *
 * Never throws: a log that cannot be written must not block the user's own action, but it
 * is not silent either -- `append` returns {ok:false, error} and the pop-up shows it.
 */

const fs = require("node:fs");
const path = require("node:path");

const MAX_BYTES = 2 * 1024 * 1024;
const FILE = "assist-log.jsonl";

function createAssistLog({ dir, fsImpl = fs, maxBytes = MAX_BYTES } = {}) {
  const file = path.join(String(dir || "."), FILE);
  function rotate() {
    try {
      const st = fsImpl.statSync(file);
      if (st.size < maxBytes) return;
      try { fsImpl.rmSync(`${file}.1`, { force: true }); } catch { /* absent */ }
      fsImpl.renameSync(file, `${file}.1`);
    } catch { /* no file yet */ }
  }
  function append(record) {
    try {
      rotate();
      fsImpl.appendFileSync(file, `${JSON.stringify(record)}\n`, "utf8");
      return { ok: true };
    } catch (error) {
      return { ok: false, error: String((error && error.message) || error) };
    }
  }
  function tail(n = 50) {
    try {
      const lines = fsImpl.readFileSync(file, "utf8").split(/\r?\n/).filter(Boolean).slice(-Math.max(1, n));
      return lines.map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
    } catch { return []; }
  }
  return { append, tail, file };
}

module.exports = { createAssistLog, MAX_BYTES, FILE };
