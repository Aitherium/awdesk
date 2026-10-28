"use strict";

/**
 * notebooks-window.cjs -- main's half of aither://notebooks (notebooks-client.cjs). Every
 * channel answers only the aither://notebooks page.
 *
 * View opens the notebook in AitherOne inside the Aither browser (openUrl, from main).
 * Open transcript only REVEALS a .jsonl the index names and that exists -- it never runs
 * or opens anything. Replay refuses recorded side effects unless the page passes the
 * owner's explicit confirmation (notebooks-client.cjs replayCensus).
 */

const fs = require("node:fs");
const { createNotebooksClient, validId, viewUrl } = require("./notebooks-client.cjs");

let wired = false;
let clientImpl = null;

function client() {
  if (!clientImpl) clientImpl = createNotebooksClient();
  return clientImpl;
}

function fromNotebooksPage(sender) {
  try {
    const url = new URL(sender.getURL());
    return url.protocol === "aither:" && url.hostname === "notebooks";
  } catch {
    return false;
  }
}

function notebooksHandlers(c = client(), { isNotebooks = fromNotebooksPage, openUrl = null,
  shell = null, exists = (p) => fs.existsSync(p) } = {}) {
  const guard = (fn) => async (event, ...args) => {
    if (!event || !event.sender || !isNotebooks(event.sender)) {
      return { ok: false, error: "not the notebooks page" };
    }
    try {
      return await fn(...args);
    } catch (error) {
      return { ok: false, error: String((error && error.message) || error) };
    }
  };
  const sh = () => shell || require("electron").shell;
  return {
    "desk:notebooks-list": guard((opts) => c.list({ localOnly: Boolean(opts && opts.localOnly) })),
    "desk:notebooks-outline": guard((id) => c.outline(id)),
    "desk:notebooks-replay": guard((id, opts) =>
      c.replay(id, { allowSideEffects: Boolean(opts && opts.allowSideEffects) })),
    "desk:notebooks-export": guard(async (id) => {
      const out = await c.exportTo(id);
      if (out.ok) sh().showItemInFolder(out.path);
      return out;
    }),
    "desk:notebooks-view": guard(async (id) => {
      if (!validId(id)) return { ok: false, error: "not a notebook id" };
      const url = viewUrl(id);
      if (openUrl) openUrl(url);
      else await sh().openExternal(url);
      return { ok: true, url };
    }),
    "desk:notebooks-transcript": guard((logPath) => {
      const file = String(logPath || "");
      if (!file.toLowerCase().endsWith(".jsonl") || !exists(file)) {
        return { ok: false, error: "no transcript at that path on this computer" };
      }
      sh().showItemInFolder(file);
      return { ok: true, path: file };
    }),
  };
}

function ensureNotebooksIpc({ openUrl = null } = {}) {
  if (wired) return;
  wired = true;
  const { ipcMain } = require("electron");
  for (const [channel, handler] of Object.entries(notebooksHandlers(client(), { openUrl }))) {
    ipcMain.handle(channel, handler);
  }
}

module.exports = { ensureNotebooksIpc, fromNotebooksPage, notebooksHandlers };
