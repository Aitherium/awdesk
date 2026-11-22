"use strict";

/**
 * canvas-model.cjs -- the edits aither://canvas makes to ONE board's pinned cards.
 *
 * Owner, 2026-11-07: "have access to a canvas for pinning apps and widgets."
 *
 * There is no canvas store here. A canvas IS a desk whiteboard (boards-core.cjs,
 * ~/Aither Boards/<id>.json, the same document the floating board window edits): its
 * drawing `items` belong to the board window, its `pins` (pin-item.cjs cards), `view`
 * and snap `grid` belong to the canvas. This module is the pure rule for every pin
 * edit; browser-canvas.cjs saves the result through boards-window.updateBoard, the
 * same applySave path a window save takes.
 *
 * Pure (no electron, no fs, no timers).
 */

const pinItem = require("./pin-item.cjs");

const LIMITS = Object.freeze({
  pins: 100,
  minW: 120,
  minH: 80,
  maxW: 4000,
  maxH: 4000,
  coord: 20000,
  gridMin: 4,
  gridMax: 64,
  zoomMin: 0.25,
  zoomMax: 2,
  note: 20000,
});
const DEFAULT_GRID = 16;

const isObj = (v) => Boolean(v) && typeof v === "object" && !Array.isArray(v);

function num(v, min, max, fallback) {
  if (v == null || v === "") return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
}

/** Round `v` to the grid (0 or a falsy grid = no snap). */
function snap(v, grid) {
  const g = Number(grid);
  return g > 0 ? Math.round(Number(v) / g) * g : Math.round(Number(v));
}

/**
 * A free spot for a new w x h card: scan right then down on the grid from `origin`
 * until nothing overlaps. Deterministic, so a test can say where a pin lands.
 */
function placeNew(pins, w, h, { grid = DEFAULT_GRID, origin = { x: 0, y: 0 } } = {}) {
  const g = grid || DEFAULT_GRID;
  const overlaps = (x, y) => pins.some((p) => {
    const b = p.bounds;
    return x < b.x + b.width + g && x + w + g > b.x && y < b.y + b.height + g && y + h + g > b.y;
  });
  const x0 = snap(origin.x, g);
  const y0 = snap(origin.y, g);
  for (let y = y0; y < y0 + 9600; y += g * 4) {
    for (let x = x0; x < x0 + 2400; x += g * 4) if (!overlaps(x, y)) return { x, y };
  }
  return { x: x0, y: y0 + pins.reduce((m, p) => Math.max(m, p.bounds.y + p.bounds.height), 0) + g };
}

/** The canvas's half of a board, sanitized (what applyPinOp reads). */
function canvasOf(board) {
  const b = isObj(board) ? board : {};
  return {
    pins: (Array.isArray(b.pins) ? b.pins : []).map(pinItem.normalizePinItem).filter(Boolean),
    view: isObj(b.view) ? { scale: num(b.view.scale, LIMITS.zoomMin, LIMITS.zoomMax, 1), x: num(b.view.x, -1e5, 1e5, 0), y: num(b.view.y, -1e5, 1e5, 0) }
      : { scale: 1, x: 0, y: 0 },
    grid: Math.round(num(b.grid, LIMITS.gridMin, LIMITS.gridMax, DEFAULT_GRID)),
    snap: b.snap !== false,
  };
}

const topZ = (pins) => pins.reduce((m, p) => Math.max(m, p.z), 0);

/**
 * Apply one edit to a board's canvas half. Returns {ok, patch, pin?} -- `patch` is
 * what to hand boards-window.updateBoard ({pins} | {view} | {grid, snap}) -- or
 * {ok:false, error}. The board is never mutated.
 *
 *   pin.add {kind?, url?, widget?, title?, text?, w?, h?, x?, y?, origin?}
 *            (a url picks its own kind: pin-item.pinItemFromUrl)
 *   pin.move {id, x, y}    pin.resize {id, w, h}    pin.lock {id, locked?}
 *   pin.remove {id}        pin.update {id, title?, text?, opacity?}   pin.front {id}
 *   pin.duplicate {id, x?, y?}  (Ctrl+middle-drag: the copy lands at x,y)
 *   view {zoom, pan}       grid {grid?, snap?}
 *
 * A LOCKED pin refuses move and resize (lock = "leave it") but can be unlocked,
 * retitled or removed. Moves and resizes snap to the grid when snap is on.
 */
function applyPinOp(board, op, { rand = Math.random } = {}) {
  const c = canvasOf(board);
  const o = isObj(op) ? op : {};
  const fail = (error) => ({ ok: false, error });
  const find = () => c.pins.find((p) => p.id === o.id) || null;
  const s = (v) => (c.snap ? snap(v, c.grid) : Math.round(v));
  switch (o.op) {
    case "pin.add": {
      if (c.pins.length >= LIMITS.pins) return fail(`a board holds at most ${LIMITS.pins} cards`);
      const id = pinItem.newPinId(rand);
      let pin;
      if (o.kind === "widget") pin = pinItem.normalizePinItem({ id, kind: "widget", src: "", widget: o.widget, title: o.title });
      else if (o.kind === "note") pin = pinItem.normalizePinItem({ id, kind: "note", src: typeof o.text === "string" ? o.text : "", title: o.title });
      else pin = pinItem.pinItemFromUrl(o.url, { id, title: o.title || "" });
      if (!pin) {
        return fail(o.kind === "widget" ? "no such widget"
          : "a card needs a web address, an image, a GIF, a YouTube link or an aither:// page (not the canvas itself)");
      }
      const size = pinItem.DEFAULT_SIZE[pin.kind];
      const w = Math.round(num(o.w, LIMITS.minW, LIMITS.maxW, size.width));
      const h = Math.round(num(o.h, LIMITS.minH, LIMITS.maxH, size.height));
      const at = o.x != null && o.y != null ? { x: s(o.x), y: s(o.y) }
        : placeNew(c.pins, w, h, { grid: c.grid, origin: isObj(o.origin) ? o.origin : { x: 0, y: 0 } });
      pin.bounds = { x: at.x, y: at.y, width: w, height: h };
      pin.z = topZ(c.pins) + 1;
      return { ok: true, patch: { pins: [...c.pins, pin] }, pin: pin.id };
    }
    case "pin.move":
    case "pin.resize": {
      const pin = find();
      if (!pin) return fail("no such card");
      if (pin.locked) return fail("that card is locked");
      const b = { ...pin.bounds };
      if (o.op === "pin.move") {
        b.x = s(num(o.x, -LIMITS.coord, LIMITS.coord, b.x));
        b.y = s(num(o.y, -LIMITS.coord, LIMITS.coord, b.y));
      } else {
        b.width = Math.max(LIMITS.minW, s(num(o.w, LIMITS.minW, LIMITS.maxW, b.width)));
        b.height = Math.max(LIMITS.minH, s(num(o.h, LIMITS.minH, LIMITS.maxH, b.height)));
      }
      return { ok: true, patch: { pins: c.pins.map((p) => (p.id === pin.id ? { ...p, bounds: b } : p)) }, pin: pin.id };
    }
    case "pin.duplicate": {
      // Ctrl+middle-drag (middle-drag.js): a copy, unlocked, on top, where it was dropped.
      const pin = find();
      if (!pin) return fail("no such card");
      if (c.pins.length >= LIMITS.pins) return fail(`a board holds at most ${LIMITS.pins} cards`);
      const copy = { ...JSON.parse(JSON.stringify(pin)), id: pinItem.newPinId(rand), locked: false, z: topZ(c.pins) + 1 };
      delete copy.extra; // the copy is the desk's own item, not the AitherOne original
      copy.bounds = { ...copy.bounds,
        x: s(num(o.x, -LIMITS.coord, LIMITS.coord, pin.bounds.x + c.grid)),
        y: s(num(o.y, -LIMITS.coord, LIMITS.coord, pin.bounds.y + c.grid)) };
      return { ok: true, patch: { pins: [...c.pins, copy] }, pin: copy.id };
    }
    case "pin.lock": {
      const pin = find();
      if (!pin) return fail("no such card");
      const locked = o.locked == null ? !pin.locked : o.locked === true;
      return { ok: true, patch: { pins: c.pins.map((p) => (p.id === pin.id ? { ...p, locked } : p)) }, pin: pin.id };
    }
    case "pin.remove": {
      if (!find()) return fail("no such card");
      return { ok: true, patch: { pins: c.pins.filter((p) => p.id !== o.id) } };
    }
    case "pin.update": {
      const pin = find();
      if (!pin) return fail("no such card");
      const next = { ...pin };
      if (typeof o.title === "string") next.title = o.title;
      if (typeof o.text === "string" && pin.kind === "note") next.src = o.text.slice(0, LIMITS.note);
      if (o.opacity != null) next.opacity = o.opacity;
      const clean = pinItem.normalizePinItem(next);
      if (!clean) return fail("that edit does not fit the card");
      return { ok: true, patch: { pins: c.pins.map((p) => (p.id === pin.id ? clean : p)) }, pin: pin.id };
    }
    case "pin.front": {
      const pin = find();
      if (!pin) return fail("no such card");
      const z = topZ(c.pins) + 1;
      return { ok: true, patch: { pins: c.pins.map((p) => (p.id === pin.id ? { ...p, z } : p)) }, pin: pin.id };
    }
    case "view": {
      const pan = isObj(o.pan) ? o.pan : {};
      return { ok: true, patch: { view: {
        scale: num(o.zoom, LIMITS.zoomMin, LIMITS.zoomMax, c.view.scale),
        x: Math.round(num(pan.x, -1e5, 1e5, c.view.x)), y: Math.round(num(pan.y, -1e5, 1e5, c.view.y)),
      } } };
    }
    case "grid":
      return { ok: true, patch: {
        grid: o.grid != null ? Math.round(num(o.grid, LIMITS.gridMin, LIMITS.gridMax, c.grid)) : c.grid,
        snap: typeof o.snap === "boolean" ? o.snap : c.snap,
      } };
    default:
      return fail(`unknown canvas op: ${o.op}`);
  }
}

/**
 * A card body's rectangle on screen, clipped to the board's viewport -- where main puts
 * a live card's view. Both rects are in the canvas page's CSS pixels. null when
 * nothing usable of it is visible.
 */
function clipRect(rect, viewport) {
  if (!isObj(rect) || !isObj(viewport)) return null;
  const x = Math.max(rect.x, viewport.x);
  const y = Math.max(rect.y, viewport.y);
  const right = Math.min(rect.x + rect.width, viewport.x + viewport.width);
  const bottom = Math.min(rect.y + rect.height, viewport.y + viewport.height);
  const width = Math.floor(right - x);
  const height = Math.floor(bottom - y);
  if (!(width >= 24 && height >= 24)) return null;
  return { x: Math.round(x), y: Math.round(y), width, height };
}

module.exports = { LIMITS, DEFAULT_GRID, snap, placeNew, canvasOf, applyPinOp, clipRect };
