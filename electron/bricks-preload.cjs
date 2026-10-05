"use strict";

/**
 * Bridge for aither://bricks (bricks.html): the awkno catalog and pages (bricks-window.cjs),
 * plus the desk's existing installed-bricks list and upgrade/test/rollback (bricks-client.cjs,
 * the same channels Settings > Updates uses).
 */
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("aitherBricks", {
  list: () => ipcRenderer.invoke("desk:brickcat-list"),
  page: (name) => ipcRenderer.invoke("desk:brickcat-page", String(name ?? "")),
  installed: () => ipcRenderer.invoke("desk:bricks-list"),
  skills: () => ipcRenderer.invoke("desk:skills-list"),
  packs: () => ipcRenderer.invoke("desk:packs-list"),
  packAct: (verb, id) => ipcRenderer.invoke("desk:packs-act", String(verb ?? ""), String(id ?? "")),
  skill: (file) => ipcRenderer.invoke("desk:skills-read", String(file ?? "")),
  act: (verb, name) => ipcRenderer.invoke("desk:bricks-act", String(verb ?? ""), String(name ?? "")),
});
