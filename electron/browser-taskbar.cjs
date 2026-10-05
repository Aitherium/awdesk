"use strict";

/**
 * browser-taskbar.cjs -- the AitherOS Online taskbar along the bottom of the Aither
 * Browser (owner, 2026-10-04: "just missing the AitherOS living desktop taskbar at
 * the bottom of the browser now").
 *
 * It is the REAL taskbar -- Veil's <Taskbar/> (components/os/dock.tsx), served bare at
 * app.aitherium.com/embed/taskbar -- in a view of its own, in AitherOS Online's
 * signed-in partition. Never a second, hand-drawn copy: that is how the site grew three
 * drifting taskbars (dock.tsx header, 2026-08-19).
 *
 * The page has no bridge into the desk. It speaks two ways, both plain web:
 *   - NAVIGATION. Outside a desktop the taskbar navigates to `/?spawn=<app>`
 *     (useDockTarget). The desk catches every navigation and window.open from the
 *     view and sends it to the pinned AitherOS Online tab (an aitherium.com page)
 *     or a new web tab (anything else). The view itself never leaves /embed/taskbar.
 *   - ITS TITLE. Start and the tray open popovers UPWARD, which a 56 px view would
 *     clip. The page titles itself OPEN_TITLE while one is open; the desk grows the
 *     view over the page until the title goes back.
 *
 * Until /embed/taskbar is deployed the view gets a 404: the strip is then hidden and
 * the rail says "unavailable" rather than showing an error page as a taskbar.
 *
 * Pure: every decision is asserted under `node --test`.
 */

const TASKBAR_PATH = "/embed/taskbar";
const OPEN_TITLE = "Aither taskbar · open";
/** A navigation sooner than this after the page loaded is the page moving itself, not a click. */
const SETTLE_MS = 1500;

/** Where the taskbar page lives, on the AitherOS Online host. */
function taskbarUrl(onlineBase) {
  try {
    const url = new URL(TASKBAR_PATH, String(onlineBase || "https://app.aitherium.com/"));
    return url.protocol === "https:" ? url.href : null;
  } catch {
    return null;
  }
}

/** Is a popover (Start, the tray) open? Read from the page's title. */
function isOpenTitle(title) {
  return String(title || "").trim() === OPEN_TITLE;
}

/** Is `url` the taskbar page itself (the one place the view may stay)? */
function isTaskbarPage(url) {
  try {
    const parsed = new URL(String(url || ""));
    return parsed.protocol === "https:" && isAitheriumHost(parsed.hostname)
      && parsed.pathname.replace(/\/+$/, "") === TASKBAR_PATH;
  } catch {
    return false;
  }
}

function isAitheriumHost(host) {
  const h = String(host || "").toLowerCase();
  return h === "aitherium.com" || h.endsWith(".aitherium.com");
}

/**
 * Where a navigation out of the taskbar goes.
 *   "stay"    the taskbar page itself (a reload, a hash change)
 *   "online"  an aitherium.com page: the pinned AitherOS Online tab loads it
 *   "web"     any other http(s) page: a new web tab of the owner's
 *   "deny"    anything else (file:, aither:, javascript:)
 */
function routeFor(url) {
  if (isTaskbarPage(url)) return "stay";
  let parsed;
  try {
    parsed = new URL(String(url || ""));
  } catch {
    return "deny";
  }
  if (parsed.protocol === "https:" && isAitheriumHost(parsed.hostname)) return "online";
  if (parsed.protocol === "https:" || parsed.protocol === "http:") return "web";
  return "deny";
}

/** A main-frame response that means "there is no taskbar here" (not deployed, an error). */
function isUnavailable(httpResponseCode) {
  const code = Number(httpResponseCode);
  return Number.isFinite(code) && code >= 400;
}

/**
 * The view's rectangle while a popover is open: from under the toolbar to the window's
 * bottom, full width, so Start can open as tall as it wants.
 */
function expandedRect(rects) {
  const top = rects.page.y;
  const bottom = rects.taskbar.y + rects.taskbar.height;
  return { x: 0, y: top, width: rects.taskbar.width, height: Math.max(0, bottom - top) };
}

module.exports = {
  OPEN_TITLE,
  SETTLE_MS,
  TASKBAR_PATH,
  expandedRect,
  isOpenTitle,
  isTaskbarPage,
  isUnavailable,
  routeFor,
  taskbarUrl,
};
