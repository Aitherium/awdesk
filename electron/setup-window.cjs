"use strict";

/**
 * setup-window.cjs — the "Set up Aither" window (Start menu, tray, jump list, `--setup`).
 *
 * All logic lives in setup-wizard.cjs (tested without Electron); this file only wires
 * a sandboxed window to it. The renderer sees six verbs (setup-preload.cjs) and gets
 * back NON-secret summaries: tokens stay in this process, and the password the person
 * types crosses IPC once, is hashed inside awnix and is dropped here.
 */

const fs = require("node:fs");
const path = require("node:path");
const { execFile } = require("node:child_process");
const { BrowserWindow, ipcMain, shell } = require("electron");
const { resolveFleetDistro } = require("./fleet-distro.cjs");
const { WslRunner, LocalRunner, spawnRun, fallbackCycle } = require("./awnix-provision.cjs");
const { SetupWizard, maintenanceLock } = require("./setup-wizard.cjs");

const REPO_TOOLS = process.env.AITHER_REPO_TOOLS || "C:\\AitherOS-Fresh\\AitherOS\\dev\\tools";
const FLEET_HOST_SCRIPT = process.env.AWDESK_FLEET_HOST_SCRIPT || path.join(REPO_TOOLS, "fleet_host.py");
const AW_OPS_SCRIPT = path.join(REPO_TOOLS, "aw_ops.py");
const PYTHON = process.env.AWDESK_PYTHON || (process.platform === "win32" ? "python" : "python3");
const IDLE_POLL_MS = 60_000;
const IDLE_MAX_MS = 2 * 3600 * 1000;

let win = null;
let wizard = null;
let ipcWired = false;
let deps = {};

function send(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

function execFileP(file, args, opts = {}) {
  return new Promise((resolve) => {
    execFile(file, args, { windowsHide: true, timeout: opts.timeoutMs || 120_000, maxBuffer: 8 << 20 },
      (err, stdout, stderr) => resolve({ code: err ? (typeof err.code === "number" ? err.code : 1) : 0,
        stdout: String(stdout || ""), stderr: String(stderr || "") }));
  });
}

/** The engine this desk can push into an image that lacks a new-enough aither-setup. */
function engineSource() {
  const candidates = [
    process.resourcesPath && path.join(process.resourcesPath, "aither-setup"),
    path.join(__dirname, "..", "..", "standalone", "bootc"),
  ].filter(Boolean);
  for (const dir of candidates) {
    const script = path.join(dir, "aither-setup.py");
    const catalogue = path.join(dir, "aither-setup.json");
    if (fs.existsSync(script) && fs.existsSync(catalogue)) {
      return { script: fs.readFileSync(script, "utf8"), catalogue: fs.readFileSync(catalogue, "utf8") };
    }
  }
  return null;
}

/** Maintenance lock + (on the owner's machine) an aw_ops claim other sessions read. */
function setupLock() {
  const m = maintenanceLock();
  let claimId = "";
  return {
    async acquire() {
      if (!(await m.acquire())) return false;
      if (fs.existsSync(AW_OPS_SCRIPT)) {
        const r = await execFileP(PYTHON, [AW_OPS_SCRIPT, "claim", "awnix-setup", "--ttl", "60", "--pid", String(process.pid)]);
        claimId = (r.stdout.match(/\b([0-9a-f]{6,})\b/) || [])[1] || "";
      }
      return true;
    },
    async release() {
      await m.release();
      if (claimId) await execFileP(PYTHON, [AW_OPS_SCRIPT, "release", claimId]);
      claimId = "";
    },
  };
}

/** The safe restart: fleet_host.py cycle when this machine has it, else fallbackCycle (same order). */
function makeCycle(runner) {
  return async (mode = "idle") => {
    if (runner.kind !== "wsl") return { ok: true, note: "nothing to restart on this platform" };
    if (fs.existsSync(FLEET_HOST_SCRIPT)) {
      const started = Date.now();
      for (;;) {
        const r = await execFileP(PYTHON, [FLEET_HOST_SCRIPT, "cycle", "--execute", "--json"], { timeoutMs: 1_800_000 });
        let res;
        try { res = JSON.parse(r.stdout); } catch { res = null; }
        if (res && res.refused && mode === "idle" && Date.now() - started < IDLE_MAX_MS) {
          send("desk:setup-progress", { event: "phase", phase: "waiting", note: `waiting for a safe moment: ${res.error}` });
          await new Promise((ok) => setTimeout(ok, IDLE_POLL_MS));
          continue;
        }
        if (!res) return { ok: false, error: (r.stderr || r.stdout).trim().slice(-300) || `exit ${r.code}` };
        return { ok: Boolean(res.ok), refused: Boolean(res.refused), error: res.error || "", fallback: res.fallback || "" };
      }
    }
    // No fleet_host.py here: the same ordering (attach task -> assert data mounts).
    return fallbackCycle({ runner, execFile: execFileP });
  };
}

function makeRunner() {
  if (process.platform === "win32") return new WslRunner({ distro: resolveFleetDistro().name });
  if (process.platform === "linux") return new LocalRunner();
  return null;
}

function getWizard() {
  if (wizard) return wizard;
  const runner = makeRunner();
  if (!runner) return null;
  wizard = new SetupWizard({
    runner, openExternal: (url) => shell.openExternal(url), execFile: execFileP,
    cycle: makeCycle(runner), lock: setupLock(), engineSource,
    setDefaultUidFallback: deps.setDefaultUidFallback,
  });
  wizard.on("log", (m) => console.log("[setup]", m));
  wizard.on("signin-fallback", (e) => send("desk:setup-progress", { event: "signin-fallback", reason: e.reason }));
  return wizard;
}

/** Wrap a verb so the renderer gets {ok, value} or {ok:false, error} -- never a stack. */
function verb(fn) {
  return async (_event, ...args) => {
    try {
      return { ok: true, value: await fn(...args) };
    } catch (e) {
      return { ok: false, error: String(e?.message || e), code: e?.code || "" };
    }
  };
}

function wireIpc() {
  if (ipcWired) return;
  ipcWired = true;
  const need = () => {
    const w = getWizard();
    if (!w) throw new Error("this platform has no Linux side to set up; sign in from the desk instead");
    return w;
  };
  ipcMain.handle("desk:setup-preflight", verb(() => need().preflight()));
  ipcMain.handle("desk:setup-install-engine", verb(() => need().installEngine()));
  ipcMain.handle("desk:setup-signin", verb(() => need().signIn()));
  ipcMain.handle("desk:setup-apply", verb(async (answers) => {
    const a = answers && typeof answers === "object" ? { ...answers } : {};
    try {
      return await need().apply(a, (ev) => send("desk:setup-progress", ev));
    } finally {
      a.password = "";
    }
  }));
  ipcMain.handle("desk:setup-restart", verb((mode) => need().restart(mode === "now" ? "now" : "idle")));
  ipcMain.handle("desk:setup-verify", verb(() => need().verify()));
  ipcMain.on("desk:setup-done", () => {
    if (deps.openAwsh) deps.openAwsh();
    if (win && !win.isDestroyed()) win.close();
  });
  ipcMain.on("desk:setup-close", () => {
    if (win && !win.isDestroyed()) win.close();
  });
}

function createSetupWindow(options = {}) {
  deps = { ...deps, ...options };
  wireIpc();
  if (win && !win.isDestroyed()) {
    win.show();
    win.focus();
    return win;
  }
  win = new BrowserWindow({
    width: 760, height: 720, minWidth: 560, minHeight: 560, show: false,
    title: "Set up Aither", backgroundColor: "#0f1218", autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, "setup-preload.cjs"),
      contextIsolation: true, nodeIntegration: false, sandbox: true,
    },
  });
  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  win.webContents.on("will-navigate", (event) => event.preventDefault());
  win.once("ready-to-show", () => {
    win.show();
    win.focus();
  });
  win.on("closed", () => {
    win = null;
    // Never leave the WSL [oobe] terminal waiting on a desk that went away.
    if (wizard) void wizard.prov.markDeskPresent(false).catch(() => {});
  });
  void win.loadFile(path.join(__dirname, "setup-window.html"));
  return win;
}

/**
 * Startup hook: open the wizard by itself when awnix is registered, RUNNING (a status
 * read must never boot a stopped distro), has a new-enough engine and reports not set up.
 * AITHER_SETUP_AUTO=0 turns it off.
 */
/** Where "the setup already offered itself here" is remembered. Owner, 2026-10-03:
 *  "it is now having me set up aitheros all over again??" -- on a machine whose
 *  fleet was already serving, awnix still reports configured:false, so every desk
 *  start (and every restart) popped the wizard again. It offers itself ONCE; after
 *  that it is a palette / jump-list command the owner opens on purpose. */
function autoOfferMarker() {
  try {
    return path.join(require("electron").app.getPath("userData"), "setup-auto-offered.json");
  } catch {
    return null;
  }
}

function alreadyOffered() {
  const marker = autoOfferMarker();
  return Boolean(marker && require("node:fs").existsSync(marker));
}

function rememberOffered() {
  const marker = autoOfferMarker();
  if (!marker) return;
  try {
    require("node:fs").writeFileSync(marker, JSON.stringify({ offeredAt: new Date().toISOString() }));
  } catch (error) {
    console.warn("[desk] could not remember the setup offer:", error?.message || error);
  }
}

async function maybeAutoOpen(options = {}) {
  if (process.env.AITHER_SETUP_AUTO === "0" || process.platform !== "win32") return false;
  if (alreadyOffered()) return false;
  const distro = resolveFleetDistro().name;
  const l = await spawnRun("wsl.exe", ["-l", "--running", "--quiet"], { timeoutMs: 20_000 });
  const running = Buffer.from(l.stdout, "utf8").toString().replace(/\0/g, "").split(/\r?\n/).map((s) => s.trim());
  if (!running.includes(distro)) return false;
  const w = getWizard();
  if (!w) return false;
  await w.prov.resolveEngine();
  const st = await w.prov.status();
  if (!st.ok || st.missingCaps.length || st.configured) return false;
  rememberOffered();
  createSetupWindow(options);
  return true;
}

function isSetupWindowOpen() {
  return Boolean(win && !win.isDestroyed());
}

module.exports = { createSetupWindow, maybeAutoOpen, isSetupWindowOpen, engineSource };
