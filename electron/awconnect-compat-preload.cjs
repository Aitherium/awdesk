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
 * it must stay self-contained (no closure over this file) -- it receives its one
 * privileged handle as an executeInMainWorld ARGUMENT instead (see isolatedBridge).
 *
 * chrome.identity (added 2026-10-06): `getRedirectURL` is real string work done right
 * here, and `launchWebAuthFlow` calls the desk's webauth window over the bridged
 * function: main world -> bridged function -> preload's ipcRenderer -> awconnect-webauth.cjs.
 * Measured: executeInMainWorld copies a function argument INTO the main world as a
 * callable proxy (page world AND service-worker world), and ipcRenderer exists in the
 * preload world of both. Without a bridge it stays inert, exactly as a browser without
 * the API -- never an exception at startup.
 */

function compatShim(identity) {
  // Only on an extension's own origin -- read HERE, in the main world: the preload's
  // isolated context cannot see a service worker's location (measured: it was empty).
  const loc = globalThis.location;
  if (!loc || loc.protocol !== "chrome-extension:") return;
  const c = globalThis.chrome;
  if (!c || c.__aitherCompat) return;
  const ev = () => ({ addListener() {}, removeListener() {}, hasListener() { return false; }, hasListeners() { return false; } });
  const fill = (k) => (/^on[A-Z]/.test(String(k)) ? ev() : () => Promise.resolve(undefined));
  const stub = (special) => new Proxy({}, { get: (t, k) => {
    if (special && Object.prototype.hasOwnProperty.call(special, k)) return special[k](t);
    return k in t ? t[k] : (t[k] = fill(k));
  } });
  const wrap = (orig, special) => new Proxy(orig, {
    get: (t, k) => {
      if (special && Object.prototype.hasOwnProperty.call(special, k)) return special[k](t);
      let v;
      try { v = Reflect.get(t, k); } catch { v = undefined; }
      if (v !== undefined) return typeof v === "function" ? v.bind(t) : v;
      return fill(k);
    },
  });
  // The extension's own id, read HERE in the main world: chrome.runtime.id is what
  // Electron's extension support exposes in a page and in a worker; location.host (a
  // chrome-extension: page or worker location) is the fallback. An id we cannot read
  // leaves identity inert rather than inventing a callback host.
  const readRuntimeId = () => {
    try { return String((c.runtime && c.runtime.id) || ""); } catch { return ""; }
  };
  const extensionId = () => {
    const fromRuntime = readRuntimeId();
    if (/^[a-p]{32}$/.test(fromRuntime)) return fromRuntime;
    try {
      const host = String((loc && loc.host) || "");
      return /^[a-p]{32}$/.test(host) ? host : "";
    } catch { return ""; }
  };
  // Chrome: getRedirectURL(path?) -> "https://<id>.chromiumapp.org/<path>" SYNCHRONOUSLY,
  // always on the callback host the desk's interception watches. A path that would leave
  // that host (an absolute URL, a scheme, a protocol-relative "//host") falls back to the
  // bare base: the flow can only ever come back to THIS extension's own callback.
  const redirectUrl = (path) => {
    const id = extensionId();
    if (!id) return undefined;
    const base = `https://${id}.chromiumapp.org/`;
    const raw = String(path === undefined || path === null ? "" : path);
    if (/^[a-z][a-z0-9+.-]*:/i.test(raw) || raw.startsWith("//")) return base;
    const rest = raw.replace(/^\/+/, "");
    if (!rest) return base;
    try {
      const resolved = new URL(rest, base);
      return resolved.origin === base.slice(0, -1) ? resolved.href : base;
    } catch { return base; }
  };
  const launchWebAuthFlow = (details, callback) => {
    const cb = typeof callback === "function" ? callback : null;
    const id = extensionId();
    const bridged = identity && typeof identity.launchWebAuthFlow === "function";
    const p = bridged && id
      ? Promise.resolve(identity.launchWebAuthFlow({
        url: String((details && details.url) || ""),
        interactive: !(details && details.interactive === false),
      }))
      : Promise.resolve(undefined);
    if (!cb) return p;
    // The Chromium callback form (MV2-style callers): the flow's value goes to the
    // callback and no promise is returned -- a rejected return would be unhandled.
    // Chromium sets runtime.lastError for the DURATION of the callback and the
    // callback form reads it to learn WHY. Without this a legacy caller
    // (awconnect/shared/oidc-pkce.js) read undefined and reported "sign-in window
    // closed" for user-close, timeout AND load failure alike -- review finding,
    // 2026-10-06.
    p.then(
      (url) => {
        try { cb(url); } finally {
          try { delete c.runtime.lastError; } catch { /* the namespace may be frozen */ }
        }
      },
      (e) => {
        try {
          c.runtime.lastError = { message: String((e && e.message) || e) };
        } catch { /* the namespace may be frozen */ }
        try { cb(undefined); } finally {
          try { delete c.runtime.lastError; } catch { /* the namespace may be frozen */ }
        }
      },
    );
    return undefined;
  };
  const names = ["cookies", "contextMenus", "omnibox", "sidePanel", "offscreen", "identity", "notifications",
    "processes", "downloads", "alarms", "windows", "tabs", "tabGroups", "commands", "action", "scripting",
    "webNavigation", "permissions", "idle", "system", "storage", "runtime", "i18n", "management", "history",
    "bookmarks", "declarativeNetRequest", "webRequest", "search", "tts", "fontSettings"];
  const special = {
    storage: { sync: (t) => {
      try { return t.sync || t.local; } catch { return t.local; }
    } },
    runtime: {
      // Chromium: runtime.lastError is the ERROR OBJECT during a failing callback
      // and ABSENT otherwise. The wrap proxy fabricates a filler for absent
      // members, so without this accessor `if (chrome.runtime.lastError)` read
      // TRUTHY after every successful callback-form call.
      lastError: (t) => {
        try {
          return Object.prototype.hasOwnProperty.call(t, "lastError") ? t.lastError : undefined;
        } catch { return undefined; }
      },
    },
    identity: {
      getRedirectURL: () => redirectUrl,
      launchWebAuthFlow: () => launchWebAuthFlow,
    },
  };
  for (const name of names) {
    try {
      let present;
      try { present = c[name]; } catch { present = undefined; }
      c[name] = present ? wrap(present, special[name]) : stub(special[name]);
    } catch { /* a frozen namespace stays as it is */ }
  }
  try { Object.defineProperty(c, "__aitherCompat", { value: true }); } catch { /* fine */ }
}

const electron = require("electron");
const { contextBridge, ipcRenderer } = electron || {};

/** The one channel the desk serves (awconnect-webauth.cjs CHANNEL; a test pins them). */
const CHANNEL = "awconnect:identity:webauth";

/**
 * The shim's ONLY privileged handle. It lives in this isolated world (where ipcRenderer
 * exists) and is copied into the main world as a callable proxy by executeInMainWorld.
 * ipcRenderer.invoke rejections are unwrapped so the extension shows Chromium's own
 * wording instead of "Error invoking remote method '...': Error: ...".
 */
const isolatedBridge = ipcRenderer && typeof ipcRenderer.invoke === "function"
  ? {
    launchWebAuthFlow: async (details) => {
      try {
        return await ipcRenderer.invoke(CHANNEL, details);
      } catch (error) {
        const message = String((error && error.message) || error).replace(/^Error invoking remote method '[^']*':\s*(Error:\s*)?/, "");
        throw new Error(message, { cause: error });
      }
    },
  }
  : null;

if (contextBridge && typeof contextBridge.executeInMainWorld === "function") {
  try {
    contextBridge.executeInMainWorld({ func: compatShim, args: [isolatedBridge] });
  } catch {
    // An Electron that cannot copy the argument still gets the non-identity shim.
    try { contextBridge.executeInMainWorld({ func: compatShim, args: [] }); } catch { /* the extension starts as it would */ }
  }
}

if (typeof module !== "undefined" && module.exports) module.exports = { CHANNEL, compatShim };
