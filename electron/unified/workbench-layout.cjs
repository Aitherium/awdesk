"use strict";

/**
 * workbench-layout.cjs -- Pure pixel geometry for Unified AitherBrowser.
 *
 * Computes exact rects for:
 *   - Left Rail (avatar + conversations + projects + automations)
 *   - Center Agent Chat Pane
 *   - Right Browser Pane + nested WebContentsView content rects (1 or 2 split panes)
 *   - Living Desktop full-bleed WebContentsView rect
 *
 * Pure JS (reuses ../browser-panes.cjs for split-pane math). Zero Electron imports.
 */

const browserPanes = require("../browser-panes.cjs");

const TITLEBAR_HEIGHT = 36;
const BROWSER_CHROME_HEIGHT = 76; // 36px tab strip + 40px address/toolbar
const DESKTOP_TOPBAR_HEIGHT = 40;
const RAIL_COLLAPSED_WIDTH = 56;
const RAIL_MIN = 180;
const RAIL_MAX = 420;
const CHAT_MIN = 300;
const BROWSER_MIN = 320;
const DIVIDER = 4;

function normalizeUrlInput(input, homeUrl = "https://aithr.net") {
  const raw = String(input || "").trim();
  if (!raw) return homeUrl;
  if (/^(?:https?|file|about|aither):\/\//i.test(raw)) return raw;
  // Direct localhost / IP / port navigation (never hijack http://127.0.0.1:8765 into a search!)
  if (/^(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]|\d{1,3}(?:\.\d{1,3}){3})(?::\d+)?(?:\/.*)?$/i.test(raw)) {
    return `http://${raw}`;
  }
  // Domain-like token without spaces (e.g., aithr.net, github.com/Aitherium)
  if (!/\s/.test(raw) && /^[a-z0-9-]+(?:\.[a-z0-9-]+)+(?::\d+)?(?:\/.*)?$/i.test(raw)) {
    return `https://${raw}`;
  }
  return `https://duckduckgo.com/?q=${encodeURIComponent(raw)}`;
}

/**
 * Compute layout rectangles inside the single BaseWindow's content bounds.
 *
 * @param {object} opts
 * @param {"avatar"|"workbench"|"desktop"} opts.mode
 * @param {number} opts.width   Window content width in DIP
 * @param {number} opts.height  Window content height in DIP
 * @param {object} [opts.layout] Persisted layout preferences
 * @param {number} [opts.splitCount] 1 or 2 browser panes visible
 */
function computeLayout({ mode = "workbench", width = 1440, height = 900, layout = {}, splitCount = 1 } = {}) {
  const W = Math.max(240, Math.round(Number(width) || 1440));
  const H = Math.max(220, Math.round(Number(height) || 900));

  if (mode === "avatar") {
    return {
      mode: "avatar",
      shell: { x: 0, y: 0, width: W, height: H },
      rail: null,
      chat: null,
      browserChrome: null,
      browserViews: [],
      dividers: [],
    };
  }

  if (mode === "desktop") {
    const topH = DESKTOP_TOPBAR_HEIGHT;
    return {
      mode: "desktop",
      shell: { x: 0, y: 0, width: W, height: H },
      rail: null,
      chat: null,
      browserChrome: { x: 0, y: 0, width: W, height: topH },
      browserViews: [
        { x: 0, y: topH, width: W, height: Math.max(100, H - topH) },
      ],
      dividers: [],
    };
  }

  // Workbench 3-pane layout
  const railCollapsed = layout.railCollapsed === true;
  const railW = railCollapsed
    ? RAIL_COLLAPSED_WIDTH
    : Math.max(RAIL_MIN, Math.min(RAIL_MAX, Math.round(Number(layout.railWidth) || 248)));

  const bodyY = TITLEBAR_HEIGHT;
  const bodyH = Math.max(200, H - bodyY);
  const railRect = { x: 0, y: bodyY, width: railW, height: bodyH };

  const remX = railW + DIVIDER;
  const remW = Math.max(200, W - remX);

  const showChat = layout.showChat !== false;
  const showBrowser = layout.showBrowser !== false;
  // Never collapse both center and right panes simultaneously
  const effectiveChat = showChat || !showBrowser;
  const effectiveBrowser = showBrowser;

  let chatRect = null;
  let browserOuter = null;

  if (effectiveChat && effectiveBrowser) {
    const ratio = Number.isFinite(Number(layout.chatRatio))
      ? Math.max(0.22, Math.min(0.75, Number(layout.chatRatio)))
      : 0.44;
    let chatW = Math.round((remW - DIVIDER) * ratio);
    if (remW >= CHAT_MIN + BROWSER_MIN + DIVIDER) {
      chatW = Math.max(CHAT_MIN, Math.min(remW - BROWSER_MIN - DIVIDER, chatW));
    } else {
      chatW = Math.round((remW - DIVIDER) / 2);
    }
    const browserW = Math.max(120, remW - chatW - DIVIDER);
    chatRect = { x: remX, y: bodyY, width: chatW, height: bodyH };
    browserOuter = { x: remX + chatW + DIVIDER, y: bodyY, width: browserW, height: bodyH };
  } else if (effectiveChat) {
    chatRect = { x: remX, y: bodyY, width: remW, height: bodyH };
  } else {
    browserOuter = { x: remX, y: bodyY, width: remW, height: bodyH };
  }

  let browserChrome = null;
  let browserViews = [];
  let dividers = [];

  if (browserOuter) {
    browserChrome = {
      x: browserOuter.x,
      y: browserOuter.y,
      width: browserOuter.width,
      height: BROWSER_CHROME_HEIGHT,
    };
    const contentRect = {
      x: browserOuter.x,
      y: browserOuter.y + BROWSER_CHROME_HEIGHT,
      width: browserOuter.width,
      height: Math.max(80, browserOuter.height - BROWSER_CHROME_HEIGHT),
    };
    const panes = Math.max(1, Math.min(2, Math.round(Number(splitCount) || 1)));
    if (panes === 1) {
      browserViews = [contentRect];
    } else {
      const splitRes = browserPanes.layoutPanes(
        contentRect,
        browserPanes.defaultSizes(panes),
        "horizontal",
      );
      browserViews = splitRes.panes;
      dividers = splitRes.dividers;
    }
  }

  return {
    mode: "workbench",
    shell: { x: 0, y: 0, width: W, height: H },
    titlebar: { x: 0, y: 0, width: W, height: TITLEBAR_HEIGHT },
    rail: railRect,
    chat: chatRect,
    browserChrome,
    browserOuter,
    browserViews,
    dividers,
  };
}

module.exports = {
  TITLEBAR_HEIGHT,
  BROWSER_CHROME_HEIGHT,
  DESKTOP_TOPBAR_HEIGHT,
  RAIL_COLLAPSED_WIDTH,
  RAIL_MIN,
  RAIL_MAX,
  CHAT_MIN,
  BROWSER_MIN,
  DIVIDER,
  normalizeUrlInput,
  computeLayout,
};
