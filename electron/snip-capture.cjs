"use strict";

/**
 * snip-capture.cjs -- the Electron-free half of the desk's snipping tool (owner
 * 2026-11-01: "stop using the Windows Snipping Tool"). snip-window.cjs owns the
 * overlay windows, desktopCapturer and the toast; everything here is pure math or
 * injected I/O, so snip-capture.test.cjs runs it under `node --test`.
 *
 *   PrintScreen -> one frozen overlay per display -> drag a region (Esc cancels,
 *   Enter / double-click takes the display) -> crop at NATIVE pixels -> PNG in
 *   ~/Pictures/Aither Screenshots/"Screenshot YYYY-MM-DD HHMMSS.png" -> system
 *   clipboard -> toast [Ask Aither] [Copy path] [Open folder] -> queued upload to
 *   the owner's Strata `screenshots` folder (strata-sync.cjs; never blocks).
 *
 * THE SCALE RULE. The overlay is laid out in DIPs (the display's `bounds`); the
 * frozen frame is DEVICE pixels (bounds x scaleFactor on a 150% laptop panel). A
 * selection is converted with the ratio of the frame's REAL size to the bounds,
 * not with `scaleFactor` alone: desktopCapturer may hand back a frame a pixel or
 * two off the product (odd DIP sizes round), and a crop computed from the factor
 * then reads past the frame edge. Every rect is clamped to the frame.
 *
 * Same degradation contract as every desk module: {ok:false, reason}, never throws.
 */

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const FOLDER_NAME = "Aither Screenshots";
/** A drag shorter than this (DIPs) on either axis is a click, not a region. */
const MIN_REGION_DIP = 4;

function pad(n, width = 2) {
  return String(n).padStart(width, "0");
}

/** "Screenshot 2026-11-01 093007.png" in LOCAL time -- what Explorer sorts by. */
function screenshotName(date = new Date()) {
  const d = date instanceof Date ? date : new Date(date);
  return `Screenshot ${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} `
    + `${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}.png`;
}

/**
 * ~/Pictures/Aither Screenshots. `picturesDir` is Electron's app.getPath("pictures")
 * (honours a OneDrive-redirected Pictures folder); the fallback is ~/Pictures.
 */
function screenshotDir({ picturesDir, homeDir = os.homedir() } = {}) {
  return path.join(picturesDir || path.join(homeDir, "Pictures"), FOLDER_NAME);
}

// ── a folder the desk may actually write into ───────────────────────────────
//
// Measured 2026-11-01 on the owner's box: Windows Defender Controlled Folder Access
// is ON and protects Pictures and Videos. It refuses the desk's electron.exe there
// (Defender event 1123), and Node's fs.mkdirSync(dir, {recursive: true}) does not
// throw on that refusal on Windows -- it LOOPS FOREVER on the main thread. A screen
// recording froze the whole desk (bridge dead, then the process gone), and the
// first PrtSc into Pictures would have done the same.
//
// So: never the recursive call. ensureDirSafe creates one missing level at a time
// (each non-recursive mkdir throws at once on a refusal), writableDir probes the
// folder with a zero-byte file ONCE per folder per 5 min, and the capture falls back
// to ~/Aither Captures/<kind> -- the home root is not a protected folder.

const CAPTURES_FALLBACK = "Aither Captures";
const VERDICT_TTL_MS = 5 * 60_000;
const dirVerdicts = new Map();

/** mkdir -p, one level at a time; throws the first refusal instead of looping. */
function ensureDirSafe(dir, fsImpl = fs) {
  const missing = [];
  let cur = path.resolve(String(dir || ""));
  while (!fsImpl.existsSync(cur)) {
    missing.unshift(cur);
    const up = path.dirname(cur);
    if (up === cur) break;
    cur = up;
  }
  for (const p of missing) fsImpl.mkdirSync(p);
}

/** ~/Aither Captures/<kind>: where a capture lands when the preferred folder refuses. */
function fallbackCaptureDir(kind, homeDir = os.homedir()) {
  return path.join(homeDir, CAPTURES_FALLBACK, String(kind || "Captures"));
}

/**
 * The first of `candidates` this process can write into. Each folder is probed with
 * a zero-byte file (created and removed); the verdict is cached VERDICT_TTL_MS so a
 * refusal does not raise a Defender notification on every capture, and an owner who
 * allows the desk afterwards is picked up within minutes.
 *
 * @returns {{ok: true, dir: string, fallback: boolean, refused: string[]} | {ok: false, reason: string}}
 */
function writableDir(candidates, { fsImpl = fs, now = () => Date.now() } = {}) {
  const refused = [];
  const list = (Array.isArray(candidates) ? candidates : [candidates]).filter(Boolean);
  for (let i = 0; i < list.length; i += 1) {
    const dir = path.resolve(list[i]);
    const cached = dirVerdicts.get(dir);
    if (cached && now() - cached.at < VERDICT_TTL_MS) {
      if (cached.ok) return { ok: true, dir, fallback: i > 0, refused };
      refused.push(`${dir} (${cached.why})`);
      continue;
    }
    try {
      ensureDirSafe(dir, fsImpl);
      const probe = path.join(dir, `.aither-write-probe-${process.pid}`);
      fsImpl.writeFileSync(probe, "");
      try { fsImpl.unlinkSync(probe); } catch { /* a stray zero-byte probe is harmless */ }
      dirVerdicts.set(dir, { ok: true, at: now() });
      return { ok: true, dir, fallback: i > 0, refused };
    } catch (error) {
      const why = (error && error.code) || String((error && error.message) || error).slice(0, 80);
      dirVerdicts.set(dir, { ok: false, why, at: now() });
      refused.push(`${dir} (${why})`);
    }
  }
  return { ok: false, reason: `${refused.length} folders refused the write — ${refused.join("; ")}` };
}

/** The toast note when a capture had to fall back. */
function fallbackNote(preferred, used) {
  return `Windows blocked ${path.basename(path.dirname(preferred)) || preferred} (Controlled Folder Access) — `
    + `saved to ${used}. Allow Aither under Windows Security › Ransomware protection to save there.`;
}

/** Forget cached folder verdicts (tests; an owner who just allowed the desk). */
function resetDirVerdicts() {
  dirVerdicts.clear();
}

/** Two captures in one second must not overwrite each other: "... (2).png". */
function uniquePath(dir, name, exists = fs.existsSync) {
  const first = path.join(dir, name);
  if (!exists(first)) return first;
  const ext = path.extname(name);
  const stem = name.slice(0, name.length - ext.length);
  for (let i = 2; i < 1000; i += 1) {
    const next = path.join(dir, `${stem} (${i})${ext}`);
    if (!exists(next)) return next;
  }
  return path.join(dir, `${stem} (${Date.now()})${ext}`);
}

/** The rect two drag points span, whatever direction the drag went. */
function normalizeDrag(a, b) {
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return { x, y, width: Math.abs(a.x - b.x), height: Math.abs(a.y - b.y) };
}

function isRegion(rect, min = MIN_REGION_DIP) {
  return Boolean(rect) && rect.width >= min && rect.height >= min;
}

/**
 * A selection in overlay DIPs -> the crop rect in frame device pixels.
 *
 * @param {{x,y,width,height}} rect  relative to the display's top-left, DIPs
 * @param {{bounds:{width,height}, scaleFactor?:number}} display
 * @param {{width:number,height:number}} [frame] the captured frame's real size
 * @returns {{x,y,width,height}|null} null when nothing is left after clamping
 */
function regionToDevice(rect, display, frame) {
  if (!rect || !display || !display.bounds) return null;
  const sf = Number(display.scaleFactor) > 0 ? Number(display.scaleFactor) : 1;
  const fw = frame && frame.width > 0 ? frame.width : Math.round(display.bounds.width * sf);
  const fh = frame && frame.height > 0 ? frame.height : Math.round(display.bounds.height * sf);
  const kx = fw / display.bounds.width;
  const ky = fh / display.bounds.height;
  const x0 = Math.max(0, Math.min(fw, Math.round(rect.x * kx)));
  const y0 = Math.max(0, Math.min(fh, Math.round(rect.y * ky)));
  const x1 = Math.max(0, Math.min(fw, Math.round((rect.x + rect.width) * kx)));
  const y1 = Math.max(0, Math.min(fh, Math.round((rect.y + rect.height) * ky)));
  if (x1 - x0 < 1 || y1 - y0 < 1) return null;
  return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
}

/** The frame size desktopCapturer must be asked for so no display is downscaled. */
function thumbnailSizeFor(displays) {
  let width = 0;
  let height = 0;
  for (const d of displays || []) {
    const sf = Number(d.scaleFactor) > 0 ? Number(d.scaleFactor) : 1;
    width = Math.max(width, Math.round(d.bounds.width * sf));
    height = Math.max(height, Math.round(d.bounds.height * sf));
  }
  return { width: width || 1920, height: height || 1080 };
}

/**
 * Pair each display with its capture source. Electron sets `display_id` on screen
 * sources; when a platform leaves it empty (some Linux portals) the order is the
 * fallback -- documented as the one guess this module makes.
 */
function matchSources(displays, sources) {
  const out = [];
  (displays || []).forEach((display, index) => {
    const byId = (sources || []).find((s) => String(s.display_id || "") === String(display.id));
    // The order fallback only takes a source that names NO display. Measured 2026-11-02:
    // Windows (4K + 1080p) returned ONE source, display_id = the 1080p screen; the old
    // `sources[index]` gave it to the 4K display too, so Print Screen showed the second
    // monitor blown up over the main one. A display with no source of its own is left
    // out here and captured natively (snip-window nativeFrame).
    const byOrder = (sources || [])[index];
    const source = byId || (byOrder && !String(byOrder.display_id || "") ? byOrder : null);
    if (source) out.push({ display, source });
  });
  return out;
}

/**
 * Persist one capture: write the PNG, put it on the clipboard, queue the upload.
 * Every edge is injected; the upload is fire-and-forget by contract.
 *
 * @param {{png: Buffer, dir: string, now?: Date, fsImpl?: object,
 *          toClipboard?: (filePath:string) => void,
 *          enqueue?: (item:object) => {ok:boolean}}} args
 * @returns {{ok:true, path:string, name:string, queued:boolean} | {ok:false, reason:string}}
 */
function saveCapture({ png, dir, now = new Date(), fsImpl = fs, toClipboard, enqueue, fallbackDir = fallbackCaptureDir("Screenshots") }) {
  try {
    if (!png || !png.length) return { ok: false, reason: "the capture came back empty" };
    const where = writableDir([dir, fallbackDir], { fsImpl });
    if (!where.ok) return { ok: false, reason: `could not save the screenshot: ${where.reason}` };
    const note = where.fallback ? fallbackNote(dir, where.dir) : null;
    dir = where.dir;
    const filePath = uniquePath(dir, screenshotName(now), (p) => fsImpl.existsSync(p));
    fsImpl.writeFileSync(filePath, png);
    try {
      if (toClipboard) toClipboard(filePath);
    } catch { /* the file is saved; a clipboard refusal must not lose it */ }
    let queued = false;
    try {
      queued = Boolean(enqueue && enqueue({
        folder: "screenshots", name: path.basename(filePath), bytes: png, contentType: "image/png",
      }).ok);
    } catch { queued = false; }
    return { ok: true, path: filePath, name: path.basename(filePath), queued, note, dir };
  } catch (error) {
    return { ok: false, reason: `could not save the screenshot: ${String((error && error.message) || error).slice(0, 200)}` };
  }
}

// ── Windows PrintScreen ownership ──────────────────────────────────────────
// Windows 11 sends PrtSc to Snipping Tool while this value is 1, and a global
// shortcut then never sees the key. Flipping it is the owner's call (a tray row),
// reversible by the matching "Restore Windows Snipping Tool" row.
const PRTSC_KEY = "HKCU\\Control Panel\\Keyboard";
const PRTSC_VALUE = "PrintScreenKeyForSnippingEnabled";

/** reg.exe argv to set the value: 0 = Aither owns PrtSc, 1 = Snipping Tool does. */
function printScreenRegArgs(snippingEnabled) {
  return ["add", PRTSC_KEY, "/v", PRTSC_VALUE, "/t", "REG_DWORD", "/d", snippingEnabled ? "1" : "0", "/f"];
}

function printScreenQueryArgs() {
  return ["query", PRTSC_KEY, "/v", PRTSC_VALUE];
}

/**
 * Parse `reg query` output. Returns "snipping" | "aither" | "unset". Windows 11's
 * default when the value is absent is Snipping Tool, so "unset" means Snipping
 * Tool still takes the key on current builds.
 */
function parsePrintScreenQuery(stdout) {
  const m = /PrintScreenKeyForSnippingEnabled\s+REG_DWORD\s+0x([0-9a-f]+)/i.exec(String(stdout || ""));
  if (!m) return "unset";
  return parseInt(m[1], 16) === 0 ? "aither" : "snipping";
}

module.exports = {
  FOLDER_NAME, MIN_REGION_DIP, PRTSC_KEY, PRTSC_VALUE, CAPTURES_FALLBACK,
  ensureDirSafe, fallbackCaptureDir, fallbackNote, resetDirVerdicts, writableDir,
  screenshotName, screenshotDir, uniquePath, normalizeDrag, isRegion, regionToDevice,
  thumbnailSizeFor, matchSources, saveCapture,
  printScreenRegArgs, printScreenQueryArgs, parsePrintScreenQuery,
};
