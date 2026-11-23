"use strict";

/**
 * fairy-drop.cjs -- where a dropped fairy stands, and how long it stays there.
 *
 * Owner, 2026-11-23: "when I drag a fairy somewhere it immediately flies away
 * again". Two measured causes in the window layer:
 *
 *   1. `dockPosition` always answered the TOP-RIGHT corner of a window, so a
 *      drop anywhere else made the fairy fly across the window to that corner.
 *      `nearestCorner`/`dockFor` pick the corner nearest the drop instead.
 *   2. Nothing remembered which corner a hand drop chose, so a follow tick or a
 *      re-dock could choose a different one. `corner` is fixed at drop time and
 *      `dockFor(..., {corner})` reuses it when the window moves or resizes.
 *
 * And what happens AFTER the drop is the owner's choice, per fairy with a global
 * default (a switch in the desk Settings and a row on the fairy's own menu):
 *
 *   pin     stays docked until dragged again (the default)
 *   timed   stays N seconds, then flies home
 *   return  flies home straight away -- the old behaviour, kept as an option
 *
 * The module is PURE: no electron, no fs, no clock. Every rule is a value, so
 * `node --test electron/fairy-drop.test.cjs` can assert it with no display.
 */

const MODES = Object.freeze(["pin", "timed", "return"]);
const DEFAULT_MODE = "pin";
const DEFAULT_SECONDS = 10;
const MIN_SECONDS = 3;
const MAX_SECONDS = 600;
/** The corners, in the order a tie is broken (`ne` first: the old dock). */
const CORNERS = Object.freeze(["ne", "nw", "se", "sw"]);
/** Clearance from the window's edge, matching spirit-core's dock gap. */
const GAP = 14;
/** Windows reports a minimised window's rect far off-screen (measured -32000). */
const OFF_SCREEN = -30000;

function num(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

/** A rect as {x,y,width,height} with whole finite numbers; null when unusable. */
function normBounds(b) {
  if (!b || typeof b !== "object") return null;
  const width = num(b.width);
  const height = num(b.height);
  if (width <= 0 || height <= 0) return null;
  return { x: Math.round(num(b.x)), y: Math.round(num(b.y)), width: Math.round(width), height: Math.round(height) };
}

function clampSeconds(v, fallback = DEFAULT_SECONDS) {
  const n = Math.round(num(v, fallback));
  return Math.min(MAX_SECONDS, Math.max(MIN_SECONDS, n));
}

/** The saved/typed shape -> {mode, seconds}. Anything unknown becomes the default. */
function normalizeDrop(raw) {
  const src = raw && typeof raw === "object" ? raw : {};
  return {
    mode: MODES.includes(src.mode) ? src.mode : DEFAULT_MODE,
    seconds: clampSeconds(src.seconds),
  };
}

/**
 * The corner of `bounds` nearest to a screen `point` (the drop). A tie goes to the
 * one listed first in CORNERS, which keeps a drop at the exact centre predictable.
 */
function nearestCorner(bounds, point) {
  const b = normBounds(bounds);
  if (!b) return "ne";
  const px = num(point && point.x);
  const py = num(point && point.y);
  const at = {
    ne: { x: b.x + b.width, y: b.y },
    nw: { x: b.x, y: b.y },
    se: { x: b.x + b.width, y: b.y + b.height },
    sw: { x: b.x, y: b.y + b.height },
  };
  let best = "ne";
  let bestDistance = Infinity;
  for (const corner of CORNERS) {
    const q = at[corner];
    const distance = (px - q.x) ** 2 + (py - q.y) ** 2;
    if (distance < bestDistance) {
      bestDistance = distance;
      best = corner;
    }
  }
  return best;
}

/**
 * The orb's top-left when it sits in `corner` of `bounds`, `gap` clear of the
 * edges. A window narrower or shorter than the orb is centred on that axis rather
 * than pushed outside it.
 */
function cornerAnchor(bounds, corner, size, gap = GAP) {
  const b = normBounds(bounds) || { x: 0, y: 0, width: 0, height: 0 };
  const w = num(size && size.width, 72);
  const h = num(size && size.height, 72);
  const c = CORNERS.includes(corner) ? corner : "ne";
  const left = b.x + gap;
  const right = b.x + b.width - w - gap;
  const top = b.y + gap;
  const bottom = b.y + b.height - h - gap;
  const x = right < left ? Math.round(b.x + (b.width - w) / 2) : (c.endsWith("w") ? left : right);
  const y = bottom < top ? Math.round(b.y + (b.height - h) / 2) : (c.startsWith("n") ? top : bottom);
  return { x: Math.round(x), y: Math.round(y) };
}

/**
 * Where to dock an orb of `size` inside `bounds`.
 *   - `corner` (a remembered hand-drop corner) wins, so a followed window that
 *     moves or resizes keeps the fairy on the corner the owner chose;
 *   - else `dropPoint` selects the nearest corner;
 *   - else the old default: the top-right corner.
 */
function dockFor(bounds, size, { dropPoint = null, corner = null, gap = GAP } = {}) {
  const c = CORNERS.includes(corner) ? corner : (dropPoint ? nearestCorner(bounds, dropPoint) : "ne");
  return { corner: c, ...cornerAnchor(bounds, c, size, gap) };
}

/** What a drop mode means, as values the window layer acts on. */
function decideDrop(behavior) {
  const d = normalizeDrop(behavior);
  if (d.mode === "pin") return { mode: d.mode, seconds: d.seconds, dock: true, returnAfterMs: null };
  if (d.mode === "timed") return { mode: d.mode, seconds: d.seconds, dock: true, returnAfterMs: d.seconds * 1000 };
  return { mode: d.mode, seconds: d.seconds, dock: false, returnAfterMs: 0 };
}

/** The menu row / settings line for a drop behaviour. */
function behaviorLabel(behavior) {
  const d = normalizeDrop(behavior);
  if (d.mode === "pin") return "Pin until I move it";
  if (d.mode === "timed") return `Stay ${d.seconds} seconds, then home`;
  return "Fly home straight away";
}

/**
 * Is a followed window still where the fairy can stand?
 *   "live"       a normal on-screen rect
 *   "minimised"  Windows' off-screen rect, or the probe says it is not visible
 *   "gone"       no rect at all (closed)
 */
function windowState(rect, { visible = true } = {}) {
  if (rect == null) return "gone";
  const b = normBounds(rect);
  if (!b) return "gone";
  if (visible === false) return "minimised";
  if (b.x <= OFF_SCREEN || b.y <= OFF_SCREEN) return "minimised";
  return "live";
}

/** The key a per-fairy behaviour is stored under. The orb itself is "orb". */
function behaviorKey(agent) {
  const key = String(agent == null ? "" : agent).trim().toLowerCase();
  return key || "orb";
}

/** The behaviour in force for one fairy: its own override, else the global default. */
function behaviorFor(state, agent) {
  const s = state && typeof state === "object" ? state : {};
  const key = behaviorKey(agent);
  const map = s.dropBy && typeof s.dropBy === "object" ? s.dropBy : {};
  return normalizeDrop(map[key] || s.drop || {});
}

/** State with one fairy's behaviour stored (agent "" = the orb). */
function withBehavior(state, agent, behavior) {
  const s = state && typeof state === "object" ? state : {};
  const key = behaviorKey(agent);
  const map = { ...(s.dropBy && typeof s.dropBy === "object" ? s.dropBy : {}) };
  map[key] = normalizeDrop(behavior);
  return { ...s, dropBy: map };
}

/** A saved per-fairy map, cleaned: known keys only, every value normalised. */
function normalizeDropMap(raw) {
  const src = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  const out = {};
  for (const [key, value] of Object.entries(src).slice(0, 400)) {
    const k = String(key || "").trim().toLowerCase().slice(0, 40);
    if (k) out[k] = normalizeDrop(value);
  }
  return out;
}

/** The three rows a fairy's right-click menu offers, the one in force marked. */
function menuRows(behavior) {
  const b = normalizeDrop(behavior);
  const mark = (on, text) => (on ? `${text} ✓` : text);
  return [
    { id: "fc:drop:pin", label: mark(b.mode === "pin", "Dropped: pin in place"), hint: "Stay where I drop it until I move it again" },
    { id: "fc:drop:timed:10", label: mark(b.mode === "timed" && b.seconds === 10, "Dropped: stay 10 seconds"), hint: "Then fly home; set the seconds in Settings" },
    { id: "fc:drop:return", label: mark(b.mode === "return", "Dropped: fly home"), hint: "The old behaviour, kept as an option" },
  ];
}

module.exports = {
  MODES, DEFAULT_MODE, DEFAULT_SECONDS, MIN_SECONDS, MAX_SECONDS, CORNERS, GAP, OFF_SCREEN,
  normBounds, clampSeconds, normalizeDrop, normalizeDropMap, nearestCorner, cornerAnchor, dockFor,
  decideDrop, behaviorLabel, menuRows, windowState, behaviorKey, behaviorFor, withBehavior,
};
