"use strict";

/**
 * desktop-right.cjs -- the ONE rule for "the owner right-clicked the empty desktop".
 *
 * Owner, 2026-11-23: the right-click ring must open on the desktop background only,
 * never on an app, a file or an icon, and Shift+right-click must keep Windows' own
 * desktop menu. The resident window probe reports {down, shift, className, x, y};
 * this module decides whether that sample is a fresh right-press on the desk layer.
 *
 * A fresh press (wasDown false -> down true) over Progman / WorkerW / the desktop's
 * list view, with Shift up, is ours. Everything else is not.
 *
 * PURE: no electron, no clock. node --test electron/desktop-right.test.cjs
 */

/** The shell windows that make up the desktop background itself. */
const DESKTOP_CLASSES = Object.freeze(["Progman", "WorkerW", "SHELLDLL_DefView", "SysListView32"]);

function isDesktopClass(className) {
  return DESKTOP_CLASSES.includes(String(className || ""));
}

/**
 * @param {{down?: boolean, shift?: boolean, className?: string, wasDown?: boolean}} sample
 * @returns {boolean} true when THIS sample starts a desktop right-click for the ring.
 */
function shouldOpen({ down = false, shift = false, className = "", wasDown = false } = {}) {
  if (down !== true) return false; // not pressed (or already handled)
  if (wasDown === true) return false; // still held: never a second ring
  if (shift === true) return false; // Shift+right-click is Windows' menu, untouched
  return isDesktopClass(className);
}

module.exports = { DESKTOP_CLASSES, isDesktopClass, shouldOpen };
