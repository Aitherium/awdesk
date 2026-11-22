"use strict";

/** Bridge for phone-panel.html (owned by phone-panel.cjs): state, one verb, and live updates. */
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("aitherPhone", {
  state: () => ipcRenderer.invoke("phone-panel:state"),
  act: (verb) => ipcRenderer.invoke("phone-panel:act", String(verb || "")),
  close: () => ipcRenderer.invoke("phone-panel:close"),
  onChange: (fn) => {
    const listener = (_event, value) => { try { fn(value); } catch { /* page bug stays in the page */ } };
    ipcRenderer.on("phone-panel:changed", listener);
    return () => ipcRenderer.removeListener("phone-panel:changed", listener);
  },
});
