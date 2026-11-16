"use strict";

/**
 * assist-utils.cjs -- the PowerToys / Sysinternals class of utilities, run from the Aither
 * pop-up. INTEGRATE, never reimplement: every row here finds the tool the owner already
 * installed and drives IT. A tool that is not installed is greyed with the plain reason; it
 * is never faked.
 *
 *   ocr       PowerToys Text Extractor   signals PowerToys' own PowerOCR event, then waits for the
 *                                        text it puts on the clipboard and shows it here
 *   color     PowerToys Color Picker     signals its show event
 *   ontop     PowerToys Always On Top    re-focuses the captured window, signals its pin event
 *   awake     PowerToys Awake            PowerToys.Awake.exe --time-limit N --display-on (ours, killable)
 *   locks     PowerToys File Locksmith   FileLocksmithCLI.exe --json <path>  (handle64 when absent)
 *   procinfo  Sysinternals pslist        pslist64 -x <pid of the focused app>
 *   procexp   Sysinternals Process Explorer   opens it
 *   resize    PowerToys Image Resizer    ImageResizerCLI.exe --width N --unit Pixel (never --replace)
 *
 * How PowerToys is driven: its modules wait on named events (`Local\PowerOCREvent-...`) that
 * its own hotkeys set. The names below were read out of PowerToys.Interop.dll of the
 * installed 0.102 build and are a FIXED allow-list -- no caller supplies an event name. A
 * module whose event is absent (the runner is not running, or the module is disabled) makes
 * us start the runner the owner installed (their click on the utility is the consent) and
 * retry once for a few seconds; if it is still absent the answer says so.
 *
 * Nothing here is destructive: no `--kill`, no `--replace`, no handle closing. A verb that
 * would be (end a locking process, overwrite an image) is deliberately absent; the Explorer
 * file verbs raise a decision card for anything that changes or removes a file.
 *
 * Every run is an argv ARRAY through execFile / spawn (shell:false) on an absolute path that
 * exists; the only text that reaches a command line is a validated path or a validated
 * integer. Electron-free; every effect is injected for `node --test`.
 */

const fs = require("node:fs");
const path = require("node:path");
const core = require("./assist-core.cjs");
const { createTools, findTool, powerToysDirs, sysinternalsDirs, powershellExe } = require("./assist-tools.cjs");

/** Fixed PowerToys event names (PowerToys.Interop.dll, 0.102). Never taken from a caller. */
const PT_EVENTS = Object.freeze({
  ocr: "Local\\PowerOCREvent-dc864e06-e1af-4ecc-9078-f98bee745e3a",
  color: "Local\\ShowColorPickerEvent-8c46be2a-3e05-4186-b56b-4ae986ef2525",
  ontop: "Local\\AlwaysOnTopPinEvent-892e0aa2-cfa8-4cc4-b196-ddeb32314ce8",
});

const IMAGE_EXT = new Set([".png", ".jpg", ".jpeg", ".bmp", ".gif", ".tif", ".tiff", ".webp", ".heic"]);
const OUT_MAX = 6000;
const TOOLS_TIMEOUT_MS = 20000;
const LOCKS_TIMEOUT_MS = 100000; // measured 2026-11-16: FileLocksmithCLI took 43 s on this PC
const OCR_WAIT_MS = 90000;

/** First line of a selection as an existing absolute Windows path, else null. Pure given existsSync. */
function pathFromSelection(selection, existsSync = fs.existsSync) {
  const first = String(selection || "").split(/\r?\n/).map((l) => l.trim()).find(Boolean) || "";
  const bare = first.replace(/^"(.*)"$/, "$1").trim();
  // eslint-disable-next-line no-control-regex -- control characters are exactly what this strips
  if (!/^[A-Za-z]:\\[^<>"|?*\u0000-\u001f]+$/.test(bare) || bare.startsWith("\\\\?\\")) return null;
  if (bare.split("\\").some((part) => part === "..")) return null;
  try { return existsSync(bare) ? bare : null; } catch { return null; }
}

/** "30m", "2h", "90" (minutes), "45s" -> seconds, capped to 24 h; null when unparseable. */
function parseDuration(text) {
  const m = /^\s*(\d{1,4})\s*(s|sec|m|min|h|hr|hour|hours)?\s*$/i.exec(String(text || ""));
  if (!m) return null;
  const n = Number(m[1]);
  const unit = (m[2] || "m").toLowerCase();
  const seconds = unit.startsWith("h") ? n * 3600 : unit.startsWith("s") ? n : n * 60;
  return seconds > 0 && seconds <= 86400 ? seconds : null;
}

function clipOut(text) {
  // eslint-disable-next-line no-control-regex -- control characters are exactly what this strips
  const t = String(text || "").replace(/\u0000/g, "").trim();
  return t.length > OUT_MAX ? `${t.slice(0, OUT_MAX)}\n... (cut at ${OUT_MAX} characters)` : t;
}

const SIGNAL_SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  "try { $e = [System.Threading.EventWaitHandle]::OpenExisting($env:AWDESK_PT_EVENT); [void]$e.Set(); exit 0 }",
  "catch [System.Threading.WaitHandleCannotBeOpenedException] { exit 3 }",
  "catch { exit 4 }",
].join("; ");

function createAssistUtils({
  env = process.env, platform = process.platform, existsSync = fs.existsSync,
  execFile = require("node:child_process").execFile, spawn = require("node:child_process").spawn,
  clipboard = null, caret = null, log = null, getSettings = () => ({}), tools = null,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)), now = Date.now,
} = {}) {
  const win = platform === "win32";
  let awakeChild = null;

  // Tools come from KNOWN install dirs only (never PATH) and are signature-checked before
  // they run (assist-tools.cjs). `pt`/`si` say "installed"; `use` is the gate before an exec.
  const toolbox = tools || createTools({ env, platform, existsSync, execFile });
  const pt = (names) => toolbox.locate(names, "powertoys");
  const si = (names) => toolbox.locate(names, "sysinternals");
  /** null = not installed; { ok:false, error } = installed but untrusted; { ok:true, path } = may run. */
  const use = (names, family) => toolbox.resolve(names, family);

  const CATALOG = [
    { id: "ocr", label: "Extract text from screen", hint: "PowerToys Text Extractor", needs: "none", tool: () => pt(["PowerToys.PowerOCR.exe"]), requires: "PowerToys (winget install Microsoft.PowerToys)" },
    { id: "color", label: "Pick a colour", hint: "PowerToys Color Picker", needs: "none", tool: () => pt(["PowerToys.ColorPickerUI.exe"]), requires: "PowerToys" },
    { id: "ontop", label: "Keep this window on top", hint: "PowerToys Always On Top (toggles the app you were in)", needs: "target", tool: () => pt(["PowerToys.AlwaysOnTop.exe"]), requires: "PowerToys" },
    { id: "awake", label: "Keep PC awake 1 h", hint: "PowerToys Awake", needs: "none", tool: () => pt(["PowerToys.Awake.exe"]), requires: "PowerToys" },
    { id: "awake-off", label: "Let PC sleep again", hint: "ends the Awake Aither started", needs: "none", tool: () => pt(["PowerToys.Awake.exe"]), requires: "PowerToys" },
    { id: "locks", label: "What locks this file?", hint: "select a file path first · PowerToys File Locksmith (Sysinternals handle as a fallback)", needs: "path", tool: () => pt(["FileLocksmithCLI.exe"]) || si(["handle64.exe", "handle.exe"]), requires: "PowerToys or Sysinternals handle" },
    { id: "procinfo", label: "Process info for this app", hint: "Sysinternals pslist on the app you were in", needs: "target", tool: () => si(["pslist64.exe", "pslist.exe"]), requires: "Sysinternals (winget install Microsoft.Sysinternals)" },
    { id: "procexp", label: "Open Process Explorer", hint: "Sysinternals", needs: "none", tool: () => si(["procexp64.exe", "procexp.exe"]), requires: "Sysinternals" },
    { id: "resize", label: "Shrink image to 1280 px wide", hint: "select an image path first · PowerToys Image Resizer; writes a copy, never replaces", needs: "path", tool: () => pt(["PowerToys.ImageResizerCLI.exe"]), requires: "PowerToys" },
  ];
  const byId = new Map(CATALOG.map((u) => [u.id, u]));

  function list() {
    return CATALOG.map((u) => {
      const exe = win ? u.tool() : null;
      return { id: u.id, label: u.label, hint: u.hint, needs: u.needs, available: Boolean(exe), missing: exe ? "" : (win ? `Needs ${u.requires}` : "Windows only") };
    });
  }

  function exec(file, args, { timeoutMs = TOOLS_TIMEOUT_MS } = {}) {
    return new Promise((resolve) => {
      try {
        execFile(file, args, { timeout: timeoutMs, windowsHide: true, shell: false, maxBuffer: 2 * 1024 * 1024 }, (error, stdout, stderr) => {
          resolve({ error, code: error && typeof error.code === "number" ? error.code : 0, killed: Boolean(error && error.killed), stdout: String(stdout || ""), stderr: String(stderr || "") });
        });
      } catch (error) { resolve({ error, code: -1, stdout: "", stderr: String(error && error.message) }); }
    });
  }

  /** Set one of PowerToys' fixed events; start the owner's runner once if the event is not there. */
  async function signal(eventName) {
    const run = () => {
      try {
        return new Promise((resolve) => {
          execFile(powershellExe(env), ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", SIGNAL_SCRIPT],
            { timeout: 8000, windowsHide: true, shell: false, env: { ...process.env, AWDESK_PT_EVENT: eventName } }, (error) => resolve(error && typeof error.code === "number" ? error.code : error ? -1 : 0));
        });
      } catch { return Promise.resolve(-1); }
    };
    let code = await run();
    if (code === 0) return { ok: true };
    const runner = code === 3 ? await use(["PowerToys.exe"], "powertoys") : null;
    if (runner && !runner.ok) return { ok: false, error: runner.error };
    if (code === 3 && runner) {
      try { spawn(runner.path, [], { detached: true, stdio: "ignore", windowsHide: false }).unref(); } catch { return { ok: false, error: "Could not start PowerToys." }; }
      for (let i = 0; i < 14 && code !== 0; i += 1) { await sleep(700); code = await run(); }
      if (code === 0) return { ok: true, startedRunner: true };
    }
    return { ok: false, error: "PowerToys did not answer. Start PowerToys and make sure that utility is switched on in its settings." };
  }

  async function runOcr() {
    if (!clipboard) return { ok: false, error: "The clipboard is not available." };
    const before = clipboard.readText();
    const sig = await signal(PT_EVENTS.ocr);
    if (!sig.ok) return sig;
    const end = now() + OCR_WAIT_MS;
    while (now() < end) {
      await sleep(400);
      const text = clipboard.readText();
      if (text && text !== before) return { ok: true, text: clipOut(text), note: "Text Extractor copied this; it is also on your clipboard." };
    }
    return { ok: false, error: "No text arrived. Drag a region with Text Extractor within 90 seconds." };
  }

  async function runLocks(opts) {
    const target = pathFromSelection(opts.selection, existsSync);
    if (!target) return { ok: false, error: "Select a file path first (Explorer: Copy as path, then select the pasted text)." };
    const locksmith = await use(["FileLocksmithCLI.exe"], "powertoys");
    if (locksmith && !locksmith.ok) return { ok: false, error: locksmith.error };
    if (locksmith) {
      const r = await exec(locksmith.path, ["--json", target], { timeoutMs: LOCKS_TIMEOUT_MS });
      if (r.killed) return { ok: false, error: "File Locksmith took too long (it scans every open handle). Try again, or close apps you do not need." };
      let procs;
      try { procs = JSON.parse(r.stdout).processes; } catch { procs = null; }
      if (Array.isArray(procs)) {
        if (!procs.length) return { ok: true, text: `Nothing has ${path.win32.basename(target)} open right now.`, note: "PowerToys File Locksmith" };
        return { ok: true, text: clipOut(procs.map((p) => `${p.name} (pid ${p.pid}, ${p.user || "?"})`).join("\n")), note: `PowerToys File Locksmith: ${procs.length} process${procs.length === 1 ? "" : "es"}` };
      }
    }
    const handle = await use(["handle64.exe", "handle.exe"], "sysinternals");
    if (!handle) return { ok: false, error: "Needs PowerToys File Locksmith or Sysinternals handle." };
    if (!handle.ok) return { ok: false, error: handle.error };
    const r = await exec(handle.path, ["-accepteula", "-nobanner", target], { timeoutMs: TOOLS_TIMEOUT_MS });
    const out = clipOut(r.stdout);
    return /No matching handles/i.test(out) ? { ok: true, text: `Nothing has ${path.win32.basename(target)} open (as far as an unelevated handle can see).`, note: "Sysinternals handle" } : { ok: true, text: out, note: "Sysinternals handle" };
  }

  async function runProcInfo(opts) {
    const pid = Number(opts.pid);
    if (!Number.isInteger(pid) || pid <= 4) return { ok: false, error: "No app to inspect: open the pop-up from inside the app you mean." };
    const pslist = await use(["pslist64.exe", "pslist.exe"], "sysinternals");
    if (!pslist) return { ok: false, error: "Needs Sysinternals pslist." };
    if (!pslist.ok) return { ok: false, error: pslist.error };
    const r = await exec(pslist.path, ["-accepteula", "-nobanner", "-x", String(pid)], { timeoutMs: TOOLS_TIMEOUT_MS });
    if (r.error && !r.stdout) return { ok: false, error: `pslist failed: ${clipOut(r.stderr || String(r.error.message || r.error))}` };
    return { ok: true, text: clipOut(r.stdout), note: `Sysinternals pslist, pid ${pid}` };
  }

  async function runResize(opts) {
    const target = pathFromSelection(opts.selection, existsSync);
    if (!target || !IMAGE_EXT.has(path.win32.extname(target).toLowerCase())) return { ok: false, error: "Select an image file path first (png, jpg, gif, bmp, tiff, webp)." };
    const width = Number.parseInt(String(opts.arg || "1280"), 10);
    if (!Number.isInteger(width) || width < 16 || width > 16000) return { ok: false, error: "Width must be between 16 and 16000 pixels." };
    const resizer = await use(["PowerToys.ImageResizerCLI.exe"], "powertoys");
    if (!resizer) return { ok: false, error: "Needs PowerToys Image Resizer." };
    if (!resizer.ok) return { ok: false, error: resizer.error };
    const r = await exec(resizer.path, ["--width", String(width), "--unit", "Pixel", "--fit", "Fit", "--shrink-only", target], { timeoutMs: 60000 });
    if (r.error) return { ok: false, error: `Image Resizer failed: ${clipOut(r.stderr || r.stdout || String(r.error.message || r.error))}` };
    return { ok: true, text: clipOut(r.stdout) || "Done.", note: "PowerToys Image Resizer wrote a resized copy next to the original; the original is untouched." };
  }

  const RUNNERS = {
    ocr: runOcr,
    color: async () => { const s = await signal(PT_EVENTS.color); return s.ok ? { ok: true, note: "Colour Picker is open: click a colour; PowerToys copies it." } : s; },
    ontop: async (opts) => {
      if (!caret || !Number.isFinite(Number(opts.hwnd)) || Number(opts.hwnd) <= 0) return { ok: false, error: "No window to pin: open the pop-up from inside the window you mean." };
      if (opts.hide) opts.hide();
      const f = await caret.focus({ hwnd: opts.hwnd });
      if (!f || !f.ok) return { ok: false, error: "Could not switch back to that window." };
      await sleep(180);
      const s = await signal(PT_EVENTS.ontop);
      return s.ok ? { ok: true, note: "Always On Top toggled for that window." } : s;
    },
    awake: async (opts) => {
      const seconds = parseDuration(opts.arg) || 3600;
      if (awakeChild) { try { awakeChild.kill(); } catch { /* gone */ } awakeChild = null; }
      const exe = await use(["PowerToys.Awake.exe"], "powertoys");
      if (!exe) return { ok: false, error: "Needs PowerToys Awake." };
      if (!exe.ok) return { ok: false, error: exe.error };
      try {
        awakeChild = spawn(exe.path, ["--time-limit", String(seconds), "--display-on"], { detached: false, stdio: "ignore", windowsHide: true });
        awakeChild.on("exit", () => { awakeChild = null; });
      } catch (error) { return { ok: false, error: `Could not start Awake: ${String((error && error.message) || error)}` }; }
      return { ok: true, note: `PowerToys Awake keeps this PC and its screen awake for ${Math.round(seconds / 60)} min.` };
    },
    "awake-off": async () => {
      if (!awakeChild) return { ok: true, note: "Aither has no Awake running. (An Awake you started in PowerToys is yours to stop there.)" };
      try { awakeChild.kill(); } catch { /* gone */ }
      awakeChild = null;
      return { ok: true, note: "Awake ended. The PC can sleep again." };
    },
    locks: runLocks,
    procinfo: runProcInfo,
    procexp: async () => {
      const exe = await use(["procexp64.exe", "procexp.exe"], "sysinternals");
      if (!exe) return { ok: false, error: "Needs Sysinternals Process Explorer." };
      if (!exe.ok) return { ok: false, error: exe.error };
      try { spawn(exe.path, ["/accepteula"], { detached: true, stdio: "ignore" }).unref(); } catch (error) { return { ok: false, error: String((error && error.message) || error) }; }
      return { ok: true, note: "Process Explorer opened." };
    },
    resize: runResize,
  };

  /**
   * Run one listed utility. `opts`: {selection, pid, hwnd, arg, hide}. Logged before it
   * runs and again with the outcome; a log failure refuses the run, like every other verb.
   */
  async function run(id, opts = {}) {
    const u = byId.get(String(id || ""));
    if (!u) return { ok: false, error: "Unknown utility." };
    if (!win) return { ok: false, error: "Utilities are Windows only." };
    if (!u.tool()) return { ok: false, error: `Needs ${u.requires}. Aither runs the tool you install; it does not copy it.` };
    const rec = (outcome, extra) => core.logRecord({ id: `u${now().toString(36)}`, surface: "desk", verb: `util:${u.id}`, ctx: { app: opts.app, title: opts.title }, settings: getSettings(), outcome, extra: { tool: u.hint, ...(extra || {}) }, now: now() });
    if (log) {
      const written = log.append(rec("started"));
      if (written && written.ok === false) return { ok: false, error: `Not run: the action log is not writable (${written.error}).` };
    }
    let result;
    try { result = await RUNNERS[u.id](opts); } catch (error) { result = { ok: false, error: String((error && error.message) || error) }; }
    if (log) log.append({ ...rec(result.ok ? "ok" : "error"), ...(result.ok ? {} : { error: String(result.error || "").slice(0, 300) }) });
    return result;
  }

  return { list, run, signal, stop: () => { if (awakeChild) { try { awakeChild.kill(); } catch { /* gone */ } awakeChild = null; } } };
}

module.exports = {
  createAssistUtils, pathFromSelection, parseDuration, findTool, powerToysDirs, sysinternalsDirs,
  PT_EVENTS, SIGNAL_SCRIPT, IMAGE_EXT, OUT_MAX,
};
