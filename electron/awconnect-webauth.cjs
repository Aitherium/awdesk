"use strict";

/**
 * awconnect-webauth.cjs -- chrome.identity for the extensions the Aither Browser loads
 * (browser-extensions.cjs -> awconnect-compat-preload.cjs).
 *
 * Electron gives an extension no identity API, so the compat shim used to stub it:
 * getRedirectURL() resolved a Promise<undefined> and launchWebAuthFlow() resolved
 * undefined, and awconnect's OIDC flow died in parseRedirect() with "sign-in window
 * closed" (measured 2026-10-06 in a desk-faithful BrowserWindow + loadAwconnect +
 * withCompat). This module is the real thing for the desk: it owns the auth window, the
 * callback interception and the single-flow lock, and answers the shim over ONE channel.
 *
 * Facts measured 2026-10-06 (Electron 39.8.10, this repo):
 *   - a server 302 to https://<id>.chromiumapp.org/?code=... arrives as `will-redirect`
 *     carrying the FULL target URL, and event.preventDefault() cancels it before any
 *     network request to chromiumapp.org (the host is never resolved).
 *   - after preventDefault the original loadURL() rejects ERR_FAILED (-2) and NO
 *     did-fail-load fires; the flow settles from the interception, never from loadURL.
 *   - a sandboxed SERVICE-WORKER preload gets ipcRenderer, but its invokes land on
 *     ServiceWorkerMain.ipc.handle(worker) and NOT on ipcMain -- so the channel is served
 *     twice: ipcMain for extension pages, worker.ipc for the MV3 background worker.
 *   - getWorkerFromVersionID() alone does not materialise the worker;
 *     startWorkerForScope() does, and returns the already-running one.
 *   - `setTimeout` does not exist in the service-worker preload's world -- every timer
 *     lives here, in the main process.
 *   - chrome.runtime.id and location.host both read as the extension id in the page AND
 *     in the worker main world; the shim derives the id there, this module re-derives it
 *     from the SENDER and never trusts a payload.
 *
 * Error texts follow Chromium's identity API so awconnect's own messages stay familiar
 * ("The user did not approve access.", "Authorization page could not be loaded.").
 */

/** The one channel(awconnect-compat-preload.cjs CHANNEL; a test pins the two together). */
const CHANNEL = "awconnect:identity:webauth";
/** Chromium extension ids: exactly 32 letters a-p. */
const EXTENSION_ID = /^[a-p]{32}$/;
/** Chrome hands the callback back on https://<id>.chromiumapp.org/; so do we. */
const CALLBACK_SUFFIX = ".chromiumapp.org";
/** Chromium's own budget for an interactive auth flow. */
const DEFAULT_TIMEOUT_MS = 900000;

const MESSAGES = {
  singleFlow: "Only one web auth flow is allowed at a time.",
  userClosed: "The user did not approve access.",
  loadFailed: "Authorization page could not be loaded.",
  timedOut: "Timed out waiting for the authorization response.",
  badUrl: "The URL must be a valid http or https URL.",
  notExtension: "The web auth flow is only available to one of this browser's extensions.",
};

/** https://<id>.chromiumapp.org/ for a well-formed id, else null. */
function redirectBase(id) {
  return EXTENSION_ID.test(String(id || "")) ? `https://${id}${CALLBACK_SUFFIX}/` : null;
}

/** Is `url` a redirect back to THIS extension's own callback host? */
function isCallbackUrl(id, url) {
  const base = redirectBase(id);
  return Boolean(base && typeof url === "string" && url.startsWith(base));
}

/** The extension id in a chrome-extension: URL (a page or a service worker scope), else "". */
function extensionIdFromUrl(url) {
  try {
    const parsed = new URL(String(url || ""));
    return parsed.protocol === "chrome-extension:" && EXTENSION_ID.test(parsed.hostname) ? parsed.hostname : "";
  } catch {
    return "";
  }
}

/** The extension behind a SENDER url, only if `getExtension` says it is loaded, else "". */
function senderExtension(url, getExtension) {
  const id = extensionIdFromUrl(url);
  if (!id) return "";
  try {
    return getExtension(id) ? id : "";
  } catch {
    return "";
  }
}

/**
 * One flow at a time, like Chromium. `BrowserWindow` is injected so the whole machine
 * is testable without Electron (the desk's style: pure decisions here, the one Electron
 * call injected); install() passes the real one.
 */
function createWebAuthFlows({ BrowserWindow, timeoutMs = DEFAULT_TIMEOUT_MS, setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
  let active = null;

  /**
   * Open the auth window on `session` and resolve with the first navigation to
   * https://<id>.chromiumapp.org/... . Always settles, never throws.
   */
  function run({ session, id, url, interactive = true } = {}) {
    const base = redirectBase(id);
    if (active) return Promise.reject(new Error(MESSAGES.singleFlow));
    if (!base) return Promise.reject(new Error(MESSAGES.badUrl));
    let parsed = null;
    try {
      parsed = new URL(String(url || ""));
    } catch {
      parsed = null;
    }
    if (!parsed || (parsed.protocol !== "https:" && parsed.protocol !== "http:")) {
      return Promise.reject(new Error(MESSAGES.badUrl));
    }
    if (typeof BrowserWindow !== "function" || !session) {
      return Promise.reject(new Error(MESSAGES.loadFailed));
    }
    return new Promise((resolve, reject) => {
      let settled = false;
      const flow = { win: null, timer: null };
      active = flow;
      const settle = (error, value) => {
        if (settled) return;
        settled = true;
        if (active === flow) active = null;
        if (flow.timer !== null) clearTimer(flow.timer);
        if (flow.win && !flow.win.isDestroyed()) {
          try { flow.win.destroy(); } catch { /* already gone */ }
        }
        if (error) reject(error); else resolve(value);
      };
      let win;
      try {
        win = new BrowserWindow({
          width: 600,
          height: 720,
          // A silent re-auth (interactive:false, prompt=none) never takes focus, as in
          // Chromium; an interactive one is a real window the owner approves in.
          show: interactive !== false,
          autoHideMenuBar: true,
          title: "Sign in",
          webPreferences: {
            session,
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: true,
            webSecurity: true,
            allowRunningInsecureContent: false,
          },
        });
      } catch {
        settle(new Error(MESSAGES.loadFailed));
        return;
      }
      flow.win = win;
      flow.timer = setTimer(() => settle(new Error(MESSAGES.timedOut)), timeoutMs);
      const wc = win.webContents;
      // The measured IdP flow arrives as a server redirect: catch it here and cancel
      // before chromiumapp.org is ever contacted.
      wc.on("will-redirect", (event, target, _inPlace, isMainFrame) => {
        if (isMainFrame === false || !isCallbackUrl(id, target)) return;
        event.preventDefault();
        settle(null, target);
      });
      // A page that sends ITSELF there: location.href, a link, a meta refresh.
      wc.on("will-navigate", (event, target) => {
        if (!isCallbackUrl(id, target)) return;
        event.preventDefault();
        settle(null, target);
      });
      // Backstop: committed anyway -- still the answer the flow was waiting for.
      wc.on("did-navigate", (_event, target) => {
        if (isCallbackUrl(id, target)) settle(null, target);
      });
      wc.on("did-fail-load", (_event, code, _description, target, isMainFrame) => {
        if (isMainFrame === false) return;
        if (code === -3) return; // ERR_ABORTED: a cancelled navigation, not a failure
        if (isCallbackUrl(id, target)) settle(null, target);
        else settle(new Error(MESSAGES.loadFailed));
      });
      wc.on("render-process-gone", () => settle(new Error(MESSAGES.loadFailed)));
      win.on("closed", () => settle(new Error(MESSAGES.userClosed)));
      // loadURL() rejects on a prevented redirect (measured -2) and on a real failure;
      // either way did-fail-load or the interception has settled, or the timer will.
      void win.loadURL(parsed.href).catch(() => { /* settled elsewhere */ });
    });
  }

  return { run, busy: () => Boolean(active) };
}

const installedSessions = new WeakSet();
/** Electron refuses a second `handle` on one channel, so the frame handler is per-ipcMain. */
const handlerIpcMains = new WeakSet();

/**
 * Wire the channel for one browser session. Idempotent per session; must run before the
 * browser window opens (the extension's worker can ask at any moment).
 *
 * @returns {{ ok: true, flows } | { ok: false, error: string }}
 */
function install({ ipcMain, session, BrowserWindow = null, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  if (!ipcMain || typeof ipcMain.handle !== "function" || !session) {
    return { ok: false, error: "install needs an ipcMain and the browser's session" };
  }
  if (installedSessions.has(session)) return { ok: true, flows: null };
  installedSessions.add(session);
  const BW = BrowserWindow || require("electron").BrowserWindow;
  const flows = createWebAuthFlows({ BrowserWindow: BW, timeoutMs });
  const runFor = (id, ses, payload) => flows.run({
    session: ses,
    id,
    url: payload && payload.url,
    interactive: !(payload && payload.interactive === false),
  });

  // Extension pages (side panel, options): a frame's ipcRenderer.invoke lands here.
  // Registered ONCE per ipcMain -- Electron throws on a second handle for a channel --
  // and the desk has one browser session, so the first install's lock is the app's.
  if (!handlerIpcMains.has(ipcMain)) {
    handlerIpcMains.add(ipcMain);
    ipcMain.handle(CHANNEL, (event, payload) => {
      const frame = event && event.senderFrame;
      const wc = event && event.sender;
      const frameUrl = (frame && frame.url) || (wc && typeof wc.getURL === "function" ? wc.getURL() : "");
      const ses = (wc && wc.session) || null;
      const api = ses && (ses.extensions || ses);
      const id = ses ? senderExtension(frameUrl, (x) => api && typeof api.getExtension === "function" && api.getExtension(x)) : "";
      if (!id) return Promise.reject(new Error(MESSAGES.notExtension));
      return runFor(id, ses, payload);
    });
  }

  // The MV3 background worker: its invokes land on the worker's OWN ipc (measured), so
  // each worker gets the handler as it starts, and again after every restart.
  const workers = session.serviceWorkers;
  if (workers && typeof workers.on === "function") {
    const hooked = new WeakSet();
    const hookWorker = (worker) => {
      if (!worker || hooked.has(worker)) return false;
      const id = extensionIdFromUrl(worker.scope || "");
      if (!id) return false; // only an extension's own worker may ask
      hooked.add(worker);
      try {
        worker.ipc.handle(CHANNEL, (event, payload) =>
          runFor(id, (event && event.session) || session, payload));
        return true;
      } catch {
        return false;
      }
    };
    const hookRunning = () => {
      let infos;
      try { infos = workers.getAllRunning() || {}; } catch { return; }
      for (const info of Object.values(infos)) {
        try { hookWorker(workers.getWorkerFromVersionID(info && info.versionId)); } catch { /* not materialised yet */ }
      }
    };
    // startWorkerForScope() is what actually hands back the worker object; it returns the
    // running worker unchanged, and wakes it when it is not up (measured -- a first call
    // can fail while the worker starts, so one retry).
    const wakeExtensionWorker = (scope) => {
      if (!extensionIdFromUrl(scope)) return;
      const attempt = (retries) => {
        Promise.resolve()
          .then(() => workers.startWorkerForScope(scope))
          .then((worker) => hookWorker(worker))
          .catch(() => {
            if (retries > 0) setTimerOnce(() => attempt(retries - 1), 500);
          });
      };
      attempt(2);
    };
    workers.on("registration-completed", (_event, details) => {
      wakeExtensionWorker(details && details.scope);
      hookRunning();
    });
    workers.on("running-status-changed", (details) => {
      const versionId = details && details.versionId;
      let worker;
      try { worker = workers.getWorkerFromVersionID(versionId); } catch { worker = undefined; }
      if (hookWorker(worker)) return;
      // An idle-terminated worker restarts without a new registration, and
      // getWorkerFromVersionID does not always materialise the wrapper (measured);
      // the scope from the status event hands the same worker back instead.
      if (!details || details.runningStatus !== "running") return;
      try { wakeExtensionWorker(workers.getInfoFromVersionID(versionId).scope); } catch { /* gone again */ }
    });
    hookRunning();
  }
  return { ok: true, flows };
}

/** A one-shot timer that never keeps the process alive; used for the worker wake retry. */
function setTimerOnce(fn, ms) {
  const timer = setTimeout(fn, ms);
  if (timer && typeof timer.unref === "function") timer.unref();
  return timer;
}

module.exports = {
  CHANNEL,
  DEFAULT_TIMEOUT_MS,
  MESSAGES,
  createWebAuthFlows,
  extensionIdFromUrl,
  install,
  isCallbackUrl,
  redirectBase,
  senderExtension,
};
