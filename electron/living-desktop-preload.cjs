"use strict";

/** Preload for the Aitheros Online overlay window.
 *
 *  The Aitheros Online shell in `?mode=overlay` publishes its interactive hit-rects every
 *  ~60ms as `postMessage({ __aither: 'os-regions', regions, dock }, '*')` to its parent
 *  (Veil `src/components/os/os-client.tsx` — the same protocol AitherConnect's browser
 *  overlay consumes to clip its iframe). Loaded TOP-LEVEL here, `window.parent` IS the
 *  window, so the page posts to itself and this listener receives it. We forward the
 *  rects to the main process, which flips `setIgnoreMouseEvents` per cursor position —
 *  that is what makes the real Windows desktop clickable THROUGH the overlay everywhere
 *  Aitheros Online isn.t drawing a window/dock. */

const { ipcRenderer } = require("electron");

window.addEventListener("message", (event) => {
  const data = event && event.data;
  if (!data || data.__aither !== "os-regions") return;
  ipcRenderer.send("living-desktop:regions", {
    regions: Array.isArray(data.regions) ? data.regions : [],
    dock: data.dock && typeof data.dock === "object" ? data.dock : null,
  });
});

// Desk -> Aitheros Online state channel (2026-08-25): main pushes the Desk snapshot
// (decision cards, avatar slots, agents, relay feed) and this forwards it into the
// page as a postMessage the Veil shell can listen for — the same family as the
// os-regions protocol above, so the shell treats the overlay as a connected host
// rather than a dumb window.
ipcRenderer.on("living-desktop:desk-state", (_event, payload) => {
  window.postMessage(Object.assign({ __aither: "desk-state" }, payload), "*");
});

// Desk -> Aitheros Online OS focus (2026-10-06): "attention left the overlay"
// (the window blurred -- another app or the bare Windows desktop has focus) and
// its return. Same shape as the channels above; the Veil shell answers it with
// the Stage Manager collapse / restore (overlay-host.ts subscribeHostFocus).
// Anything but an explicit false reads as focused: a garbled send never hides windows.
ipcRenderer.on("living-desktop:host-focus", (_event, focused) => {
  window.postMessage({ __aither: "os-host-focus", focused: focused !== false }, "*");
});

// The desk as an overlay HOST (2026-10-03, overlay-browser-host.cjs). Veil's
// overlay-host.ts only spoke to a FRAMING parent (awconnect's iframe); this window
// loads AitherOS Online top-level, so it marks the document and answers the same
// protocol on the page's own window. Only messages the page posts to ITSELF, from
// its own origin, are relayed; replies go back pinned to that origin.
//
// ONE taskbar owner per context (2026-10-09, browser-taskbar.cjs stripOwner). Only the
// HOSTED BROWSER TAB -- the pinned Online tab, launched with DESK_TAB_ARG by
// browser-internal.cjs withDeskHost -- is also marked data-host="desk": the browser's
// strip owns the taskbar there, so Veil drops its dock. The desktop overlay window
// (Ctrl+Shift+D) loads this preload WITHOUT the argument and keeps its dock. The session
// key is what Veil's markHostChrome re-reads after hydration strips the attribute;
// browser-window.cjs clears both if the strip is switched off.
const DESK_TAB_ARG = "--aither-desk-surface=browser-tab";
const browserTab = typeof process === "object" && process && Array.isArray(process.argv)
  && process.argv.includes(DESK_TAB_ARG);
function markHost() {
  const d = document.documentElement;
  if (!d) return;
  d.setAttribute("data-aither-host", "desk");
  if (!browserTab) return;
  let ours = true;
  try {
    const stored = sessionStorage.getItem("aither-host");
    if (stored === null) sessionStorage.setItem("aither-host", "desk");
    else ours = stored === "desk"; // main cleared it (strip off) or another host owns it
  } catch { /* storage blocked: the attribute still holds this document */ }
  if (ours) d.setAttribute("data-host", "desk");
}
markHost();

// aither-host/1 (aither-host-protocol.json beside this file; the same bytes as Veil's
// and awconnect's copies). The OS says os-hello; the desk answers host-hello with the
// planes it serves and who draws the taskbar: the browser's strip in the hosted tab
// (DESK_TAB_ARG), the OS's own dock in the desktop overlay window. Kept inline: a
// sandboxed preload cannot require a local file. host-protocol.test.cjs pins it.
const HOST_PROTOCOL = "aither-host/1";
const DESK_PLANES = Object.freeze(["regions", "page", "context", "focus", "desk"]);
function hostHello() {
  return { __aither: "host-hello", protocol: HOST_PROTOCOL, host: "desk", planes: DESK_PLANES.slice(),
    chrome: { taskbar: browserTab ? "host" : "os" } };
}
window.addEventListener("DOMContentLoaded", markHost);
window.addEventListener("load", markHost);

window.addEventListener("message", async (event) => {
  if (event.source !== window || event.origin !== window.location.origin) return;
  const data = event.data;
  if (!data || typeof data.__aither !== "string") return;
  const reply = (payload) => window.postMessage(payload, window.location.origin);
  if (data.__aither === "os-hello") {
    reply(hostHello());
  } else if (data.__aither === "os→page") {
    const result = await ipcRenderer.invoke("living-desktop:host-page", {
      action: data.action, selector: data.selector, text: data.text, key: data.key,
    }).catch((error) => ({ ok: false, error: String((error && error.message) || error) }));
    reply(Object.assign({}, result, { __aither: "page→os", reqId: data.reqId }));
  } else if (data.__aither === "os-page-context-request") {
    const context = await ipcRenderer.invoke("living-desktop:host-context").catch(() => null);
    if (context) reply({ __aither: "os-page-context", context });
  } else if (data.__aither === "desk-command") {
    // A HUMAN click only. "Let the agent continue" lifts the owner's pause, so a
    // page script must not be able to send it on its own: the page's transient
    // user activation is set only by a real click or key press, moments ago.
    const activation = navigator.userActivation;
    if (!activation || !activation.isActive) return;
    ipcRenderer.send("living-desktop:desk-command", String(data.id || ""));
  }
});
