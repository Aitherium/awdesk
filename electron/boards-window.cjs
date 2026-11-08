"use strict";

/**
 * boards-window.cjs -- main's half of the desk's sticky notes and whiteboards
 * (owner 2026-11-02: "spawn a virtual clipboard/whiteboard anywhere and then put it
 * away when you're done just like the rest of aitheros online/awdesk taskbar").
 *
 * Model and naming live in boards-core.cjs; this module owns the BrowserWindows,
 * the clipboard read, the save path and the "Boards" list:
 *
 *   note.new / Ctrl+Alt+N      a small markdown sticky note, opened AT the cursor
 *   board.new / Ctrl+Alt+B     a whiteboard: pen, shapes, text, sticky notes,
 *                              Ctrl+V paste, drag-in images, export PNG
 *   Put away / Esc-hold        hides the window and keeps it in the Boards list
 *                              (the tray submenu and "Boards…"), one click restores
 *                              it at the cursor -- the taskbar contract
 *   × / close                  closes the board for good (open=false)
 *
 * Persistence: <writable boards dir>/<id>.json is the source of truth, <id>.png a
 * thumbnail. The folder comes from snip-capture's writableDir (NEVER a recursive
 * mkdirSync into Documents/Pictures/Videos: Controlled Folder Access loops forever
 * there). Open+visible boards reopen on the next desk start.
 *
 * Sync: each saved board PNG and each note's markdown go through the desk's ONE
 * strata-sync queue into the existing `files` folder (strata-sync.cjs). Nothing
 * here invents a Strata folder, and a sync failure never blocks a save.
 *
 * Every IPC handler checks the sender belongs to ITS window (the snip/recorder
 * contract). Fail-soft: {ok:false, reason}, never throws at a caller.
 */

const fs = require("node:fs");
const path = require("node:path");
const core = require("./boards-core.cjs");

let electronImpl = null;
function electron() {
  if (!electronImpl) electronImpl = require("electron");
  return electronImpl;
}

/** Injected by a probe; production leaves it null and the real queue is used. */
let enqueueOverride = null;
let changeHook = () => {};
let wired = false;
let boardsDir = null;
let quitting = false;

/** id -> {board, win, lastThumbAt, lastSyncAt, moveTimer} */
const entries = new Map();

function safeAppPath(name) {
  try { return electron().app.getPath(name); } catch { return null; }
}

/**
 * ~/Aither Boards, through snip-capture's writableDir. Null means no writable
 * folder (captured in a reason, never thrown); the windows still work, unsaved.
 */
function resolveDir() {
  if (boardsDir) return boardsDir;
  const candidates = core.dirCandidates({ homeDir: safeAppPath("home") });
  try {
    const verdict = require("./snip-capture.cjs").writableDir(candidates);
    if (verdict && verdict.ok) boardsDir = verdict.dir;
  } catch { /* no writable verdict: save is disabled with a reason */ }
  return boardsDir;
}

function setEnqueue(fn) {
  enqueueOverride = typeof fn === "function" ? fn : null;
}

/** Test/probe seam: point saves at a temp folder instead of ~/Aither Boards. */
function setBoardsDir(next) {
  boardsDir = next ? String(next) : null;
  return boardsDir;
}

function setChangeHook(fn) {
  changeHook = typeof fn === "function" ? fn : () => {};
}

function notifyChange() {
  try { changeHook(); } catch { /* a tray refresh must not fail a board */ }
  notifyContent();
}

/**
 * Listeners on board CONTENT (aither://canvas, browser-canvas.cjs): told the id of a
 * board that changed, from its window or from the canvas, so both views of the one
 * document stay current. Separate from changeHook, which rebuilds the tray.
 */
const contentListeners = new Set();
function onBoardsChanged(fn) {
  if (typeof fn !== "function") return () => {};
  contentListeners.add(fn);
  return () => contentListeners.delete(fn);
}
function notifyContent(id = null) {
  for (const fn of contentListeners) {
    try { fn(id); } catch { /* one listener never blocks another */ }
  }
}

function enqueueUpload(item) {
  try {
    if (enqueueOverride) return enqueueOverride(item);
    return require("./snip-window.cjs").enqueueUpload(item);
  } catch {
    return { ok: false, reason: "the sync queue is not running" };
  }
}

/** Read the persisted boards in `folder`; a torn file is skipped, never fatal. */
function loadBoards(folder, fsImpl = fs) {
  const out = [];
  if (!folder) return out;
  let names;
  try { names = fsImpl.readdirSync(folder); } catch { return out; }
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    try {
      const board = core.normalizeBoard(JSON.parse(fsImpl.readFileSync(path.join(folder, name), "utf8")));
      if (board) out.push(board);
    } catch { /* a torn file is not a board */ }
  }
  return out;
}

function persist(board) {
  const folder = resolveDir();
  if (!folder) return { ok: false, reason: "no writable boards folder" };
  try {
    const file = core.boardFile(folder, board.id);
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, core.boardJson(board));
    fs.renameSync(tmp, file);
    return { ok: true, path: file };
  } catch (error) {
    return { ok: false, reason: String((error && error.message) || error).slice(0, 200) };
  }
}

function existingBoards() {
  return [...entries.values()].map((entry) => entry.board);
}

function uniqueTitleFor(kind, date) {
  return core.uniqueTitle(core.titleFor(kind, date), [...existingBoards(), ...loadBoards(resolveDir())]);
}

// ── window creation ─────────────────────────────────────────────────────────

function windowFor(board) {
  const { BrowserWindow, screen } = electron();
  const point = screen.getCursorScreenPoint();
  const display = screen.getDisplayNearestPoint(point);
  const restored = core.usableBounds(board.bounds, screen.getAllDisplays());
  const bounds = restored || core.placeAt(point, core.defaultSize(board.kind), display.workArea);
  board.bounds = { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height };
  const win = new BrowserWindow({
    ...bounds, show: false, frame: false, resizable: true, alwaysOnTop: true, skipTaskbar: false,
    minWidth: core.MIN_WIDTH, minHeight: core.MIN_HEIGHT, backgroundColor: "#14171c",
    title: board.title,
    webPreferences: {
      preload: path.join(__dirname, "board-preload.cjs"),
      contextIsolation: true, nodeIntegration: false, sandbox: true,
    },
  });
  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  win.webContents.on("will-navigate", (event) => event.preventDefault());
  win.once("ready-to-show", () => { if (!win.isDestroyed()) win.show(); });
  win.on("moved", () => queueBoundsSave(board, win));
  win.on("resized", () => queueBoundsSave(board, win));
  win.on("closed", () => {
    // The CURRENT document, not `board`: every save replaces entry.board (applySave
    // returns a new object), so the creation-time object here is stale -- persisting
    // it wrote the board back as it was when the window opened (its later drawing,
    // pins and pan lost on close; caught by the windowView smoke, 2026-11-07).
    const current = (entries.get(board.id) || {}).board || board;
    entries.delete(board.id);
    if (quitting) return; // a restart must find the board open
    current.open = false;
    current.visible = false;
    persist(current);
    notifyChange();
  });
  void win.loadFile(path.join(__dirname, "board.html"), { query: { kind: board.kind, id: board.id } });
  return win;
}

function queueBoundsSave(board, win) {
  const entry = entries.get(board.id);
  if (!entry) return;
  if (entry.moveTimer) clearTimeout(entry.moveTimer);
  entry.moveTimer = setTimeout(() => {
    if (!win.isDestroyed()) {
      const b = win.getBounds();
      // The current document (see the closed handler): never a stale copy.
      const current = entry.board;
      current.bounds = { x: b.x, y: b.y, width: b.width, height: b.height };
      persist(current);
    }
  }, 300);
  if (entry.moveTimer.unref) entry.moveTimer.unref();
}

/** Open a NEW note/board (or focus an existing one). `at` is a screen point. */
function create(kind, { at, restored = null } = {}) {
  const k = kind === "note" ? "note" : "board";
  if (restored) {
    const board = core.normalizeBoard(restored);
    if (!board) return { ok: false, reason: "that board file is not readable" };
    const known = entries.get(board.id);
    if (known) { show(known.board.id); return { ok: true, board: known.board, focused: true }; }
    const win = windowFor(board);
    entries.set(board.id, { board, win, lastThumbAt: 0, lastSyncAt: 0, moveTimer: null });
    persist(board);
    notifyChange();
    return { ok: true, board };
  }
  const now = new Date();
  const point = at || electron().screen.getCursorScreenPoint();
  const display = electron().screen.getDisplayNearestPoint(point);
  const box = core.placeAt(point, core.defaultSize(k), display.workArea);
  const board = core.newBoard({ kind: k, date: now, title: uniqueTitleFor(k, now), bounds: box });
  const win = windowFor(board);
  entries.set(board.id, { board, win, lastThumbAt: 0, lastSyncAt: 0, moveTimer: null });
  persist(board);
  notifyChange();
  return { ok: true, board };
}

function createNote(opts) {
  return create("note", opts);
}

function createBoard(opts) {
  return create("board", opts);
}

/** Bring one board back AT THE CURSOR (the taskbar click contract). */
function show(id) {
  const entry = entries.get(String(id || ""));
  if (!entry) return { ok: false, reason: "that board is not open" };
  const { screen } = electron();
  const point = screen.getCursorScreenPoint();
  const display = screen.getDisplayNearestPoint(point);
  const size = entry.win.isDestroyed() ? core.defaultSize(entry.board.kind)
    : { width: entry.win.getBounds().width, height: entry.win.getBounds().height };
  const bounds = core.placeAt(point, size, display.workArea);
  if (!entry.win.isDestroyed()) {
    entry.win.setBounds(bounds);
    entry.win.show();
    entry.win.focus();
  }
  entry.board.visible = true;
  entry.board.open = true;
  entry.board.bounds = { ...bounds };
  persist(entry.board);
  notifyChange();
  return { ok: true, board: entry.board, bounds };
}

/** Put away = hide into the Boards list (keeps the board open). */
async function putAway(id) {
  const entry = entries.get(String(id || ""));
  if (!entry) return { ok: false, reason: "that board is not open" };
  entry.board.visible = false;
  persist(entry.board);
  // Capture while the window is still on screen: capturePage on a hidden window
  // yields an empty image on Windows.
  await syncBoard(entry, null, { force: true });
  if (!entry.win.isDestroyed()) entry.win.hide();
  notifyChange();
  return { ok: true };
}

// ── sync + thumbnail ────────────────────────────────────────────────────────

function decodePng(raw) {
  if (!raw) return null;
  const text = String(raw);
  const m = /^data:image\/png;base64,([A-Za-z0-9+/=]+)$/.exec(text);
  if (!m) return null;
  try { return Buffer.from(m[1], "base64"); } catch { return null; }
}

async function captureThumbnail(entry) {
  if (entry.win.isDestroyed()) return null;
  try {
    const image = await entry.win.webContents.capturePage();
    if (!image || image.isEmpty()) return null;
    const png = image.resize({ width: Math.min(480, image.getSize().width) }).toPNG();
    const folder = resolveDir();
    if (folder) fs.writeFileSync(core.thumbnailFile(folder, entry.board.id), png);
    return png;
  } catch {
    return null;
  }
}

/**
 * Queue the board's PNG + (notes) markdown into the `files` Strata folder.
 * `png` may be a data URL from the renderer; null asks for a capturePage. A
 * non-forced sync is throttled so drawing does not upload on every stroke.
 */
async function syncBoard(entry, png, { force = false } = {}) {
  const now = Date.now();
  if (!force && now - entry.lastSyncAt < 60_000) return { ok: false, reason: "throttled" };
  let bytes = decodePng(png);
  if (!bytes) bytes = await captureThumbnail(entry);
  entry.lastSyncAt = now;
  const board = entry.board;
  if (board.kind === "note" && !bytes) {
    // A note's markdown is still worth syncing without a picture.
    const md = core.syncItems(board, { png: null });
    for (const item of md) enqueueUpload(item);
    return { ok: true, queued: md.length };
  }
  if (!bytes) return { ok: false, reason: "no image to sync" };
  const items = core.syncItems(board, { png: bytes });
  let queued = 0;
  for (const item of items) if (enqueueUpload(item).ok) queued += 1;
  return { ok: true, queued };
}

// ── export ──────────────────────────────────────────────────────────────────

function exportPng(dataUrl) {
  const folder = resolveDir();
  const bytes = decodePng(dataUrl);
  if (!bytes) return { ok: false, reason: "the export was not a PNG" };
  if (!folder) return { ok: false, reason: "no writable boards folder" };
  const file = core.exportFile(folder, `export-${Date.now()}`, new Date());
  try {
    fs.writeFileSync(file, bytes);
  } catch (error) {
    return { ok: false, reason: `could not save the PNG: ${String((error && error.message) || error).slice(0, 160)}` };
  }
  return { ok: true, path: file, name: path.basename(file) };
}

// ── the list (tray submenu + Boards…) ───────────────────────────────────────

/** Tray rows: at most 5 boards, "+N more", then the three verbs. */
function traySubmenu() {
  const boards = [...entries.values()].map((entry) => entry.board).filter((b) => b.open !== false);
  const summary = core.listSummary(boards);
  const rows = summary.rows.map((row) => ({
    label: row.hidden ? `${row.label}  (put away)` : row.label,
    click: () => void show(row.id),
  }));
  if (summary.more > 0) rows.push({ label: `+${summary.more} more`, click: () => openList() });
  if (!boards.length) rows.push({ label: "No notes or whiteboards yet", enabled: false });
  rows.push(
    { type: "separator" },
    { label: "New note", click: () => void createNote() },
    { label: "New whiteboard", click: () => void createBoard() },
    { label: "Board list…", click: () => openList() },
  );
  return rows;
}

/** The full list as a native menu at the pointer (the "+N more" destination). */
function openList() {
  const { Menu, BrowserWindow, screen } = electron();
  const boards = core.listedBoards([...entries.values()].map((entry) => entry.board));
  const rows = boards.map((board) => ({
    label: `${board.kind === "note" ? "Note" : "Board"}: ${board.title}${board.visible === false ? "  (put away)" : ""}`,
    click: () => void show(board.id),
  }));
  if (!rows.length) rows.push({ label: "No notes or whiteboards yet", enabled: false });
  rows.push(
    { type: "separator" },
    { label: "New note", click: () => void createNote() },
    { label: "New whiteboard", click: () => void createBoard() },
  );
  const point = screen.getCursorScreenPoint();
  const menu = Menu.buildFromTemplate(rows);
  menu.popup({ window: BrowserWindow.getFocusedWindow() || undefined, x: point.x, y: point.y });
  return { ok: true, count: boards.length };
}

/** Reopen boards left open AND visible at the last quit. */
function restoreOpenBoards() {
  const folder = resolveDir();
  if (!folder) return { ok: false, reason: "no writable boards folder" };
  let count = 0;
  for (const board of loadBoards(folder)) {
    if (!board.open || !board.visible) continue;
    if (entries.has(board.id)) continue;
    const verdict = create(board.kind, { restored: board });
    if (verdict.ok) count += 1;
  }
  return { ok: true, count, dir: folder };
}

// ── IPC ─────────────────────────────────────────────────────────────────────

function entryFor(event) {
  if (!event || !event.sender) return null;
  for (const entry of entries.values()) {
    if (!entry.win.isDestroyed() && entry.win.webContents === event.sender) return entry;
  }
  return null;
}

function handlers() {
  return {
    "board:init": (event) => {
      const entry = entryFor(event);
      if (!entry) return { ok: false, reason: "not a board window" };
      return { ok: true, board: { ...entry.board }, dir: resolveDir() };
    },
    "board:save": (event, patch) => {
      const entry = entryFor(event);
      if (!entry) return { ok: false, reason: "not a board window" };
      entry.board = core.applySave(entry.board, patch);
      const saved = persist(entry.board);
      notifyContent(entry.board.id);
      entry.win.setTitle(entry.board.title);
      // The full-size PNG rides an occasional save; a note's thumbnail is captured.
      const png = patch && typeof patch.png === "string" ? patch.png : null;
      if (png || entry.board.kind === "note") void syncBoard(entry, png, { force: false });
      if (!png && Date.now() - entry.lastThumbAt > 3000) {
        entry.lastThumbAt = Date.now();
        void captureThumbnail(entry);
      }
      return saved.ok ? { ok: true, updatedAt: entry.board.updatedAt } : saved;
    },
    "board:put-away": (event) => {
      const entry = entryFor(event);
      if (!entry) return { ok: false, reason: "not a board window" };
      return putAway(entry.board.id);
    },
    "board:close": async (event) => {
      const entry = entryFor(event);
      if (!entry) return { ok: false, reason: "not a board window" };
      entry.board.open = false;
      entry.board.visible = false;
      persist(entry.board);
      await syncBoard(entry, null, { force: true });
      entry.win.close();
      notifyChange();
      return { ok: true };
    },
    "board:paste": (event) => {
      const entry = entryFor(event);
      if (!entry) return { ok: false, reason: "not a board window" };
      const { clipboard } = electron();
      try {
        const image = clipboard.readImage();
        if (image && !image.isEmpty()) {
          const size = image.getSize();
          return { ok: true, kind: "image", dataUrl: image.toDataURL(), width: size.width, height: size.height };
        }
        const text = clipboard.readText();
        if (String(text || "").trim()) return { ok: true, kind: "text", text: String(text).slice(0, 100_000) };
        return { ok: false, reason: "the clipboard has no image or text" };
      } catch (error) {
        return { ok: false, reason: String((error && error.message) || error).slice(0, 160) };
      }
    },
    // ── the board's pinned cards (the same renderer and host as aither://canvas) ──
    "board:pins": (event) => {
      const entry = entryFor(event);
      if (!entry) return { ok: false, reason: "not a board window" };
      return pinHost().state(event.sender, entry.board.id, hostFor(entry));
    },
    "board:pin-op": (event, op) => {
      const entry = entryFor(event);
      if (!entry) return { ok: false, reason: "not a board window" };
      return pinHost().op(entry.board.id, op);
    },
    "board:pin-views": (event, data) => {
      const entry = entryFor(event);
      if (!entry) return { ok: false, reason: "not a board window" };
      return pinHost().views(event.sender, entry.board.id, hostFor(entry), data);
    },
    "board:pin-widget": (event, id) => (entryFor(event) ? pinHost().widget(id) : { ok: false, reason: "not a board window" }),
    "board:pin-open": (event, id) => {
      const entry = entryFor(event);
      if (!entry) return { ok: false, reason: "not a board window" };
      return pinHost().open(entry.board.id, id);
    },
    "board:export": (event, dataUrl) => {
      const entry = entryFor(event);
      if (!entry) return { ok: false, reason: "not a board window" };
      const verdict = exportPng(dataUrl);
      return verdict;
    },
  };
}

/** The canvas host's board-window door (browser-window.cjs), required lazily: no cycle at load. */
function pinHost() {
  return require("./browser-window.cjs").pinHost();
}

/** Where a board window's live cards go: its own window, from its content origin. */
function hostFor(entry) {
  return () => (entry.win.isDestroyed() ? null
    : { window: entry.win, origin: { x: 0, y: 0 }, shown: entry.win.isVisible() && !entry.win.isMinimized() });
}

function ensureIpc() {
  if (wired) return;
  wired = true;
  const { ipcMain } = electron();
  for (const [channel, fn] of Object.entries(handlers())) ipcMain.handle(channel, fn);
  try {
    electron().app.on("before-quit", () => { quitting = true; });
  } catch { /* no app (probe teardown): the flag stays false */ }
}

// ── the canvas's door onto the same store (aither://canvas) ──────────────────
// The canvas page reads and edits boards WITHOUT a floating window: an open window's
// in-memory board wins (it is the newest), otherwise the file in ~/Aither Boards is.

/** Every listed whiteboard (kind "board", open), newest first: a window's copy wins. */
function allBoards() {
  const byId = new Map(loadBoards(resolveDir()).map((b) => [b.id, b]));
  for (const entry of entries.values()) byId.set(entry.board.id, entry.board);
  return core.listedBoards([...byId.values()]).filter((b) => b.kind === "board");
}

function getBoard(id) {
  const entry = entries.get(String(id || ""));
  if (entry) return entry.board;
  return allBoards().find((b) => b.id === String(id || "")) || null;
}

/**
 * Save a canvas edit to board `id`: the same applySave a window save goes through, so
 * neither half can drop the other's fields. A board with an open window is updated in
 * place and its window is told to reload (board:changed).
 */
function updateBoard(id, patch) {
  const current = getBoard(id);
  if (!current) return { ok: false, reason: "no such board" };
  const next = core.applySave(current, patch);
  const entry = entries.get(next.id);
  if (entry) {
    entry.board = next;
    try { if (!entry.win.isDestroyed()) entry.win.webContents.send("board:changed", { ...next }); } catch { /* closing */ }
  }
  const saved = persist(next);
  notifyContent(next.id);
  return saved.ok || !resolveDir() ? { ok: true, board: next, saved: saved.ok } : { ...saved, board: next };
}

/**
 * Record "the desk and AitherOne agreed at this version" on a board's link WITHOUT
 * bumping updatedAt (a bump would read as a desk edit on the next sync).
 */
function stampLink(id) {
  const board = getBoard(id);
  if (!board || !board.link || !board.link.aitherone) return { ok: false, reason: "that board is not linked" };
  board.link = { aitherone: { ...board.link.aitherone, localUpdatedAt: board.updatedAt } };
  const entry = entries.get(board.id);
  if (entry) entry.board = board;
  persist(board);
  return { ok: true, board };
}

/** A new whiteboard for the canvas: on the Boards list (put away), no window opened. */
function createCanvasBoard(title) {
  const now = new Date();
  const board = core.newBoard({ kind: "board", date: now,
    title: String(title || "").trim().slice(0, 160) || uniqueTitleFor("board", now) });
  board.visible = false;
  persist(board);
  notifyChange();
  return { ok: true, board };
}

/** Take a board off the list (open:false, the file stays): the canvas's "Delete". */
function closeBoard(id) {
  const entry = entries.get(String(id || ""));
  if (entry && !entry.win.isDestroyed()) {
    entry.board.open = false;
    entry.board.visible = false;
    persist(entry.board);
    entry.win.close();
    notifyChange();
    return { ok: true };
  }
  const board = getBoard(id);
  if (!board) return { ok: false, reason: "no such board" };
  persist({ ...board, open: false, visible: false });
  notifyChange();
  return { ok: true };
}

/** Float a board in its own window (the board window stays the floating view). */
function float(id) {
  if (entries.has(String(id || ""))) return show(id);
  const board = getBoard(id);
  if (!board) return { ok: false, reason: "no such board" };
  return create("board", { restored: { ...board, visible: true } });
}

/** Test/probe seam: the open entries, read-only copy. */
function list() {
  return [...entries.values()].map((entry) => ({ ...entry.board }));
}

module.exports = {
  ensureIpc, setEnqueue, setChangeHook, setBoardsDir, resolveDir, loadBoards, persist,
  createNote, createBoard, create, show, putAway, restoreOpenBoards, openList, traySubmenu,
  exportPng, syncBoard, list,
  allBoards, getBoard, updateBoard, stampLink, createCanvasBoard, closeBoard, float, onBoardsChanged,
  // exposed for the probe
  __entries: entries,
};
