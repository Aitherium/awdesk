"use strict";

/**
 * boards-core.cjs -- the Electron-free half of the desk's sticky notes and
 * whiteboards (owner 2026-11-02: "spawn a virtual clipboard/whiteboard anywhere and
 * then put it away when you're done"). boards-window.cjs owns the BrowserWindows,
 * the clipboard read and the Strata queue; this module is model + placement + the
 * names files land under, so boards-core.test.cjs runs under `node --test`.
 *
 * A board is ONE JSON document, the source of truth:
 *
 *   {version:2, id, kind:"note"|"board", title, createdAt, updatedAt,
 *    open, visible, bounds:{x,y,width,height}, items:[...], text:"...",
 *    pins:[pin-item], view:{scale,x,y}, windowView:{x,y}, grid, snap, link}
 *
 * Version 2 (2026-11-07, aither://canvas): a board also holds PINNED CARDS (`pins`,
 * pin-item.cjs: live pages, YouTube, GIFs, images, widgets, notes) beside its drawing
 * `items`, the canvas view (`view`, AitherOne's SceneView shape), its snap grid, and
 * `link` -- the AitherOne canvas doc it syncs with, if any. A version-1 file migrates
 * on read (migrateBoard): no pins, the default view, unlinked. The floating board
 * window and the canvas page edit the SAME document.
 *
 * `open`      the board exists in the Boards list (a closed board is not restored).
 * `visible`   its window is on screen. "Put away" clears visible and keeps open, so
 *             the row stays in the tray's Boards submenu and one click brings it
 *             back at the cursor (the taskbar contract the owner asked for).
 *
 * The renderer owns the drawing model (`items`), this module only validates it:
 * every persisted field is read back through normalizeBoard(), so a torn or
 * hand-edited file degrades to a usable empty board instead of a crash.
 *
 * Writes go to ~/Aither Boards (see dirCandidates) through snip-capture's
 * writableDir. NEVER a recursive mkdirSync into Documents/Pictures/Videos:
 * Controlled Folder Access makes that loop forever on the main thread (measured
 * 2026-11-01, snip-capture.cjs).
 */

const os = require("node:os");
const path = require("node:path");
// The pinned cards on a board (aither://canvas): one card model, shared with the
// desktop pins and AitherOne scenes.
const pinItem = require("./pin-item.cjs");

const BOARDS_DIR_NAME = "Aither Boards";
const KINDS = Object.freeze(["note", "board"]);
const MAX_LIST = 5;
const NOTE_SIZE = Object.freeze({ width: 360, height: 300 });
const BOARD_SIZE = Object.freeze({ width: 760, height: 560 });
const MIN_WIDTH = 240;
const MIN_HEIGHT = 180;
const BOARD_VERSION = 2;
const MAX_PINS = 100;
const GRID_MIN = 4;
const GRID_MAX = 64;
const DEFAULT_GRID = 16;
const SCALE_MIN = 0.25;
const SCALE_MAX = 2;

function pad(n, width = 2) {
  return String(n).padStart(width, "0");
}

/** "2026-11-02 0930" in LOCAL time. */
function stamp(date = new Date()) {
  const d = date instanceof Date ? date : new Date(date);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}${pad(d.getMinutes())}`;
}

/** The window title a fresh board carries. Notes and whiteboards read apart. */
function titleFor(kind, date = new Date()) {
  return `${kind === "note" ? "Note" : "Whiteboard"} ${stamp(date)}`;
}

/** A title no other open board has: "... (2)" rather than two identical rows. */
function uniqueTitle(base, existing = []) {
  const taken = new Set((existing || []).map((b) => String(b && b.title ? b.title : "")));
  if (!taken.has(base)) return base;
  for (let i = 2; i < 1000; i += 1) {
    const next = `${base} (${i})`;
    if (!taken.has(next)) return next;
  }
  return `${base} (${Date.now()})`;
}

function newId(kind, date = new Date(), rand = Math.random().toString(16).slice(2, 8)) {
  const d = date instanceof Date ? date : new Date(date);
  const k = kind === "note" ? "note" : "board";
  return `${k}-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}-${rand}`;
}

/**
 * Where boards may live, in preference order. The home root first: Defender's
 * Controlled Folder Access protects Documents/Pictures/Videos, and snip-capture
 * measured a recursive mkdir there hanging the main thread forever. The second
 * candidate is the same "Aither Captures" fallback the snipping tool uses.
 */
function dirCandidates({ homeDir = os.homedir() } = {}) {
  return [
    path.join(homeDir, BOARDS_DIR_NAME),
    path.join(homeDir, "Aither Captures", "Boards"),
  ];
}

function boardFile(dir, id) {
  return path.join(String(dir || ""), `${String(id || "").replace(/[^a-z0-9._-]/gi, "_")}.json`);
}

function thumbnailFile(dir, id) {
  return path.join(String(dir || ""), `${String(id || "").replace(/[^a-z0-9._-]/gi, "_")}.png`);
}

function exportFile(dir, id, date = new Date()) {
  return path.join(String(dir || ""), `${String(id || "").replace(/[^a-z0-9._-]/gi, "_")} ${stamp(date).replace(/[ :]/g, "-")}.png`);
}

// ── placement ───────────────────────────────────────────────────────────────

function defaultSize(kind) {
  return kind === "note" ? { ...NOTE_SIZE } : { ...BOARD_SIZE };
}

/**
 * Where a new board opens: its top-left AT the cursor, flipped left/up when the
 * size would run past the display edge, then clamped into the WORK area (never
 * under the taskbar). `workArea` is Electron's display.workArea (DIPs).
 */
function placeAt(point, size, workArea, margin = 8) {
  const area = workArea && Number.isFinite(workArea.width) ? workArea : { x: 0, y: 0, width: 1920, height: 1080 };
  const w = Math.min(Math.max(Number(size && size.width) || BOARD_SIZE.width, MIN_WIDTH), area.width - margin * 2);
  const h = Math.min(Math.max(Number(size && size.height) || BOARD_SIZE.height, MIN_HEIGHT), area.height - margin * 2);
  const cx = Number(point && point.x) || 0;
  const cy = Number(point && point.y) || 0;
  let x = cx;
  let y = cy;
  if (x + w > area.x + area.width - margin) x = cx - w;
  if (y + h > area.y + area.height - margin) y = cy - h;
  x = Math.min(Math.max(x, area.x + margin), area.x + area.width - w - margin);
  y = Math.min(Math.max(y, area.y + margin), area.y + area.height - h - margin);
  return { x: Math.round(x), y: Math.round(y), width: Math.round(w), height: Math.round(h) };
}

/** A restored board's bounds if they still sit on a display; else null (open at cursor). */
function usableBounds(bounds, displays = []) {
  if (!bounds || !Number.isFinite(Number(bounds.width)) || !Number.isFinite(Number(bounds.height))) return null;
  const b = { x: Number(bounds.x) || 0, y: Number(bounds.y) || 0, width: Number(bounds.width), height: Number(bounds.height) };
  if (b.width < MIN_WIDTH || b.height < MIN_HEIGHT) return null;
  const cx = b.x + b.width / 2;
  const cy = b.y + b.height / 2;
  const hit = (displays || []).some((d) => d && d.bounds
    && cx >= d.bounds.x && cx <= d.bounds.x + d.bounds.width
    && cy >= d.bounds.y && cy <= d.bounds.y + d.bounds.height);
  return hit ? b : null;
}

// ── model ───────────────────────────────────────────────────────────────────

/** A fresh board document. `title` is made unique against `existing` by the caller. */
function newBoard({ kind = "board", date = new Date(), id, title, bounds } = {}) {
  const k = KINDS.includes(kind) ? kind : "board";
  const at = date instanceof Date ? date : new Date(date);
  const iso = at.toISOString();
  return {
    version: BOARD_VERSION,
    id: id || newId(k, at),
    kind: k,
    title: String(title || titleFor(k, at)),
    createdAt: iso,
    updatedAt: iso,
    open: true,
    visible: true,
    bounds: bounds && Number.isFinite(Number(bounds.x)) ? {
      x: Number(bounds.x), y: Number(bounds.y),
      width: Number(bounds.width), height: Number(bounds.height),
    } : { x: 0, y: 0, ...defaultSize(k) },
    items: [],
    text: "",
    pins: [],
    view: { scale: 1, x: 0, y: 0 },
    windowView: { x: 0, y: 0 },
    grid: DEFAULT_GRID,
    snap: true,
    link: null,
  };
}

function finite(n, fallback = 0) {
  return Number.isFinite(Number(n)) ? Number(n) : fallback;
}

function normalizeItem(raw) {
  if (!raw || typeof raw !== "object" || !raw.id || !raw.type) return null;
  const base = {
    id: String(raw.id).slice(0, 80),
    type: String(raw.type).slice(0, 16),
    x: finite(raw.x),
    y: finite(raw.y),
    w: Math.max(1, finite(raw.w, 1)),
    h: Math.max(1, finite(raw.h, 1)),
  };
  if (raw.type === "stroke") {
    const points = Array.isArray(raw.points)
      ? raw.points.filter((p) => p && Number.isFinite(Number(p.x)) && Number.isFinite(Number(p.y)))
        .map((p) => ({ x: Number(p.x), y: Number(p.y) }))
      : [];
    if (points.length < 2) return null;
    return { ...base, points, color: String(raw.color || "#e6e8eb"), width: Math.max(1, finite(raw.width, 3)) };
  }
  if (raw.type === "shape") {
    return {
      ...base,
      shape: ["line", "rect", "ellipse"].includes(raw.shape) ? raw.shape : "rect",
      color: String(raw.color || "#e6e8eb"),
      width: Math.max(1, finite(raw.width, 3)),
    };
  }
  if (raw.type === "text") {
    return { ...base, text: String(raw.text || "").slice(0, 4000), color: String(raw.color || "#e6e8eb"), size: Math.max(8, finite(raw.size, 16)) };
  }
  if (raw.type === "note") {
    return { ...base, text: String(raw.text || "").slice(0, 4000), color: String(raw.color || "#3a3a2a") };
  }
  if (raw.type === "image") {
    const dataUrl = String(raw.dataUrl || "");
    if (!/^data:image\//.test(dataUrl)) return null;
    return { ...base, dataUrl, name: String(raw.name || "image").slice(0, 120) };
  }
  return null;
}

/** Read a persisted board back into a usable document, or null when it is not one. */
function normalizeBoard(raw) {
  if (!raw || typeof raw !== "object") return null;
  if (!raw.id || !KINDS.includes(raw.kind)) return null;
  const items = Array.isArray(raw.items) ? raw.items.map(normalizeItem).filter(Boolean) : [];
  const v2 = migrateBoard(raw);
  return {
    version: BOARD_VERSION,
    id: String(raw.id).slice(0, 120),
    kind: raw.kind,
    title: String(raw.title || titleFor(raw.kind)).slice(0, 160),
    createdAt: String(raw.createdAt || new Date().toISOString()),
    updatedAt: String(raw.updatedAt || new Date().toISOString()),
    open: raw.open !== false,
    visible: raw.visible !== false,
    bounds: raw.bounds && Number.isFinite(Number(raw.bounds.width))
      ? {
        x: finite(raw.bounds.x), y: finite(raw.bounds.y),
        width: Math.max(MIN_WIDTH, finite(raw.bounds.width, defaultSize(raw.kind).width)),
        height: Math.max(MIN_HEIGHT, finite(raw.bounds.height, defaultSize(raw.kind).height)),
      }
      : { x: 0, y: 0, ...defaultSize(raw.kind) },
    items,
    text: String(raw.text || "").slice(0, 200_000),
    ...v2,
  };
}

/**
 * The version-2 fields of a board, from any version. A v1 file has none of them and
 * gets the defaults; a v2 file has each read back through its own sanitizer.
 */
function migrateBoard(raw) {
  const r = raw && typeof raw === "object" ? raw : {};
  const seen = new Set();
  const pins = [];
  for (const p of Array.isArray(r.pins) ? r.pins : []) {
    const pin = pinItem.normalizePinItem(p);
    if (!pin || seen.has(pin.id)) continue;
    seen.add(pin.id);
    pins.push(pin);
    if (pins.length >= MAX_PINS) break;
  }
  const v = r.view && typeof r.view === "object" ? r.view : {};
  const wv = r.windowView && typeof r.windowView === "object" ? r.windowView : {};
  const clamp = (n, lo, hi, d) => (Number.isFinite(Number(n)) ? Math.min(hi, Math.max(lo, Number(n))) : d);
  const l = r.link && typeof r.link === "object" && r.link.aitherone && typeof r.link.aitherone === "object" ? r.link.aitherone : null;
  const docId = l && typeof l.docId === "string" && /^[A-Za-z0-9_.:-]{1,120}$/.test(l.docId) ? l.docId : null;
  return {
    pins,
    view: { scale: clamp(v.scale, SCALE_MIN, SCALE_MAX, 1), x: Math.round(clamp(v.x, -1e5, 1e5, 0)), y: Math.round(clamp(v.y, -1e5, 1e5, 0)) },
    // The FLOATING WINDOW's pan (board.html, middle-drag on empty space), apart from the
    // canvas page's `view`: the two views of one board keep their own place.
    windowView: { x: Math.round(clamp(wv.x, -1e5, 1e5, 0)), y: Math.round(clamp(wv.y, -1e5, 1e5, 0)) },
    grid: Math.round(clamp(r.grid, GRID_MIN, GRID_MAX, DEFAULT_GRID)),
    snap: r.snap !== false,
    link: docId ? { aitherone: {
      docId,
      // The doc's updated_at when we last agreed with it, and our own updatedAt then:
      // the two halves of last-writer-wins (aitherone-link.cjs).
      remoteUpdatedAt: typeof l.remoteUpdatedAt === "string" ? l.remoteUpdatedAt.slice(0, 40) : null,
      localUpdatedAt: typeof l.localUpdatedAt === "string" ? l.localUpdatedAt.slice(0, 40) : null,
      // AitherOne's content_hash at the last agreement (the base_hash of the next save)
      // and the scene `rev` counter (aitherone-canvas SYNC.md).
      remoteHash: typeof l.remoteHash === "string" ? l.remoteHash.slice(0, 128) : null,
      rev: Number.isInteger(l.rev) && l.rev >= 0 ? l.rev : 0,
      // AitherOne scene nodes the desk cannot show (files, arrows ...): kept verbatim
      // and written back on the next push, never dropped.
      keep: Array.isArray(l.keep) ? l.keep.filter((k) => k && typeof k === "object").slice(0, 200) : [],
    } } : null,
  };
}

/** A save from the renderer: keep the identity main owns, take the content. */
function applySave(board, patch, now = Date.now()) {
  const p = patch && typeof patch === "object" ? patch : {};
  const next = normalizeBoard({
    ...board,
    title: p.title != null ? p.title : board.title,
    text: p.text != null ? p.text : board.text,
    items: Array.isArray(p.items) ? p.items : board.items,
    bounds: p.bounds && typeof p.bounds === "object" ? p.bounds : board.bounds,
    // The canvas's half of the document; the board window never sends these, so a
    // window save keeps the pins the canvas placed (and the other way round).
    pins: Array.isArray(p.pins) ? p.pins : board.pins,
    view: p.view && typeof p.view === "object" ? p.view : board.view,
    grid: p.grid != null ? p.grid : board.grid,
    snap: typeof p.snap === "boolean" ? p.snap : board.snap,
    link: p.link !== undefined ? p.link : board.link,
    windowView: p.windowView && typeof p.windowView === "object" ? p.windowView : board.windowView,
    // A save never resurrects a closed board and never un-hides a put-away one.
    open: board.open,
    visible: board.visible,
    updatedAt: new Date(now).toISOString(),
  });
  return next || board;
}

/** Newest first; a put-away board sorts by when it was put away (its update). */
function sortBoards(boards = []) {
  return [...boards].filter(Boolean).sort((a, b) => {
    const at = Date.parse(b.updatedAt || "") || 0;
    const bt = Date.parse(a.updatedAt || "") || 0;
    return at - bt;
  });
}

/** Boards that belong in the Boards list: open ones, on screen or put away. */
function listedBoards(boards = []) {
  return sortBoards(boards).filter((b) => b.open !== false);
}

/**
 * The tray submenu rows: at most MAX_LIST boards, then ONE "+N more" row.
 * Returns plain {label, id, hidden} records; boards-window adds the clicks.
 */
function listSummary(boards = [], max = MAX_LIST) {
  const listed = listedBoards(boards);
  const rows = listed.slice(0, max).map((b) => ({
    id: b.id,
    label: `${b.kind === "note" ? "Note" : "Board"}: ${b.title}`,
    hidden: b.visible === false,
  }));
  return { rows, more: Math.max(0, listed.length - rows.length) };
}

// ── paste / drop classification ─────────────────────────────────────────────

/**
 * What a clipboard payload should become: an image item, the files as items, or
 * one text item. Image wins over text (a copied screenshot often carries both).
 */
function classifyPaste({ hasImage = false, files = [], text = "" } = {}) {
  if (hasImage) return "image";
  if (Array.isArray(files) && files.length) return "files";
  if (String(text || "").trim()) return "text";
  return null;
}

/** An item centred in a board of `size`, never larger than 80% of the canvas. */
function centeredItem(type, size, { width, height } = {}) {
  const sw = Math.max(1, finite(size && size.width, BOARD_SIZE.width));
  const sh = Math.max(1, finite(size && size.height, BOARD_SIZE.height));
  const w = Math.max(1, Math.min(finite(width, sw * 0.5), sw * 0.8));
  const h = Math.max(1, Math.min(finite(height, sh * 0.5), sh * 0.8));
  return { x: (sw - w) / 2, y: (sh - h) / 2, w, h };
}

// ── persistence payloads ────────────────────────────────────────────────────

function boardJson(board) {
  return `${JSON.stringify(board, null, 2)}\n`;
}

/** The note's own text as a markdown file; a whiteboard keeps its sticky-note text. */
function markdownFor(board) {
  const body = board.kind === "note"
    ? String(board.text || "")
    : (board.items || []).filter((i) => i.type === "note" && i.text)
      .map((i) => `- ${String(i.text).replace(/\n/g, "\n  ")}`).join("\n");
  const at = board.updatedAt || board.createdAt || "";
  return `# ${board.title}\n\n${body}${body ? "\n" : ""}\n_saved ${at}_\n`;
}

/**
 * The Strata queue items for a board: folder `files` (the folder files-ops.cjs
 * already uploads to -- no new Strata folder is invented here). `png` may be null
 * while the renderer has not produced one yet.
 */
function syncItems(board, { png = null } = {}) {
  const items = [];
  if (png) items.push({ folder: "files", name: `${board.id}.png`, bytes: png, contentType: "image/png" });
  if (board.kind === "note") {
    items.push({ folder: "files", name: `${board.id}.md`, bytes: Buffer.from(markdownFor(board), "utf8"), contentType: "text/markdown" });
  }
  return items;
}

module.exports = {
  BOARD_VERSION, MAX_PINS, DEFAULT_GRID, migrateBoard,
  BOARDS_DIR_NAME, KINDS, MAX_LIST, NOTE_SIZE, BOARD_SIZE, MIN_WIDTH, MIN_HEIGHT,
  pad, stamp, titleFor, uniqueTitle, newId, dirCandidates, boardFile, thumbnailFile, exportFile,
  defaultSize, placeAt, usableBounds,
  newBoard, normalizeBoard, applySave, sortBoards, listedBoards, listSummary,
  classifyPaste, centeredItem, boardJson, markdownFor, syncItems,
};
