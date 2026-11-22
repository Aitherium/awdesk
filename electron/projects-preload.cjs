"use strict";

/**
 * Bridge for aither://projects (projects.html), injected by browser-internal-preload.cjs
 * (the `<stem>-preload.cjs` convention) and console-preload.cjs. Read-first: list, add,
 * remove a folder, read its state and its PR. Main answers only this page.
 */

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("aitherProjects", {
  list: () => ipcRenderer.invoke("desk:projects-list"),
  add: (dir) => ipcRenderer.invoke("desk:projects-add", String(dir ?? "")),
  remove: (dir) => ipcRenderer.invoke("desk:projects-remove", String(dir ?? "")),
  state: (dir) => ipcRenderer.invoke("desk:projects-state", String(dir ?? "")),
  pr: (dir, n) => ipcRenderer.invoke("desk:projects-pr", String(dir ?? ""), Number(n)),
});
