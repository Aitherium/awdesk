"use strict";

/**
 * fairy-queue -- the list behind the fairy's "N more waiting ›" link.
 *
 * Owner, 2026-11-10: 99+ cards waited and he could not find the ONE a live session
 * was stopped on. The whisper only ever shows the top card plus "99+ more waiting",
 * which opened the Inbox on whatever it showed last. This is the list that link
 * opens now: every waiting card in ONE flat, searchable order, repeats collapsed,
 * needs-you cards first, and cards that answer themselves (a deadline picks their
 * default; the suggestion is "Skip") folded behind a toggle rather than floated.
 *
 * The RULES are here, pure (no electron, no fs) and node --test'd; the window
 * (fairy-queue-window.cjs) only renders what queueView() returns, so a test can
 * name which rule put a card where without a browser.
 *
 * Nothing here answers, dismisses or snoozes a card. Opening one routes to the
 * SAME Inbox answer path every other surface uses; the owner's answer stays the
 * owner's.
 */

const decisionCards = require("./decision-cards.cjs");

/** A card with no agent/tab/host/folder is still filterable as one chip. */
const OTHER_SOURCE = "Other";

/** Text with case, spacing and punctuation flattened ("Wake X failed" === "wake x failed"). */
function normalizeText(value) {
  return String(value == null ? "" : value).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
}

/** Where a card came from, as the chip's label: agent, then tab, then host, then folder. */
function cardSource(card) {
  const text = (v) => String(v == null ? "" : v).trim();
  const agent = text(card && card.agent);
  if (agent) return agent;
  const tab = text(card && card.tab);
  if (tab) return tab;
  const host = text(card && card.host);
  if (host) return host;
  const cwd = text(card && card.cwd);
  if (cwd) return cwd.split(/[\\/]/).filter(Boolean).pop() || OTHER_SOURCE;
  return OTHER_SOURCE;
}

/** Everything a search may match: title, source, and the card's own body. */
function haystack(card, source) {
  const facts = Array.isArray(card && card.facts) ? card.facts : [];
  return [
    card && card.title,
    source,
    card && card.summary,
    card && card.detail,
    ...facts,
    card && card.kind,
  ].filter((v) => typeof v === "string" && v).join(" ").toLowerCase();
}

/** What a row says about its own suggested answer ("Skip", "Keep it scheduled"). */
function suggestedLine(card) {
  const label = decisionCards.suggestedLabel ? decisionCards.suggestedLabel(card) : "";
  if (!label) return "";
  return card && decisionCards.isNoopSuggestion(card) ? `suggests “${label}” — changes nothing` : `suggests “${label}”`;
}

/**
 * One entry per (source, title): the first card in the input's order is the
 * representative (the caller hands cards in rank order), and every repeat rides
 * on the entry's `ids`. A card with no title never merges -- two asks are only
 * "the same" when they say the same thing from the same place.
 */
function groupRepeats(cards) {
  const groups = [];
  const byKey = new Map();
  for (const card of Array.isArray(cards) ? cards : []) {
    if (!card || !card.id) continue;
    const source = cardSource(card);
    const title = String(card.title || "");
    const key = title.trim()
      ? `${source.toLowerCase()}\u0000${normalizeText(title)}`
      : `id\u0000${card.id}`;
    let group = byKey.get(key);
    if (!group) {
      group = {
        id: card.id,
        ids: [],
        cards: [],
        source,
        title,
        kind: String(card.kind || ""),
        urgency: String(card.urgency || ""),
        createdAt: Number(card.createdAt) || 0,
        deadline: Number(card.deadline) || 0,
        summary: String(card.summary || card.detail || "").slice(0, 240),
        suggested: suggestedLine(card),
      };
      byKey.set(key, group);
      groups.push(group);
    }
    group.ids.push(card.id);
    group.cards.push(card);
  }
  for (const group of groups) {
    group.count = group.ids.length;
    group.needsYou = group.cards.some((c) => decisionCards.isNeedsYou(c));
    group.selfAnswering = group.cards.every((c) => decisionCards.isSelfAnswering(c));
  }
  return groups;
}

/** Needs-you entries first; inside a tier the caller's rank order is kept. */
function orderEntries(entries, needsYouFirst = true) {
  if (!needsYouFirst) return entries.slice();
  const lead = entries.filter((e) => e.needsYou);
  const rest = entries.filter((e) => !e.needsYou);
  return lead.concat(rest);
}

/** The chips: every source present after search/hide, with how many entries it holds. */
function sourceChips(entries) {
  const counts = new Map();
  for (const entry of entries) counts.set(entry.source, (counts.get(entry.source) || 0) + 1);
  return [...counts.entries()]
    .map(([label, count]) => ({ label, count }))
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
}

/**
 * What the queue window shows for the current search/filter state.
 *
 * Args:
 *   cards: ranked cards, in queue order (main's listOpen).
 *   query: every whitespace-separated token must match title/source/body.
 *   source: an exact chip label ("" = every source).
 *   hideSelfAnswering: hide entries where EVERY card answers itself.
 *   needsYouFirst: pin entries holding a credential/blocked/blocking card on top.
 *
 * Returns {entries, sources, totalEntries, totalCards, filteredEntries,
 * filteredCards, shownEntries, shownCards, hiddenEntries} -- `total*` is the whole
 * queue, `filtered*` what survived the search and the self-answering toggle (what
 * the chips count), `shown*` what survived the source chip as well.
 */
function queueView(cards, {
  query = "",
  source = "",
  hideSelfAnswering = false,
  needsYouFirst = true,
} = {}) {
  const entries = groupRepeats(cards);
  const tokens = String(query || "").toLowerCase().split(/\s+/).filter(Boolean);
  const wanted = String(source || "").trim().toLowerCase();
  const searched = entries.filter((entry) => {
    if (!tokens.length) return true;
    // EVERY card in a collapsed entry can match -- a repeat's body counts, or the
    // search would hide a group because its first card happened to be terse.
    const hay = entry.cards.map((card) => haystack(card, entry.source)).join(" ");
    return tokens.every((token) => hay.includes(token));
  });
  const visible = searched.filter((entry) => !(hideSelfAnswering && entry.selfAnswering));
  const sources = sourceChips(visible);
  const matched = wanted
    ? visible.filter((entry) => entry.source.toLowerCase() === wanted)
    : visible;
  const shown = orderEntries(matched, needsYouFirst);
  const countCards = (list) => list.reduce((n, entry) => n + entry.count, 0);
  return {
    entries: shown,
    sources,
    totalEntries: entries.length,
    totalCards: countCards(entries),
    filteredEntries: visible.length,
    filteredCards: countCards(visible),
    shownEntries: shown.length,
    shownCards: countCards(shown),
    hiddenEntries: entries.length - shown.length,
  };
}

module.exports = {
  OTHER_SOURCE,
  normalizeText,
  cardSource,
  suggestedLine,
  groupRepeats,
  orderEntries,
  sourceChips,
  queueView,
};
