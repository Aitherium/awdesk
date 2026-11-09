"use strict";

/* global window, document */

/**
 * Bridge for the spirit (orb.html, all three views: orb, bubble, veil).
 * Owned by orb-window.cjs.
 *
 * The page can say WHERE the pointer is, that a press began/ended, which verb
 * it asks, what was dropped on it, and whether it is typing — nothing else.
 * Capture, the vision ladder, the queue, the probe and the clipboard all live
 * in main; the page never names a path, a model or a file (a dropped file's
 * PATH is read here with webUtils and handed to main, which applies the
 * credential refusal before anything opens it).
 */

const { contextBridge, ipcRenderer, webUtils } = require("electron");

function on(channel, fn) {
  const listener = (_event, payload) => {
    try { fn(payload); } catch { /* a page bug stays in the page */ }
  };
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

/** Turn a drop into what main can act on: real paths plus typed text. */
function droppedPayload(event) {
  const paths = [];
  const files = event && event.dataTransfer ? event.dataTransfer.files : null;
  for (const file of files || []) {
    try {
      const p = webUtils.getPathForFile(file);
      if (p) paths.push(String(p));
    } catch { /* a drag that is not a real file (a browser image) has no path */ }
  }
  let text;
  try { text = String(event.dataTransfer.getData("text/plain") || ""); } catch { text = ""; }
  if (text.length > 4000) text = text.slice(0, 4000);
  return { paths, text };
}

// Drop targets: the orb disc and the bubble card. A hover cue is CSS-only.
if (typeof window !== "undefined" && window.addEventListener) {
  window.addEventListener("dragover", (event) => {
    event.preventDefault();
    try { document.documentElement.classList.add("drop-hover"); } catch { /* no DOM */ }
  });
  window.addEventListener("dragleave", () => {
    try { document.documentElement.classList.remove("drop-hover"); } catch { /* no DOM */ }
  });
  window.addEventListener("drop", (event) => {
    event.preventDefault();
    try { document.documentElement.classList.remove("drop-hover"); } catch { /* no DOM */ }
    const payload = droppedPayload(event);
    if (!payload.paths.length && !payload.text.trim()) return;
    void ipcRenderer.invoke("desk:spirit-drop", payload);
  });
}

contextBridge.exposeInMainWorld("aitherOrb", {
  // existing ask-orb surface
  init: () => ipcRenderer.invoke("desk:orb-init"),
  hit: (inside) => ipcRenderer.invoke("desk:orb-hit", Boolean(inside)),
  dragStart: () => ipcRenderer.invoke("desk:orb-drag-start"),
  dragEnd: () => ipcRenderer.invoke("desk:orb-drag-end"),
  click: () => ipcRenderer.invoke("desk:orb-click"),
  // The BADGE is the needs-you door: one click opens the Inbox list (never
  // answers anything). Kept separate from `click` so the orb body keeps its
  // open/close meaning.
  needsYou: () => ipcRenderer.invoke("desk:orb-needs-you"),
  ask: (verb, text) => ipcRenderer.invoke("desk:orb-ask", String(verb || ""), String(text || "")),
  copy: (id) => ipcRenderer.invoke("desk:orb-copy", String(id || "")),
  pin: (id, pinned) => ipcRenderer.invoke("desk:orb-pin", String(id || ""), Boolean(pinned)),
  close: () => ipcRenderer.invoke("desk:orb-close"),
  hide: () => ipcRenderer.invoke("desk:orb-toggle"),
  state: (next) => ipcRenderer.invoke("desk:orb-state", { drafting: Boolean(next && next.drafting) }),
  onLine: (fn) => on("orb:line", fn),
  onBadge: (fn) => on("orb:badge", fn),
  onBusy: (fn) => on("orb:busy", fn),
  onQueue: (fn) => on("orb:queue", fn),
  onFocus: (fn) => on("orb:focus", fn),

  // spirit: attach, trips, holds, results, right-click, drag-out
  menu: () => ipcRenderer.invoke("desk:spirit-menu"),
  pick: (index, action) => ipcRenderer.invoke("desk:spirit-pick", Number(index) || 0, String(action || "hold")),
  holdAction: (action) => ipcRenderer.invoke("desk:spirit-hold", String(action || "")),
  dragHold: () => ipcRenderer.invoke("desk:spirit-drag-hold"),
  cancelTrip: () => ipcRenderer.invoke("desk:spirit-cancel"),
  home: () => ipcRenderer.invoke("desk:spirit-home"),
  attach: () => ipcRenderer.invoke("desk:spirit-attach"),
  mode: (mode) => ipcRenderer.invoke("desk:spirit-mode", mode ? String(mode) : ""),
  onHold: (fn) => on("orb:hold", fn),
  onResults: (fn) => on("orb:results", fn),
  onTrips: (fn) => on("orb:trips", fn),
  onTint: (fn) => on("orb:tint", fn),
  onDepth: (fn) => on("orb:depth", fn),
  onAttach: (fn) => on("orb:attach", fn),
  onMode: (fn) => on("orb:mode", fn),
  onVeil: (fn) => on("orb:veil", fn),
  // the owner's AitherSprite the fairy wears ({name, stage, mood, line, tooltip, tint} | null)
  onSprite: (fn) => on("orb:sprite", fn),
  // attention (fairy-attention.cjs): the whisper's buttons and the fairy's nudge level.
  nudgeAct: (action, key) => ipcRenderer.invoke("desk:nudge-act", String(action || ""),
    typeof key === "boolean" ? key : String(key == null ? "" : key)),
  onNudge: (fn) => on("orb:nudge", fn),
  onNudgeView: (fn) => on("orb:nudge-view", fn),
  onNudgeFlash: (fn) => on("orb:nudge-flash", fn),
  // The agent fairy (agent-fairy.cjs): whose colours the fairy wears, the
  // companions orbiting it, and a hover on one of them (shows that agent's card).
  onFairy: (fn) => on("orb:fairy", fn),
  onCompanions: (fn) => on("orb:companions", fn),
  peek: (id) => ipcRenderer.invoke("desk:orb-peek", String(id || "")),
});
