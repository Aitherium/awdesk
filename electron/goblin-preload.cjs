"use strict";

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("goblinApi", {
  onState: (cb) => { ipcRenderer.on("goblin:state", (_event, state) => cb(state)); },
  dismiss: () => { ipcRenderer.send("goblin:dismiss"); },
});
