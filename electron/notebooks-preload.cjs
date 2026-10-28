"use strict";

/**
 * Bridge for aither://notebooks (notebooks.html), injected by browser-internal-preload.cjs
 * (the `<stem>-preload.cjs` convention). Main answers only this page.
 */

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("aitherNotebooks", {
  list: (opts) => ipcRenderer.invoke("desk:notebooks-list", { localOnly: Boolean(opts && opts.localOnly) }),
  outline: (id) => ipcRenderer.invoke("desk:notebooks-outline", String(id ?? "")),
  replay: (id, opts) => ipcRenderer.invoke("desk:notebooks-replay", String(id ?? ""),
    { allowSideEffects: Boolean(opts && opts.allowSideEffects) }),
  exportTo: (id) => ipcRenderer.invoke("desk:notebooks-export", String(id ?? "")),
  view: (id) => ipcRenderer.invoke("desk:notebooks-view", String(id ?? "")),
  transcript: (logPath) => ipcRenderer.invoke("desk:notebooks-transcript", String(logPath ?? "")),
});
