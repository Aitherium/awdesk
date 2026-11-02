"use strict";

/**
 * recorder-window.cjs -- the Electron half of the screen recorder: the region
 * overlay, the floating control bar, the toast, and the owner of their IPC (the
 * snip-window.cjs shape). Math, naming, ffmpeg argv and finalising live in
 * recorder-core.cjs; uploads go through strata-sync.cjs; [Ask Aither] runs
 * drop-router's VIDEO lane (first frame -> vision), injected by main as
 * `askVideo`, so this file grows no vision client of its own.
 *
 *   startRecording({mode:"region"})  snip.html overlay per display -> drag / Enter
 *   startRecording({mode:"screen"})  the display under the cursor, no overlay
 *   stopRecording() / togglePause()  what the bar's buttons and the hotkey call
 *
 * THE OVERLAY IS THE SNIPPING TOOL'S. snip.html is loaded unchanged with
 * recorder-preload.cjs, which exposes the same `window.aitherSnip` API the page
 * calls but routes it to `recorder:region-*` channels -- so the selection UI has
 * ONE implementation, and a later snip.html improvement reaches both tools.
 *
 * WHO RECORDS. recorder.html?view=bar is the control bar AND the recorder: it
 * runs getUserMedia(chromeMediaSourceId) + MediaRecorder(webm/vp9), crops on a
 * canvas when a region was picked (so a region is honoured even without ffmpeg),
 * and streams 1 s chunks here, where recorder-core's chunk writer appends them to
 * a temp file. The bar is setContentProtection(true): it never appears in its own
 * recording.
 *
 * CLOUD SYNC IS OPT-IN (recorder-core.cjs header): finish() queues an upload only
 * when deps.syncEnabled() says so (default: cast.json `recorder.sync === true`,
 * which is unset = off); otherwise the toast offers [Sync] for that one recording.
 * A queued upload on this module's own queue can be cancelled from the toast.
 *
 * COMMANDS DURING START-UP. A stop or pause that arrives while the bar is still
 * "starting" (page not loaded, getUserMedia pending) is HELD in
 * session.pendingCommand and delivered when the bar reports "recording"; a
 * webContents.send to a page that is not listening yet would be dropped.
 */

const os = require("node:os");
const path = require("node:path");
const core = require("./recorder-core.cjs");
const snip = require("./snip-capture.cjs");

function electron() {
  return require("electron");
}

const BAR_WIDTH = 340;
const BAR_HEIGHT = 44;
const TOAST_WIDTH = 400;
const TOAST_HEIGHT = 112;

let wired = false;
let deps = { askVideo: null, onAnswer: null, enqueue: null, ffmpeg: undefined, syncEnabled: null };
const SPOOL_DIR = path.join(os.homedir(), ".aither", "desk-sync-spool-recordings");
/** Queue ids the owner cancelled this run (belt to cancelSpooledJob's braces). */
const cancelledJobs = new Set();
/** webContents.id -> {win, display, image, source} while a region is being picked. */
let overlays = new Map();
/**
 * The one recording in flight:
 * {state, options, display, sourceId, cropDip, writer, startedAt, bar, segments}.
 * state: "selecting" | "starting" | "recording" | "paused" | "finishing".
 */
let session = null;
let toastWin = null;
let toastInfo = null;
let toastTimer = null;
let lastRecording = null;
let queue = null;

/**
 * main.cjs injects: askVideo(filePath) -> verdict (drop-router routeDrop with a
 * video mime), onAnswer(verdict) (announceDrop), and optionally enqueue(item) to
 * share a queue; otherwise this module keeps its own strata-sync queue on its
 * OWN spool directory (two queues on one spool would upload a job twice).
 * syncEnabled() -> boolean is the auto-sync opt-in; unset reads cast.json
 * `recorder.sync` through desk-settings and is OFF when the key is absent.
 */
function configureRecorder(next = {}) {
  deps = { ...deps, ...next };
}

/** Auto-upload every saved recording? Off unless the owner opted in. */
function autoSyncEnabled() {
  try {
    if (typeof deps.syncEnabled === "function") return deps.syncEnabled() === true;
    const c = require("./desk-settings.cjs").current();
    return Boolean(c && c.recorder && c.recorder.sync === true);
  } catch {
    return false; // an unreadable setting never turns an upload on
  }
}

function uploadQueue() {
  if (deps.enqueue) return { enqueue: deps.enqueue, pending: () => [], shared: true };
  if (!queue) {
    const sync = require("./strata-sync.cjs");
    queue = sync.createUploadQueue({
      spoolDir: SPOOL_DIR,
      // Size-scaled timeout + give-up-after-N-timeouts + cancel (recorder-core).
      upload: core.createRecordingUploader({
        uploadOnce: sync.uploadOnce,
        origin: () => sync.syncOrigin().origin,
        token: sync.defaultToken,
        isCancelled: (id) => cancelledJobs.has(id),
      }),
      onEvent: ({ type, job, verdict }) => {
        if (type === "uploaded") {
          if (toastInfo && toastInfo.ok && toastInfo.queueId === job.id) {
            toastInfo = { ...toastInfo, queued: false, syncNote: "Synced to AitherOS Online · Screenshots" };
            pushToast();
          }
          return;
        }
        // Name + folder + reason only: never the payload, never the token.
        console.warn(`[recorder-sync] ${type} ${job.folder}/${job.name}: ${(verdict && verdict.reason) || ""}`);
        if (type === "dropped" && toastInfo && toastInfo.ok && toastInfo.queueId === job.id) {
          const why = String((verdict && verdict.reason) || "dropped");
          toastInfo = {
            ...toastInfo, queued: false, queueId: null,
            syncNote: why === "sync cancelled" || why === "spooled payload vanished"
              ? "1 recording sync cancelled — kept on this PC"
              : `1 recording not synced — ${why.slice(0, 120)}`,
          };
          pushToast();
        }
      },
    });
    queue.start();
  }
  return queue;
}

/**
 * Cancel a queued recording upload. Only this module's own queue can: a shared
 * queue injected by main exposes no cancel. {ok:true} | {ok:false, reason}.
 */
function cancelQueued(id) {
  if (!id) return { ok: false, reason: "0 uploads queued for this recording" };
  if (deps.enqueue) return { ok: false, reason: "1 sync cannot be cancelled here — the shared desk queue has no cancel" };
  cancelledJobs.add(id);
  return core.cancelSpooledJob({ spoolDir: SPOOL_DIR, id });
}

function ffmpegPath() {
  return deps.ffmpeg !== undefined ? deps.ffmpeg : core.findFfmpeg();
}

/** execFile, hidden console, resolves {ok, reason}; never rejects. */
function runFfmpeg(bin, args) {
  return new Promise((resolve) => {
    require("node:child_process").execFile(bin, args,
      { windowsHide: true, timeout: core.FFMPEG_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024 },
      (error, _stdout, stderr) => resolve(error
        ? { ok: false, reason: String(stderr || error.message || error).trim().split(/\r?\n/).pop().slice(0, 200) }
        : { ok: true }));
  });
}

/**
 * The runner drop-router's video lane should use (routeDrop deps.ffmpeg): the
 * resolved binary, a hidden console. Its default spawns bare "ffmpeg" without
 * windowsHide, which flashes a console on Windows.
 */
function firstFrameRunner() {
  const bin = ffmpegPath() || "ffmpeg";
  return (args) => require("node:child_process").execFileSync(bin, args,
    { stdio: "ignore", timeout: 60_000, windowsHide: true });
}

function isRecording() {
  return Boolean(session && session.state !== "finishing");
}

function status() {
  if (!session) return { state: "idle" };
  return {
    state: session.state,
    format: session.options.format,
    elapsedMs: core.elapsedMs(session.segments),
    region: session.cropDip ? { width: session.cropDip.width, height: session.cropDip.height } : null,
  };
}

function closeOverlays() {
  for (const { win } of overlays.values()) {
    try { if (!win.isDestroyed()) win.destroy(); } catch { /* already gone */ }
  }
  overlays = new Map();
}

async function captureFrames() {
  const { screen, desktopCapturer } = electron();
  const displays = screen.getAllDisplays();
  const sources = await desktopCapturer.getSources({
    types: ["screen"], thumbnailSize: snip.thumbnailSizeFor(displays),
  });
  const frames = snip.matchSources(displays, sources)
    .map(({ display, source }) => ({ display, source, image: source.thumbnail }))
    .filter((f) => f.source && f.source.id);
  // A display desktopCapturer cannot see (the 5090's 4K screen while the desk is
  // pinned to the iGPU, measured 2026-11-02) records NATIVELY through ffmpeg gdigrab.
  if (!ffmpegPath()) return frames;
  for (const display of displays) {
    if (frames.some((f) => f.display.id === display.id)) continue;
    const image = await require("./snip-window.cjs").nativeFrame(display);
    if (image && !image.isEmpty()) frames.push({ display, source: null, image, native: true });
  }
  return frames;
}

// ── native (ffmpeg gdigrab) recording ───────────────────────────────────────

/** The session's capture rect in PHYSICAL virtual-desktop pixels. */
function nativeRect(display, cropDip) {
  const b = display.bounds;
  const dip = cropDip
    ? { x: b.x + cropDip.x, y: b.y + cropDip.y, width: cropDip.width, height: cropDip.height }
    : { ...b };
  try { return electron().screen.dipToScreenRect(null, dip); } catch { return dip; }
}

/** Start one gdigrab segment (on "recording"); ffmpeg writes until it reads "q". */
function nativeSegmentStart(s) {
  const n = s.native.parts.length;
  const output = path.join(os.tmpdir(), "aither-recorder-native", `nat-${s.native.stamp}-${n}.mkv`);
  try { require("node:fs").mkdirSync(path.dirname(output), { recursive: true }); } catch { /* temp exists */ }
  const args = core.nativeGrabArgs({ rect: s.native.rect, fps: s.options.fps, output });
  if (!args) return false;
  const child = require("node:child_process").spawn(ffmpegPath(), args, { windowsHide: true, stdio: ["pipe", "ignore", "pipe"] });
  let err = "";
  child.stderr.on("data", (d) => { err = (err + d).slice(-400); });
  const done = new Promise((resolve) => {
    child.on("error", (e) => resolve({ ok: false, reason: e.message }));
    child.on("close", (code) => resolve(code === 0 ? { ok: true } : { ok: false, reason: err.trim().split(/\r?\n/).pop() || `ffmpeg exit ${code}` }));
  });
  s.native.parts.push(output);
  s.native.live = { child, done };
  return true;
}

/** Stop the live segment (pause or stop); resolves when ffmpeg has closed the file. */
async function nativeSegmentStop(s) {
  const live = s.native && s.native.live;
  if (!live) return null;
  s.native.live = null;
  try { live.child.stdin.write("q"); live.child.stdin.end(); } catch { /* already exiting */ }
  const timer = setTimeout(() => { try { live.child.kill(); } catch { /* gone */ } }, 8000);
  const r = await live.done;
  clearTimeout(timer);
  return r;
}

/** Stop the last segment and join every segment into one file; returns its path or null. */
async function nativeAssemble(s) {
  await nativeSegmentStop(s);
  const fs = require("node:fs");
  const parts = s.native.parts.filter((p) => { try { return fs.statSync(p).size > 0; } catch { return false; } });
  if (parts.length <= 1) return parts[0] || null;
  const dir = path.dirname(parts[0]);
  const list = path.join(dir, `nat-${s.native.stamp}.txt`);
  const joined = path.join(dir, `nat-${s.native.stamp}-joined.mkv`);
  fs.writeFileSync(list, core.nativeConcatList(parts));
  const r = await runFfmpeg(ffmpegPath(), ["-hide_banner", "-loglevel", "error", "-f", "concat", "-safe", "0", "-i", list, "-c", "copy", "-y", joined]);
  try { fs.unlinkSync(list); } catch { /* temp */ }
  if (!r.ok) return parts[0];
  for (const p of parts) { try { fs.unlinkSync(p); } catch { /* temp */ } }
  return joined;
}

/**
 * Begin a recording. Resolves {ok:true, pending} (overlay or bar is up) or
 * {ok:false, reason}. Never rejects.
 *
 * @param {{mode?: "region"|"screen", format?: "mp4"|"gif"|"webm",
 *          systemAudio?: boolean, mic?: boolean, fps?: number}} [raw]
 */
async function startRecording(raw = {}) {
  if (session) return { ok: false, reason: `1 recording already ${session.state} — stop it from the bar first` };
  const options = core.normalizeOptions(raw);
  recoverLeftovers();
  session = { state: "selecting", options, segments: [] };
  try {
    ensureRecorderIpc();
    const frames = await captureFrames();
    if (!frames.length) {
      session = null;
      return fail("0 screens could be captured — allow screen recording for Aither and try again");
    }
    if (options.mode === "screen") {
      const { screen } = electron();
      const here = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
      const frame = frames.find((f) => f.display.id === here.id) || frames[0];
      return beginBar(frame, null);
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
          preload: path.join(__dirname, "recorder-preload.cjs"),
          contextIsolation: true, nodeIntegration: false, sandbox: true,
        },
      });
      win.setAlwaysOnTop(true, "screen-saver");
      win.setBounds(bounds);
      win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
      win.webContents.on("will-navigate", (event) => event.preventDefault());
      const wcId = win.webContents.id;
      overlays.set(wcId, { win, ...frame });
      win.once("ready-to-show", () => { win.show(); win.focus(); });
      win.on("closed", () => {
        overlays.delete(wcId);
        // Every overlay closed without a pick (Alt+F4, display unplugged): cancel.
        if (!overlays.size && session && session.state === "selecting") session = null;
      });
      // The snipping tool's own overlay page; the preload re-points its API here.
      void win.loadFile(path.join(__dirname, "snip.html"));
    }
    return { ok: true, pending: true };
  } catch (error) {
    closeOverlays();
    session = null;
    return fail(`1 recording could not start — ${String((error && error.message) || error).slice(0, 160)}`);
  }
}

function fail(reason) {
  showToast({ ok: false, reason });
  return { ok: false, reason };
}

function videosDirOrUndefined() {
  try { return electron().app.getPath("videos"); } catch { return undefined; }
}

/**
 * Temp WebMs a crash, a failed move or a refused start left behind are moved
 * into Videos/Aither Recordings (never deleted unseen) and named on a toast.
 * Runs only with no session, so no live recording's temp file is touched.
 */
function recoverLeftovers() {
  try {
    const dir = core.recordingDir({ videosDir: videosDirOrUndefined() });
    const swept = core.recoverStaleRecordings({ dir });
    const line = core.recoveredLine(swept);
    if (!line) return swept;
    const first = swept.recovered[0];
    showToast(first
      ? { ok: true, path: path.join(swept.dir || dir, first), name: first, format: "webm", note: line, syncable: false }
      : { ok: false, reason: line });
    return swept;
  } catch {
    return null; // recovery is best-effort; the next start tries again
  }
}

/** Open the control bar for one display (and optional DIP crop); it starts recording. */
function beginBar(frame, cropDip) {
  const { BrowserWindow } = electron();
  // State first: closing the overlays fires their "closed" handler, which cancels
  // a session still in "selecting".
  if (session) session.state = "starting";
  closeOverlays();
  const { bounds, workArea } = frame.display;
  const area = workArea || bounds;
  // Above the region when there is room, else top-centre of the display.
  const anchorX = cropDip ? bounds.x + cropDip.x + cropDip.width / 2 : area.x + area.width / 2;
  const x = Math.round(Math.max(area.x, Math.min(area.x + area.width - BAR_WIDTH, anchorX - BAR_WIDTH / 2)));
  const above = cropDip ? bounds.y + cropDip.y - BAR_HEIGHT - 8 : area.y + 12;
  const y = Math.round(above >= area.y ? above : area.y + 12);
  const bar = new BrowserWindow({
    x, y, width: BAR_WIDTH, height: BAR_HEIGHT,
    frame: false, transparent: true, resizable: false, minimizable: false, maximizable: false,
    fullscreenable: false, skipTaskbar: true, hasShadow: false, show: false, alwaysOnTop: true,
    webPreferences: {
      preload: path.join(__dirname, "recorder-preload.cjs"),
      contextIsolation: true, nodeIntegration: false, sandbox: true,
      backgroundThrottling: false,
    },
  });
  // Windows: WDA_EXCLUDEFROMCAPTURE -- the bar is visible to the owner, absent from the video.
  try { bar.setContentProtection(true); } catch { /* older OS: the bar shows in the recording */ }
  bar.setAlwaysOnTop(true, "screen-saver");
  bar.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  bar.webContents.on("will-navigate", (event) => event.preventDefault());
  const stamp = `${Date.now()}-${process.pid}`;
  session = {
    ...session,
    state: "starting",
    display: frame.display,
    sourceId: frame.source ? frame.source.id : null,
    native: frame.source ? null : { rect: nativeRect(frame.display, cropDip), stamp, parts: [], live: null },
    cropDip,
    bar,
    writer: core.createChunkWriter(path.join(os.tmpdir(), "aither-recorder", `rec-${stamp}.webm`)),
    startedAt: new Date(),
  };
  bar.once("ready-to-show", () => bar.showInactive());
  bar.on("closed", () => {
    // Closed under a live recording (crash, Alt+F4): keep what was written.
    if (session && session.bar === bar && session.state !== "finishing") void finish({ reason: "the control bar closed" });
  });
  void bar.loadFile(path.join(__dirname, "recorder.html"), { query: { view: "bar" } });
  return { ok: true, pending: true };
}

const NOT_RUNNING = "0 recordings running — start one from the palette";

/**
 * Ask the bar to stop; it flushes MediaRecorder and calls recorder:done. While
 * the bar is still "starting" the stop is held and delivered when it reports
 * "recording" ({ok:true, pending:true}).
 */
function stopRecording() {
  if (!session || !session.bar || session.bar.isDestroyed()) return { ok: false, reason: NOT_RUNNING };
  if (session.state === "finishing") return { ok: false, reason: "1 recording already saving — wait for its toast" };
  if (session.state === "starting") {
    session.pendingCommand = "stop";
    return { ok: true, pending: true };
  }
  session.bar.webContents.send("recorder:command", "stop");
  return { ok: true };
}

/** Pause / resume; during "starting" it toggles a held pause (a held stop wins). */
function togglePause() {
  if (!session || !session.bar || session.bar.isDestroyed()) return { ok: false, reason: NOT_RUNNING };
  if (session.state === "finishing") return { ok: false, reason: "1 recording already saving — wait for its toast" };
  if (session.state === "starting") {
    if (session.pendingCommand !== "stop") session.pendingCommand = session.pendingCommand === "pause" ? null : "pause";
    return { ok: true, pending: true };
  }
  session.bar.webContents.send("recorder:command", session.state === "paused" ? "resume" : "pause");
  return { ok: true };
}

async function finish({ reason } = {}) {
  if (!session || session.state === "finishing") return { ok: false, reason: "nothing to finish" };
  const s = session;
  s.state = "finishing";
  s.writer.close();
  try { if (s.bar && !s.bar.isDestroyed()) s.bar.destroy(); } catch { /* already gone */ }
  let tempPath = s.writer.path;
  let nativeSound = false;
  if (s.native) {
    tempPath = await nativeAssemble(s);
    const fs = require("node:fs");
    let soundBytes = 0;
    try { soundBytes = fs.statSync(s.writer.path).size; } catch { /* no sound recorded */ }
    if (tempPath && soundBytes > 0) {
      const muxed = tempPath.replace(/\.mkv$/i, "-av.mkv");
      const r = await runFfmpeg(ffmpegPath(), core.nativeMuxArgs({ video: tempPath, audio: s.writer.path, output: muxed }));
      if (r.ok) {
        try { fs.unlinkSync(tempPath); } catch { /* temp */ }
        tempPath = muxed;
        nativeSound = true;
      } else {
        console.warn(`[recorder] sound could not be joined to the video: ${r.reason}`);
      }
    }
    try { fs.unlinkSync(s.writer.path); } catch { /* the sound file never existed */ }
    if (!tempPath) {
      session = null;
      showToast({ ok: false, reason: "1 recording came back empty — ffmpeg could not grab this screen" });
      return { ok: false, reason: "native recording empty" };
    }
  }
  const verdict = await core.finalizeRecording({
    tempPath,
    dir: core.recordingDir({ videosDir: videosDirOrUndefined() }),
    startedAt: s.startedAt,
    // A native segment is H.264 in MKV, never WebM: "webm" would only rename it.
    format: s.native && core.parseFormat(s.options.format) === "webm" ? "mp4" : s.options.format,
    ffmpeg: ffmpegPath(),
    audio: s.native ? nativeSound : (s.options.systemAudio || s.options.mic),
    run: runFfmpeg,
    enqueue: (item) => uploadQueue().enqueue(item),
    sync: autoSyncEnabled(),
    truncated: s.writer.failed || null,
  });
  session = null;
  if (verdict.ok) {
    lastRecording = verdict.path;
    showToast({ ...verdict, interrupted: reason || null });
  } else {
    showToast({ ok: false, reason: verdict.reason });
  }
  return verdict;
}

// ── toast ──────────────────────────────────────────────────────────────────

function showToast(info) {
  const { BrowserWindow, screen } = electron();
  toastInfo = info;
  if (toastTimer) clearTimeout(toastTimer);
  const area = screen.getPrimaryDisplay().workArea;
  const bounds = {
    x: area.x + area.width - TOAST_WIDTH - 16, y: area.y + area.height - TOAST_HEIGHT - 16,
    width: TOAST_WIDTH, height: TOAST_HEIGHT,
  };
  if (!toastWin || toastWin.isDestroyed()) {
    toastWin = new BrowserWindow({
      ...bounds, frame: false, transparent: true, resizable: false, movable: false,
      skipTaskbar: true, focusable: false, show: false, alwaysOnTop: true,
      webPreferences: {
        preload: path.join(__dirname, "recorder-preload.cjs"),
        contextIsolation: true, nodeIntegration: false, sandbox: true,
      },
    });
    toastWin.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    toastWin.webContents.on("will-navigate", (event) => event.preventDefault());
    toastWin.once("ready-to-show", () => toastWin && !toastWin.isDestroyed() && toastWin.showInactive());
    void toastWin.loadFile(path.join(__dirname, "recorder.html"), { query: { view: "toast" } });
  } else {
    toastWin.setBounds(bounds);
    toastWin.webContents.send("recorder:toast-update", publicToast());
    toastWin.showInactive();
  }
  armToastTimer(info && info.ok ? 10_000 : 8000);
}

function armToastTimer(ms) {
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    if (toastWin && !toastWin.isDestroyed()) toastWin.hide();
  }, ms);
}

/**
 * What the toast page may see: a name and state lines, never a token. The one
 * path it can see is inside a failure's remedy ("1 recording left in <temp> —
 * move it manually"), because without it the remedy cannot be followed.
 */
function publicToast() {
  if (!toastInfo) return null;
  if (!toastInfo.ok) return { ok: false, reason: String(toastInfo.reason || "") };
  let sync = toastInfo.syncNote || null;
  if (!sync && toastInfo.queued) {
    try { sync = core.syncLine(uploadQueue().pending()) || "Syncing to AitherOS Online · Screenshots"; } catch { sync = null; }
  }
  const canSync = Boolean(!toastInfo.queued && toastInfo.syncable && !toastInfo.syncNote);
  if (!sync && canSync) sync = "Kept on this PC — press Sync to upload it to AitherOS Online";
  return {
    ok: true,
    name: toastInfo.name,
    format: toastInfo.format,
    note: toastInfo.note || null,
    sync,
    canSync,
    canCancelSync: Boolean(toastInfo.queued && toastInfo.queueId && !deps.enqueue),
    interrupted: toastInfo.interrupted || null,
    status: toastInfo.status || null,
  };
}

function pushToast() {
  if (toastWin && !toastWin.isDestroyed()) toastWin.webContents.send("recorder:toast-update", publicToast());
}

async function toastAction(action) {
  const { clipboard, shell } = electron();
  const file = toastInfo && toastInfo.ok ? toastInfo.path : null;
  if (action === "dismiss") {
    if (toastWin && !toastWin.isDestroyed()) toastWin.hide();
    return { ok: true };
  }
  if (!file) return { ok: false, reason: "no recording" };
  if (action === "copy-path") {
    clipboard.writeText(file);
    toastInfo = { ...toastInfo, status: "Path copied" };
    pushToast();
    return { ok: true };
  }
  if (action === "open-folder") {
    shell.showItemInFolder(file);
    return { ok: true };
  }
  if (action === "sync") {
    // The per-recording opt-in: this file, now, nothing else.
    if (toastInfo.queued) return { ok: true, pending: true };
    const sent = core.queueRecordingUpload({ filePath: file, enqueue: (item) => uploadQueue().enqueue(item) });
    toastInfo = { ...toastInfo, queued: sent.queued, queueId: sent.id, syncable: sent.syncable, syncNote: sent.syncNote };
    pushToast();
    return sent.queued ? { ok: true } : { ok: false, reason: sent.syncNote };
  }
  if (action === "cancel-sync") {
    const r = cancelQueued(toastInfo.queueId);
    if (r.ok) toastInfo = { ...toastInfo, queued: false, queueId: null, syncNote: "1 recording sync cancelled — kept on this PC" };
    else toastInfo = { ...toastInfo, status: r.reason };
    pushToast();
    return r.ok ? { ok: true } : r;
  }
  if (action === "ask") {
    if (typeof deps.askVideo !== "function") return { ok: false, reason: "vision lane not wired" };
    toastInfo = { ...toastInfo, status: "Asking Aither about the first frame…" };
    pushToast();
    armToastTimer(90_000);
    let verdict;
    try { verdict = await deps.askVideo(file); } catch (error) { verdict = { ok: false, reason: String((error && error.message) || error) }; }
    toastInfo = {
      ...toastInfo,
      status: verdict && verdict.ok ? "Aither answered in chat"
        : `1 ask failed — ${String((verdict && verdict.reason) || "no answer").slice(0, 120)}`,
    };
    pushToast();
    armToastTimer(8000);
    try { if (verdict && verdict.ok && deps.onAnswer) deps.onAnswer(verdict); } catch { /* the answer was still shown */ }
    return verdict && verdict.ok ? { ok: true } : { ok: false, reason: (verdict && verdict.reason) || "no answer" };
  }
  return { ok: false, reason: `unknown action ${action}` };
}

// ── IPC ────────────────────────────────────────────────────────────────────

function rectFrom(raw) {
  if (!raw || typeof raw !== "object") return null;
  const n = (v) => (Number.isFinite(Number(v)) ? Number(v) : NaN);
  const rect = { x: n(raw.x), y: n(raw.y), width: n(raw.width), height: n(raw.height) };
  return Object.values(rect).every(Number.isFinite) ? rect : null;
}

function fromBar(event) {
  return Boolean(session && session.bar && !session.bar.isDestroyed() && event.sender.id === session.bar.webContents.id);
}

/**
 * The IPC contract as a pure-ish table (channel -> handler(event, arg)), so the
 * wiring is inspectable; ensureRecorderIpc registers it once.
 */
function handlers() {
  return {
    // snip.html, via recorder-preload's aitherSnip shim.
    "recorder:region-frame": (event) => {
      const entry = overlays.get(event.sender.id);
      if (!entry || !entry.image || entry.image.isEmpty()) return { ok: false, reason: "no recording selection in progress" };
      return { ok: true, dataUrl: entry.image.toDataURL(), width: entry.display.bounds.width, height: entry.display.bounds.height };
    },
    "recorder:region-select": (event, raw) => {
      const entry = overlays.get(event.sender.id);
      if (!entry) return { ok: false, reason: "no recording selection in progress" };
      const rect = rectFrom(raw);
      if (!snip.isRegion(rect)) return { ok: false, reason: "region too small" };
      return beginBar(entry, rect);
    },
    "recorder:region-full": (event) => {
      const entry = overlays.get(event.sender.id);
      if (!entry) return { ok: false, reason: "no recording selection in progress" };
      return beginBar(entry, null);
    },
    // Only an overlay may cancel, and only while it is picking: the bar and the
    // toast load the same preload, and a cancel mid-recording used to null the
    // session under a live writer (orphaned fd, a bar that never closed).
    "recorder:region-cancel": (event) => {
      if (!overlays.has(event && event.sender && event.sender.id) || !session || session.state !== "selecting") {
        return { ok: false, reason: "no recording selection in progress" };
      }
      closeOverlays();
      session = null;
      return { ok: true };
    },
    // The bar.
    "recorder:plan": (event) => {
      if (!fromBar(event)) return { ok: false, reason: "not the recorder bar" };
      if (session.native) {
        return {
          ok: true, native: true, fps: session.options.fps, format: session.options.format,
          cropped: Boolean(session.cropDip),
          // The bar records the sound (any GPU can); main muxes it onto the video at finish.
          systemAudio: session.options.systemAudio ? core.systemAudioConstraints() : null,
          mic: session.options.mic,
        };
      }
      return {
        ok: true,
        constraints: core.captureConstraints({ sourceId: session.sourceId, display: session.display, fps: session.options.fps }),
        systemAudio: session.options.systemAudio ? core.systemAudioConstraints() : null,
        mic: session.options.mic,
        fps: session.options.fps,
        cropped: Boolean(session.cropDip),
        format: session.options.format,
        ffmpeg: Boolean(ffmpegPath()),
      };
    },
    "recorder:stream-size": (event, raw) => {
      if (!fromBar(event)) return { ok: false, reason: "not the recorder bar" };
      const stream = { width: Number(raw && raw.width) || 0, height: Number(raw && raw.height) || 0 };
      if (!stream.width || !stream.height) return { ok: false, reason: "the stream has no size" };
      return { ok: true, crop: core.cropForStream(session.cropDip, session.display, stream) };
    },
    "recorder:chunk": (event, bytes) => {
      if (!fromBar(event)) return { ok: false, reason: "not the recorder bar" };
      if (!(bytes instanceof ArrayBuffer) && !ArrayBuffer.isView(bytes)) return { ok: false, reason: "not bytes" };
      return session.writer.write(bytes instanceof ArrayBuffer
        ? Buffer.from(bytes) : Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength));
    },
    "recorder:state": (event, raw) => {
      if (!fromBar(event)) return { ok: false, reason: "not the recorder bar" };
      const next = String(raw || "");
      const now = Date.now();
      const open = session.segments.length && session.segments[session.segments.length - 1][1] == null;
      if (next === "recording" && !open) session.segments.push([now, null]);
      if (next === "paused" && open) session.segments[session.segments.length - 1][1] = now;
      // Native: each recording stretch is its own ffmpeg segment, joined at finish.
      if (session.native && next === "recording" && !session.native.live && !nativeSegmentStart(session)) {
        return { ok: false, reason: "the region is too small to record" };
      }
      if (session.native && next === "paused") void nativeSegmentStop(session);
      if (next === "recording" || next === "paused") session.state = next;
      // A stop/pause asked for while the bar was starting: the bar registered
      // onCommand before it reported "recording", so it hears this one.
      if (next === "recording" && session.pendingCommand) {
        const cmd = session.pendingCommand;
        session.pendingCommand = null;
        try { session.bar.webContents.send("recorder:command", cmd); } catch { /* bar gone: its closed handler saves */ }
      }
      return { ok: true, ...status() };
    },
    "recorder:done": (event) => {
      if (!fromBar(event)) return { ok: false, reason: "not the recorder bar" };
      return finish();
    },
    "recorder:failed": (event, raw) => {
      if (!fromBar(event)) return { ok: false, reason: "not the recorder bar" };
      const why = String(raw || "capture failed").slice(0, 160);
      const s = session;
      session = null;
      if (s.native) void nativeSegmentStop(s);
      try { s.writer.close(); } catch { /* nothing opened */ }
      // An empty temp file is litter; one with bytes is recovered on the next start.
      if (!s.writer.bytes) { try { require("node:fs").unlinkSync(s.writer.path); } catch { /* never created */ } }
      try { if (s.bar && !s.bar.isDestroyed()) s.bar.destroy(); } catch { /* gone */ }
      return fail(`1 recording could not start (${why}) — allow screen and mic access, then try again`);
    },
    "recorder:status": () => status(),
    // The toast.
    "recorder:toast-info": () => publicToast(),
    "recorder:toast-action": (_event, action) => toastAction(String(action || "")),
  };
}

function ensureRecorderIpc() {
  if (wired) return;
  wired = true;
  const { ipcMain } = electron();
  for (const [channel, fn] of Object.entries(handlers())) ipcMain.handle(channel, fn);
}

/** The last saved recording's path (main-process callers only). */
function lastRecordingPath() {
  return lastRecording;
}

/**
 * Test seam (the console-window.cjs __setWindowsForTest shape): replace the
 * module's session / overlays / toast so handlers() can be driven under node --test
 * without Electron. Returns the live state for assertions.
 */
function __setStateForTest(next = {}) {
  if ("session" in next) session = next.session;
  if ("overlays" in next) overlays = next.overlays instanceof Map ? next.overlays : new Map(next.overlays || []);
  if ("toastInfo" in next) toastInfo = next.toastInfo;
  return { session, overlays, toastInfo };
}

module.exports = {
  configureRecorder, startRecording, stopRecording, togglePause, isRecording, status,
  ensureRecorderIpc, lastRecordingPath, firstFrameRunner, closeOverlays, handlers,
  cancelQueued, autoSyncEnabled, publicToast, __setStateForTest,
};
