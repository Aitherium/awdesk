"use strict";

/**
 * fairy-hover-guard — the fairy's hover tip and its hit testing can never get stuck.
 *
 * Owner, 2026-11-14: "fix fairy -- these little tooltips get stuck and stay in the
 * way constantly". Screenshots: a "support-loop: support repro: needs-info" pill left
 * floating over Explorer and over a terminal, beside the fairy with a 48 badge.
 *
 * Why it stuck: the tip and the click-through flip were driven ONLY by the page's
 * mousemove/mouseleave. A window ignoring the mouse with `forward: true` gets no
 * reliable mouseleave on Windows, the companions orbit out from under a still
 * pointer, and a new companion list reset the page's hover without hiding the tip.
 * So the page could stop talking while the tip stayed up and the window kept
 * taking clicks.
 *
 * Main now owns the safety net, whatever the page does:
 *   - a tip hides on its own after `tipTtlMs`, and as soon as the pointer moves
 *     `slopPx` away from where it was shown (it is beside ONE fairy, not a sticker);
 *   - a window made hit-testable is handed back to click-through once the pointer
 *     is outside its bounds, and the page is told so it re-arms its hover;
 *   - `release()` drops both at once (hide, drag, a card or menu opening, a new
 *     companion list).
 * One tip at a time: there is one tip window and showing replaces it.
 *
 * Perf: the poll runs only while a tip is up or a window is hit-testable. An idle
 * fairy costs no timer.
 *
 * Pure: the cursor, the window effects and the timers are injected.
 */

const TIP_TTL_MS = 4000;
const POLL_MS = 200;
const SLOP_PX = 28;

function inside(point, rect) {
  return Boolean(point && rect)
    && point.x >= rect.x && point.x < rect.x + rect.width
    && point.y >= rect.y && point.y < rect.y + rect.height;
}

function createHoverGuard({
  cursor,
  hideTip,
  setClickThrough,
  released = () => {},
  tipTtlMs = TIP_TTL_MS,
  pollMs = POLL_MS,
  slopPx = SLOP_PX,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  setTick = setInterval,
  clearTick = clearInterval,
} = {}) {
  /** {at: {x, y}} while a tip is up. */
  let tip = null;
  let ttl = null;
  let tick = null;
  /** key -> bounds() for each window currently taking the mouse. */
  const held = new Map();

  function stopTtl() {
    if (ttl) clearTimer(ttl);
    ttl = null;
  }

  function syncPoll() {
    const want = Boolean(tip) || held.size > 0;
    if (want && !tick) {
      tick = setTick(poll, pollMs);
      if (tick && typeof tick.unref === "function") tick.unref();
    } else if (!want && tick) {
      clearTick(tick);
      tick = null;
    }
  }

  function dropTip() {
    stopTtl();
    if (tip) {
      tip = null;
      try { hideTip(); } catch { /* the tip window is gone: nothing to hide */ }
    }
    syncPoll();
  }

  /** Back to click-through. `tell`: the page did not ask, so it must re-arm its hover. */
  function giveBack(key, tell = true) {
    if (!held.has(key)) return;
    held.delete(key);
    try { setClickThrough(key, true); } catch { /* the window is gone */ }
    if (tell) { try { released(key); } catch { /* the page is gone */ } }
  }

  function poll() {
    let c;
    try { c = cursor(); } catch { c = null; }
    if (!c) return;
    if (tip && Math.hypot(c.x - tip.at.x, c.y - tip.at.y) > slopPx) dropTip();
    for (const [key, bounds] of [...held]) {
      let rect;
      try { rect = bounds(); } catch { rect = null; }
      if (!inside(c, rect)) {
        giveBack(key);
        dropTip();
      }
    }
    syncPoll();
  }

  return {
    /** A tip was just shown at `point` (screen px). Replaces any earlier one. */
    tipShown(point) {
      stopTtl();
      let at = point && Number.isFinite(Number(point.x)) ? { x: Number(point.x), y: Number(point.y) } : null;
      if (!at) { try { at = cursor(); } catch { at = null; } }
      tip = { at: at || { x: 0, y: 0 } };
      ttl = setTimer(dropTip, tipTtlMs);
      if (ttl && typeof ttl.unref === "function") ttl.unref();
      syncPoll();
    },
    /** The tip was hidden by its owner: forget it. */
    tipHidden() {
      stopTtl();
      tip = null;
      syncPoll();
    },
    /** The page says the pointer is (not) on something in window `key`. */
    hit(key, isInside, bounds) {
      if (isInside) {
        held.set(key, bounds);
        try { setClickThrough(key, false); } catch { /* gone */ }
      } else {
        giveBack(key, false);
        // A window the page let go of may not have been "held" (already given
        // back by the poll); click-through is still the answer.
        try { setClickThrough(key, true); } catch { /* gone */ }
      }
      syncPoll();
    },
    /** Drop everything: every window back to click-through, the tip hidden. */
    release() {
      for (const key of [...held.keys()]) giveBack(key);
      dropTip();
    },
    poll,
    state() {
      return { tip: tip ? { ...tip.at } : null, held: [...held.keys()], polling: Boolean(tick) };
    },
  };
}

module.exports = { createHoverGuard, inside, TIP_TTL_MS, POLL_MS, SLOP_PX };
