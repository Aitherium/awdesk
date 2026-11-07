"use strict";

/**
 * snip-window.cjs -- the Electron half of the snipping tool: the frozen overlay
 * per display, the crop, and the toast. It owns its IPC (the files-window.cjs
 * shape). All math, naming and saving live in snip-capture.cjs; uploads go
 * through strata-sync.cjs; [Ask Aither] runs drop-router's image lane (injected
 * by main as `askImage`, so this file grows no vision client of its own).
 *
 *   startSnip({mode:"region"})  PrintScreen: overlays, drag / Enter / Esc
 *   startSnip({mode:"screen"})  the display under the cursor, no overlay
 *
 * The overlays are opened AFTER the frames are captured, so they never appear in
 * their own screenshot. Each overlay knows only its own frame (a data URL handed
 * over IPC), and the renderer sends back a DIP rect -- the crop happens here,
 * against the full-resolution NativeImage.
 */

const path = require("node:path");
const core = require("./snip-capture.cjs");

function electron() {
  return require("electron");
}

let wired = false;
let deps = { askImage: null, onAnswer: null, enqueue: null, afterClipboard: null };
/** webContents.id -> {win, display, image} for the snip in progress. */
let overlays = new Map();
let busy = false;
let toastWin = null;
let toastInfo = null;
let toastTimer = null;
let lastCapture = null;

/**
 * main.cjs injects: askImage(filePath) -> verdict (drop-router routeDrop),
 * onAnswer(verdict) (speak + relay, the dropped-image path), enqueue(item)
 * (strata-sync queue), afterClipboard() (clipboard-sync adoptCurrent).
 */
function configureSnip(next = {}) {
  deps = { ...deps, ...next };
}

function closeOverlays() {
  for (const { win } of overlays.values()) {
    try { if (!win.isDestroyed()) win.destroy(); } catch { /* already gone */ }
  }
  overlays = new Map();
  busy = false;
}

function finish(entry, rectDip) {
  const { clipboard, app } = electron();
  const frame = entry.image.getSize();
  const crop = rectDip
    ? core.regionToDevice(rectDip, entry.display, frame)
    : { x: 0, y: 0, width: frame.width, height: frame.height };
  closeOverlays();
  if (!crop) return { ok: false, reason: "nothing selected" };
  const image = rectDip ? entry.image.crop(crop) : entry.image;
  return commit(image, app, clipboard);
}

function commit(image, app, clipboard) {
  const verdict = core.saveCapture({
    png: image.toPNG(),
    dir: core.screenshotDir({ picturesDir: safePictures(app) }),
    toClipboard: () => {
      clipboard.writeImage(image);
      try { if (deps.afterClipboard) deps.afterClipboard(); } catch { /* sync is optional */ }
    },
    enqueue: deps.enqueue || undefined,
  });
  if (verdict.ok) {
    lastCapture = verdict.path;
    showToast(verdict);
  } else {
    showToast({ ok: false, reason: verdict.reason });
  }
  return verdict;
}

function safePictures(app) {
  try { return app.getPath("pictures"); } catch { return undefined; }
}

/**
 * Save an image that is ALREADY in hand (the screen-ink overlay's "Save shot",
 * ink-window.cjs). It goes through the same commit as a Print Screen: the
 * Aither Screenshots folder, the clipboard, the toast and the Strata queue.
 */
function saveImage(image) {
  if (!image || image.isEmpty()) return { ok: false, reason: "the image is empty" };
  const { app, clipboard } = electron();
  return commit(image, app, clipboard);
}

async function captureFrames() {
  const { screen, desktopCapturer } = electron();
  const displays = screen.getAllDisplays();
  const sources = await desktopCapturer.getSources({
    types: ["screen"], thumbnailSize: core.thumbnailSizeFor(displays),
  });
  const frames = core.matchSources(displays, sources)
    .map(({ display, source }) => ({ display, image: source.thumbnail }))
    .filter((f) => f.image && !f.image.isEmpty());
  // A display desktopCapturer did not return (measured 2026-11-02: a 4K + 1080p
  // Windows desk got ONE source) is grabbed by GDI instead of borrowing a neighbour's.
  for (const display of displays) {
    if (frames.some((f) => f.display.id === display.id)) continue;
    const image = await nativeFrame(display);
    if (image && !image.isEmpty()) frames.push({ display, image });
  }
  return frames;
}

const NATIVE_GRAB_PS = [
  "$ErrorActionPreference='Stop'",
  "Add-Type -AssemblyName System.Drawing",
  "Add-Type -Namespace D -Name U -MemberDefinition '[DllImport(\"user32.dll\")] public static extern bool SetProcessDpiAwarenessContext(IntPtr c);'",
  "[void][D.U]::SetProcessDpiAwarenessContext([IntPtr](-4))",
  "$x=[int]$env:SNIP_X; $y=[int]$env:SNIP_Y; $w=[int]$env:SNIP_W; $h=[int]$env:SNIP_H",
  "$b=New-Object System.Drawing.Bitmap $w,$h",
  "$g=[System.Drawing.Graphics]::FromImage($b)",
  "$g.CopyFromScreen($x,$y,0,0,(New-Object System.Drawing.Size $w,$h))",
  "$b.Save($env:SNIP_OUT,[System.Drawing.Imaging.ImageFormat]::Png)",
].join("; ");

// A resident GDI grabber: one PowerShell kept warm so Print Screen does not pay a
// process start + Add-Type compile per press. Measured 2026-11-02 with the host CPU
// at 100 %: one-shot grab 2.5 s, warm grab 140-250 ms for a 4K screen. It writes raw
// BGRA (no PNG encode) that nativeImage.createFromBitmap takes as-is.
const GRAB_LOOP_PS = String.raw`$ErrorActionPreference='Stop'
Add-Type -AssemblyName System.Drawing
Add-Type -Namespace D -Name U -MemberDefinition '[DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr c);'
[void][D.U]::SetProcessDpiAwarenessContext([IntPtr](-4))
[Console]::Out.WriteLine('ready')
while ($null -ne ($line = [Console]::In.ReadLine())) {
  try {
    $p = $line.Split('|'); $x=[int]$p[0]; $y=[int]$p[1]; $w=[int]$p[2]; $h=[int]$p[3]; $out=$p[4]
    $b = New-Object System.Drawing.Bitmap $w,$h,([System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
    $g = [System.Drawing.Graphics]::FromImage($b)
    $g.CopyFromScreen($x,$y,0,0,(New-Object System.Drawing.Size $w,$h))
    $d = $b.LockBits((New-Object System.Drawing.Rectangle 0,0,$w,$h),[System.Drawing.Imaging.ImageLockMode]::ReadOnly,$b.PixelFormat)
    $buf = New-Object byte[] ($d.Stride*$h)
    [System.Runtime.InteropServices.Marshal]::Copy($d.Scan0,$buf,0,$buf.Length)
    $b.UnlockBits($d); $g.Dispose(); $b.Dispose()
    [System.IO.File]::WriteAllBytes($out,$buf)
    [Console]::Out.WriteLine('ok')
  } catch { [Console]::Out.WriteLine('err ' + $_.Exception.Message) }
}
`;
const GRAB_TIMEOUT_MS = 5000;
let grabber = null; // { child, ready: Promise<boolean>, waiters: [], chain: Promise }

function startGrabber() {
  if (grabber) return grabber;
  const os = require("node:os");
  const fs = require("node:fs");
  const script = path.join(os.tmpdir(), `aither-snip-grab-${process.pid}.ps1`);
  try { fs.writeFileSync(script, GRAB_LOOP_PS); } catch { return null; }
  const child = require("node:child_process").spawn("powershell.exe",
    ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", script],
    { windowsHide: true, stdio: ["pipe", "pipe", "ignore"] });
  const g = { child, waiters: [], chain: Promise.resolve(), ready: null };
  let buf = "";
  let onReady;
  g.ready = new Promise((resolve) => { onReady = resolve; });
  child.stdout.on("data", (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (line === "ready") onReady(true);
      else if (g.waiters.length) g.waiters.shift()(line);
    }
  });
  const dead = () => {
    onReady(false);
    for (const w of g.waiters.splice(0)) w("err grabber exited");
    if (grabber === g) grabber = null;
    try { fs.unlinkSync(script); } catch { /* temp */ }
  };
  child.on("error", dead);
  child.on("exit", dead);
  grabber = g;
  return g;
}

/** Start the warm grabber ahead of the first Print Screen (Windows, several displays). */
function warmNativeGrabber() {
  if (process.platform !== "win32") return false;
  try { if (electron().screen.getAllDisplays().length < 2) return false; } catch { return false; }
  return Boolean(startGrabber());
}

/** One display via the warm grabber, as a nativeImage, or null (caller falls back). */
function grabWarm(rect) {
  const g = startGrabber();
  if (!g) return Promise.resolve(null);
  const run = async () => {
    if (!(await g.ready)) return null;
    const os = require("node:os");
    const fs = require("node:fs");
    const out = path.join(os.tmpdir(), `aither-snip-${process.pid}-${rect.x}_${rect.y}.raw`);
    const width = Math.round(rect.width);
    const height = Math.round(rect.height);
    const answer = await new Promise((resolve) => {
      const timer = setTimeout(() => { resolve("err timeout"); try { g.child.kill(); } catch { /* gone */ } }, GRAB_TIMEOUT_MS);
      g.waiters.push((line) => { clearTimeout(timer); resolve(line); });
      try { g.child.stdin.write(`${Math.round(rect.x)}|${Math.round(rect.y)}|${width}|${height}|${out}\n`); } catch { resolve("err stdin"); }
    });
    let image = null;
    try {
      if (answer === "ok") image = electron().nativeImage.createFromBitmap(fs.readFileSync(out), { width, height });
    } catch { image = null; }
    try { fs.unlinkSync(out); } catch { /* nothing written */ }
    if (answer !== "ok") console.warn(`[snip] warm grab failed: ${answer}`);
    return image;
  };
  const result = g.chain.then(run, run);
  g.chain = result.catch(() => null);
  return result;
}

/** One display's pixels via GDI (Windows only): the warm grabber, else a one-shot PowerShell. */
async function nativeFrame(display) {
  if (process.platform !== "win32") return null;
  let rect;
  try { rect = electron().screen.dipToScreenRect(null, display.bounds); } catch { rect = display.bounds; }
  const warm = await grabWarm(rect).catch(() => null);
  if (warm && !warm.isEmpty()) return warm;
  return nativeFrameOnce(display);
}

/** One display's pixels via a one-shot GDI PowerShell, as a nativeImage, or null. Never rejects. */
function nativeFrameOnce(display) {
  if (process.platform !== "win32") return Promise.resolve(null);
  const { screen, nativeImage } = electron();
  const os = require("node:os");
  const fs = require("node:fs");
  let rect;
  try { rect = screen.dipToScreenRect(null, display.bounds); } catch { rect = display.bounds; }
  const out = path.join(os.tmpdir(), `aither-snip-${process.pid}-${display.id}.png`);
  const env = { ...process.env, SNIP_X: String(rect.x), SNIP_Y: String(rect.y),
    SNIP_W: String(rect.width), SNIP_H: String(rect.height), SNIP_OUT: out };
  return new Promise((resolve) => {
    require("node:child_process").execFile("powershell.exe",
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", NATIVE_GRAB_PS],
      { env, windowsHide: true, timeout: 8000 },
      (error) => {
        let image = null;
        try { if (!error) image = nativeImage.createFromBuffer(fs.readFileSync(out)); } catch { image = null; }
        try { fs.unlinkSync(out); } catch { /* nothing written */ }
        if (error) console.warn(`[snip] native grab of display ${display.id} failed: ${error.message}`);
        resolve(image);
      });
  });
}

/**
 * Begin a snip. Resolves {ok:true, pending} for region mode (the overlay is up),
 * the saveCapture verdict for screen mode, or {ok:false, reason}. Never rejects.
 */
async function startSnip({ mode = "region" } = {}) {
  if (busy) return { ok: false, reason: "a snip is already open" };
  busy = true;
  try {
    ensureSnipIpc();
    const frames = await captureFrames();
    if (!frames.length) {
      busy = false;
      return { ok: false, reason: "no screen could be captured (screen-recording permission?)" };
    }
    if (mode === "screen") {
      const { screen, app, clipboard } = electron();
      const here = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
      const frame = frames.find((f) => f.display.id === here.id) || frames[0];
      busy = false;
      return commit(frame.image, app, clipboard);
    }
    const { BrowserWindow } = electron();
    for (const frame of frames) {
      const { bounds } = frame.display;
      const win = new BrowserWindow({
        x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height,
        frame: false, transparent: true, resizable: false, movable: false,
        minimizable: false, maximizable: false, fullscreenable: false,
        skipTaskbar: true, hasShadow: false, enableLargerThanScreen: true, show: false,
        webPreferences: {
          preload: path.join(__dirname, "snip-preload.cjs"),
          contextIsolation: true, nodeIntegration: false, sandbox: true,
        },
      });
      win.setAlwaysOnTop(true, "screen-saver");
      win.setBounds(bounds);
      win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
      win.webContents.on("will-navigate", (event) => event.preventDefault());
      const wcId = win.webContents.id;
      overlays.set(wcId, { win, display: frame.display, image: frame.image });
      win.once("ready-to-show", () => { win.show(); win.focus(); });
      win.on("closed", () => {
        overlays.delete(wcId);
        if (!overlays.size) busy = false;
      });
      void win.loadFile(path.join(__dirname, "snip.html"));
    }
    return { ok: true, pending: true };
  } catch (error) {
    closeOverlays();
    return { ok: false, reason: `snip failed: ${String((error && error.message) || error).slice(0, 200)}` };
  }
}

function showToast(info) {
  const { BrowserWindow, screen } = electron();
  toastInfo = info;
  if (toastTimer) clearTimeout(toastTimer);
  const area = screen.getPrimaryDisplay().workArea;
  const width = 380;
  const height = 92;
  const bounds = { x: area.x + area.width - width - 16, y: area.y + area.height - height - 16, width, height };
  if (!toastWin || toastWin.isDestroyed()) {
    toastWin = new BrowserWindow({
      ...bounds, frame: false, transparent: true, resizable: false, movable: false,
      skipTaskbar: true, focusable: false, show: false, alwaysOnTop: true,
      webPreferences: {
        preload: path.join(__dirname, "snip-preload.cjs"),
        contextIsolation: true, nodeIntegration: false, sandbox: true,
      },
    });
    toastWin.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    toastWin.webContents.on("will-navigate", (event) => event.preventDefault());
    toastWin.once("ready-to-show", () => toastWin && !toastWin.isDestroyed() && toastWin.showInactive());
    void toastWin.loadFile(path.join(__dirname, "snip-toast.html"));
  } else {
    toastWin.setBounds(bounds);
    toastWin.webContents.send("snip:toast-update", publicToast());
    toastWin.showInactive();
  }
  armToastTimer();
}

function armToastTimer(ms = 8000) {
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    if (toastWin && !toastWin.isDestroyed()) toastWin.hide();
  }, ms);
}

/** What the toast page may see: a name and a state, never a token or a full verdict. */
function publicToast() {
  if (!toastInfo) return null;
  if (!toastInfo.ok) return { ok: false, reason: String(toastInfo.reason || "") };
  return {
    ok: true,
    name: toastInfo.name || path.basename(toastInfo.path || ""),
    queued: Boolean(toastInfo.queued),
    status: toastInfo.status || null,
    note: toastInfo.note ? String(toastInfo.note).slice(0, 300) : null,
  };
}

async function toastAction(action) {
  const { clipboard, shell } = electron();
  const file = toastInfo && toastInfo.ok ? toastInfo.path : null;
  if (!file) return { ok: false, reason: "no screenshot" };
  if (action === "copy-path") {
    clipboard.writeText(file);
    return { ok: true };
  }
  if (action === "open-folder") {
    shell.showItemInFolder(file);
    return { ok: true };
  }
  if (action === "ask") {
    if (typeof deps.askImage !== "function") return { ok: false, reason: "vision lane not wired" };
    toastInfo = { ...toastInfo, status: "Asking Aither…" };
    if (toastWin && !toastWin.isDestroyed()) toastWin.webContents.send("snip:toast-update", publicToast());
    armToastTimer(60_000);
    const verdict = await deps.askImage(file);
    toastInfo = { ...toastInfo, status: verdict && verdict.ok ? "Aither answered in chat" : `Ask failed: ${String((verdict && verdict.reason) || "no answer").slice(0, 120)}` };
    if (toastWin && !toastWin.isDestroyed()) toastWin.webContents.send("snip:toast-update", publicToast());
    armToastTimer(6000);
    try { if (verdict && verdict.ok && deps.onAnswer) deps.onAnswer(verdict); } catch { /* the answer was still shown */ }
    return verdict && verdict.ok ? { ok: true } : { ok: false, reason: (verdict && verdict.reason) || "no answer" };
  }
  if (action === "dismiss") {
    if (toastWin && !toastWin.isDestroyed()) toastWin.hide();
    return { ok: true };
  }
  return { ok: false, reason: `unknown action ${action}` };
}

function rectFrom(raw) {
  if (!raw || typeof raw !== "object") return null;
  const n = (v) => (Number.isFinite(Number(v)) ? Number(v) : NaN);
  const rect = { x: n(raw.x), y: n(raw.y), width: n(raw.width), height: n(raw.height) };
  return Object.values(rect).every(Number.isFinite) ? rect : null;
}

function ensureSnipIpc() {
  if (wired) return;
  wired = true;
  const { ipcMain } = electron();
  ipcMain.handle("snip:frame", (event) => {
    const entry = overlays.get(event.sender.id);
    if (!entry) return { ok: false, reason: "no snip in progress" };
    return { ok: true, dataUrl: entry.image.toDataURL(), width: entry.display.bounds.width, height: entry.display.bounds.height };
  });
  ipcMain.handle("snip:select", (event, raw) => {
    const entry = overlays.get(event.sender.id);
    if (!entry) return { ok: false, reason: "no snip in progress" };
    const rect = rectFrom(raw);
    if (!core.isRegion(rect)) return { ok: false, reason: "region too small" };
    return finish(entry, rect);
  });
  ipcMain.handle("snip:full", (event) => {
    const entry = overlays.get(event.sender.id);
    if (!entry) return { ok: false, reason: "no snip in progress" };
    return finish(entry, null);
  });
  ipcMain.handle("snip:cancel", () => {
    closeOverlays();
    return { ok: true };
  });
  ipcMain.handle("snip:toast-info", () => publicToast());
  ipcMain.handle("snip:toast-action", (_event, action) => toastAction(String(action || "")));
}

/** The last saved screenshot's path (main-process callers only). */
function lastScreenshot() {
  return lastCapture;
}

// ── The capture runtime main.cjs starts once: queue + clipboard mirror + PrtSc ──
let queue = null;
let clipSync = null;
let prtscOwner = "unknown";

function regExe(args) {
  return new Promise((resolve) => {
    if (process.platform !== "win32") return resolve({ ok: false, stdout: "", reason: "not Windows" });
    require("node:child_process").execFile("reg.exe", args, { windowsHide: true, timeout: 10_000 }, (error, stdout) => {
      resolve({ ok: !error, stdout: String(stdout || ""), reason: error ? String(error.message || error).slice(0, 200) : null });
    });
  });
}

async function refreshPrintScreenOwner() {
  const r = await regExe(core.printScreenQueryArgs());
  // `reg query` exits 1 when the value is absent: that is "unset", not an error.
  prtscOwner = process.platform === "win32" ? core.parsePrintScreenQuery(r.stdout) : "n/a";
  return prtscOwner;
}

/** "aither" | "snipping" | "unset" | "unknown" | "n/a" -- the tray rows read it. */
function printScreenOwner() {
  return prtscOwner;
}

/**
 * Flip HKCU PrintScreenKeyForSnippingEnabled. `owner` "aither" writes 0, "snipping"
 * writes 1. The owner's tray click is the consent; the twin row reverses it.
 */
async function setPrintScreenOwner(owner) {
  const r = await regExe(core.printScreenRegArgs(owner !== "aither"));
  await refreshPrintScreenOwner();
  if (!r.ok) console.warn(`[snip] could not set ${core.PRTSC_VALUE}: ${r.reason}`);
  return { ok: r.ok, owner: prtscOwner, reason: r.reason };
}

function clipboardSyncOn() {
  return require("./clipboard-sync.cjs").syncEnabled();
}

/** The tray / palette switch. Persists to cast.json; the poll picks it up next tick. */
function toggleClipboardSync() {
  const cs = require("./clipboard-sync.cjs");
  const on = !cs.syncEnabled();
  try {
    cs.setSyncEnabled(on);
  } catch (error) {
    console.warn(`[clipboard-sync] ${String((error && error.message) || error)}`);
    return { ok: false, reason: String((error && error.message) || error) };
  }
  // Turning ON must not backfill whatever was copied an hour ago.
  if (on && clipSync) clipSync.adoptCurrent();
  return { ok: true, on };
}

/**
 * Start once from app.whenReady: the durable upload queue, the clipboard poll
 * (a no-op every tick while cast.json clipboard.sync is off), the PrtSc state.
 *
 * @param {{askImage?: Function, onAnswer?: Function}} wiring
 */
function startCapture({ askImage, onAnswer } = {}) {
  const sync = require("./strata-sync.cjs");
  const cs = require("./clipboard-sync.cjs");
  if (!queue) {
    queue = sync.createUploadQueue({
      onEvent: ({ type, job, verdict }) => {
        if (type === "uploaded") return;
        // Name + folder + reason only: never the payload, never the token.
        console.warn(`[strata-sync] ${type} ${job.folder}/${job.name}: ${(verdict && verdict.reason) || ""}`);
      },
    });
    queue.start();
  }
  if (!clipSync) {
    clipSync = cs.createClipboardSync({
      read: cs.electronReader(electron().clipboard),
      enqueue: (item) => queue.enqueue(item),
      enabled: cs.syncEnabled,
    });
    clipSync.start();
  }
  configureSnip({
    askImage, onAnswer,
    enqueue: (item) => queue.enqueue(item),
    afterClipboard: () => clipSync && clipSync.adoptCurrent(),
  });
  ensureSnipIpc();
  void refreshPrintScreenOwner();
  return { ok: true };
}

/**
 * Queue one upload through the SAME strata-sync queue the snipping tool uses.
 * Added for the boards (notes/whiteboards) so they never invent a second queue
 * or a second Strata folder. Returns {ok, id} | {ok:false, reason}; before
 * startCapture it says so instead of throwing.
 */
function enqueueUpload(item) {
  if (!deps.enqueue) return { ok: false, reason: "the sync queue is not running" };
  try {
    return deps.enqueue(item);
  } catch (error) {
    return { ok: false, reason: String((error && error.message) || error).slice(0, 200) };
  }
}

module.exports = {
  configureSnip, startSnip, ensureSnipIpc, lastScreenshot, closeOverlays,
  startCapture, toggleClipboardSync, clipboardSyncOn, printScreenOwner, setPrintScreenOwner,
  refreshPrintScreenOwner, nativeFrame, warmNativeGrabber, enqueueUpload, saveImage,
};
