"use strict";

/**
 * files-window.cjs — the Files page's standalone twin, and the owner of its IPC.
 *
 * Same shape as ops-window.cjs. The page is the OWNER's local file explorer:
 * roots from cast.json (files-access.cjs), list / open / reveal in Explorer /
 * hand to agent, and the per-root switch that lets agents READ a root through
 * the desk MCP files_* tools. Nothing here writes, moves or deletes a file.
 *
 * "Hand to agent" posts the path into the chat (main injects the poster with
 * setFilesHandOff -- the same relay line a dropped file produces) and says, in
 * that line, whether agents can actually read it. Handing over a path in an
 * UNSHARED root does not grant anything: the line says so, and the owner flips
 * the switch if he means it.
 */

const path = require("node:path");

function electron() {
  return require("electron");
}

let filesWindow = null;
let wired = false;
let accessImpl = null;
let handOffImpl = null;

function access() {
  if (!accessImpl) accessImpl = require("./files-access.cjs").createFilesAccess();
  return accessImpl;
}

/** main.cjs: (text, {path, rootId, rootLabel, agentRead}) => {ok} | Promise. */
function setFilesHandOff(fn) {
  handOffImpl = typeof fn === "function" ? fn : null;
}

async function answer(fn) {
  try {
    return { ok: true, data: await fn() };
  } catch (error) {
    return { ok: false, error: String((error && error.message) || error) };
  }
}

function handOffLine(loc) {
  const share = loc.root.agentRead
    ? `agents may read it (desk files_read, root "${loc.root.label}")`
    : `its folder "${loc.root.label}" is NOT shared with agents -- grant it in Files to let them read it`;
  return `📂 The owner handed over ${loc.path} -- ${share}.`;
}

function defaultShell() {
  return electron().shell;
}

async function defaultPickFolder() {
  const { dialog, BrowserWindow } = electron();
  const parent = BrowserWindow.getFocusedWindow() || undefined;
  const picked = await dialog.showOpenDialog(parent, { properties: ["openDirectory"] });
  return picked && !picked.canceled && picked.filePaths && picked.filePaths[0] ? picked.filePaths[0] : null;
}

/**
 * The handler table, pure over injected dependencies so it is testable without Electron.
 * @param {object} deps
 * @param {object} [deps.files]      files-access instance
 * @param {object} [deps.shell]      {openPath(p) -> Promise<string>, showItemInFolder(p)}
 * @param {Function} [deps.handOff]  (text, meta) -> {ok}; default: what main injected
 * @param {Function} [deps.pickFolder] () -> Promise<string|null>
 */
function filesHandlers({ files = access(), shell = null, handOff = null, pickFolder = defaultPickFolder } = {}) {
  const sh = () => shell || defaultShell();
  return {
    "desk:files-roots": () => answer(() => files.roots()),
    "desk:files-list": (_e, rootId, rel) => answer(() => files.list(String(rootId || ""), String(rel || ""))),
    "desk:files-open": (_e, rootId, rel) => answer(async () => {
      const loc = files.locate(String(rootId || ""), String(rel || ""));
      const why = await sh().openPath(loc.path);
      if (why) throw new Error(why);
      return { opened: loc.path };
    }),
    "desk:files-reveal": (_e, rootId, rel) => answer(() => {
      const loc = files.locate(String(rootId || ""), String(rel || ""));
      sh().showItemInFolder(loc.path);
      return { revealed: loc.path };
    }),
    "desk:files-hand": (_e, rootId, rel) => answer(async () => {
      const post = handOff || handOffImpl;
      if (!post) throw new Error("the chat is not wired in this build -- nothing was posted");
      const loc = files.locate(String(rootId || ""), String(rel || ""));
      const text = handOffLine(loc);
      const verdict = await post(text, { path: loc.path, rootId: loc.root.id, rootLabel: loc.root.label,
        agentRead: loc.root.agentRead });
      if (verdict && verdict.ok === false) throw new Error(verdict.error || verdict.detail || verdict.reason || "chat refused the post");
      return { posted: text, agentRead: loc.root.agentRead };
    }),
    "desk:files-grant": (_e, rootId, allowed) => answer(() => files.setAgentRead(String(rootId || ""),
      allowed === true)),
    "desk:files-add-root": () => answer(async () => {
      const picked = await pickFolder();
      if (!picked) return { added: false, cancelled: true };
      return files.addRoot(picked);
    }),
    "desk:files-remove-root": (_e, rootId) => answer(() => files.removeRoot(String(rootId || ""))),
  };
}

function ensureFilesIpc() {
  if (wired) return;
  wired = true;
  const { ipcMain } = electron();
  for (const [channel, handler] of Object.entries(filesHandlers())) ipcMain.handle(channel, handler);
}

function createFilesWindow() {
  ensureFilesIpc();
  const { BrowserWindow } = electron();
  if (filesWindow && !filesWindow.isDestroyed()) {
    filesWindow.show();
    filesWindow.focus();
    return filesWindow;
  }
  filesWindow = new BrowserWindow({
    width: 1000,
    height: 720,
    minWidth: 620,
    minHeight: 440,
    show: false,
    title: "Aither Files",
    backgroundColor: "#0f1218",
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, "files-preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  filesWindow.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  filesWindow.webContents.on("will-navigate", (event) => event.preventDefault());
  filesWindow.once("ready-to-show", () => {
    filesWindow.show();
    filesWindow.focus();
  });
  filesWindow.on("closed", () => {
    filesWindow = null;
  });
  void filesWindow.loadFile(path.join(__dirname, "files.html"));
  return filesWindow;
}

function closeFilesWindow() {
  if (filesWindow && !filesWindow.isDestroyed()) filesWindow.close();
}

function isFilesWindowOpen() {
  return Boolean(filesWindow && !filesWindow.isDestroyed());
}

module.exports = {
  ensureFilesIpc, createFilesWindow, closeFilesWindow, isFilesWindowOpen, filesHandlers,
  setFilesHandOff, handOffLine,
};
