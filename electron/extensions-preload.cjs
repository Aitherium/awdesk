"use strict";

/** Bridge for aither://extensions (extensions.html). Main answers only this page (extensions-window.cjs). */
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("aitherExtensions", {
  list: () => ipcRenderer.invoke("desk:extensions-list"),
  add: () => ipcRenderer.invoke("desk:extensions-add"),
  remove: (id) => ipcRenderer.invoke("desk:extensions-remove", String(id ?? "")),
  open: (id) => ipcRenderer.invoke("desk:extensions-open", String(id ?? "")),
  pluginStatus: () => ipcRenderer.invoke("desk:plugins-status"),
  pluginInstall: () => ipcRenderer.invoke("desk:plugins-install"),
});
