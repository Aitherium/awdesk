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

/** Run in the page's isolated world to end its full screen (no click needed to exit). */
const EXIT_SCRIPT = "document.fullscreenElement ? document.exitFullscreen().then(() => true, () => false) : false";

module.exports = { EXIT_SCRIPT, createFullscreen, fullRect, fullscreenRects };
