"use strict";

/**
 * Bridge for aither://explore (explore.html), injected by browser-internal-preload.cjs
 * (the `<stem>-preload.cjs` convention). Main answers only this page, and only the
 * operations in explore-window.cjs exploreOps -- `call` names one, it cannot add one.
 */

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("aitherExplore", {
  call: (op, ...args) => ipcRenderer.invoke("desk:explore-call", String(op ?? ""), ...args.slice(0, 3)),
});
