"use strict";

// "Install the full local stack" (local-stack.html): read the checklist, start the install,
// follow its progress. Nothing here can carry a token: main redacts before sending.
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("localStack", {
  state: () => ipcRenderer.invoke("local-stack:state"),
  run: () => ipcRenderer.invoke("local-stack:run"),
  close: () => ipcRenderer.send("local-stack:close"),
  onProgress: (fn) => {
    const h = (_e, ev) => fn(ev);
    ipcRenderer.on("local-stack:progress", h);
    return () => ipcRenderer.removeListener("local-stack:progress", h);
  },
});
