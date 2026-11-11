"use strict";

/**
 * agent-fairy — which fairy the desk wears, and which companions orbit it.
 *
 * Owner, 2026-11-09: "I also need desktop / awdesk / awvatar fairies that match the
 * colors on desktop, and aitherium.com fairy syncing." Every Discord agent bot is a
 * fairy in its Order colour; the desk fairy takes on the colour of whoever is
 * talking or whose card it carries (an Atlas card grey, a Lyra review violet, a
 * Demiurge PR cyan), and the owner's idle fairy stays Aither white-gold.
 *
 * The palette is ONE file, agent-fairies.json, byte-identical to the canonical
 * AitherOS/config/agent-fairies.json and to AitherVeil's copy
 * (check_agent_fairy_palette.py asserts it). This module only reads it.
 *
 * PURE: no electron. node --test.
 */

const PALETTE = require("./agent-fairies.json");

const HEX_RE = /^#[0-9a-f]{6}$/i;
/** A card from nobody in particular: a harness, not an agent. No fairy of its own. */
const GENERIC_RE = /^(claude[- ]?code|claude|codex|agent|session|unknown|an unidentified.*)$/i;

/** "Lyra", "lyra (review)", "demi", "aither-demiurge" -> a palette key, or "". */
function normalizeAgent(name) {
  const raw = String(name == null ? "" : name).trim().toLowerCase();
  if (!raw) return "";
  const agents = PALETTE.agents || {};
  const aliases = PALETTE.aliases || {};
  const direct = aliases[raw] || raw;
  if (agents[direct]) return direct;
  // The first word that names an agent: "Lyra review", "atlas-board", "aither/demi".
  for (const word of raw.split(/[^a-z0-9]+/).filter(Boolean)) {
    const key = aliases[word] || word;
    if (agents[key]) return key;
  }
  return "";
}

function safeHex(value, fallback) {
  return HEX_RE.test(String(value || "")) ? String(value).toLowerCase() : fallback;
}

/**
 * The fairy for an agent: {agent, label, color, core, glow, wings, ring, sparkles,
 * known}. An unknown or empty name is the default (Aither) fairy with known:false.
 */
function fairyFor(name) {
  const key = normalizeAgent(name);
  const fallbackKey = PALETTE.default || "aither";
  const entry = (PALETTE.agents || {})[key || fallbackKey] || {};
  const color = safeHex(entry.color, "#38bdf8");
  return {
    agent: key || fallbackKey,
    label: String(entry.label || key || fallbackKey),
    color,
    core: safeHex(entry.core, "#ffffff"),
    glow: safeHex(entry.glow, color),
    wings: entry.wings === "swept" ? "swept" : "petal",
    ring: entry.ring === true,
    sparkles: entry.sparkles === true,
    known: Boolean(key),
  };
}

/** FNV-1a 32-bit of a string (the web fairy uses the same, so a crew agent is one colour everywhere). */
function fnv1a(text) {
  let h = 0x811c9dc5;
  const s = String(text || "");
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/** hsl(h, s%, l%) -> "#rrggbb". */
function hslHex(h, sat, light) {
  const s = sat / 100;
  const l = light / 100;
  const k = (n) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  const hex = (x) => Math.round(x * 255).toString(16).padStart(2, "0");
  return `#${hex(f(0))}${hex(f(8))}${hex(f(4))}`;
}

/** A crew agent with no palette entry still gets ONE stable colour: its name hashed to a hue. */
function colorForName(name) {
  return hslHex(fnv1a(String(name || "").trim().toLowerCase()) % 360, 70, 60);
}

/** The crew key for a card's agent: the palette key, else the raw name; "" = no agent (generic). */
function crewKey(name) {
  const known = normalizeAgent(name);
  if (known) return known;
  const raw = String(name == null ? "" : name).trim();
  if (!raw || GENERIC_RE.test(raw)) return "";
  return raw.toLowerCase().slice(0, 40);
}

/**
 * The fairy for ANY agent raising cards: the palette fairy when it has one, else a
 * crew fairy in its hashed colour (known:false, crew:true). Never hides an agent.
 */
function crewFairy(name) {
  const known = fairyFor(name);
  if (known.known) return { ...known, crew: false };
  const key = crewKey(name);
  if (!key) return { ...known, crew: false };
  const color = colorForName(key);
  const raw = String(name).trim();
  return {
    agent: key, label: raw.slice(0, 40), color, core: "#ffffff", glow: color,
    wings: "petal", ring: false, sparkles: false, known: false, crew: true,
  };
}

/** The owner's own fairy (nothing to say, no card being carried). */
function restingFairy() {
  return fairyFor(PALETTE.default || "aither");
}

/**
 * A Claude Code session's own fairy key: "session-" + the first 8 of its id.
 * Owner 2026-11-10: "what about discord fairies vs local fairy vs claude/terminal
 * fairies" -- every Claude session's cards said agent "claude-code", which reads as
 * generic, so they had NO fairy, and the sessions themselves never showed.
 */
function sessionKey(sessionId) {
  const s = String(sessionId == null ? "" : sessionId).replace(/[^a-z0-9]/gi, "").slice(0, 8).toLowerCase();
  return s ? `session-${s}` : "";
}

const CLAUDE_AGENT_RE = /^(claude(-code)?|claude code)$/i;

/** Who a card is from: a Claude session's own fairy, else the card's agent (palette or crew), else nobody. */
function cardAgent(card) {
  const key = crewKey(card && card.agent);
  const raw = String((card && card.agent) || "").trim();
  if (card && card.sessionId && (!key || CLAUDE_AGENT_RE.test(raw))) return sessionKey(card.sessionId) || key;
  return key;
}

/**
 * Live Claude Code sessions (session-context.liveSessions) as presence rows: one
 * companion per session, labelled with its name. Busy = working; anything else idle.
 */
function sessionPresence(sessions) {
  const rows = [];
  const entries = sessions instanceof Map ? [...sessions.entries()]
    : Object.entries(sessions && typeof sessions === "object" ? sessions : {});
  for (const [id, s] of entries) {
    const agent = sessionKey(id);
    if (!agent || !s) continue;
    const cwd = String(s.cwd || "").replace(/[\\/]+$/, "");
    const label = String(s.name || cwd.split(/[\\/]/).pop() || "Claude session").trim().slice(0, 40);
    const busy = /^(busy|running|working|thinking)$/i.test(String(s.status || ""));
    rows.push({ agent, label, state: busy ? "working" : "idle", work: [] });
  }
  return rows;
}

/** Presence states, strongest first: what a companion shows. */
const STATES = Object.freeze(["waiting", "speaking", "working", "idle"]);

/** Only an http(s) URL survives (a link the chat can offer); anything else is "". */
function webUrl(value) {
  const raw = String(value || "").trim();
  return /^https:\/\/[^\s]+$/i.test(raw) ? raw.slice(0, 300) : "";
}

/**
 * One presence row from GET /atlas/presence (MCP atlas_presence), normalised:
 * {agent, state, work:[{title,url}], threadUrl, dmUrl, discord}. null = unusable.
 */
function normalizePresence(row) {
  if (!row || typeof row !== "object") return null;
  const agent = crewKey(row.agent);
  if (!agent) return null;
  const raw = String(row.state || "").toLowerCase();
  const state = raw === "waiting" || raw === "working" ? raw : "idle";
  const work = (Array.isArray(row.work) ? row.work : []).slice(0, 5)
    .filter((w) => w && typeof w === "object")
    .map((w) => ({ title: String(w.title || "").slice(0, 120), url: webUrl(w.url), state: String(w.state || "") }));
  const discord = row.discord && typeof row.discord === "object" ? row.discord : null;
  return {
    agent,
    label: String(row.label || "").slice(0, 40),
    state,
    needsOwner: Math.max(0, Number(row.needs_owner) || 0),
    work,
    threadUrl: webUrl(row.thread_url),
    dmUrl: discord ? webUrl(discord.dm_url) : "",
    bot: Boolean(discord && discord.bot),
  };
}

/**
 * The companions that orbit the fairy: one per agent that is ACTIVE -- a card
 * waiting on the owner, live work on Atlas' company board, or a Discord bot of its
 * own (owner 2026-11-09: "active awdesk fairies for each active Discord agent ...
 * one and the same at the platform level") -- every one of them, uncapped, never
 * the agent the main fairy already wears. Exact duplicates merge: one fairy per
 * agent, with the card count.
 *
 * Each: {agent, label, color, core, glow, wings, ring, sparkles, crew, state,
 * cardId, title, count, work, threadUrl, dmUrl, bot}. `state`: waiting (cards or
 * the board says it waits on the owner) > speaking (a line or a post just now) >
 * working > idle. With no presence at all, the old rule holds: companions show
 * only when cards from two or more agents wait.
 */
function companionsFor(cards, { current = "", presence = [], speaking = [] } = {}) {
  const list = Array.isArray(cards) ? cards.filter((c) => c && typeof c.id === "string") : [];
  const byAgent = new Map();
  const slot = (agent) => {
    if (!byAgent.has(agent)) byAgent.set(agent, { card: null, count: 0, name: agent, presence: null });
    return byAgent.get(agent);
  };
  for (const card of list) {
    const agent = cardAgent(card);
    if (!agent) continue;
    const s = slot(agent);
    s.count += 1;
    // The companion carries that agent's NEWEST card: a click opens what it just
    // raised, not a weeks-old ask that happens to rank first (owner 2026-11-09).
    if (!s.card || (Number(card.createdAt) || 0) > (Number(s.card.createdAt) || 0)) {
      s.card = card;
      s.name = card.agent;
    }
  }
  const rows = (Array.isArray(presence) ? presence : []).map(normalizePresence).filter(Boolean);
  if (!rows.length && byAgent.size < 2) return [];
  for (const row of rows) {
    const s = slot(row.agent);
    if (!s.presence) s.presence = row;
    if (!s.card) s.name = row.label || row.agent;
  }
  const talking = new Set((Array.isArray(speaking) ? speaking : []).map((a) => crewKey(a)).filter(Boolean));
  const wearing = crewKey(current);
  const out = [];
  for (const [agent, s] of byAgent) {
    if (agent === wearing) continue;
    const pr = s.presence;
    // A Claude session's fairy: its colour hashed from its own key, its name from the
    // session list (its cards all say "claude-code", which would make every session one).
    const f = agent.startsWith("session-")
      ? { ...crewFairy(agent), label: (pr && pr.label) || "Claude session" }
      : crewFairy(s.name);
    const state = s.count > 0 || (pr && pr.state === "waiting") ? "waiting"
      : talking.has(agent) ? "speaking"
        : pr && pr.state === "working" ? "working" : "idle";
    const firstWork = pr && pr.work.length ? pr.work[0].title : "";
    out.push({
      agent: f.agent, label: f.label, color: f.color, core: f.core, glow: f.glow,
      wings: f.wings, ring: f.ring, sparkles: f.sparkles, crew: Boolean(f.crew),
      state,
      cardId: s.card ? s.card.id : "",
      title: s.card
        ? String(s.card.title || "A decision").replace(/^Claude Code needs you:\s*/i, "").slice(0, 110)
        : firstWork ? firstWork.slice(0, 110) : (state === "idle" ? "idle" : state),
      count: s.count,
      work: pr ? pr.work : [],
      threadUrl: pr ? pr.threadUrl : "",
      dmUrl: pr ? pr.dmUrl : "",
      bot: Boolean(pr && pr.bot),
    });
  }
  // The ones that need the owner first, then who is talking, working, idle.
  const rank = (c) => STATES.indexOf(c.state);
  return out.map((c, i) => ({ c, i })).sort((a, b) => (rank(a.c) - rank(b.c)) || (a.i - b.i)).map((x) => x.c);
}

/**
 * Agents that posted in the relay since `seenAt` (epoch s): their companions flash.
 * The first read (seenAt 0) only sets the mark -- a desk start is not a burst of posts.
 * `rows` are relay-feed shapeRows rows ({agent:true, author:"atlas+sid", at}).
 */
function newPosters(rows, seenAt) {
  if (!(Number(seenAt) > 0)) return [];
  const out = new Set();
  for (const row of Array.isArray(rows) ? rows : []) {
    if (!row || row.agent !== true || !(Number(row.at) > seenAt)) continue;
    const key = crewKey(String(row.author || "").split("+")[0]);
    if (key) out.add(key);
  }
  return [...out];
}

/** The newest message time among `rows`, never moving backwards. */
function latestAt(rows, seenAt = 0) {
  let best = Number(seenAt) || 0;
  for (const row of Array.isArray(rows) ? rows : []) best = Math.max(best, Number(row && row.at) || 0);
  return best;
}

/**
 * Ring capacities: 6 on the first, then 4 more on each ring out (6, 10, 14, ...).
 * The first ring orbits OUTSIDE the 28 px disc (owner 2026-11-10: "there is only
 * one"): at 24 px, six 10 px companions sat under the disc, and the next ring's
 * 6-8 px dots were lost on a 4K screen. DISC_RADIUS is the disc plus its glow.
 */
const DISC_RADIUS = 30;
const RING0_RADIUS = 44;
const RING_STEP = 18;
const RING0_CAP = 6;
const RING_GROW = 4;
/** The smallest a companion is drawn, and the smallest area that answers the pointer. */
const MIN_SIZE = 9;
const HIT_MIN = 16;

/** Companion size for n of them: 14 px, shrinking a quarter pixel per companion past six. */
function companionSize(n) {
  return Math.max(MIN_SIZE, 14 - 0.25 * Math.max(0, (Number(n) || 0) - 6));
}

/**
 * Where every companion sits: rings that grow with the count. Returns one slot per
 * companion {ring, radius, index, of, size, hit} (index/of = its place on its ring).
 */
function swarmLayout(n) {
  const count = Math.max(0, Math.floor(Number(n) || 0));
  const size = companionSize(count);
  const hit = Math.max(HIT_MIN, size + 4);
  const slots = [];
  let ring = 0;
  let left = count;
  while (left > 0) {
    const cap = RING0_CAP + ring * RING_GROW;
    const on = Math.min(cap, left);
    for (let i = 0; i < on; i += 1) {
      slots.push({ ring, radius: RING0_RADIUS + ring * RING_STEP, index: i, of: on, size, hit });
    }
    left -= on;
    ring += 1;
  }
  return slots;
}

/** Half the side of the square the swarm needs (outer ring + its fairy + a glow). */
function swarmExtent(n) {
  const slots = swarmLayout(n);
  if (!slots.length) return 0;
  const outer = slots[slots.length - 1];
  return Math.ceil(outer.radius + Math.max(outer.size, outer.hit) / 2 + 8);
}

/** Where a slot sits at time t (pixels from the centre). Alternate rings turn opposite ways. */
function companionOffset(slot, nowMs) {
  const dir = slot.ring % 2 === 0 ? 1 : -1;
  const turn = ((Number(nowMs) || 0) / (9000 + slot.ring * 3000)) * dir;
  const a = 2 * Math.PI * (slot.index / Math.max(1, slot.of)) + 2 * Math.PI * turn + slot.ring * 0.4;
  return { x: Math.round(Math.cos(a) * slot.radius), y: Math.round(Math.sin(a) * slot.radius * 0.82) };
}

/** How long the fairy wears a speaker's colour: about the length of the line. */
function speakingMs(text) {
  const n = String(text || "").length;
  return Math.max(3000, Math.min(20000, n * 65));
}

module.exports = {
  PALETTE,
  normalizeAgent,
  fairyFor,
  crewFairy,
  crewKey,
  colorForName,
  restingFairy,
  cardAgent,
  sessionKey,
  sessionPresence,
  companionsFor,
  normalizePresence,
  newPosters,
  latestAt,
  STATES,
  DISC_RADIUS,
  companionSize,
  swarmLayout,
  swarmExtent,
  companionOffset,
  speakingMs,
};
