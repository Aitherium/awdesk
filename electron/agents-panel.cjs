"use strict";

/**
 * agents-panel.cjs -- the data behind the "Agents" tab of the browser side panel
 * (connect-panel.html), and the ONE shape it renders: AGENTS_VIEW v1.
 *
 * WHY (front-door plan, slice 11): the owner should see live sessions, the cards
 * waiting on him and the room without leaving the page he is on. Every source
 * already exists in the desk -- this module only joins and shapes them:
 *
 *   sessions  sessions-client.cjs listSessions()  (harness daemon :8362, /sessions/unified)
 *   cards     main's openDecisions                 (decision-cards.cjs, the awask store)
 *   room      main's roomFeed                      (room-publisher.cjs recentChat())
 *
 * awconnect-next renders the SAME shape in Edge/Chrome
 * (AitherOS/apps/awconnect-next/src/panels/agents/agentsView.ts), so the field
 * names and the section notes below are a contract between the two: change them
 * in both, or the two side panels stop looking identical.
 *
 * Answering is NOT here: the panel's answer goes through main's answerDeckCard,
 * the exact path the Inbox and the deck use (signed approval first, else awask).
 * checkAnswer() only refuses an answer the panel could not honestly have offered:
 * a card that is not open, or a key that is not one of that card's options.
 *
 * Failure is a rendered state ({ok:false, note}), never an empty list:
 * "could not look" and "nothing is waiting" must not read the same.
 */

const VERSION = 1;
const MAX_SESSIONS = 30;
const MAX_CARDS = 20;
const MAX_ROOM = 40;
const TEXT_MAX = 400;
/** Working first: those are the ones the owner glances at. Exited rows are not "live". */
const STATUS_ORDER = Object.freeze({
  "waiting-permission": 0,
  "waiting-input": 1,
  // session_directory.NEEDS_OWNER: the daemon's "maybe blocked" -- still the owner's first look.
  "blocked?": 2,
  working: 3,
  idle: 4,
});
const HIDDEN_STATUS = new Set(["exited", "dead", "ended"]);
/** The statuses both panels highlight as waiting on the owner (session_directory.NEEDS_OWNER). */
const NEEDS_OWNER = Object.freeze(["waiting-permission", "waiting-input", "blocked?"]);
/** The words both side panels show for a session's status. */
const STATUS_TEXT = Object.freeze({
  "waiting-permission": "needs you",
  "waiting-input": "needs you",
  "blocked?": "maybe blocked",
  working: "working",
  idle: "idle",
});

function clip(value, n = TEXT_MAX) {
  const s = String(value == null ? "" : value).replace(/\s+/g, " ").trim();
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

function num(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

/** One /sessions/unified row (after sessions-client withFocus/withActions) -> a panel row. */
function shapeSession(row) {
  if (!row || typeof row !== "object") return null;
  const id = String(row.id || row.session_id || "");
  if (!id) return null;
  const status = String(row.status || "idle");
  if (HIDDEN_STATUS.has(status)) return null;
  const focus = row.focus && typeof row.focus === "object" ? row.focus : {};
  return {
    id,
    title: clip(row.title || row.cwd || id, 120),
    harness: clip(row.harness || "", 40),
    status,
    statusText: STATUS_TEXT[status] || status,
    summary: clip(row.last_activity_summary || ""),
    goal: clip(focus.goal || ""),
    next: clip(focus.next || ""),
    at: num(row.last_activity_at),
  };
}

function shapeSessions(result) {
  if (!result || result.ok !== true) {
    return { ok: false, note: clip((result && result.note) || "the harness daemon did not answer", 200), rows: [] };
  }
  const rows = (Array.isArray(result.sessions) ? result.sessions : [])
    .map(shapeSession)
    .filter(Boolean)
    .sort((a, b) => (STATUS_ORDER[a.status] ?? 9) - (STATUS_ORDER[b.status] ?? 9) || b.at - a.at);
  const shown = rows.slice(0, MAX_SESSIONS);
  const more = rows.length > shown.length ? ` (+${rows.length - shown.length} more)` : "";
  return { ok: true, note: rows.length ? `${rows.length} live${more}` : "No live sessions.", rows: shown };
}

/** One decision-cards.cardFromRaw() card -> a panel card. */
function shapeCard(card) {
  if (!card || typeof card !== "object" || typeof card.id !== "string" || !card.id) return null;
  const options = (Array.isArray(card.options) ? card.options : [])
    .filter((o) => o && typeof o.key === "string" && o.key)
    .map((o) => ({
      key: o.key,
      label: clip(o.label || o.key, 80),
      consequence: clip(o.consequence || "", 200),
      recommended: Boolean(o.recommended) || o.key === card.defaultKey,
    }));
  const from = card.agent || card.tab || (card.cwd ? String(card.cwd).split(/[\\/]/).filter(Boolean).pop() : "");
  return {
    id: card.id,
    title: clip(card.title || "Decision needed", 160),
    summary: clip(card.summary || ""),
    urgency: String(card.urgency || "normal"),
    from: clip(from || "", 80),
    deadline: num(card.deadline),
    createdAt: num(card.createdAt),
    options,
    // The desk IS the owner's surface: every open card with options is answerable here.
    answerable: options.length > 0,
    whyNot: options.length > 0 ? "" : "This card has no options: open it in the Inbox.",
  };
}

function shapeCards(cards) {
  if (!Array.isArray(cards)) return { ok: false, note: "the decision store could not be read", rows: [] };
  const rows = cards.map(shapeCard).filter(Boolean);
  // Most urgent first, then the one blocking longest.
  const rank = { critical: 0, high: 1, normal: 2, low: 3 };
  rows.sort((a, b) => (rank[a.urgency] ?? 2) - (rank[b.urgency] ?? 2) || a.createdAt - b.createdAt);
  return {
    ok: true,
    note: rows.length ? `${rows.length} waiting` : "Nothing is waiting on you.",
    rows: rows.slice(0, MAX_CARDS),
  };
}

/** room-publisher shapeChat() rows -> the transcript, newest last. */
function shapeRoom(rows, status = "ok") {
  const healthy = status === "ok";
  const list = Array.isArray(rows) ? rows : [];
  if (!healthy && list.length === 0) {
    return { ok: false, note: clip(`room unavailable: ${status}`, 200), rows: [] };
  }
  const shaped = list
    .filter((r) => r && typeof r === "object" && r.text)
    .slice(-MAX_ROOM)
    .map((r) => ({
      id: String(r.id || r.seq || ""),
      at: num(r.at),
      author: clip(r.author || "?", 60),
      text: clip(r.text, 600),
      agent: Boolean(r.agent),
    }));
  return { ok: true, note: shaped.length ? "" : "The room is quiet.", rows: shaped };
}

/** The whole tab: {v, sessions, cards, room, waiting}. */
function buildAgentsView({ sessions, cards, room, roomStatus = "ok" } = {}) {
  const c = shapeCards(cards);
  return {
    v: VERSION,
    sessions: shapeSessions(sessions),
    cards: c,
    room: shapeRoom(room, roomStatus),
    waiting: c.rows.length,
  };
}

/** Every section says WHY it is empty -- the desk wiring is missing, not the work. */
function unavailableView(note) {
  const why = clip(note || "not wired", 200);
  return {
    v: VERSION,
    sessions: { ok: false, note: why, rows: [] },
    cards: { ok: false, note: why, rows: [] },
    room: { ok: false, note: why, rows: [] },
    waiting: 0,
  };
}

/**
 * May the panel answer (id, choice)? Only an OPEN card, and only with one of its
 * own option keys -- a renderer cannot invent a choice the raiser never offered.
 * @returns {{ok: true} | {ok: false, error: string}}
 */
function checkAnswer(cards, id, choice) {
  if (typeof id !== "string" || !id || typeof choice !== "string" || !choice) {
    return { ok: false, error: "a card id and a choice are required" };
  }
  const card = (Array.isArray(cards) ? cards : []).find((c) => c && c.id === id);
  if (!card) return { ok: false, error: "That card is no longer open (answered elsewhere?)." };
  const keys = (Array.isArray(card.options) ? card.options : []).map((o) => o && o.key);
  if (!keys.includes(choice)) return { ok: false, error: `"${choice}" is not one of this card's options.` };
  return { ok: true };
}

/**
 * The source main installs into browser-window.setAgentsHost(): joins the three
 * feeds and caches the daemon read for `ttlMs` so a panel polling every few
 * seconds never puts the daemon on the panel's clock.
 *
 * `answer` (main's answerDeckCard wrapper) reports success when awask is SPAWNED,
 * not when it took the answer, and the open-card list only changes when the
 * decision watcher fires. So an answered id is remembered until the card leaves
 * the open list (or `answeredTtlMs` passes, so a refused answer can be retried):
 * meanwhile the view shows it as not answerable and check() refuses a second
 * answer -- no second receipt, no second "answered" line in #agents.
 */
function createAgentsSource({
  listSessions,
  getCards,
  getRoom,
  getRoomStatus = () => "ok",
  answer = null,
  now = Date.now,
  ttlMs = 5000,
  answeredTtlMs = 120000,
}) {
  let cached = null;
  let cachedAt = 0;
  let inflight = null;
  const answered = new Map(); // card id -> when the panel's answer went through
  async function sessions() {
    if (cached && now() - cachedAt < ttlMs) return cached;
    if (!inflight) {
      inflight = Promise.resolve()
        .then(() => listSessions())
        .catch((error) => ({ ok: false, sessions: [], note: String((error && error.message) || error) }))
        .then((result) => {
          cached = result;
          cachedAt = now();
          inflight = null;
          return result;
        });
    }
    return inflight;
  }
  function pruneAnswered(cards) {
    const open = new Set((Array.isArray(cards) ? cards : []).map((c) => c && c.id));
    for (const [id, at] of answered) {
      if (!open.has(id) || now() - at >= answeredTtlMs) answered.delete(id);
    }
  }
  const source = {
    async view() {
      const cards = getCards();
      pruneAnswered(cards);
      const view = buildAgentsView({
        sessions: await sessions(),
        cards,
        room: getRoom(),
        roomStatus: getRoomStatus(),
      });
      for (const row of view.cards.rows) {
        if (!answered.has(row.id)) continue;
        row.answerable = false;
        row.whyNot = "Answered: the desk is closing this card.";
      }
      return view;
    },
    check(id, choice) {
      const cards = getCards();
      pruneAnswered(cards);
      if (answered.has(id)) {
        return { ok: false, error: "Already answered: the desk is closing this card." };
      }
      return checkAnswer(cards, id, choice);
    },
  };
  if (typeof answer === "function") {
    source.answer = async (id, choice, parent) => {
      const verdict = source.check(id, choice);
      if (!verdict.ok) return verdict;
      answered.set(id, now()); // claimed before the await: a double click cannot race past it
      let result;
      try {
        result = await answer(id, choice, parent);
      } catch (error) {
        answered.delete(id);
        throw error;
      }
      if (!result || result.ok !== true) answered.delete(id);
      return result;
    };
  }
  return source;
}

module.exports = {
  VERSION,
  STATUS_TEXT,
  NEEDS_OWNER,
  MAX_SESSIONS,
  MAX_CARDS,
  MAX_ROOM,
  shapeSession,
  shapeSessions,
  shapeCard,
  shapeCards,
  shapeRoom,
  buildAgentsView,
  unavailableView,
  checkAnswer,
  createAgentsSource,
};
