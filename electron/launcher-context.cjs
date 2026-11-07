"use strict";

/**
 * launcher-context -- what Alt+Space shows BEFORE you type.
 *
 * Owner, 2026-11-06: the decision cards need to be one list you can reach from
 * the keyboard. The empty launcher leads with a "Needs you (N)" group built
 * from decision-cards.listSnapshot(). Every row is `kind: "card"`; answering
 * one goes through the "card-answer" command, which resolves the number/text to
 * the card's own option key and lets awask record it (DCS001). This module only
 * shapes rows -- it never writes.
 */

function clip(text, max) {
  const s = String(text || "").replace(/\s+/g, " ").trim();
  return s.length > max ? s.slice(0, max - 1) + "…" : s;
}

/**
 * One card as a launcher row: what it asks, the number keys that answer it, and
 * the RAISER's recommendation. No card body is rendered here -- the row is one
 * line until the owner expands it.
 */
function cardSubtitle(card) {
  const bits = [];
  const kind = String(card.kind || "decision");
  if (kind && kind !== "decision") bits.push(kind);
  const urgency = String(card.urgency || "").toLowerCase();
  if (urgency && urgency !== "normal") bits.push(urgency);
  if (card.stale) bits.push("stale");
  const options = Array.isArray(card.options) ? card.options : [];
  if (options.length) bits.push(`${options.length} ${options.length === 1 ? "option" : "options"}`);
  const summary = String(card.summary || "").replace(/\s+/g, " ").trim();
  if (summary) bits.push(summary.length > 80 ? summary.slice(0, 79) + "…" : summary);
  return bits.join(" · ");
}

/**
 * The "Needs you (N)" group: the open decision cards, in the store's rank order
 * (the caller passes decision-cards.listSnapshot(), so there is no second
 * ranking), ABOVE the foreground-window group.
 *
 * Rows are `kind: "card"` so the launcher can answer and expand them without
 * pretending they are an app; the card id travels as `target` and the card's
 * own option keys travel in `options`, exactly as the deck receives them. All
 * writes still leave through awask -- this function only shapes rows.
 *
 * `cap` keeps the empty overlay a glance, not a scroll: the group says how many
 * more there are and one key opens the full list. Expanding draws up to
 * `expandCap` rows in place -- past that the deck is the list, so the DOM never
 * grows with the store.
 */
function needsYouGroup(cards, { cap = 5, expandCap = 40 } = {}) {
  const list = Array.isArray(cards) ? cards.filter((c) => c && typeof c.id === "string") : [];
  if (list.length === 0) return { group: null, items: [], status: "" };

  const visible = list.slice(0, Math.max(1, expandCap));
  const items = visible.map((card, i) => ({
    key: `card:${card.id}`,
    kind: "card",
    title: clip(card.title || "Decision needed", 70),
    subtitle: cardSubtitle(card),
    // The launcher's card path reads this; it is an id, never card text.
    target: card.id,
    cardId: card.id,
    defaultKey: typeof card.defaultKey === "string" ? card.defaultKey : "",
    needsYou: card.needsYou === true,
    stale: card.stale === true,
    options: (Array.isArray(card.options) ? card.options : []).map((o, index) => ({
      index: Number.isInteger(o.index) ? o.index : index + 1,
      key: String(o.key || ""),
      label: String(o.label || o.key || ""),
      recommended: o.recommended === true,
    })),
    // A hair of score separation, purely so a merge keeps this order.
    score: 1 - i / 100,
  }));

  // `shown` is the collapsed slice launcher.html draws before the owner expands;
  // `items` is everything this group is willing to draw. Same objects, so a row
  // is identical open and closed and cannot move when the list is expanded.
  return {
    group: {
      id: "needs-you",
      // The overlay draws the count in its own badge (as it does for "Right
      // now"); putting it in the label too printed "Needs you (8) 8".
      label: "Needs you",
      total: list.length,
      shown: items.slice(0, Math.max(1, cap)),
      more: Math.max(0, list.length - Math.max(1, cap)),
      items,
    },
    items,
    status: "",
  };
}

module.exports = { needsYouGroup };
