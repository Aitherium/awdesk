"use strict";

/**
 * launch-modes — where an AitherOS Online app opens from the desk (owner, 2026-10-13:
 * "opening the sprite from the aitherbrowser lefthand sidebar opens the full screen
 * aitheros living desktop ... clicking academy does the same thing ... spaces launch
 * fullscreen ... we need to be able to configure this").
 *
 * Before this, every rail app row loaded `<online>/?spawn=<id>` (browser-window
 * openAgentApp) and every osApp command opened the AitherDesktop shell window
 * (living-desktop-window showDesktopApp), whose `?app=` hands off to the Living
 * Desktop at `/` -- so EVERY door booted the full desktop with the app on top.
 *
 *   tab      (default) the app alone in its own Aither Browser tab: <online>/solo?app=<id>
 *   window   the same page popped out into its own window
 *   desktop  the full AitherOS Living Desktop with the app as a window (the old way)
 *
 * Per app, persisted in browser-layout.json (browser-rail normalizeLayout) under
 * `launchModes`. The rail's mode chip cycles it. Pure: no electron here.
 */

const MODES = Object.freeze(["tab", "window", "desktop"]);
const DEFAULT_MODE = "tab";
const APP_ID = /^[a-z][a-z0-9-]{0,63}$/;
const MAX_ENTRIES = 200;

/** What each mode says on the chip and in its tooltip. */
const MODE_LABELS = Object.freeze({
  tab: Object.freeze({ glyph: "▭", hint: "Opens in a tab" }),
  window: Object.freeze({ glyph: "⧉", hint: "Opens in its own window" }),
  desktop: Object.freeze({ glyph: "⌂", hint: "Opens on the full AitherOS desktop" }),
});

function isMode(mode) {
  return MODES.includes(mode);
}

function isAppId(id) {
  return typeof id === "string" && APP_ID.test(id);
}

/** A sanitized {appId: mode} map; a default-mode entry is dropped (it is the default). */
function normalizeLaunchModes(raw) {
  const out = {};
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return out;
  for (const [id, mode] of Object.entries(raw)) {
    if (Object.keys(out).length >= MAX_ENTRIES) break;
    if (isAppId(id) && isMode(mode) && mode !== DEFAULT_MODE) out[id] = mode;
  }
  return out;
}

/** The mode an app opens in. */
function launchModeFor(modes, id) {
  const m = modes && Object.prototype.hasOwnProperty.call(modes, id) ? modes[id] : null;
  return isMode(m) ? m : DEFAULT_MODE;
}

/** The mode after `mode` on the chip: tab -> window -> desktop -> tab. */
function nextMode(mode) {
  const i = MODES.indexOf(mode);
  return MODES[(i + 1) % MODES.length];
}

/** `modes` with `id` set to `mode` (a new object), or null when either is invalid. */
function withMode(modes, id, mode) {
  if (!isAppId(id) || !isMode(mode)) return null;
  return normalizeLaunchModes({ ...(modes || {}), [id]: mode });
}

/** "<id>:<mode>" from the rail (the preload stringifies its argument). */
function parseModeArg(arg) {
  const m = /^([a-z][a-z0-9-]{0,63}):([a-z]+)$/.exec(String(arg || ""));
  return m && isMode(m[2]) ? { id: m[1], mode: m[2] } : null;
}

/**
 * The URL an app opens at. `tab`/`window`: the bare single-app route (Veil
 * app/(os)/solo; deep-link.ts soloAppHref). `desktop`: the Living Desktop with the
 * app spawned on it, exactly what the rail loaded before.
 */
function appUrl(onlineBase, id, mode) {
  if (!isAppId(id)) return null;
  let url;
  try { url = new URL(onlineBase); } catch { return null; }
  url.hash = "";
  if (mode === "desktop") {
    url.pathname = "/";
    url.search = `?spawn=${encodeURIComponent(id)}`;
  } else {
    url.pathname = "/solo";
    url.search = `?app=${encodeURIComponent(id)}`;
  }
  return url.href;
}

module.exports = {
  MODES, DEFAULT_MODE, MODE_LABELS, isMode, isAppId, normalizeLaunchModes, launchModeFor,
  nextMode, withMode, parseModeArg, appUrl,
};
