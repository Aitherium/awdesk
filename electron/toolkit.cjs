"use strict";

/**
 * toolkit.cjs -- the Electron half of the desk's LOCAL toolkit (owner 2026-11-13 22:01:
 * "what about the local awdesk tools and integrations, like right-click access to
 * drawing, graphics, GIFs, playing notes, typing, drawing/painting, opening a whiteboard,
 * pinning notes to the desktop, sending things away"; 22:04: interact mode, the region
 * flow, presenting, voice control).
 *
 * The rules live in toolkit-core.cjs (pure, node --test). This module owns the windows,
 * one IPC surface (toolkit:*, sender-scoped) and the transports, all injected by main:
 *
 *   sketch.new      sketch.html     layers, brushes, eraser, fill, PNG      (offline)
 *   piano.open      piano.html      play, record, MIDI/WAV, seed Song Studio (offline)
 *   scratch.new     scratch.html    quick type -> sticky note | Relay | task | Aither
 *   sticky.new      a desktop pin note (pins-window), colour + on-top/behind, workspace-tagged
 *   graphics.open   graphics.html   resize/convert local; remove bg/upscale/grade/sharpen on
 *                                   THIS machine's Media Forge (never a paid provider)
 *   region.box      pick a box -> region.html: live pixels + OCR + an agent chat bound to it
 *   present.start   pick a box -> everything else dims, laser on; Esc ends
 *   send.last       the newest snip/recording -> a target (a menu at the cursor without one)
 *   interact.toggle the desk takes the mouse everywhere until Esc (the overlay is otherwise
 *                   click-through except its own pixels) -- a pill says so while it lasts
 *
 * Every page sees verdicts only: no token, no path outside its own saves, no other
 * workspace. A window remembers the workspace it was OPENED in, and nothing it makes is
 * ever delivered into another one (owner-hard-workspace-isolation).
 */

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const core = require("./toolkit-core.cjs");

let electronImpl = null;
function electron() {
  if (!electronImpl) electronImpl = require("electron");
  return electronImpl;
}

/** Injected by main (configureToolkit). Every one optional: a missing one is a verdict. */
const deps = {
  runCommand: null, // (id, arg) => verdict
  askImage: null, // ({filePath, prompt}) => routeDrop verdict
  askText: null, // (text) => commandAction result
  onAnswer: null, // (verdict) => void  (announce in chat/voice)
  postRelay: null, // (text) => {ok}
  token: null, // async () => bearer | ""
  currentTenant: null, // () => tenant | null
  lastCapture: null, // () => path | null
  nativeFrame: null, // async (display) => nativeImage | null
  setForceInteractive: null, // (bool) => void  (the avatar + overlay windows)
  controlPlane: () => "https://api.aitherium.com",
  mediaForge: () => "http://127.0.0.1:8200",
  fetchImpl: (...a) => globalThis.fetch(...a),
  homeDir: () => os.homedir(),
};

function configureToolkit(next = {}) {
  for (const [k, v] of Object.entries(next)) if (v !== undefined) deps[k] = v;
  try {
    require("./pins-window.cjs").setNoteSender((pin) => sendNotePin(pin));
  } catch { /* pins not in this build */ }
  try {
    require("./boards-window.cjs").setWorkspaceOf(() => activeWorkspace().key);
  } catch { /* boards not in this build */ }
}

const TOOLS = Object.freeze({
  sketch: { html: "sketch.html", width: 900, height: 640, onTop: false, title: "Sketch" },
  piano: { html: "piano.html", width: 720, height: 300, onTop: false, title: "Play notes" },
  scratch: { html: "scratch.html", width: 440, height: 230, onTop: true, title: "Quick type" },
  graphics: { html: "graphics.html", width: 560, height: 480, onTop: false, title: "Edit an image" },
  region: { html: "region.html", width: 520, height: 600, onTop: true, title: "Region" },
});

/** webContents.id -> {tool, win, workspace, data} */
const windows = new Map();
let wired = false;

function activeWorkspace() {
  let tenant;
  try { tenant = typeof deps.currentTenant === "function" ? deps.currentTenant() : null; } catch { tenant = null; }
  return { key: core.workspaceKey(tenant), name: (tenant && (tenant.name || tenant.host)) || "Personal" };
}

function atCursor(width, height) {
  const { screen } = electron();
  const cursor = screen.getCursorScreenPoint();
  const area = screen.getDisplayNearestPoint(cursor).workArea;
  const x = Math.min(Math.max(cursor.x - Math.round(width / 2), area.x + 8), area.x + area.width - width - 8);
  const y = Math.min(Math.max(cursor.y - 40, area.y + 8), area.y + area.height - height - 8);
  return { x: Math.round(x), y: Math.round(y), width, height };
}

function openTool(tool, data = {}) {
  const def = TOOLS[tool];
  if (!def) return { ok: false, error: `no tool ${tool}` };
  ensureIpc();
  const { BrowserWindow } = electron();
  const bounds = data.bounds || atCursor(def.width, def.height);
  const win = new BrowserWindow({
    ...bounds, frame: false, show: false, resizable: true, transparent: false,
    backgroundColor: "#14171c", alwaysOnTop: def.onTop, skipTaskbar: false, title: def.title,
    minWidth: 320, minHeight: 200,
    webPreferences: {
      preload: path.join(__dirname, "toolkit-preload.cjs"),
      contextIsolation: true, nodeIntegration: false, sandbox: true,
      backgroundThrottling: true,
    },
  });
  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  win.webContents.on("will-navigate", (event) => event.preventDefault());
  const id = win.webContents.id;
  windows.set(id, { tool, win, workspace: activeWorkspace(), data });
  win.on("closed", () => {
    const entry = windows.get(id);
    windows.delete(id);
    if (entry && entry.timer) clearInterval(entry.timer);
  });
  win.once("ready-to-show", () => { win.show(); win.focus(); });
  void win.loadFile(path.join(__dirname, def.html));
  return { ok: true, line: `${def.title} opened`, id };
}

function entryFor(event) {
  return (event && event.sender && windows.get(event.sender.id)) || null;
}

// ── saves (never a recursive mkdir: Defender controlled-folder access loops on one) ──

function ensureDir(parts) {
  let dir = parts[0];
  for (const part of parts.slice(1)) {
    dir = path.join(dir, part);
    try { fs.mkdirSync(dir); } catch (error) { if (error.code !== "EEXIST") throw error; }
  }
  return dir;
}

function saveBytes(workspace, tool, name, bytes) {
  const dir = ensureDir([deps.homeDir(), "Aither Toolkit", workspace.key, tool]);
  let file = path.join(dir, name);
  if (fs.existsSync(file)) {
    const ext = path.extname(name);
    file = path.join(dir, `${path.basename(name, ext)}-${Date.now().toString(36)}${ext}`);
  }
  fs.writeFileSync(file, bytes);
  return file;
}

function bytesOf(payload) {
  if (payload.dataB64) return Buffer.from(payload.dataB64, "base64");
  return Buffer.from(String(payload.text || ""), "utf8");
}

function doSave(entry, payload) {
  const mime = payload.mime || (payload.dataB64 ? "" : "text/plain");
  const name = core.safeSaveName(payload.name, mime, entry.tool);
  if (!name) return { ok: false, error: `cannot save a ${mime || "file of that type"}` };
  try {
    const file = saveBytes(entry.workspace, entry.tool, name, bytesOf(payload));
    return { ok: true, path: file, line: `saved ${path.basename(file)}` };
  } catch (error) {
    return { ok: false, error: `not saved: ${String((error && error.code) || error)}` };
  }
}

function doCopy(payload) {
  const { clipboard, nativeImage } = electron();
  if (payload.dataB64 && /^image\//.test(payload.mime || "image/png")) {
    const img = nativeImage.createFromBuffer(Buffer.from(payload.dataB64, "base64"));
    if (img.isEmpty()) return { ok: false, error: "that image did not decode" };
    clipboard.writeImage(img);
    return { ok: true, line: "image copied" };
  }
  clipboard.writeText(String(payload.text || ""));
  return { ok: true, line: "text copied" };
}

// ── send to ... ─────────────────────────────────────────────────────────────────

async function bearer() {
  try {
    const t = typeof deps.token === "function" ? await deps.token() : "";
    return typeof t === "string" ? t : "";
  } catch {
    return "";
  }
}

/** Genesis POST /v1/capture through the control plane's bridge (AitherOS #16722). */
async function fileCapture(target, payload) {
  const body = core.captureBody(target, payload);
  if (!body || body.error) return { ok: false, error: (body && body.error) || "not a capture target" };
  const token = await bearer();
  if (!token) return { ok: false, error: "sign in to Aither to send there (the tray's Sign in)" };
  let res;
  try {
    res = await deps.fetchImpl(`${deps.controlPlane()}/api/bridge/genesis/v1/capture`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    });
  } catch (error) {
    return { ok: false, error: `offline -- not sent (${String((error && error.message) || error).slice(0, 80)})` };
  }
  let data;
  try { data = await res.json(); } catch { data = null; }
  if (res.status === 404) return { ok: false, error: "Send to Aither is not live on this platform yet (capture endpoint 404)" };
  if (!res.ok) return { ok: false, error: `not sent: HTTP ${res.status}${data && data.detail ? ` ${String(data.detail).slice(0, 120)}` : ""}` };
  const where = (data && (data.delivered_to || data.destination || data.to)) || target.label;
  return { ok: true, line: `sent to ${typeof where === "string" ? where : target.label}` };
}

async function uploadDrive(payload) {
  const strata = require("./strata-sync.cjs");
  const token = await bearer() || strata.defaultToken();
  const name = core.safeSaveName(payload.name, payload.mime || "text/plain", "send") || core.fileName("send", "bin");
  const verdict = await strata.uploadOnce({
    origin: strata.syncOrigin().origin, folder: "files", name, bytes: bytesOf(payload),
    contentType: payload.mime || "text/plain", token,
  });
  return verdict.ok ? { ok: true, line: `uploaded ${name} to Drive` } : { ok: false, error: verdict.reason || "upload failed" };
}

function tempFile(payload, ext) {
  const file = path.join(os.tmpdir(), `aither-toolkit-${process.pid}-${Date.now().toString(36)}.${ext}`);
  fs.writeFileSync(file, bytesOf(payload));
  return file;
}

async function askAither(payload, question = "") {
  if (payload.dataB64 && /^image\//.test(payload.mime || "image/png")) {
    if (typeof deps.askImage !== "function") return { ok: false, error: "the vision lane is not wired" };
    const file = tempFile(payload, "png");
    try {
      const verdict = await deps.askImage({ filePath: file, prompt: question });
      if (verdict && verdict.ok && typeof deps.onAnswer === "function") {
        try { deps.onAnswer(verdict); } catch { /* the answer is still returned */ }
      }
      return verdict && verdict.ok
        ? { ok: true, answer: String(verdict.summary || ""), line: "Aither answered" }
        : { ok: false, error: (verdict && verdict.reason) || "no answer" };
    } finally {
      fs.unlink(file, () => {});
    }
  }
  const text = [question, payload.text].filter(Boolean).join("\n\n").trim();
  if (!text) return { ok: false, error: "nothing to ask" };
  if (typeof deps.askText !== "function") return { ok: false, error: "the agents are not wired" };
  const result = await deps.askText(text);
  const answer = String((result && (result.reply || (result.result && result.result.reply) || result.text || result.summary)) || "").trim();
  return { ok: true, answer, line: answer ? "Aither answered" : "asked Aither" };
}

/**
 * One send. `workspace` is the workspace the item was MADE in; capture/drive/relay go
 * through the hard-isolation check against the desk's workspace right now.
 */
async function sendTo(targetId, payload, workspace) {
  const id = String(targetId || "");
  if (id.startsWith("person:")) {
    const who = id.slice(7).replace(/[^a-z0-9 _.-]/gi, "").slice(0, 40);
    if (typeof deps.postRelay !== "function") return { ok: false, error: "Relay is not wired" };
    const gate = core.mayDeliver(workspace && workspace.key, activeWorkspace().key);
    if (!gate.ok) return { ok: false, error: gate.reason };
    const name = payload.name || payload.title || "an item";
    const r = await deps.postRelay(`@${who} ${payload.text ? payload.text.slice(0, 1500) : `sent you ${name} from the desk`}`);
    return r && r.ok ? { ok: true, line: `sent to ${who} on Relay` } : { ok: false, error: (r && r.error) || "Relay refused it" };
  }
  const target = core.targetById(id);
  if (!target) return { ok: false, error: `no target ${id}` };
  if (target.via === "local") return doCopy(payload);
  if (target.via === "discord") {
    const v = doCopy(payload);
    if (!v.ok) return v;
    try { await electron().shell.openExternal("discord://"); } catch { /* Discord not installed: still copied */ }
    return { ok: true, line: "copied -- paste it into Discord (Ctrl+V)" };
  }
  if (target.via === "ask") return askAither(payload);
  const gate = core.mayDeliver(workspace && workspace.key, activeWorkspace().key);
  if (!gate.ok) return { ok: false, error: gate.reason };
  if (target.via === "capture") return fileCapture(target, payload);
  if (target.via === "strata") return uploadDrive(payload);
  if (target.via === "relay") {
    if (typeof deps.postRelay !== "function") return { ok: false, error: "Relay is not wired" };
    const text = payload.text || `${payload.title || payload.name || "an item"} (from the desk; file kept locally)`;
    const r = await deps.postRelay(text.slice(0, 1800));
    return r && r.ok ? { ok: true, line: "posted to Relay" } : { ok: false, error: (r && r.error) || "Relay refused it" };
  }
  return { ok: false, error: `cannot send via ${target.via}` };
}

/** A sticky-note pin -> Notes, only inside the workspace it was written in. */
async function sendNotePin(pin) {
  const workspace = { key: (pin.extra && pin.extra.workspace) || activeWorkspace().key };
  const v = await sendTo("notes", { kind: "text", text: String(pin.src || ""), title: pin.title || "Sticky note" }, workspace);
  return v.ok ? v : { ok: false, reason: v.error };
}

// ── last capture ────────────────────────────────────────────────────────────────

const MIME_BY_EXT = Object.freeze({ ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
  ".gif": "image/gif", ".webp": "image/webp", ".mp4": "video/mp4" });

function payloadFromFile(file) {
  const mime = MIME_BY_EXT[path.extname(file).toLowerCase()] || "application/octet-stream";
  const stat = fs.statSync(file);
  if (stat.size > 15 * 1024 * 1024) return { error: `${path.basename(file)} is over the 15 MB send limit` };
  return { kind: mime.startsWith("image/") ? "image" : "file", name: path.basename(file), mime,
    dataB64: fs.readFileSync(file).toString("base64"), title: path.basename(file), text: "" };
}

async function sendLast(arg) {
  const file = typeof deps.lastCapture === "function" ? deps.lastCapture() : null;
  if (!file || !fs.existsSync(file)) return { ok: false, error: "no snip or recording yet -- snip something first" };
  const payload = payloadFromFile(file);
  if (payload.error) return { ok: false, error: payload.error };
  const target = String(arg || "").trim();
  if (target) return sendTo(target, payload, activeWorkspace());
  // No target: a short native menu at the cursor.
  const { Menu } = electron();
  return new Promise((resolve) => {
    const items = core.publicTargets(true).map((t) => ({
      label: t.label, click: () => { void sendTo(t.id, payload, activeWorkspace()).then(resolve); },
    }));
    const menu = Menu.buildFromTemplate([{ label: `Send ${path.basename(file)} to…`, enabled: false }, { type: "separator" }, ...items]);
    menu.popup({ callback: () => setTimeout(() => resolve({ ok: true, line: "menu closed" }), 0) });
  });
}

// ── region: pick, live frames, OCR, present ─────────────────────────────────────

let picker = null;
function pickRegion() {
  if (picker) return Promise.resolve(null);
  const { BrowserWindow, screen, ipcMain } = electron();
  const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  return new Promise((resolve) => {
    const win = new BrowserWindow({
      ...display.bounds, frame: false, transparent: true, resizable: false, movable: false,
      skipTaskbar: true, hasShadow: false, enableLargerThanScreen: true, show: false, focusable: true,
      webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true,
        preload: path.join(__dirname, "toolkit-pick-preload.cjs") },
    });
    picker = { win, display };
    win.setAlwaysOnTop(true, "screen-saver");
    const done = (rect) => {
      ipcMain.removeHandler("toolkit-pick:done");
      picker = null;
      if (!win.isDestroyed()) win.close();
      resolve(rect);
    };
    ipcMain.removeHandler("toolkit-pick:done");
    ipcMain.handle("toolkit-pick:done", (event, raw) => {
      if (event.sender !== win.webContents) return { ok: false };
      const n = (v) => Number(v);
      const rect = raw && [raw.x, raw.y, raw.width, raw.height].every((v) => Number.isFinite(n(v)))
        ? { x: display.bounds.x + n(raw.x), y: display.bounds.y + n(raw.y), width: n(raw.width), height: n(raw.height) }
        : null;
      done(rect && rect.width >= 16 && rect.height >= 16 ? rect : null);
      return { ok: true };
    });
    win.on("closed", () => { if (picker && picker.win === win) { picker = null; resolve(null); } });
    win.once("ready-to-show", () => { win.show(); win.focus(); });
    void win.loadFile(path.join(__dirname, "toolkit-pick.html"));
  });
}

async function grabRegion(rect) {
  const { screen, desktopCapturer } = electron();
  const display = screen.getDisplayMatching(rect);
  const crop = core.cropRect(rect, display);
  if (!crop) return { ok: false, error: "the region is off screen" };
  let image = null;
  try { if (typeof deps.nativeFrame === "function") image = await deps.nativeFrame(display); } catch { image = null; }
  if (!image || image.isEmpty()) {
    const s = display.scaleFactor || 1;
    const sources = await desktopCapturer.getSources({ types: ["screen"],
      thumbnailSize: { width: Math.round(display.bounds.width * s), height: Math.round(display.bounds.height * s) } });
    const src = sources.find((x) => String(x.display_id) === String(display.id)) || sources[0];
    image = src ? src.thumbnail : null;
  }
  if (!image || image.isEmpty()) return { ok: false, error: "the screen could not be captured" };
  const size = image.getSize();
  const k = size.width / Math.round(display.bounds.width * (display.scaleFactor || 1));
  const scaled = k === 1 ? crop : { x: Math.round(crop.x * k), y: Math.round(crop.y * k), width: Math.round(crop.width * k), height: Math.round(crop.height * k) };
  const cut = image.crop(scaled);
  return { ok: true, dataB64: cut.toPNG().toString("base64"), width: scaled.width, height: scaled.height };
}

/** Windows OCR (Windows.Media.Ocr) on a PNG, offline, through one hidden PowerShell. */
const OCR_PS = [
  "$ErrorActionPreference='Stop'",
  "Add-Type -AssemblyName System.Runtime.WindowsRuntime",
  "$null=[Windows.Storage.StorageFile,Windows.Storage,ContentType=WindowsRuntime]",
  "$null=[Windows.Media.Ocr.OcrEngine,Windows.Foundation,ContentType=WindowsRuntime]",
  "$null=[Windows.Graphics.Imaging.BitmapDecoder,Windows.Graphics,ContentType=WindowsRuntime]",
  "$asTask=([System.WindowsRuntimeSystemExtensions].GetMethods()|?{$_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'})[0]",
  "function Await($op,$t){$task=$asTask.MakeGenericMethod($t).Invoke($null,@($op));$task.Wait(-1)|Out-Null;$task.Result}",
  "$f=Await ([Windows.Storage.StorageFile]::GetFileFromPathAsync($env:OCR_IN)) ([Windows.Storage.StorageFile])",
  "$s=Await ($f.OpenAsync([Windows.Storage.FileAccessMode]::Read)) ([Windows.Storage.Streams.IRandomAccessStream])",
  "$d=Await ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($s)) ([Windows.Graphics.Imaging.BitmapDecoder])",
  "$b=Await ($d.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])",
  "$e=[Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages()",
  "$r=Await ($e.RecognizeAsync($b)) ([Windows.Media.Ocr.OcrResult])",
  "[Console]::OutputEncoding=[Text.Encoding]::UTF8",
  "($r.Lines|%{$_.Text}) -join \"`n\"",
].join(";");

function ocrPng(dataB64) {
  if (process.platform !== "win32") return Promise.resolve({ ok: false, error: "local OCR is Windows-only in this build" });
  const file = tempFile({ dataB64 }, "png");
  return new Promise((resolve) => {
    require("node:child_process").execFile("powershell.exe",
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", OCR_PS],
      { env: { ...process.env, OCR_IN: file }, windowsHide: true, timeout: 20_000, maxBuffer: 4 * 1024 * 1024 },
      (error, stdout, stderr) => {
        fs.unlink(file, () => {});
        if (error) resolve({ ok: false, error: `OCR failed: ${String(stderr || error.message).trim().slice(0, 160)}` });
        else resolve({ ok: true, text: String(stdout || "").trim() });
      });
  });
}

/**
 * A small pill at the top of the screen that says which layer has the mouse. It takes the
 * keyboard when shown, so Esc (or a click on it) leaves -- no global Esc grab, which
 * would steal Esc from every app (shortcuts.test: only the registry binds global keys).
 */
function makePill(text, onLeave) {
  const { BrowserWindow, screen } = electron();
  const area = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea;
  const width = 440;
  const pill = new BrowserWindow({
    x: area.x + Math.round((area.width - width) / 2), y: area.y + 10, width, height: 38,
    frame: false, transparent: true, resizable: false, movable: false, focusable: true,
    skipTaskbar: true, hasShadow: false, show: false,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  pill.setAlwaysOnTop(true, "screen-saver");
  const html = `<!doctype html><meta charset="utf-8"><title>pill</title><style>html,body{margin:0;background:transparent;overflow:hidden}
div{margin:3px auto;width:max-content;font:600 12.5px Segoe UI,system-ui;color:#0d1117;background:#7cc4ff;padding:7px 14px;border-radius:999px;box-shadow:0 2px 12px rgba(0,0,0,.4);cursor:pointer}</style>
<div onclick="document.title='leave'">${text}</div>`;
  let left = false;
  const leave = () => { if (!left) { left = true; onLeave(); } };
  pill.webContents.on("page-title-updated", (_e, title) => { if (title === "leave") leave(); });
  pill.webContents.on("before-input-event", (_e, input) => { if (input.type === "keyDown" && input.key === "Escape") leave(); });
  void pill.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
  pill.once("ready-to-show", () => { pill.show(); pill.focus(); });
  return pill;
}

let presenter = null;
function stopPresenting() {
  if (!presenter) return { ok: true, line: "not presenting" };
  if (presenter.win && !presenter.win.isDestroyed()) presenter.win.close();
  if (presenter.pill && !presenter.pill.isDestroyed()) presenter.pill.close();
  if (presenter.laser) run2("ink.laser");
  presenter = null;
  return { ok: true, line: "presentation ended" };
}

async function startPresenting(rectArg) {
  if (presenter) return stopPresenting();
  const rect = rectArg || await pickRegion();
  if (!rect) return { ok: false, error: "no region picked" };
  const { BrowserWindow, screen } = electron();
  const display = screen.getDisplayMatching(rect);
  const b = display.bounds;
  const win = new BrowserWindow({
    ...b, frame: false, transparent: true, resizable: false, movable: false, focusable: false,
    skipTaskbar: true, hasShadow: false, enableLargerThanScreen: true, show: false,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  win.setAlwaysOnTop(true, "screen-saver");
  win.setIgnoreMouseEvents(true);
  const r = { x: rect.x - b.x, y: rect.y - b.y, w: rect.width, h: rect.height };
  const html = `<!doctype html><meta charset="utf-8"><style>html,body{margin:0;height:100%;overflow:hidden;background:transparent}
#hole{position:absolute;left:${r.x}px;top:${r.y}px;width:${r.w}px;height:${r.h}px;box-shadow:0 0 0 99999px rgba(0,0,0,.55);outline:2px solid #7cc4ff;border-radius:4px}
#tag{position:absolute;left:${r.x}px;top:${Math.max(0, r.y - 26)}px;font:12px Segoe UI,system-ui;color:#e6e8eb;background:#171b21;padding:3px 8px;border-radius:6px}</style>
<div id="hole"></div>`;
  void win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
  win.once("ready-to-show", () => win.showInactive());
  presenter = { win, rect, laser: true, pill: makePill("Presenting · laser on · Esc or click to end", () => stopPresenting()) };
  run2("ink.laser");
  return { ok: true, line: "presenting -- Esc ends" };
}

function run2(id, arg) {
  if (typeof deps.runCommand !== "function") return { ok: false, error: "commands not wired" };
  try { return deps.runCommand(id, arg) || { ok: true }; } catch (error) { return { ok: false, error: String(error && error.message || error) }; }
}

async function boxRegion() {
  const rect = await pickRegion();
  if (!rect) return { ok: false, error: "no region picked" };
  const { screen } = electron();
  const area = screen.getDisplayMatching(rect).workArea;
  const w = 520;
  const h = 600;
  const right = rect.x + rect.width + 12;
  const x = right + w <= area.x + area.width ? right : Math.max(area.x + 8, rect.x - w - 12);
  const y = Math.min(Math.max(rect.y, area.y + 8), area.y + area.height - h - 8);
  return openTool("region", { rect, bounds: { x: Math.round(x), y: Math.round(y), width: w, height: h } });
}

// ── interact mode ───────────────────────────────────────────────────────────────

let interact = { on: false, pill: null };
function interactMode() {
  return interact.on;
}

function setInteract(on) {
  if (on === interact.on) return { ok: true, on };
  interact.on = on;
  try { if (typeof deps.setForceInteractive === "function") deps.setForceInteractive(on); } catch { /* best effort */ }
  if (on) {
    interact.pill = makePill("Interact mode · the desk has the mouse · Esc, Ctrl+Alt+Y or click to leave", () => setInteract(false));
  } else {
    if (interact.pill && !interact.pill.isDestroyed()) interact.pill.close();
    interact.pill = null;
  }
  return { ok: true, on, line: on ? "interact mode on -- Esc leaves" : "interact mode off -- clicks reach your desktop" };
}

// ── sticky notes + Song Studio + graphics ───────────────────────────────────────

function newSticky(text = "") {
  const ws = activeWorkspace();
  const pins = require("./pins-window.cjs");
  const pinsCore = require("./pins-core.cjs");
  const card = pinsCore.normalizeRecord({ kind: "note", src: String(text || " ").slice(0, 20000), title: "Note",
    extra: { workspace: ws.key, color: pinsCore.NOTE_COLORS[0] } });
  if (!card) return { ok: false, error: "the note did not read back" };
  const v = pins.addPin(card);
  return v.ok ? { ok: true, line: `sticky note pinned (${ws.name})` } : { ok: false, error: v.reason };
}

function mfKey() {
  try {
    return fs.readFileSync(process.env.MF_OWNER_KEY_FILE || path.join(deps.homeDir(), ".aither", "media-forge", "owner.key"), "utf8").trim();
  } catch {
    return "";
  }
}

async function mf(pathname, init = {}) {
  const key = mfKey();
  if (!key) return { ok: false, error: "Media Forge is not set up on this machine (no owner key)" };
  try {
    const res = await deps.fetchImpl(`${deps.mediaForge()}${pathname}`, {
      ...init, headers: { ...(init.headers || {}), "X-MF-Owner-Key": key }, signal: AbortSignal.timeout(init.timeoutMs || 30_000),
    });
    const data = await res.json().catch(() => null);
    if (!res.ok || (data && data.ok === false)) {
      return { ok: false, error: `Media Forge: ${(data && (data.error || data.detail)) || `HTTP ${res.status}`}`.slice(0, 200) };
    }
    return { ok: true, data };
  } catch (error) {
    return { ok: false, error: `Media Forge is not running (${String((error && error.message) || error).slice(0, 80)})` };
  }
}

async function songSeed(arg) {
  const a = arg && typeof arg === "object" ? arg : {};
  if (typeof a.wavB64 !== "string" || !a.wavB64) return { ok: false, error: "no melody to seed" };
  const name = `desk-seed-${Date.now().toString(36)}`;
  const form = new FormData();
  form.append("name", name);
  form.append("lyrics", "(instrumental seed from the desk's piano pad)");
  form.append("title", "Desk melody seed");
  const made = await mf("/api/song-studio/projects", { method: "POST", body: form });
  if (!made.ok) return made;
  const up = new FormData();
  up.append("kind", "beat");
  up.append("file", new Blob([Buffer.from(a.wavB64, "base64")], { type: "audio/wav" }), "seed.wav");
  const sent = await mf(`/api/song-studio/projects/${encodeURIComponent(name)}/upload`, { method: "POST", body: up });
  if (!sent.ok) return sent;
  if (typeof a.midiB64 === "string" && a.midiB64) {
    try { saveBytes(activeWorkspace(), "piano", `${name}.mid`, Buffer.from(a.midiB64, "base64")); } catch { /* the seed still went */ }
  }
  return { ok: true, line: `Song Studio project "${name}" seeded with the melody` };
}

async function graphicsApply(arg) {
  const a = arg && typeof arg === "object" ? arg : {};
  const action = core.graphicsAction(a.action);
  if (!action) return { ok: false, error: "unknown action" };
  if (typeof a.dataB64 !== "string" || !a.dataB64) return { ok: false, error: "no image" };
  const { nativeImage } = electron();
  const img = nativeImage.createFromBuffer(Buffer.from(a.dataB64, "base64"));
  if (img.isEmpty()) return { ok: false, error: "that image did not decode" };
  if (action.id === "resize") {
    const dims = core.resizeDims(img.getSize(), { width: a.width, height: a.height, scale: a.scale });
    const out = img.resize({ width: dims.width, height: dims.height, quality: "best" });
    return { ok: true, dataB64: out.toPNG().toString("base64"), mime: "image/png", line: `resized to ${dims.width}x${dims.height}` };
  }
  if (action.id === "convert") {
    const fmt = String(a.format || "png").toLowerCase();
    if (fmt === "jpg" || fmt === "jpeg") return { ok: true, dataB64: img.toJPEG(Math.min(100, Math.max(10, Number(a.quality) || 90))).toString("base64"), mime: "image/jpeg", line: "converted to JPEG" };
    return { ok: true, dataB64: img.toPNG().toString("base64"), mime: "image/png", line: "converted to PNG" };
  }
  // Media Forge on THIS machine. BYO-pay: no provider key is ever attached, so only the
  // local ComfyUI lane can run it; a paid-only op comes back refused, never billed.
  const form = new FormData();
  form.append("file", new Blob([img.toPNG()], { type: "image/png" }), "desk.png");
  const up = await mf("/api/upload", { method: "POST", body: form });
  if (!up.ok) return up;
  const mediaId = up.data && up.data.id;
  const q = await mf(`/api/op/${action.mf}/async`, { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ image: mediaId, ...action.params }) });
  if (!q.ok) return q;
  const jobId = q.data && q.data.job_id;
  const deadline = Date.now() + 10 * 60_000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 2000));
    const j = await mf(`/op/jobs/${encodeURIComponent(jobId)}`);
    if (!j.ok) return j;
    const st = j.data || {};
    if (st.state === "failed" || st.error) return { ok: false, error: `Media Forge: ${String(st.error || "failed").slice(0, 160)}` };
    if (st.state === "done" || st.state === "succeeded" || st.result) {
      const result = st.result || st;
      const url = (result.images && result.images[0]) || (result.urls && result.urls[0]) || null;
      const href = typeof url === "string" ? url : (url && (url.url || url.src));
      if (!href) return { ok: false, error: "Media Forge finished with no image" };
      const key = mfKey();
      const res = await deps.fetchImpl(href.startsWith("http") ? href : `${deps.mediaForge()}${href}`, { headers: { "X-MF-Owner-Key": key } });
      if (!res.ok) return { ok: false, error: `result fetch HTTP ${res.status}` };
      const bytes = Buffer.from(await res.arrayBuffer());
      return { ok: true, dataB64: bytes.toString("base64"), mime: "image/png", line: `${action.label} done (local GPU)` };
    }
  }
  return { ok: false, error: "Media Forge took over 10 minutes -- the job keeps running there" };
}

async function graphicsOpen(arg) {
  let file = String(arg || "").trim();
  if (!file) {
    const { dialog } = electron();
    const last = typeof deps.lastCapture === "function" ? deps.lastCapture() : null;
    const pick = await dialog.showOpenDialog({ title: "Edit an image", defaultPath: last || undefined,
      filters: [{ name: "Images", extensions: ["png", "jpg", "jpeg", "webp", "gif"] }], properties: ["openFile"] });
    if (pick.canceled || !pick.filePaths.length) return { ok: false, error: "no image picked" };
    file = pick.filePaths[0];
  }
  if (!fs.existsSync(file)) return { ok: false, error: "that file is gone" };
  const payload = payloadFromFile(file);
  if (payload.error) return { ok: false, error: payload.error };
  return openTool("graphics", { image: payload });
}

// ── IPC ─────────────────────────────────────────────────────────────────────────

async function callVerb(entry, verb, arg) {
  switch (verb) {
    case "song.seed": return songSeed(arg);
    case "graphics.apply": return graphicsApply(arg);
    case "graphics.image": return entry.data && entry.data.image ? { ok: true, ...entry.data.image } : { ok: false, error: "no image" };
    case "region.rect": return entry.data && entry.data.rect ? { ok: true, rect: entry.data.rect } : { ok: false, error: "no region" };
    case "region.frame": return entry.data && entry.data.rect ? grabRegion(entry.data.rect) : { ok: false, error: "no region" };
    case "region.ocr": {
      const f = entry.data && entry.data.rect ? await grabRegion(entry.data.rect) : { ok: false, error: "no region" };
      return f.ok ? ocrPng(f.dataB64) : f;
    }
    case "region.rebox": {
      const rect = await pickRegion();
      if (!rect) return { ok: false, error: "no region picked" };
      entry.data.rect = rect;
      return { ok: true, rect };
    }
    case "region.present": return startPresenting(entry.data && entry.data.rect);
    case "region.record": return run2("record.region");
    case "pin.image": {
      if (!arg || typeof arg.dataB64 !== "string") return { ok: false, error: "no image" };
      const v = require("./pins-window.cjs").addPin({ kind: "image", src: `data:image/png;base64,${arg.dataB64}`, title: String(arg.title || "Region") });
      return v.ok ? { ok: true, line: "pinned to the desktop" } : { ok: false, error: v.reason };
    }
    case "sticky": return newSticky(arg && arg.text);
    default: return { ok: false, error: `unknown call ${String(verb).slice(0, 40)}` };
  }
}

function ensureIpc() {
  if (wired) return;
  wired = true;
  const { ipcMain } = electron();
  const guard = (fn) => async (event, ...args) => {
    const entry = entryFor(event);
    if (!entry) return { ok: false, error: "not a toolkit window" };
    try { return await fn(entry, ...args); } catch (error) { return { ok: false, error: String((error && error.message) || error).slice(0, 200) }; }
  };
  ipcMain.handle("toolkit:info", guard((entry) => ({
    ok: true, tool: entry.tool, workspace: entry.workspace, targets: core.publicTargets(true),
    graphics: entry.tool === "graphics" ? core.GRAPHICS.map((g) => ({ id: g.id, label: g.label, local: Boolean(g.local) })) : undefined,
  })));
  ipcMain.handle("toolkit:send", guard((entry, target, payload) => sendTo(target, payload, entry.workspace)));
  ipcMain.handle("toolkit:save", guard((entry, payload) => doSave(entry, payload)));
  ipcMain.handle("toolkit:copy", guard((_entry, payload) => doCopy(payload)));
  ipcMain.handle("toolkit:run", guard((_entry, id, arg) => {
    // Pages may run desk commands from the menu's own list only.
    if (!core.MENU_IDS.includes(id) && !["ink.laser", "ink.clear", "record.region"].includes(id)) {
      return { ok: false, error: `${id} is not a toolkit command` };
    }
    return run(id, arg);
  }));
  ipcMain.handle("toolkit:ask", guard((_entry, question, imageB64) => (imageB64
    ? askAither({ kind: "image", mime: "image/png", dataB64: imageB64 }, question)
    : askAither({ kind: "text", text: "" }, question))));
  ipcMain.handle("toolkit:call", guard((entry, verb, arg) => callVerb(entry, verb, arg)));
  ipcMain.handle("toolkit:close", guard((entry) => { if (!entry.win.isDestroyed()) entry.win.close(); return { ok: true }; }));
}

/** The commands this module owns; main's runCommand hands them here. */
const OWNED = Object.freeze(["sketch.new", "piano.open", "scratch.new", "sticky.new", "graphics.open", "region.box",
  "present.start", "present.stop", "send.last", "interact.toggle", "voice.mute"]);

function handles(id) {
  return OWNED.includes(String(id || ""));
}

function run(id, arg) {
  switch (id) {
    case "sketch.new": return openTool("sketch");
    case "piano.open": return openTool("piano");
    case "scratch.new": return openTool("scratch", { text: typeof arg === "string" ? arg : "" });
    case "sticky.new": return newSticky(typeof arg === "string" ? arg : "");
    case "graphics.open": return graphicsOpen(arg);
    case "region.box": return boxRegion();
    case "present.start": return startPresenting(null);
    case "present.stop": return stopPresenting();
    case "send.last": return sendLast(arg);
    case "interact.toggle": return setInteract(!interact.on);
    case "voice.mute": return run2("audio.mic.mute");
    default: return run2(id, arg);
  }
}

/** A spoken utterance -> {id, arg} when it is a desk command, else null. */
function voiceCommand(text) {
  return core.parseVoiceCommand(text);
}

module.exports = {
  configureToolkit, run, handles, OWNED, voiceCommand, interactMode, setInteract, sendTo, openTool,
  TOOLS, __windows: windows,
};
