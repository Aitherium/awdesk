"use strict";

// The "Connect this computer" window's only door to main: confirm a code, open the page that
// shows one, and read whether this computer is already connected (its device id, no secrets).
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("deskConnect", {
  enroll: (code) => ipcRenderer.invoke("device-connect:enroll", String(code || "")),
  openPage: () => ipcRenderer.invoke("device-connect:open-page"),
  state: () => ipcRenderer.invoke("device-connect:state"),
});
