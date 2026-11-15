"use strict";

/**
 * fairy-panel — what the fairy's Aither panel shows, decided in one pure place.
 *
 * Owner, 2026-11-14: "make this little menu card not look like shit, and make it
 * actually functional and useful." The old card had a header, four giant chips that
 * duplicated the input, an EMPTY box that only repeated "attached to <window>", a
 * blank area, and the input at the bottom. One box and one button now (the
 * customer-UI rule): the input on top, the actions as small chips under it, ONE line
 * naming the session the fairy is attached to with its live state, and a body of real
 * content: the answer, the last few exchanges with that session, and the open
 * decision cards that session raised, answerable in place.
 *
 * Pure: sessions come in as agents-panel shapeSessions() rows, cards as the fairy's
 * attention cards, history as the exchanges orb-window records. No Electron here.
 */

const HISTORY_MAX = 4;
const CARDS_MAX = 3;
const SWITCH_MAX = 8;
const TEXT_MAX = 220;

function clip(value, n = TEXT_MAX) {
  const s = String(value == null ? "" : value).replace(/\s+/g, " ").trim();
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

function norm(value) {
  return String(value || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

/**
 * The session the panel is about: the one the owner picked, else the one whose title
 * matches the window the fairy is attached to (a terminal tab is titled after its
 * session), else none. `sessions` are shapeSessions() rows ({id, title, status, ...}).
 */
function pickSession(sessions, { chosenId = null, attachTitle = "" } = {}) {
  const rows = Array.isArray(sessions) ? sessions.filter((s) => s && s.id) : [];
  if (chosenId) {
    const chosen = rows.find((s) => s.id === chosenId);
    if (chosen) return chosen;
  }
  const want = norm(attachTitle);
  if (!want) return null;
  let best = null;
  let bestLen = 0;
  for (const s of rows) {
    const t = norm(s.title);
    if (!t) continue;
    if ((want.includes(t) || t.includes(want)) && t.length > bestLen) {
      best = s;
      bestLen = t.length;
    }
  }
  return best;
}

/** The open cards a session raised, answerable in place (most urgent first). */
function cardsFor(cards, session) {
  if (!session) return [];
  const rank = { critical: 0, high: 1, normal: 2, low: 3 };
  return (Array.isArray(cards) ? cards : [])
    .filter((c) => c && typeof c.id === "string" && c.sessionId && c.sessionId === session.id)
    .sort((a, b) => (rank[a.urgency] ?? 2) - (rank[b.urgency] ?? 2) || (a.createdAt || 0) - (b.createdAt || 0))
    .slice(0, CARDS_MAX)
    .map((c) => ({
      id: c.id,
      title: clip(c.title || "Decision needed", 120),
      urgency: String(c.urgency || "normal"),
      options: (Array.isArray(c.options) ? c.options : [])
        .filter((o) => o && typeof o.key === "string" && o.key)
        .slice(0, 4)
        .map((o) => ({ key: o.key, label: clip(o.label || o.key, 40), recommended: Boolean(o.recommended) || o.key === c.defaultKey })),
    }));
}

/** Record one exchange (newest last) under `key`; returns the kept list. */
function recordExchange(store, key, { q, a, kind = "answer", at = Date.now() } = {}) {
  const k = String(key || "free");
  const list = store.get(k) || [];
  list.push({ q: clip(q, 160), a: clip(a, TEXT_MAX), kind, at });
  while (list.length > HISTORY_MAX + 1) list.shift();
  store.set(k, list);
  return list;
}

/**
 * The panel's view. `current` is the line on screen (orb-core queue item) so the
 * history never repeats the answer already shown above it.
 */
function panelView({ sessions = null, sessionsNote = "", cards = [], history = new Map(), chosenId = null, attach = null, current = null } = {}) {
  const attachTitle = attach && attach.title ? String(attach.title) : "";
  const rows = Array.isArray(sessions) ? sessions : [];
  const session = pickSession(rows, { chosenId, attachTitle });
  const key = session ? session.id : "free";
  const past = (history.get(key) || []).filter((h) => !(current && h.a === clip(current.text, TEXT_MAX)));
  let line;
  if (session) {
    line = {
      kind: "session",
      id: session.id,
      title: clip(session.title, 60),
      status: String(session.status || "idle"),
      statusText: clip(session.statusText || session.status || "idle", 30),
      last: clip(session.summary || session.next || session.goal || "", 120),
    };
  } else if (attachTitle) {
    line = { kind: "window", title: clip(attachTitle, 60), status: "", statusText: "attached", last: "" };
  } else {
    line = { kind: "free", title: "Aither", status: "", statusText: "", last: "" };
  }
  return {
    line,
    attached: Boolean(attach),
    choices: rows.slice(0, SWITCH_MAX).map((s) => ({ id: s.id, title: clip(s.title, 50), statusText: clip(s.statusText || s.status, 20) })),
    sessionsNote: clip(sessionsNote, 120),
    history: past.slice(-HISTORY_MAX),
    cards: cardsFor(cards, session),
  };
}

/** The bubble's height for its content, inside the window's bounds. */
function fitHeight(contentPx, { min = 112, max = 480 } = {}) {
  const n = Math.ceil(Number(contentPx) || 0);
  return Math.max(min, Math.min(max, n));
}

module.exports = { panelView, pickSession, cardsFor, recordExchange, fitHeight, HISTORY_MAX, CARDS_MAX };
