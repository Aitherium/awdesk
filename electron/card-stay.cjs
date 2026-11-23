"use strict";

/**
 * card-stay.cjs -- how long the fairy's asking card stays open, and where a
 * pinned one stands.
 *
 * Owner, 2026-11-22: the response card vanished before it could be read. Three
 * measured causes on that day's build:
 *
 *   1. `ensureBubble().on("blur")` called closeBubble() whenever focus moved and
 *      the pointer was not over the card -- so clicking away, opening another
 *      app, or pressing the Snipping Tool's own capture key closed it.
 *   2. `bubbleWanted()` only listed a live line / hold / trip. With none of them
 *      up, the 250 ms pump hid an open card.
 *   3. Nothing remembered where the owner put the card, so even a pinned card
 *      could not be dragged.
 *
 * The owner's rule (same shape as fairy-drop.cjs, which this sits beside in
 * Settings): a card stays open until dismissed with Esc, the close button or a
 * click on the fairy. It may ALSO close after an idle timeout, but that timeout
 * defaults to OFF. Pinning keeps it open, lets it be dragged, and docks it to
 * the nearest screen corner -- the corner fairy-drop.cjs already chooses.
 *
 * This module is PURE: no electron, no fs, no clock, so
 * `node --test electron/card-stay.test.cjs` pins every rule with no display.
 */

const fairyDrop = require("./fairy-drop.cjs");

const MODES = Object.freeze(["open", "idle"]);
const DEFAULT_MODE = "open";
/** Off unless the owner sets a number: an idle timeout must never surprise. */
const DEFAULT_IDLE_SECONDS = 60;
const MIN_IDLE_SECONDS = 10;
const MAX_IDLE_SECONDS = 3600;
/** The fairy's card window: grows to its content up to a screen cap unless the
 *  owner turned "fit to content" off; edges resize it and the size is remembered. */
const DEFAULT_WIDTH = 420;
const MIN_WIDTH = 320;
const MAX_WIDTH = 1000;
const DEFAULT_HEIGHT = 188;
const MIN_HEIGHT = 140;
const MAX_HEIGHT = 2000;
/** Never taller than this share of the display's work area; scroll beyond it. */
const CAP_SHARE = 0.7;

function num(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function clampSeconds(v, fallback = DEFAULT_IDLE_SECONDS) {
  const n = Math.round(num(v, fallback));
  return Math.min(MAX_IDLE_SECONDS, Math.max(MIN_IDLE_SECONDS, n));
}

function clampWidth(v, fallback = DEFAULT_WIDTH) {
  return Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, Math.round(num(v, fallback))));
}

function clampHeight(v, fallback = DEFAULT_HEIGHT) {
  return Math.min(MAX_HEIGHT, Math.max(MIN_HEIGHT, Math.round(num(v, fallback))));
}

/** The saved/patched shape -> a complete card setting. Unknown values take the default. */
function normalizeCard(raw) {
  const src = raw && typeof raw === "object" ? raw : {};
  return {
    // Pin: stays open, can be dragged, exempt from the idle timeout.
    pin: src.pin === true,
    // "open" = until dismissed; "idle" = close after idleSeconds with no activity.
    mode: MODES.includes(src.mode) ? src.mode : DEFAULT_MODE,
    idleSeconds: clampSeconds(src.idleSeconds),
    // Where a pinned card stands (window top-left), and the corner it docked to.
    x: Number.isFinite(Number(src.x)) ? Math.round(Number(src.x)) : null,
    y: Number.isFinite(Number(src.y)) ? Math.round(Number(src.y)) : null,
    corner: fairyDrop.CORNERS.includes(src.corner) ? src.corner : null,
    // The card window. fit = grow to content (capped at 70% of the display); the
    // width/height are the defaults and the size the owner left it at.
    width: clampWidth(src.width),
    height: clampHeight(src.height),
    fit: src.fit !== false,
  };
}

/**
 * What the window layer acts on: how long after the last activity to close, or
 * null for "never on its own". A PINNED card is always null -- pinning means
 * the owner wants it there.
 */
function decide(card) {
  const c = normalizeCard(card);
  if (c.pin) return { closeAfterMs: null, pinned: true, mode: c.mode };
  return {
    closeAfterMs: c.mode === "idle" ? c.idleSeconds * 1000 : null,
    pinned: false,
    mode: c.mode,
  };
}

/** The Settings row / tooltip sentence for the current answer. */
function label(card) {
  const c = normalizeCard(card);
  if (c.pin) return "Pinned open";
  return c.mode === "idle" ? `Closes after ${c.idleSeconds} seconds idle` : "Stays open until I close it";
}

/** The corner a dragged card docks to: the NEAREST one to its centre (fairy-drop's rule). */
function dockCorner(area, bounds) {
  const b = fairyDrop.normBounds(bounds) || { x: 0, y: 0, width: 0, height: 0 };
  return fairyDrop.nearestCorner(area, { x: b.x + b.width / 2, y: b.y + b.height / 2 });
}

/** Top-left for a card of `size` docked at `corner` of `area`, gap-clear like a fairy. */
function dockPosition(area, size, corner) {
  return fairyDrop.cornerAnchor(area, corner, size);
}

/** The tallest the card may grow inside `area`: 70% of the display's work area. */
function heightCap(area) {
  const h = Number(area && area.height) || 1080;
  return Math.max(MIN_HEIGHT, Math.round(h * CAP_SHARE));
}

module.exports = {
  MODES, DEFAULT_MODE, DEFAULT_IDLE_SECONDS, MIN_IDLE_SECONDS, MAX_IDLE_SECONDS,
  DEFAULT_WIDTH, MIN_WIDTH, MAX_WIDTH, DEFAULT_HEIGHT, MIN_HEIGHT, MAX_HEIGHT, CAP_SHARE,
  clampSeconds, clampWidth, clampHeight, normalizeCard, decide, label, dockCorner,
  dockPosition, heightCap,
};
