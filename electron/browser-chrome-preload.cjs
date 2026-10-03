"use strict";

// Preload for the Aither Browser's TOOLBAR (browser-chrome.html). The page view
// has no preload at all; this bridge exists only on the desk's own chrome, and
// main checks the sender of every call (browser-window.cjs).
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("aitherBrowser", {
  state: () => ipcRenderer.invoke("desk:browser-state"),
  navigate: (url) => ipcRenderer.invoke("desk:browser-navigate", String(url ?? "")),
  back: () => ipcRenderer.send("desk:browser-nav", "back"),
  forward: () => ipcRenderer.send("desk:browser-nav", "forward"),
  reload: () => ipcRenderer.send("desk:browser-nav", "reload"),
  stop: () => ipcRenderer.send("desk:browser-nav", "stop"),
  newTab: () => ipcRenderer.invoke("desk:browser-tab-new"),
  activateTab: (id) => ipcRenderer.send("desk:browser-tab-activate", Number(id)),
  closeTab: (id) => ipcRenderer.send("desk:browser-tab-close", Number(id)),
  takeOver: () => ipcRenderer.send("desk:browser-takeover"),
  handBack: () => ipcRenderer.send("desk:browser-handback"),
  onState: (listener) => {
    const handler = (_event, payload) => listener(payload);
    ipcRenderer.on("desk:browser-state", handler);
    return () => ipcRenderer.off("desk:browser-state", handler);
  },
});
