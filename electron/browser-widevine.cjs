"use strict";

/**
 * browser-widevine.cjs -- protected video and music (Netflix, Spotify, Disney+) in the
 * Aither Browser.
 *
 * Owner, 2026-11-13: "and fix electron". Stock Electron ships no Widevine CDM, so DRM
 * players stayed black and the browser sent the owner to Edge. The desk now builds on
 * castLabs' Electron for Content Security (same Electron, plus a component updater that
 * installs Google's Widevine CDM into userData). That build adds one API, `components`:
 * whenReady() installs the CDM, status() reports it.
 *
 * This module is the only place that touches `components`, and it is guarded: on stock
 * Electron `components` is undefined, the state is "missing", nothing throws, and the
 * "Open in Edge" notice stays as the fallback.
 *
 * Pure parts (tested without Electron): the status mapping, the more-menu label and the
 * notice decision. createWidevine() holds the one install promise.
 *
 * What an unsigned build plays is limited: see docs/WIDEVINE.md (VMP signing).
 */

/** Chromium's component id of the Widevine CDM (castLabs exposes it as WIDEVINE_CDM_ID). */
const WIDEVINE_CDM_ID = "oimompecagnajdejgnnjijobebaeigek";

/** Component-updater statuses that mean "installed and usable". */
const USABLE = new Set(["updated", "up-to-date"]);

/**
 * One fact sheet from what Electron reports.
 *   hasApi   this binary has the `components` API (castLabs build)
 *   phase    "idle" | "installing" | "ready" | "failed" (the install promise)
 *   record   components.status() (keyed by component id), or null
 *   error    why the install failed
 * state: "missing" (stock Electron) | "installing" | "ready" | "failed".
 */
function widevineSnapshot({ hasApi = false, phase = "idle", record = null, error = "", cdmId = WIDEVINE_CDM_ID } = {}) {
  if (!hasApi) return { state: "missing", build: "stock", version: null, status: null, error: "" };
  const entry = (record && typeof record === "object" && record[cdmId]) || null;
  const version = entry && entry.version ? String(entry.version) : null;
  const status = entry && entry.status ? String(entry.status) : null;
  let state;
  if (phase === "failed") state = "failed";
  else if (phase === "ready") state = version ? "ready" : "failed";
  else if (version && USABLE.has(status)) state = "ready"; // installed on an earlier run
  else state = "installing";
  return {
    state, build: "castlabs", version, status,
    error: state === "failed" ? String(error || "the Widevine component did not install") : "",
  };
}

/** The more-menu line. Always one short sentence the owner can act on. */
function widevineMenuLabel(snap) {
  const s = snap || {};
  if (s.state === "ready") return `Protected video and music: on (Widevine ${s.version})`;
  if (s.state === "installing") return "Protected video and music: installing Widevine…";
  if (s.state === "failed") return "Protected video and music: Widevine did not install (click to retry)";
  return "Protected video and music: not in this build (opens in Edge)";
}

/**
 * Which notice a page gets, or null for none.
 *   needsDrm  the URL is a known DRM site
 *   tabBy     "you" | "agent": only the owner's tabs are offered anything
 *   snap      widevineSnapshot()
 *   hasEdge   Edge is installed (the fallback exists)
 *   stayed    the owner already chose "Stay here" for this host
 * Ready -> no notice: the page just plays. Installing -> a wait line (the wiring reloads
 * the page once when the install settles). Missing or failed -> the Edge hand-off, when
 * there is one.
 */
function drmNotice({ needsDrm = false, tabBy = "", snap = null, hasEdge = false, stayed = false, url = "", host = "" } = {}) {
  if (!needsDrm || tabBy !== "you") return null;
  const state = (snap && snap.state) || "missing";
  if (state === "ready") return null;
  if (state === "installing") {
    return {
      kind: "drm-wait", data: { url, host }, keep: false,
      text: "Getting protected playback ready (Widevine is installing). This takes a few seconds the first time.",
      actions: [],
    };
  }
  if (!hasEdge || stayed) return null;
  const why = state === "failed"
    ? "Protected playback (Widevine) did not install, so this site's video or music will not play here."
    : "This site plays protected video or music (DRM), which this build cannot play.";
  return {
    kind: "drm", data: { url, host },
    text: `${why} Watch it in Edge?`,
    actions: [{ id: "open-edge", label: "Open in Edge" }, { id: "drm-stay", label: "Stay here" }],
  };
}

/**
 * The live holder. `components` is Electron's (undefined on stock builds). ensure()
 * starts the install once and never rejects; snapshot() is cheap and synchronous.
 */
function createWidevine({ components, timeoutMs = 45000, log = () => {} } = {}) {
  const hasApi = Boolean(components && typeof components.whenReady === "function" && typeof components.status === "function");
  const cdmId = (hasApi && components.WIDEVINE_CDM_ID) || WIDEVINE_CDM_ID;
  let phase = "idle";
  let error = "";
  let pending = null;

  function snapshot() {
    let record = null;
    if (hasApi) { try { record = components.status(); } catch { record = null; } }
    return widevineSnapshot({ hasApi, phase, record, error, cdmId });
  }

  function ensure({ retry = false } = {}) {
    if (!hasApi) return Promise.resolve(snapshot());
    if (pending && !(retry && phase === "failed")) return pending;
    phase = "installing";
    error = "";
    let timer = null;
    const timeout = new Promise((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error(`Widevine was not ready after ${Math.round(timeoutMs / 1000)} s`)), timeoutMs);
      if (typeof timer.unref === "function") timer.unref();
    });
    // Only the Widevine CDM is required: the Media Foundation CDM is Windows-only extra.
    pending = Promise.race([Promise.resolve().then(() => components.whenReady([cdmId])), timeout])
      .then(() => { phase = "ready"; })
      .catch((e) => {
        phase = "failed";
        const parts = Array.isArray(e && e.errors) ? e.errors.map((x) => (x && x.message) || String(x)) : [];
        error = [String((e && e.message) || e), ...parts].filter(Boolean).join("; ");
        log(`widevine: ${error}`);
      })
      .then(() => { clearTimeout(timer); return snapshot(); });
    return pending;
  }

  return { hasApi, ensure, snapshot };
}

let shared = null;
/** The desk's one holder, built on first use from the running Electron. */
function getWidevine() {
  if (!shared) {
    let components;
    try { components = require("electron").components; } catch { components = undefined; }
    shared = createWidevine({ components, log: (m) => console.warn(`[browser] ${m}`) });
  }
  return shared;
}

module.exports = {
  WIDEVINE_CDM_ID,
  createWidevine, drmNotice, getWidevine, widevineMenuLabel, widevineSnapshot,
};
