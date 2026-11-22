"use strict";

/**
 * browser-library.cjs -- the Aither Browser's history and bookmarks.
 *
 * One small JSON file in the desk's userData (browser-library.json), written
 * atomically (tmp + rename) so a crash mid-write leaves yesterday's file, never
 * half of one. http(s) pages only; a URL with credentials is never stored.
 *
 * History remembers WHO visited (the owner's tab or an agent's), so the address
 * bar can suggest the owner's own pages first. No agent tool reads this file.
 */

const fs = require("node:fs");
const path = require("node:path");

const VERSION = 1;
const MAX_HISTORY = 2000;
const MAX_BOOKMARKS = 500;
const MAX_TITLE = 200;

function storable(url) {
  try {
    const u = new URL(String(url || ""));
    return (u.protocol === "http:" || u.protocol === "https:") && !u.username && !u.password;
  } catch {
    return false;
  }
}

function emptyData() {
  return { version: VERSION, history: [], bookmarks: [] };
}

function readFile(file) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    if (!parsed || parsed.version !== VERSION) return emptyData();
    return {
      version: VERSION,
      history: Array.isArray(parsed.history) ? parsed.history.filter((h) => h && storable(h.url)) : [],
      bookmarks: Array.isArray(parsed.bookmarks) ? parsed.bookmarks.filter((b) => b && storable(b.url)) : [],
    };
  } catch {
    return emptyData();
  }
}

/**
 * @param {{file: string, now?: () => number, maxHistory?: number}} opts
 */
function createLibrary({ file, now = () => Date.now(), maxHistory = MAX_HISTORY } = {}) {
  if (!file) throw new Error("createLibrary needs a file");
  const data = readFile(file);

  function save() {
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const tmp = `${file}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(data));
      fs.renameSync(tmp, file);
      return true;
    } catch {
      return false; // a full disk loses one visit, never the browser
    }
  }

  return {
    /** Record a finished page load. Returns false for anything not worth keeping. */
    visit(url, title = "", by = "you") {
      if (!storable(url)) return false;
      const at = now();
      const existing = data.history.findIndex((h) => h.url === url);
      const prior = existing >= 0 ? data.history.splice(existing, 1)[0] : null;
      data.history.unshift({
        url,
        title: String(title || (prior && prior.title) || "").slice(0, MAX_TITLE),
        at,
        count: (prior ? prior.count || 1 : 0) + 1,
        by: by === "agent" && (!prior || prior.by === "agent") ? "agent" : "you",
      });
      if (data.history.length > maxHistory) data.history.length = maxHistory;
      return save();
    },

    history(limit = 50) {
      return data.history.slice(0, Math.max(0, limit));
    },

    clearHistory() {
      data.history = [];
      return save();
    },

    bookmarks() {
      return data.bookmarks.slice();
    },

    isBookmarked(url) {
      return data.bookmarks.some((b) => b.url === url);
    },

    /** Add or remove a bookmark. Returns the new state: true = bookmarked. */
    toggleBookmark(url, title = "") {
      if (!storable(url)) return false;
      const at = data.bookmarks.findIndex((b) => b.url === url);
      if (at >= 0) {
        data.bookmarks.splice(at, 1);
        save();
        return false;
      }
      if (data.bookmarks.length >= MAX_BOOKMARKS) return false;
      data.bookmarks.unshift({ url, title: String(title || "").slice(0, MAX_TITLE), at: now() });
      save();
      return true;
    },

    /**
     * Address-bar suggestions for what the owner typed: bookmarks first, then the
     * owner's own history, then pages an agent visited; most-visited first within each.
     */
    suggest(text, limit = 8) {
      const q = String(text || "").trim().toLowerCase();
      if (!q) return [];
      const hit = (e) => e.url.toLowerCase().includes(q) || String(e.title || "").toLowerCase().includes(q);
      const seen = new Set();
      const out = [];
      const add = (e, kind) => {
        if (out.length >= limit || seen.has(e.url)) return;
        seen.add(e.url);
        out.push({ url: e.url, title: e.title || "", kind });
      };
      data.bookmarks.filter(hit).forEach((b) => add(b, "bookmark"));
      const ranked = (by) => data.history.filter((h) => hit(h) && h.by === by)
        .sort((a, b) => (b.count || 1) - (a.count || 1) || b.at - a.at);
      ranked("you").forEach((h) => add(h, "history"));
      ranked("agent").forEach((h) => add(h, "agent"));
      return out;
    },
  };
}

module.exports = { MAX_BOOKMARKS, MAX_HISTORY, createLibrary, storable };
