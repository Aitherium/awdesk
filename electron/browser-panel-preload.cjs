"use strict";

// Preload for the Aither Browser's ASSISTANT PANEL (browser-panel.html). Two
// verbs and one event for the assistant, plus two for the downloads shelf -- the
// whole contract a replacement panel (the awkit Connect panel) must speak. Main
// checks the sender of every call.
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("aitherAssist", {
  state: () => ipcRenderer.invoke("desk:browser-state"),
  ask: () => ipcRenderer.invoke("desk:browser-ask", ""),
  clearDownloads: () => ipcRenderer.send("desk:browser-downloads-clear"),
  showDownload: (id) => ipcRenderer.send("desk:browser-download-show", Number(id)),
  onState: (listener) => {
    const handler = (_event, payload) => listener(payload);
    ipcRenderer.on("desk:browser-state", handler);
    return () => ipcRenderer.off("desk:browser-state", handler);
  },
});
