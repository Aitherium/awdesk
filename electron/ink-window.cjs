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
 *   Ctrl+Alt+K            ink stays, clicks go THROUGH to the apps underneath
 *                         (2026-11-07: "keep using apps under the ink"); the
 *                         toolbar still answers -- hovering it catches the mouse
 *
 * Save to board turns the marks into whiteboard items (ink-core inkToBoardItems ->
 * boards-window), so a sketch over a screen becomes an editable board. Snip with
 * ink leaves draw mode (the marks stay on screen) and opens the snipping tool, so
 * the region you cut carries the annotations.
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
const inkMode = require("./ink-mode.cjs");

function electron() {
  return configured.electron || require("electron");
}

let wired = false;
let configured = { saveImage: null, onSaved: null, boards: null, snip: null, cursor: null, electron: null, onChange: null };
/** The ONE mode machine's state (ink-mode.cjs): interact | draw | draw-held | pen. */
let modeState = inkMode.initial();
let lastSwitchAt = 0;
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
    win.showInactive();
    applyInteraction();
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
      screen.on(name, () => { try { if (windows.size) syncWindows(); } catch { /* next tick */ } });
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
  const v = inkMode.view(modeState);
  return {
    active: v.drawing,
    mode: v.mode,
    view: v,
    tool,
    color,
    width,
    fadeMs,
    // The palette is docked on the display the mode began on, and only while drawing.
    toolbar: v.palette && displayId === toolbarDisplayId,
    displayId,
    sentAt: Date.now(),
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
  try { if (configured.onChange) configured.onChange(status()); } catch { /* a tray refresh must not fail ink */ }
}

/**
 * Who gets the mouse, per overlay, from the ONE mode machine (ink-mode.cjs):
 *   all     every overlay takes the pointer (a drawing mode)
 *   object  only the overlay under the cursor, and only while it is on an ink
 *           object (interact + middle-drag)
 *   none    every overlay is click-through, forwarding moves
 * Only setIgnoreMouseEvents flips -- the windows are never recreated, so a switch
 * has no flicker and the next pointer event already lands.
 */
function applyInteraction() {
  const cap = inkMode.capture(modeState, Date.now());
  for (const [id, entry] of windows.entries()) {
    const win = entry.win;
    if (!win || win.isDestroyed()) continue;
    const take = cap === "all" || (cap === "object" && id === hoverDisplayId);
    try {
      if (take) {
        win.setIgnoreMouseEvents(false);
        if (cap === "all") win.setFocusable(true);
      } else {
        win.setIgnoreMouseEvents(true, { forward: true });
        win.setFocusable(false);
        if (win.isFocused()) win.blur();
      }
    } catch { /* the window was closing */ }
  }
  if (cap === "all" && inkMode.view(modeState).mode === "draw") {
    // Latched draw takes the keyboard too (Esc, Ctrl+Z). A HELD draw never steals
    // focus: the app under it keeps its caret, and releasing the chord is instant.
    const entry = entryFor(toolbarDisplayId);
    if (entry) {
      try { entry.win.showInactive(); entry.win.focus(); } catch { /* gone */ }
    }
  }
  syncHoverPoll();
}

/**
 * Feed one event to the mode machine and apply the result. Returns the status.
 * The marks are never touched here: clear and fade are separate actions.
 */
function dispatch(event) {
  const before = modeState.mode;
  modeState = inkMode.reduce(modeState, event);
  if (modeState.mode !== before) {
    lastSwitchAt = Date.now();
    if (inkMode.isDrawing(modeState) && before === "interact") {
      const here = displayUnderCursor();
      if (here) toolbarDisplayId = here.id;
    }
  }
  applyInteraction();
  broadcast();
  if (event && event.type === "wheel" && inkMode.isDrawing(modeState)) {
    // Let the wheel ticks reach the app for 350 ms, then take the pointer back.
    setTimeout(() => { applyInteraction(); }, 380).unref?.();
  }
  return status();
}

// ── interact: the overlay takes the mouse only over an ink object ───────────
//
// While interacting, the overlays are click-through. To let a middle-drag grab a
// stroke WITHOUT entering draw mode, main polls the cursor (~30 Hz, only while
// marks exist), asks overlay-hit.cjs whether it is near any ink object's box (the
// same region test the desktop overlay uses), then ink-core.topmostHit for the
// exact 6 px stroke distance. Only that overlay, only on the object, captures.

let hoverTimer = null;
let hoverDisplayId = null;

function anyMarks() {
  for (const id of docs.keys()) if (marksOn(id) > 0) return true;
  return false;
}

function syncHoverPoll() {
  const want = !inkMode.isDrawing(modeState) && windows.size > 0 && anyMarks();
  if (want && !hoverTimer) {
    hoverTimer = setInterval(pollHover, 33);
    if (hoverTimer.unref) hoverTimer.unref();
  } else if (!want && hoverTimer) {
    clearInterval(hoverTimer);
    hoverTimer = null;
    if (modeState.hover) { modeState = inkMode.reduce(modeState, { type: "hover", id: null }); hoverDisplayId = null; }
  }
}

/** The ink object at a screen point: {displayId, item} or null. Pure over `docs`. */
function objectAt(cursor) {
  const overlayHit = require("./overlay-hit.cjs");
  for (const [id, entry] of windows.entries()) {
    const b = entry.display.bounds;
    const items = docFor(id).items;
    if (!items.length) continue;
    const regions = items.map((item) => {
      const r = core.itemBounds(item) || { x: 0, y: 0, width: 0, height: 0 };
      return { x: r.x, y: r.y, w: r.width, h: r.height };
    });
    const verdict = overlayHit.hitVerdict({ now: 1, bounds: b, cursor, hit: { regions, dock: null, reportedAt: 1 } });
    if (!verdict.interactive) continue;
    const local = { x: cursor.x - b.x, y: cursor.y - b.y };
    const item = core.topmostHit(items, local, 6);
    if (item) return { displayId: id, item };
  }
  return null;
}

function pollHover() {
  if (modeState.grab) return; // a drag in progress owns the mouse until middle-up
  let cursor;
  try { cursor = configured.cursor ? configured.cursor() : electron().screen.getCursorScreenPoint(); } catch { return; }
  const found = objectAt(cursor);
  const id = found ? found.item.id : null;
  const was = modeState.hover ? modeState.hover.id : null;
  if (id === was && (found ? found.displayId : null) === hoverDisplayId) return;
  hoverDisplayId = found ? found.displayId : null;
  modeState = inkMode.reduce(modeState, { type: "hover", id, locked: false });
  applyInteraction();
  broadcast();
}

// ── hold-to-draw (Ctrl+Alt held) ─────────────────────────────────────────────

let holdWatch = null;

/** Start the chord watcher (ink-hold.cjs). Main calls this once; a probe never does. */
function startHoldToDraw(options = {}) {
  if (holdWatch) return holdWatch;
  holdWatch = require("./ink-hold.cjs").createHoldWatch({
    ...options,
    onHold: () => { ensureReady(); dispatch({ type: "hold-down" }); },
    onRelease: () => { dispatch({ type: "hold-up" }); },
  });
  return holdWatch;
}

/**
 * Any desk hotkey fired: a held Ctrl+Alt was the start of a chord (Ctrl+Alt+Q,
 * ...), not a request to draw. Ctrl+Alt+D itself latches (toggle from draw-held).
 */
function noteHotkey() {
  if (holdWatch) holdWatch.cancel();
}

function stopHoldToDraw() {
  if (holdWatch) { holdWatch.stop(); holdWatch = null; }
}

// ── modes ────────────────────────────────────────────────────────────────────

function ensureReady() {
  ensureInkIpc();
  wireScreenEvents();
  syncWindows();
}

/** Draw mode on (optionally with a tool). Idempotent; the marks stay. */
function enterDraw(options = {}) {
  ensureReady();
  if (typeof options.tool === "string" && core.TOOLS.includes(options.tool)) tool = options.tool;
  if (options.displayId != null) toolbarDisplayId = options.displayId;
  return dispatch({ type: "set", mode: "draw" });
}

/** Back to interacting: click-through, marks stay where they are. */
function exitDraw() {
  if (!inkMode.isDrawing(modeState) && windows.size === 0) return status();
  return dispatch({ type: "set", mode: "interact" });
}

/** Ctrl+Alt+D: draw <-> interact. Never clears anything. */
function toggleDraw() {
  ensureReady();
  return dispatch({ type: "toggle" });
}

/**
 * ink.passthrough (Ctrl+Alt+K): back to interacting with the ink left on screen
 * (or, when already interacting, into draw). Same machine as the toggle; kept as
 * its own key because "give me my desktop back" is the one owners reach for.
 */
function setPassThrough(on) {
  ensureReady();
  if (on === true) return dispatch({ type: "set", mode: "interact" });
  if (on === false) return dispatch({ type: "set", mode: "draw" });
  return dispatch({ type: "toggle" });
}

/** Ctrl+Alt+L / Ctrl+Alt+S: the tool toggles, the overlay stays click-through when off. */
function toggleTool(nextTool) {
  if (!core.TOOLS.includes(nextTool)) return status();
  if (inkMode.isDrawing(modeState) && tool === nextTool) return exitDraw();
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
  syncHoverPoll();
  return status();
}

function marksOn(displayId) {
  return docFor(displayId).items.length;
}

function status() {
  let marks = 0;
  for (const id of docs.keys()) marks += marksOn(id);
  const v = inkMode.view(modeState);
  return { active: v.drawing, mode: v.mode, label: inkMode.label(modeState), tool, color, width, fadeMs,
    displays: windows.size, marks, lastSwitchAt };
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

/** The display whose marks a board/snip acts on: the toolbar's, else the busiest. */
function targetDisplayId() {
  if (toolbarDisplayId != null && marksOn(toolbarDisplayId) > 0) return toolbarDisplayId;
  let best = null;
  let most = 0;
  for (const id of docs.keys()) {
    const n = marksOn(id);
    if (n > most) { most = n; best = id; }
  }
  return best;
}

function boardsApi() {
  if (configured.boards) return configured.boards;
  return require("./boards-window.cjs");
}

/**
 * Save to board: the marks become a NEW whiteboard of editable items (strokes,
 * shapes, text), opened at the cursor. The screen marks stay where they are --
 * "Clear" is a separate, undoable choice.
 */
function saveToBoard() {
  const id = targetDisplayId();
  if (id == null) return { ok: false, reason: "0 marks to save — draw something first" };
  const items = docFor(id).items;
  const converted = core.inkToBoardItems(items, { pad: 24, idPrefix: `ink${Date.now().toString(36)}` });
  if (!converted.items.length) return { ok: false, reason: "0 marks to save — draw something first" };
  const bcore = require("./boards-core.cjs");
  let point = { x: 0, y: 0 };
  let workArea = { x: 0, y: 0, width: 1920, height: 1080 };
  try {
    if (configured.cursor) {
      point = configured.cursor();
    } else {
      const { screen } = electron();
      point = screen.getCursorScreenPoint();
      workArea = screen.getDisplayNearestPoint(point).workArea;
    }
  } catch { /* a probe without a screen keeps the defaults */ }
  const size = {
    width: Math.min(Math.max(bcore.BOARD_SIZE.width, converted.size.width), workArea.width),
    height: Math.min(Math.max(bcore.BOARD_SIZE.height, converted.size.height + 48), workArea.height),
  };
  const now = new Date();
  const board = bcore.newBoard({
    kind: "board", date: now, title: `Ink ${bcore.stamp(now)}`, bounds: bcore.placeAt(point, size, workArea),
  });
  board.items = converted.items;
  try {
    const verdict = boardsApi().create("board", { restored: board });
    if (!verdict || !verdict.ok) return { ok: false, reason: (verdict && verdict.reason) || "the board did not open" };
    return { ok: true, boardId: board.id, items: converted.items.length };
  } catch (error) {
    return { ok: false, reason: String((error && error.message) || error).slice(0, 160) };
  }
}

/**
 * Snip with ink: leave draw mode (marks stay visible, overlays go click-through so
 * the snip overlay gets the mouse) and open the region snip. The snip grabs the
 * composited screen, so the cut carries the annotations.
 */
async function snipWithInk() {
  exitDraw();
  const snip = configured.snip || require("./snip-window.cjs");
  // Let the toolbar repaint away before the snip freezes the frame.
  await new Promise((resolve) => { const t = setTimeout(resolve, 120); if (t.unref) t.unref(); });
  try {
    const verdict = await snip.startSnip({ mode: "region" });
    return verdict || { ok: true };
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
    "ink:pass-through": (event, on) => {
      if (!senderEntry(event)) return null;
      return setPassThrough(on == null ? null : Boolean(on));
    },
    // The overlay's own mode events: Esc, right-click, a pen arriving, the mouse
    // moving under a pen, the wheel, and a middle press / release. Only these
    // types; everything else (toggle, hold) comes from main's own keys.
    "ink:mode": (event, raw) => {
      const found = senderEntry(event);
      if (!found || !raw || typeof raw !== "object") return null;
      const type = String(raw.type || "");
      if (!RENDERER_EVENTS.has(type)) return null;
      if (type === "middle-down") {
        const item = raw.id ? docFor(found.id).items.find((i) => i.id === String(raw.id)) : null;
        dispatch({ type, hit: item ? { id: item.id, locked: false } : null,
          shift: raw.shift === true, ctrl: raw.ctrl === true, meta: raw.meta === true });
        if (modeState.grab) hoverDisplayId = found.id;
        return publicState(found.id);
      }
      dispatch({ type, now: Date.now() });
      return publicState(found.id);
    },
    // A finished middle-drag: main applies it (ink-core translate / resize /
    // duplicate) as ONE undoable edit, then the grab ends.
    "ink:grab-end": (event, raw) => {
      const found = senderEntry(event);
      if (!found) return null;
      const result = commitGrab(found.id, raw);
      dispatch({ type: "middle-up" });
      return { ...publicState(found.id), result };
    },
    "ink:to-board": (event) => {
      if (!senderEntry(event)) return null;
      return saveToBoard();
    },
    "ink:snip": (event) => {
      if (!senderEntry(event)) return null;
      return snipWithInk();
    },
  };
}

const RENDERER_EVENTS = new Set(["escape", "right-click", "pen-enter", "pen-leave", "mouse", "wheel", "middle-down", "middle-up"]);

/**
 * Apply a finished middle-drag to the doc of one display.
 * raw = {dx, dy} in overlay pixels; the gesture and the item come from the grab
 * main recorded on middle-down (a renderer cannot name a different item here).
 */
function commitGrab(displayId, raw) {
  const grab = modeState.grab;
  if (!grab) return { ok: false, reason: "no grab in progress" };
  const doc = docFor(displayId);
  const item = doc.items.find((i) => i.id === grab.id);
  if (!item) return { ok: false, reason: "that mark is gone" };
  const dx = Number(raw && raw.dx) || 0;
  const dy = Number(raw && raw.dy) || 0;
  const from = core.itemBounds(item);
  const to = require("./middle-drag-load.cjs").middleDrag().dragBounds(grab.gesture, from, dx, dy);
  if (grab.gesture === "duplicate") {
    const copy = core.translateItem(core.duplicateItem(item, newItemId()), dx, dy);
    setDoc(displayId, core.pushItem(doc, copy));
    syncHoverPoll();
    return { ok: true, gesture: "duplicate", id: copy.id };
  }
  if (!dx && !dy) return { ok: true, gesture: grab.gesture, id: item.id, unchanged: true };
  const next = grab.gesture === "resize" ? core.resizeItem(item, from, to) : core.translateItem(item, dx, dy);
  setDoc(displayId, core.updateItems(doc, [next]));
  return { ok: true, gesture: grab.gesture, id: item.id };
}

function ensureInkIpc() {
  if (wired) return;
  wired = true;
  const { ipcMain } = electron();
  ipcMain.on("ink:chrome-done", (event) => settleChromeWaiter(event.sender));
  for (const [channel, fn] of Object.entries(handlers())) ipcMain.handle(channel, fn);
}

function closeInk() {
  modeState = inkMode.initial();
  if (hoverTimer) { clearInterval(hoverTimer); hoverTimer = null; }
  hoverDisplayId = null;
  for (const [, entry] of windows) {
    try { if (!entry.win.isDestroyed()) entry.win.destroy(); } catch { /* gone */ }
  }
  windows = new Map();
}

/** Test/probe seam: read the live state without touching Electron windows. */
function __state() {
  return {
    active: inkMode.isDrawing(modeState), mode: modeState.mode, grab: modeState.grab, hover: modeState.hover,
    capture: inkMode.capture(modeState, Date.now()), tool, color, width, fadeMs, toolbarDisplayId,
    windows: [...windows.keys()],
    docs: [...docs.entries()].map(([id, doc]) => ({
      id, items: doc.items.length, undo: doc.undo.length, redo: doc.redo.length,
    })),
  };
}

module.exports = {
  configureInk, ensureInkIpc, enterDraw, exitDraw, toggleDraw, toggleTool,
  setTool, setColor, setWidth, setFade, clearDrawings, saveDrawing, status,
  setPassThrough, saveToBoard, snipWithInk, dispatch, startHoldToDraw, stopHoldToDraw, noteHotkey, objectAt, commitGrab,
  closeInk, handlers, lastDrawingPath: () => lastDrawingPath, __state,
  __setDoc: setDoc, __doc: (displayId) => docs.get(displayId) || null,
  __pollHover: () => pollHover(),
  __senderOf: (displayId) => { const e = entryFor(displayId); return e ? e.win.webContents : null; },
};
