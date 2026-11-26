"use strict";

/**
 * morph-state.cjs -- Pure 3-state window morph machine for Unified AitherBrowser.
 *
 * One OS window (BaseWindow) morphs cleanly across three modes:
 *   - "avatar"    : compact always-on-top companion + whisper cards (no attached webviews)
 *   - "workbench" : Antigravity-style 3-pane shell (Left Rail | Agent Chat | Browser)
 *   - "desktop"   : full work-area AitherOS Living Desktop overlay (aithr.net full-bleed)
 *
 * Pure JS (zero Electron imports) so every bounds transition, drag clamp, and resize
 * rule is unit-tested under `node --test`.
 */

const fs = require("node:fs");
const path = require("node:path");

const MODES = Object.freeze(["avatar", "workbench", "desktop"]);
const DEFAULT_HOME_URL = "https://aithr.net";
const STATE_FILE = "unified-shell.json";

const MODE_LIMITS = Object.freeze({
  avatar: Object.freeze({
    defaultW: 440,
    defaultH: 560,
    minW: 260,
    minH: 280,
    maxW: 760,
    maxH: 980,
    alwaysOnTop: true,
    resizable: true,
  }),
  workbench: Object.freeze({
    defaultW: 1440,
    defaultH: 900,
    minW: 900,
    minH: 580,
    maxW: 7680,
    maxH: 4320,
    alwaysOnTop: false,
    resizable: true,
  }),
  desktop: Object.freeze({
    defaultW: 1920,
    defaultH: 1080,
    minW: 800,
    minH: 600,
    maxW: 7680,
    maxH: 4320,
    alwaysOnTop: false,
    resizable: false,
  }),
});

const DEFAULT_DISPLAY = Object.freeze({ x: 0, y: 0, width: 1920, height: 1080 });

function clampNum(v, lo, hi, fallback) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(lo, Math.min(hi, Math.round(n)));
}

function normalizeDisplay(display) {
  const d = display && typeof display === "object" ? display : DEFAULT_DISPLAY;
  return {
    x: Number.isFinite(Number(d.x)) ? Math.round(Number(d.x)) : 0,
    y: Number.isFinite(Number(d.y)) ? Math.round(Number(d.y)) : 0,
    width: Math.max(800, clampNum(d.width, 800, 15360, DEFAULT_DISPLAY.width)),
    height: Math.max(600, clampNum(d.height, 600, 8640, DEFAULT_DISPLAY.height)),
  };
}

function defaultBoundsFor(mode, display) {
  const d = normalizeDisplay(display);
  const lim = MODE_LIMITS[mode] || MODE_LIMITS.workbench;
  if (mode === "desktop") {
    return { x: d.x, y: d.y, width: d.width, height: d.height };
  }
  const width = Math.min(lim.defaultW, d.width - 32);
  const height = Math.min(lim.defaultH, d.height - 32);
  if (mode === "avatar") {
    // Dock near bottom-right corner with breathing room
    return {
      x: d.x + Math.max(16, d.width - width - 24),
      y: d.y + Math.max(16, d.height - height - 24),
      width,
      height,
    };
  }
  return {
    x: d.x + Math.round((d.width - width) / 2),
    y: d.y + Math.round((d.height - height) / 2),
    width,
    height,
  };
}

function clampBounds(mode, bounds, display) {
  const d = normalizeDisplay(display);
  if (mode === "desktop") {
    return { x: d.x, y: d.y, width: d.width, height: d.height };
  }
  const lim = MODE_LIMITS[mode] || MODE_LIMITS.workbench;
  const maxW = Math.min(lim.maxW, d.width);
  const maxH = Math.min(lim.maxH, d.height);
  const minW = Math.min(lim.minW, maxW);
  const minH = Math.min(lim.minH, maxH);
  const width = clampNum(bounds && bounds.width, minW, maxW, Math.min(lim.defaultW, maxW));
  const height = clampNum(bounds && bounds.height, minH, maxH, Math.min(lim.defaultH, maxH));
  // Keep at least 80px visible on screen horizontally and titlebar/top visible vertically
  const minVisible = Math.min(80, width);
  const minX = d.x - width + minVisible;
  const maxX = d.x + d.width - minVisible;
  const minY = d.y;
  const maxY = d.y + d.height - Math.min(60, height);
  const fallback = defaultBoundsFor(mode, d);
  const x = clampNum(bounds && bounds.x, minX, maxX, fallback.x);
  const y = clampNum(bounds && bounds.y, minY, maxY, fallback.y);
  return { x, y, width, height };
}

function createInitialState(display) {
  const d = normalizeDisplay(display);
  return {
    version: 1,
    mode: "workbench",
    previousMode: "workbench",
    homeUrl: DEFAULT_HOME_URL,
    avatarRenderer: "orb2d", // "orb2d" (0% idle GPU) | "vrm-ondemand"
    selectedVrm: "model-avreg-aither-v2.vrm",
    boundsByMode: {
      avatar: defaultBoundsFor("avatar", d),
      workbench: defaultBoundsFor("workbench", d),
    },
    layout: {
      railWidth: 248,
      railCollapsed: false,
      chatRatio: 0.44,
      showChat: true,
      showBrowser: true,
      browserSplit: false,
      desktopDockOpen: true,
    },
  };
}

function normalizeState(raw, display) {
  const base = createInitialState(display);
  if (!raw || typeof raw !== "object") return base;
  const mode = MODES.includes(raw.mode) ? raw.mode : base.mode;
  const previousMode = MODES.includes(raw.previousMode) ? raw.previousMode : "workbench";
  const homeUrl =
    typeof raw.homeUrl === "string" && /^https?:\/\//i.test(raw.homeUrl.trim())
      ? raw.homeUrl.trim()
      : DEFAULT_HOME_URL;
  const avatarRenderer = raw.avatarRenderer === "vrm-ondemand" ? "vrm-ondemand" : "orb2d";
  const selectedVrm =
    typeof raw.selectedVrm === "string" && /^[\w.-]+\.vrm$/i.test(raw.selectedVrm.trim())
      ? raw.selectedVrm.trim()
      : base.selectedVrm;
  const rawBounds = raw.boundsByMode && typeof raw.boundsByMode === "object" ? raw.boundsByMode : {};
  const rawLayout = raw.layout && typeof raw.layout === "object" ? raw.layout : {};
  return {
    version: 1,
    mode,
    previousMode,
    homeUrl,
    avatarRenderer,
    selectedVrm,
    boundsByMode: {
      avatar: clampBounds("avatar", rawBounds.avatar || base.boundsByMode.avatar, display),
      workbench: clampBounds("workbench", rawBounds.workbench || base.boundsByMode.workbench, display),
    },
    layout: {
      railWidth: clampNum(rawLayout.railWidth, 180, 420, base.layout.railWidth),
      railCollapsed: rawLayout.railCollapsed === true,
      chatRatio:
        Number.isFinite(Number(rawLayout.chatRatio))
          ? Math.max(0.22, Math.min(0.75, Number(rawLayout.chatRatio)))
          : base.layout.chatRatio,
      showChat: rawLayout.showChat !== false,
      showBrowser: rawLayout.showBrowser !== false,
      browserSplit: rawLayout.browserSplit === true,
      desktopDockOpen: rawLayout.desktopDockOpen !== false,
    },
  };
}

/** Transition to a target morph mode, preserving current mode's bounds. */
function transitionMode(state, nextMode, currentWindowBounds, display) {
  if (!MODES.includes(nextMode)) {
    throw new Error(`Invalid morph mode: ${nextMode}`);
  }
  const d = normalizeDisplay(display);
  const next = {
    ...state,
    boundsByMode: { ...state.boundsByMode },
    layout: { ...state.layout },
  };
  if (state.mode === "avatar" || state.mode === "workbench") {
    if (currentWindowBounds) {
      next.boundsByMode[state.mode] = clampBounds(state.mode, currentWindowBounds, d);
    }
  }
  if (nextMode !== state.mode) {
    next.previousMode = state.mode;
    next.mode = nextMode;
  }
  const targetBounds =
    nextMode === "desktop"
      ? defaultBoundsFor("desktop", d)
      : clampBounds(nextMode, next.boundsByMode[nextMode], d);
  const lim = MODE_LIMITS[nextMode];
  return {
    state: next,
    windowSpec: {
      mode: nextMode,
      bounds: targetBounds,
      minWidth: lim.minW,
      minHeight: lim.minH,
      alwaysOnTop: lim.alwaysOnTop,
      resizable: lim.resizable,
    },
  };
}

/** Begin a middle-mouse (or header) window drag from screen coordinates. */
function beginDrag(mode, windowBounds, pointerScreen) {
  if (mode === "desktop") return null;
  if (!windowBounds || !pointerScreen) return null;
  return {
    mode,
    startMouseX: Number(pointerScreen.x) || 0,
    startMouseY: Number(pointerScreen.y) || 0,
    startWinX: Math.round(Number(windowBounds.x) || 0),
    startWinY: Math.round(Number(windowBounds.y) || 0),
    width: Math.round(Number(windowBounds.width) || 340),
    height: Math.round(Number(windowBounds.height) || 480),
  };
}

/** Compute next clamped window bounds during an active drag. */
function stepDrag(drag, pointerScreen, display) {
  if (!drag || !pointerScreen) return null;
  const dx = (Number(pointerScreen.x) || 0) - drag.startMouseX;
  const dy = (Number(pointerScreen.y) || 0) - drag.startMouseY;
  return clampBounds(
    drag.mode,
    {
      x: drag.startWinX + dx,
      y: drag.startWinY + dy,
      width: drag.width,
      height: drag.height,
    },
    display,
  );
}

/** Apply an explicit edge/corner resize delta (for frameless avatar/workbench handles). */
function applyResize(mode, startBounds, edge, dx, dy, display) {
  if (mode === "desktop" || !startBounds) return null;
  const lim = MODE_LIMITS[mode] || MODE_LIMITS.workbench;
  const d = normalizeDisplay(display);
  const maxW = Math.min(lim.maxW, d.width);
  const maxH = Math.min(lim.maxH, d.height);
  let { x, y, width, height } = startBounds;
  const deltaX = Math.round(Number(dx) || 0);
  const deltaY = Math.round(Number(dy) || 0);

  if (edge.includes("e")) {
    width = clampNum(width + deltaX, lim.minW, maxW, width);
  }
  if (edge.includes("s")) {
    height = clampNum(height + deltaY, lim.minH, maxH, height);
  }
  if (edge.includes("w")) {
    const nextW = clampNum(width - deltaX, lim.minW, maxW, width);
    x += width - nextW;
    width = nextW;
  }
  if (edge.includes("n")) {
    const nextH = clampNum(height - deltaY, lim.minH, maxH, height);
    y += height - nextH;
    height = nextH;
  }
  return clampBounds(mode, { x, y, width, height }, d);
}

function loadState(userDataDir, display) {
  if (!userDataDir) return createInitialState(display);
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(userDataDir, STATE_FILE), "utf8"));
    return normalizeState(raw, display);
  } catch {
    return createInitialState(display);
  }
}

function saveState(userDataDir, state) {
  if (!userDataDir) return false;
  try {
    fs.mkdirSync(userDataDir, { recursive: true });
    const tmp = path.join(userDataDir, `${STATE_FILE}.tmp`);
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2), "utf8");
    fs.renameSync(tmp, path.join(userDataDir, STATE_FILE));
    return true;
  } catch {
    return false;
  }
}

module.exports = {
  MODES,
  DEFAULT_HOME_URL,
  STATE_FILE,
  MODE_LIMITS,
  normalizeDisplay,
  defaultBoundsFor,
  clampBounds,
  createInitialState,
  normalizeState,
  transitionMode,
  beginDrag,
  stepDrag,
  applyResize,
  loadState,
  saveState,
};
