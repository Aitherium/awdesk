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
const MAX_COMPANIONS = 4;

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

/** The owner's own fairy (nothing to say, no card being carried). */
function restingFairy() {
  return fairyFor(PALETTE.default || "aither");
}

/** Who a card is from: the card's agent, else nobody (the default fairy). */
function cardAgent(card) {
  return normalizeAgent(card && card.agent);
}

/**
 * The small companions that orbit the fairy: one per agent with a card waiting,
 * most-urgent-first by the queue's own order, at most four, never the agent the
 * main fairy already wears. Shown only when cards from TWO or more agents wait.
 * Each: {agent, color, core, glow, wings, ring, sparkles, label, cardId, title, count}.
 */
function companionsFor(cards, { current = "", max = MAX_COMPANIONS } = {}) {
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
  const wearing = normalizeAgent(current);
  const out = [];
  for (const [agent, { card, count }] of byAgent) {
    if (agent === wearing) continue;
    const f = fairyFor(agent);
    out.push({
      agent: f.agent, label: f.label, color: f.color, core: f.core, glow: f.glow,
      wings: f.wings, ring: f.ring, sparkles: f.sparkles,
      cardId: card.id,
      title: String(card.title || "A decision").replace(/^Claude Code needs you:\s*/i, "").slice(0, 110),
      count,
    });
    if (out.length >= Math.max(0, Number(max) || 0)) break;
  }
  return out;
}

/** Where companion i of n sits on its orbit at time t (page pixels from the centre). */
function companionOffset(i, n, nowMs, radius = 24) {
  const count = Math.max(1, Number(n) || 1);
  const turn = (Number(nowMs) || 0) / 9000; // one slow lap every 9 s
  const a = (2 * Math.PI * (i / count)) + 2 * Math.PI * turn;
  return { x: Math.round(Math.cos(a) * radius), y: Math.round(Math.sin(a) * radius * 0.82) };
}

/** How long the fairy wears a speaker's colour: about the length of the line. */
function speakingMs(text) {
  const n = String(text || "").length;
  return Math.max(3000, Math.min(20000, n * 65));
}

module.exports = {
  PALETTE,
  MAX_COMPANIONS,
  normalizeAgent,
  fairyFor,
  restingFairy,
  cardAgent,
  companionsFor,
  companionOffset,
  speakingMs,
};
