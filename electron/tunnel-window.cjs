"use strict";

/**
 * tunnel-window.cjs — the "Public URL" panel (tunnel.html) and the owner of its
 * IPC: give a local port a public URL in one click, list what is public, stop it.
 *
 * Same shape as disk-explorer-window.cjs (ensure<X>Ipc / create / close / isOpen,
 * with a pure handler table so the IPC contract is testable without Electron).
 * The transport is tunnel-client.cjs -> the `awtunnel` CLI; the window holds no
 * credential (a quick tunnel needs none).
 *
 * The channels are exported (TUNNEL_CHANNELS) so another window — the System
 * window's port rows — can call the SAME handlers through its own preload
 * instead of growing a second tunnel path. registerTunnelIpc() is idempotent.
 *
 * The fleet-internal override is forwarded ONLY as a literal `allowInternal ===
 * true` from the renderer payload; nothing else in the payload reaches awtunnel.
 */

const path = require("node:path");

const TUNNEL_CHANNELS = Object.freeze({
  list: "desk:tunnel-list",
  check: "desk:tunnel-check",
  start: "desk:tunnel-start",
  stop: "desk:tunnel-stop",
  copy: "desk:tunnel-copy",
  open: "desk:tunnel-open",
});

function electron() {
  return require("electron");
}

let tunnelWindow = null;
let wired = false;
let clientImpl = null;

function client() {
  if (!clientImpl) {
    const { TunnelClient } = require("./tunnel-client.cjs");
    clientImpl = new TunnelClient();
  }
  return clientImpl;
}

function obj(v) {
  return v && typeof v === "object" && !Array.isArray(v) ? v : {};
}

/** Only a public tunnel URL may be copied or opened (never a file:, never javascript:). */
function safeUrl(url) {
  const text = String(url || "").trim();
  return /^https:\/\/[A-Za-z0-9.-]+(?::\d+)?(\/[^\s]*)?$/.test(text) ? text : null;
}

/**
 * The handler table, pure over an injected client + clipboard/shell. Every
 * handler resolves {ok, data} | {ok:false, reason}; none throws across the bridge.
 */
function tunnelHandlers(tunnels = client(), { clipboard = null, shell = null } = {}) {
  const { checkPort } = require("./tunnel-client.cjs");
  const clip = () => clipboard || electron().clipboard;
  const sh = () => shell || electron().shell;
  const guard = (fn) => async (...args) => {
    try {
      return await fn(...args);
    } catch (error) {
      return { ok: false, reason: `1 tunnel action failed: ${String(error?.message || error).slice(0, 200)} — Refresh and retry` };
    }
  };
  return {
    [TUNNEL_CHANNELS.list]: guard(() => tunnels.list()),
    // A dry run for a port row: "would this be refused, and why" without spawning.
    [TUNNEL_CHANNELS.check]: guard((_e, opts) => {
      const o = obj(opts);
      return checkPort(o.port, { allowInternal: o.allowInternal === true });
    }),
    [TUNNEL_CHANNELS.start]: guard((_e, opts) => {
      const o = obj(opts);
      return tunnels.start({
        port: o.port,
        host: typeof o.host === "string" ? o.host : undefined,
        protocol: typeof o.protocol === "string" ? o.protocol : undefined,
        allowInternal: o.allowInternal === true,
      });
    }),
    [TUNNEL_CHANNELS.stop]: guard((_e, opts) => tunnels.stop(obj(opts).port)),
    [TUNNEL_CHANNELS.copy]: guard((_e, url) => {
      const u = safeUrl(url);
      if (!u) return { ok: false, reason: "1 URL refused: only an https tunnel URL can be copied — Refresh the list" };
      clip().writeText(u);
      return { ok: true, data: { copied: u } };
    }),
    [TUNNEL_CHANNELS.open]: guard(async (_e, url) => {
      const u = safeUrl(url);
      if (!u) return { ok: false, reason: "1 URL refused: only an https tunnel URL can be opened — Refresh the list" };
      await sh().openExternal(u);
      return { ok: true, data: { opened: u } };
    }),
  };
}

/**
 * Register every tunnel channel on ipcMain, once. Any window whose preload
 * invokes TUNNEL_CHANNELS reaches these handlers (the System window included).
 */
function registerTunnelIpc(ipcMain = null, handlers = null) {
  if (wired) return false;
  wired = true;
  const ipc = ipcMain || electron().ipcMain;
  for (const [channel, handler] of Object.entries(handlers || tunnelHandlers())) ipc.handle(channel, handler);
  return true;
}

/** Open (or focus) the panel; `port` pre-fills the port box (a System-window row). */
function createTunnelWindow({ port = null } = {}) {
  registerTunnelIpc();
  const { BrowserWindow } = electron();
  const query = port ? { port: String(port) } : undefined;
  if (tunnelWindow && !tunnelWindow.isDestroyed()) {
    if (query) void tunnelWindow.loadFile(path.join(__dirname, "tunnel.html"), { query });
    tunnelWindow.show();
    tunnelWindow.focus();
    return tunnelWindow;
  }
  tunnelWindow = new BrowserWindow({
    width: 620,
    height: 520,
    minWidth: 460,
    minHeight: 360,
    show: false,
    title: "Public URL",
    backgroundColor: "#0f1218",
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, "tunnel-preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  tunnelWindow.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  tunnelWindow.webContents.on("will-navigate", (event) => event.preventDefault());
  tunnelWindow.once("ready-to-show", () => {
    tunnelWindow.show();
    tunnelWindow.focus();
  });
  tunnelWindow.on("closed", () => {
    tunnelWindow = null;
  });
  void tunnelWindow.loadFile(path.join(__dirname, "tunnel.html"), query ? { query } : undefined);
  return tunnelWindow;
}

function closeTunnelWindow() {
  if (tunnelWindow && !tunnelWindow.isDestroyed()) tunnelWindow.close();
}

function isTunnelWindowOpen() {
  return Boolean(tunnelWindow && !tunnelWindow.isDestroyed());
}

/** The shared client (an MCP tool or the System window may reuse it). */
function getTunnelClient() {
  return client();
}

module.exports = {
  TUNNEL_CHANNELS,
  tunnelHandlers,
  registerTunnelIpc,
  createTunnelWindow,
  closeTunnelWindow,
  isTunnelWindowOpen,
  getTunnelClient,
  safeUrl,
};
