"use strict";

/**
 * Bridge for the Files page (files.html), injected by console-preload.cjs inside
 * the console and used directly by the detached window (files-window.cjs).
 *
 * Read verbs answer {ok, data|error}; the owner write verbs (files-ops.cjs)
 * answer {ok, ...} | {ok:false, reason}, batch verbs {ok, done, failed}.
 * `grant` only flips whether AGENTS may read a root -- agents never reach any
 * write verb here. Delete is the Recycle Bin. `pathsOf` resolves dropped File
 * objects to paths here, because the sandboxed renderer cannot see them.
 *
 * 🚩 Import takes File objects, never path strings: `importFiles` resolves the
 * dropped files with webUtils.getPathForFile HERE and invokes IPC with only
 * those, so page script cannot name a source (~/.ssh, a system file) to copy or
 * move. A File the page constructs itself has no path and is dropped.
 */

const { contextBridge, ipcRenderer, webUtils } = require("electron");

const s = (v) => String(v == null ? "" : v);
const many = (v) => (Array.isArray(v) ? v : [v]).map(s).filter(Boolean);

/** Real on-disk paths of dropped File objects; anything without one is skipped. */
function pathsOfFiles(fileList) {
  const out = [];
  for (const f of Array.from(fileList || [])) {
    try {
      const p = webUtils.getPathForFile(f);
      if (p) out.push(p);
    } catch { /* a non-file drop (text, a URL) has no path */ }
  }
  return out;
}

contextBridge.exposeInMainWorld("aitherFiles", {
  roots: () => ipcRenderer.invoke("desk:files-roots"),
  list: (rootId, rel) => ipcRenderer.invoke("desk:files-list", s(rootId), s(rel)),
  open: (rootId, rel) => ipcRenderer.invoke("desk:files-open", s(rootId), s(rel)),
  reveal: (rootId, rel) => ipcRenderer.invoke("desk:files-reveal", s(rootId), s(rel)),
  hand: (rootId, rel) => ipcRenderer.invoke("desk:files-hand", s(rootId), s(rel)),
  grant: (rootId, allowed) => ipcRenderer.invoke("desk:files-grant", s(rootId), allowed === true),
  addRoot: () => ipcRenderer.invoke("desk:files-add-root"),
  removeRoot: (rootId) => ipcRenderer.invoke("desk:files-remove-root", s(rootId)),
  // owner write verbs
  mkdir: (rootId, rel, name) => ipcRenderer.invoke("desk:files-mkdir", s(rootId), s(rel), s(name)),
  rename: (rootId, rel, name) => ipcRenderer.invoke("desk:files-rename", s(rootId), s(rel), s(name)),
  copy: (srcRoot, rels, dstRoot, dstRel) => ipcRenderer.invoke("desk:files-copy", s(srcRoot), many(rels), s(dstRoot), s(dstRel)),
  move: (srcRoot, rels, dstRoot, dstRel) => ipcRenderer.invoke("desk:files-move", s(srcRoot), many(rels), s(dstRoot), s(dstRel)),
  trash: (rootId, rels) => ipcRenderer.invoke("desk:files-trash", s(rootId), many(rels)),
  importFiles: (fileList, dstRoot, dstRel, move) => ipcRenderer.invoke("desk:files-import", pathsOfFiles(fileList),
    s(dstRoot), s(dstRel), move === true),
  props: (rootId, rel) => ipcRenderer.invoke("desk:files-props", s(rootId), s(rel)),
  preview: (rootId, rel) => ipcRenderer.invoke("desk:files-preview", s(rootId), s(rel)),
  thumb: (rootId, rel, size) => ipcRenderer.invoke("desk:files-thumb", s(rootId), s(rel), Number(size) || 96),
  address: (text) => ipcRenderer.invoke("desk:files-address", s(text)),
  send: (rootId, rels) => ipcRenderer.invoke("desk:files-send", s(rootId), many(rels)),
  cloud: () => ipcRenderer.invoke("desk:files-cloud"),
  ask: (rootId, rel, question) => ipcRenderer.invoke("desk:files-ask", s(rootId), s(rel), s(question)),
  dragOut: (rootId, rels) => ipcRenderer.invoke("desk:files-drag-out", s(rootId), many(rels)),
  wineStatus: () => ipcRenderer.invoke("desk:files-wine-status"),
  wineEnable: (consent) => ipcRenderer.invoke("desk:files-wine-enable", consent === true),
  wineRestore: () => ipcRenderer.invoke("desk:files-wine-restore"),
  pathsOf: (fileList) => pathsOfFiles(fileList),
});
