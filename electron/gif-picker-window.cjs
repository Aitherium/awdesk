"use strict";

/**
 * gif-picker-window.cjs -- the GIF picker (owner 2026-11-07: "searching for GIFs
 * and pinning them on the desktop"). A search grid at the cursor:
 *
 *   click          pin the GIF to the desktop (pins-window.cjs)
 *   Shift+click    put it on the current whiteboard (boards-window addImageToCurrentBoard)
 *   drag           a real FILE drag (webContents.startDrag) -- drop it on a board,
 *                  Discord, an email, anything that takes an image file
 *
 * The page only ever sends a result ID; main resolves it through gif-search's
 * lookup(), so a renderer cannot make the desk fetch an arbitrary URL. Downloads
 * are https from the provider CDNs only (gif-search MEDIA_HOST), capped at 15 MB,
 * cached under userData/gif-cache (one non-recursive mkdir, never Documents).
 */

const fs = require("node:fs");
const path = require("node:path");
const { createGifSearch, mediaUrl } = require("./gif-search.cjs");

const MAX_BYTES = 15 * 1024 * 1024;
const SIZE = Object.freeze({ width: 560, height: 600 });

let configured = { electron: null, gifs: null, pins: null, boards: null, fetchImpl: null, cacheDir: null };
let win = null;
let wired = false;
let lastQuery = "";

function electron() {
  return configured.electron || require("electron");
}

function configureGifPicker(next = {}) {
  configured = { ...configured, ...next };
}

function gifs() {
  if (!configured.gifs) configured.gifs = createGifSearch();
  return configured.gifs;
}

function pins() {
  return configured.pins || require("./pins-window.cjs");
}

function boards() {
  return configured.boards || require("./boards-window.cjs");
}

function cacheDir() {
  if (configured.cacheDir) return configured.cacheDir;
  const dir = path.join(electron().app.getPath("userData"), "gif-cache");
  // userData exists; ONE level, never recursive (Controlled Folder Access, boards-core.cjs).
  try { fs.mkdirSync(dir); } catch { /* exists */ }
  configured.cacheDir = dir;
  return dir;
}

function cachePath(id) {
  return path.join(cacheDir(), `${String(id).replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 80)}.gif`);
}

/** The GIF's bytes on disk (cached). {ok, file, bytes} | {ok:false, reason}. */
async function download(result) {
  const url = result && mediaUrl(result.url);
  if (!url) return { ok: false, reason: "that GIF is not from Tenor or Giphy's media servers" };
  const file = cachePath(result.id);
  try {
    const bytes = fs.readFileSync(file);
    if (bytes.length) return { ok: true, file, bytes };
  } catch { /* not cached yet */ }
  const fetchImpl = configured.fetchImpl || ((...a) => fetch(...a));
  let res;
  try { res = await fetchImpl(url, { redirect: "error" }); } catch { return { ok: false, reason: "the GIF could not be downloaded" }; }
  if (!res || !res.ok) return { ok: false, reason: `the GIF server answered HTTP ${res ? res.status : 0}` };
  const declared = Number(res.headers && res.headers.get ? res.headers.get("content-length") : 0);
  if (declared > MAX_BYTES) return { ok: false, reason: "that GIF is over 15 MB" };
  const bytes = Buffer.from(await res.arrayBuffer());
  if (bytes.length > MAX_BYTES) return { ok: false, reason: "that GIF is over 15 MB" };
  try { fs.writeFileSync(file, bytes); } catch { /* serve from memory; the drag needs the file */ }
  return { ok: true, file, bytes };
}

/** A pin no bigger than 320 px on its long side, keeping the GIF's aspect. */
function pinSize(result) {
  const w = Number(result.width) || 280;
  const h = Number(result.height) || 220;
  const k = Math.min(1, 320 / Math.max(w, h));
  return { width: Math.max(80, Math.round(w * k)), height: Math.max(60, Math.round(h * k)) };
}

function pinGif(id) {
  const result = gifs().lookup(id);
  if (!result) return { ok: false, reason: "that result is gone — search again" };
  const size = pinSize(result);
  return pins().addPin({ kind: "gif", src: result.url, title: result.title, bounds: { x: 0, y: 0, ...size } });
}

async function gifToBoard(id) {
  const result = gifs().lookup(id);
  if (!result) return { ok: false, reason: "that result is gone — search again" };
  const got = await download(result);
  if (!got.ok) return got;
  return boards().addImageToCurrentBoard({
    dataUrl: `data:image/gif;base64,${got.bytes.toString("base64")}`,
    name: result.title, width: result.width, height: result.height,
  });
}

/** The renderer's view of a search: no full-size URL, no key, just what the grid draws. */
function publicResults(r) {
  if (!r || !r.ok) return r;
  return {
    ok: true, provider: r.provider, rating: r.rating, query: r.query,
    results: r.results.map((g) => ({ id: g.id, title: g.title, preview: g.preview, width: g.width, height: g.height })),
  };
}

function isPicker(event) {
  return Boolean(win && !win.isDestroyed() && event && event.sender === win.webContents);
}

function handlers() {
  const guard = (fn) => async (event, ...args) => {
    if (!isPicker(event)) return { ok: false, reason: "not the GIF picker" };
    try { return await fn(event, ...args); } catch (error) {
      return { ok: false, reason: String((error && error.message) || error).slice(0, 160) };
    }
  };
  return {
    "gif:init": guard(async () => ({ ok: true, query: lastQuery, keyStatus: await gifs().keyStatus() })),
    "gif:search": guard(async (_e, q) => { lastQuery = String(q || "").slice(0, 100); return publicResults(await gifs().search(q)); }),
    "gif:pin": guard((_e, id) => pinGif(String(id || ""))),
    "gif:to-board": guard((_e, id) => gifToBoard(String(id || ""))),
    "gif:prefetch": guard(async (_e, id) => {
      const result = gifs().lookup(String(id || ""));
      if (!result) return { ok: false, reason: "unknown result" };
      const got = await download(result);
      return got.ok ? { ok: true } : got;
    }),
    "gif:close": guard(() => { hide(); return { ok: true }; }),
  };
}

/**
 * startDrag must run synchronously inside the renderer's dragstart, so it is an
 * ipcMain.on (not handle) and only drags a file prefetch already put on disk.
 */
function onDrag(event, id) {
  if (!isPicker(event)) return;
  const result = gifs().lookup(String(id || ""));
  if (!result) return;
  const file = cachePath(result.id);
  if (!fs.existsSync(file)) return;
  const { nativeImage } = electron();
  let icon = nativeImage.createFromPath(file);
  if (!icon || icon.isEmpty()) {
    icon = nativeImage.createFromDataURL("data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=");
  }
  try { event.sender.startDrag({ file, icon: icon.resize({ width: 64 }) }); } catch { /* drag refused */ }
}

function ensureIpc() {
  if (wired) return;
  wired = true;
  const { ipcMain } = electron();
  for (const [channel, fn] of Object.entries(handlers())) ipcMain.handle(channel, fn);
  ipcMain.on("gif:drag", onDrag);
}

function hide() {
  try { if (win && !win.isDestroyed()) win.hide(); } catch { /* gone */ }
}

/** Open the picker at the cursor, optionally searching `query` straight away. */
function openGifPicker(query = "") {
  ensureIpc();
  const { BrowserWindow, screen } = electron();
  const point = screen.getCursorScreenPoint();
  const area = screen.getDisplayNearestPoint(point).workArea;
  const x = Math.round(Math.min(Math.max(point.x - SIZE.width / 2, area.x + 8), area.x + area.width - SIZE.width - 8));
  const y = Math.round(Math.min(Math.max(point.y - 80, area.y + 8), area.y + area.height - SIZE.height - 8));
  if (typeof query === "string" && query.trim()) lastQuery = query.trim().slice(0, 100);
  if (!win || win.isDestroyed()) {
    win = new BrowserWindow({
      x, y, ...SIZE, frame: false, resizable: true, minWidth: 360, minHeight: 320, show: false, skipTaskbar: true,
      alwaysOnTop: true, backgroundColor: "#14141a", title: "GIFs",
      webPreferences: {
        preload: path.join(__dirname, "gif-picker-preload.cjs"),
        contextIsolation: true, nodeIntegration: false, sandbox: true,
      },
    });
    win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    win.webContents.on("will-navigate", (event) => event.preventDefault());
    win.on("blur", () => { /* stays: a drag onto another window blurs it */ });
    win.once("ready-to-show", () => { win.show(); win.focus(); });
    void win.loadFile(path.join(__dirname, "gif-picker.html"));
  } else {
    win.setBounds({ x, y, ...SIZE });
    win.show();
    win.focus();
    win.webContents.send("gif:query", lastQuery);
  }
  return { ok: true };
}

module.exports = {
  configureGifPicker, openGifPicker, handlers, gifSearch: () => gifs(), pinGif, gifToBoard, download, pinSize, publicResults, hide,
  __onDrag: onDrag,
};
