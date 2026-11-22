/* global window */
/* middle-drag.js -- the owner's middle-button rule, ONE copy for every desk surface
   (owner, 2026-11-07):
       middle-drag on an item          MOVE it   (a card, a pin, an ink object)
       Shift + middle-drag on an item  RESIZE it
       Ctrl  + middle-drag on an item  DUPLICATE it (the copy follows the pointer)
       middle-drag on empty space      PAN the surface (where the surface pans)
   A page script (aither://canvas, the floating board window, the browser chrome's
   edit-layout mode) loads it with <script src="middle-drag.js"> and gets
   window.AitherMiddleDrag. Pure decisions + a tiny pointer tracker; no DOM writes.
   middle-drag.test.cjs runs this file in a vm. desk-pins-ink owns the desktop-pin
   handler and the shortcut-conflict test, and reuses this file: the main process
   (ink-mode, ink-window, pins-window) loads this SAME file through
   middle-drag-load.cjs, so there is no second copy of the rule. */
(function (root) {
  "use strict";

  /** "move" | "resize" | "duplicate" | "pan" | null for a pointerdown. */
  function classify(event, onItem) {
    if (!event || event.button !== 1) return null;
    if (!onItem) return "pan";
    if (event.ctrlKey || event.metaKey) return "duplicate";
    if (event.shiftKey) return "resize";
    return "move";
  }

  /**
   * Follow one middle-drag from `event` until the button comes up. `scale` turns
   * screen pixels into the surface's units (a zoomed board). Calls
   * onMove({dx, dy}) per move with the TOTAL delta, then onEnd({dx, dy, moved}).
   * The browser's own middle-click autoscroll is suppressed for the gesture.
   */
  function track(event, target, { scale = 1, onMove = () => {}, onEnd = () => {} } = {}) {
    if (event.preventDefault) event.preventDefault();
    if (event.stopPropagation) event.stopPropagation();
    try { target.setPointerCapture(event.pointerId); } catch { /* a synthetic event has no capture */ }
    const start = { x: event.clientX, y: event.clientY };
    let last = { dx: 0, dy: 0 };
    const k = Number(scale) > 0 ? Number(scale) : 1;
    const move = (ev) => {
      last = { dx: (ev.clientX - start.x) / k, dy: (ev.clientY - start.y) / k };
      onMove(last);
    };
    const up = () => {
      target.removeEventListener("pointermove", move);
      target.removeEventListener("pointerup", up);
      target.removeEventListener("pointercancel", up);
      onEnd({ ...last, moved: Math.abs(last.dx) + Math.abs(last.dy) > 0 });
    };
    target.addEventListener("pointermove", move);
    target.addEventListener("pointerup", up);
    target.addEventListener("pointercancel", up);
    return { cancel: up };
  }

  /** Same tolerance AitherOne uses for a stroke hit (scene.ts). */
  const HIT_PX = 6;
  const MIN_W = 24;
  const MIN_H = 24;

  /**
   * The full decision (desk-pins-ink, 2026-11-07), for callers that know more than a
   * pointer event: a LOCKED item never moves or resizes but can be duplicated, and on
   * the bare DESKTOP empty space passes to the app underneath instead of panning.
   * Returns "move" | "resize" | "duplicate" | "blocked" | "pass" | "pan".
   */
  function decide({ onItem = false, locked = false, shift = false, ctrl = false, meta = false, surface = "board" } = {}) {
    if (!onItem) return surface === "desktop" ? "pass" : "pan";
    if (ctrl || meta) return "duplicate";
    if (locked) return "blocked";
    return shift ? "resize" : "move";
  }

  /** The bounds a drag of (dx, dy) gives: move/duplicate translate, resize grows from the bottom-right. */
  function dragBounds(gesture, start, dx, dy, { minW = MIN_W, minH = MIN_H } = {}) {
    const b = { x: Number(start.x) || 0, y: Number(start.y) || 0, width: Number(start.width) || 0, height: Number(start.height) || 0 };
    const ddx = Number(dx) || 0;
    const ddy = Number(dy) || 0;
    if (gesture === "move" || gesture === "duplicate") return { ...b, x: b.x + ddx, y: b.y + ddy };
    if (gesture === "resize") return { ...b, width: Math.max(minW, b.width + ddx), height: Math.max(minH, b.height + ddy) };
    return b;
  }

  /**
   * Keep a window rectangle on a display (the moveOrb rule, awdesk #9): at least
   * `keep` px of it stays inside the work area nearest its centre.
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

  /** Stop Chromium's middle-click autoscroll (and a middle-click paste) on `el`. */
  function suppressAutoscroll(el) {
    el.addEventListener("mousedown", (e) => { if (e.button === 1) e.preventDefault(); });
    el.addEventListener("auxclick", (e) => { if (e.button === 1) e.preventDefault(); });
  }

  root.AitherMiddleDrag = Object.freeze({
    classify, track, suppressAutoscroll, decide, dragBounds, clampToAreas, HIT_PX, MIN_W, MIN_H,
  });
})(typeof window !== "undefined" ? window : globalThis);
