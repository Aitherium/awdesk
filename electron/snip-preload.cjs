"use strict";

/**
 * Bridge for the snip overlay (snip.html) and its toast (snip-toast.html), both
 * owned by snip-window.cjs. The overlay hands back a DIP rect; the crop, the save
 * and the upload happen in the main process. Nothing here sees a token or a path
 * beyond the screenshot's file name.
 */

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("aitherSnip", {
  frame: () => ipcRenderer.invoke("snip:frame"),
  select: (rect) => ipcRenderer.invoke("snip:select", {
    x: Number(rect && rect.x), y: Number(rect && rect.y),
    width: Number(rect && rect.width), height: Number(rect && rect.height),
  }),
  full: () => ipcRenderer.invoke("snip:full"),
  cancel: () => ipcRenderer.invoke("snip:cancel"),
  toastInfo: () => ipcRenderer.invoke("snip:toast-info"),
  toastAction: (action) => ipcRenderer.invoke("snip:toast-action", String(action || "")),
  onToastUpdate: (fn) => {
    const listener = (_event, info) => { try { fn(info); } catch { /* page bug stays in the page */ } };
    ipcRenderer.on("snip:toast-update", listener);
    return () => ipcRenderer.removeListener("snip:toast-update", listener);
  },
});
