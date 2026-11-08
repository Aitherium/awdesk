"use strict";

/**
 * ink-mode.cjs -- the screen ink's ONE mode machine (owner 2026-11-07: "the
 * whole-screen drawing must SEAMLESSLY transition from drawing to interacting with
 * the desktop again").
 *
 *   interact    the default. Ink stays on screen; the overlay is click-through.
 *               Over an ink object it captures the mouse only so a middle-drag can
 *               grab it (`capture: "object"`); everywhere else clicks reach the apps.
 *   draw        latched drawing (the toggle key, Ctrl+Alt+D). The overlay takes
 *               the pointer, the tool palette is docked to the bottom edge, and a
 *               thin edge glow shows the mode.
 *   draw-held   drawing while the hold chord is down (Ctrl+Alt, held). Release it
 *               and you are back in interact at once.
 *   pen         a pen reached the overlay while interacting: it draws, and the
 *               first mouse move (or the pen leaving) hands the desktop back.
 *
 * Mode changes NEVER touch the marks: clear and fade are separate actions. The
 * overlay window is never recreated on a switch -- only setIgnoreMouseEvents flips.
 *
 * Inputs are plain events; reduce() is pure and returns a NEW state, so
 * ink-mode.test.cjs drives every transition under `node --test`.
 */

const { middleDrag } = require("./middle-drag-load.cjs");

const MODES = Object.freeze(["interact", "draw", "draw-held", "pen"]);
const DRAWING = Object.freeze(new Set(["draw", "draw-held", "pen"]));

function initial() {
  return { mode: "interact", hover: null, grab: null, wheelPassUntil: 0 };
}

function norm(state) {
  const s = state && typeof state === "object" ? state : {};
  return {
    mode: MODES.includes(s.mode) ? s.mode : "interact",
    hover: s.hover || null,
    grab: s.grab || null,
    wheelPassUntil: Number(s.wheelPassUntil) || 0,
  };
}

/**
 * One event -> the next state.
 *
 *   toggle                 interact|pen -> draw; draw -> interact; draw-held -> draw (latched)
 *   set {mode}             any -> that mode
 *   hold-down / hold-up    interact|pen -> draw-held; draw-held -> interact
 *   escape / right-click   any drawing mode -> interact (marks stay)
 *   pen-enter / pen-leave  interact -> pen; pen -> interact
 *   mouse                  a mouse pointer moved: pen -> interact (the mouse resumes)
 *   hover {id|null, locked} interact only: the ink object under the cursor
 *   middle-down {hit, shift, ctrl, meta}  a grab when it lands on an object
 *   middle-up              the grab ends
 *   wheel {now}            nothing changes but the wheel passes for 350 ms
 */
function reduce(state, event) {
  const s = norm(state);
  const e = event && typeof event === "object" ? event : {};
  switch (e.type) {
    case "toggle":
      if (s.mode === "draw") return { ...s, mode: "interact", grab: null };
      return { ...s, mode: "draw", hover: null };
    case "set":
      return MODES.includes(e.mode) ? { ...s, mode: e.mode, hover: e.mode === "interact" ? s.hover : null } : s;
    case "hold-down":
      if (s.mode === "interact" || s.mode === "pen") return { ...s, mode: "draw-held", hover: null };
      return s;
    case "hold-up":
      return s.mode === "draw-held" ? { ...s, mode: "interact", grab: null } : s;
    case "escape":
    case "right-click":
      return DRAWING.has(s.mode) ? { ...s, mode: "interact", grab: null } : s;
    case "pen-enter":
      return s.mode === "interact" ? { ...s, mode: "pen", hover: null } : s;
    case "pen-leave":
    case "mouse":
      return s.mode === "pen" ? { ...s, mode: "interact" } : s;
    case "hover":
      if (s.mode !== "interact" || s.grab) return s;
      return { ...s, hover: e.id ? { id: String(e.id), locked: e.locked === true } : null };
    case "middle-down": {
      const hit = e.hit || null;
      const gesture = middleDrag().decide({ onItem: Boolean(hit), locked: Boolean(hit && hit.locked),
        shift: e.shift, ctrl: e.ctrl, meta: e.meta, surface: "desktop" });
      if (gesture === "pass" || gesture === "blocked") return { ...s, grab: null };
      return { ...s, grab: { id: e.hit.id, gesture } };
    }
    case "middle-up":
      return s.grab ? { ...s, grab: null } : s;
    case "wheel":
      return DRAWING.has(s.mode) ? { ...s, wheelPassUntil: (Number(e.now) || 0) + 350 } : s;
    default:
      return s;
  }
}

/**
 * Who gets the mouse:
 *   "all"     a drawing mode (and not inside a wheel pass)
 *   "object"  interact, with the cursor on an ink object or a grab in progress
 *   "none"    interact anywhere else: the overlay is fully click-through
 */
function capture(state, now = 0) {
  const s = norm(state);
  if (DRAWING.has(s.mode)) return now && now < s.wheelPassUntil ? "none" : "all";
  return s.hover || s.grab ? "object" : "none";
}

/** What the overlay shows: palette (docked, drawing modes only), edge glow, cursor. */
function view(state) {
  const s = norm(state);
  const drawing = DRAWING.has(s.mode);
  return {
    mode: s.mode,
    drawing,
    palette: drawing,
    glow: drawing,
    cursor: drawing ? "crosshair" : s.grab ? "grabbing" : s.hover ? (s.hover.locked ? "default" : "grab") : "default",
    hoverId: drawing ? null : s.hover ? s.hover.id : null,
  };
}

/** The tray / status line for a mode. */
function label(state) {
  const m = norm(state).mode;
  return m === "draw" ? "Drawing — Esc or right-click to interact"
    : m === "draw-held" ? "Drawing while Ctrl+Alt is held"
      : m === "pen" ? "Pen drawing — move the mouse to interact"
        : "Ink stays — Ctrl+Alt+D or hold Ctrl+Alt to draw";
}

module.exports = { MODES, initial, reduce, capture, view, label, isDrawing: (s) => DRAWING.has(norm(s).mode) };
