"use strict";

// The hidden "Lend memory" page's only door to main: its config, a signed hello per dial
// (the device key never enters the page), and status reports.
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("kvlend", {
  config: () => ipcRenderer.invoke("kvlend:config"),
  hello: () => ipcRenderer.invoke("kvlend:hello"),
  status: (st) => ipcRenderer.send("kvlend:status", st),
});
