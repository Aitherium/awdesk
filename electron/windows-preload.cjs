"use strict";

/** Bridge for aither://windows (windows.html). Main answers only this page (windows-window.cjs). */
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("aitherWindows", {
  state: () => ipcRenderer.invoke("desk:windows-state"),
  move: (key, displayId) => ipcRenderer.invoke("desk:windows-move", String(key ?? ""), Number(displayId)),
  show: (key) => ipcRenderer.invoke("desk:windows-show", String(key ?? "")),
  hide: (key) => ipcRenderer.invoke("desk:windows-hide", String(key ?? "")),
  onTop: (key, on) => ipcRenderer.invoke("desk:windows-ontop", String(key ?? ""), Boolean(on)),
  save: (name) => ipcRenderer.invoke("desk:windows-save", String(name ?? "")),
  restore: (name) => ipcRenderer.invoke("desk:windows-restore", String(name ?? "")),
  remove: (name) => ipcRenderer.invoke("desk:windows-remove", String(name ?? "")),
});
