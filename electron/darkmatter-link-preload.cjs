"use strict";

/**
 * Bridge for the Darkmatter Link window (darkmatter-link.html).
 *
 * There is no verb that reads the gateway key back: the page can set or clear it
 * and is told only whether one is stored.
 */

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("darkmatterLink", {
  state: () => ipcRenderer.invoke("desk:dml-state"),
  status: () => ipcRenderer.invoke("desk:dml-status"),
  games: () => ipcRenderer.invoke("desk:dml-games"),
  personas: () => ipcRenderer.invoke("desk:dml-personas"),
  settings: (patch) => ipcRenderer.invoke("desk:dml-settings", patch || {}),
  consent: (wanted) => ipcRenderer.invoke("desk:dml-consent", wanted === true),
  setKey: (key) => ipcRenderer.invoke("desk:dml-key-set", String(key || "")),
  clearKey: () => ipcRenderer.invoke("desk:dml-key-clear"),
  start: () => ipcRenderer.invoke("desk:dml-start"),
  stop: () => ipcRenderer.invoke("desk:dml-stop"),
  openShop: () => ipcRenderer.send("desk:dml-open-shop"),
});
