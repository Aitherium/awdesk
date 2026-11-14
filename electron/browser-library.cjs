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
 *
 * A bookmark may sit in a folder: `folder` is a path joined with "/" ("Favorites
 * bar/Work"), the shape Edge's own file flattens to. A bookmark without one is at the
 * top level, so a file written before folders existed reads unchanged. Bookmarks leave
 * and arrive as the Netscape bookmarks HTML every browser reads and writes.
 */

const fs = require("node:fs");
const path = require("node:path");

const VERSION = 1;
const MAX_HISTORY = 2000;
const MAX_BOOKMARKS = 5000; // an Edge profile's favorites, folders and all
const MAX_FOLDER = 200;
/** Folders whose bookmarks sit directly on the bookmarks bar (Edge and Chrome name theirs). */
const BAR_FOLDERS = Object.freeze(["", "favorites bar", "bookmarks bar"]);
const MAX_TITLE = 200;

function storable(url) {
  try {
    const u = new URL(String(url || ""));
    return (u.protocol === "http:" || u.protocol === "https:") && !u.username && !u.password;
  } catch {
    return false;
  }
}

/** A folder path as stored: trimmed parts joined with "/", no control characters, "" for none. */
function normFolder(name) {
  return String(name == null ? "" : name)
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f]/g, " ")
    .split("/").map((part) => part.trim()).filter(Boolean).join("/")
    .slice(0, MAX_FOLDER);
}

/** Is `folder` the folder `parent` or inside it? */
function inFolder(folder, parent) {
  return folder === parent || folder.startsWith(`${parent}/`);
}

function emptyData() {
  return { version: VERSION, history: [], bookmarks: [], folders: [] };
}

function readFile(file) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    if (!parsed || parsed.version !== VERSION) return emptyData();
    return {
      version: VERSION,
      history: Array.isArray(parsed.history) ? parsed.history.filter((h) => h && storable(h.url)) : [],
      bookmarks: Array.isArray(parsed.bookmarks) ? parsed.bookmarks.filter((b) => b && storable(b.url)) : [],
      // Folders the owner made that hold nothing yet (a bookmark carries its own).
      folders: Array.isArray(parsed.folders) ? parsed.folders.map(normFolder).filter(Boolean) : [],
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

    /**
     * The history page: newest first, filtered by text (address or title) and by who
     * visited. @returns {{entries: object[], total: number}} `total` counts every match.
     */
    historyPage({ q = "", by = "", limit = 200, offset = 0 } = {}) {
      const text = String(q || "").trim().toLowerCase();
      const who = by === "you" || by === "agent" ? by : "";
      const hits = data.history.filter((h) => (!who || h.by === who)
        && (!text || h.url.toLowerCase().includes(text) || String(h.title || "").toLowerCase().includes(text)));
      const start = Math.max(0, Number(offset) || 0);
      return { entries: hits.slice(start, start + Math.max(0, Math.min(1000, Number(limit) || 0))), total: hits.length };
    },

    /** Forget one page. Returns whether it was there. */
    removeHistory(url) {
      const at = data.history.findIndex((h) => h.url === url);
      if (at < 0) return false;
      data.history.splice(at, 1);
      save();
      return true;
    },

    /** Forget every visit with from <= at < to (ms). Returns how many went. */
    removeHistoryRange({ from = 0, to = Infinity } = {}) {
      const lo = Number(from) || 0;
      const hi = to == null || to === Infinity ? Infinity : Number(to);
      if (!(hi > lo)) return 0;
      const before = data.history.length;
      data.history = data.history.filter((h) => !((h.at || 0) >= lo && (h.at || 0) < hi));
      const n = before - data.history.length;
      if (n) save();
      return n;
    },

    /** Forget all history, or (with `since`, ms) only what was visited at or after it. */
    clearHistory({ since = 0 } = {}) {
      const from = Number(since) || 0;
      data.history = from > 0 ? data.history.filter((h) => (h.at || 0) < from) : [];
      return save();
    },

    bookmarks() {
      return data.bookmarks.map((b) => ({ ...b, folder: normFolder(b.folder) }));
    },

    /** Every folder, sorted: the ones bookmarks sit in, their parents, and empty ones the owner made. */
    folders() {
      const out = new Set(data.folders);
      for (const b of data.bookmarks) {
        const parts = normFolder(b.folder).split("/").filter(Boolean);
        for (let i = 1; i <= parts.length; i += 1) out.add(parts.slice(0, i).join("/"));
      }
      return [...out].sort((a, b) => a.localeCompare(b));
    },

    /** Make an empty folder. Returns its stored name, or "" when the name is empty. */
    addFolder(name) {
      const folder = normFolder(name);
      if (!folder) return "";
      if (!data.folders.includes(folder)) {
        data.folders.push(folder);
        save();
      }
      return folder;
    },

    /** Rename a folder (and everything inside it). Returns how many bookmarks moved. */
    renameFolder(from, to) {
      const src = normFolder(from);
      const dst = normFolder(to);
      if (!src || !dst || src === dst || inFolder(dst, src)) return 0;
      const move = (f) => (inFolder(f, src) ? normFolder(dst + f.slice(src.length)) : f);
      let n = 0;
      for (const b of data.bookmarks) {
        const f = normFolder(b.folder);
        if (!inFolder(f, src)) continue;
        b.folder = move(f);
        n += 1;
      }
      data.folders = [...new Set(data.folders.map(move))];
      if (!data.folders.includes(dst)) data.folders.push(dst);
      save();
      return n;
    },

    /**
     * Delete a folder. Its bookmarks go with it, or (keep) move up to the top level.
     * Returns how many bookmarks were deleted or moved.
     */
    removeFolder(name, { keep = false } = {}) {
      const src = normFolder(name);
      if (!src) return 0;
      let n = 0;
      if (keep) {
        for (const b of data.bookmarks) {
          if (!inFolder(normFolder(b.folder), src)) continue;
          delete b.folder;
          n += 1;
        }
      } else {
        const before = data.bookmarks.length;
        data.bookmarks = data.bookmarks.filter((b) => !inFolder(normFolder(b.folder), src));
        n = before - data.bookmarks.length;
      }
      data.folders = data.folders.filter((f) => !inFolder(f, src));
      save();
      return n;
    },

    /** Add a bookmark (or move / retitle the one already at that address). */
    addBookmark({ url, title = "", folder = "" } = {}) {
      if (!storable(url)) return { ok: false, error: "only http(s) pages can be bookmarked" };
      const f = normFolder(folder);
      const have = data.bookmarks.find((b) => b.url === url);
      if (have) {
        if (title) have.title = String(title).slice(0, MAX_TITLE);
        if (f) have.folder = f;
        else delete have.folder;
        save();
        return { ok: true, added: false };
      }
      if (data.bookmarks.length >= MAX_BOOKMARKS) return { ok: false, error: `the bookmark limit (${MAX_BOOKMARKS}) is reached` };
      const row = { url, title: String(title || "").slice(0, MAX_TITLE), at: now() };
      if (f) row.folder = f;
      data.bookmarks.unshift(row);
      save();
      return { ok: true, added: true };
    },

    /** Rename a bookmark, change its address, or move it to a folder ("" = top level). */
    updateBookmark(url, { title, folder, url: nextUrl } = {}) {
      const row = data.bookmarks.find((b) => b.url === url);
      if (!row) return { ok: false, error: "no such bookmark" };
      if (nextUrl != null && nextUrl !== url) {
        if (!storable(nextUrl)) return { ok: false, error: "only http(s) pages can be bookmarked" };
        if (data.bookmarks.some((b) => b.url === nextUrl)) return { ok: false, error: "that address is already bookmarked" };
        row.url = String(nextUrl);
      }
      if (title != null) row.title = String(title).slice(0, MAX_TITLE);
      if (folder != null) {
        const f = normFolder(folder);
        if (f) row.folder = f;
        else delete row.folder;
      }
      save();
      return { ok: true };
    },

    removeBookmark(url) {
      const at = data.bookmarks.findIndex((b) => b.url === url);
      if (at < 0) return false;
      data.bookmarks.splice(at, 1);
      save();
      return true;
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
     * Bring in another browser's bookmarks and history (Import from Edge). An entry
     * already here is kept as it is; imported history counts as the owner's own.
     * @returns {{bookmarks: number, history: number}} how many were added.
     */
    importEntries({ bookmarks = [], history = [] } = {}) {
      let b = 0;
      let h = 0;
      for (const e of Array.isArray(bookmarks) ? bookmarks : []) {
        if (!e || !storable(e.url) || data.bookmarks.length >= MAX_BOOKMARKS) continue;
        if (data.bookmarks.some((x) => x.url === e.url)) continue;
        const row = { url: e.url, title: String(e.title || "").slice(0, MAX_TITLE), at: Number(e.at) || now() };
        const folder = normFolder(e.folder);
        if (folder) row.folder = folder; // the folder it sat in there (Edge, a bookmarks file)
        data.bookmarks.push(row);
        b += 1;
      }
      const known = new Set(data.history.map((x) => x.url));
      for (const e of Array.isArray(history) ? history : []) {
        if (!e || !storable(e.url) || known.has(e.url)) continue;
        known.add(e.url);
        data.history.push({ url: e.url, title: String(e.title || "").slice(0, MAX_TITLE), at: Number(e.at) || 0,
          count: Math.max(1, Number(e.count) || 1), by: "you" });
        h += 1;
      }
      data.history.sort((x, y) => (y.at || 0) - (x.at || 0));
      if (data.history.length > maxHistory) data.history.length = maxHistory;
      if (b || h) save();
      return { bookmarks: b, history: h };
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

// ---------------------------------------------------------------- bookmarks bar

/**
 * What the bookmarks bar shows: the bookmarks at the top level (and in a "Favorites
 * bar" an import brought), then one drop-down per other folder.
 * @returns {{items: {url: string, title: string}[], folders: {name: string, count: number}[]}}
 */
function barModel(bookmarks, { maxItems = 40, maxFolders = 20 } = {}) {
  const items = [];
  const counts = new Map();
  for (const b of Array.isArray(bookmarks) ? bookmarks : []) {
    if (!b || !storable(b.url)) continue;
    const folder = normFolder(b.folder);
    if (BAR_FOLDERS.includes(folder.toLowerCase())) {
      if (items.length < maxItems) items.push({ url: b.url, title: String(b.title || "") });
    } else {
      counts.set(folder, (counts.get(folder) || 0) + 1);
    }
  }
  const folders = [...counts].map(([name, count]) => ({ name, count }))
    .sort((a, b) => a.name.localeCompare(b.name)).slice(0, maxFolders);
  return { items, folders };
}

// ---------------------------------------------------------------- Netscape bookmarks HTML

const ENTITIES = Object.freeze({ amp: "&", lt: "<", gt: ">", quot: "\"", apos: "'", nbsp: " " });

function escapeHtml(text) {
  return String(text == null ? "" : text)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

function unescapeHtml(text) {
  return String(text == null ? "" : text).replace(/&(#x[a-f0-9]+|#[0-9]+|[a-z]+);/gi, (whole, name) => {
    const key = name.toLowerCase();
    if (key.startsWith("#")) {
      const code = key[1] === "x" ? parseInt(key.slice(2), 16) : parseInt(key.slice(1), 10);
      try {
        return Number.isFinite(code) && code > 0 ? String.fromCodePoint(code) : whole;
      } catch {
        return whole;
      }
    }
    return Object.prototype.hasOwnProperty.call(ENTITIES, key) ? ENTITIES[key] : whole;
  });
}

/**
 * Bookmarks as the Netscape bookmarks HTML file (the one format Edge, Chrome, Firefox
 * and Safari all import). Folders nest by their "/" path; a "Favorites bar" folder is
 * marked as the toolbar folder so another browser puts it on its own bar.
 */
function exportNetscape(bookmarks) {
  const root = { folders: new Map(), items: [] };
  for (const b of Array.isArray(bookmarks) ? bookmarks : []) {
    if (!b || !storable(b.url)) continue;
    let node = root;
    for (const part of normFolder(b.folder).split("/").filter(Boolean)) {
      if (!node.folders.has(part)) node.folders.set(part, { folders: new Map(), items: [] });
      node = node.folders.get(part);
    }
    node.items.push(b);
  }
  const lines = [
    "<!DOCTYPE NETSCAPE-Bookmark-file-1>",
    "<!-- This is an automatically generated file.",
    "     It will be read and overwritten.",
    "     DO NOT EDIT! -->",
    "<META HTTP-EQUIV=\"Content-Type\" CONTENT=\"text/html; charset=UTF-8\">",
    "<TITLE>Bookmarks</TITLE>",
    "<H1>Bookmarks</H1>",
    "<DL><p>",
  ];
  const write = (node, depth) => {
    const pad = "    ".repeat(depth);
    for (const [name, child] of node.folders) {
      const bar = depth === 1 && BAR_FOLDERS.includes(name.toLowerCase()) ? " PERSONAL_TOOLBAR_FOLDER=\"true\"" : "";
      lines.push(`${pad}<DT><H3${bar}>${escapeHtml(name)}</H3>`, `${pad}<DL><p>`);
      write(child, depth + 1);
      lines.push(`${pad}</DL><p>`);
    }
    for (const b of node.items) {
      const added = Math.floor((Number(b.at) || 0) / 1000);
      lines.push(`${pad}<DT><A HREF="${escapeHtml(b.url)}"${added > 0 ? ` ADD_DATE="${added}"` : ""}>${escapeHtml(b.title || b.url)}</A>`);
    }
  };
  write(root, 1);
  lines.push("</DL><p>", "");
  return lines.join("\n");
}

/** The most of a bookmarks file that is read. Edge writes every favicon into the file. */
const MAX_IMPORT_CHARS = 20 * 1024 * 1024;
const MAX_ATTRS = 64 * 1024; // HREF and ADD_DATE come before the ICON data in every exporter

/** Drop <tags> in one pass. A "<" with no ">" after it stays as text. */
function stripTags(text) {
  let out = "";
  let i = 0;
  for (;;) {
    const lt = text.indexOf("<", i);
    if (lt < 0) return out + text.slice(i);
    out += text.slice(i, lt);
    const gt = text.indexOf(">", lt);
    if (gt < 0) return out + text.slice(lt);
    i = gt + 1;
  }
}

/**
 * "Where is the next `needle` at or after `from`?", asked with a `from` that only
 * grows. The last answer is kept, so all the asks together read the text once.
 */
function finder(text, needle) {
  let at = -2; // -2 not searched yet, -1 no more
  return (from) => {
    if (at === -1) return -1;
    if (at < from) at = text.indexOf(needle, from);
    return at;
  };
}

const isSpace = (ch) => ch === " " || ch === "\n" || ch === "\r" || ch === "\t" || ch === "\f";
const isWord = (ch) => (ch >= "a" && ch <= "z") || (ch >= "0" && ch <= "9") || ch === "_";

/**
 * Read a Netscape bookmarks HTML file. Web pages only; the folder is the path of the
 * <H3> headings above the link.
 *
 * One pass with indexOf, never a backtracking pattern: this runs in the main process on
 * a file the owner picked, and a file of unclosed tags must not freeze the desk. A link
 * with no </A> ends at the next <DT>, <DL> or </DL>.
 * @returns {{url: string, title: string, folder: string, at: number}[]}
 */
function parseNetscape(html, { max = MAX_BOOKMARKS } = {}) {
  const out = [];
  const stack = [];
  let pending = null;
  const text = String(html || "").slice(0, MAX_IMPORT_CHARS);
  // Tag names in any case. ASCII only, so every index is the same in both strings.
  const lower = text.replace(/[A-Z]+/g, (run) => run.toLowerCase());
  const nextLt = finder(lower, "<");
  const nextGt = finder(lower, ">");
  const nextH3End = finder(lower, "</h3");
  const nextAEnd = finder(lower, "</a");
  const nextDt = finder(lower, "<dt");
  const nextDl = finder(lower, "<dl");
  const nextDlEnd = finder(lower, "</dl");
  let i = 0;
  while (out.length < max) {
    const lt = nextLt(i);
    if (lt < 0) break;
    const gt = nextGt(lt);
    if (gt < 0) break; // no tag closes after this point
    i = lt + 1;
    if (lower.startsWith("</dl", lt)) {
      stack.pop();
      pending = null;
      i = gt + 1;
    } else if (lower.startsWith("<dl", lt) && !isWord(lower[lt + 3])) {
      stack.push(pending);
      pending = null;
      i = gt + 1;
    } else if (lower.startsWith("<h3", lt) && !isWord(lower[lt + 3])) {
      const end = nextH3End(gt);
      if (end < 0) { i = gt + 1; continue; }
      pending = unescapeHtml(stripTags(text.slice(gt + 1, Math.min(end, gt + 1 + 4 * MAX_TITLE)))).trim();
      i = end + 4;
    } else if (lower.startsWith("<a", lt) && (lt + 2 === gt || isSpace(lower[lt + 2]))) {
      let end = text.length;
      for (const at of [nextAEnd(gt), nextDt(gt), nextDl(gt), nextDlEnd(gt)]) if (at >= 0 && at < end) end = at;
      i = end; // a closing </a> is skipped as an unknown tag on the next turn
      const attrs = text.slice(lt + 2, Math.min(gt, lt + 2 + MAX_ATTRS));
      const href = /\bHREF\s*=\s*"([^"]*)"/i.exec(attrs) || /\bHREF\s*=\s*'([^']*)'/i.exec(attrs);
      const url = href ? unescapeHtml(href[1]).trim() : "";
      if (!storable(url)) continue;
      const added = /\bADD_DATE\s*=\s*"?([0-9]+)/i.exec(attrs);
      out.push({
        url,
        title: unescapeHtml(stripTags(text.slice(gt + 1, Math.min(end, gt + 1 + 4 * MAX_TITLE)))).trim().slice(0, MAX_TITLE),
        folder: normFolder(stack.filter(Boolean).join("/")),
        at: added ? Number(added[1]) * 1000 : 0,
      });
    }
  }
  return out;
}

module.exports = {
  BAR_FOLDERS, MAX_BOOKMARKS, MAX_HISTORY, MAX_IMPORT_CHARS,
  barModel, createLibrary, exportNetscape, normFolder, parseNetscape, storable,
};
