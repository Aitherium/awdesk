"use strict";

/**
 * extensions-window.cjs -- aither://extensions: the Aither Browser's extensions page,
 * like chrome://extensions (owner, 2026-10-04: "like plugins and extensions").
 *
 * What it can do, and nothing more:
 *   - list every extension loaded into the browser's web session (awconnect is built in);
 *   - add an UNPACKED extension folder the owner picks in a folder dialog (no store, no
 *     .crx, no path typed by a page);
 *   - remove one the owner added (awconnect stays: it is part of the browser);
 *   - open an extension's own page (its side panel / popup) as a tab.
 * Added folders persist in userData/extensions.json and load when the browser opens.
 * Every channel answers only aither://extensions.
 */

const fs = require("node:fs");
const path = require("node:path");

let wired = false;
/** browser-window installs these: {session(), awconnectId(), openExtensionUi(id)} */
let host = null;

function setExtensionsHost(h) {
  host = h && typeof h.session === "function" ? h : null;
}

function listFile() {
  return path.join(require("electron").app.getPath("userData"), "extensions.json");
}

/** The folders the owner added (absolute paths that still hold a manifest). */
function savedDirs({ file = listFile(), exists = fs.existsSync } = {}) {
  try {
    const data = JSON.parse(fs.readFileSync(file, "utf8"));
    return (Array.isArray(data.dirs) ? data.dirs : [])
      .filter((d) => typeof d === "string" && path.isAbsolute(d) && exists(path.join(d, "manifest.json")));
  } catch {
    return [];
  }
}

function saveDirs(dirs, { file = listFile() } = {}) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ dirs: [...new Set(dirs)].slice(0, 50) }, null, 2));
}

/** Load every saved folder into `ses` (called when the browser opens). */
async function loadSaved(ses, opts = {}) {
  const api = ses && (ses.extensions || ses);
  if (!api || typeof api.loadExtension !== "function") return [];
  const out = [];
  for (const dir of savedDirs(opts)) {
    try {
      const have = (api.getAllExtensions ? api.getAllExtensions() : []).find((e) => path.resolve(e.path) === path.resolve(dir));
      out.push(have || await api.loadExtension(dir, { allowFileAccess: false }));
    } catch { /* a broken folder stays listed in the file; the page shows it as not loaded */ }
  }
  return out;
}

function fromExtensionsPage(sender) {
  try {
    const url = new URL(sender.getURL());
    return url.protocol === "aither:" && url.hostname === "extensions";
  } catch {
    return false;
  }
}

function row(ext, { builtinId, added }) {
  const m = ext.manifest || {};
  return {
    id: ext.id, name: String(ext.name || m.name || ext.id), version: String(ext.version || m.version || ""),
    description: String(m.description || "").slice(0, 300), path: String(ext.path || ""),
    builtin: ext.id === builtinId, added: added.some((d) => path.resolve(d) === path.resolve(ext.path || "")),
    hasUi: Boolean((m.side_panel && m.side_panel.default_path) || (m.action && m.action.default_popup)),
  };
}

/**
 * The awsh plugin for Claude Code (the hooks module every awsh/Claude Code session loads):
 * `adk harness mod status` answers JSON; `install` puts it in (or refreshes a stale copy).
 * Only these two verbs; the page never names a command.
 */
function runAdkMod(verb, execFile = require("node:child_process").execFile) {
  if (!["status", "install"].includes(verb)) return Promise.resolve({ ok: false, error: "unknown plugin verb" });
  return new Promise((resolve) => {
    execFile("adk", ["harness", "mod", verb], { timeout: 120_000, windowsHide: true }, (error, stdout, stderr) => {
      const text = String(stdout || "");
      const at = text.indexOf("{");
      let data;
      try { data = at >= 0 ? JSON.parse(text.slice(at)) : null; } catch { data = null; }
      if (error && error.code === "ENOENT") return resolve({ ok: false, error: "adk is not installed" });
      if (!data) return resolve({ ok: false, error: (String(stderr || text).trim().split("\n").pop() || "adk gave no answer") });
      resolve({ ok: true, plugin: {
        name: "awsh for Claude Code", active: Boolean(data.active), installed: Boolean(data.plugin_installed),
        version: String(data.plugin_version || ""), source: String(data.source_version || ""),
        stale: Boolean(data.plugin_stale), hooks: Boolean(data.function_hooks_enabled), note: String(data.note || ""),
      } });
    });
  });
}

function extensionsHandlers({ isPage = fromExtensionsPage, getHost = () => host,
  dialog = () => require("electron").dialog, file = null, adk = runAdkMod } = {}) {
  const opts = file ? { file } : {};
  const guard = (fn) => async (event, ...args) => {
    if (!event || !event.sender || !isPage(event.sender)) return { ok: false, error: "not the extensions page" };
    const h = getHost();
    if (!h) return { ok: false, error: "the browser is not open" };
    try {
      return await fn(h, event, ...args);
    } catch (error) {
      return { ok: false, error: String((error && error.message) || error) };
    }
  };
  const api = (h) => { const s = h.session(); return s.extensions || s; };
  return {
    "desk:extensions-list": guard((h) => {
      const added = savedDirs(opts);
      return { ok: true, extensions: api(h).getAllExtensions().map((e) => row(e, { builtinId: h.awconnectId(), added })) };
    }),
    "desk:extensions-add": guard(async (h, event) => {
      const { BrowserWindow } = require("electron");
      const parent = BrowserWindow.fromWebContents(event.sender.hostWebContents || event.sender) || undefined;
      const pick = await dialog().showOpenDialog(parent, { title: "Choose an unpacked extension folder",
        properties: ["openDirectory"] });
      if (pick.canceled || !pick.filePaths[0]) return { ok: false, cancelled: true };
      const dir = pick.filePaths[0];
      if (!fs.existsSync(path.join(dir, "manifest.json"))) return { ok: false, error: "that folder has no manifest.json" };
      const ext = await api(h).loadExtension(dir, { allowFileAccess: false });
      saveDirs([...savedDirs(opts), dir], opts);
      return { ok: true, id: ext.id, name: ext.name };
    }),
    "desk:extensions-remove": guard((h, _e, id) => {
      const ext = api(h).getAllExtensions().find((e) => e.id === String(id || ""));
      if (!ext) return { ok: false, error: "no such extension" };
      if (ext.id === h.awconnectId()) return { ok: false, error: "awconnect is built into the browser" };
      api(h).removeExtension(ext.id);
      saveDirs(savedDirs(opts).filter((d) => path.resolve(d) !== path.resolve(ext.path)), opts);
      return { ok: true };
    }),
    "desk:extensions-open": guard((h, _e, id) => h.openExtensionUi(String(id || ""))),
    "desk:plugins-status": guard(() => adk("status")),
    "desk:plugins-install": guard(async () => {
      const r = await adk("install");
      return r.ok ? adk("status") : r;
    }),
  };
}

function ensureExtensionsIpc() {
  if (wired) return;
  wired = true;
  const { ipcMain } = require("electron");
  for (const [channel, handler] of Object.entries(extensionsHandlers())) ipcMain.handle(channel, handler);
}

module.exports = { runAdkMod, ensureExtensionsIpc, extensionsHandlers, fromExtensionsPage, loadSaved, saveDirs, savedDirs, setExtensionsHost };
