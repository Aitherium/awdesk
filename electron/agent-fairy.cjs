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

/** Who a card is from: the card's agent (palette or crew), else nobody. */
function cardAgent(card) {
  return crewKey(card && card.agent);
}

/**
 * The companions that orbit the fairy: one per agent with a card waiting, in the
 * queue's own order, EVERY agent (owner 2026-11-09: "WHY ONLY UP TO 4????"), never
 * the agent the main fairy already wears. Exact duplicates merge: one fairy per
 * agent with a count. Shown only when cards from TWO or more agents wait.
 * Each: {agent, label, color, core, glow, wings, ring, sparkles, crew, cardId, title, count}.
 */
function companionsFor(cards, { current = "" } = {}) {
  const list = Array.isArray(cards) ? cards.filter((c) => c && typeof c.id === "string") : [];
  const byAgent = new Map();
  for (const card of list) {
    const agent = cardAgent(card);
    if (!agent) continue;
    const seen = byAgent.get(agent);
    if (seen) { seen.count += 1; continue; }
    byAgent.set(agent, { card, count: 1 });
  }
  if (byAgent.size < 2) return [];
  const wearing = crewKey(current);
  const out = [];
  for (const [agent, { card, count }] of byAgent) {
    if (agent === wearing) continue;
    const f = crewFairy(card.agent);
    out.push({
      agent: f.agent, label: f.label, color: f.color, core: f.core, glow: f.glow,
      wings: f.wings, ring: f.ring, sparkles: f.sparkles, crew: Boolean(f.crew),
      cardId: card.id,
      title: String(card.title || "A decision").replace(/^Claude Code needs you:\s*/i, "").slice(0, 110),
      count,
    });
  }
  return out;
}

/** Ring capacities: 6 on the first, then 4 more on each ring out (6, 10, 14, ...). */
const RING0_RADIUS = 24;
const RING_STEP = 16;
const RING0_CAP = 6;
const RING_GROW = 4;
/** The smallest a companion is drawn, and the smallest area that answers the pointer. */
const MIN_SIZE = 6;
const HIT_MIN = 12;

/** Companion size for n of them: 10 px, shrinking a quarter pixel per companion past six. */
function companionSize(n) {
  return Math.max(MIN_SIZE, 10 - 0.25 * Math.max(0, (Number(n) || 0) - 6));
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
  companionsFor,
  companionSize,
  swarmLayout,
  swarmExtent,
  companionOffset,
  speakingMs,
};
