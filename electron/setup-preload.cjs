"use strict";

// Preload for "Set up Aither" (setup-window.html). The renderer is sandboxed and sees
// exactly these verbs. None returns a token: sign-in yields the non-secret identity,
// apply yields the summary aither-setup reports. The password is passed ONCE to apply.
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("aitherSetup", {
  preflight: () => ipcRenderer.invoke("desk:setup-preflight"),
  installEngine: () => ipcRenderer.invoke("desk:setup-install-engine"),
  signIn: () => ipcRenderer.invoke("desk:setup-signin"),
  apply: (answers) => ipcRenderer.invoke("desk:setup-apply", answers && typeof answers === "object" ? answers : {}),
  restart: (mode) => ipcRenderer.invoke("desk:setup-restart", mode === "now" ? "now" : "idle"),
  verify: () => ipcRenderer.invoke("desk:setup-verify"),
  done: () => ipcRenderer.send("desk:setup-done"),
  close: () => ipcRenderer.send("desk:setup-close"),
  onProgress: (fn) => {
    const h = (_e, ev) => fn(ev);
    ipcRenderer.on("desk:setup-progress", h);
    return () => ipcRenderer.removeListener("desk:setup-progress", h);
  },
});
