"use strict";

/**
 * files-window.cjs — the Files page's standalone twin, and the owner of its IPC.
 *
 * Same shape as ops-window.cjs. The page is the OWNER's local file explorer:
 * roots from cast.json (files-access.cjs), list / open / reveal in Explorer /
 * hand to agent, and the per-root switch that lets agents READ a root through
 * the desk MCP files_* tools.
 *
 * 2026-11-01 (owner: "do the same for file explorer"): the page is a real
 * Explorer replacement. The OWNER's write verbs -- new folder, rename, copy,
 * move, delete, drop-import, properties, preview, thumbnails, Send to Aitherium,
 * Ask Aither -- live in files-ops.cjs and are reachable ONLY through these IPC
 * channels, i.e. the owner's own page. The agent half (files-access agent, the
 * desk MCP files_* tools) is untouched and stays read-only. Delete is always
 * shell.trashItem (the Recycle Bin). The Win+E switch is files-wine.cjs.
 *
 * "Hand to agent" posts the path into the chat (main injects the poster with
 * setFilesHandOff -- the same relay line a dropped file produces) and says, in
 * that line, whether agents can actually read it. Handing over a path in an
 * UNSHARED root does not grant anything: the line says so, and the owner flips
 * the switch if he means it.
 *
 * 🚩 Sender check: every desk:files-* channel answers ONLY the local
 * electron/files.html (the detached window or the console's pane iframe), judged
 * on event.senderFrame.url as an exact file path -- never a substring. Any other
 * frame gets {ok:false, reason}. Import sources are resolved from dropped File
 * objects INSIDE the preload (importFiles), so page script never names a source.
 *
 * The Win+E switch stays shut (files-wine `routed`) until main.cjs routes
 * `--files` and says so with setFilesLaunchRouted(true).
 */

const path = require("node:path");
const { fileURLToPath } = require("node:url");

const PAGE_FILE = path.join(__dirname, "files.html");

function electron() {
  return require("electron");
}

let filesWindow = null;
let wired = false;
let accessImpl = null;
let handOffImpl = null;
let wineImpl = null;
let launchRouted = false;

/**
 * main.cjs calls this with true NEXT TO the code that routes `--files` on first
 * launch and in second-instance argv to createFilesWindow(). Until then the
 * Win+E switch refuses to enable (it would hijack Win+E for nothing).
 * @param {boolean} routed
 */
function setFilesLaunchRouted(routed) {
  launchRouted = routed === true;
}

/**
 * Is this IPC from the local Files page? Exact file:// path of electron/files.html
 * (query/hash ignored); http(s), data:, another page or a missing frame -> false.
 * @param {object} event  IpcMainInvokeEvent
 * @param {string} [page] the expected page path (tests)
 * @returns {boolean}
 */
function senderAllowed(event, page = PAGE_FILE) {
  try {
    const raw = event && event.senderFrame && event.senderFrame.url;
    if (!raw) return false;
    const url = new URL(String(raw));
    if (url.protocol !== "file:" || (url.host && url.host !== "localhost")) return false;
    url.search = "";
    url.hash = "";
    const got = path.resolve(fileURLToPath(url.href));
    const want = path.resolve(page);
    return process.platform === "win32" ? got.toLowerCase() === want.toLowerCase() : got === want;
  } catch {
    return false;
  }
}

/** Wrap every handler with senderAllowed; a refused frame gets the fail-soft shape. */
function guardHandlers(handlers, allowed = senderAllowed) {
  const out = {};
  for (const [channel, handler] of Object.entries(handlers)) {
    out[channel] = (event, ...args) => (allowed(event)
      ? handler(event, ...args)
      : { ok: false, reason: "1 caller refused -- only the desk's own Files page may use this", error: "caller refused" });
  }
  return out;
}

/** The Win+E switch, pointed at THIS desk binary (plus the app dir when unpackaged). */
function wine() {
  if (!wineImpl) {
    const { app } = electron();
    wineImpl = require("./files-wine.cjs").createWinE({
      exe: process.execPath, appArgs: app.isPackaged ? [] : [app.getAppPath()],
      routed: () => launchRouted,
    });
  }
  return wineImpl;
}

/** Shell thumbnail (any file type Explorer can thumbnail) as a data URL, or null. */
async function defaultThumbnail(absPath, size) {
  try {
    const { nativeImage } = electron();
    if (typeof nativeImage.createThumbnailFromPath !== "function") return null;
    const img = await nativeImage.createThumbnailFromPath(absPath, { width: size, height: size });
    return img && !img.isEmpty() ? img.toDataURL() : null;
  } catch {
    return null;
  }
}

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
function filesHandlers({
  files = access(), shell = null, handOff = null, pickFolder = defaultPickFolder, ops = null, winE = null,
  thumbnail = defaultThumbnail,
} = {}) {
  const sh = () => shell || defaultShell();
  let opsImpl = ops;
  const op = () => {
    if (!opsImpl) {
      opsImpl = require("./files-ops.cjs").createFilesOps({
        files, trash: (p) => sh().trashItem(p), thumbnail,
      });
    }
    return opsImpl;
  };
  const w = () => winE || wine();
  const list = (v) => (Array.isArray(v) ? v : [v]).map((x) => String(x == null ? "" : x)).filter(Boolean).slice(0, 5000);
  const s = (v) => String(v == null ? "" : v);
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
    // ── owner write verbs (files-ops.cjs); each resolves {ok, ...} | {ok:false, reason} ──
    "desk:files-mkdir": (_e, rootId, rel, name) => op().mkdir(s(rootId), s(rel), name ? s(name) : undefined),
    "desk:files-rename": (_e, rootId, rel, name) => op().rename(s(rootId), s(rel), s(name)),
    "desk:files-copy": (_e, srcRoot, rels, dstRoot, dstRel) => op().copy(s(srcRoot), list(rels), s(dstRoot), s(dstRel)),
    "desk:files-move": (_e, srcRoot, rels, dstRoot, dstRel) => op().move(s(srcRoot), list(rels), s(dstRoot), s(dstRel)),
    "desk:files-trash": (_e, rootId, rels) => op().remove(s(rootId), list(rels)),
    "desk:files-import": (_e, paths, dstRoot, dstRel, move) => op().importPaths(list(paths), s(dstRoot), s(dstRel),
      { move: move === true }),
    "desk:files-props": (_e, rootId, rel) => op().properties(s(rootId), s(rel)),
    "desk:files-preview": (_e, rootId, rel) => op().preview(s(rootId), s(rel)),
    "desk:files-thumb": (_e, rootId, rel, size) => op().thumb(s(rootId), s(rel), Number(size) || 96),
    "desk:files-address": (_e, text) => op().resolveAddress(s(text)),
    "desk:files-send": (_e, rootId, rels) => op().sendToAitherium(s(rootId), list(rels)),
    "desk:files-cloud": () => op().cloudList(),
    "desk:files-ask": (_e, rootId, rel, question) => op().ask(s(rootId), s(rel), s(question)),
    "desk:files-wine-status": () => w().status(),
    "desk:files-wine-enable": (_e, consent) => w().enable({ consent: consent === true }),
    "desk:files-wine-restore": () => w().restore(),
    // Drag OUT to Explorer / another app: located (confined) paths only.
    "desk:files-drag-out": (event, rootId, rels) => answer(() => {
      const paths = list(rels).map((rel) => op().locateOp(s(rootId), rel));
      if (!paths.length) throw new Error("nothing to drag");
      const { nativeImage } = electron();
      let icon = nativeImage.createFromPath(path.join(__dirname, "..", "build", "icon.png"));
      if (!icon.isEmpty()) icon = icon.resize({ width: 32, height: 32 });
      event.sender.startDrag({ file: paths[0], files: paths, icon });
      // The page compares a later drop against THESE, so a stale drag never moves the wrong files.
      return { dragging: paths.length, paths };
    }),
  };
}

function ensureFilesIpc() {
  if (wired) return;
  wired = true;
  const { ipcMain } = electron();
  for (const [channel, handler] of Object.entries(guardHandlers(filesHandlers()))) ipcMain.handle(channel, handler);
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
    width: 1200,
    height: 760,
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
      // The preview pane shows a PDF through Chromium's built-in viewer.
      plugins: true,
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
  setFilesHandOff, handOffLine, wine, setFilesLaunchRouted, senderAllowed, guardHandlers, PAGE_FILE,
};
