"use strict";

/**
 * darkmatter-link-window.cjs -- the "Darkmatter Link" window and the owner of its IPC.
 *
 * Same shape as disk-explorer-window.cjs: a pure handler table over injected effects
 * (run a command, spawn the supervisor, the gateway tool call, safeStorage), so the
 * IPC contract is testable without Electron. The policy lives in darkmatter-link.cjs.
 *
 * The renderer never sees the gateway key: it can set or clear it and learns only
 * `hasKey`. The supervisor is a child of the desk; quitting the desk stops it.
 */

const path = require("node:path");
const dml = require("./darkmatter-link.cjs");

function electron() {
  return require("electron");
}

let linkWindow = null;
let wired = false;
let supervisor = null; // { child, pid, startedAt, mode }
let lastExit = null;   // { code, at }

function obj(v) {
  return v && typeof v === "object" && !Array.isArray(v) ? v : {};
}

/** Run a short command; resolves { ok, code, stdout, stderr }. Never rejects. */
function runCommand(cmd, { timeoutMs = 60_000 } = {}) {
  const { execFile } = require("node:child_process");
  return new Promise((resolve) => {
    execFile(cmd.file, cmd.args, { cwd: cmd.cwd, timeout: timeoutMs, windowsHide: true, maxBuffer: 8 * 1024 * 1024 },
      (error, stdout, stderr) => {
        const code = error ? (typeof error.code === "number" ? error.code : -1) : 0;
        resolve({ ok: !error, code, stdout: String(stdout || ""), stderr: String(stderr || ""), error: error ? String(error.message || error) : null });
      });
  });
}

function defaultSpawn(cmd) {
  const { spawn } = require("node:child_process");
  return spawn(cmd.file, cmd.args, {
    cwd: cmd.cwd,
    env: { ...process.env, ...cmd.extraEnv },
    windowsHide: true,
    detached: process.platform !== "win32", // own process group, so stop can kill the tree
    stdio: "ignore",
  });
}

function safeStorageCodec() {
  try {
    const { safeStorage } = electron();
    if (!safeStorage.isEncryptionAvailable()) return {};
    return {
      encrypt: (s) => safeStorage.encryptString(s),
      decrypt: (buf) => safeStorage.decryptString(buf),
    };
  } catch {
    return {};
  }
}

function defaultCallTool(name, args) {
  return require("./gateway-mcp.cjs").callTool(name, args);
}

function supervisorState() {
  return {
    running: Boolean(supervisor),
    pid: supervisor ? supervisor.pid : null,
    startedAt: supervisor ? supervisor.startedAt : null,
    mode: supervisor ? supervisor.mode : null,
    lastExit,
  };
}

/**
 * The handler table. Every handler resolves {ok, ...}; none throws across the bridge.
 */
function darkmatterLinkHandlers({
  run = runCommand,
  spawnImpl = defaultSpawn,
  callTool = defaultCallTool,
  codec = null,
  fsImpl = require("node:fs"),
  home,
  log = (line) => console.log(`[darkmatter-link] ${line}`),
} = {}) {
  const keyCodec = () => codec || safeStorageCodec();
  const python = async (verb) => {
    const res = await run(dml.buildCommand(verb));
    const data = dml.parseJsonOutput(res.stdout);
    if (data === null) {
      return { ok: false, code: res.code, error: (res.stderr || res.error || "no output -- is the "
        + "Darkmatter Link pack installed? adk pack install darkmatter-link-<version>.tar.gz").slice(-600) };
    }
    return { ok: true, code: res.code, data: dml.unwrapTool(data) };
  };
  return {
    "desk:dml-state": () => ({
      ok: true,
      settings: dml.loadSettings({ fsImpl, home }),
      hasKey: dml.hasGatewayKey({ fsImpl, home }),
      supervisor: supervisorState(),
      shopUrl: dml.SHOP_URL,
    }),
    "desk:dml-status": () => python("status"),
    "desk:dml-games": () => python("games"),
    "desk:dml-personas": () => ({ ok: true, data: dml.loadPersonas({ fsImpl, home }) }),
    "desk:dml-settings": (_e, patch) => {
      const p = obj(patch);
      // Consent is NOT a plain setting: it moves only through desk:dml-consent.
      const allowed = {};
      if (typeof p.model_mode === "string") allowed.model_mode = p.model_mode;
      if (typeof p.voices === "boolean") allowed.voices = p.voices;
      return { ok: true, settings: dml.saveSettings(allowed, { fsImpl, home }) };
    },
    "desk:dml-consent": (_e, wanted) => dml.setHarvestConsent(wanted === true, { callTool, fsImpl, home }),
    "desk:dml-key-set": (_e, key) => dml.saveGatewayKey(key, { encrypt: keyCodec().encrypt, fsImpl, home }),
    "desk:dml-key-clear": () => dml.clearGatewayKey({ fsImpl, home }),
    "desk:dml-start": () => {
      if (supervisor) return { ok: true, supervisor: supervisorState(), note: "already running" };
      const settings = dml.loadSettings({ fsImpl, home });
      let cmd;
      try {
        const key = settings.model_mode === "cloud" ? dml.loadGatewayKey({ decrypt: keyCodec().decrypt, fsImpl, home }) : "";
        cmd = dml.supervisorCommand(settings, { key });
      } catch (err) {
        return { ok: false, error: String(err.message || err) };
      }
      log(`start ${dml.describeLaunch(cmd)}`);
      let child;
      try {
        child = spawnImpl(cmd);
      } catch (err) {
        return { ok: false, error: String(err.message || err) };
      }
      supervisor = { child, pid: child.pid, startedAt: new Date().toISOString(), mode: settings.model_mode };
      lastExit = null;
      if (child && typeof child.on === "function") {
        child.on("exit", (code) => {
          if (supervisor && supervisor.child === child) supervisor = null;
          lastExit = { code, at: new Date().toISOString() };
        });
        child.on("error", (err) => {
          if (supervisor && supervisor.child === child) supervisor = null;
          lastExit = { code: -1, error: String(err.message || err), at: new Date().toISOString() };
        });
      }
      return { ok: true, supervisor: supervisorState() };
    },
    "desk:dml-stop": async () => {
      if (!supervisor) return { ok: true, supervisor: supervisorState(), note: "not running" };
      const res = await run(dml.stopCommand(supervisor.pid), { timeoutMs: 15_000 });
      if (res.ok) supervisor = null;
      return { ok: res.ok, error: res.ok ? null : (res.stderr || res.error), supervisor: supervisorState() };
    },
  };
}

function ensureDarkmatterLinkIpc() {
  if (wired) return;
  wired = true;
  const { ipcMain, shell } = electron();
  for (const [channel, handler] of Object.entries(darkmatterLinkHandlers())) ipcMain.handle(channel, handler);
  ipcMain.on("desk:dml-open-shop", () => {
    void shell.openExternal(dml.SHOP_URL);
  });
}

function createDarkmatterLinkWindow() {
  ensureDarkmatterLinkIpc();
  const { BrowserWindow } = electron();
  if (linkWindow && !linkWindow.isDestroyed()) {
    linkWindow.show();
    linkWindow.focus();
    return linkWindow;
  }
  linkWindow = new BrowserWindow({
    width: 980,
    height: 760,
    minWidth: 640,
    minHeight: 480,
    show: false,
    title: "Darkmatter Link",
    backgroundColor: "#0f1218",
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, "darkmatter-link-preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  linkWindow.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  linkWindow.webContents.on("will-navigate", (event) => event.preventDefault());
  linkWindow.once("ready-to-show", () => {
    linkWindow.show();
    linkWindow.focus();
  });
  linkWindow.on("closed", () => {
    linkWindow = null;
  });
  void linkWindow.loadFile(path.join(__dirname, "darkmatter-link.html"));
  return linkWindow;
}

/** Desk quit: the supervisor is the desk's child and leaves with it. */
function stopDarkmatterSupervisor() {
  if (!supervisor) return;
  try {
    const cmd = dml.stopCommand(supervisor.pid);
    require("node:child_process").execFileSync(cmd.file, cmd.args, { windowsHide: true, stdio: "ignore", timeout: 10_000 });
  } catch {
    /* already gone */
  }
  supervisor = null;
}

function isDarkmatterLinkWindowOpen() {
  return Boolean(linkWindow && !linkWindow.isDestroyed());
}

function closeDarkmatterLinkWindow() {
  if (linkWindow && !linkWindow.isDestroyed()) linkWindow.close();
}

module.exports = {
  darkmatterLinkHandlers,
  ensureDarkmatterLinkIpc,
  createDarkmatterLinkWindow,
  closeDarkmatterLinkWindow,
  isDarkmatterLinkWindowOpen,
  stopDarkmatterSupervisor,
  _resetForTest: () => { supervisor = null; lastExit = null; },
};
