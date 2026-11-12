"use strict";

/**
 * fairy-menu.cjs -- what a RIGHT-click on a fairy or on the orb offers, and the
 * one-line tooltip a hover may show.
 *
 * Owner, 2026-11-12: "hovering over fairies causes cards to keep popping and they
 * change so fast -- don't engage on hover, require a click/right click. Make the
 * left-click and right-click interactions and menus better; the fairies in
 * AitherOS Online are actually nice."
 *
 * So the desk follows Online's fairy (Veil os-fairy.tsx):
 *   hover        a one-line tooltip after a dwell, never a card, never focus.
 *   left click   a companion fairy -> its card, pinned until closed or another click;
 *                the orb -> the waiting queue (no cards: the ask bubble).
 *   right click  a pill menu (Online's .osf-pill look) built here, drawn by orb.html
 *                view=menu, picked by id in orb-window.cjs.
 *
 * PURE: no electron, no fs. The caller owns the clock and the windows.
 */

const MIN = 60_000;
const HOUR = 60 * MIN;

/** The hover dwell before a tooltip shows. A sweep across the swarm shows nothing. */
const TIP_DWELL_MS = 400;
/** A tooltip is one line. */
const TIP_MAX = 72;
/** An explicitly opened card stays this long unless closed or replaced by a click. */
const PINNED_MS = 30 * MIN;

/** Menu geometry: the page (orb.html view=menu) draws exactly these sizes. */
const MENU = Object.freeze({ width: 268, row: 34, sep: 9, head: 30, pad: 12 });

const SNOOZES = Object.freeze([
  Object.freeze({ id: "snooze:1h", label: "Snooze 1 hour" }),
  Object.freeze({ id: "snooze:4h", label: "Snooze 4 hours" }),
  Object.freeze({ id: "snooze:tomorrow", label: "Snooze until tomorrow 9:00" }),
]);

function clip(text, max) {
  const s = String(text == null ? "" : text).replace(/\s+/g, " ").trim();
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

function isCredential(card) {
  return String((card && card.kind) || "").toLowerCase() === "credential";
}

/**
 * The option the card recommends, or null. Same rule as Online's whisper: an
 * option marked `recommended`, else the card's `default_key` / `recommend`.
 * A credential card is never answered from a menu.
 */
function recommendedOption(card) {
  if (!card || isCredential(card)) return null;
  const options = (Array.isArray(card.options) ? card.options : []).filter((o) => o && typeof o.key === "string");
  if (!options.length) return null;
  const marked = options.find((o) => o.recommended === true);
  if (marked) return marked;
  const key = String(card.default_key || card.recommend || card.default || "");
  return key ? options.find((o) => o.key === key) || null : null;
}

/** 09:00 local on the day after `nowMs`. */
function tomorrowMorning(nowMs, hour = 9) {
  const d = new Date(Number(nowMs) || Date.now());
  d.setDate(d.getDate() + 1);
  d.setHours(hour, 0, 0, 0);
  return d.getTime();
}

/** When a snooze id runs out, or null for an id that is not a snooze. */
function snoozeUntil(id, nowMs) {
  const now = Number(nowMs) || Date.now();
  if (id === "snooze:1h") return now + HOUR;
  if (id === "snooze:4h") return now + 4 * HOUR;
  if (id === "snooze:tomorrow") return tomorrowMorning(now);
  return null;
}

/** A card's per-card memory after a snooze (fairy-attention reads snoozeUntil). */
function recordSnooze(mem = {}, untilMs) {
  return { ...mem, snoozeUntil: Number(untilMs) || 0 };
}

/**
 * The right-click menu on a companion fairy.
 *
 * Args:
 *   card: the companion's card, or null for a presence-only fairy (no card).
 *   opts.label: the agent's plain name ("Lyra").
 *   opts.agent: the agent key, for a fairy with no card.
 *
 * Returns {header, items}: items are {id, label, hint?, disabled?} or {sep:true}.
 */
function fairyItems(card, { label = "", agent = "" } = {}) {
  const who = clip(label || agent || "This agent", 28);
  if (!card) {
    return {
      header: `${who} · nothing waiting`,
      items: [{ id: "talk", label: `Talk to ${who}`, hint: "Open a chat with this agent" }],
    };
  }
  const rec = recommendedOption(card);
  const credential = isCredential(card);
  const items = [
    { id: "open", label: "Open", hint: "Show this card beside the fairy until you close it" },
    rec
      ? { id: `answer:${rec.key}`, label: `Answer: ${clip(rec.label || rec.key, 30)}`, hint: "The recommended option" }
      : {
        id: "answer", label: "Answer with recommended", disabled: true,
        hint: credential ? "A secret is entered in the secure prompt, never from a menu" : "This card recommends no option",
      },
    { sep: true },
    ...SNOOZES.map((s) => ({ ...s })),
    { id: "mute", label: "Stop nudging this", hint: "It stays on the badge and in the list" },
    { id: "dismiss", label: "Dismiss", hint: "Cancel the card and tell the agent it is not needed" },
    { sep: true },
    card.sessionId
      ? { id: "session", label: "Go to session", hint: "Bring its terminal tab to the front" }
      : { id: "session", label: "Go to session", disabled: true, hint: "No session raised this card" },
    { id: "copy", label: "Copy link", hint: "The card's page on aitherium.com" },
  ];
  return { header: `${who} · ${clip(card.title || "a card", 40)}`, items };
}

/**
 * The right-click menu on the orb.
 *
 * Args:
 *   opts.waiting: how many cards wait.
 *   opts.mutedUntil: ms epoch the nudges are muted until (0 = not muted).
 *   opts.nowMs: the clock.
 */
function orbItems({ waiting = 0, mutedUntil = 0, nowMs = Date.now() } = {}) {
  const muted = Number(mutedUntil) > Number(nowMs);
  const n = Math.max(0, Number(waiting) || 0);
  return {
    header: n ? `Aither · ${n} waiting on you` : "Aither",
    items: [
      { id: "inbox", label: "Open inbox", hint: "The Inbox, where every card is answered" },
      { id: "queue", label: "Answer window", hint: "Every waiting card in one list", disabled: n === 0 },
      muted
        ? { id: "unmute", label: "Unmute nudges", hint: "The fairy may nudge again" }
        : { id: "mute-1h", label: "Mute nudges 1 hour", hint: "No nudges, chimes or flutters for an hour" },
      { id: "hide", label: "Hide fairies", hint: "Hide the fairy and its companions (the tray brings them back)" },
      { id: "settings", label: "Settings", hint: "Desk settings" },
      { sep: true },
      { id: "more", label: "More…", hint: "Search, ask, attach, sounds and the desk's doors" },
    ],
  };
}

/** The pixel height the menu window needs for `items` (plus its header). */
function menuHeight(items) {
  const list = Array.isArray(items) ? items : [];
  const rows = list.filter((i) => i && !i.sep).length;
  const seps = list.filter((i) => i && i.sep).length;
  return MENU.pad * 2 + MENU.head + rows * MENU.row + seps * MENU.sep;
}

/**
 * Where the menu goes: beside the pointer, flipped left/up when it would leave
 * the work area, never off it.
 */
function menuPlacement(cursor, area, size) {
  const c = cursor && Number.isFinite(Number(cursor.x)) ? cursor : { x: 0, y: 0 };
  const a = area || { x: 0, y: 0, width: 1920, height: 1080 };
  const w = Number(size && size.width) || MENU.width;
  const h = Number(size && size.height) || 200;
  let x = c.x + 8;
  let y = c.y + 4;
  if (x + w > a.x + a.width) x = c.x - w - 8;
  if (y + h > a.y + a.height) y = c.y - h - 4;
  x = Math.min(Math.max(a.x, x), a.x + a.width - w);
  y = Math.min(Math.max(a.y, y), a.y + a.height - h);
  return { x: Math.round(x), y: Math.round(y) };
}

/** The one-line hover tooltip for a companion: who, and what it waits on. */
function tipText({ label = "", agent = "", title = "", state = "", count = 0 } = {}) {
  const who = String(label || agent || "Agent");
  const more = Number(count) > 1 ? ` (+${Number(count) - 1})` : "";
  const what = title ? String(title) : (state && state !== "waiting" ? state : "");
  return clip(what ? `${who}: ${what}${more}` : `${who}${more}`, TIP_MAX);
}

/** A card's link on Online (Veil /decide), for "Copy link". */
function cardLink(id, origin = "https://aitherium.com") {
  const u = new URL("/decide", origin);
  u.searchParams.set("id", String(id || ""));
  return u.toString();
}

module.exports = {
  TIP_DWELL_MS,
  TIP_MAX,
  PINNED_MS,
  MENU,
  SNOOZES,
  recommendedOption,
  tomorrowMorning,
  snoozeUntil,
  recordSnooze,
  fairyItems,
  orbItems,
  menuHeight,
  menuPlacement,
  tipText,
  cardLink,
};
