"use strict";

/**
 * Bridge for aither://search (search.html), injected by browser-internal-preload.cjs
 * (the `<stem>-preload.cjs` convention) and console-preload.cjs. Main answers only this
 * page (search-window.cjs).
 */

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("aitherSearch", {
  search: (mode, query) => ipcRenderer.invoke("desk:search-run", String(mode || "q"), String(query ?? "")),
  images: (query) => ipcRenderer.invoke("desk:search-images", String(query ?? "")),
  videos: (query) => ipcRenderer.invoke("desk:search-videos", String(query ?? "")),
  share: (item) => ipcRenderer.invoke("desk:search-share", {
    url: String((item && item.url) || ""), title: String((item && item.title) || ""), kind: String((item && item.kind) || "page"),
  }),
  research: (question, depth) => ipcRenderer.invoke("desk:research-start", String(question ?? ""), String(depth || "standard")),
  researchList: () => ipcRenderer.invoke("desk:research-list"),
  researchRead: (id) => ipcRenderer.invoke("desk:research-read", String(id ?? "")),
  openForge: () => ipcRenderer.invoke("desk:forge-open"),
});
