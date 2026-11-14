"use strict";

/**
 * browser-fullscreen.cjs -- a page's full screen (a video's full-screen button).
 *
 * element.requestFullscreen() is granted to the owner's web tab (browser-quiet-grants).
 * Electron then puts the WINDOW in full screen and fires enter-html-full-screen on the
 * tab, but the tab's view keeps its place under the toolbar, so the video filled a
 * rectangle in the middle of an otherwise empty screen. While a tab is in page full
 * screen its view now gets the whole window: the toolbar, tab strip and rail (the
 * chrome page underneath) are covered, and the panel, taskbar and dock are hidden.
 *
 * Nothing is saved and nothing is restored by hand: the layout is a function of the
 * owner's prefs, so the moment the tab leaves full screen the next layout pass is the
 * exact layout from before.
 *
 * One tab at a time. Showing another tab, closing the tab or the page navigating ends it.
 *
 * Pure: no electron.
 */

const { promptHost } = require("./browser-permissions.cjs");

/** The whole content area of the window, as a view rect. */
function fullRect(content) {
  const width = Math.max(0, Math.round(Number(content && content.width) || 0));
  const height = Math.max(0, Math.round(Number(content && content.height) || 0));
  return { x: 0, y: 0, width, height };
}

/**
 * The window's rects while a page is full screen: the page takes everything, every
 * other pane collapses to nothing (browser-window layout() hides a pane of size 0).
 */
function fullscreenRects(rects, content) {
  const none = { x: 0, y: 0, width: 0, height: 0 };
  const out = { ...(rects || {}), page: fullRect(content) };
  for (const pane of ["panel", "taskbar", "dock"]) out[pane] = { ...none };
  out.avatar = null;
  return out;
}

function createFullscreen() {
  let tab = null;
  return {
    /** The tab in page full screen, or null. */
    tab: () => tab,
    /** enter-html-full-screen on this tab. Returns true when the layout must change. */
    enter(id) {
      if (id == null || tab === id) return false;
      tab = id;
      return true;
    },
    /** leave-html-full-screen, the tab closed, or its page left. */
    leave(id) {
      if (tab == null || (id != null && tab !== id)) return false;
      tab = null;
      return true;
    },
    /** The rects to lay out with: full screen only while its tab is the one on screen. */
    rects(rects, content, activeId) {
      return tab != null && tab === activeId ? fullscreenRects(rects, content) : rects;
    },
    /** The full-screen tab that is no longer on screen (another tab was shown): it must exit. */
    stale(activeId) {
      return tab != null && tab !== activeId ? tab : null;
    },
  };
}

// ---- the exit hint (M2) -----------------------------------------------------------
// A page in full screen covers the address bar, so it can draw a fake one. Every time a
// page enters full screen, main shows "<site> is full screen - press Esc" for HINT_MS in
// a view of its OWN, on top of the page: the page cannot remove, cover or restyle it.

const HINT_MS = 3000;
const HINT_SIZE = Object.freeze({ width: 460, height: 44, top: 28 });

function escapeHtml(text) {
  return String(text).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

/** "<site> is full screen - press Esc to exit". The END of a long host is what is shown. */
function hintText(url) {
  let origin = null;
  try {
    const u = new URL(String(url || ""));
    if (u.protocol === "http:" || u.protocol === "https:") origin = u.origin;
  } catch { /* not a web page */ }
  return `${origin ? promptHost(origin) : "This page"} is full screen \u2014 press Esc to exit`;
}

/** The hint's own document: text only, no script, nothing from the page but its host name (escaped). */
function hintPage(url) {
  const html = `<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">`
    + "<style>html,body{margin:0;height:100%;background:transparent;overflow:hidden}"
    + "div{box-sizing:border-box;height:100%;display:flex;align-items:center;justify-content:center;padding:0 18px;"
    + "background:rgba(15,18,24,.94);color:#fff;font:600 14px/1 system-ui,sans-serif;border:1px solid rgba(255,255,255,.35);"
    + "border-radius:22px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}</style>"
    + `<div id="hint">${escapeHtml(hintText(url))}</div>`;
  return `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;
}

/** Where the hint sits: top centre of the window, never wider than it. */
function hintRect(content) {
  const full = fullRect(content);
  const width = Math.min(HINT_SIZE.width, Math.max(0, full.width - 16));
  return { x: Math.max(0, Math.round((full.width - width) / 2)), y: HINT_SIZE.top, width, height: HINT_SIZE.height };
}

// ---- questions under a full-screen page (L1) ---------------------------------------
// A permission prompt or an "Open <App>?" question lives in the toolbar, which a
// full-screen page covers. Its Allow/Open arms after half a second on screen
// (browser-permissions ALLOW_ARM_MS), so raised under full screen it would arm unseen.
// Such a notice makes the page leave full screen, is held unanswerable until it has, and
// its clock starts again the moment the toolbar is visible.

const EYES_KINDS = Object.freeze(["permission", "external-app"]);

/** Does this notice ask the owner something that must be SEEN before it can be answered? */
function needsEyes(notice) {
  return Boolean(notice) && EYES_KINDS.includes(notice.kind);
}

/** The notice as raised under a full-screen page: it cannot arm (`at` is not a time yet). */
function heldNotice(notice) {
  return needsEyes(notice) ? { ...notice, at: Infinity } : notice;
}

/** The page left full screen: the question's half second starts now. Mutates and returns it. */
function restamp(notice, now) {
  if (needsEyes(notice)) notice.at = now;
  return notice;
}

/** Run in the page's isolated world to end its full screen (no click needed to exit). */
const EXIT_SCRIPT = "document.fullscreenElement ? document.exitFullscreen().then(() => true, () => false) : false";

module.exports = {
  EXIT_SCRIPT, EYES_KINDS, HINT_MS, createFullscreen, fullRect, fullscreenRects,
  heldNotice, hintPage, hintRect, hintText, needsEyes, restamp,
};
