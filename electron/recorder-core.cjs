"use strict";

/**
 * recorder-core.cjs -- the Electron-free half of the desk's screen recorder (owner
 * 2026-11-01: replace the Windows utilities). recorder-window.cjs owns the region
 * overlay, the floating control bar, the toast and their IPC; everything here is
 * pure math or injected I/O, so recorder-core.test.cjs runs it under `node --test`.
 *
 *   record.region -> snip.html overlay (REUSED from the snipping tool) -> drag a
 *   region / Enter for the display -> control bar (stop / pause / timer) records
 *   desktopCapturer + getUserMedia(chromeMediaSourceId) + MediaRecorder webm/vp9
 *   -> ffmpeg (if on PATH) to MP4 h264 or GIF (palettegen) -> ~/Videos/Aither
 *   Recordings/"Recording YYYY-MM-DD HHMMSS.mp4" -> toast [Ask Aither] [Copy path]
 *   [Open folder] [Sync | Cancel sync].
 *
 * CLOUD SYNC IS OPT-IN. A screen video with mic audio is far more sensitive than a
 * screenshot, so a recording is uploaded to the owner's Strata `screenshots` folder
 * (strata-sync.cjs) only when cast.json `recorder.sync` is true, or when the owner
 * presses [Sync] on that one recording's toast. A queued upload can be cancelled
 * from the toast. Uploads get a timeout scaled to the file (uploadTimeoutMs) and
 * give up, loudly, after MAX_UPLOAD_TIMEOUTS timeouts in a row instead of
 * retrying forever.
 *
 * NOTHING IS DELETED UNTIL ITS REPLACEMENT IS PROVEN. The temp WebM is removed
 * only after the converted file exists, is non-empty and carries its format's
 * magic bytes (verifyOutput); a move that fails names where the WebM was left;
 * temp files an interrupted session left behind are recovered into the
 * recordings folder on the next start (recoverStaleRecordings), never swept away.
 *
 * THE SCALE RULE is snip-capture.cjs's: a DIP selection becomes device pixels with
 * the ratio of the STREAM's real size to the display bounds, never scaleFactor
 * alone, then clamped. The recorder adds one rule on top: H.264 4:2:0 needs EVEN
 * width and height, so every crop is shrunk to even edges (cropForStream).
 *
 * NO FFMPEG is a state, not a failure: the WebM is kept and the toast says how to
 * get MP4/GIF. Same degradation contract as every desk module: {ok:false, reason},
 * never throws.
 */

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const snip = require("./snip-capture.cjs");

const FOLDER_NAME = "Aither Recordings";
const FORMATS = Object.freeze(["mp4", "gif", "webm"]);
/** The strata-sync folder recordings land in (Veil's clipboard app lists it). */
const UPLOAD_FOLDER = "screenshots";
/** Veil /api/strata/upload MAX_FILE_SIZE: a bigger recording would 413 forever. */
const MAX_UPLOAD_BYTES = 100 * 1024 * 1024;
const DEFAULT_FPS = 30;
const GIF_FPS = 15;
const GIF_MAX_WIDTH = 960;
const FFMPEG_TIMEOUT_MS = 10 * 60_000;
const FFMPEG_REMEDY = "install ffmpeg (winget install Gyan.FFmpeg) for MP4/GIF";
const VISIBLE_CAP = 5;
/** strata-sync's own fixed timeout; the floor for a recording's upload. */
const UPLOAD_TIMEOUT_FLOOR_MS = 30_000;
/** The slowest uplink a recording upload is sized for (~4 Mbit/s): 100 MB -> ~200 s. */
const UPLOAD_MIN_BYTES_PER_SEC = 512 * 1024;
/** Timeouts in a row after which an upload is dropped (and the toast says so). */
const MAX_UPLOAD_TIMEOUTS = 3;
const TIMED_OUT = "upload timed out";
/** os.tmpdir()/aither-recorder: where the chunk writer spools a live recording. */
const TEMP_DIR_NAME = "aither-recorder";
const TEMP_FILE_RE = /^rec-.*\.webm$/;
/** A temp file younger than this may belong to a recording still being written. */
const STALE_AFTER_MS = 5 * 60_000;
/** Magic bytes a converted file must carry before the source WebM is deleted. */
const MAGIC = Object.freeze({ mp4: { at: 4, text: "ftyp" }, gif: { at: 0, text: "GIF8" } });

const CONTENT_TYPES = Object.freeze({ mp4: "video/mp4", gif: "image/gif", webm: "video/webm" });

function pad(n, width = 2) {
  return String(n).padStart(width, "0");
}

/** "Recording 2026-11-01 093007.mp4" in LOCAL time -- what Explorer sorts by. */
function recordingName(date = new Date(), ext = "mp4", suffix = "") {
  const d = date instanceof Date ? date : new Date(date);
  const e = String(ext || "mp4").replace(/^\./, "");
  return `Recording ${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} `
    + `${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}${suffix}.${e}`;
}

/** os.tmpdir()/aither-recorder -- the chunk writer's spool for a live recording. */
function tempDir({ tmp = os.tmpdir() } = {}) {
  return path.join(tmp, TEMP_DIR_NAME);
}

/**
 * ~/Videos/Aither Recordings. `videosDir` is Electron's app.getPath("videos")
 * (honours a redirected Videos folder); the fallback is ~/Videos.
 */
function recordingDir({ videosDir, homeDir = os.homedir() } = {}) {
  return path.join(videosDir || path.join(homeDir, "Videos"), FOLDER_NAME);
}

/** The asked-for format, or mp4. */
function parseFormat(format) {
  const f = String(format || "").toLowerCase().replace(/^\./, "");
  return FORMATS.includes(f) ? f : "mp4";
}

/**
 * Every start request normalised once: {mode, format, systemAudio, mic, fps}.
 * GIF never carries audio, so its audio flags are forced off (no wasted capture).
 */
function normalizeOptions(raw = {}) {
  const format = parseFormat(raw.format);
  const gif = format === "gif";
  const fps = Number(raw.fps) > 0 && Number(raw.fps) <= 60 ? Math.round(Number(raw.fps)) : DEFAULT_FPS;
  return {
    mode: raw.mode === "screen" ? "screen" : "region",
    format,
    systemAudio: !gif && raw.systemAudio === true,
    mic: !gif && raw.mic === true,
    fps,
  };
}

/** Shrink a device rect to even width/height inside the frame (H.264 4:2:0). */
function evenRect(rect, frame) {
  if (!rect) return null;
  const fw = frame && frame.width > 0 ? frame.width : rect.x + rect.width;
  const fh = frame && frame.height > 0 ? frame.height : rect.y + rect.height;
  const x = Math.max(0, Math.min(fw, Math.floor(rect.x)));
  const y = Math.max(0, Math.min(fh, Math.floor(rect.y)));
  let width = Math.min(Math.floor(rect.width), fw - x);
  let height = Math.min(Math.floor(rect.height), fh - y);
  width -= width % 2;
  height -= height % 2;
  if (width < 2 || height < 2) return null;
  return { x, y, width, height };
}

/**
 * A region in overlay DIPs -> the crop in STREAM pixels, even-edged.
 *
 * @param {{x,y,width,height}|null} cropDip   null = the whole display
 * @param {{bounds:{width,height}, scaleFactor?:number}} display
 * @param {{width:number,height:number}} stream  the video track's real size
 * @returns {{x,y,width,height}|null} null = record the whole frame uncropped
 */
function cropForStream(cropDip, display, stream) {
  if (!cropDip) return null;
  return evenRect(snip.regionToDevice(cropDip, display, stream), stream);
}

/**
 * getUserMedia constraints for one display (Electron's legacy chromeMediaSource
 * path; the source id comes from desktopCapturer in the main process). The size
 * is pinned to the display's device pixels so a 150% panel is not downscaled.
 */
function captureConstraints({ sourceId, display, fps = DEFAULT_FPS }) {
  const sf = display && Number(display.scaleFactor) > 0 ? Number(display.scaleFactor) : 1;
  const width = display && display.bounds ? Math.round(display.bounds.width * sf) : 1920;
  const height = display && display.bounds ? Math.round(display.bounds.height * sf) : 1080;
  return {
    audio: false,
    video: {
      mandatory: {
        chromeMediaSource: "desktop",
        chromeMediaSourceId: String(sourceId || ""),
        minWidth: width, maxWidth: width, minHeight: height, maxHeight: height,
        // BOTH bounds. Measured 2026-11-01: with maxFrameRate alone the legacy
        // desktop capturer delivered ~1.6 fps (9-10 frames in 6 s of a 60 fps
        // animation, VP9 and H.264 alike) -- the encoder was never the limit.
        minFrameRate: fps,
        maxFrameRate: fps,
      },
    },
  };
}

/**
 * System audio on Windows: Chromium only loops back the WHOLE desktop's audio and
 * insists on a video constraint beside it; the renderer keeps the audio track and
 * stops the (tiny) video one.
 */
function systemAudioConstraints() {
  return {
    audio: { mandatory: { chromeMediaSource: "desktop" } },
    video: { mandatory: { chromeMediaSource: "desktop", maxWidth: 320, maxHeight: 180, maxFrameRate: 1 } },
  };
}

/**
 * ffmpeg on PATH, the way the desk already calls it (drop-router's video lane and
 * push-to-talk spawn bare "ffmpeg"); resolved here to a full path so a missing
 * binary is known BEFORE a conversion is attempted. AWDESK_FFMPEG overrides.
 *
 * @returns {string|null}
 */
function findFfmpeg({ env = process.env, platform = process.platform, exists = fs.existsSync } = {}) {
  try {
    const forced = String((env && env.AWDESK_FFMPEG) || "").trim();
    if (forced) return exists(forced) ? forced : null;
    const sep = platform === "win32" ? ";" : ":";
    const pathVar = String((env && (env.PATH || env.Path || env.path)) || "");
    const exts = platform === "win32"
      ? String((env && env.PATHEXT) || ".EXE").split(";").filter(Boolean).map((e) => e.toLowerCase())
      : [""];
    const join = platform === "win32" ? path.win32.join : path.posix.join;
    for (const raw of pathVar.split(sep)) {
      const dir = raw.trim().replace(/^"|"$/g, "");
      if (!dir) continue;
      for (const ext of exts) {
        if (platform === "win32" && ext !== ".exe" && ext !== ".com") continue;
        const candidate = join(dir, `ffmpeg${ext}`);
        if (exists(candidate)) return candidate;
      }
    }
  } catch { /* an unreadable PATH means "not found" */ }
  return null;
}

const QUIET = Object.freeze(["-y", "-hide_banner", "-loglevel", "error"]);

/** WebM -> MP4 (H.264, yuv420p, faststart). Odd edges are trimmed by the scale filter. */
function mp4Args(input, output, { crf = 23, preset = "veryfast", audio = true } = {}) {
  return [
    ...QUIET, "-i", input,
    "-c:v", "libx264", "-preset", preset, "-crf", String(crf), "-pix_fmt", "yuv420p",
    "-vf", "scale=trunc(iw/2)*2:trunc(ih/2)*2",
    ...(audio ? ["-c:a", "aac", "-b:a", "160k"] : ["-an"]),
    "-movflags", "+faststart",
    output,
  ];
}

/** WebM -> GIF in ONE pass: split -> palettegen -> paletteuse (no banding). */
function gifArgs(input, output, { fps = GIF_FPS, maxWidth = GIF_MAX_WIDTH } = {}) {
  const graph = `[0:v]fps=${fps},scale=w='min(${maxWidth},iw)':h=-1:flags=lanczos,split[a][b];`
    + "[a]palettegen=stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=5:diff_mode=rectangle";
  return [...QUIET, "-i", input, "-filter_complex", graph, "-loop", "0", "-an", output];
}

/**
 * What finalize will do: {ext, args|null, note|null}. No ffmpeg, or format webm,
 * means the WebM is kept as-is; the note says why in "<count> <thing> — <remedy>".
 */
function convertPlan({ format, ffmpeg, input, output, audio = true }) {
  const f = parseFormat(format);
  if (f === "webm") return { ext: "webm", args: null, note: null };
  if (!ffmpeg) return { ext: "webm", args: null, note: `1 recording kept as WebM — ${FFMPEG_REMEDY}` };
  return { ext: f, args: f === "gif" ? gifArgs(input, output) : mp4Args(input, output, { audio }), note: null };
}

/** The strata-sync enqueue item for a saved recording, or why it stays local. */
function uploadItem({ filePath, size }) {
  const ext = path.extname(filePath || "").toLowerCase().replace(".", "");
  if (!filePath) return { ok: false, reason: "no recording to sync" };
  if (Number(size) > MAX_UPLOAD_BYTES) {
    return {
      ok: false,
      reason: `1 recording too large to sync (${(Number(size) / 1024 / 1024).toFixed(0)} MB > 100 MB) — kept on this PC`,
    };
  }
  return {
    ok: true,
    item: { folder: UPLOAD_FOLDER, name: path.basename(filePath), filePath, contentType: CONTENT_TYPES[ext] || "application/octet-stream" },
  };
}

/** "0:07", "12:03", "1:02:03" -- the control bar's timer. */
function formatElapsed(ms) {
  const total = Math.max(0, Math.floor(Number(ms) / 1000) || 0);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return h ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

/**
 * Recording time that excludes pauses. `segments` are [startMs, endMs|null] pairs
 * (null = still running), `now` closes the open one.
 */
function elapsedMs(segments, now = Date.now()) {
  let sum = 0;
  for (const [a, b] of segments || []) sum += Math.max(0, (b == null ? now : b) - a);
  return sum;
}

/** Rank-preserving cap (ux-shape law 4): {shown, more} -- `more` is the REAL remainder. */
function capList(items, cap = VISIBLE_CAP) {
  const all = Array.isArray(items) ? items : [];
  return { shown: all.slice(0, cap), more: Math.max(0, all.length - cap), total: all.length };
}

/**
 * The toast's sync line from strata-sync's pending() rows for recordings.
 * Retrying jobs read as "<count> recordings waiting to sync — <remedy>".
 */
function syncLine(pendingRows) {
  const rec = (pendingRows || []).filter((r) => /^Recording /.test(String(r.name || "")));
  const stuck = rec.filter((r) => r.attempts > 0);
  if (!stuck.length) return rec.length ? "Syncing to AitherOS Online · Screenshots" : null;
  const why = String(stuck[0].lastReason || "");
  const remedy = /sign in/i.test(why) ? "sign in to Aither"
    : /timed out/i.test(why) ? `slow upload, retrying (gives up after ${MAX_UPLOAD_TIMEOUTS} timeouts)`
      : "retrying automatically";
  const { shown, more } = capList(stuck.map((r) => r.name));
  return `${stuck.length} recording${stuck.length === 1 ? "" : "s"} waiting to sync — ${remedy}`
    + ` (${shown.join(", ")}${more ? `, +${more} more` : ""})`;
}

/**
 * Append-only chunk sink for MediaRecorder's timeslices: a long recording never
 * sits in memory, and a crash leaves a (partly playable) WebM on disk.
 *
 * STICKY FAILURE. The first failed write (disk full, EPERM) is remembered in
 * `failed` and every later append is refused: appending past a lost chunk would
 * leave a hole in the middle of the WebM, which ffmpeg turns into a corrupt file
 * the toast then calls "Saved". finish() passes `failed` to finalizeRecording as
 * `truncated`, so the toast says the recording is cut short and why.
 */
function createChunkWriter(filePath, fsImpl = fs) {
  let fd = null;
  let bytes = 0;
  let failed = null;
  return {
    path: filePath,
    write(buf) {
      if (failed) return { ok: false, reason: failed, refused: true };
      try {
        if (fd === null) {
          fsImpl.mkdirSync(path.dirname(filePath), { recursive: true });
          fd = fsImpl.openSync(filePath, "w");
        }
        const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
        fsImpl.writeSync(fd, b);
        bytes += b.length;
        return { ok: true, bytes };
      } catch (error) {
        failed = `could not write the recording: ${String((error && error.message) || error).slice(0, 200)}`;
        return { ok: false, reason: failed };
      }
    },
    close() {
      if (fd !== null) {
        try { fsImpl.closeSync(fd); } catch { /* already closed */ }
        fd = null;
      }
      return { ok: true, bytes };
    },
    get bytes() { return bytes; },
    get failed() { return failed; },
  };
}

function sleepSync(ms) {
  try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); } catch { /* no wait: retry at once */ }
}

/** Codes a held file (antivirus, the indexer, a preview pane) answers with on Windows. */
const BUSY_CODES = new Set(["EPERM", "EBUSY", "EACCES"]);

/**
 * Move a file, never losing it. EXDEV (temp and Videos on different volumes) goes
 * straight to copy + unlink; EPERM/EBUSY/EACCES (a scanner holding the new WebM)
 * retries the rename briefly first. Returns {ok:true} | {ok:false, reason}; on
 * failure the source is untouched and no half-copied target is left behind.
 */
function moveFile(from, to, fsImpl = fs, { retries = 3, waitMs = 200, wait = sleepSync } = {}) {
  let lastError = null;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      fsImpl.renameSync(from, to);
      return { ok: true };
    } catch (error) {
      lastError = error;
      if (!(error && BUSY_CODES.has(error.code)) || attempt === retries) break;
      wait(waitMs * (attempt + 1));
    }
  }
  try {
    fsImpl.copyFileSync(from, to);
  } catch (error) {
    try { fsImpl.unlinkSync(to); } catch { /* nothing half-copied */ }
    const code = (error && error.code) || (lastError && lastError.code) || "error";
    return { ok: false, reason: `${code}: ${String((error && error.message) || error).slice(0, 160)}` };
  }
  try { fsImpl.unlinkSync(from); } catch { /* the copy is what matters; a leftover is recovered later */ }
  return { ok: true };
}

/**
 * Is a converted file real? Non-empty AND its format's magic bytes ("ftyp" at
 * offset 4 for MP4, "GIF8" for GIF). ffmpeg can exit 0 and still leave an empty
 * or torn file (a full disk during the faststart rewrite); the source WebM is
 * deleted only after this says yes.
 *
 * @returns {{ok:true, size:number} | {ok:false, reason:string}}
 */
function verifyOutput(filePath, format, fsImpl = fs) {
  let size;
  try { size = fsImpl.statSync(filePath).size; } catch { return { ok: false, reason: "no output file" }; }
  if (!size) return { ok: false, reason: "an empty file" };
  const f = parseFormat(format);
  const magic = MAGIC[f];
  if (!magic) return { ok: true, size };
  let fd = null;
  try {
    fd = fsImpl.openSync(filePath, "r");
    const head = Buffer.alloc(magic.at + magic.text.length);
    const n = fsImpl.readSync(fd, head, 0, head.length, 0);
    if (n < head.length || head.subarray(magic.at).toString("latin1") !== magic.text) {
      return { ok: false, reason: `a file that is not ${f.toUpperCase()}` };
    }
    return { ok: true, size };
  } catch (error) {
    return { ok: false, reason: `an unreadable file: ${String((error && error.message) || error).slice(0, 120)}` };
  } finally {
    if (fd !== null) { try { fsImpl.closeSync(fd); } catch { /* closed */ } }
  }
}

/**
 * The upload timeout for a payload: strata-sync's 30 s floor, or the time the
 * file takes at UPLOAD_MIN_BYTES_PER_SEC, whichever is longer. A fixed 30 s timed
 * out every recording above ~37 MB at 10 Mbit/s, on every attempt, forever.
 */
function uploadTimeoutMs(bytes) {
  const n = Math.max(0, Number(bytes) || 0);
  return Math.max(UPLOAD_TIMEOUT_FLOOR_MS, Math.ceil((n / UPLOAD_MIN_BYTES_PER_SEC) * 1000));
}

/**
 * The strata-sync `upload` seam for the recorder's own queue: (job, bytes) ->
 * verdict. It sizes the timeout to the bytes, turns MAX_UPLOAD_TIMEOUTS timeouts
 * in a row into a PERMANENT verdict (the queue drops the job and its spooled
 * copy, and its "dropped" event tells the toast), and refuses a cancelled job.
 * `job.timeouts` rides on the job object, which the queue persists on retry, so
 * the count survives a desk restart.
 *
 * @param {{uploadOnce: Function, origin: () => string, token: () => string|null,
 *          isCancelled?: (id: string) => boolean, maxTimeouts?: number}} deps
 * @returns {(job: object, bytes: Buffer) => Promise<object>}
 */
function createRecordingUploader({ uploadOnce, origin, token, isCancelled = () => false, maxTimeouts = MAX_UPLOAD_TIMEOUTS }) {
  return async (job, bytes) => {
    if (isCancelled(job.id)) return { ok: false, status: 0, reason: "sync cancelled", permanent: true };
    const size = bytes ? bytes.length : 0;
    let verdict;
    try {
      verdict = await uploadOnce({
        origin: origin(), folder: job.folder, name: job.name, bytes, contentType: job.contentType,
        token: token(), timeoutMs: uploadTimeoutMs(size),
      });
    } catch (error) {
      verdict = { ok: false, status: 0, reason: String((error && error.message) || error).slice(0, 200), permanent: false };
    }
    if (verdict && !verdict.ok && verdict.reason === TIMED_OUT) {
      job.timeouts = (Number(job.timeouts) || 0) + 1;
      if (job.timeouts >= maxTimeouts) {
        return {
          ...verdict, permanent: true,
          reason: `upload timed out ${job.timeouts} times (${(size / 1024 / 1024).toFixed(0)} MB) — kept on this PC`,
        };
      }
    } else if (verdict && !verdict.ok) {
      job.timeouts = 0;
    }
    return verdict;
  };
}

/**
 * Cancel a spooled strata-sync job by removing its spool files (<id>.bin and
 * <id>.json). The queue then drops it as "payload vanished" on its next pass and
 * never reloads it after a restart. {ok:true, removed} | {ok:false, reason}.
 */
function cancelSpooledJob({ spoolDir, id, fsImpl = fs }) {
  if (!spoolDir || !id || /[\\/]|\.\./.test(String(id))) return { ok: false, reason: "no such sync job" };
  let removed = 0;
  for (const ext of [".bin", ".json"]) {
    try { fsImpl.unlinkSync(path.join(spoolDir, `${id}${ext}`)); removed += 1; } catch { /* already gone */ }
  }
  return removed ? { ok: true, removed } : { ok: false, reason: "1 sync already finished — nothing to cancel" };
}

/**
 * Queue one saved recording for upload: {queued, id, syncNote, syncable}.
 * `syncable` false = it can never be uploaded (too big); syncNote says why.
 */
function queueRecordingUpload({ filePath, fsImpl = fs, enqueue }) {
  const up = uploadItem({ filePath, size: fileSize(filePath, fsImpl) });
  if (!up.ok) return { queued: false, id: null, syncNote: up.reason, syncable: false };
  try {
    const v = enqueue ? enqueue(up.item) : null;
    if (v && v.ok) return { queued: true, id: v.id || null, syncNote: null, syncable: true };
    return { queued: false, id: null, syncNote: `1 recording not queued for sync — ${(v && v.reason) || "sync queue unavailable"}`, syncable: true };
  } catch (error) {
    return { queued: false, id: null, syncNote: `1 recording not queued for sync — ${String((error && error.message) || error).slice(0, 120)}`, syncable: true };
  }
}

function fileSize(filePath, fsImpl = fs) {
  try { return fsImpl.statSync(filePath).size; } catch { return 0; }
}

/**
 * Temp WebMs an interrupted session left in os.tmpdir()/aither-recorder (a crash,
 * a failed move, a refused start) are RECOVERED into the recordings folder as
 * "Recording <mtime> (recovered).webm", never deleted unseen. Empty ones are
 * removed; files younger than `staleMs`, and `exclude`, are left alone.
 *
 * @returns {{recovered: string[], failed: string[], removed: number}}
 */
function recoverStaleRecordings({ tempDirPath = tempDir(), dir, fsImpl = fs, now = Date.now(), exclude = null, staleMs = STALE_AFTER_MS }) {
  const out = { recovered: [], failed: [], removed: 0 };
  let entries;
  try { entries = fsImpl.readdirSync(tempDirPath); } catch { return out; }
  for (const entry of entries.filter((e) => TEMP_FILE_RE.test(e)).sort()) {
    const full = path.join(tempDirPath, entry);
    if (exclude && path.resolve(full) === path.resolve(exclude)) continue;
    let st;
    try { st = fsImpl.statSync(full); } catch { continue; }
    if (now - st.mtimeMs < staleMs) continue;
    if (!st.size) {
      try { fsImpl.unlinkSync(full); out.removed += 1; } catch { /* the next start tries again */ }
      continue;
    }
    try {
      // Never the recursive mkdir into Videos: under Controlled Folder Access it loops
      // forever on the main thread (snip-capture.cjs writableDir, measured 2026-11-01).
      const where = snip.writableDir([dir, snip.fallbackCaptureDir("Recordings")], { fsImpl });
      if (!where.ok) { out.failed.push(entry); continue; }
      out.dir = where.dir;
      const target = snip.uniquePath(where.dir, recordingName(new Date(st.mtimeMs), "webm", " (recovered)"), (p) => fsImpl.existsSync(p));
      const moved = moveFile(full, target, fsImpl, { retries: 0 });
      if (moved.ok) out.recovered.push(path.basename(target));
      else out.failed.push(entry);
    } catch {
      out.failed.push(entry);
    }
  }
  return out;
}

/** The toast line for a recovery pass, or null when there was nothing to recover. */
function recoveredLine({ recovered = [], failed = [] } = {}, tempDirPath = tempDir()) {
  if (!recovered.length && !failed.length) return null;
  const parts = [];
  if (recovered.length) {
    const { shown, more } = capList(recovered);
    parts.push(`${recovered.length} unsaved recording${recovered.length === 1 ? "" : "s"} recovered — in Videos · Aither Recordings`
      + ` (${shown.join(", ")}${more ? `, +${more} more` : ""})`);
  }
  if (failed.length) {
    parts.push(`${failed.length} recording${failed.length === 1 ? "" : "s"} still in ${tempDirPath} — move ${failed.length === 1 ? "it" : "them"} manually`);
  }
  return parts.join(" · ");
}

/** The move failed: the WebM is still in temp, and the reason says where. */
function leftInTemp(tempPath, why) {
  return {
    ok: false,
    keptAt: tempPath,
    reason: `1 recording left in ${tempPath} — move it manually (${String(why || "move failed").slice(0, 80)})`,
  };
}

/**
 * Turn the temp WebM into the saved recording: convert (when ffmpeg + format
 * allow), verify, name it, and queue its upload ONLY when `sync` is true (the
 * owner's opt-in). `run(bin, args)` is an injected execFile wrapper that resolves
 * {ok, reason}; every edge is injected. `truncated` is the chunk writer's sticky
 * failure: what was written is still saved, and the note says it is cut short.
 *
 * @returns {Promise<{ok:true, path, name, format, queued, queueId, syncable, note, syncNote}
 *                  | {ok:false, reason, keptAt?}>}
 */
async function finalizeRecording({
  tempPath, dir, startedAt = new Date(), format = "mp4", ffmpeg = null, audio = true,
  run, fsImpl = fs, enqueue, sync = false, truncated = null, moveOpts,
}) {
  try {
    const size = fileSize(tempPath, fsImpl);
    if (!size) {
      try { fsImpl.unlinkSync(tempPath); } catch { /* never created */ }
      return {
        ok: false,
        reason: truncated
          ? `1 recording could not be written — ${String(truncated).slice(0, 160)}`
          : "1 recording came back empty — check screen-recording permission and try again",
      };
    }
    // Never the recursive mkdir into Videos: under Controlled Folder Access it loops
    // forever on the main thread (snip-capture.cjs writableDir, measured 2026-11-01).
    const where = snip.writableDir([dir, snip.fallbackCaptureDir("Recordings")], { fsImpl });
    if (!where.ok) return leftInTemp(tempPath, where.reason);
    const preferredDir = dir;
    dir = where.dir;
    const wanted = parseFormat(format);
    const target = snip.uniquePath(dir, recordingName(startedAt, wanted), (p) => fsImpl.existsSync(p));
    const plan = convertPlan({ format: wanted, ffmpeg, input: tempPath, output: target, audio });
    let finalPath = target;
    let note = plan.note;
    if (where.fallback) {
      const moved = snip.fallbackNote(preferredDir, dir);
      note = note ? `${moved} · ${note}` : moved;
    }
    const keepWebm = () => {
      const webm = snip.uniquePath(dir, recordingName(startedAt, "webm"), (p) => fsImpl.existsSync(p));
      const moved = moveFile(tempPath, webm, fsImpl, moveOpts);
      return moved.ok ? { ok: true, path: webm } : moved;
    };
    if (plan.args && typeof run === "function") {
      const r = await run(ffmpeg, plan.args);
      const check = r && r.ok ? verifyOutput(target, wanted, fsImpl) : null;
      if (!check || !check.ok) {
        try { fsImpl.unlinkSync(target); } catch { /* nothing half-written */ }
        const why = check ? `ffmpeg wrote ${check.reason}` : String((r && r.reason) || "ffmpeg");
        note = `1 conversion failed (${why.slice(0, 120)}) — kept as WebM`;
        const kept = keepWebm();
        if (!kept.ok) return leftInTemp(tempPath, kept.reason);
        finalPath = kept.path;
      } else {
        try { fsImpl.unlinkSync(tempPath); } catch { /* recovered on the next start */ }
      }
    } else if (plan.ext === wanted) {
      const moved = moveFile(tempPath, target, fsImpl, moveOpts);
      if (!moved.ok) return leftInTemp(tempPath, moved.reason);
    } else {
      const kept = keepWebm();
      if (!kept.ok) return leftInTemp(tempPath, kept.reason);
      finalPath = kept.path;
    }
    if (truncated) {
      const cut = `1 recording truncated — ${String(truncated).slice(0, 120)}; what came before is saved`;
      note = note ? `${cut} · ${note}` : cut;
    }
    let sent;
    if (sync) sent = queueRecordingUpload({ filePath: finalPath, fsImpl, enqueue });
    else {
      const up = uploadItem({ filePath: finalPath, size: fileSize(finalPath, fsImpl) });
      sent = { queued: false, id: null, syncNote: up.ok ? null : up.reason, syncable: up.ok };
    }
    return {
      ok: true, path: finalPath, name: path.basename(finalPath),
      format: path.extname(finalPath).slice(1),
      queued: sent.queued, queueId: sent.id, syncable: sent.syncable, note, syncNote: sent.syncNote,
    };
  } catch (error) {
    return { ok: false, reason: `1 recording could not be saved — ${String((error && error.message) || error).slice(0, 200)}` };
  }
}

/**
 * ffmpeg gdigrab argv for one segment of a NATIVE recording: a display that
 * desktopCapturer cannot see. Measured 2026-11-02: the desk is pinned to the iGPU
 * (present-policy.cjs) and Windows then hides the RTX 5090's 4K output from
 * Chromium's capturer, so getUserMedia has no source for it; GDI sees every screen.
 * `rect` is in PHYSICAL pixels (virtual-desktop coordinates, may be negative).
 */
function nativeGrabArgs({ rect, fps = DEFAULT_FPS, output }) {
  const width = Math.floor(rect.width) - (Math.floor(rect.width) % 2);
  const height = Math.floor(rect.height) - (Math.floor(rect.height) % 2);
  if (!output || width < 2 || height < 2) return null;
  return [
    "-hide_banner", "-loglevel", "error", "-f", "gdigrab",
    "-framerate", String(Math.max(1, Math.min(60, Math.round(Number(fps) || DEFAULT_FPS)))),
    "-offset_x", String(Math.round(rect.x)), "-offset_y", String(Math.round(rect.y)),
    "-video_size", `${width}x${height}`, "-draw_mouse", "1", "-i", "desktop",
    "-c:v", "libx264", "-preset", "ultrafast", "-crf", "18", "-pix_fmt", "yuv420p", "-y", output,
  ];
}

/** ffmpeg concat-demuxer list for native segments (single quotes escaped per its syntax). */
function nativeConcatList(paths) {
  return (paths || []).map((p) => `file '${String(p).replace(/\\/g, "/").replace(/'/g, "'\\''")}'`).join("\n") + "\n";
}

module.exports = {
  FOLDER_NAME, FORMATS, UPLOAD_FOLDER, MAX_UPLOAD_BYTES, DEFAULT_FPS, GIF_FPS, GIF_MAX_WIDTH,
  FFMPEG_TIMEOUT_MS, FFMPEG_REMEDY, CONTENT_TYPES, VISIBLE_CAP,
  UPLOAD_TIMEOUT_FLOOR_MS, UPLOAD_MIN_BYTES_PER_SEC, MAX_UPLOAD_TIMEOUTS, TEMP_DIR_NAME, STALE_AFTER_MS,
  recordingName, recordingDir, tempDir, parseFormat, normalizeOptions, evenRect, cropForStream,
  captureConstraints, systemAudioConstraints, findFfmpeg, mp4Args, gifArgs, convertPlan,
  uploadItem, formatElapsed, elapsedMs, capList, syncLine, createChunkWriter, finalizeRecording,
  moveFile, verifyOutput, uploadTimeoutMs, createRecordingUploader, cancelSpooledJob,
  queueRecordingUpload, recoverStaleRecordings, recoveredLine, nativeGrabArgs, nativeConcatList,
};
