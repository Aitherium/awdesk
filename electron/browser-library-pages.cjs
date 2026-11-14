"use strict";

/**
 * browser-library-pages.cjs -- the Aither Browser's own pages, like edge://history:
 *
 *   aither://history      what was visited, by you or an agent; search, delete, clear
 *   aither://bookmarks    list, search, rename, move, delete, folders, import / export
 *   aither://downloads    the downloads shelf as a page
 *   aither://permissions  what each site may use (camera, microphone, ...); take it back
 *   aither://clear-data   clear history, cookies and site data, cache, saved passwords
 *
 * The data was already kept (browser-library.cjs, browser-downloads.cjs); there was no
 * page to see it, so Ctrl+H opened nothing and a bookmark could only be starred.
 *
 * The fence: every channel answers ONE page. A channel's own pane is in CHANNELS, and
 * the sender must be showing that aither:// page; another Aither page, a web page or
 * the toolbar gets "not this page". No agent tool reaches these channels: an agent's
 * tab is a web tab with no preload, and it can never open an aither:// address.
 *
 * Anything that destroys more than one row asks the owner first, in a dialog MAIN
 * draws (host.confirm), so a page script cannot answer for them. A page never names a
 * file: export and import go through main's own save / open dialogs.
 *
 * Pure: no electron at module load. browser-window.cjs installs the host.
 */

const fs = require("node:fs");
const libraryMod = require("./browser-library.cjs");

/** The pages this module answers, by pane id. */
const PAGES = Object.freeze(["history", "bookmarks", "downloads", "permissions", "clear-data"]);

/** How far back "Clear browsing data" and "Delete a range" may reach, in ms (all = everything). */
const RANGES = Object.freeze({
  hour: 60 * 60 * 1000,
  day: 24 * 60 * 60 * 1000,
  week: 7 * 24 * 60 * 60 * 1000,
  month: 28 * 24 * 60 * 60 * 1000,
  all: 0,
});
const RANGE_LABELS = Object.freeze({
  hour: "the last hour", day: "the last 24 hours", week: "the last 7 days", month: "the last 4 weeks", all: "all time",
});

const MAX_TEXT = 300;
const MAX_URL = 4096;

function text(value, max = MAX_TEXT) {
  return typeof value === "string" ? value.slice(0, max) : "";
}

/** The pane an aither:// sender is showing ("history"), or "" for anything else. */
function paneOf(sender) {
  try {
    const url = new URL(sender.getURL());
    return url.protocol === "aither:" ? url.hostname.toLowerCase() : "";
  } catch {
    return "";
  }
}

/**
 * What a "Clear browsing data" request will do, from the page's checkboxes. Pure.
 * Cookies and the cache have no dates Chromium lets us read here, so a range shorter
 * than "all time" still clears ALL of them; `lines` says so in the confirm.
 * @returns {{ok: true, history: boolean, cookies: boolean, cache: boolean, passwords: boolean,
 *   range: string, since: number, lines: string[]} | {ok: false, error: string}}
 */
function clearPlan(input = {}, now = Date.now()) {
  const range = Object.prototype.hasOwnProperty.call(RANGES, input && input.range) ? input.range : "";
  if (!range) return { ok: false, error: "choose a time range" };
  const plan = {
    ok: true,
    history: Boolean(input.history),
    cookies: Boolean(input.cookies),
    cache: Boolean(input.cache),
    passwords: Boolean(input.passwords),
    range,
    since: RANGES[range] ? now - RANGES[range] : 0,
    lines: [],
  };
  if (!plan.history && !plan.cookies && !plan.cache && !plan.passwords) return { ok: false, error: "nothing is ticked" };
  const when = RANGE_LABELS[range];
  const whole = range === "all" ? "" : " (all of it: this cannot be limited to a time range)";
  if (plan.history) plan.lines.push(`- Browsing history from ${when}`);
  if (plan.cookies) plan.lines.push(`- Cookies and site data${whole}. You will be signed out of websites.`);
  if (plan.cache) plan.lines.push(`- Cached images and files${whole}`);
  if (plan.passwords) plan.lines.push(`- Saved passwords from ${when}`);
  return plan;
}

/** A history row as the page gets it. */
function historyRow(h) {
  return { url: String(h.url), title: String(h.title || ""), at: Number(h.at) || 0, count: Number(h.count) || 1,
    by: h.by === "agent" ? "agent" : "you" };
}

/** A downloads row as the page gets it, with what its buttons may do. */
function downloadRow(row, shelf) {
  const done = row.state === "completed" && Boolean(row.path);
  return { ...row, canOpen: done, canShow: done, canRetry: shelf.retryable(row.id), canRemove: row.state !== "progressing" };
}

/**
 * The IPC handlers, by channel. `getHost` returns what browser-window installed:
 *   library() downloads() permissions()   the three stores
 *   open(url)            open a web address in an owner tab
 *   goto(pane)           show another library page
 *   openFile(path) showFile(path) download(url)
 *   confirm({message, detail, button}) -> Promise<boolean>   a dialog main draws
 *   pickSave({title, name}) / pickOpen({title}) -> Promise<string|null>   a file main picked
 *   clearData(plan) -> Promise<object>   passwordCount() -> number
 *   bar() -> boolean   setBar(on)   changed()
 */
function libraryHandlers({ getHost, pane = paneOf, now = () => Date.now(), fsImpl = fs } = {}) {
  const on = (pages, fn) => async (event, ...args) => {
    const from = event && event.sender ? pane(event.sender) : "";
    if (!from || !pages.includes(from)) return { ok: false, error: "not this page" };
    const h = typeof getHost === "function" ? getHost() : null;
    if (!h) return { ok: false, error: "the browser is not open" };
    try {
      return await fn(h, ...args);
    } catch (error) {
      return { ok: false, error: String((error && error.message) || error) };
    }
  };
  const done = (h, result) => { h.changed(); return result; };

  return {
    // ---------------------------------------------------------------- every library page
    "desk:library-open": on(PAGES, (h, url) => {
      const target = text(url, MAX_URL);
      if (!libraryMod.storable(target)) return { ok: false, error: "only web pages open from here" };
      return h.open(target) ? { ok: true } : { ok: false, error: "the tab did not open" };
    }),
    "desk:library-goto": on(PAGES, (h, page) => (PAGES.includes(page) && h.goto(page)
      ? { ok: true } : { ok: false, error: "no such page" })),

    // ---------------------------------------------------------------- aither://history
    "desk:library-history-list": on(["history"], (h, query = {}) => {
      const q = query && typeof query === "object" ? query : {};
      const page = h.library().historyPage({ q: text(q.q), by: text(q.by, 10), limit: Number(q.limit) || 200,
        offset: Number(q.offset) || 0 });
      return { ok: true, entries: page.entries.map(historyRow), total: page.total, now: now() };
    }),
    "desk:library-history-remove": on(["history"], (h, url) => done(h, { ok: h.library().removeHistory(text(url, MAX_URL)) })),
    "desk:library-history-remove-range": on(["history"], async (h, span = {}) => {
      const s = span && typeof span === "object" ? span : {};
      let from = Number(s.from) || 0;
      let to = s.to == null ? Infinity : Number(s.to);
      let what = text(s.label, 80) || "this range";
      if (Object.prototype.hasOwnProperty.call(RANGES, s.range) && s.range !== "all") {
        from = now() - RANGES[s.range];
        to = Infinity;
        what = RANGE_LABELS[s.range];
      }
      if (!(to > from)) return { ok: false, error: "that range is empty" };
      const yes = await h.confirm({ message: `Delete the history of ${what}?`, detail: "The pages stay bookmarked if they are.",
        button: "Delete" });
      if (!yes) return { ok: false, cancelled: true };
      return done(h, { ok: true, removed: h.library().removeHistoryRange({ from, to }) });
    }),
    "desk:library-history-clear": on(["history"], async (h) => {
      const yes = await h.confirm({ message: "Clear all browsing history?",
        detail: "Every visited page is forgotten, yours and your agents'. Bookmarks stay.", button: "Clear history" });
      if (!yes) return { ok: false, cancelled: true };
      h.library().clearHistory();
      return done(h, { ok: true });
    }),

    // ---------------------------------------------------------------- aither://bookmarks
    "desk:library-bookmarks-list": on(["bookmarks"], (h) => ({ ok: true, bookmarks: h.library().bookmarks(),
      folders: h.library().folders(), bar: Boolean(h.bar()), max: libraryMod.MAX_BOOKMARKS })),
    "desk:library-bookmarks-add": on(["bookmarks"], (h, row = {}) => {
      const r = row && typeof row === "object" ? row : {};
      return done(h, h.library().addBookmark({ url: text(r.url, MAX_URL).trim(), title: text(r.title), folder: text(r.folder) }));
    }),
    "desk:library-bookmarks-update": on(["bookmarks"], (h, url, patch = {}) => {
      const p = patch && typeof patch === "object" ? patch : {};
      const next = {};
      if (typeof p.title === "string") next.title = text(p.title);
      if (typeof p.folder === "string") next.folder = text(p.folder);
      if (typeof p.url === "string") next.url = text(p.url, MAX_URL).trim();
      return done(h, h.library().updateBookmark(text(url, MAX_URL), next));
    }),
    "desk:library-bookmarks-remove": on(["bookmarks"], (h, url) => done(h, { ok: h.library().removeBookmark(text(url, MAX_URL)) })),
    "desk:library-bookmarks-folder-add": on(["bookmarks"], (h, name) => {
      const folder = h.library().addFolder(text(name));
      return folder ? done(h, { ok: true, folder }) : { ok: false, error: "a folder needs a name" };
    }),
    "desk:library-bookmarks-folder-rename": on(["bookmarks"], (h, from, to) => {
      const src = libraryMod.normFolder(text(from));
      const dst = libraryMod.normFolder(text(to));
      if (!src || !dst) return { ok: false, error: "a folder needs a name" };
      if (src === dst) return { ok: true, moved: 0 };
      if (!h.library().folders().includes(src)) return { ok: false, error: "no such folder" };
      if (dst === src || dst.startsWith(`${src}/`)) return { ok: false, error: "a folder cannot move into itself" };
      return done(h, { ok: true, moved: h.library().renameFolder(src, dst) });
    }),
    "desk:library-bookmarks-folder-remove": on(["bookmarks"], async (h, name, keep) => {
      const folder = libraryMod.normFolder(text(name));
      if (!folder || !h.library().folders().includes(folder)) return { ok: false, error: "no such folder" };
      const inside = h.library().bookmarks().filter((b) => b.folder === folder || b.folder.startsWith(`${folder}/`)).length;
      if (inside && !keep) {
        const yes = await h.confirm({ message: `Delete the folder "${folder}" and its ${inside} bookmark${inside === 1 ? "" : "s"}?`,
          detail: "This cannot be undone.", button: "Delete" });
        if (!yes) return { ok: false, cancelled: true };
      }
      return done(h, { ok: true, removed: h.library().removeFolder(folder, { keep: Boolean(keep) }) });
    }),
    "desk:library-bookmarks-export": on(["bookmarks"], async (h) => {
      const file = await h.pickSave({ title: "Export bookmarks", name: "bookmarks.html" });
      if (!file) return { ok: false, cancelled: true };
      const rows = h.library().bookmarks();
      fsImpl.writeFileSync(file, libraryMod.exportNetscape(rows), "utf8");
      return { ok: true, count: rows.length, file };
    }),
    "desk:library-bookmarks-import": on(["bookmarks"], async (h) => {
      const file = await h.pickOpen({ title: "Import a bookmarks HTML file" });
      if (!file) return { ok: false, cancelled: true };
      // Read no more than the parser takes: a huge file is refused, not loaded.
      let size;
      try { size = fsImpl.statSync(file).size; } catch (error) { return { ok: false, error: `that file could not be read: ${error.message}` }; }
      if (size > libraryMod.MAX_IMPORT_CHARS) return { ok: false, error: "that file is too large to be a bookmarks file (over 20 MB)" };
      const rows = libraryMod.parseNetscape(fsImpl.readFileSync(file, "utf8"));
      if (!rows.length) return { ok: false, error: "that file holds no bookmarks" };
      const added = h.library().importEntries({ bookmarks: rows }).bookmarks;
      return done(h, { ok: true, found: rows.length, added });
    }),
    "desk:library-bookmarks-bar": on(["bookmarks"], (h, show) => {
      h.setBar(Boolean(show));
      return { ok: true, bar: Boolean(h.bar()) };
    }),

    // ---------------------------------------------------------------- aither://downloads
    "desk:library-downloads-list": on(["downloads"], (h) => {
      const shelf = h.downloads();
      return { ok: true, downloads: shelf.list().map((row) => downloadRow(row, shelf)) };
    }),
    "desk:library-downloads-open": on(["downloads"], async (h, id) => {
      const row = h.downloads().get(Number(id));
      if (!row || row.state !== "completed" || !row.path) return { ok: false, error: "that download has no finished file" };
      const error = await h.openFile(row.path);
      return error ? { ok: false, error: String(error) } : { ok: true };
    }),
    "desk:library-downloads-show": on(["downloads"], (h, id) => {
      const row = h.downloads().get(Number(id));
      if (!row || row.state !== "completed" || !row.path) return { ok: false, error: "that download has no finished file" };
      h.showFile(row.path);
      return { ok: true };
    }),
    "desk:library-downloads-retry": on(["downloads"], (h, id) => {
      const shelf = h.downloads();
      const row = shelf.get(Number(id));
      if (!row || !shelf.retryable(row.id)) return { ok: false, error: "that download cannot be tried again" };
      if (!h.download(row.url)) return { ok: false, error: "the download did not start" };
      shelf.remove(row.id);
      return done(h, { ok: true });
    }),
    "desk:library-downloads-remove": on(["downloads"], (h, id) => {
      const ok = h.downloads().remove(Number(id));
      return ok ? done(h, { ok: true }) : { ok: false, error: "a download in progress stays on the list" };
    }),
    "desk:library-downloads-clear": on(["downloads"], (h) => {
      h.downloads().clearFinished();
      return done(h, { ok: true });
    }),

    // ---------------------------------------------------------------- aither://permissions
    "desk:library-permissions-list": on(["permissions"], (h) => ({ ok: true, permissions: h.permissions().list() })),
    "desk:library-permissions-remove": on(["permissions"], (h, origin, kind) => {
      const site = text(origin, MAX_URL);
      const one = typeof kind === "string" && kind ? text(kind, 40) : null;
      const ok = h.permissions().remove(site, one);
      // The pages that are open lose it too: the site asks again without a reload.
      if (ok) h.revokePermission(site, one);
      return ok ? done(h, { ok: true }) : { ok: false, error: "nothing was remembered for that site" };
    }),
    "desk:library-permissions-clear": on(["permissions"], async (h) => {
      const yes = await h.confirm({ message: "Forget every site permission?",
        detail: "Every site asks again the next time it wants your camera, microphone, location, notifications or clipboard.",
        button: "Forget all" });
      if (!yes) return { ok: false, cancelled: true };
      const removed = h.permissions().clear();
      h.revokePermission(null, null);
      return done(h, { ok: true, removed });
    }),

    // ---------------------------------------------------------------- aither://clear-data
    "desk:library-clear-summary": on(["clear-data"], (h) => ({ ok: true,
      history: h.library().historyPage({ limit: 0 }).total, passwords: Number(h.passwordCount()) || 0,
      ranges: Object.keys(RANGES).map((id) => ({ id, label: RANGE_LABELS[id] })) })),
    "desk:library-clear-run": on(["clear-data"], async (h, input) => {
      const plan = clearPlan(input, now());
      if (!plan.ok) return plan;
      const yes = await h.confirm({ message: "Clear this browsing data?",
        detail: `${plan.lines.join("\n")}\n\nOnly your own browsing profile is cleared. Your AitherOS sign-in and your agents' browser session are kept.`,
        button: "Clear data" });
      if (!yes) return { ok: false, cancelled: true };
      const result = await h.clearData(plan);
      return done(h, { ok: true, ...result });
    }),
  };
}

/** Which page each channel answers: the fence, as data (asserted by the tests). */
const CHANNELS = Object.freeze(Object.fromEntries(Object.keys(libraryHandlers({ getHost: () => null })).map((channel) => {
  const m = /^desk:library-(history|bookmarks|downloads|permissions|clear)-/.exec(channel);
  return [channel, m ? (m[1] === "clear" ? "clear-data" : m[1]) : "*"];
})));

let host = null;
let wired = false;

function setLibraryHost(h) {
  host = h && typeof h.library === "function" ? h : null;
}

function ensureLibraryIpc() {
  if (wired) return;
  wired = true;
  const { ipcMain } = require("electron");
  for (const [channel, handler] of Object.entries(libraryHandlers({ getHost: () => host }))) ipcMain.handle(channel, handler);
}

module.exports = {
  CHANNELS, PAGES, RANGES, RANGE_LABELS,
  clearPlan, ensureLibraryIpc, libraryHandlers, paneOf, setLibraryHost,
};
