"use strict";

/**
 * browser-extensions.cjs -- awconnect built into the Aither Browser.
 *
 * Owner, 2026-10-04: "AWCONNECT BROWSER EXTENSION SHOULD BE BUILT IN". The real
 * extension -- the same build adk stages for Chrome/Edge at ~/.aither/awconnect/current
 * (`adk awconnect status` -> latest.path) -- is loaded into the browser's OWN web
 * partition, so its content scripts (the aitherium.com portal bridge, the freeze
 * watchdog) and its background worker run on the pages you browse here, exactly as
 * in Edge. Its full UI opens as a tab (chrome-extension://<id>/sidepanel/index.html).
 *
 * What Electron cannot give an MV3 extension (sidePanel, offscreen, omnibox,
 * contextMenus) it simply does not get; the desk's Connect panel stays the side panel.
 * chrome.identity it does get now -- awconnect-webauth.cjs answers the shim's
 * launchWebAuthFlow, so awconnect's own Sign in works (see awconnect-compat-preload.cjs).
 * DESK_AWCONNECT_DIR points at another unpacked build; DESK_AWCONNECT=0 turns it off.
 *
 * Pure decisions here (which folder, which URLs); the one Electron call is injected.
 */

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

/** Fallback UI page; the manifest's side_panel.default_path wins (uiPath). */
const UI_PAGE = "sidepanel/sidepanel.html";
const COMPAT_PRELOAD = path.join(__dirname, "awconnect-compat-preload.cjs");
const COMPAT_ID = "aither-awconnect-compat";
const EXTENSION_ID = /^[a-p]{32}$/;

/** The unpacked awconnect folder to load, or null (none staged, or turned off). */
function awconnectDir({ env = process.env, home = os.homedir(), exists = fs.existsSync } = {}) {
  if (String((env && env.DESK_AWCONNECT) || "") === "0") return null;
  const candidates = [];
  if (env && env.DESK_AWCONNECT_DIR) candidates.push(String(env.DESK_AWCONNECT_DIR));
  candidates.push(path.join(home, ".aither", "awconnect", "current"));
  for (const dir of candidates) {
    if (dir && exists(path.join(dir, "manifest.json"))) return dir;
  }
  return null;
}

/** Is `url` a page of THIS extension (the only chrome-extension: URL a tab may hold)? */
function isExtensionPage(url, id) {
  if (!EXTENSION_ID.test(String(id || ""))) return false;
  try {
    const parsed = new URL(String(url || ""));
    return parsed.protocol === "chrome-extension:" && parsed.hostname === id;
  } catch {
    return false;
  }
}

/** The extension's own UI page: its side panel, else its popup. Relative, no "..". */
function uiPath(manifest) {
  const m = manifest || {};
  const want = String((m.side_panel && m.side_panel.default_path) || (m.action && m.action.default_popup) || UI_PAGE);
  return /^[A-Za-z0-9_\-./]+\.html$/.test(want) && !want.split("/").includes("..") && !want.startsWith("/") ? want : UI_PAGE;
}

function uiUrl(id, page = UI_PAGE) {
  return EXTENSION_ID.test(String(id || "")) ? `chrome-extension://${id}/${uiPath({ side_panel: { default_path: page } })}` : null;
}

/** The compat preload for awconnect's worker, registered on the session once (Electron 35+). */
function registerCompat(ses) {
  if (!ses || typeof ses.registerPreloadScript !== "function") return false;
  try {
    const have = typeof ses.getPreloadScripts === "function" ? ses.getPreloadScripts() : [];
    if ((have || []).some((p) => p && p.id === COMPAT_ID)) return true;
    ses.registerPreloadScript({ id: COMPAT_ID, type: "service-worker", filePath: COMPAT_PRELOAD });
    return true;
  } catch {
    return false;
  }
}

/**
 * Load awconnect into `ses` once. Electron 36+ moved the API to `ses.extensions`.
 * @returns {Promise<{ok: true, id, name, version, dir} | {ok: false, error}>}
 */
async function loadAwconnect(ses, { dir = awconnectDir() } = {}) {
  if (!dir) return { ok: false, error: "no awconnect build is staged (adk awconnect setup stages one)" };
  const api = ses && (ses.extensions || ses);
  if (!api || typeof api.loadExtension !== "function") return { ok: false, error: "this Electron cannot load extensions" };
  // Before the worker first starts: Electron lacks chrome.cookies/windows/storage.sync...
  const compat = registerCompat(ses);
  try {
    const already = typeof api.getAllExtensions === "function" ? api.getAllExtensions() : [];
    const found = (already || []).find((ext) => ext && path.resolve(ext.path || "") === path.resolve(dir));
    const ext = found || await api.loadExtension(dir, { allowFileAccess: false });
    return { ok: true, id: ext.id, name: ext.name, version: ext.version, dir, compat,
      ui: uiPath(ext.manifest) };
  } catch (error) {
    return { ok: false, error: String((error && error.message) || error) };
  }
}

/** Tab preferences for `kind`: awconnect's own tab gets the compat preload, every other tab is unchanged. */
function withCompat(kind, prefs) {
  return kind === "extension" ? { ...prefs, preload: COMPAT_PRELOAD } : prefs;
}

module.exports = { COMPAT_PRELOAD, UI_PAGE, awconnectDir, isExtensionPage, loadAwconnect, registerCompat, uiPath, uiUrl, withCompat };
