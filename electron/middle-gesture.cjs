"use strict";

/**
 * middle-gesture.cjs -- ONE middle-button gesture map for every surface that holds
 * objects: screen ink (ink.html), desktop pins (pin.html / pins-window), the
 * floating whiteboard (board.html) and -- by contract -- the aither://canvas and
 * the AitherOne Spatial Canvas (Veil aitherone-canvas/scene.ts middleGesture).
 *
 * Owner 2026-11-07: "MIDDLE-CLICK DRAG MOVES THINGS".
 *
 *   middle-drag on an object         move it (the topmost by z wins; a stroke is hit
 *                                    within HIT_PX of its line)
 *   Shift + middle-drag              resize from the bottom-right corner
 *   Ctrl (or Cmd) + middle-drag      duplicate, and drag the copy (Ctrl beats Shift)
 *   middle on empty space            desktop surfaces: pass (the app underneath gets
 *                                    it); board/canvas surfaces: pan
 *   a locked object                  never moves or resizes; it can be duplicated
 *                                    (the copy is unlocked)
 *
 * Pure, and loadable both by require() and by a <script> tag (UMD tail), so the
 * overlay, the board page and the main process cannot disagree.
 */

(function (root, factory) {
  if (typeof module === "object" && module && module.exports) module.exports = factory();
  else root.AitherMiddleGesture = factory();
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  /** Same tolerance AitherOne uses for a stroke hit (scene.ts). */
  const HIT_PX = 6;
  const MIN_W = 24;
  const MIN_H = 24;

  /**
   * What a middle press does.
   * @param {{hit?: {id: string, locked?: boolean} | null, shift?: boolean, ctrl?: boolean,
   *   meta?: boolean, surface?: "desktop"|"board"}} press
   * @returns {"move"|"resize"|"duplicate"|"blocked"|"pass"|"pan"}
   */
  function middleGesture({ hit = null, shift = false, ctrl = false, meta = false, surface = "desktop" } = {}) {
    if (!hit) return surface === "desktop" ? "pass" : "pan";
    if (ctrl || meta) return "duplicate";
    if (hit.locked) return "blocked";
    return shift ? "resize" : "move";
  }

  /**
   * The bounds a drag of (dx, dy) gives. move translates; resize grows or shrinks
   * from the bottom-right corner (never below MIN_W x MIN_H); duplicate moves the
   * copy like a move; blocked/pass/pan leave the object alone.
   */
  function dragBounds(gesture, start, dx, dy, { minW = MIN_W, minH = MIN_H } = {}) {
    const b = { x: Number(start.x) || 0, y: Number(start.y) || 0, width: Number(start.width) || 0, height: Number(start.height) || 0 };
    const ddx = Number(dx) || 0;
    const ddy = Number(dy) || 0;
    if (gesture === "move" || gesture === "duplicate") return { ...b, x: b.x + ddx, y: b.y + ddy };
    if (gesture === "resize") {
      return { ...b, width: Math.max(minW, b.width + ddx), height: Math.max(minH, b.height + ddy) };
    }
    return b;
  }

  /**
   * Keep a window rectangle on a display (the moveOrb rule, awdesk #9): at least
   * `keep` px of it stays inside the work area that holds its centre, else the
   * nearest work area.
   */
  function clampToAreas(bounds, areas, keep = 48) {
    const list = Array.isArray(areas) ? areas.filter(Boolean) : [];
    if (!list.length) return bounds;
    const cx = bounds.x + bounds.width / 2;
    const cy = bounds.y + bounds.height / 2;
    const dist = (a) => {
      const dx = Math.max(a.x - cx, 0, cx - (a.x + a.width));
      const dy = Math.max(a.y - cy, 0, cy - (a.y + a.height));
      return dx * dx + dy * dy;
    };
    const area = [...list].sort((a, b) => dist(a) - dist(b))[0];
    const k = Math.min(keep, bounds.width, bounds.height);
    const x = Math.min(Math.max(bounds.x, area.x - bounds.width + k), area.x + area.width - k);
    const y = Math.min(Math.max(bounds.y, area.y), area.y + area.height - k);
    return { ...bounds, x: Math.round(x), y: Math.round(y) };
  }

  return { HIT_PX, MIN_W, MIN_H, middleGesture, dragBounds, clampToAreas };
});
