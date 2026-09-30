"use strict";

/**
 * disk-explorer-window.cjs — the "Disk Explorer" window and the owner of its IPC.
 *
 * Tabs: Tree (folder sizes), Search (every indexed file on the caller's nodes),
 * Duplicates (content groups + wasted bytes), Proposals (dedup / archive / share
 * proposals, with "Raise decision card"), Shares.
 *
 * Same shape as ops-window.cjs (ensure<X>Ipc / create / close / isOpen, with a
 * pure handler table so the IPC contract is testable without Electron). The
 * transport is disk-explorer-client.cjs -> the Veil /api/storage proxy on the
 * signed-in aitherium.com session; the window holds no credential.
 *
 * What the window can NOT do, on purpose: approve, apply, delete, move. A
 * proposal is answered as a decision card by a human (Inbox / Veil), never here.
 */

const path = require("node:path");

// The living desktop's partition: where the owner's aitherium.com session cookie
// lives (living-desktop-window.cjs PARTITION; inference-window.cjs uses the same).
const SESSION_PARTITION = "persist:living-desktop";

function electron() {
  return require("electron");
}

let explorerWindow = null;
let wired = false;
let clientImpl = null;
let signInHandler = null;

function setDiskExplorerSignInHandler(fn) {
  signInHandler = typeof fn === "function" ? fn : null;
}

function client() {
  if (!clientImpl) {
    const { session } = electron();
    const { DiskExplorerClient } = require("./disk-explorer-client.cjs");
    const ses = session.fromPartition(SESSION_PARTITION);
    // credentials:"include" is what makes the partition's cookies ride along.
    clientImpl = new DiskExplorerClient({ fetchImpl: (url, init) => ses.fetch(url, { ...init, credentials: "include" }) });
  }
  return clientImpl;
}

function obj(v) {
  return v && typeof v === "object" && !Array.isArray(v) ? v : {};
}

/**
 * The handler table, pure over an injected client. Every handler resolves the
 * client's own {ok, data|error} verdict; none throws across the bridge. Only
 * the named fields of each renderer payload are forwarded — a renderer cannot
 * smuggle extra keys into a Genesis body.
 */
function diskExplorerHandlers(disk = client(), { whoami = null } = {}) {
  const who = whoami || (() => require("./disk-explorer-client.cjs").awstorageWhoami());
  return {
    // `awstorage whoami` order (env AWSTORAGE_NODE, ~/.aither/node-id, hostname),
    // never a bare os.hostname() guess; the renderer also offers /files/nodes.
    "desk:disk-host": () => ({ ok: true, data: who() }),
    "desk:disk-nodes": () => disk.nodes(),
    "desk:disk-search": (_e, opts) => {
      const o = obj(opts);
      return disk.search({ q: o.q, node: o.node, ext: o.ext, minSize: o.minSize, newerDays: o.newerDays, limit: o.limit, cursor: o.cursor });
    },
    "desk:disk-dupes": (_e, opts) => {
      const o = obj(opts);
      return disk.dupes({ node: o.node, minSize: o.minSize, limit: o.limit });
    },
    "desk:disk-tree": (_e, opts) => {
      const o = obj(opts);
      return disk.tree({ node: o.node, path: o.path, depth: o.depth });
    },
    "desk:disk-proposals": (_e, opts) => {
      const o = obj(opts);
      return disk.proposals({ node: o.node, status: o.status, limit: o.limit });
    },
    "desk:disk-raise-card": (_e, proposalId) => disk.raiseCard(proposalId),
    "desk:disk-share": (_e, opts) => {
      const o = obj(opts);
      return disk.share({ node: o.node, path: o.path, seal: o.seal === true });
    },
    "desk:disk-shares": () => disk.shares(),
  };
}

function ensureDiskExplorerIpc() {
  if (wired) return;
  wired = true;
  const { ipcMain, shell } = electron();
  for (const [channel, handler] of Object.entries(diskExplorerHandlers())) ipcMain.handle(channel, handler);
  ipcMain.on("desk:disk-sign-in", () => {
    if (signInHandler) { signInHandler(); return; }
    void shell.openExternal(`${client().base}/login?returnUrl=%2Fworkspace%2Fstorage`);
  });
  ipcMain.on("desk:disk-open-inbox", () => {
    void shell.openExternal(`${client().base}/workspace/storage`);
  });
}

function createDiskExplorerWindow() {
  ensureDiskExplorerIpc();
  const { BrowserWindow } = electron();
  if (explorerWindow && !explorerWindow.isDestroyed()) {
    explorerWindow.show();
    explorerWindow.focus();
    return explorerWindow;
  }
  explorerWindow = new BrowserWindow({
    width: 1080,
    height: 760,
    minWidth: 680,
    minHeight: 480,
    show: false,
    title: "Disk Explorer",
    backgroundColor: "#0f1218",
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, "disk-explorer-preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  explorerWindow.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  explorerWindow.webContents.on("will-navigate", (event) => event.preventDefault());
  explorerWindow.once("ready-to-show", () => {
    explorerWindow.show();
    explorerWindow.focus();
  });
  explorerWindow.on("closed", () => {
    explorerWindow = null;
  });
  void explorerWindow.loadFile(path.join(__dirname, "disk-explorer.html"));
  return explorerWindow;
}

function closeDiskExplorerWindow() {
  if (explorerWindow && !explorerWindow.isDestroyed()) explorerWindow.close();
}

function isDiskExplorerWindowOpen() {
  return Boolean(explorerWindow && !explorerWindow.isDestroyed());
}

/** The shared client (main's drop "share this" lane reuses it). */
function getDiskExplorerClient() {
  return client();
}

module.exports = {
  ensureDiskExplorerIpc,
  createDiskExplorerWindow,
  closeDiskExplorerWindow,
  isDiskExplorerWindowOpen,
  setDiskExplorerSignInHandler,
  getDiskExplorerClient,
  diskExplorerHandlers,
  SESSION_PARTITION,
};
