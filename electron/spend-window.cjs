"use strict";

/**
 * spend-window.cjs — the Spend pane's standalone twin, and the owner of its IPC.
 *
 * Same shape as ops-window.cjs: the handlers live HERE so a detached Spend window
 * (and the Pulse page's spend card, which asks through the plane bridge) works
 * even if the console never opened this session. Transport: spend-client.cjs ->
 * gateway-mcp.cjs, nothing else. Read-only by construction.
 *
 * ONE client per process, so the tray line, this pane and the Pulse card share
 * the client's 60 s cache instead of each calling the gateway.
 */

const path = require("node:path");

function electron() {
  return require("electron");
}

let spendWindow = null;
let wired = false;
let clientImpl = null;
let openerImpl = null;

/** The shared client (tray + pane + Pulse card). */
function spendClient() {
  if (!clientImpl) clientImpl = require("./spend-client.cjs").createSpendClient();
  return clientImpl;
}

/** main.cjs says how "open the spend page" is done (aither://spend in the browser). */
function setSpendOpener(fn) {
  openerImpl = typeof fn === "function" ? fn : null;
}

/** The handler table, pure over an injected client so it is testable without Electron. */
function spendHandlers(client = spendClient(), opener = () => openerImpl) {
  return {
    // Never throws across the bridge: the client already answers {ok, ...}.
    "desk:spend-report": async (_e, hours, opts) => {
      try {
        return await client.report(hours, { fresh: Boolean(opts && opts.fresh) });
      } catch (error) {
        return { ok: false, notDeployed: false, reason: String((error && error.message) || error) };
      }
    },
    "desk:spend-open": () => {
      const open = opener();
      if (!open) return { ok: false, error: "no spend page opener wired" };
      try {
        open();
        return { ok: true };
      } catch (error) {
        return { ok: false, error: String((error && error.message) || error) };
      }
    },
  };
}

function ensureSpendIpc() {
  if (wired) return;
  wired = true;
  const { ipcMain } = electron();
  for (const [channel, handler] of Object.entries(spendHandlers())) ipcMain.handle(channel, handler);
}

function createSpendWindow() {
  ensureSpendIpc();
  const { BrowserWindow } = electron();
  if (spendWindow && !spendWindow.isDestroyed()) {
    spendWindow.show();
    spendWindow.focus();
    return spendWindow;
  }
  spendWindow = new BrowserWindow({
    width: 980,
    height: 720,
    minWidth: 600,
    minHeight: 440,
    show: false,
    title: "Aither Spend",
    backgroundColor: "#0f1218",
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, "spend-preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  spendWindow.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  spendWindow.webContents.on("will-navigate", (event) => event.preventDefault());
  spendWindow.once("ready-to-show", () => {
    spendWindow.show();
    spendWindow.focus();
  });
  spendWindow.on("closed", () => {
    spendWindow = null;
  });
  void spendWindow.loadFile(path.join(__dirname, "spend.html"));
  return spendWindow;
}

function closeSpendWindow() {
  if (spendWindow && !spendWindow.isDestroyed()) spendWindow.close();
}

function isSpendWindowOpen() {
  return Boolean(spendWindow && !spendWindow.isDestroyed());
}

module.exports = {
  ensureSpendIpc, createSpendWindow, closeSpendWindow, isSpendWindowOpen, spendHandlers,
  spendClient, setSpendOpener,
};
