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
 *   - AND the desk must hold a TRACE of that session on this machine (`known(sessionId)`:
 *     a Claude state file or a transcript). A session in WSL/awnix, a container agent or
 *     another harness never leaves one here, so it always looks "not running" from this
 *     side; absence of a trace means "cannot tell", never "ended". An empty `host` is not
 *     proof of locality on its own;
 *   - the liveness read must have WORKED (`judged`): an unreadable sessions folder is an
 *     empty map, and an empty map must never be read as "everything ended";
 *   - the card must look ended on TWO sweeps `confirmMs` apart (default 2 min): one bad
 *     pid probe, or a session restarting, never closes anything;
 *   - and it must be older than `graceSec` (default 15 min): a session that just
 *     finished and left a card for the owner gets a quarter of an hour before it goes;
 *   - the audit line is written FIRST; if it cannot be written nothing is closed;
 *   - a card whose session this machine has NO trace of (it ran in WSL, a container or
 *     another harness) is not closed because "it ended" -- that cannot be told -- but a
 *     grant / approval / permission card nobody answered for EXPIRE_SEC (24 h) is closed
 *     as EXPIRED, with its own audit reason: nobody sits at a terminal waiting on a
 *     "Allow Claude to use: Bash(...)" prompt a day later. Key requests (credential)
 *     are never closed by either rule;
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
const EXPIRE_SEC = 24 * 60 * 60;
const EXPIRE_KINDS = new Set(["blocked", "approval", "permission"]);
const EXPIRE_NOTE = "expired: nobody answered in 24 h and the session that asked cannot be found on this machine (closed by Desk)";
const NOTE = "session ended: closed by Desk (the session that asked is no longer running)";

function hostMatches(cardHost, ownHost) {
  const a = String(cardHost || "").trim().toLowerCase();
  if (!a) return true; // an unlabelled card came from this store, which is local
  const b = String(ownHost || "").trim().toLowerCase();
  return Boolean(b) && (a === b || a.split(".")[0] === b.split(".")[0]);
}

function isCredential(card) {
  return card.kind === "credential" || Boolean(card.secretName);
}

/** A grant / approval / permission prompt: the kinds that go stale when nobody answers. */
function expirable(card) {
  const kind = String(card.kind || "").toLowerCase();
  if (String(card.agent || "") === "claude-permission-grant") return true;
  return Boolean(card.sessionId) && EXPIRE_KINDS.has(kind);
}

/**
 * The verdict for one card: {keep: "<why it stays>"} or {close: "ended" | "expired"}.
 * `known(sessionId)` says whether this machine holds any trace of the session.
 */
function classify(card, live, { host = "", nowSec = Date.now() / 1000, graceSec = GRACE_SEC, expireSec = EXPIRE_SEC, known = () => false } = {}) {
  if (!card || typeof card !== "object" || typeof card.id !== "string") return { keep: "not a card" };
  if (!hostMatches(card.host, host)) return { keep: "raised on another machine" };
  const created = Number(card.createdAt) || 0;
  const age = created > 0 ? nowSec - created : 0;
  const running = Boolean(card.sessionId) && live && typeof live.has === "function" && live.has(card.sessionId);
  if (running) return { keep: "its session is running" };
  if (isCredential(card)) return { keep: "a key request stays until you close it" };
  if (!card.sessionId) {
    // a grant prompt with no session left behind is the same dead end, just older
    if (expirable(card) && age >= expireSec) return { close: "expired" };
    return { keep: "no session behind it" };
  }
  let traced;
  try { traced = typeof known === "function" && Boolean(known(card.sessionId)); } catch { traced = false; }
  if (!traced) {
    if (expirable(card) && age >= expireSec) return { close: "expired" };
    return { keep: "no trace of that session on this machine" };
  }
  if (created > 0 && age < graceSec) return { keep: "inside the grace period" };
  return { close: "ended" };
}

/** Why a card is NOT closed, or "" when it is one the desk may close. */
function keepReason(card, live, opts) {
  const verdict = classify(card, live, opts);
  return verdict.keep || "";
}

/**
 * The ids of cards whose asking session has ENDED, the number every surface leaves out of
 * "waiting": raised on this machine, a session this machine HAS a trace of, not running.
 * Unknown sessions (WSL, containers) and key requests are never in it. An unreadable
 * liveness read (`judged` false) gives the empty set.
 */
function endedIds(cards, live, { host = "", known = () => false, judged = true } = {}) {
  const out = new Set();
  if (!judged || !live || typeof live.has !== "function") return out;
  for (const card of Array.isArray(cards) ? cards : []) {
    if (!card || typeof card.id !== "string" || !card.sessionId || isCredential(card)) continue;
    if (!hostMatches(card.host, host) || live.has(card.sessionId)) continue;
    let traced;
    try { traced = typeof known === "function" && Boolean(known(card.sessionId)); } catch { traced = false; }
    if (traced) out.add(card.id);
  }
  return out;
}

/**
 * One look. `seen` (a Map id -> first-seen-ended ms) carries the two-look rule across
 * calls; the caller keeps it. Returns {judged, closed:[card], held:{id:reason}}.
 */
function plan(cards, live, { seen, host = "", nowMs = Date.now(), graceSec = GRACE_SEC, confirmMs = CONFIRM_MS, judged = true, known = () => false } = {}) {
  const out = { judged: Boolean(judged), closed: [], held: {}, why: {} };
  if (!judged || !live) return out; // could not judge: close nothing, remember nothing
  const state = seen instanceof Map ? seen : new Map();
  const present = new Set();
  for (const card of Array.isArray(cards) ? cards : []) {
    const verdict = classify(card, live, { host, nowSec: nowMs / 1000, graceSec, known });
    if (verdict.keep) {
      if (card && card.id) { out.held[card.id] = verdict.keep; state.delete(card.id); }
      continue;
    }
    present.add(card.id);
    if (!state.has(card.id)) state.set(card.id, nowMs);
    if (nowMs - state.get(card.id) >= confirmMs) { out.closed.push(card); out.why[card.id] = verdict.close; }
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

/**
 * Where the closing lines go. A run that points the desk at another card store
 * (AITHER_DECISIONS_DIR, a scratch run or a test) writes its audit INSIDE that store, so
 * it can never add a row to the owner's real trail; AITHER_DECISIONS_AUDIT_DIR overrides both.
 */
function auditFile(home = os.homedir(), env = process.env) {
  const override = String(env.AITHER_DECISIONS_AUDIT_DIR || "").trim();
  if (override) return path.join(override, "ended-sessions.jsonl");
  const store = String(env.AITHER_DECISIONS_DIR || "").trim();
  if (store) return path.join(store, "_audit", "ended-sessions.jsonl");
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
    appendFn(file, verdict.closed.map((c) => {
      const expired = verdict.why[c.id] === "expired";
      return auditRow(c, nowMs, { step: "closing", ...(expired ? { reason: "expired: no answer in 24 h, session not found on this machine" } : {}) });
    }));
  } catch (error) {
    result.error = `audit not written, nothing closed: ${String((error && error.message) || error).slice(0, 160)}`;
    return result;
  }
  for (const card of verdict.closed) {
    let ok;
    try { ok = Boolean(cancel(card.id, verdict.why[card.id] === "expired" ? EXPIRE_NOTE : NOTE)); } catch { ok = false; }
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

module.exports = { GRACE_SEC, CONFIRM_MS, EXPIRE_SEC, NOTE, EXPIRE_NOTE, hostMatches, classify, endedIds, keepReason, plan, auditRow, appendAudit, auditFile, sweep };
