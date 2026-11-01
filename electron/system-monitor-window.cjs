"use strict";

/**
 * system-monitor-window.cjs — the "System" window (task manager + networking)
 * and the owner of its IPC.
 *
 * Same shape as disk-explorer-window.cjs (ensure<X>Ipc / create / close /
 * isOpen, with a pure handler table so the IPC contract is testable without
 * Electron). The backend is system-monitor.cjs; the desk MCP server reads the
 * SAME monitor through its read-only `agent` half (sharedSystemMonitor()).
 *
 * The OWNER's verbs live only here: End process / End tree (the renderer asks
 * first and sends confirm:true), Set priority, Open file location, and "Ask
 * Aither", which posts one redacted line into the chat the way the Files
 * page's hand-off does (main injects the poster with setSystemHandOff). A
 * renderer sends a pid and the name it saw; the monitor re-reads the process
 * before acting, so a reused pid is refused, not ended.
 */

const path = require("node:path");

function electron() {
  return require("electron");
}

let systemWindow = null;
let wired = false;
let monitorImpl = null;
let handOffImpl = null;

/** The desk's own pids (main + GPU + renderers), so End never targets the desk. */
function deskPids() {
  try {
    return electron().app.getAppMetrics().map((m) => m.pid).concat(process.pid);
  } catch {
    return [process.pid];
  }
}

/** One monitor per desk process: the window and the MCP tools share samples. */
function sharedSystemMonitor() {
  if (!monitorImpl) monitorImpl = require("./system-monitor.cjs").createSystemMonitor({ selfPids: deskPids });
  return monitorImpl;
}

/** main.cjs: (text, {pid, name}) => {ok} | Promise. */
function setSystemHandOff(fn) {
  handOffImpl = typeof fn === "function" ? fn : null;
}

function obj(v) {
  return v && typeof v === "object" && !Array.isArray(v) ? v : {};
}

/**
 * The handler table, pure over injected dependencies.
 * @param {object} [deps]
 * @param {object}   [deps.monitor]  system-monitor createSystemMonitor()
 * @param {object}   [deps.shell]    {showItemInFolder(p)}
 * @param {Function} [deps.handOff]  (text, meta) -> {ok}; default: what main injected
 */
function systemHandlers({ monitor = sharedSystemMonitor(), shell = null, handOff = null } = {}) {
  const sh = () => shell || electron().shell;
  return {
    "desk:sys-snapshot": () => monitor.snapshot(),
    "desk:sys-network": () => monitor.network(),
    "desk:sys-probes": () => monitor.probes(),
    "desk:sys-startup": () => monitor.startup(),
    "desk:sys-end": (_e, opts) => {
      const o = obj(opts);
      return monitor.endProcess({ pid: Number(o.pid), name: String(o.name || ""), tree: o.tree === true, confirm: o.confirm === true });
    },
    "desk:sys-priority": (_e, opts) => {
      const o = obj(opts);
      return monitor.setPriority({ pid: Number(o.pid), name: String(o.name || ""), level: String(o.level || "") });
    },
    "desk:sys-reveal": (_e, pid) => {
      const p = monitor.lookup(Number(pid));
      if (!p) return { ok: false, reason: `pid ${pid} is not in the last sample -- refresh` };
      if (!p.exe) return { ok: false, reason: `${p.name} has no file path Windows will show (protected or a system process)` };
      sh().showItemInFolder(p.exe);
      return { ok: true, revealed: p.exe };
    },
    "desk:sys-ask": async (_e, pid) => {
      const post = handOff || handOffImpl;
      if (!post) return { ok: false, reason: "the chat is not wired in this build -- nothing was posted" };
      const line = monitor.askLine(Number(pid));
      if (!line) return { ok: false, reason: `pid ${pid} is not in the last sample -- refresh` };
      try {
        const verdict = await post(line, { pid: Number(pid) });
        if (verdict && verdict.ok === false) return { ok: false, reason: verdict.error || verdict.detail || verdict.reason || "chat refused the post" };
        return { ok: true, posted: line };
      } catch (error) {
        return { ok: false, reason: String((error && error.message) || error) };
      }
    },
  };
}

function ensureSystemIpc() {
  if (wired) return;
  wired = true;
  const { ipcMain } = electron();
  for (const [channel, handler] of Object.entries(systemHandlers())) ipcMain.handle(channel, handler);
}

function createSystemWindow() {
  ensureSystemIpc();
  const { BrowserWindow } = electron();
  if (systemWindow && !systemWindow.isDestroyed()) {
    systemWindow.show();
    systemWindow.focus();
    return systemWindow;
  }
  systemWindow = new BrowserWindow({
    width: 1100,
    height: 780,
    minWidth: 700,
    minHeight: 480,
    show: false,
    title: "System",
    backgroundColor: "#0f1218",
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, "system-monitor-preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  systemWindow.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  systemWindow.webContents.on("will-navigate", (event) => event.preventDefault());
  systemWindow.once("ready-to-show", () => {
    systemWindow.show();
    systemWindow.focus();
  });
  systemWindow.on("closed", () => {
    systemWindow = null;
  });
  void systemWindow.loadFile(path.join(__dirname, "system-monitor.html"));
  return systemWindow;
}

function closeSystemWindow() {
  if (systemWindow && !systemWindow.isDestroyed()) systemWindow.close();
}

function isSystemWindowOpen() {
  return Boolean(systemWindow && !systemWindow.isDestroyed());
}

module.exports = {
  ensureSystemIpc, createSystemWindow, closeSystemWindow, isSystemWindowOpen,
  systemHandlers, setSystemHandOff, sharedSystemMonitor,
};
