"use strict";

/**
 * held-toast -- a Windows toast whose click still arrives.
 *
 * Electron's Notification is a plain JS object. When `const n = new Notification(..);
 * n.on("click", ..); n.show()` returns, nothing references `n`: the garbage collector may
 * free it and the toast stays on screen with a dead click (Owner, 2026-11-16: "Phone
 * connected: Pixel 10 Pro Fold -- Click to use this phone" did nothing). upload-notices
 * learned this first (main.cjs uploadNoticesHeld); this is that fix as ONE helper, so a
 * toast with a click handler cannot be written the other way.
 *
 * The toast is held until it is clicked, closed, fails, or `ttlMs` passes (a toast sent to
 * the action center never fires `close` on some Windows builds). A handler that throws is
 * logged, never thrown into Electron's event loop.
 */

const DEFAULT_TTL_MS = 30 * 60_000;
const MAX_HELD = 50;

function createToaster({ Notification, ttlMs = DEFAULT_TTL_MS, max = MAX_HELD,
  setTimeoutImpl = setTimeout, clearTimeoutImpl = clearTimeout, log = () => {} } = {}) {
  const held = new Map(); // notification -> ttl timer

  function isSupported() {
    try { return Boolean(Notification && Notification.isSupported()); } catch { return false; }
  }

  function release(n) {
    const timer = held.get(n);
    if (timer === undefined && !held.has(n)) return;
    held.delete(n);
    if (timer) clearTimeoutImpl(timer);
  }

  /** Show a toast. Returns the Notification, or null when toasts are unavailable. */
  function show({ title, body, onClick, onClose, ...rest }) {
    if (!isSupported()) return null;
    const n = new Notification({ title, body, ...rest });
    while (held.size >= max) release(held.keys().next().value);
    const timer = setTimeoutImpl(() => release(n), ttlMs);
    if (timer && typeof timer.unref === "function") timer.unref();
    held.set(n, timer);
    n.on("click", () => {
      release(n);
      if (typeof onClick !== "function") return;
      try {
        const r = onClick();
        if (r && typeof r.catch === "function") r.catch((e) => log(`toast click failed: ${e && e.message}`));
      } catch (e) {
        log(`toast click failed: ${e && e.message}`);
      }
    });
    n.on("close", () => { release(n); if (typeof onClose === "function") { try { onClose(); } catch { /* caller bug */ } } });
    n.on("failed", () => release(n));
    n.show();
    return n;
  }

  return { show, held: () => held.size };
}

module.exports = { createToaster, DEFAULT_TTL_MS, MAX_HELD };
