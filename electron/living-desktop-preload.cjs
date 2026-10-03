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

// The desk as an overlay HOST (2026-10-03, overlay-browser-host.cjs). Veil's
// overlay-host.ts only spoke to a FRAMING parent (awconnect's iframe); this window
// loads AitherOS Online top-level, so it marks the document and answers the same
// protocol on the page's own window. Only messages the page posts to ITSELF, from
// its own origin, are relayed; replies go back pinned to that origin.
function markHost() {
  if (document.documentElement) document.documentElement.setAttribute("data-aither-host", "desk");
}
markHost();
window.addEventListener("DOMContentLoaded", markHost);
window.addEventListener("load", markHost);

window.addEventListener("message", async (event) => {
  if (event.source !== window || event.origin !== window.location.origin) return;
  const data = event.data;
  if (!data || typeof data.__aither !== "string") return;
  const reply = (payload) => window.postMessage(payload, window.location.origin);
  if (data.__aither === "os→page") {
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
