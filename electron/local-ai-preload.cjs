"use strict";

/** Bridge for aither://local-ai (local-ai.html). Channels: local-ai-window.cjs. */
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("aitherLocalAi", {
  status: () => ipcRenderer.invoke("desk:localai-status"),
  install: (model) => ipcRenderer.invoke("desk:localai-install", String(model ?? "")),
  remove: () => ipcRenderer.invoke("desk:localai-remove"),
  job: () => ipcRenderer.invoke("desk:localai-job"),
  route: () => ipcRenderer.invoke("desk:localai-route"),
  chat: (messages, port) => ipcRenderer.invoke("desk:localai-chat", messages, Number(port) || 0),
});
