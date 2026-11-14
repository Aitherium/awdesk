"use strict";

/**
 * browser-verbs.cjs -- the Aither Browser from Alt+Space (owner 2026-11-13: "and
 * integrate with the Alt+Space hot key and whatnot?"). Same shape as desk-verbs.cjs:
 * the first word is the verb, the rows are plain data, the launcher runs them BY KEY.
 *
 *   example.com | https://...          open the address in a tab of yours
 *   go <address>                        the same, said out loud
 *   search <words>                      a web search in the browser
 *   private <address>   (inprivate)     the address in an InPrivate tab
 *   history <words>                     pages YOU visited; Enter opens one
 *   bookmark <words>    (bookmarks)     your bookmarks; Enter opens one
 *   tab <words>         (tabs)          switch to one of your open tabs
 *   find <words>                        find on the page in your active tab
 *   extension <store address>           add a Chrome Web Store / Edge Add-ons extension
 *
 * A bare verb that is also an ordinary word ("history", "tab", "find", "private",
 * "bookmarks") and a bare address without a scheme ("node.js" is also an app) keep
 * the normal search underneath their rows (`keepSearch`). `?` stays Ask Aither and
 * `!private` stays the hidden-results reveal: neither is parsed here.
 *
 * Every row runs a command-registry row (`browser.*`), so the launcher, the palette
 * and the tray share ONE implementation (browser-window.browserCommand). The lists
 * are the OWNER's: history rows are pages the owner visited (never an agent's visit,
 * never InPrivate, which is not recorded at all), and tab rows leave out agent and
 * InPrivate tabs. This module only shapes rows -- it never reads the library itself.
 *
 * Pure, so browser-verbs.test.cjs asserts every verb under `node --test`.
 */

const { parseExtensionId } = require("./browser-webstore.cjs");

const ALIASES = Object.freeze({
  go: "go",
  search: "search",
  private: "private", inprivate: "private", incognito: "private",
  history: "history",
  bookmark: "bookmark", bookmarks: "bookmark",
  tab: "tab", tabs: "tab",
  find: "find",
  extension: "extension",
});

/** Rows a list verb answers with, at most (the launcher shows five and "+N more"). */
const MAX_ROWS = 8;
const MAX_ARG = 300;

// "notes.txt", "main.rs", "setup.exe": a file name, not a host. Said with `go` it still opens.
const FILE_EXT = /\.(txt|md|pdf|docx?|xlsx?|pptx?|csv|json|ya?ml|toml|ini|log|js|cjs|mjs|ts|tsx|jsx|py|ps1|sh|bat|cmd|exe|msi|zip|7z|rar|png|jpe?g|gif|webp|svg|mp[34]|wav|mov|mkv|html?|css|xml|c|h|cpp|cs|rs|java|rb|php|sql|lnk|dll|iso)$/i;
const BARE_HOST = /^(localhost|[\w-]+(\.[\w-]+)+)(:\d+)?([/?#]\S*)?$/i;
const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/;

/**
 * Is this ONE token an address the browser opens? Returns what to show ("https://…")
 * or null. `strict` is the bare-token rule: a file name or a version number ("v1.2")
 * is not offered as a site; after `go` anything host-shaped is taken at its word.
 */
function addressOf(text, { strict = true } = {}) {
  const t = String(text == null ? "" : text).trim();
  if (!t || /\s/.test(t) || t.length > 2048) return null;
  if (/^aither:\/\/[a-z0-9-]+/i.test(t)) return t;
  if (/^https?:\/\//i.test(t)) {
    try { return new URL(t).hostname ? t : null; } catch { return null; }
  }
  // Any other scheme (file:, javascript:, mailto:) is not something a tab opens here.
  if (/^[a-z][a-z0-9+.-]*:(?!\d)/i.test(t)) return null;
  const m = BARE_HOST.exec(t);
  if (!m) return null;
  const host = m[1];
  if (strict && host.toLowerCase() !== "localhost" && !IPV4.test(host)) {
    const tld = host.slice(host.lastIndexOf(".") + 1);
    if (!/^[a-z]{2,}$/i.test(tld)) return null;
    if (!m[4] && FILE_EXT.test(host)) return null;
  }
  return `https://${t}`;
}

/**
 * The browser verb in a launcher query, or null when the text is an ordinary search.
 * @param {string} text
 * @returns {null | {verb: string, arg: string, bare: boolean, keepSearch: boolean, target?: string, url?: string, word?: string}}
 */
function parseBrowserVerb(text) {
  const raw = String(text == null ? "" : text).trim();
  if (!raw || /^[>?@!]/.test(raw)) return null;
  if (!/\s/.test(raw)) {
    const url = addressOf(raw);
    // A typed scheme can only be an address; "node.js" is also an app, so search stays.
    if (url) return { verb: "go", arg: raw, bare: false, url, keepSearch: !/^(https?|aither):\/\//i.test(raw) };
  }
  const m = /^(\S+)(?:\s+([\s\S]*))?$/.exec(raw);
  if (!m) return null;
  const word = m[1].toLowerCase();
  const verb = ALIASES[word];
  if (!verb) return null;
  const arg = String(m[2] || "").replace(/\s+/g, " ").trim().slice(0, MAX_ARG);
  const out = { verb, arg, bare: !arg, keepSearch: !arg, word };
  if (verb === "go") {
    // "go pro", "go": an ordinary search.
    const url = addressOf(arg, { strict: false });
    if (!url) return null;
    out.url = url;
  } else if (verb === "search") {
    if (!arg) return null;
  } else if (verb === "private") {
    if (!arg) out.target = "new";
    else {
      // "private equity": an ordinary search.
      const url = addressOf(arg, { strict: false });
      if (!url || /^aither:/i.test(url)) return null;
      out.target = "url";
      out.url = url;
    }
  } else if (verb === "history" || verb === "bookmark" || verb === "tab") {
    out.target = arg ? "match" : "page";
  } else if (verb === "find") {
    out.target = arg ? "text" : "bar";
  } else if (verb === "extension") {
    // Only a store page's address; "extension cord" is an ordinary search.
    if (!arg || /\s/.test(arg) || !parseExtensionId(arg).ok) return null;
    out.url = arg;
  }
  return out;
}

/** Entries ({url, title}) containing EVERY word of `words`, in their given order. */
function matchEntries(entries, words) {
  const want = String(words == null ? "" : words).toLowerCase().split(/\s+/).filter(Boolean);
  const list = Array.isArray(entries) ? entries : [];
  if (!want.length) return list.slice();
  return list.filter((e) => {
    const hay = `${(e && e.title) || ""} ${(e && e.url) || ""}`.toLowerCase();
    return want.every((w) => hay.includes(w));
  });
}

function clip(text, max) {
  const s = String(text || "").replace(/\s+/g, " ").trim();
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

function row(key, title, subtitle, id, arg, kind = "browser") {
  return { key: `verb:b-${key}`, kind, title, subtitle, action: arg === undefined ? { type: "command", id } : { type: "command", id, arg } };
}

/**
 * The launcher rows a browser verb answers with. Every action is
 * {type: "command", id, arg?}: a `browser.*` registry row, run by main.
 *
 * @param {ReturnType<typeof parseBrowserVerb>} v
 * @param {{history?: object[], bookmarks?: object[], tabs?: object[]}} [ctx]
 *   history    the owner's own visits matching v.arg ({url, title}), newest first
 *   bookmarks  the owner's bookmarks matching v.arg ({url, title, folder})
 *   tabs       the owner's open tabs ({id, url, title, active}); agent and InPrivate tabs left out
 * @returns {{rows: object[], status: string}}
 */
function verbRows(v, { history = [], bookmarks = [], tabs = [] } = {}) {
  if (!v) return { rows: [], status: "" };
  if (v.verb === "go") {
    const rows = [row("go", `Open ${clip(v.url, 70)}`, "A new tab of yours in the Aither browser", "browser.go", v.arg)];
    if (!/^aither:/i.test(v.url)) rows.push(row("go-private", "Open it InPrivate", "Nothing kept: no history, cookies gone when it closes", "browser.tab.private", v.arg));
    return { rows, status: "Enter opens it in the Aither browser" };
  }
  if (v.verb === "search") {
    return { rows: [row("search", `Search the web for “${clip(v.arg, 60)}”`, "In the Aither browser", "browser.search", v.arg)],
      status: "Enter searches the web" };
  }
  if (v.verb === "private") {
    if (v.target === "new") {
      return { rows: [row("private", "New InPrivate tab", "Nothing kept: no history, cookies gone when it closes", "browser.tab.private")],
        status: "private <address> opens that page InPrivate" };
    }
    return { rows: [row("private", `Open ${clip(v.url, 70)} InPrivate`, "Nothing kept: no history, cookies gone when it closes", "browser.tab.private", v.arg)],
      status: "Enter opens it InPrivate" };
  }
  if (v.verb === "history") {
    const page = row("history-page", "Open History", "aither://history — every page, search and delete", "browser.history");
    if (v.target === "page") return { rows: [page], status: "history <words> finds a page you visited" };
    const hits = matchEntries(history, v.arg).slice(0, MAX_ROWS);
    const rows = hits.map((h, i) => row(`history-${i}`, clip(h.title || h.url, 80), clip(h.url, 110), "browser.go", h.url, "history"));
    return { rows: [...rows, page], status: hits.length
      ? `${hits.length} page${hits.length === 1 ? "" : "s"} from your history · Enter opens the top one`
      : `0 pages in your history match “${clip(v.arg, 40)}”` };
  }
  if (v.verb === "bookmark") {
    const page = row("bookmarks-page", "Open Bookmarks", "aither://bookmarks — folders, rename, import, export", "browser.bookmarks");
    if (v.target === "page") {
      const star = row("bookmark-page", "Bookmark this page", "The page in your active tab (again removes it)", "browser.bookmark-page");
      return { rows: v.word === "bookmark" ? [star, page] : [page, star], status: "bookmark <words> finds one of your bookmarks" };
    }
    const hits = matchEntries(bookmarks, v.arg).slice(0, MAX_ROWS);
    const rows = hits.map((b, i) => row(`bookmark-${i}`, clip(b.title || b.url, 80),
      clip(`${b.folder ? `${b.folder} · ` : ""}${b.url}`, 110), "browser.go", b.url, "bookmark"));
    return { rows: [...rows, page], status: hits.length
      ? `${hits.length} bookmark${hits.length === 1 ? "" : "s"} · Enter opens the top one`
      : `0 bookmarks match “${clip(v.arg, 40)}”` };
  }
  if (v.verb === "tab") {
    const mine = v.target === "match" ? matchEntries(tabs, v.arg) : (Array.isArray(tabs) ? tabs : []);
    const rows = mine.slice(0, MAX_ROWS).map((t) => row(`tab-${t.id}`, clip(t.title || t.url || "Tab", 80),
      clip(`${t.active ? "On screen · " : ""}${t.url || ""}`, 110), "browser.tab.switch", `#${t.id}`, "tab"));
    if (v.target === "page") rows.push(row("tab-new", "New tab", "In the Aither browser", "browser.tab.new"));
    return { rows, status: mine.length
      ? `${mine.length} open tab${mine.length === 1 ? "" : "s"}${v.target === "match" ? " match" : ""} · Enter switches to it`
      : v.target === "match" ? `0 open tabs match “${clip(v.arg, 40)}”` : "0 tabs open — Enter opens one" };
  }
  if (v.verb === "find") {
    if (v.target === "bar") {
      return { rows: [row("find", "Find on this page", "The page in your active tab", "browser.find")], status: "find <words> looks for them on the page" };
    }
    return { rows: [row("find", `Find “${clip(v.arg, 60)}” on this page`, "The page in your active tab", "browser.find", v.arg)],
      status: "Enter finds it on the page" };
  }
  if (v.verb === "extension") {
    return { rows: [row("extension", "Add this extension to Aither", clip(v.url, 110), "browser.extension.add", v.url)],
      status: "Enter downloads it and asks before it is added" };
  }
  return { rows: [], status: "" };
}

/** The verb rows as ONE launcher group (the page renders it like any other). */
function verbGroup(v, rows) {
  if (!v || !rows || !rows.length) return null;
  const label = { go: "Aither browser", search: "Web search", private: "InPrivate", history: "History", bookmark: "Bookmarks",
    tab: "Open tabs", find: "Find on page", extension: "Extensions" }[v.verb] || "Browser";
  return { id: "verbs", label, total: rows.length, items: rows.map((r) => ({ key: r.key, kind: r.kind, title: r.title, subtitle: r.subtitle })) };
}

module.exports = { ALIASES, MAX_ROWS, addressOf, matchEntries, parseBrowserVerb, verbRows, verbGroup };
