"use strict";

const { contextBridge, ipcRenderer } = require("electron");

function onChannel(channel, fn) {
  const listener = (_event, payload) => fn(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

contextBridge.exposeInMainWorld("aitherUnified", {
  // Shell & morph state
  getState: () => ipcRenderer.invoke("unified:get-state"),
  setMode: (mode) => ipcRenderer.invoke("unified:set-mode", mode),
  updateLayout: (patch) => ipcRenderer.invoke("unified:update-layout", patch),
  setAvatarRenderer: (renderer) => ipcRenderer.invoke("unified:set-avatar-renderer", renderer),
  setSelectedVrm: (vrmId) => ipcRenderer.invoke("unified:set-selected-vrm", vrmId),
  listVrmModels: () => ipcRenderer.invoke("unified:vrm-list"),
  loadVrmBytes: (vrmId) => ipcRenderer.invoke("unified:vrm-load", vrmId),
  listSwarms: () => ipcRenderer.invoke("unified:swarms-list"),

  // Native middle-mouse drag & frameless edge resize
  dragStart: (x, y) => ipcRenderer.send("unified:drag-start", { x, y }),
  dragMove: (x, y) => ipcRenderer.send("unified:drag-move", { x, y }),
  dragEnd: () => ipcRenderer.send("unified:drag-end"),
  resizeStart: (edge, x, y) => ipcRenderer.send("unified:resize-start", { edge, x, y }),
  resizeMove: (x, y) => ipcRenderer.send("unified:resize-move", { x, y }),
  resizeEnd: () => ipcRenderer.send("unified:resize-end"),
  windowAction: (action) => ipcRenderer.send("unified:window-action", action),

  // Browser tabs, find, DevTools, zoom
  openTab: (opts) => ipcRenderer.invoke("unified:tab-open", opts),
  closeTab: (id) => ipcRenderer.invoke("unified:tab-close", id),
  activateTab: (id) => ipcRenderer.invoke("unified:tab-activate", id),
  setSecondaryTab: (id) => ipcRenderer.invoke("unified:tab-secondary", id),
  navigateTab: (id, url) => ipcRenderer.invoke("unified:tab-navigate", { id, url }),
  tabNav: (id, action) => ipcRenderer.invoke("unified:tab-nav", { id, action }),
  findInPage: (id, text, opts) => ipcRenderer.invoke("unified:tab-find", { id, text, opts }),
  stopFindInPage: (id) => ipcRenderer.invoke("unified:tab-find-stop", id),
  toggleDevTools: (id) => ipcRenderer.invoke("unified:tab-devtools", id),
  zoomTab: (id, action) => ipcRenderer.invoke("unified:tab-zoom", { id, action }),

  // Stages, Bookmarks, History, Downloads
  listStages: () => ipcRenderer.invoke("unified:stages-list"),
  createStage: (opts) => ipcRenderer.invoke("unified:stages-create", opts),
  switchStage: (id) => ipcRenderer.invoke("unified:stages-switch", id),
  deleteStage: (id) => ipcRenderer.invoke("unified:stages-delete", id),
  getLibrary: (activeUrl) => ipcRenderer.invoke("unified:library-get", activeUrl),
  toggleBookmark: (url, title) => ipcRenderer.invoke("unified:library-bookmark-toggle", { url, title }),
  suggestUrls: (query) => ipcRenderer.invoke("unified:library-suggest", query),
  listDownloads: () => ipcRenderer.invoke("unified:downloads-list"),
  clearDownloads: () => ipcRenderer.invoke("unified:downloads-clear"),
  openDownload: (filePath, mode) => ipcRenderer.invoke("unified:downloads-open", { filePath, mode }),

  // Conversations, decisions, credentials, automations, awsh sessions
  listConversations: () => ipcRenderer.invoke("unified:conversations-list"),
  createConversation: (opts) => ipcRenderer.invoke("unified:conversations-create", opts),
  deleteConversation: (id) => ipcRenderer.invoke("unified:conversations-delete", id),
  sendChat: (opts) => ipcRenderer.invoke("unified:chat-send", opts),
  listDecisions: () => ipcRenderer.invoke("unified:decisions-list"),
  answerDecision: (id, optionKey, note) => ipcRenderer.invoke("unified:decisions-answer", { id, optionKey, note }),
  cancelDecision: (id) => ipcRenderer.invoke("unified:decisions-cancel", id),
  submitCredential: (id, secretValue) => ipcRenderer.invoke("unified:decisions-credential", { id, secretValue }),
  listAutomations: () => ipcRenderer.invoke("unified:automations-list"),
  listAwshSessions: () => ipcRenderer.invoke("unified:awsh-sessions"),
  listModels: () => ipcRenderer.invoke("unified:models-list"),

  // Push events from main
  onState: (fn) => onChannel("unified:state", fn),
  onTabs: (fn) => onChannel("unified:tabs", fn),
  onDecisions: (fn) => onChannel("unified:decisions", fn),
  onDownloads: (fn) => onChannel("unified:downloads", fn),
  onChatChunk: (fn) => onChannel("unified:chat-chunk", fn),
  onShortcutUi: (fn) => onChannel("unified:shortcut-ui", fn),
});
