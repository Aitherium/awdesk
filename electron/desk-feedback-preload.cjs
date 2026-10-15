"use strict";

// The "Send feedback" window's only door to main: read what would be attached, and send.
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("deskFeedback", {
  state: () => ipcRenderer.invoke("desk-feedback:state"),
  send: (payload) => ipcRenderer.invoke("desk-feedback:send", {
    message: String((payload && payload.message) || ""),
    includeLogs: Boolean(payload && payload.includeLogs),
    includeShot: Boolean(payload && payload.includeShot),
  }),
});
