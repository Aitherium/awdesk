"use strict";

/**
 * ink-core.cjs -- the Electron-free half of the desk's screen-ink tool.
 *
 * ink-window.cjs owns the per-display overlays and their IPC; ink.html draws.
 * This file is the model they share: what a mark IS, how it is added, erased,
 * undone and faded, and the geometry an arrow head or an eraser hit needs. It is
 * pure (no Electron, no clock of its own) so ink-core.test.cjs runs it under
 * `node --test`, and the renderer loads the same file with a <script> tag (the
 * UMD tail below) so the overlay and the main process cannot disagree about a
 * shape.
 *
 * The model is a plain state object so a test can hand it in and diff it out:
 *
 *   state = { items: Item[], undo: Op[], redo: Op[] }
 *   Item  = { id, createdAt, type, tool, ... }   (see normalizeItem)
 *
 * Every reducer returns a NEW state and never mutates its input. An empty result
 * is still a state, so callers never special-case `undefined`.
 */

(function (root, factory) {
  if (typeof module === "object" && module && module.exports) module.exports = factory();
  else root.AitherInkCore = factory();
})(typeof globalThis !== "undefined" ? globalThis : this, function () {

  /** Tools the toolbar offers. `eraser`, `laser` and `spotlight` leave no item. */
  const TOOLS = Object.freeze([
    "pen", "highlighter", "arrow", "rect", "ellipse", "line", "text",
    "eraser", "laser", "spotlight",
  ]);
  /** The six swatches (light-on-dark first so a dark desktop still reads). */
  const COLORS = Object.freeze(["#ff4d4d", "#ffd166", "#4ade80", "#7aa2ff", "#c084fc", "#ffffff"]);
  const WIDTHS = Object.freeze([2, 5, 10]);
  const SHAPE_TOOLS = Object.freeze(["line", "arrow", "rect", "ellipse"]);
  const MAX_POINTS = 4000;

  const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));
  const finite = (n) => typeof n === "number" && Number.isFinite(n);

  /**
   * The ONE clock the fade math may use. `createdAt` is stamped with Date.now()
   * (epoch ms) by normalizeItem, so fadeAlpha/pruneByAge must be given the same
   * epoch clock. performance.now() starts near zero at page load and would make
   * every age hugely negative (fadeAlpha pinned to 1, nothing ever pruned).
   * Laser trails and ripples are frame-local and keep performance.now().
   */
  function now() {
    return Date.now();
  }

  function normalizeState(state) {
    const s = state && typeof state === "object" ? state : {};
    return {
      items: Array.isArray(s.items) ? s.items : [],
      undo: Array.isArray(s.undo) ? s.undo : [],
      redo: Array.isArray(s.redo) ? s.redo : [],
    };
  }

  // ── geometry ───────────────────────────────────────────────────────────────

  /** The rect two drag points describe, normalised to positive width/height. */
  function rectFrom(a, b) {
    const x = Math.min(a.x, b.x);
    const y = Math.min(a.y, b.y);
    return { x, y, width: Math.abs(b.x - a.x), height: Math.abs(b.y - a.y) };
  }

  /** Shortest distance from p to the segment a-b. */
  function distanceToSegment(p, a, b) {
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len2 = dx * dx + dy * dy;
    let t = len2 ? ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2 : 0;
    t = clamp(t, 0, 1);
    return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
  }

  /** Distance from p to a rect's outline (0 when p sits on the border). */
  function distanceToRectBorder(p, rect) {
    const x2 = rect.x + rect.width;
    const y2 = rect.y + rect.height;
    if (p.x < rect.x || p.x > x2 || p.y < rect.y || p.y > y2) {
      // Outside: distance to the nearest edge (measured from the outside).
      const dx = Math.max(rect.x - p.x, 0, p.x - x2);
      const dy = Math.max(rect.y - p.y, 0, p.y - y2);
      return Math.hypot(dx, dy);
    }
    return Math.min(p.x - rect.x, x2 - p.x, p.y - rect.y, y2 - p.y);
  }

  /** Distance from p to an ellipse's outline, by sampling (64 points is plenty). */
  function distanceToEllipse(p, rect) {
    const cx = rect.x + rect.width / 2;
    const cy = rect.y + rect.height / 2;
    const rx = Math.max(rect.width / 2, 1);
    const ry = Math.max(rect.height / 2, 1);
    let best = Infinity;
    for (let i = 0; i < 64; i += 1) {
      const a = (i / 64) * Math.PI * 2;
      const d = Math.hypot(p.x - (cx + Math.cos(a) * rx), p.y - (cy + Math.sin(a) * ry));
      if (d < best) best = d;
    }
    return best;
  }

  /** The two barbs of an arrow whose tip is b and whose tail is a. */
  function arrowHead(a, b, size = 14) {
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len = Math.hypot(dx, dy) || 1;
    const ux = dx / len;
    const uy = dy / len;
    const wing = (angle) => ({
      x: b.x - (ux * Math.cos(angle) - uy * Math.sin(angle)) * size,
      y: b.y - (uy * Math.cos(angle) + ux * Math.sin(angle)) * size,
    });
    return [wing(0.42), wing(-0.42)];
  }

  // ── items ──────────────────────────────────────────────────────────────────

  /**
   * Sanitise an item that came from a renderer. Returns a fresh object, or null
   * when nothing drawable is left. Coordinates stay finite; a stroke keeps at
   * most MAX_POINTS points; colours and widths must be ones the toolbar offers.
   */
  function normalizeItem(raw, { now = Date.now(), fallbackId = "" } = {}) {
    if (!raw || typeof raw !== "object") return null;
    const type = raw.type;
    const id = typeof raw.id === "string" && raw.id ? raw.id.slice(0, 64) : String(fallbackId || "");
    if (!id) return null;
    const color = COLORS.includes(raw.color) ? raw.color : COLORS[0];
    const width = finite(raw.width) ? clamp(raw.width, 1, 24) : WIDTHS[1];
    const createdAt = finite(raw.createdAt) ? raw.createdAt : now;

    if (type === "stroke") {
      const tool = raw.tool === "highlighter" ? "highlighter" : "pen";
      const points = Array.isArray(raw.points) ? raw.points : [];
      const clean = [];
      for (const p of points.slice(0, MAX_POINTS)) {
        if (!p || !finite(p.x) || !finite(p.y)) continue;
        clean.push({ x: p.x, y: p.y, p: finite(p.p) ? clamp(p.p, 0.05, 1) : 0.5 });
      }
      if (!clean.length) return null;
      return { id, type, tool, color, width, createdAt, points: clean };
    }
    if (type === "shape") {
      const tool = SHAPE_TOOLS.includes(raw.tool) ? raw.tool : "line";
      if (!raw.a || !raw.b || !finite(raw.a.x) || !finite(raw.a.y) || !finite(raw.b.x) || !finite(raw.b.y)) return null;
      if (Math.hypot(raw.b.x - raw.a.x, raw.b.y - raw.a.y) < 1 && tool !== "rect" && tool !== "ellipse") return null;
      return {
        id, type, tool, color, width, createdAt,
        a: { x: raw.a.x, y: raw.a.y }, b: { x: raw.b.x, y: raw.b.y },
      };
    }
    if (type === "text") {
      const text = typeof raw.text === "string" ? raw.text.replace(/\s+/g, " ").trim().slice(0, 200) : "";
      if (!text || !raw.at || !finite(raw.at.x) || !finite(raw.at.y)) return null;
      return {
        id, type, tool: "text", color, width, createdAt,
        text, size: finite(raw.size) ? clamp(raw.size, 10, 72) : 20,
        at: { x: raw.at.x, y: raw.at.y },
      };
    }
    return null;
  }

  /** A text item's hit box (the renderer draws top-left with a baseline offset). */
  function textBounds(item) {
    const size = item.size || 20;
    return {
      x: item.at.x,
      y: item.at.y - size,
      width: Math.max(24, item.text.length * size * 0.58),
      height: size * 1.4,
    };
  }

  /** Does `point` land on `item` within `radius` extra pixels? */
  function hitTest(item, point, radius = 8) {
    if (!item || !point) return false;
    const grow = radius + (item.width || 0) / 2;
    if (item.type === "stroke") {
      const pts = item.points || [];
      if (pts.length === 1) return Math.hypot(point.x - pts[0].x, point.y - pts[0].y) <= grow;
      for (let i = 1; i < pts.length; i += 1) {
        if (distanceToSegment(point, pts[i - 1], pts[i]) <= grow) return true;
      }
      return false;
    }
    if (item.type === "shape") {
      if (item.tool === "line" || item.tool === "arrow") {
        return distanceToSegment(point, item.a, item.b) <= grow;
      }
      const rect = rectFrom(item.a, item.b);
      const d = item.tool === "ellipse" ? distanceToEllipse(point, rect) : distanceToRectBorder(point, rect);
      return d <= grow;
    }
    if (item.type === "text") {
      const b = textBounds(item);
      return point.x >= b.x - radius && point.x <= b.x + b.width + radius
        && point.y >= b.y - radius && point.y <= b.y + b.height + radius;
    }
    return false;
  }

  // ── reducers ───────────────────────────────────────────────────────────────

  /** Add one item; the action is undoable and clears the redo branch. */
  function pushItem(state, item) {
    const s = normalizeState(state);
    if (!item || !item.id) return s;
    return { items: [...s.items, item], undo: [...s.undo, { kind: "add", item }], redo: [] };
  }

  function removeIds(state, ids) {
    const s = normalizeState(state);
    const wanted = new Set(ids || []);
    if (!wanted.size) return s;
    const entries = [];
    s.items.forEach((item, index) => { if (wanted.has(item.id)) entries.push({ item, index }); });
    if (!entries.length) return s;
    return {
      items: s.items.filter((item) => !wanted.has(item.id)),
      undo: [...s.undo, { kind: "remove", entries }],
      redo: [],
    };
  }

  /** Everything an eraser stroke touched, as ids (one undo step for the drag). */
  function eraseAt(state, point, radius = 10) {
    const s = normalizeState(state);
    const ids = s.items.filter((item) => hitTest(item, point, radius)).map((item) => item.id);
    return { state: removeIds(s, ids), removed: ids };
  }

  function clearAll(state) {
    const s = normalizeState(state);
    if (!s.items.length) return s;
    return { items: [], undo: [...s.undo, { kind: "clear", items: s.items }], redo: [] };
  }

  function applyInverse(op, items) {
    if (op.kind === "add") return items.filter((item) => item.id !== op.item.id);
    if (op.kind === "clear") return [...op.items];
    if (op.kind === "remove") {
      const next = [...items];
      for (const { item, index } of [...op.entries].sort((a, b) => a.index - b.index)) {
        next.splice(clamp(index, 0, next.length), 0, item);
      }
      return next;
    }
    return items;
  }

  function applyForward(op, items) {
    if (op.kind === "add") return items.some((item) => item.id === op.item.id) ? items : [...items, op.item];
    if (op.kind === "clear") return [];
    if (op.kind === "remove") {
      const ids = new Set(op.entries.map((entry) => entry.item.id));
      return items.filter((item) => !ids.has(item.id));
    }
    return items;
  }

  function undo(state) {
    const s = normalizeState(state);
    if (!s.undo.length) return s;
    const op = s.undo[s.undo.length - 1];
    return {
      items: applyInverse(op, s.items),
      undo: s.undo.slice(0, -1),
      redo: [...s.redo, op],
    };
  }

  function redo(state) {
    const s = normalizeState(state);
    if (!s.redo.length) return s;
    const op = s.redo[s.redo.length - 1];
    return {
      items: applyForward(op, s.items),
      undo: [...s.undo, op],
      redo: s.redo.slice(0, -1),
    };
  }

  // ── fading ─────────────────────────────────────────────────────────────────

  /**
   * A mark's opacity right now. fadeMs 0 means "keep until cleared"; otherwise a
   * mark fades over its whole life (so a 5 s fade is visibly dying at 3 s).
   */
  function fadeAlpha(item, now, fadeMs) {
    if (!fadeMs || fadeMs <= 0) return 1;
    const age = now - (item.createdAt || now);
    if (age <= 0) return 1;
    if (age >= fadeMs) return 0;
    return 1 - age / fadeMs;
  }

  /** Drop marks whose fade is over. Returns the state plus the removed ids. */
  function pruneByAge(state, now, fadeMs) {
    const s = normalizeState(state);
    if (!fadeMs || fadeMs <= 0) return { state: s, removed: [] };
    const removed = s.items.filter((item) => fadeAlpha(item, now, fadeMs) <= 0).map((item) => item.id);
    if (!removed.length) return { state: s, removed };
    return { state: removeIds(s, removed), removed };
  }

  /** A laser trail: keep points younger than ttlMs, capped at `max` newest. */
  function laserTrail(points, now, ttlMs = 900, max = 120) {
    const list = Array.isArray(points) ? points : [];
    return list.filter((p) => p && now - p.t <= ttlMs).slice(-max);
  }

  /** "1 mark" / "3 marks" -- the toolbar's count line, never "1 marks". */
  function marksLine(count, tool) {
    const n = Number(count) || 0;
    return `${n} ${n === 1 ? "mark" : "marks"} · ${tool || "pen"}`;
  }

  return {
    TOOLS, COLORS, WIDTHS, SHAPE_TOOLS, MAX_POINTS, now,
    normalizeState, rectFrom, distanceToSegment, distanceToRectBorder, distanceToEllipse,
    arrowHead, normalizeItem, textBounds, hitTest,
    pushItem, removeIds, eraseAt, clearAll, undo, redo,
    fadeAlpha, pruneByAge, laserTrail, marksLine,
  };
});
