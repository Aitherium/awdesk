"use strict";

/** toolkit-pick-preload.cjs -- the region picker's one call: the box it drew (DIPs, display-relative), or null. */
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("toolkitPick", {
  done: (rect) => ipcRenderer.invoke("toolkit-pick:done", rect && typeof rect === "object" ? {
    x: Number(rect.x), y: Number(rect.y), width: Number(rect.width), height: Number(rect.height),
  } : null),
});
