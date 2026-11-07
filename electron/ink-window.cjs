"use strict";

/**
 * ink-window.cjs -- the Electron half of the desk's screen-ink tool (owner:
 * "give us screen drawing tools and pens and stuff"; "record presentations on
 * the fly").
 *
 *   Ctrl+Alt+D            draw mode on/off      (toolbar on the display under the cursor)
 *   Ctrl+Alt+L            laser pointer         (fading trail, no marks)
 *   Ctrl+Alt+S            spotlight             (dim everything but a circle at the cursor)
 *   Ctrl+Alt+C            clear every mark on every display
 *
 * ONE transparent overlay per display, always-on-top at screen-saver level and
 * NOT content-protected -- so a recorder or a screenshot sees the ink. While
 * drawing is on, the overlays take the mouse; while it is off they are fully
 * click-through (`setIgnoreMouseEvents(true, {forward:true})`) and only the
 * drawings remain visible. Esc (in the overlay) leaves drawing mode and KEEPS
 * the marks; the fade option retires them on their own.
 *
 * Main is the source of truth for the mark list (`docs` per display id) so a
 * display re-created by a resolution change gets its drawings back, and "Clear"
 * from any surface means every display. Math and reducers live in ink-core.cjs;
 * the windows and their IPC live here, in the snip-window.cjs shape.
 *
 * Save shot: the toolbar hides, the display is grabbed through the snipping
 * tool's own GDI path (snip-window.nativeFrame -- the 4K screen desktopCapturer
 * cannot see), and the image goes through snip-window.saveImage so it lands in
 * ~/Pictures/Aither Screenshots, the clipboard, and the Strata upload queue.
 */

const path = require("node:path");
const core = require("./ink-core.cjs");

function electron() {
  return require("electron");
}

let wired = false;
let configured = { saveImage: null, onSaved: null };
let active = false;
let tool = "pen";
let color = core.COLORS[3];
let width = core.WIDTHS[1];
let fadeMs = 0;
let toolbarDisplayId = null;
/** display.id -> {win, display, boundsKey} */
let windows = new Map();
/** display.id -> {items, undo, redo} */
let docs = new Map();
let listenersWired = false;
let idSeq = 0;

/** The module's one moment of configuration (save can be injected by a probe). */
function configureInk(next = {}) {
  configured = { ...configured, ...next };
}

function docFor(displayId) {
  if (!docs.has(displayId)) docs.set(displayId, core.normalizeState());
  return docs.get(displayId);
}

function setDoc(displayId, state) {
  docs.set(displayId, core.normalizeState(state));
}

function newItemId() {
  idSeq += 1;
  try {
    return `m${require("node:crypto").randomUUID().slice(0, 8)}${idSeq}`;
  } catch {
    return `m${Date.now().toString(36)}${idSeq}`;
  }
}

function displayUnderCursor() {
  try {
    const { screen } = electron();
    return screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  } catch {
    return null;
  }
}

function boundsKey(display) {
  const b = display.bounds;
  return `${b.x},${b.y},${b.width},${b.height}`;
}

// ── windows ──────────────────────────────────────────────────────────────────

function createOverlay(display) {
  const { BrowserWindow } = electron();
  const { bounds } = display;
  const win = new BrowserWindow({
    x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height,
    frame: false, transparent: true, resizable: false, movable: false,
    minimizable: false, maximizable: false, fullscreenable: false,
    skipTaskbar: true, hasShadow: false, enableLargerThanScreen: true, show: false,
    focusable: false,
    webPreferences: {
      preload: path.join(__dirname, "ink-preload.cjs"),
      contextIsolation: true, nodeIntegration: false, sandbox: true,
      backgroundThrottling: false,
    },
  });
  win.setAlwaysOnTop(true, "screen-saver");
  win.setBounds(bounds);
  win.setIgnoreMouseEvents(true, { forward: true });
  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  win.webContents.on("will-navigate", (event) => event.preventDefault());
  win.once("ready-to-show", () => {
    if (active) {
      win.setIgnoreMouseEvents(false);
      win.setFocusable(true);
      win.showInactive();
      if (display.id === toolbarDisplayId) win.focus();
    } else {
      win.showInactive();
    }
  });
  win.on("closed", () => {
    const entry = windows.get(display.id);
    if (entry && entry.win === win) windows.delete(display.id);
  });
  void win.loadFile(path.join(__dirname, "ink.html"));
  windows.set(display.id, { win, display, boundsKey: boundsKey(display) });
}

/** One overlay per display, refreshed when a display is added, removed or resized. */
function syncWindows() {
  const { screen } = electron();
  const displays = screen.getAllDisplays();
  const seen = new Set(displays.map((d) => d.id));
  for (const [id, entry] of [...windows.entries()]) {
    const display = displays.find((d) => d.id === id);
    if (!display || !seen.has(id)) {
      try { if (!entry.win.isDestroyed()) entry.win.destroy(); } catch { /* gone */ }
      windows.delete(id);
      continue;
    }
    if (entry.boundsKey !== boundsKey(display)) {
      // A resolution change moves the coordinate space; rebuild so the canvas
      // matches. The marks live in `docs`, so they come back on the new window.
      try { if (!entry.win.isDestroyed()) entry.win.destroy(); } catch { /* gone */ }
      windows.delete(id);
    }
  }
  for (const display of displays) if (!windows.has(display.id)) createOverlay(display);
  if (toolbarDisplayId != null && !windows.has(toolbarDisplayId)) {
    const here = displayUnderCursor();
    toolbarDisplayId = here ? here.id : displays[0] ? displays[0].id : null;
  }
}

function wireScreenEvents() {
  if (listenersWired) return;
  listenersWired = true;
  try {
    const { screen } = electron();
    for (const name of ["display-added", "display-removed", "display-metrics-changed"]) {
      screen.on(name, () => { try { if (active || windows.size) syncWindows(); } catch { /* next tick */ } });
    }
  } catch { /* no screen in a probe before ready */ }
}

function entryFor(displayId) {
  const entry = windows.get(displayId);
  if (!entry || entry.win.isDestroyed()) return null;
  return entry;
}

function senderEntry(event) {
  for (const [id, entry] of windows.entries()) {
    if (!entry.win.isDestroyed() && entry.win.webContents === event.sender) return { id, entry };
  }
  return null;
}

function send(entry, channel, payload) {
  try {
    if (entry && !entry.win.isDestroyed()) entry.win.webContents.send(channel, payload);
  } catch { /* the window died between the check and the send */ }
}

function publicState(displayId) {
  return {
    active,
    tool,
    color,
    width,
    fadeMs,
    toolbar: active && displayId === toolbarDisplayId,
    displayId,
    items: docFor(displayId).items,
  };
}

/** Push the current state to one display (default: all). */
function broadcast(displayId) {
  if (displayId != null) {
    const entry = entryFor(displayId);
    if (entry) send(entry, "ink:state", publicState(displayId));
    return;
  }
  for (const id of windows.keys()) {
    const entry = entryFor(id);
    if (entry) send(entry, "ink:state", publicState(id));
  }
}

function applyInteraction() {
  for (const entry of windows.values()) {
    const win = entry.win;
    if (!win || win.isDestroyed()) continue;
    try {
      if (active) {
        win.setIgnoreMouseEvents(false);
        win.setFocusable(true);
      } else {
        win.setIgnoreMouseEvents(true, { forward: true });
        win.setFocusable(false);
        if (win.isFocused()) win.blur();
      }
    } catch { /* the window was closing */ }
  }
  if (active) {
    const entry = entryFor(toolbarDisplayId);
    if (entry) {
      try { entry.win.showInactive(); entry.win.focus(); } catch { /* gone */ }
    }
  }
}

// ── modes ────────────────────────────────────────────────────────────────────

function ensureReady() {
  ensureInkIpc();
  wireScreenEvents();
  syncWindows();
}

/** Draw mode on (optionally with a tool). Idempotent. */
function enterDraw(options = {}) {
  ensureReady();
  if (typeof options.tool === "string" && core.TOOLS.includes(options.tool)) tool = options.tool;
  const here = displayUnderCursor();
  toolbarDisplayId = options.displayId != null ? options.displayId : here ? here.id : toolbarDisplayId;
  active = true;
  applyInteraction();
  broadcast();
  return status();
}

/** Draw mode off: fully click-through, marks stay where they are. */
function exitDraw() {
  if (!active && windows.size === 0) return status();
  active = false;
  applyInteraction();
  broadcast();
  return status();
}

function toggleDraw() {
  return active ? exitDraw() : enterDraw();
}

/** Ctrl+Alt+L / Ctrl+Alt+S: the tool toggles, the overlay stays click-through when off. */
function toggleTool(nextTool) {
  if (!core.TOOLS.includes(nextTool)) return status();
  if (active && tool === nextTool) return exitDraw();
  return enterDraw({ tool: nextTool });
}

function setTool(nextTool) {
  if (!core.TOOLS.includes(nextTool)) return status();
  tool = nextTool;
  broadcast();
  return status();
}

function setColor(nextColor) {
  if (!core.COLORS.includes(nextColor)) return status();
  color = nextColor;
  broadcast();
  return status();
}

function setWidth(nextWidth) {
  const w = Number(nextWidth);
  if (!Number.isFinite(w)) return status();
  width = Math.max(1, Math.min(24, w));
  broadcast();
  return status();
}

/** 0 = keep until cleared; otherwise marks fade over that many ms. */
function setFade(nextFade) {
  const ms = Number(nextFade);
  fadeMs = Number.isFinite(ms) && ms > 0 ? Math.max(1000, ms) : 0;
  broadcast();
  return status();
}

/**
 * Ctrl+Alt+C: every mark on every display, as ONE undoable step per display
 * (core.clearAll records a "clear" op), so a stray press is recoverable with
 * the toolbar's Undo instead of wiping the presentation.
 */
function clearDrawings() {
  for (const [id, doc] of [...docs.entries()]) docs.set(id, core.clearAll(doc));
  broadcast();
  return status();
}

function marksOn(displayId) {
  return docFor(displayId).items.length;
}

function status() {
  let marks = 0;
  for (const id of docs.keys()) marks += marksOn(id);
  return { active, tool, color, width, fadeMs, displays: windows.size, marks };
}

/** The last saved drawing's path (main-process callers only). */
let lastDrawingPath = null;

function defaultSaveImage() {
  return require("./snip-window.cjs").saveImage;
}

/** Overlays that have been asked to hide their chrome, waiting for the ack. */
let chromeWaiters = [];

function settleChromeWaiter(sender) {
  for (let i = 0; i < chromeWaiters.length; i += 1) {
    if (chromeWaiters[i].sender === sender) {
      const [waiter] = chromeWaiters.splice(i, 1);
      waiter.resolve(true);
      return;
    }
  }
}

/**
 * Wait for one overlay to confirm it painted a chrome change (the page answers
 * ink:chrome-done after two animation frames). The bound keeps a destroyed or
 * stuck renderer from hanging the save.
 */
function waitForChrome(entry, ms = 600) {
  return new Promise((resolve) => {
    if (!entry || !entry.win || entry.win.isDestroyed()) { resolve(false); return; }
    const waiter = { sender: entry.win.webContents, resolve };
    chromeWaiters.push(waiter);
    setTimeout(() => {
      const i = chromeWaiters.indexOf(waiter);
      if (i >= 0) { chromeWaiters.splice(i, 1); resolve(false); }
    }, ms);
  });
}

/**
 * Save what the display looks like WITH the ink, through the snipping tool's
 * path so it reaches the clipboard and the Strata queue like any screenshot.
 * The whole chrome layer (toolbar, hint banner, spotlight dim) hides for the
 * grab and comes straight back.
 */
async function saveDrawing() {
  if (!windows.size) return { ok: false, reason: "drawing mode has never been opened" };
  const targetId = toolbarDisplayId != null && windows.has(toolbarDisplayId)
    ? toolbarDisplayId : [...windows.keys()][0];
  const entry = entryFor(targetId);
  if (!entry) return { ok: false, reason: "the display went away" };
  let save = configured.saveImage;
  if (!save) {
    try { save = defaultSaveImage(); } catch { save = null; }
  }
  if (typeof save !== "function") return { ok: false, reason: "the screenshot saver is unavailable" };
  const painted = waitForChrome(entry);
  send(entry, "ink:chrome", false);
  await painted;
  let image = null;
  try {
    const snip = require("./snip-window.cjs");
    image = await snip.nativeFrame(entry.display);
  } catch { /* image stays null -> the caller gets a reason */ } finally {
    send(entry, "ink:chrome", true);
  }
  if (!image || image.isEmpty()) {
    return { ok: false, reason: "this display could not be captured (screen-recording access?)" };
  }
  try {
    const verdict = await save(image);
    if (verdict && verdict.ok && verdict.path) {
      lastDrawingPath = verdict.path;
      try { if (configured.onSaved) configured.onSaved(verdict); } catch { /* speak is optional */ }
    }
    return verdict || { ok: false, reason: "the screenshot saver returned nothing" };
  } catch (error) {
    return { ok: false, reason: String((error && error.message) || error).slice(0, 160) };
  }
}

// ── IPC ──────────────────────────────────────────────────────────────────────

function handlers() {
  return {
    "ink:init": (event) => {
      const found = senderEntry(event);
      return publicState(found ? found.id : null);
    },
    "ink:add": (event, raw) => {
      const found = senderEntry(event);
      if (!found) return null;
      const item = core.normalizeItem(raw, { fallbackId: newItemId() });
      if (!item) return publicState(found.id);
      setDoc(found.id, core.pushItem(docFor(found.id), item));
      broadcast();
      return publicState(found.id);
    },
    "ink:erase": (event, point) => {
      const found = senderEntry(event);
      if (!found || !point) return null;
      const radius = Number.isFinite(Number(point.radius)) ? Number(point.radius) : 10;
      const next = core.eraseAt(docFor(found.id), { x: Number(point.x), y: Number(point.y) }, radius);
      if (next.removed.length) {
        setDoc(found.id, next.state);
        broadcast();
      }
      return publicState(found.id);
    },
    "ink:prune": (event, ids) => {
      const found = senderEntry(event);
      if (!found || !Array.isArray(ids) || !ids.length) return null;
      const gone = new Set(ids.map(String));
      const doc = docFor(found.id);
      // A fade is not an edit: pruning must not land in the undo history.
      const next = { ...doc, items: doc.items.filter((item) => !gone.has(item.id)) };
      if (next.items.length !== doc.items.length) {
        setDoc(found.id, next);
        broadcast();
      }
      return publicState(found.id);
    },
    "ink:undo": (event) => {
      const found = senderEntry(event);
      if (!found) return null;
      setDoc(found.id, core.undo(docFor(found.id)));
      broadcast();
      return publicState(found.id);
    },
    "ink:redo": (event) => {
      const found = senderEntry(event);
      if (!found) return null;
      setDoc(found.id, core.redo(docFor(found.id)));
      broadcast();
      return publicState(found.id);
    },
    // Everything below mutates the whole desk (clear, leave, capture a display,
    // change the pen): only an overlay that this module created may ask.
    "ink:clear": (event) => {
      if (!senderEntry(event)) return null;
      clearDrawings();
      return status();
    },
    "ink:exit": (event) => {
      if (!senderEntry(event)) return null;
      return exitDraw();
    },
    "ink:save": (event) => {
      if (!senderEntry(event)) return null;
      return saveDrawing();
    },
    "ink:set-tool": (event, nextTool) => {
      if (!senderEntry(event)) return null;
      return setTool(String(nextTool || ""));
    },
    "ink:set-color": (event, nextColor) => {
      if (!senderEntry(event)) return null;
      return setColor(String(nextColor || ""));
    },
    "ink:set-width": (event, nextWidth) => {
      if (!senderEntry(event)) return null;
      return setWidth(nextWidth);
    },
    "ink:set-fade": (event, nextFade) => {
      if (!senderEntry(event)) return null;
      return setFade(nextFade);
    },
  };
}

function ensureInkIpc() {
  if (wired) return;
  wired = true;
  const { ipcMain } = electron();
  ipcMain.on("ink:chrome-done", (event) => settleChromeWaiter(event.sender));
  for (const [channel, fn] of Object.entries(handlers())) ipcMain.handle(channel, fn);
}

function closeInk() {
  active = false;
  for (const [, entry] of windows) {
    try { if (!entry.win.isDestroyed()) entry.win.destroy(); } catch { /* gone */ }
  }
  windows = new Map();
}

/** Test/probe seam: read the live state without touching Electron windows. */
function __state() {
  return {
    active, tool, color, width, fadeMs, toolbarDisplayId,
    windows: [...windows.keys()],
    docs: [...docs.entries()].map(([id, doc]) => ({
      id, items: doc.items.length, undo: doc.undo.length, redo: doc.redo.length,
    })),
  };
}

module.exports = {
  configureInk, ensureInkIpc, enterDraw, exitDraw, toggleDraw, toggleTool,
  setTool, setColor, setWidth, setFade, clearDrawings, saveDrawing, status,
  closeInk, handlers, lastDrawingPath: () => lastDrawingPath, __state,
  __setDoc: setDoc, __doc: (displayId) => docs.get(displayId) || null,
};
