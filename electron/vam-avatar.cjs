"use strict";

/**
 * vam-avatar — the `vam` avatar source: Virt-A-Mate as the desk's realistic body.
 *
 * Two loopback servers from AitherOS `lib/darklink` do the VaM side; this module
 * is the desk's client for both, and it never starts, installs or restarts them:
 *
 *   127.0.0.1:9341  vam_frames.py   GET /health {ok, frames, stale, age_s, size, error}
 *                                   GET /stream.mjpg  multipart/x-mixed-replace
 *   127.0.0.1:9342  vam_avatar.py   POST /avatar  Content-Type: application/json
 *                                   {expression?, mood?, speaking?, text?}
 *                                   200 ok | 422 a look with no morph | 415 | 400
 *
 * The body shown is the frame stream; the face and jaw are driven by events.
 * Contract, as vam_avatar.py reads it (VamAvatar.handle / expression_for):
 *   - `expression` is one of happy|sad|surprised|angry|neutral (verbatim wins),
 *   - `mood` is the desk's Aeon mood word (folded server-side by MOOD_TO_EXPRESSION),
 *   - `speaking` must be a real boolean (`is True` / `is False`), and `text` rides
 *     only with `speaking: true` (it sets the flap length, words / 2.6 s),
 *   - anything but Content-Type application/json is 415.
 * So this module sends exactly those keys and nothing else.
 *
 * FAIL VISIBLE, NEVER FAIL THE DESK. A dead frame server is a reason string the
 * renderer shows over the VRM it falls back to; a dead avatar server is a logged
 * miss. Nothing here throws into main.
 */

const VAM_FRAMES_BASE = "http://127.0.0.1:9341";
const VAM_AVATAR_BASE = "http://127.0.0.1:9342";
const EXPRESSIONS = ["happy", "sad", "surprised", "angry", "neutral"];
/** Bridge animations that read as a look. TALK/IDLE/GREETING are body motion,
 *  not a face, so they are not forwarded. */
const ANIMATION_EXPRESSION = { HAPPY: "happy", FINGER_GUN: "happy", DANCE: "happy" };
/** How often main re-asks /health while the persona wants VaM: VaM starting or
 *  closing flips the body within one period. */
const PROBE_INTERVAL_MS = 15_000;

function errText(error) {
  if (!error) return "unknown error";
  const code = error.cause && error.cause.code ? error.cause.code : error.code;
  if (code === "ECONNREFUSED") return "connection refused";
  if (error.name === "TimeoutError" || error.name === "AbortError") return "timed out";
  return String(code || error.message || error);
}

/**
 * probeFrames — is there a live VaM picture to show? Resolves, never rejects:
 * `{ok: true, streamUrl, health}` or `{ok: false, reason, health?}` where
 * `reason` is a sentence the owner reads on the fallback badge.
 */
async function probeFrames({ base = VAM_FRAMES_BASE, fetchImpl = globalThis.fetch, timeoutMs = 1500 } = {}) {
  const where = base.replace(/^https?:\/\//, "");
  let res;
  try {
    res = await fetchImpl(`${base}/health`, { signal: AbortSignal.timeout(timeoutMs) });
  } catch (error) {
    return { ok: false, reason: `VaM frame server on ${where}: ${errText(error)}` };
  }
  let health;
  try {
    health = await res.json();
  } catch {
    return { ok: false, reason: `VaM frame server on ${where}: /health answered HTTP ${res.status}, not JSON` };
  }
  if (!res.ok) return { ok: false, reason: `VaM frame server on ${where}: /health HTTP ${res.status}`, health };
  if (!health || health.ok !== true) {
    const why = (health && health.error) || (health && health.stale ? "frames are stale" : "no frame captured yet");
    return { ok: false, reason: `VaM not capturable: ${why}`, health };
  }
  return { ok: true, streamUrl: `${base}/stream.mjpg`, health };
}

/**
 * resolveSource — the event the renderer gets: which body slot0 shows and why.
 * `requested` is the persona's cast.json `avatar`; `probe` is probeFrames()'s
 * verdict (ignored for vrm).
 */
function resolveSource(requested, probe, from = "builtin") {
  if (requested !== "vam") {
    return { type: "avatar-source", slotId: "slot0", requested: "vrm", source: "vrm", streamUrl: null, reason: null, from };
  }
  if (probe && probe.ok) {
    return { type: "avatar-source", slotId: "slot0", requested: "vam", source: "vam", streamUrl: probe.streamUrl, reason: null, from };
  }
  return {
    type: "avatar-source",
    slotId: "slot0",
    requested: "vam",
    source: "vrm",
    streamUrl: null,
    reason: (probe && probe.reason) || "VaM frame server not probed",
    from,
  };
}

/** The exact body vam_avatar.py's handle() reads -- or null when the event
 *  carries nothing it acts on. Keys outside the contract are dropped. */
function vamEvent({ expression, mood, speaking, text } = {}) {
  const out = {};
  if (typeof expression === "string" && EXPRESSIONS.includes(expression.trim().toLowerCase())) {
    out.expression = expression.trim().toLowerCase();
  }
  if (typeof mood === "string" && mood.trim()) out.mood = mood.trim();
  if (speaking === true) {
    out.speaking = true;
    if (typeof text === "string" && text.trim()) out.text = text;
  } else if (speaking === false) {
    out.speaking = false;
  }
  return Object.keys(out).length ? out : null;
}

/**
 * createVamForwarder — desk events -> POST /avatar, in order.
 *
 * Posts are CHAINED: a speaking:false must never overtake the speaking:true it
 * ends (vam_avatar.py's speak() restarts the flap, so a reordered pair leaves
 * the jaw flapping for the whole estimated read time).
 */
function createVamForwarder({
  base = VAM_AVATAR_BASE,
  fetchImpl = globalThis.fetch,
  timeoutMs = 2000,
  log = () => {},
  setTimer = setTimeout,
  clearTimer = clearTimeout,
} = {}) {
  let chain = Promise.resolve();
  let speaking = false;
  let stopTimer = null;
  let lastFailure = "";

  async function send(body) {
    try {
      const res = await fetchImpl(`${base}/avatar`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
      let reply = null;
      try {
        reply = await res.json();
      } catch {
        reply = null;
      }
      lastFailure = "";
      return { ok: res.ok, status: res.status, reply };
    } catch (error) {
      const reason = errText(error);
      // One log line per distinct failure, not one per flap of a dead server.
      if (reason !== lastFailure) log("vam-avatar post failed", reason);
      lastFailure = reason;
      return { ok: false, status: 0, reason };
    }
  }

  function post(fields) {
    const body = vamEvent(fields);
    if (!body) return Promise.resolve({ ok: false, status: 0, reason: "nothing in the vam contract" });
    const next = chain.then(() => send(body));
    chain = next.catch(() => {});
    return next;
  }

  function clearStop() {
    if (stopTimer) clearTimer(stopTimer);
    stopTimer = null;
  }

  /** Start talking. `durationMs` (the TTS clip length, when known) schedules the
   *  matching stop; without it vam_avatar.py ends the flap on its own estimate. */
  function speakingStart(text, durationMs) {
    clearStop();
    speaking = true;
    const p = post({ speaking: true, text });
    if (Number.isFinite(durationMs) && durationMs > 0) {
      stopTimer = setTimer(() => {
        stopTimer = null;
        void speakingStop();
      }, durationMs);
      if (stopTimer && typeof stopTimer.unref === "function") stopTimer.unref();
    }
    return p;
  }

  function speakingStop() {
    clearStop();
    if (!speaking) return Promise.resolve({ ok: true, status: 0, reason: "not speaking" });
    speaking = false;
    return post({ speaking: false });
  }

  /** One desk event (the same object main hands the avatar window). Returns the
   *  post's promise, or null when the event means nothing to VaM. */
  function fromDeskEvent(event) {
    if (!event || typeof event !== "object") return null;
    if (event.type === "state" && event.state) {
      const s = event.state;
      const now = s.phase === "active" && s.activity === "speaking" && !s.outputMuted;
      if (now && !speaking) return speakingStart("");
      if (!now && speaking) return speakingStop();
      return null;
    }
    if (event.type === "aeon-mood" && typeof event.mood === "string" && event.mood) {
      return post({ mood: event.mood });
    }
    if (event.type === "animation") {
      const emotion = typeof event.emotion === "string" ? event.emotion.toLowerCase() : "";
      const look = EXPRESSIONS.includes(emotion) ? emotion : ANIMATION_EXPRESSION[event.animation];
      if (look) return post({ expression: look });
    }
    return null;
  }

  return {
    post,
    speakingStart,
    speakingStop,
    expression: (look) => post({ expression: look }),
    mood: (mood) => post({ mood }),
    fromDeskEvent,
    isSpeaking: () => speaking,
    /** Resolves once every queued post has settled (tests, shutdown). */
    drain: () => chain,
    close: () => clearStop(),
  };
}

module.exports = {
  ANIMATION_EXPRESSION,
  EXPRESSIONS,
  PROBE_INTERVAL_MS,
  VAM_AVATAR_BASE,
  VAM_FRAMES_BASE,
  createVamForwarder,
  probeFrames,
  resolveSource,
  vamEvent,
};
