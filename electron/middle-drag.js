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
   handler and the shortcut-conflict test, and reuses this file. */
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

  /** Stop Chromium's middle-click autoscroll (and a middle-click paste) on `el`. */
  function suppressAutoscroll(el) {
    el.addEventListener("mousedown", (e) => { if (e.button === 1) e.preventDefault(); });
    el.addEventListener("auxclick", (e) => { if (e.button === 1) e.preventDefault(); });
  }

  root.AitherMiddleDrag = Object.freeze({ classify, track, suppressAutoscroll });
})(typeof window !== "undefined" ? window : globalThis);
