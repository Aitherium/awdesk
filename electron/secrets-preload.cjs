"use strict";

/**
 * Bridge for the Secrets page (secrets.html), injected by console-preload.cjs
 * inside the console and used directly by the detached window (secrets-window.cjs).
 *
 * ONE verb: list names and masked hints. There is deliberately no reveal,
 * copy, set or delete here -- a secret value never reaches a renderer.
 */

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("aitherSecrets", {
  list: () => ipcRenderer.invoke("desk:secrets-list"),
});
