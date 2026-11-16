"use strict";

/**
 * ended-cards.cjs -- a card whose asking session has ENDED is closed by the desk, with
 * an audit line, so the number on every surface is the real number.
 *
 * Owner, 2026-11-16 (screenshots): the Inbox listed "Allow Claude to use: Bash(...)"
 * grants and old Approve cards under an "ended" badge, 40 waiting while 22 were real.
 * Nobody is left to read an answer to a session that is gone, and a Needs-you list that
 * is half ghosts trains the owner to stop reading it. The Inbox already had a button for
 * this ("3 from ended sessions -- close them"); this runs it for him.
 *
 * Rules, each one a way this could lose a real card:
 *   - only a card that NAMES a session (`sessionId`) and was raised on THIS machine
 *     (`host` empty or ours): a session on another computer always looks "not running"
 *     from here, and that is not an end;
 *   - the liveness read must have WORKED (`judged`): an unreadable sessions folder is an
 *     empty map, and an empty map must never be read as "everything ended";
 *   - the card must look ended on TWO sweeps `confirmMs` apart (default 2 min): one bad
 *     pid probe, or a session restarting, never closes anything;
 *   - and it must be older than `graceSec` (default 15 min): a session that just
 *     finished and left a card for the owner gets a quarter of an hour before it goes;
 *   - the audit line is written FIRST; if it cannot be written nothing is closed;
 *   - closing is awask's `cancel` (it tells the raising session) with a note that says
 *     why; the card is never deleted here, and `held` says which one-line reason kept
 *     every other card.
 *
 * PURE except for the injected `cancel` and the audit file. No electron.
 */

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const GRACE_SEC = 15 * 60;
const CONFIRM_MS = 2 * 60_000;
const NOTE = "session ended: closed by Desk (the session that asked is no longer running)";

function hostMatches(cardHost, ownHost) {
  const a = String(cardHost || "").trim().toLowerCase();
  if (!a) return true; // an unlabelled card came from this store, which is local
  const b = String(ownHost || "").trim().toLowerCase();
  return Boolean(b) && (a === b || a.split(".")[0] === b.split(".")[0]);
}

/** Why a card is NOT ended, or "" when it is one the desk may close. */
function keepReason(card, live, { host = "", nowSec = Date.now() / 1000, graceSec = GRACE_SEC } = {}) {
  if (!card || typeof card !== "object" || typeof card.id !== "string") return "not a card";
  if (!card.sessionId) return "no session behind it";
  if (!hostMatches(card.host, host)) return "raised on another machine";
  if (live && typeof live.has === "function" && live.has(card.sessionId)) return "its session is running";
  const created = Number(card.createdAt) || 0;
  if (created > 0 && nowSec - created < graceSec) return "inside the grace period";
  return "";
}

/**
 * One look. `seen` (a Map id -> first-seen-ended ms) carries the two-look rule across
 * calls; the caller keeps it. Returns {judged, closed:[card], held:{id:reason}}.
 */
function plan(cards, live, { seen, host = "", nowMs = Date.now(), graceSec = GRACE_SEC, confirmMs = CONFIRM_MS, judged = true } = {}) {
  const out = { judged: Boolean(judged), closed: [], held: {} };
  if (!judged || !live) return out; // could not judge: close nothing, remember nothing
  const state = seen instanceof Map ? seen : new Map();
  const present = new Set();
  for (const card of Array.isArray(cards) ? cards : []) {
    const why = keepReason(card, live, { host, nowSec: nowMs / 1000, graceSec });
    if (why) {
      if (card && card.id) { out.held[card.id] = why; state.delete(card.id); }
      continue;
    }
    present.add(card.id);
    if (!state.has(card.id)) state.set(card.id, nowMs);
    if (nowMs - state.get(card.id) >= confirmMs) out.closed.push(card);
    else out.held[card.id] = "waiting for a second look";
  }
  for (const id of [...state.keys()]) if (!present.has(id)) state.delete(id); // answered or gone
  return out;
}

function auditRow(card, nowMs, extra = {}) {
  return {
    at: new Date(nowMs).toISOString(),
    id: card.id,
    title: String(card.title || "").slice(0, 200),
    kind: card.kind || "",
    agent: card.agent || "",
    sessionId: card.sessionId || "",
    host: card.host || "",
    createdAt: Number(card.createdAt) || 0,
    reason: "session ended",
    by: "desk:ended-sweep",
    ...extra,
  };
}

/** Append JSON lines. Throws when it cannot, so the caller closes nothing. */
function appendAudit(file, rows, fsImpl = fs) {
  fsImpl.mkdirSync(path.dirname(file), { recursive: true });
  fsImpl.appendFileSync(file, rows.map((r) => `${JSON.stringify(r)}\n`).join(""), "utf8");
}

function auditFile(home = os.homedir()) {
  return path.join(home, ".aither", "decisions-audit", "ended-sessions.jsonl");
}

/**
 * Plan, audit, then cancel. `cancel(id, note)` is decision-cards.cancelCard.
 * Returns {judged, closed:[id], failed:[id], held}.
 */
function sweep(cards, live, {
  cancel, file = auditFile(), appendFn = appendAudit, nowMs = Date.now(), ...planOpts
} = {}) {
  const verdict = plan(cards, live, { nowMs, ...planOpts });
  const result = { judged: verdict.judged, closed: [], failed: [], held: verdict.held };
  if (!verdict.closed.length || typeof cancel !== "function") return result;
  try {
    appendFn(file, verdict.closed.map((c) => auditRow(c, nowMs, { step: "closing" })));
  } catch (error) {
    result.error = `audit not written, nothing closed: ${String((error && error.message) || error).slice(0, 160)}`;
    return result;
  }
  for (const card of verdict.closed) {
    let ok;
    try { ok = Boolean(cancel(card.id, NOTE)); } catch { ok = false; }
    (ok ? result.closed : result.failed).push(card.id);
  }
  if (result.failed.length) {
    try {
      appendFn(file, result.failed.map((id) => ({
        at: new Date(nowMs).toISOString(), id, step: "cancel-failed", by: "desk:ended-sweep",
      })));
    } catch { /* best effort: the closing line is already on disk */ }
  }
  return result;
}

module.exports = { GRACE_SEC, CONFIRM_MS, NOTE, hostMatches, keepReason, plan, auditRow, appendAudit, auditFile, sweep };
