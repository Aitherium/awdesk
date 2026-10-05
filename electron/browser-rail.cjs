"use strict";

/**
 * browser-rail.cjs -- the Aither Browser's left rail: the avatar docked at the top,
 * every Aither page under it, and the layer strip at the bottom.
 *
 * Owner, 2026-10-04: "it doesn't have all the proper ways to navigate to the various
 * pages that we collapsed from the Aither Console into this ... the awdesk avatar
 * should be attached to the Aither Browser and the browser just forms around it like
 * a shell, and then AitherDesktop forms around that dynamically ... multiple layers:
 * awsh -> awdesk/avatar -> browser -> AitherOS Online overlay".
 *
 * Until then the aither:// pages were reachable only by typing the scheme into the
 * address bar or from the three pinned tabs; the console's rail had been deleted with
 * the console. This module is that rail again, generic over console-window.cjs PANES
 * (a pane added there appears here with no edit) plus the OS apps the command
 * registry already declares.
 *
 * Pure (no electron at module load): every rectangle and row is asserted under
 * `node --test`. browser-window.cjs lays the views out from railLayout(), and main
 * docks the avatar window onto avatarSlotRect().
 */

/** Section order, top to bottom. A section not named here follows in PANES order. */
const SECTION_ORDER = Object.freeze(["Now", "Agents", "Stage", "Apps", "Data", "System", "Planes", "Online"]);
const RAIL_WIDTH = 248;
const RAIL_COLLAPSED_WIDTH = 56;
/** Drag limits (owner, 2026-10-04: "side bars need to be draggable/customizable"). */
const RAIL_MIN = 180;
const RAIL_MAX = 420;
const PANEL_MIN = 260;
const PANEL_MAX = 640;
/** The grab strip between rail|page and page|panel: the chrome page draws the handle there. */
const GUTTER = 6;
/** The living desktop's taskbar along the bottom (Veil's <Taskbar/>, EDGE_ROOT h-14). */
const TASKBAR_HEIGHT = 56;
/** The brand row: the Aither button that opens THE menu (the tray's), and the collapse toggle. */
const BRAND_HEIGHT = 44;
/** The avatar's slot, portrait like the floating window's default (430 x 680). */
const AVATAR_SLOT_HEIGHT = 360;
/** The layer strip at the bottom: awsh, Avatar, Browser, Online. */
const LAYERS_HEIGHT = 92;

/**
 * Commands the rail may run, by registry id. The rail is a page: it sends an id
 * back, and main refuses any id not on this list (the same fence the bead rail has).
 */
const RAIL_COMMANDS = Object.freeze([
  "osapp.family", "osapp.learn", "osapp.sprite", "osapp.academy", "osapp.spaces",
  "avatar.dock", "desktop.overlay.toggle",
]);

/** The OS apps (they open inside AitherOS Online, never as new installables). */
const APP_ROWS = Object.freeze([
  Object.freeze({ command: "osapp.family", label: "Family", hint: "The household, devices and kids", icon: "home" }),
  Object.freeze({ command: "osapp.learn", label: "Learn", hint: "Lessons and the tutor", icon: "book" }),
  Object.freeze({ command: "osapp.sprite", label: "Sprite", hint: "Make and animate sprites", icon: "image" }),
  Object.freeze({ command: "osapp.academy", label: "Academy", hint: "Courses and classes", icon: "book" }),
  Object.freeze({ command: "osapp.spaces", label: "Spaces", hint: "Shared spaces and boards", icon: "grid" }),
]);

/**
 * The layers, innermost first. Each row says what it is and the ONE thing a click
 * does, so the stack the owner described is visible instead of implied.
 */
const LAYERS = Object.freeze([
  Object.freeze({ key: "shell", label: "awsh", hint: "The shell: terminal tabs, Claude Code, Aither, Codex", page: "terminal" }),
  Object.freeze({ key: "avatar", label: "Avatar", hint: "Dock it here, or float it on the desktop", command: "avatar.dock" }),
  Object.freeze({ key: "browser", label: "Browser", hint: "This window: pages, tabs, the agent panel" }),
  Object.freeze({ key: "online", label: "Online", hint: "AitherOS Online around everything", command: "desktop.overlay.toggle" }),
]);

/**
 * Every rail row, grouped. A row is either a PAGE (opens aither://<id>) or a
 * COMMAND (an id from RAIL_COMMANDS). Panes that live as a tab of another pane
 * (`tabOf`) stay rows: the console hid them behind a tab, and that is exactly
 * the "where is it" the owner hit.
 *
 * @param {Array<object>} panes console-window.cjs PANES
 * @param {{activePane?: string|null}} [opts]
 */
function railSections(panes, { activePane = null } = {}) {
  const groups = new Map();
  const add = (name, row) => {
    if (!groups.has(name)) groups.set(name, []);
    groups.get(name).push(row);
  };
  for (const pane of panes || []) {
    if (!pane || typeof pane.id !== "string") continue;
    add(pane.section || "More", {
      kind: "page", id: pane.id, label: pane.label || pane.id, hint: pane.hint || "",
      icon: pane.icon || null, active: pane.id === activePane,
    });
  }
  for (const app of APP_ROWS) {
    add("Apps", { kind: "command", id: app.command, label: app.label, hint: app.hint, icon: app.icon, active: false });
  }
  const names = [...groups.keys()];
  const ordered = [...SECTION_ORDER.filter((n) => groups.has(n)), ...names.filter((n) => !SECTION_ORDER.includes(n))];
  return ordered.map((name) => ({ name, rows: groups.get(name) }));
}

/** May the rail run this command id? */
/**
 * Is what the owner typed into the address bar a SEARCH rather than an address? Words
 * with a space, or one word with no dot, no scheme and no port. "localhost:3000",
 * "example.com" and "aither://x" are addresses.
 */
function isSearchText(text) {
  const t = String(text || "").trim();
  if (!t || t.length > 500) return false;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(t)) return false;
  if (/\s/.test(t)) return true;
  return !/[.:/]/.test(t);
}

function railMayRun(id) {
  return RAIL_COMMANDS.includes(String(id || ""));
}

/** The layer strip's rows with live state. */
function layerRows({ docked = false, overlayVisible = false, browserOpen = true } = {}) {
  return LAYERS.map((layer) => ({
    ...layer,
    on: layer.key === "avatar" ? Boolean(docked)
      : layer.key === "online" ? Boolean(overlayVisible)
        : layer.key === "browser" ? Boolean(browserOpen) : true,
    state: layer.key === "avatar" ? (docked ? "docked" : "floating")
      : layer.key === "online" ? (overlayVisible ? "around you" : "off")
        : layer.key === "browser" ? "here" : "ready",
  }));
}

function clamp(value, min, max, fallback) {
  if (value == null || value === "") return fallback;
  const n = Number(value);
  return Number.isFinite(n) ? Math.round(Math.min(max, Math.max(min, n))) : fallback;
}

/**
 * The owner's layout, sanitized: what browser-layout.json may hold. Anything
 * unknown or out of range falls back, so a hand-edited file cannot wedge the window.
 */
function normalizeLayout(raw = {}) {
  const r = raw && typeof raw === "object" ? raw : {};
  return {
    railWidth: clamp(r.railWidth, RAIL_MIN, RAIL_MAX, RAIL_WIDTH),
    panelWidth: clamp(r.panelWidth, PANEL_MIN, PANEL_MAX, 340),
    railCollapsed: Boolean(r.railCollapsed),
    panelCollapsed: Boolean(r.panelCollapsed),
    taskbar: r.taskbar !== false,
    collapsedSections: Array.isArray(r.collapsedSections)
      ? [...new Set(r.collapsedSections.filter((n) => typeof n === "string" && n.length <= 40))].slice(0, 20) : [],
  };
}

function railWidth(collapsed, width = RAIL_WIDTH) {
  return collapsed ? RAIL_COLLAPSED_WIDTH : clamp(width, RAIL_MIN, RAIL_MAX, RAIL_WIDTH);
}

/**
 * Where every view goes inside the window's content area.
 *
 *   rail | gutter | page | gutter | panel     (top: chrome, bottom: taskbar)
 *
 * The gutters are the chrome page's own pixels: the drag handles live there.
 *
 * @param {{width: number, height: number}} content the window's content size
 */
function railLayout(content, { collapsed = false, docked = false, chromeHeight, panelWidth = 340,
  railWidth: wantRail = RAIL_WIDTH, panelCollapsed = false, taskbarHeight = 0 }) {
  const width = Math.max(0, Math.floor(content.width || 0));
  const height = Math.max(0, Math.floor(content.height || 0));
  const railW = Math.min(railWidth(collapsed, wantRail), width);
  const rest = Math.max(0, width - railW - GUTTER);
  const panelW = panelCollapsed ? 0 : Math.min(clamp(panelWidth, PANEL_MIN, PANEL_MAX, 340), Math.floor(rest / 2));
  const taskH = Math.min(Math.max(0, taskbarHeight), Math.max(0, height - chromeHeight));
  const bodyH = Math.max(0, height - chromeHeight - taskH);
  const pageX = railW + GUTTER;
  const pageW = Math.max(0, width - pageX - (panelW ? panelW + GUTTER : 0));
  return {
    rail: { x: 0, y: 0, width: railW, height: height - taskH },
    page: { x: pageX, y: chromeHeight, width: pageW, height: bodyH },
    panel: { x: width - panelW, y: chromeHeight, width: panelW, height: bodyH },
    taskbar: { x: 0, y: height - taskH, width, height: taskH },
    avatar: avatarSlot({ width, height: height - taskH }, { collapsed, docked, railWidth: railW }),
  };
}

/**
 * The avatar slot inside the content area, or null when there is none: the rail is
 * collapsed (56 px cannot hold a body) or the avatar is floating. Portrait, as wide
 * as the rail. The slot never eats the layer strip: on a short window it shrinks,
 * and below 160 px it is gone.
 */
function avatarSlot(content, { collapsed = false, docked = false, railWidth: w = RAIL_WIDTH } = {}) {
  if (collapsed || !docked) return null;
  const room = Math.floor((content.height || 0) - BRAND_HEIGHT - LAYERS_HEIGHT - 120);
  const width = railWidth(false, w);
  const height = Math.min(Math.round(width * (AVATAR_SLOT_HEIGHT / RAIL_WIDTH)), room);
  if (height < 160) return null;
  return { x: 0, y: BRAND_HEIGHT, width, height };
}

/**
 * The slot in SCREEN coordinates, for main to put the avatar window on. `contentBounds`
 * is BrowserWindow#getContentBounds() (DIP, screen space), so this is one offset.
 */
function avatarSlotRect(contentBounds, opts) {
  if (!contentBounds) return null;
  const slot = avatarSlot(contentBounds, opts);
  if (!slot) return null;
  return {
    x: Math.round(contentBounds.x + slot.x),
    y: Math.round(contentBounds.y + slot.y),
    width: slot.width,
    height: slot.height,
  };
}

module.exports = {
  GUTTER,
  PANEL_MAX,
  PANEL_MIN,
  RAIL_MAX,
  RAIL_MIN,
  TASKBAR_HEIGHT,
  normalizeLayout,
  APP_ROWS,
  AVATAR_SLOT_HEIGHT,
  BRAND_HEIGHT,
  LAYERS,
  LAYERS_HEIGHT,
  RAIL_COLLAPSED_WIDTH,
  RAIL_COMMANDS,
  RAIL_WIDTH,
  SECTION_ORDER,
  avatarSlot,
  avatarSlotRect,
  layerRows,
  railLayout,
  railMayRun,
  isSearchText,
  railSections,
  railWidth,
};
