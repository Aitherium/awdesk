"use strict";

// The "Nearby devices" window's only door to main: start listening (5 minutes), read the
// list, hand ONE listed rid to the approval page, and hear when the list changes.
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("deskNearby", {
  start: () => ipcRenderer.invoke("nearby:start"),
  state: () => ipcRenderer.invoke("nearby:state"),
  approve: (rid) => ipcRenderer.invoke("nearby:approve", String(rid || "")),
  onChange: (fn) => {
    ipcRenderer.on("nearby:changed", (_event, devices) => fn(Array.isArray(devices) ? devices : []));
  },
});
