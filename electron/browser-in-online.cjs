"use strict";

/**
 * browser-in-online.cjs -- the Aither Browser as a window OF AitherOS Online.
 *
 * Owner, 2026-10-04 (AITHER-BROWSER-PLAN slice 23): "when the overlay is up, the browser
 * sits inside AitherOS Online". The OS cannot render a native window, so it renders the
 * browser's FRAME -- an OS window (`deskbrowser`, Veil desk-browser-window.tsx) in its
 * taskbar and stage strip, focused and minimized by its window manager -- and says where
 * that frame's body is (aither-host/1 `desk-window`, overlay window only). Here:
 *
 *   shown     the browser becomes an OWNED window of the overlay (so it stays above the
 *             transparent overlay, not above every app), at the body's rect in screen DIP;
 *             `focus` raises and focuses it (the OS raised its window).
 *   hidden    minimized in the OS, or swept into the stage strip: the browser hides.
 *   detached  the OS window closed, or the overlay went away: the browser is its own
 *             window again, at the bounds it had before it went in.
 *
 * Electron-free: windows are injected, so the state machine runs under `node --test`
 * with plain stubs (browser-in-online.test.cjs), like avatar-dock.cjs.
 */

/** While inside Online the frame decides the size; the browser's own floor would overhang it. */
const INSIDE_MIN = Object.freeze({ width: 360, height: 240 });

/**
 * A rect in the overlay page's CSS px -> screen DIP. Null for anything that is not a
 * real, positive-size rect (the preload shaped it; this is the second check).
 * @param {{x:number,y:number,w:number,h:number}} rect
 * @param {{x:number,y:number}} content  the overlay's content bounds
 * @param {number} zoom  the overlay page's zoom factor
 */
function screenRect(rect, content, zoom = 1) {
  if (!rect || typeof rect !== "object" || !content) return null;
  const nums = [rect.x, rect.y, rect.w, rect.h];
  if (!nums.every((n) => typeof n === "number" && Number.isFinite(n))) return null;
  if (!(rect.w > 0 && rect.h > 0)) return null;
  const z = typeof zoom === "number" && zoom > 0 && Number.isFinite(zoom) ? zoom : 1;
  return {
    x: Math.round(content.x + rect.x * z),
    y: Math.round(content.y + rect.y * z),
    width: Math.max(1, Math.round(rect.w * z)),
    height: Math.max(1, Math.round(rect.h * z)),
  };
}

/**
 * @param {{
 *   browser: () => object|null,   the Aither Browser BrowserWindow (or null)
 *   onChange?: (inside: boolean) => void,
 * }} deps
 */
function createBrowserInOnline({ browser, onChange = () => {} }) {
  let inside = false;
  let owner = null;
  let freeBounds = null;
  let freeMin = null;

  const live = (w) => Boolean(w && !(typeof w.isDestroyed === "function" && w.isDestroyed()));

  function detach() {
    const b = browser();
    const was = inside;
    inside = false;
    owner = null;
    if (!was) return false;
    if (live(b)) {
      if (typeof b.setParentWindow === "function") b.setParentWindow(null);
      if (freeMin && typeof b.setMinimumSize === "function") b.setMinimumSize(freeMin[0], freeMin[1]);
      if (freeBounds) b.setBounds(freeBounds);
      if (typeof b.isVisible === "function" && !b.isVisible()) b.show();
    }
    freeBounds = null;
    freeMin = null;
    onChange(false);
    return true;
  }

  function attach(b, overlay) {
    if (inside && owner === overlay) return;
    if (inside) detach();
    freeBounds = b.getBounds();
    freeMin = typeof b.getMinimumSize === "function" ? b.getMinimumSize() : null;
    if (typeof b.setMinimumSize === "function") b.setMinimumSize(INSIDE_MIN.width, INSIDE_MIN.height);
    if (typeof b.setParentWindow === "function") b.setParentWindow(overlay);
    inside = true;
    owner = overlay;
    onChange(true);
  }

  /**
   * One `desk-window` message from the overlay.
   * @param {{state?: string, rect?: object|null, focus?: boolean}} msg
   * @param {object} overlay  the overlay BrowserWindow that sent it
   */
  function apply(msg, overlay) {
    const m = msg && typeof msg === "object" ? msg : {};
    const b = browser();
    if (m.state === "detached") return detach();
    if (!live(b) || !live(overlay)) return detach();
    if (m.state === "hidden") {
      if (inside && typeof b.isVisible === "function" && b.isVisible()) b.hide();
      return inside;
    }
    if (m.state !== "shown") return inside;
    // Inside Online only while Online is on screen.
    if (typeof overlay.isVisible === "function" && !overlay.isVisible()) return detach();
    const zoom = overlay.webContents && typeof overlay.webContents.getZoomFactor === "function"
      ? overlay.webContents.getZoomFactor() : 1;
    const rect = screenRect(m.rect, overlay.getContentBounds(), zoom);
    if (!rect && !inside) return false; // a bare focus before any frame: nothing to raise
    attach(b, overlay);
    if (rect) b.setBounds(rect);
    if (m.focus) {
      b.show();
      b.focus();
    } else if (typeof b.isVisible === "function" && !b.isVisible()) {
      b.showInactive();
    }
    return true;
  }

  return {
    apply,
    detach,
    /** The browser window closed: forget it (it has no bounds left to restore). */
    browserClosed() {
      const was = inside;
      inside = false;
      owner = null;
      freeBounds = null;
      freeMin = null;
      if (was) onChange(false);
    },
    isInside: () => inside,
  };
}

module.exports = { INSIDE_MIN, createBrowserInOnline, screenRect };
