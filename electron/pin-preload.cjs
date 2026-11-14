"use strict";

/**
 * pin-preload.cjs -- the bridge for a desktop pin's CONTROLS page (pin.html),
 * owned by pins-window.cjs. Embedded web content (a page, a YouTube embed) runs
 * in a separate WebContentsView with no preload at all; this bridge never
 * reaches it. Only the pin's own switches cross here -- no paths, no tokens.
 */

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("aitherPin", {
  init: () => ipcRenderer.invoke("pin:init"),
  set: (patch) => ipcRenderer.invoke("pin:set", patch && typeof patch === "object" ? {
    ...(patch.opacity !== undefined ? { opacity: Number(patch.opacity) } : {}),
    ...(patch.locked !== undefined ? { locked: Boolean(patch.locked) } : {}),
    ...(patch.onTop !== undefined ? { onTop: Boolean(patch.onTop) } : {}),
    ...(patch.muted !== undefined ? { muted: Boolean(patch.muted) } : {}),
    ...(patch.title !== undefined ? { title: String(patch.title) } : {}),
    ...(patch.src !== undefined ? { src: String(patch.src) } : {}),
    ...(patch.color !== undefined ? { color: String(patch.color).slice(0, 9) } : {}),
  } : {}),
  /** A note: file it into Notes in the workspace it was written in. */
  send: () => ipcRenderer.invoke("pin:send"),
  close: () => ipcRenderer.invoke("pin:close"),
  hide: () => ipcRenderer.invoke("pin:hide"),
  hoverChrome: (over) => ipcRenderer.invoke("pin:hover-chrome", Boolean(over)),
  launch: () => ipcRenderer.invoke("pin:launch"),
  openInBrowser: () => ipcRenderer.invoke("pin:open-in-browser"),
  reload: () => ipcRenderer.invoke("pin:reload"),
  /** Middle-drag in SCREEN coordinates: main moves (Shift resizes, Ctrl duplicates) the window. */
  grabStart: (p) => ipcRenderer.invoke("pin:grab-start", {
    x: Number(p && p.x) || 0, y: Number(p && p.y) || 0,
    shift: Boolean(p && p.shift), ctrl: Boolean(p && p.ctrl), meta: Boolean(p && p.meta) }),
  grabMove: (p) => ipcRenderer.invoke("pin:grab-move", { x: Number(p && p.x) || 0, y: Number(p && p.y) || 0 }),
  grabEnd: () => ipcRenderer.invoke("pin:grab-end"),
  onState: (fn) => {
    const listener = (_event, state) => { try { fn(state); } catch { /* page bug stays in the page */ } };
    ipcRenderer.on("pin:state", listener);
    return () => ipcRenderer.removeListener("pin:state", listener);
  },
});
