"use strict";

/**
 * toolkit-preload.cjs -- the ONE bridge every local toolkit window shares (sketch pad,
 * piano pad, quick type, region workspace, graphics actions). Owner 2026-11-13: "local
 * awdesk tools ... right-click access to drawing, graphics, GIFs, playing notes, typing,
 * whiteboard, pinning notes, sending things away".
 *
 * A page never sees a token, a path outside its own saves, or another workspace: every
 * call is a verdict ({ok, line} | {ok:false, error}) computed in toolkit.cjs. Payloads are
 * plain data: {kind, name, mime, dataB64?, text?, title?}.
 */

const { contextBridge, ipcRenderer } = require("electron");

function clean(payload) {
  const p = payload && typeof payload === "object" ? payload : {};
  return {
    kind: String(p.kind || "text").slice(0, 20),
    name: String(p.name || "").slice(0, 200),
    mime: String(p.mime || "").slice(0, 100),
    dataB64: typeof p.dataB64 === "string" ? p.dataB64 : "",
    text: typeof p.text === "string" ? p.text.slice(0, 100_000) : "",
    title: String(p.title || "").slice(0, 300),
  };
}

contextBridge.exposeInMainWorld("toolkit", {
  /** {tool, workspace:{key,name}, targets:[{id,label,group}], offline} */
  info: () => ipcRenderer.invoke("toolkit:info"),
  /** Send a payload to one target id (see toolkit-core SEND_TARGETS). */
  send: (target, payload) => ipcRenderer.invoke("toolkit:send", String(target || ""), clean(payload)),
  /** Save under ~/Aither Toolkit/<workspace>/<tool>/ ; resolves {ok, path}. */
  save: (payload) => ipcRenderer.invoke("toolkit:save", clean(payload)),
  /** Image (dataB64 png) or text onto the clipboard. */
  copy: (payload) => ipcRenderer.invoke("toolkit:copy", clean(payload)),
  /** Run a desk command by id (e.g. "song.seed" with an arg). */
  run: (id, arg) => ipcRenderer.invoke("toolkit:run", String(id || ""), arg === undefined ? null : String(arg).slice(0, 4000)),
  /** Ask Aither about this window's content: {question, imageB64?} -> {ok, answer}. */
  ask: (question, imageB64) => ipcRenderer.invoke("toolkit:ask", String(question || "").slice(0, 4000),
    typeof imageB64 === "string" ? imageB64 : ""),
  /** Tool-specific request (region frames, graphics ops). */
  call: (verb, arg) => ipcRenderer.invoke("toolkit:call", String(verb || ""), arg === undefined ? null : arg),
  close: () => ipcRenderer.invoke("toolkit:close"),
  onEvent: (fn) => {
    const listener = (_event, msg) => { try { fn(msg); } catch { /* a page bug stays in the page */ } };
    ipcRenderer.on("toolkit:event", listener);
    return () => ipcRenderer.removeListener("toolkit:event", listener);
  },
});
