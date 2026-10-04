"use strict";

/**
 * Bridge for the Files page (files.html), injected by console-preload.cjs inside
 * the console and used directly by the detached window (files-window.cjs).
 *
 * Every verb answers {ok, data|error}. Nothing here writes, moves or deletes a
 * file; `grant` only flips whether AGENTS may read a root.
 */

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("aitherFiles", {
  roots: () => ipcRenderer.invoke("desk:files-roots"),
  list: (rootId, rel) => ipcRenderer.invoke("desk:files-list", String(rootId || ""), String(rel || "")),
  open: (rootId, rel) => ipcRenderer.invoke("desk:files-open", String(rootId || ""), String(rel || "")),
  reveal: (rootId, rel) => ipcRenderer.invoke("desk:files-reveal", String(rootId || ""), String(rel || "")),
  hand: (rootId, rel) => ipcRenderer.invoke("desk:files-hand", String(rootId || ""), String(rel || "")),
  grant: (rootId, allowed) => ipcRenderer.invoke("desk:files-grant", String(rootId || ""), allowed === true),
  addRoot: () => ipcRenderer.invoke("desk:files-add-root"),
  removeRoot: (rootId) => ipcRenderer.invoke("desk:files-remove-root", String(rootId || "")),
});
