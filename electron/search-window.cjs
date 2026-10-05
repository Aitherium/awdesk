"use strict";

/**
 * search-window.cjs -- main's half of aither://search (search-client.cjs). Every
 * channel answers only the aither://search page: it starts processes (awfind,
 * awresearch) on the owner's machine, so no other page may reach it.
 */

const { createSearchClient } = require("./search-client.cjs");

let wired = false;
let clientImpl = null;
let openForge = null;

function client() {
  if (!clientImpl) {
    let dataDir = null;
    try { dataDir = require("node:path").join(require("electron").app.getPath("userData"), "research"); } catch { /* tests */ }
    clientImpl = createSearchClient({ dataDir });
  }
  return clientImpl;
}

function fromSearchPage(sender) {
  try {
    const url = new URL(sender.getURL());
    return url.protocol === "aither:" && url.hostname === "search";
  } catch {
    return false;
  }
}

/** main says how a Media Forge URL opens (a web tab in the browser). */
function setForgeOpener(fn) {
  openForge = typeof fn === "function" ? fn : null;
}

function searchHandlers(c = client(), { isSearch = fromSearchPage, opener = () => openForge } = {}) {
  const guard = (fn) => async (event, ...args) => {
    if (!event || !event.sender || !isSearch(event.sender)) return { ok: false, error: "not the search page" };
    try {
      return await fn(...args);
    } catch (error) {
      return { ok: false, error: String((error && error.message) || error) };
    }
  };
  return {
    "desk:search-run": guard((mode, query) => c.search(String(mode), query)),
    "desk:search-images": guard((query) => c.images(query)),
    "desk:research-start": guard((question, depth) => c.startResearch(question, String(depth || "standard"))),
    "desk:research-list": guard(() => c.listResearch()),
    "desk:research-read": guard((id) => c.readResearch(id)),
    "desk:forge-open": guard(async () => {
      const where = await c.forgeUrl();
      const open = opener();
      if (!where.ok || !open) return where.ok ? { ok: false, error: "no opener wired" } : where;
      open(where.url);
      return { ok: true, url: where.url };
    }),
  };
}

function ensureSearchIpc() {
  if (wired) return;
  wired = true;
  const { ipcMain } = require("electron");
  for (const [channel, handler] of Object.entries(searchHandlers())) ipcMain.handle(channel, handler);
}

module.exports = { client, ensureSearchIpc, fromSearchPage, searchHandlers, setForgeOpener };
