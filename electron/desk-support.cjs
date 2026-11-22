"use strict";

/** Desk support plane: crash/error reports and one-click feedback to the company app.
 *
 *  Active only on a tenant install: ~/.aither/desk-tenant.json carries `api` (the setup
 *  door's 3268 step writes it). No customer name or host is compiled in; the destination
 *  is that file's `api`, validated like the tenant host (https, a single label under
 *  aitherium.com, or an exact host in the file's own allowed_hosts).
 *
 *  Reports are scrubbed here (secrets, tokens, home paths, e-mail addresses), written to the
 *  shared outbox ~/.aither/support-outbox/ (the same format awdk's adk/support_report.py
 *  writes, so whichever is online first delivers), and uploaded with this PC's own device
 *  secret from ~/.aither/app_devices.json -> POST <api>/api/devices/<id>/reports. The app
 *  derives the tenant from that secret; nothing here names one.
 *
 *  Automatic reports are ON by default for a tenant install and OFF with
 *  ~/.aither/support.json {"enabled": false} (`adk feedback off`) or AITHER_SUPPORT_REPORTS=0.
 *  Feedback the person sends by hand is always delivered.
 *
 *  What is captured automatically: main-process uncaught exceptions (monitored, never
 *  swallowed), unhandled promise rejections, renderer/child process crashes, windows that
 *  stop responding, and the METADATA of Electron crash dumps (name, size, time -- the dump
 *  itself never leaves the PC).
 */

const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const deskTenant = require("./desk-tenant.cjs");

const MAX_TITLE = 200;
const MAX_MESSAGE = 8000;
const MAX_STACK = 16000;
const MAX_LOG_LINES = 200;
const MAX_LOG_LINE = 500;
const MAX_OUTBOX = 200;
const MAX_SCREENSHOT_CHARS = 1024 * 1024;
const FLUSH_INTERVAL_MS = 5 * 60 * 1000;
const OFF = new Set(["0", "false", "off", "no", "disabled"]);

const aitherDir = (homedir = os.homedir()) => path.join(homedir, ".aither");
const outboxDir = (homedir) => path.join(aitherDir(homedir), "support-outbox");

function readJson(file, readFile = fs.readFileSync) {
  try {
    const data = JSON.parse(String(readFile(file, "utf8")).replace(/^﻿/, ""));
    return data && typeof data === "object" && !Array.isArray(data) ? data : null;
  } catch {
    return null;
  }
}

/** Automatic reports on? env wins over the settings file; default on. */
function enabled({ env = process.env, homedir = os.homedir(), readFile } = {}) {
  const raw = String((env && env.AITHER_SUPPORT_REPORTS) || "").trim().toLowerCase();
  if (raw) return !OFF.has(raw);
  const data = readJson(path.join(aitherDir(homedir), "support.json"), readFile);
  return !(data && data.enabled === false);
}

/** The company app API from desk-tenant.json `api`, validated; null when absent/invalid. */
function tenantApi({ homedir = os.homedir(), readFile } = {}) {
  const data = readJson(deskTenant.configPath(homedir), readFile);
  if (!data || typeof data.api !== "string") return null;
  const verdict = deskTenant.validateHost(data.api, Array.isArray(data.allowed_hosts) ? data.allowed_hosts : []);
  return verdict.ok ? `https://${verdict.host}` : null;
}

/** This PC's device record for `api` (written by awdk's app_device.py), or null. */
function deviceRecord(api, { homedir = os.homedir(), readFile } = {}) {
  if (!api) return null;
  const data = readJson(path.join(aitherDir(homedir), "app_devices.json"), readFile);
  const rec = data && data[String(api).trim().replace(/\/+$/, "").toLowerCase()];
  if (!rec || typeof rec !== "object" || rec.removed) return null;
  if (typeof rec.device_id !== "string" || typeof rec.token !== "string" || !rec.device_id || !rec.token) return null;
  return { deviceId: rec.device_id, token: rec.token };
}

// ── Scrubbing (the app scrubs again with awreport on arrival) ─────────────────

const SECRET_PATTERNS = [
  /sk-ant-[A-Za-z0-9_-]+/g,
  /sk-[A-Za-z0-9_-]{4,}/g,
  /gh[pousr]_[A-Za-z0-9_]+/g,
  /\b(?:AKIA|ASIA)[0-9A-Z]{4,}/g,
  /xox[abprs]-[A-Za-z0-9-]+/g,
  /[ps]k_live_[A-Za-z0-9]+/g,
  /AIza[0-9A-Za-z_-]{10,}/g,
  /aither_sk_[A-Za-z0-9_-]+/g,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  /Bearer\s+[A-Za-z0-9._~+/=-]+/gi,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g,
];
const KV_PATTERN = /((?:password|passwd|secret|token|api[_-]?key|authorization|x-device-token)['"]?\s*[:=]\s*['"]?)[^\s'",}&]+/gi;
const URL_SECRET = /([?&](?:token|key|code|secret|sig|signature|access_token|password)=)[^&\s#]+/gi;
const EMAIL = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g;
const HOME_PATHS = [/[A-Za-z]:\\Users\\[^\\/\s:'"]+/gi, /(?:\/home\/|\/Users\/)[^/\\\s:'"]+/g];

function scrubText(value, homedir = os.homedir()) {
  if (typeof value !== "string") return value;
  let out = value;
  for (const re of SECRET_PATTERNS) out = out.replace(re, "[REDACTED]");
  out = out.replace(KV_PATTERN, "$1[REDACTED]").replace(URL_SECRET, "$1[REDACTED]");
  out = out.replace(EMAIL, "[EMAIL]");
  if (homedir) out = out.split(homedir).join("[HOME]");
  for (const re of HOME_PATHS) out = out.replace(re, "[HOME]");
  return out;
}

function scrubValue(value, homedir) {
  if (typeof value === "string") return scrubText(value, homedir);
  if (Array.isArray(value)) return value.map((v) => scrubValue(v, homedir));
  if (value && typeof value === "object") {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = scrubValue(v, homedir);
    return out;
  }
  return value;
}

/** Scrub every field but the screenshot (an image the person chose to attach). */
function scrubReport(report, homedir = os.homedir()) {
  const { screenshot, ...rest } = report;
  const out = scrubValue(rest, homedir);
  if (screenshot) out.screenshot = screenshot;
  out.scrubbed = true;
  return out;
}

const clip = (v, n) => {
  const s = v == null ? "" : String(v);
  return s.length <= n ? s : `${s.slice(0, n - 15)} ...[truncated]`;
};

/** One report envelope (the shape awdk's support_report.build_report writes). */
function buildReport({ kind, title, message = "", stack = "", logs = [], screenshot = null, extra = {} },
  { appVersion = "", versions = process.versions, platform = process.platform, release = os.release() } = {}) {
  if (!["crash", "error", "feedback", "setup"].includes(kind)) throw new Error(`bad kind ${kind}`);
  const report = {
    id: crypto.randomUUID().replace(/-/g, ""),
    created_at: Date.now() / 1000,
    kind,
    source: "desk",
    title: clip(title, MAX_TITLE),
    message: clip(message, MAX_MESSAGE),
    stack: clip(stack, MAX_STACK),
    logs: (Array.isArray(logs) ? logs : []).map((l) => clip(l, MAX_LOG_LINE)).slice(-MAX_LOG_LINES),
    app_version: clip(appVersion, 64),
    os: platform === "win32" ? "windows" : platform === "darwin" ? "macos" : platform,
    os_version: clip(release, 128),
    runtime: clip(`electron ${versions.electron || "?"} chrome ${versions.chrome || "?"}`, 64),
    extra: { ...extra },
  };
  if (typeof screenshot === "string" && screenshot.length <= MAX_SCREENSHOT_CHARS) report.screenshot = screenshot;
  return report;
}

function outboxFiles(dir) {
  try {
    return fs.readdirSync(dir).filter((n) => n.endsWith(".json")).sort().map((n) => path.join(dir, n));
  } catch {
    return [];
  }
}

/** Scrub and queue. `force` = a person sent it by hand (ignores the opt-out). */
function enqueue(report, { homedir = os.homedir(), env = process.env, force = false } = {}) {
  if (!force && !enabled({ env, homedir })) return null;
  const clean = scrubReport(report, homedir);
  const dir = outboxDir(homedir);
  fs.mkdirSync(dir, { recursive: true });
  const name = `${String(Date.now()).padStart(13, "0")}-${clean.id}.json`;
  const tmp = path.join(dir, `${name}.tmp`);
  fs.writeFileSync(tmp, JSON.stringify(clean));
  fs.renameSync(tmp, path.join(dir, name));
  const files = outboxFiles(dir);
  for (const old of files.slice(0, Math.max(0, files.length - MAX_OUTBOX))) {
    try { fs.unlinkSync(old); } catch { /* raced: fine */ }
  }
  return path.join(dir, name);
}

/** Upload queued reports with this PC's device secret. Never throws.
 *  2xx -> deleted; 400/413/415/422 -> rejected/; anything else -> kept, stop. */
async function flush({ homedir = os.homedir(), fetchImpl = globalThis.fetch, readFile, api, record, max = 20 } = {}) {
  const out = { sent: 0, rejected: 0, kept: 0, stopped: "" };
  const base = api === undefined ? tenantApi({ homedir, readFile }) : api;
  const dev = record === undefined ? deviceRecord(base, { homedir, readFile }) : record;
  const dir = outboxDir(homedir);
  if (!base || !dev || typeof fetchImpl !== "function") {
    out.stopped = !base ? "no company app configured" : !dev ? "this PC is not listed in the app yet" : "no fetch";
    out.kept = outboxFiles(dir).length;
    return out;
  }
  for (const file of outboxFiles(dir).slice(0, max)) {
    const claimed = `${file}.sending-${process.pid}`;
    try { fs.renameSync(file, claimed); } catch { continue; }
    let body;
    try {
      body = fs.readFileSync(claimed, "utf8");
      JSON.parse(body);
    } catch {
      setAside(dir, claimed, path.basename(file));
      out.rejected += 1;
      continue;
    }
    let status = 0;
    try {
      const res = await fetchImpl(`${base}/api/devices/${encodeURIComponent(dev.deviceId)}/reports`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Device-Token": dev.token },
        body,
      });
      status = Number(res && res.status) || 0;
    } catch (err) {
      try { fs.renameSync(claimed, file); } catch { /* left claimed: retried after restart */ }
      out.stopped = String((err && err.message) || err).slice(0, 200);
      break;
    }
    if (status >= 200 && status < 300) {
      try { fs.unlinkSync(claimed); } catch { /* gone */ }
      out.sent += 1;
    } else if ([400, 413, 415, 422].includes(status)) {
      setAside(dir, claimed, path.basename(file));
      out.rejected += 1;
    } else {
      try { fs.renameSync(claimed, file); } catch { /* */ }
      out.stopped = `HTTP ${status}`;
      break;
    }
  }
  out.kept = outboxFiles(dir).length;
  return out;
}

function setAside(dir, claimed, name) {
  try {
    fs.mkdirSync(path.join(dir, "rejected"), { recursive: true });
    fs.renameSync(claimed, path.join(dir, "rejected", name));
  } catch {
    try { fs.unlinkSync(claimed); } catch { /* */ }
  }
}

// ── Recent log lines ─────────────────────────────────────────────────────────

const ring = [];
let consoleWrapped = false;
/** Keep the last MAX_LOG_LINES console.error/warn lines of the main process in memory. */
function installConsoleRing(target = console) {
  if (consoleWrapped) return;
  consoleWrapped = true;
  for (const level of ["error", "warn"]) {
    const orig = target[level].bind(target);
    target[level] = (...args) => {
      try {
        ring.push(`${new Date().toISOString()} [${level}] ${args.map((a) => (a instanceof Error ? `${a.name}: ${a.message}` : String(a))).join(" ")}`);
        if (ring.length > MAX_LOG_LINES) ring.splice(0, ring.length - MAX_LOG_LINES);
      } catch { /* never break console */ }
      orig(...args);
    };
  }
}

/** The Desk's own log files (each module keeps one) + the console ring, last `n` lines. */
function recentLogLines(n = 100, { homedir = os.homedir(), tmpdir = os.tmpdir() } = {}) {
  const files = [
    path.join(aitherDir(homedir), "desk-command.jsonl"),
    path.join(aitherDir(homedir), "game-stage.log"),
    path.join(tmpdir, "desk-living-desktop.log"),
  ];
  const lines = [];
  for (const f of files) {
    try {
      const st = fs.statSync(f);
      const fd = fs.openSync(f, "r");
      const len = Math.min(st.size, 64 * 1024);
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, st.size - len);
      fs.closeSync(fd);
      const tail = buf.toString("utf8").split(/\r?\n/).filter(Boolean).slice(-Math.ceil(n / 2));
      lines.push(`--- ${path.basename(f)} ---`, ...tail);
    } catch { /* absent: fine */ }
  }
  if (ring.length) lines.push("--- console ---", ...ring);
  return lines.slice(-n);
}

// ── Crash hooks ──────────────────────────────────────────────────────────────

/** Install the automatic reporters. `report(kind, title, details)` queues one report.
 *  Returns the list of hooks it installed (tests read it). Never throws. */
function installCrashHooks({ app, crashReporter, proc = process, report, homedir = os.homedir() }) {
  const installed = [];
  const safe = (fn) => (...a) => { try { fn(...a); } catch { /* a reporter must never crash */ } };
  // Monitor, never handle: the process still behaves exactly as it did before.
  proc.on("uncaughtExceptionMonitor", safe((err, origin) => {
    report("crash", `main: ${err && err.name ? err.name : "Error"}: ${err && err.message ? err.message : err}`,
      { stack: err && err.stack ? String(err.stack) : "", extra: { origin: String(origin || "") } });
  }));
  installed.push("uncaughtExceptionMonitor");
  // Only when nobody else handles them: report, then log like Node's own warning.
  if (proc.listenerCount("unhandledRejection") === 0) {
    proc.on("unhandledRejection", safe((reason) => {
      report("error", `main: unhandled rejection: ${reason && reason.message ? reason.message : reason}`,
        { stack: reason && reason.stack ? String(reason.stack) : "" });
      console.error("[desk] unhandled promise rejection:", reason);
    }));
    installed.push("unhandledRejection");
  }
  if (app && typeof app.on === "function") {
    app.on("render-process-gone", safe((_e, wc, details) => {
      if (!details || details.reason === "clean-exit") return;
      let url = "";
      try { url = String(wc && wc.getURL ? wc.getURL() : "").split(/[?#]/)[0]; } catch { /* destroyed */ }
      report("crash", `renderer gone: ${details.reason}`, { extra: { exit_code: String(details.exitCode), url } });
    }));
    app.on("child-process-gone", safe((_e, details) => {
      if (!details || ["clean-exit", "killed"].includes(details.reason)) return;
      report("crash", `${details.type || "child"} process gone: ${details.reason}`,
        { extra: { exit_code: String(details.exitCode), name: String(details.name || details.serviceName || "") } });
    }));
    app.on("web-contents-created", safe((_e, wc) => {
      let said = false;
      wc.on("unresponsive", safe(() => {
        if (said) return;
        said = true;
        let url = "";
        try { url = String(wc.getURL()).split(/[?#]/)[0]; } catch { /* */ }
        report("error", "window stopped responding", { extra: { url } });
      }));
    }));
    installed.push("render-process-gone", "child-process-gone", "unresponsive");
  }
  if (crashReporter && typeof crashReporter.start === "function") {
    try {
      // Local dumps only: nothing is sent to any crash server. Their metadata is reported
      // on the next start by reportNewDumps().
      crashReporter.start({ uploadToServer: false, submitURL: "", compress: true });
      installed.push("crashReporter");
    } catch { /* already started or unsupported */ }
  }
  void homedir;
  return installed;
}

/** Report each crash dump not seen before (name, size, time only). Returns the count. */
function reportNewDumps({ dumpDir, report, homedir = os.homedir() }) {
  const seenFile = path.join(aitherDir(homedir), "desk-crash-seen.json");
  const seen = new Set((readJson(seenFile) || {}).seen || []);
  const found = [];
  const walk = (dir, depth) => {
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory() && depth < 3) walk(p, depth + 1);
      else if (e.isFile() && e.name.endsWith(".dmp")) found.push(p);
    }
  };
  if (dumpDir) walk(dumpDir, 0);
  let n = 0;
  for (const p of found) {
    const key = path.basename(p);
    if (seen.has(key)) continue;
    seen.add(key);
    let st = null;
    try { st = fs.statSync(p); } catch { continue; }
    report("crash", "Desk crashed (native crash dump)", {
      extra: { dump: key, size: String(st.size), at: st.mtime.toISOString() },
    });
    n += 1;
  }
  try {
    fs.mkdirSync(path.dirname(seenFile), { recursive: true });
    fs.writeFileSync(seenFile, JSON.stringify({ seen: [...seen].slice(-500) }));
  } catch { /* re-reported next time: harmless */ }
  return n;
}

/** The tray row: present only when there is a company app to send to. */
function trayItems(open, { homedir = os.homedir(), readFile } = {}) {
  if (!tenantApi({ homedir, readFile })) return [];
  return [{ label: "Send feedback…", enabled: typeof open === "function", click: () => open && open() }];
}

/** Wire it all for the running app. Returns { report, flushSoon, openFeedback }. */
function startDeskSupport({ app, crashReporter, BrowserWindow, ipcMain, desktopCapturer, log = console.log }) {
  const homedir = os.homedir();
  const appVersion = () => { try { return app.getVersion(); } catch { return ""; } };
  const active = () => Boolean(tenantApi({ homedir }));
  let timer = null;
  const flushSoon = () => {
    if (!active()) return;
    flush({ homedir }).then((r) => { if (r.sent) log(`[desk] support: sent ${r.sent} report(s)`); })
      .catch(() => { /* never throws, but belt and braces */ });
  };
  const report = (kind, title, details = {}) => {
    if (!active()) return null;
    const file = enqueue(buildReport({ kind, title, logs: recentLogLines(60), ...details },
      { appVersion: appVersion() }), { homedir });
    if (file) setTimeout(flushSoon, 2000).unref?.();
    return file;
  };
  installConsoleRing();
  installCrashHooks({ app, crashReporter, report, homedir });
  const feedback = createFeedbackWindow({ BrowserWindow, ipcMain, desktopCapturer, homedir, appVersion,
    flushNow: () => flush({ homedir }) });
  app.whenReady().then(() => {
    try { reportNewDumps({ dumpDir: app.getPath("crashDumps"), report, homedir }); } catch { /* */ }
    flushSoon();
    timer = setInterval(flushSoon, FLUSH_INTERVAL_MS);
    timer.unref?.();
  });
  return { report, flushSoon, openFeedback: () => feedback.open() };
}

// ── The "Send feedback" window ───────────────────────────────────────────────

function createFeedbackWindow({ BrowserWindow, ipcMain, desktopCapturer, homedir = os.homedir(),
  appVersion = () => "", flushNow }) {
  let win = null;
  let shot = null;
  const page = pathToFileURL(path.join(__dirname, "desk-feedback.html")).href;
  // The sender must be THIS window AND still on its own page (webContents identity
  // survives a navigation; the frame URL does not).
  const mine = (event) => Boolean(win && !win.isDestroyed() && event.sender === win.webContents
    && event.senderFrame && event.senderFrame.url === page);

  ipcMain.handle("desk-feedback:state", (event) => {
    if (!mine(event)) return null;
    return { hasShot: Boolean(shot), shotPreview: shot, logs: recentLogLines(100, { homedir }).length,
      autoReports: enabled({ homedir }) };
  });
  ipcMain.handle("desk-feedback:send", async (event, payload) => {
    if (!mine(event)) return { ok: false };
    const message = String((payload && payload.message) || "").trim().slice(0, MAX_MESSAGE);
    if (!message) return { ok: false, error: "Write a few words first." };
    const report = buildReport({
      kind: "feedback",
      title: message.split(/\r?\n/)[0].slice(0, 120),
      message,
      logs: payload && payload.includeLogs ? recentLogLines(100, { homedir }) : [],
      screenshot: payload && payload.includeShot ? shot : null,
    }, { appVersion: appVersion() });
    enqueue(report, { homedir, force: true });
    const res = await flushNow();
    return { ok: true, sent: res.sent > 0, detail: res.sent > 0 ? "" : (res.stopped || "queued") };
  });

  async function captureScreen() {
    if (!desktopCapturer) return null;
    try {
      const sources = await desktopCapturer.getSources({ types: ["screen"], thumbnailSize: { width: 1280, height: 800 } });
      const img = sources && sources[0] && sources[0].thumbnail;
      if (!img || img.isEmpty()) return null;
      let data = `data:image/png;base64,${img.toPNG().toString("base64")}`;
      if (data.length > MAX_SCREENSHOT_CHARS) data = `data:image/jpeg;base64,${img.toJPEG(70).toString("base64")}`;
      return data.length <= MAX_SCREENSHOT_CHARS ? data : null;
    } catch {
      return null;
    }
  }

  async function open() {
    if (win && !win.isDestroyed()) { win.show(); win.focus(); return win; }
    shot = await captureScreen(); // before the form appears, so it shows the problem
    win = new BrowserWindow({
      width: 560, height: 560, resizable: false, title: "Send feedback", autoHideMenuBar: true,
      webPreferences: { preload: path.join(__dirname, "desk-feedback-preload.cjs"),
        contextIsolation: true, sandbox: true, nodeIntegration: false },
    });
    win.on("closed", () => { win = null; shot = null; });
    win.webContents.on("will-navigate", (e) => e.preventDefault());
    win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    win.loadFile(path.join(__dirname, "desk-feedback.html"));
    return win;
  }

  return { open };
}

module.exports = {
  enabled, tenantApi, deviceRecord, scrubText, scrubReport, buildReport, enqueue, flush,
  installConsoleRing, recentLogLines, installCrashHooks, reportNewDumps, trayItems,
  startDeskSupport, createFeedbackWindow, outboxDir,
};
