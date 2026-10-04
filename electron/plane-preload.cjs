"use strict";

/**
 * Bridge for the plane pages (plane-<id>.html), injected by console-preload.cjs
 * inside the console and used directly by the detached window (plane-window.cjs).
 *
 * Read-only: one snapshot verb per plane. Every call answers {ok, data|error}.
 */

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("aitherPlane", {
  planes: () => ipcRenderer.invoke("desk:plane-list"),
  snapshot: (planeId) => ipcRenderer.invoke("desk:plane-snapshot", String(planeId || "")),
});
