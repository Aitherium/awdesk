"use strict";

/**
 * speech-arbiter.cjs -- ONE voice at a time, by priority.
 *
 * Owner, 2026-11-16: "they all talked over each other" -- two terminal-session actors and Aither
 * speaking coding-session text at once. Every speaker called speakAloud on its own and each
 * clip played the moment it was synthesized. This is the single lane every spoken line goes
 * through (main.cjs speakAloud):
 *
 *   rank 0  the owner's direct conversation (voice answers, drop-to-avatar, "Listening.")
 *   rank 1  decision cards (the needs-you lead)
 *   rank 2  Aither (the resident body)
 *   rank 3  everything else
 *
 * One line plays at a time and the lane is held for the clip's own length. A waiting line is
 * picked by rank, then arrival. It is never cut off by an ordinary higher rank (a sentence is
 * not interrupted mid-word) but jumps the queue. A line that waited longer than STALE_MS is
 * dropped (its caption still shows: `onDrop`) -- a coding session's "pushed the branch" that
 * is two minutes old is noise, not news; the owner's own conversation gets longer (OWNER_STALE_MS).
 * The queue is bounded: past MAX_WAITING the oldest lowest-ranked line goes.
 *
 * P0 escalation (A5, "Aither yells"): a job enqueued with `preempt: true` (the P0 card line,
 * rank 1) may CUT the line that is playing, once -- never the owner's own words (rank 0: a
 * sentence the owner started is not interrupted by the desk). A new P0 also drops a
 * lower-priority line queued in the last PREEMPT_GRACE_MS (2 s): next to an alarm that line is
 * already stale news, and its caption still shows via `onDrop`. A preempting line itself is
 * never dropped as stale. The cut is the new line starting: the renderer closes the previous
 * AudioContext when the next `speak` arrives.
 *
 * Electron-free and clock-injected (speech-arbiter.test.cjs).
 */

const STALE_MS = 20_000;
const OWNER_STALE_MS = 60_000;
const GAP_MS = 250;
const MAX_WAITING = 6;
/** A lower-priority line queued within this window is dropped when a P0 cuts in. */
const PREEMPT_GRACE_MS = 2_000;
/** Held at most this long after a clip, whatever its reported length. */
const MAX_HOLD_MS = 90_000;

const OWNER_ORIGINS = new Set([
  "service:awdesk-voice",
  "service:awdesk-voice-answer",
  "desk:drop",
]);
const CARD_ORIGINS = new Set(["service:awdesk-decisions"]);
/** An origin kind that is a coding / terminal session (room-stage rows carry `claude_code:<id>`). */
const SESSION_KIND = /^(claude_code|claude-code|terminal|session|codex|pty|cli|subagent)(:|$)/i;

/** Who is speaking, as a rank. Pure. */
function priorityOf({ origin = "", slotId = "slot0", speaker = null } = {}) {
  const o = String(origin || "");
  if (OWNER_ORIGINS.has(o)) return 0;
  if (CARD_ORIGINS.has(o)) return 1;
  if (isSessionSpeaker({ origin, speaker })) return 3;
  const agent = speaker && speaker.agent ? String(speaker.agent).toLowerCase() : "";
  const resident = !slotId || slotId === "slot0" || slotId === "default";
  if (agent === "aither" || (resident && !agent)) return 2;
  return 3;
}

/** A coding / terminal session actor (silent by default). Pure. */
function isSessionSpeaker({ origin = "", speaker = null } = {}) {
  if (speaker && speaker.session === true) return true;
  const o = String((speaker && speaker.origin) || origin || "");
  return SESSION_KIND.test(o);
}

/**
 * The persistent "this session may talk" set, a small JSON file next to cast.json. A coding
 * session is silent until the owner opts it in from its menu; the choice survives a restart.
 * fs-injected; a missing or malformed file means nobody is opted in.
 */
function createSessionVoices({ file, fs = require("node:fs") } = {}) {
  let keys = null;
  const load = () => {
    if (keys) return keys;
    keys = new Set();
    try {
      const raw = JSON.parse(fs.readFileSync(file, "utf8"));
      for (const k of Array.isArray(raw && raw.keys) ? raw.keys : []) if (typeof k === "string" && k) keys.add(k);
    } catch { /* nobody opted in */ }
    return keys;
  };
  const save = () => {
    try { fs.writeFileSync(file, JSON.stringify({ keys: [...load()].sort() }, null, 2)); } catch { /* best-effort */ }
  };
  return {
    has: (key) => load().has(String(key)),
    set(key, on) {
      const k = String(key);
      if (!k) return false;
      if (on) load().add(k); else load().delete(k);
      save();
      return Boolean(on);
    },
    list: () => [...load()].sort(),
  };
}

/** The key a session's opt-in is stored under: stable across launches (author + seat), else its origin. */
function sessionKey({ speaker = null, origin = "", slotId = "" } = {}) {
  if (speaker && speaker.author) return `${String(speaker.author).toLowerCase()}:${Number.isInteger(speaker.seat) ? speaker.seat : 0}`;
  if (speaker && speaker.origin) return String(speaker.origin);
  return String(origin || slotId || "");
}

/**
 * createSpeechArbiter({ run, onDrop, now, setTimer, clearTimer, staleMs, ... })
 *   run(job): Promise<result>  performs the line (synthesis + playback hand-off); a result with
 *             `ok` and `durationMs` holds the lane for that long.
 *   enqueue({ rank, text, slotId, origin, meta }): Promise<result> -- resolves with run's
 *             result, or { ok:false, refused:"arbiter", reason } when the line was dropped.
 */
function createSpeechArbiter({
  run,
  onDrop = () => {},
  onCut = () => {},
  now = Date.now,
  setTimer = (fn, ms) => { const t = setTimeout(fn, ms); if (t && t.unref) t.unref(); return t; },
  clearTimer = clearTimeout,
  staleMs = STALE_MS,
  ownerStaleMs = OWNER_STALE_MS,
  gapMs = GAP_MS,
  preemptGraceMs = PREEMPT_GRACE_MS,
  maxWaiting = MAX_WAITING,
} = {}) {
  const waiting = [];
  let busy = false;
  let holdTimer = null;
  let seq = 0;
  let generation = 0;
  let current = null; // { job, gen, cut } -- the line holding the lane right now

  // A P0 is news, not a stale straggler: it is never dropped for waiting behind the owner.
  const staleFor = (job) => (job.preempt === true ? Number.POSITIVE_INFINITY : job.rank === 0 ? ownerStaleMs : staleMs);

  function drop(job, reason) {
    try { onDrop(job, reason); } catch { /* a caption must not break the lane */ }
    job.resolve({ ok: false, refused: "arbiter", reason, captioned: true });
  }

  function release() {
    holdTimer = null;
    busy = false;
    current = null;
    pump();
  }

  /** A P0 cuts the playing line once. Never the owner's words or an equal/higher line. */
  function cutCurrent(entry) {
    if (!busy || !current) return false;
    if (current.job.rank <= entry.rank) return false;
    const victim = current.job;
    current.cut = true;
    current = null;
    if (holdTimer) { clearTimer(holdTimer); holdTimer = null; }
    busy = false;
    try { onCut(victim, entry); } catch { /* a cut must not break the lane */ }
    return true;
  }

  function pump() {
    if (busy) return;
    // Stale lines go first (their caption already showed or shows now), then the best one plays.
    for (let i = waiting.length - 1; i >= 0; i -= 1) {
      if (now() - waiting[i].at > staleFor(waiting[i])) drop(waiting.splice(i, 1)[0], "stale: waited too long behind another voice");
    }
    if (!waiting.length) return;
    waiting.sort((a, b) => a.rank - b.rank || a.seq - b.seq);
    const job = waiting.shift();
    busy = true;
    const mine = { job, gen: (generation += 1), cut: false };
    current = mine;
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      // This line was cut by a P0 or the lane already moved on: settle its promise and get
      // out of the way. It must NOT re-hold the lane the preempting line now owns.
      if (mine.cut || current !== mine) { job.resolve(result); return; }
      job.resolve(result);
      const ms = result && result.ok && Number.isFinite(result.durationMs) && result.durationMs > 0
        ? Math.min(MAX_HOLD_MS, result.durationMs + gapMs)
        : 0;
      // `current` stays set for the whole hold: that is the line a P0 is allowed to cut.
      if (ms > 0) holdTimer = setTimer(release, ms);
      else release();
    };
    Promise.resolve()
      .then(() => run(job))
      .then(finish, (error) => finish({ ok: false, reason: String((error && error.message) || error) }));
  }

  function enqueue(job) {
    return new Promise((resolve) => {
      const entry = { ...job, rank: Number.isInteger(job.rank) ? job.rank : 3, at: now(), seq: (seq += 1), resolve };
      if (job.preempt === true) {
        // The news that arrived just behind the alarm is already old: drop a lower-priority
        // line queued within the grace window (its caption still shows), then cut the playing
        // line once. Both are best-effort and cannot throw into the caller.
        for (let i = waiting.length - 1; i >= 0; i -= 1) {
          const w = waiting[i];
          if (w.rank > entry.rank && now() - w.at <= preemptGraceMs) {
            drop(waiting.splice(i, 1)[0], "preempted by a P0");
          }
        }
        cutCurrent(entry);
      }
      waiting.push(entry);
      // Bounded: past the cap the oldest of the LOWEST rank goes (never the line just added if it outranks).
      while (waiting.length > maxWaiting) {
        let victim = 0;
        for (let i = 1; i < waiting.length; i += 1) {
          const a = waiting[i];
          const b = waiting[victim];
          if (a.rank > b.rank || (a.rank === b.rank && a.seq < b.seq)) victim = i;
        }
        drop(waiting.splice(victim, 1)[0], "queue full: older, lower-priority line dropped");
      }
      pump();
    });
  }

  return {
    enqueue,
    state: () => ({ busy, waiting: waiting.map((j) => ({ rank: j.rank, slotId: j.slotId, ageMs: now() - j.at })) }),
    /** Test / shutdown hook. */
    stop() { if (holdTimer) clearTimer(holdTimer); holdTimer = null; },
  };
}

module.exports = {
  STALE_MS, OWNER_STALE_MS, GAP_MS, MAX_WAITING, PREEMPT_GRACE_MS,
  priorityOf, isSessionSpeaker, sessionKey, createSessionVoices, createSpeechArbiter,
};
