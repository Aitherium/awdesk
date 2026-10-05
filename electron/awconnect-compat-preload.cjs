"use strict";

/**
 * awconnect-compat-preload.cjs -- the chrome.* APIs Electron does not give an extension,
 * filled in so awconnect's background worker and its own pages START in the Aither
 * Browser (browser-extensions.cjs).
 *
 * Measured 2026-10-04 (Electron 39, awconnect 3.8.0): a minimal MV3 worker runs, but
 * awconnect's dies at its first line that touches `chrome.cookies.onChanged`, then
 * `chrome.windows.onFocusChanged`, then `chrome.storage.sync` -- "Service worker
 * registration failed. Status code: 15". With this shim it registers and runs.
 *
 * What it does, and nothing more:
 *   - a namespace Electron lacks becomes a stub: `onX` events accept listeners and
 *     never fire; methods resolve `undefined`. A feature built on one is inert here,
 *     exactly as on a browser without that API -- never an exception at startup.
 *   - a namespace Electron HAS keeps every real member; only MISSING members are
 *     stubbed the same way.
 *   - `storage.sync` (no sync account in an embedded browser) is `storage.local`.
 *
 * Registered as the SERVICE-WORKER preload of the browser's web session (awconnect's
 * background worker) and given to the awconnect UI tab (kind "extension") only; web
 * tabs never get it. It exposes nothing, and acts only on a chrome-extension: origin.
 * A sandboxed preload cannot require a local file, so the shim lives here, and
 * `compatShim` is serialized into the main world by contextBridge.executeInMainWorld:
 * it must stay self-contained (no closure).
 */

function compatShim() {
  // Only on an extension's own origin -- read HERE, in the main world: the preload's
  // isolated context cannot see a service worker's location (measured: it was empty).
  const loc = globalThis.location;
  if (!loc || loc.protocol !== "chrome-extension:") return;
  const c = globalThis.chrome;
  if (!c || c.__aitherCompat) return;
  const ev = () => ({ addListener() {}, removeListener() {}, hasListener() { return false; }, hasListeners() { return false; } });
  const fill = (k) => (/^on[A-Z]/.test(String(k)) ? ev() : () => Promise.resolve(undefined));
  const stub = () => new Proxy({}, { get: (t, k) => (k in t ? t[k] : (t[k] = fill(k))) });
  const wrap = (orig, special) => new Proxy(orig, {
    get: (t, k) => {
      if (special && Object.prototype.hasOwnProperty.call(special, k)) return special[k](t);
      let v;
      try { v = Reflect.get(t, k); } catch { v = undefined; }
      if (v !== undefined) return typeof v === "function" ? v.bind(t) : v;
      return fill(k);
    },
  });
  const names = ["cookies", "contextMenus", "omnibox", "sidePanel", "offscreen", "identity", "notifications",
    "processes", "downloads", "alarms", "windows", "tabs", "tabGroups", "commands", "action", "scripting",
    "webNavigation", "permissions", "idle", "system", "storage", "runtime", "i18n", "management", "history",
    "bookmarks", "declarativeNetRequest", "webRequest", "search", "tts", "fontSettings"];
  const special = {
    storage: { sync: (t) => {
      try { return t.sync || t.local; } catch { return t.local; }
    } },
  };
  for (const name of names) {
    try {
      let present;
      try { present = c[name]; } catch { present = undefined; }
      c[name] = present ? wrap(present, special[name]) : stub();
    } catch { /* a frozen namespace stays as it is */ }
  }
  try { Object.defineProperty(c, "__aitherCompat", { value: true }); } catch { /* fine */ }
}

const { contextBridge } = require("electron");

if (contextBridge && typeof contextBridge.executeInMainWorld === "function") {
  try { contextBridge.executeInMainWorld({ func: compatShim }); } catch { /* the extension starts as it would */ }
}

if (typeof module !== "undefined" && module.exports) module.exports = { compatShim };
