"use strict";

/**
 * plane-window.cjs — the plane pages' (Strata, Pulse, Watch, Flux, Nexus)
 * standalone twins, and the owner of their IPC.
 *
 * Same shape as ops-window.cjs: the handlers live HERE so a detached plane
 * window works even if the console never opened, every handler answers
 * {ok:true, data} or {ok:false, error} and never throws across the bridge.
 * One window per plane (a Map), one page per plane (plane-<id>.html, all
 * rendered by plane-page.js), one IPC verb for all of them.
 *
 * Read-only by construction: the only verb is a snapshot, and the snapshot can
 * only run the reads plane-client.cjs lists for that plane.
 */

const path = require("node:path");
const { PLANES, PLANE_IDS } = require("./plane-client.cjs");

function electron() {
  return require("electron");
}

const windows = new Map();
let wired = false;
let clientImpl = null;

function client() {
  if (!clientImpl) {
    clientImpl = require("./plane-client.cjs").createPlaneClient({ store: require("./last-good-cache.cjs").deskCache() });
  }
  return clientImpl;
}

async function answer(fn) {
  try {
    return { ok: true, data: await fn() };
  } catch (error) {
    return { ok: false, error: String((error && error.message) || error) };
  }
}

function checkPlane(planeId) {
  const id = String(planeId || "");
  if (!PLANE_IDS.includes(id)) throw new Error(`unknown plane ${id || "(none)"}`);
  return id;
}

/** The page file for one plane. Exported so the console's pane table and this
 *  module cannot disagree about where a plane lives. */
function planeFile(planeId) {
  return `plane-${checkPlane(planeId)}.html`;
}

/** The handler table, pure over an injected client so it is testable without Electron. */
function planeHandlers(planes = client()) {
  return {
    "desk:plane-list": () => answer(() => planes.planes()),
    "desk:plane-snapshot": (_e, planeId) => answer(() => planes.snapshot(checkPlane(planeId))),
  };
}

function ensurePlaneIpc() {
  if (wired) return;
  wired = true;
  const { ipcMain } = electron();
  for (const [channel, handler] of Object.entries(planeHandlers())) ipcMain.handle(channel, handler);
  // The Pulse page's spend card asks through the plane bridge; its channels are
  // spend-window.cjs's, wired here too so a DETACHED Pulse window has them.
  require("./spend-window.cjs").ensureSpendIpc();
}

function createPlaneWindow(planeId) {
  const id = checkPlane(planeId);
  ensurePlaneIpc();
  const { BrowserWindow } = electron();
  const existing = windows.get(id);
  if (existing && !existing.isDestroyed()) {
    existing.show();
    existing.focus();
    return existing;
  }
  const win = new BrowserWindow({
    width: 900,
    height: 680,
    minWidth: 560,
    minHeight: 420,
    show: false,
    title: `Aither ${PLANES[id].label}`,
    backgroundColor: "#0f1218",
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, "plane-preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  windows.set(id, win);
  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  win.webContents.on("will-navigate", (event) => event.preventDefault());
  win.once("ready-to-show", () => {
    win.show();
    win.focus();
  });
  win.on("closed", () => {
    if (windows.get(id) === win) windows.delete(id);
  });
  void win.loadFile(path.join(__dirname, planeFile(id)));
  return win;
}

function closePlaneWindow(planeId) {
  const win = windows.get(String(planeId || ""));
  if (win && !win.isDestroyed()) win.close();
}

function isPlaneWindowOpen(planeId) {
  const win = windows.get(String(planeId || ""));
  return Boolean(win && !win.isDestroyed());
}

module.exports = {
  ensurePlaneIpc, createPlaneWindow, closePlaneWindow, isPlaneWindowOpen, planeHandlers, planeFile,
};
