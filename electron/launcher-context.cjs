"use strict";

/**
 * launcher-context -- what Alt+Space shows BEFORE you type.
 *
 * Owner, 2026-11-06: "alt+space and bringing up that overlay needs better
 * integration". Measured: the empty launcher answered `groups: []` and drew
 * "Type to search" -- while the desk already knew which app the owner had in
 * front of them (host-context.cjs). The overlay was a blank text box sitting on
 * top of the exact thing the owner wanted help with.
 *
 * The empty state is now a "Right now" group built from the foreground window:
 * the first row asks Aither about THAT window, the rest are the desk's own
 * actions for it. Every row is a kind launchItem already runs ("agent" sends a
 * prompt to chat, "action" runs a desk command), so nothing new can execute.
 *
 * Two rules:
 *  - The overlay itself is never the subject. Alt+Space takes focus, so a naive
 *    sample can read the desk's own window; those are filtered out and the group
 *    is simply omitted rather than offering "ask about Aither launcher".
 *  - An unreadable host never becomes a row. {ok:false} -> no group, and the
 *    status line says why, instead of a row about nothing.
 */

const OWN_WINDOW = /^(electron|aither|awdesk|desk)$/i;
const OWN_TITLE = /aither (launcher|spirit|search)|^desk$/i;

/** Is this sample the desk itself (so not worth offering)? */
function isOwnWindow(context) {
  if (!context || !context.ok) return false;
  return OWN_WINDOW.test(String(context.app || "")) || OWN_TITLE.test(String(context.title || ""));
}

function clip(text, max) {
  const s = String(text || "").replace(/\s+/g, " ").trim();
  return s.length > max ? s.slice(0, max - 1) + "…" : s;
}

/**
 * Build the "Right now" group from a host-context sample and the action ids the
 * registry actually has. Pure: same input, same rows.
 *
 * @param {object} context  sampleHostContext() result
 * @param {(id: string) => boolean} hasAction  whether the registry has a command
 * @returns {{group: object|null, status: string, items: object[]}}
 */
function rightNowGroup(context, hasAction = () => false) {
  if (!context || !context.ok) {
    return {
      group: null,
      items: [],
      status: context && context.reason ? `Can't see the foreground window: ${clip(context.reason, 90)}` : "",
    };
  }
  if (isOwnWindow(context)) return { group: null, items: [], status: "" };

  const app = clip(context.app || "this window", 40);
  const title = clip(context.title, 70);
  const subject = title ? `${app} — ${title}` : app;

  const items = [
    {
      key: "ctx:ask",
      kind: "agent",
      title: `Ask Aither about ${app}`,
      subtitle: subject,
      // chatPrompt(query, item) appends 'Use the agent "aither"'. The launcher
      // passes `prompt` as the QUERY for a ctx: row (an empty box has no query of
      // its own), so the message names the window the owner is actually in.
      target: "agents:aither",
      prompt: `I'm looking at ${subject}. Help me with what's on screen.`,
      score: 1,
    },
  ];
  const offers = [
    ["snip.region", "Snip this window", "Capture it and ask about the picture"],
    ["snip.screen", "Capture the whole screen", "Aither reads the pixels, not just the title"],
    ["note.new", "Note about this", `A note pinned to ${app}`],
  ];
  for (const [id, label, sub] of offers) {
    if (!hasAction(id)) continue;
    items.push({ key: `ctx:${id}`, kind: "action", title: label, subtitle: sub, target: id, score: 0.9 });
  }

  return {
    group: { id: "now", label: "Right now", total: items.length, items },
    items,
    status: `Looking at ${subject}`,
  };
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

module.exports = { isOwnWindow, rightNowGroup, needsYouGroup };

