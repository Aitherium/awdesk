"use strict";

/**
 * Bridge for the screen recorder's three pages, all owned by recorder-window.cjs:
 *   snip.html                 the snipping tool's region overlay, REUSED unchanged:
 *                             `aitherSnip` here speaks the same API snip-preload.cjs
 *                             exposes, routed to recorder:region-* channels.
 *   recorder.html?view=bar    the control bar that records (MediaRecorder).
 *   recorder.html?view=toast  the saved-recording toast.
 * Nothing here sees a token or a full path; the recording bytes go one way, out.
 */

const { contextBridge, ipcRenderer } = require("electron");

function rect(r) {
  return { x: Number(r && r.x), y: Number(r && r.y), width: Number(r && r.width), height: Number(r && r.height) };
}

function subscribe(channel, fn) {
  const listener = (_event, value) => { try { fn(value); } catch { /* page bug stays in the page */ } };
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

// The overlay page is the snipping tool's; only its hint line says "snip".
globalThis.addEventListener("DOMContentLoaded", () => {
  const hint = globalThis.document.getElementById("hint");
  if (hint && /snip/i.test(hint.textContent || "")) {
    hint.textContent = "Drag a region to record · Enter or double-click for the whole screen · Esc to cancel";
  }
});

contextBridge.exposeInMainWorld("aitherSnip", {
  frame: () => ipcRenderer.invoke("recorder:region-frame"),
  select: (r) => ipcRenderer.invoke("recorder:region-select", rect(r)),
  full: () => ipcRenderer.invoke("recorder:region-full"),
  cancel: () => ipcRenderer.invoke("recorder:region-cancel"),
});

contextBridge.exposeInMainWorld("aitherRecorder", {
  plan: () => ipcRenderer.invoke("recorder:plan"),
  streamSize: (size) => ipcRenderer.invoke("recorder:stream-size",
    { width: Number(size && size.width), height: Number(size && size.height) }),
  chunk: (bytes) => ipcRenderer.invoke("recorder:chunk", bytes),
  state: (state) => ipcRenderer.invoke("recorder:state", String(state || "")),
  done: () => ipcRenderer.invoke("recorder:done"),
  failed: (reason) => ipcRenderer.invoke("recorder:failed", String(reason || "")),
  onCommand: (fn) => subscribe("recorder:command", fn),
  toastInfo: () => ipcRenderer.invoke("recorder:toast-info"),
  toastAction: (action) => ipcRenderer.invoke("recorder:toast-action", String(action || "")),
  onToastUpdate: (fn) => subscribe("recorder:toast-update", fn),
});
