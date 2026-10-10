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
 *   occluders (with shown) OS windows stacked above it: the browser is clipped to the rest.
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
 * Z-ORDER (owner, 2026-10-10): a native window cannot sit BETWEEN two DOM windows of the
 * overlay, so the OS sends `occluders` -- the rects of its windows stacked ABOVE the
 * browser's frame -- and the browser is clipped to what is left (BrowserWindow.setShape).
 * Fully covered, it hides; raised (taskbar, stage strip, its title bar), nothing is above
 * it and it is whole again. Pure rect arithmetic, in the page's CSS px.
 */
function subtractRect(r, o) {
  const ox1 = Math.max(r.x, o.x);
  const oy1 = Math.max(r.y, o.y);
  const ox2 = Math.min(r.x + r.w, o.x + o.w);
  const oy2 = Math.min(r.y + r.h, o.y + o.h);
  if (ox1 >= ox2 || oy1 >= oy2) return [r];
  const out = [];
  if (oy1 > r.y) out.push({ x: r.x, y: r.y, w: r.w, h: oy1 - r.y }); // above
  if (oy2 < r.y + r.h) out.push({ x: r.x, y: oy2, w: r.w, h: r.y + r.h - oy2 }); // below
  if (ox1 > r.x) out.push({ x: r.x, y: oy1, w: ox1 - r.x, h: oy2 - oy1 }); // left
  if (ox2 < r.x + r.w) out.push({ x: ox2, y: oy1, w: r.x + r.w - ox2, h: oy2 - oy1 }); // right
  return out;
}

const isRect = (r) => Boolean(r && typeof r === "object"
  && [r.x, r.y, r.w, r.h].every((n) => typeof n === "number" && Number.isFinite(n)) && r.w > 0 && r.h > 0);

/**
 * The parts of `body` no occluder covers, as rects RELATIVE to the body (CSS px).
 * Empty = fully covered. At most 64 occluders are honoured (a page cannot make this hot).
 */
function visibleRects(body, occluders) {
  if (!isRect(body)) return [];
  let parts = [{ x: body.x, y: body.y, w: body.w, h: body.h }];
  const list = Array.isArray(occluders) ? occluders.filter(isRect).slice(0, 64) : [];
  for (const o of list) {
    parts = parts.flatMap((p) => subtractRect(p, o));
    if (!parts.length) break;
  }
  return parts.map((p) => ({ x: p.x - body.x, y: p.y - body.y, w: p.w, h: p.h }));
}

/** Body-relative CSS px rects -> a setShape() list in window DIP. */
function shapeFor(parts, zoom = 1) {
  const z = typeof zoom === "number" && zoom > 0 && Number.isFinite(zoom) ? zoom : 1;
  return parts.map((p) => ({
    x: Math.round(p.x * z), y: Math.round(p.y * z),
    width: Math.max(1, Math.round(p.w * z)), height: Math.max(1, Math.round(p.h * z)),
  }));
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
  let covered = false; // hidden because OS windows cover all of it
  let clipped = false;  // a shape is applied

  function unclip(b) {
    if (!clipped || !live(b) || typeof b.setShape !== "function") { clipped = false; return; }
    const { width, height } = b.getBounds();
    b.setShape([{ x: 0, y: 0, width, height }]);
    clipped = false;
  }

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
      unclip(b); // after the resize: a window shape does not grow with the window
      if (typeof b.isVisible === "function" && !b.isVisible()) b.show();
    }
    freeBounds = null;
    freeMin = null;
    covered = false;
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
    // Stacking: a message with the body's rect carries what is above it.
    if (m.rect) {
      const parts = visibleRects(m.rect, m.occluders);
      const whole = parts.length === 1 && parts[0].x === 0 && parts[0].y === 0
        && parts[0].w === m.rect.w && parts[0].h === m.rect.h;
      covered = parts.length === 0;
      if (covered) {
        if (typeof b.isVisible === "function" && b.isVisible()) b.hide();
        return true;
      }
      if (whole) unclip(b);
      else if (typeof b.setShape === "function") {
        b.setShape(shapeFor(parts, zoom));
        clipped = true;
      }
    }
    if (m.focus) {
      // Raised in the OS: nothing is above it any more.
      covered = false;
      unclip(b);
      b.show();
      b.focus();
    } else if (!covered && typeof b.isVisible === "function" && !b.isVisible()) {
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
      covered = false;
      clipped = false;
      if (was) onChange(false);
    },
    isInside: () => inside,
    isCovered: () => covered,
    isClipped: () => clipped,
  };
}

module.exports = { INSIDE_MIN, createBrowserInOnline, screenRect, shapeFor, subtractRect, visibleRects };
