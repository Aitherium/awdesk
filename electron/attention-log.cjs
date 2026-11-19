"use strict";

/**
 * attention-log -- the fairy's nudge ledger, always on (not only under DESK_DEBUG).
 *
 * 2026-11-19: card d-ennp (blocked, high) sat open 2 h and the owner saw no fairy; the
 * desk had no record of what it nudged, when, or why it held, because debugLog prints
 * only with DESK_DEBUG=1. This appends ONE line per nudge, per nudge outcome and per
 * hold (when the hold reason changes, or the same hold every `repeatHoldMs`), to a
 * small file under the desk's userData that rotates to `<file>.1` past `maxBytes`.
 *
 * Lines are `<ISO time> <event> <json>`; never a card's summary, facts or a secret
 * (the caller passes ids, levels and reasons only). A write that fails is dropped: the
 * log must never break the nudge loop.
 */

const fs = require("node:fs");
const path = require("node:path");

const DEFAULT_MAX_BYTES = 512 * 1024;
const DEFAULT_REPEAT_HOLD_MS = 10 * 60_000;

/**
 * @param {{file: string|(() => string), maxBytes?: number, repeatHoldMs?: number,
 *          now?: () => number, fsImpl?: typeof fs}} opts
 * @returns {{nudge(fields: object): void, outcome(fields: object): void,
 *            hold(reason: string, fields?: object): boolean, line(event: string, fields?: object): void,
 *            file(): string}}
 */
function createAttentionLog({ file, maxBytes = DEFAULT_MAX_BYTES, repeatHoldMs = DEFAULT_REPEAT_HOLD_MS, now = Date.now, fsImpl = fs } = {}) {
  let lastHold = "";
  let lastHoldAt = 0;
  const where = () => String(typeof file === "function" ? file() : file || "");

  function rotate(target) {
    try {
      const size = fsImpl.statSync(target).size;
      if (size < maxBytes) return;
      fsImpl.rmSync(`${target}.1`, { force: true });
      fsImpl.renameSync(target, `${target}.1`);
    } catch { /* no file yet, or it moved under us: nothing to rotate */ }
  }

  function line(event, fields = {}) {
    let target;
    try { target = where(); } catch { return; }
    if (!target) return;
    try {
      fsImpl.mkdirSync(path.dirname(target), { recursive: true });
      rotate(target);
      fsImpl.appendFileSync(target, `${new Date(now()).toISOString()} ${event} ${JSON.stringify(fields)}\n`);
    } catch { /* best effort, never a throw into the nudge loop */ }
  }

  return {
    line,
    nudge(fields) {
      lastHold = ""; // the next hold after a nudge is news
      line("nudge", fields);
    },
    outcome(fields) { line("end", fields); },
    /** A hold is logged when its reason changes, or again after `repeatHoldMs`. */
    hold(reason, fields = {}) {
      const r = String(reason || "");
      if (!r) return false;
      const t = now();
      if (r === lastHold && t - lastHoldAt < repeatHoldMs) return false;
      lastHold = r;
      lastHoldAt = t;
      line("hold", { reason: r, ...fields });
      return true;
    },
    file: where,
  };
}

module.exports = { createAttentionLog, DEFAULT_MAX_BYTES, DEFAULT_REPEAT_HOLD_MS };
