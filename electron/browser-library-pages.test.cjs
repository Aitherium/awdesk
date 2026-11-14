"use strict";

// The library pages' channels (browser-library-pages.cjs): each answers ONE aither://
// page, destructive calls wait on the owner's confirm, and a page never names a file.
// Also the library's own new parts: folders, the bookmarks bar, Netscape HTML, the
// history page's reads and deletes, and the keys that open the pages.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const pages = require("./browser-library-pages.cjs");
const lib = require("./browser-library.cjs");
const { createDownloads } = require("./browser-downloads.cjs");
const { createPermissionStore } = require("./browser-permissions.cjs");
const { keyAction } = require("./browser-everyday.cjs");
const policy = require("./browser-policy.cjs");
const internal = require("./browser-internal.cjs");
const { PANES } = require("./console-window.cjs");

const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), "awdesk-libpages-"));
const sender = (url) => ({ sender: { getURL: () => url } });

function rig({ confirm = true } = {}) {
  const dir = tmpDir();
  let t = 1000;
  const library = lib.createLibrary({ file: path.join(dir, "browser-library.json"), now: () => (t += 1000) });
  const downloads = createDownloads();
  const permissions = createPermissionStore({ file: path.join(dir, "browser-permissions.json") });
  const calls = { confirm: [], open: [], goto: [], download: [], changed: 0, historyCleared: 0, cleared: [], shown: [], opened: [], revoked: [] };
  let bar = false;
  const host = {
    library: () => library, downloads: () => downloads, permissions: () => permissions,
    revokePermission: (origin, kind) => { calls.revoked.push([origin, kind]); },
    open: (url) => { calls.open.push(url); return true; },
    goto: (pane) => { calls.goto.push(pane); return true; },
    openFile: async (file) => { calls.opened.push(file); return ""; },
    showFile: (file) => { calls.shown.push(file); },
    download: (url) => { calls.download.push(url); return true; },
    confirm: async (q) => { calls.confirm.push(q); return typeof confirm === "function" ? confirm(q) : confirm; },
    pickSave: async () => path.join(dir, "out.html"),
    pickOpen: async () => path.join(dir, "in.html"),
    clearData: async (plan) => { calls.cleared.push(plan); return { history: 2, errors: [] }; },
    passwordCount: () => 3,
    bar: () => bar, setBar: (on) => { bar = on; },
    changed: () => { calls.changed += 1; },
    historyCleared: () => { calls.historyCleared += 1; },
  };
  const handlers = pages.libraryHandlers({ getHost: () => host, now: () => 10_000_000 });
  const call = (pane, channel, ...args) => handlers[`desk:library-${channel}`](sender(`aither://${pane}/`), ...args);
  return { dir, library, downloads, permissions, calls, handlers, call, host };
}

test("every library page is a pane with the shared bridge, and its page exists", () => {
  for (const id of pages.PAGES) {
    const pane = PANES.find((p) => p.id === id);
    assert.ok(pane, `no pane ${id}`);
    assert.equal(pane.kind, "file");
    assert.match(pane.file, /^library-[a-z]+\.html$/);
    assert.ok(fs.existsSync(path.join(__dirname, pane.file)), pane.file);
    assert.equal(internal.preloadFor(pane), "library-preload.cjs");
    assert.equal(internal.preloadForUrl(`aither://${id}/`), "library-preload.cjs");
    // The page's own script and stylesheet are served to it; another page's HTML is not.
    assert.equal(internal.resolveRequest(`aither://${id}/library-page.js`).type, "file");
    assert.equal(internal.resolveRequest(`aither://${id}/library.css`).type, "file");
    assert.equal(internal.resolveRequest(`aither://${id}/library-preload.cjs`).type, "missing");
    const other = pages.PAGES.find((p) => p !== id);
    assert.equal(internal.resolveRequest(`aither://${id}/${PANES.find((p) => p.id === other).file}`).status, 403);
  }
});

test("the bridge names only channels main answers, and every channel is on the bridge", () => {
  const preload = fs.readFileSync(path.join(__dirname, "library-preload.cjs"), "utf8");
  const used = new Set([...preload.matchAll(/call\("([a-z-]+)"/g)].map((m) => `desk:library-${m[1]}`));
  assert.deepEqual([...used].sort(), Object.keys(pages.CHANNELS).sort());
  assert.deepEqual([...preload.matchAll(/exposeInMainWorld\("([^"]+)"/g)].map((m) => m[1]), ["aitherLibrary"]);
});

test("every channel answers only its own aither:// page", async () => {
  const { handlers } = rig();
  const strangers = ["https://evil.test/", "aither://settings/", "aither://extensions/", "file:///C:/x/library-history.html",
    "chrome-extension://abc/history.html", "about:blank", ""];
  for (const [channel, owner] of Object.entries(pages.CHANNELS)) {
    for (const url of strangers) {
      assert.deepEqual(await handlers[channel](sender(url), {}), { ok: false, error: "not this page" }, `${channel} from ${url}`);
    }
    // Another LIBRARY page is a stranger too (the history page cannot read bookmarks).
    for (const pane of pages.PAGES) {
      if (owner === "*" || pane === owner) continue;
      assert.deepEqual(await handlers[channel](sender(`aither://${pane}/`), {}), { ok: false, error: "not this page" },
        `${channel} from aither://${pane}`);
    }
    assert.deepEqual(await handlers[channel]({}, {}), { ok: false, error: "not this page" });
  }
  // A known page with no browser behind it says so instead of throwing.
  const cold = pages.libraryHandlers({ getHost: () => null });
  assert.deepEqual(await cold["desk:library-history-list"](sender("aither://history/")), { ok: false, error: "the browser is not open" });
});

test("no agent tool can reach the library: an agent never opens an aither:// page", () => {
  for (const id of pages.PAGES) {
    assert.equal(policy.sanitizeUrl(`aither://${id}/`).ok, false, id);
    assert.equal(policy.isNavigable(`aither://${id}/`), false, id);
    assert.equal(internal.navigationVerdict("web", `aither://${id}/`), "deny");
    assert.equal(internal.navigationVerdict("web", `aither://${id}/`, { frame: true }), "deny");
  }
  // The MCP browser tools have no history / bookmarks / passwords verb.
  const mcp = fs.readFileSync(path.join(__dirname, "mcp-server.cjs"), "utf8");
  const tools = [...mcp.matchAll(/["'](browser_[a-z_]+)["']/g)].map((m) => m[1]);
  assert.ok(tools.length > 5, "found the browser tools");
  for (const name of tools) assert.doesNotMatch(name, /history$|bookmark|password|download|permission/, name);
  assert.doesNotMatch(mcp, /desk:library-|getLibrary\(|getVault\(|getPermissionStore\(/);
});

test("history: listed newest first with who visited, searched, deleted one by one, by range and all", async () => {
  const r = rig();
  r.library.visit("https://a.test/one", "Alpha");
  r.library.visit("https://b.test/two", "Beta", "agent");
  r.library.visit("https://c.test/three", "Gamma");
  let got = await r.call("history", "history-list", {});
  assert.deepEqual(got.entries.map((h) => [h.title, h.by]), [["Gamma", "you"], ["Beta", "agent"], ["Alpha", "you"]]);
  assert.equal(got.total, 3);
  got = await r.call("history", "history-list", { q: "BETA" });
  assert.deepEqual(got.entries.map((h) => h.url), ["https://b.test/two"]);
  got = await r.call("history", "history-list", { by: "agent" });
  assert.equal(got.total, 1);
  got = await r.call("history", "history-list", { limit: 1, offset: 1 });
  assert.deepEqual([got.entries.length, got.entries[0].title, got.total], [1, "Beta", 3]);

  assert.deepEqual(await r.call("history", "history-remove", "https://b.test/two"), { ok: true });
  assert.deepEqual(await r.call("history", "history-remove", "https://b.test/two"), { ok: false });
  assert.equal(r.library.history().length, 2);

  // A range asks first; "no" deletes nothing.
  const no = rig({ confirm: false });
  no.library.visit("https://a.test/", "A");
  assert.deepEqual(await no.call("history", "history-remove-range", { from: 0, to: 9e15 }), { ok: false, cancelled: true });
  assert.equal(no.library.history().length, 1);
  assert.deepEqual(await no.call("history", "history-clear"), { ok: false, cancelled: true });
  assert.equal(no.library.history().length, 1);
  assert.equal(no.calls.historyCleared, 0, "a cancelled clear tells sync nothing");

  const at = r.library.history().map((h) => h.at); // [gamma, alpha]
  const ranged = await r.call("history", "history-remove-range", { from: at[0], to: at[0] + 1, label: "today" });
  assert.deepEqual(ranged, { ok: true, removed: 1 });
  assert.match(r.calls.confirm.at(-1).message, /today/);
  assert.deepEqual(r.library.history().map((h) => h.title), ["Alpha"]);
  assert.equal((await r.call("history", "history-remove-range", { from: 5, to: 5 })).ok, false, "an empty range");
  // Deleting one visit or a range is not "all history": only the full clear tells sync,
  // so the account's store does not hand the cleared history back (browser-sync.cjs).
  assert.equal(r.calls.historyCleared, 0);
  assert.deepEqual(await r.call("history", "history-clear"), { ok: true });
  assert.equal(r.library.history().length, 0);
  assert.equal(r.calls.historyCleared, 1);
  assert.ok(r.calls.changed >= 3);
});

test("history: a named range reaches back from now", async () => {
  const dir = tmpDir();
  let clock = 0;
  const library = lib.createLibrary({ file: path.join(dir, "l.json"), now: () => clock });
  const now = 100 * 24 * 3600 * 1000;
  clock = now - 30 * 60 * 1000; library.visit("https://recent.test/", "recent");
  clock = now - 3 * 3600 * 1000; library.visit("https://older.test/", "older");
  const handlers = pages.libraryHandlers({ now: () => now, getHost: () => ({ library: () => library, confirm: async () => true, changed() {} }) });
  const res = await handlers["desk:library-history-remove-range"](sender("aither://history/"), { range: "hour" });
  assert.deepEqual(res, { ok: true, removed: 1 });
  assert.deepEqual(library.history().map((h) => h.title), ["older"]);
});

test("bookmarks: add, rename, move, delete; folders are made, renamed and removed", async () => {
  const r = rig();
  assert.deepEqual(await r.call("bookmarks", "bookmarks-add", { url: "https://a.test/", title: "A", folder: " Work / Docs " }), { ok: true, added: true });
  assert.deepEqual(await r.call("bookmarks", "bookmarks-add", { url: "https://b.test/", title: "B" }), { ok: true, added: true });
  assert.equal((await r.call("bookmarks", "bookmarks-add", { url: "javascript:alert(1)" })).ok, false);
  assert.equal((await r.call("bookmarks", "bookmarks-add", { url: "file:///C:/x" })).ok, false);
  let got = await r.call("bookmarks", "bookmarks-list");
  assert.deepEqual(got.bookmarks.map((b) => [b.title, b.folder]), [["B", ""], ["A", "Work/Docs"]]);
  assert.deepEqual(got.folders, ["Work", "Work/Docs"]);
  assert.equal(got.bar, false);

  assert.deepEqual(await r.call("bookmarks", "bookmarks-update", "https://b.test/", { title: "Bee", folder: "Work" }), { ok: true });
  assert.equal((await r.call("bookmarks", "bookmarks-update", "https://b.test/", { url: "https://a.test/" })).ok, false, "a taken address");
  assert.equal((await r.call("bookmarks", "bookmarks-update", "https://nope.test/", { title: "x" })).ok, false);
  assert.deepEqual(await r.call("bookmarks", "bookmarks-update", "https://b.test/", { url: "https://bee.test/" }), { ok: true });
  assert.ok(r.library.isBookmarked("https://bee.test/") && !r.library.isBookmarked("https://b.test/"));

  assert.deepEqual(await r.call("bookmarks", "bookmarks-folder-add", "Later"), { ok: true, folder: "Later" });
  assert.equal((await r.call("bookmarks", "bookmarks-folder-add", " / ")).ok, false);
  assert.deepEqual(await r.call("bookmarks", "bookmarks-folder-rename", "Work", "Job"), { ok: true, moved: 2 });
  assert.equal((await r.call("bookmarks", "bookmarks-folder-rename", "Job", "Job/Inner")).ok, false, "not into itself");
  assert.equal((await r.call("bookmarks", "bookmarks-folder-rename", "Ghost", "X")).ok, false);
  got = await r.call("bookmarks", "bookmarks-list");
  assert.deepEqual(got.folders, ["Job", "Job/Docs", "Later"]);

  // Deleting a folder WITH bookmarks asks; keeping them does not.
  assert.deepEqual(await r.call("bookmarks", "bookmarks-folder-remove", "Job/Docs", true), { ok: true, removed: 1 });
  assert.equal(r.calls.confirm.length, 0);
  assert.deepEqual(await r.call("bookmarks", "bookmarks-folder-remove", "Job", false), { ok: true, removed: 1 });
  assert.match(r.calls.confirm[0].message, /"Job" and its 1 bookmark\?/);
  assert.deepEqual(r.library.bookmarks().map((b) => [b.url, b.folder]), [["https://a.test/", ""]]);
  assert.deepEqual(await r.call("bookmarks", "bookmarks-remove", "https://a.test/"), { ok: true });
  assert.deepEqual(await r.call("bookmarks", "bookmarks-remove", "https://a.test/"), { ok: false });

  const no = rig({ confirm: false });
  no.library.addBookmark({ url: "https://k.test/", folder: "Keep" });
  assert.deepEqual(await no.call("bookmarks", "bookmarks-folder-remove", "Keep", false), { ok: false, cancelled: true });
  assert.equal(no.library.bookmarks().length, 1);

  assert.deepEqual(await r.call("bookmarks", "bookmarks-bar", true), { ok: true, bar: true });
});

test("bookmarks: export writes the Netscape file main picked; import reads one back with its folders", async () => {
  const r = rig();
  r.library.addBookmark({ url: "https://a.test/?x=1&y=<2>", title: "A & \"B\"", folder: "Favorites bar" });
  r.library.addBookmark({ url: "https://c.test/", title: "C", folder: "Work/Docs" });
  r.library.addBookmark({ url: "https://top.test/", title: "Top" });
  const out = await r.call("bookmarks", "bookmarks-export");
  assert.deepEqual([out.ok, out.count, out.file], [true, 3, path.join(r.dir, "out.html")]);
  const html = fs.readFileSync(out.file, "utf8");
  assert.match(html, /^<!DOCTYPE NETSCAPE-Bookmark-file-1>/);
  assert.match(html, /<H3 PERSONAL_TOOLBAR_FOLDER="true">Favorites bar<\/H3>/);
  assert.match(html, /HREF="https:\/\/a\.test\/\?x=1&amp;y=&lt;2&gt;"/);
  assert.doesNotMatch(html, /<2>/);

  // Round trip into an empty library.
  const back = rig();
  fs.writeFileSync(path.join(back.dir, "in.html"), html);
  assert.deepEqual(await back.call("bookmarks", "bookmarks-import"), { ok: true, found: 3, added: 3 });
  const byUrl = Object.fromEntries(back.library.bookmarks().map((b) => [b.url, b]));
  assert.equal(byUrl["https://a.test/?x=1&y=<2>"].title, "A & \"B\"");
  assert.equal(byUrl["https://a.test/?x=1&y=<2>"].folder, "Favorites bar");
  assert.equal(byUrl["https://c.test/"].folder, "Work/Docs");
  assert.equal(byUrl["https://top.test/"].folder, "");
  // Importing the same file again adds nothing.
  assert.deepEqual(await back.call("bookmarks", "bookmarks-import"), { ok: true, found: 3, added: 0 });
  fs.writeFileSync(path.join(back.dir, "in.html"), "<html>nothing here</html>");
  assert.equal((await back.call("bookmarks", "bookmarks-import")).ok, false);
});

test("Netscape HTML from other browsers: nested folders, entities, and only web links", () => {
  const html = `<!DOCTYPE NETSCAPE-Bookmark-file-1>
<DL><p>
  <DT><H3 ADD_DATE="1" PERSONAL_TOOLBAR_FOLDER="true">Favorites bar</H3>
  <DL><p>
    <DT><A HREF="https://one.test/" ADD_DATE="1700000000" ICON="data:image/png;base64,AAAA">One &amp; only</A>
    <DT><H3>Deep &lt;er&gt;</H3>
    <DL><p>
      <DT><A HREF='https://two.test/a?b=1&amp;c=2'>Two</A>
    </DL><p>
    <DT><A HREF="javascript:alert(1)">Bookmarklet</A>
    <DT><A HREF="file:///C:/secret.txt">File</A>
  </DL><p>
  <DT><A HREF="https://three.test/">Three &#233;&#x1F600;</A>
</DL><p>`;
  assert.deepEqual(lib.parseNetscape(html), [
    { url: "https://one.test/", title: "One & only", folder: "Favorites bar", at: 1700000000000 },
    { url: "https://two.test/a?b=1&c=2", title: "Two", folder: "Favorites bar/Deep <er>", at: 0 },
    { url: "https://three.test/", title: "Three \u00e9\u{1F600}", folder: "", at: 0 },
  ]);
  assert.deepEqual(lib.parseNetscape(""), []);
  assert.equal(lib.parseNetscape(html, { max: 1 }).length, 1);
});

test("a broken bookmarks file is read in one pass: unclosed tags cannot freeze the desk", () => {
  const fill = (unit, chars) => unit.repeat(Math.ceil(chars / unit.length));
  const MB = 1024 * 1024;
  // Each of these took the old pattern-based reader minutes (it grew 4x per doubling).
  for (const [name, text] of [
    ["an <A that never closes its tag", fill("<A x ", MB)],
    ["links with no </A>", fill('<A HREF="https://a.test/">x', MB)],
    ["folders with no </H3>", fill("<DT><H3>x", MB)],
    ["only <", fill("<", MB)],
    ["a quote that never closes", fill('<A HREF="x ', MB)],
  ]) {
    const t = process.hrtime.bigint();
    lib.parseNetscape(text);
    const ms = Number(process.hrtime.bigint() - t) / 1e6;
    assert.ok(ms < 1500, `${name}: 1 MB took ${Math.round(ms)} ms`);
  }
  // A link with no </A> ends at the next <DT>; the links after it are still read.
  assert.deepEqual(lib.parseNetscape('<DL><DT><A HREF="https://a.test/">A <b>one</b>\n<DT><a href="https://b.test/">B</a>\n</DL><DT><A HREF="https://c.test/">C')
    .map((b) => [b.url, b.title]), [["https://a.test/", "A one"], ["https://b.test/", "B"], ["https://c.test/", "C"]]);
  // <ABBR>, <ADDRESS>, <DLX> are not links or folders.
  assert.deepEqual(lib.parseNetscape('<ABBR HREF="https://x.test/">x</ABBR><ADDRESS>y</ADDRESS><A HREF="https://ok.test/">ok</A>')
    .map((b) => b.url), ["https://ok.test/"]);
});

test("a file too large to be a bookmarks file is refused before it is read", async () => {
  const r = rig();
  let read = 0;
  const fsImpl = { statSync: () => ({ size: lib.MAX_IMPORT_CHARS + 1 }), readFileSync: () => { read += 1; return ""; } };
  const handlers = pages.libraryHandlers({ getHost: () => r.host, fsImpl });
  const got = await handlers["desk:library-bookmarks-import"](sender("aither://bookmarks/"));
  assert.equal(got.ok, false);
  assert.match(got.error, /too large/);
  assert.equal(read, 0, "the file was not read");
});

test("folders are optional: a file written before folders existed reads unchanged, and Edge's folders import", () => {
  const dir = tmpDir();
  const file = path.join(dir, "browser-library.json");
  fs.writeFileSync(file, JSON.stringify({ version: 1, history: [{ url: "https://h.test/", title: "H", at: 5, count: 1, by: "you" }],
    bookmarks: [{ url: "https://old.test/", title: "Old", at: 1 }] }));
  const library = lib.createLibrary({ file });
  assert.deepEqual(library.bookmarks(), [{ url: "https://old.test/", title: "Old", at: 1, folder: "" }]);
  assert.deepEqual(library.folders(), []);
  assert.equal(library.isBookmarked("https://old.test/"), true);
  // What browser-edge-import parseBookmarks hands over: {url, title, folder}.
  assert.deepEqual(library.importEntries({ bookmarks: [
    { url: "https://e.test/", title: "E", folder: "Favorites bar/Work" }, { url: "https://f.test/", title: "F", folder: "" },
  ] }), { bookmarks: 2, history: 0 });
  assert.deepEqual(library.folders(), ["Favorites bar", "Favorites bar/Work"]);
  // The star still works and writes no folder key (the old shape).
  library.toggleBookmark("https://star.test/", "Star");
  const disk = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.equal(disk.version, 1);
  assert.deepEqual(Object.keys(disk.bookmarks.find((b) => b.url === "https://star.test/")).sort(), ["at", "title", "url"]);
  assert.equal(disk.bookmarks.find((b) => b.url === "https://e.test/").folder, "Favorites bar/Work");
  // A folder name cannot smuggle control characters or grow without bound.
  assert.equal(lib.normFolder(" a /\u0007 b // c "), "a/b/c");
  assert.equal(lib.normFolder("x".repeat(999)).length, 200);
  assert.equal(lib.normFolder(null), "");
});

test("the bookmarks bar: top-level and Favorites-bar bookmarks as buttons, other folders as menus", () => {
  const model = lib.barModel([
    { url: "https://a.test/", title: "A" },
    { url: "https://b.test/", title: "B", folder: "Favorites bar" },
    { url: "https://c.test/", title: "C", folder: "Work" },
    { url: "https://d.test/", title: "D", folder: "Work" },
    { url: "https://e.test/", title: "E", folder: "Favorites bar/Trips" },
    { url: "javascript:1", title: "no" },
  ]);
  assert.deepEqual(model.items, [{ url: "https://a.test/", title: "A" }, { url: "https://b.test/", title: "B" }]);
  assert.deepEqual(model.folders, [{ name: "Favorites bar/Trips", count: 1 }, { name: "Work", count: 2 }]);
  assert.deepEqual(lib.barModel(null), { items: [], folders: [] });
  assert.equal(lib.barModel(Array.from({ length: 90 }, (_, i) => ({ url: `https://x${i}.test/` }))).items.length, 40);
});

test("the bar and its page stay in step with the chrome height", () => {
  const src = fs.readFileSync(path.join(__dirname, "browser-window.cjs"), "utf8");
  const html = fs.readFileSync(path.join(__dirname, "browser-chrome.html"), "utf8");
  const bar = Number(/const BOOKMARKS_BAR_HEIGHT = (\d+);/.exec(src)[1]);
  const chrome = Number(/const CHROME_HEIGHT = (\d+);/.exec(src)[1]);
  assert.match(html, new RegExp(`#top \\{[^}]*height: var\\(--chrome-h, ${chrome}px\\)`));
  assert.match(html, new RegExp(`#bmbar \\{ height: ${bar}px;`));
  assert.match(src, /return CHROME_HEIGHT \+ \(getPrefs\(\)\.bookmarksBar \? BOOKMARKS_BAR_HEIGHT : 0\);/);
  // Every layout reads chromeHeight(), never the bare constant.
  assert.doesNotMatch(src, /chromeHeight: CHROME_HEIGHT|top: CHROME_HEIGHT/);
  // Off by default.
  assert.equal(require("./browser-rail.cjs").normalizeLayout({}).bookmarksBar, false);
});

test("downloads: open and show only a finished file, retry what failed, remove, clear", async () => {
  const r = rig();
  const done = r.downloads.start({ filename: "a.zip", url: "https://a.test/a.zip", total: 10 });
  r.downloads.update(done, { state: "completed", received: 10, path: "C:\\Users\\x\\Downloads\\a.zip" });
  const failed = r.downloads.start({ filename: "b.zip", url: "https://b.test/b.zip" });
  r.downloads.update(failed, { state: "interrupted" });
  const running = r.downloads.start({ filename: "c.zip", url: "https://c.test/c.zip" });
  const blocked = r.downloads.start({ filename: "d.zip", url: "https://d.test/d.zip", blocked: true });
  const got = await r.call("downloads", "downloads-list");
  const by = Object.fromEntries(got.downloads.map((d) => [d.filename, d]));
  assert.deepEqual([by["a.zip"].canOpen, by["a.zip"].canShow, by["a.zip"].canRetry, by["a.zip"].canRemove], [true, true, false, true]);
  assert.deepEqual([by["b.zip"].canOpen, by["b.zip"].canRetry], [false, true]);
  assert.deepEqual([by["c.zip"].canRetry, by["c.zip"].canRemove], [false, false]);
  assert.equal(by["d.zip"].canRetry, true);

  assert.deepEqual(await r.call("downloads", "downloads-open", done), { ok: true });
  assert.deepEqual(r.calls.opened, ["C:\\Users\\x\\Downloads\\a.zip"]);
  assert.equal((await r.call("downloads", "downloads-open", failed)).ok, false);
  assert.equal((await r.call("downloads", "downloads-show", running)).ok, false);
  assert.deepEqual(await r.call("downloads", "downloads-show", done), { ok: true });
  // The page hands an id, never a path: a made-up id opens nothing.
  assert.equal((await r.call("downloads", "downloads-open", "C:\\Windows\\System32\\calc.exe")).ok, false);
  assert.equal(r.calls.opened.length, 1);

  assert.deepEqual(await r.call("downloads", "downloads-retry", failed), { ok: true });
  assert.deepEqual(r.calls.download, ["https://b.test/b.zip"]);
  assert.equal(r.downloads.get(failed), null, "the failed row gives way to the new download");
  assert.equal((await r.call("downloads", "downloads-retry", done)).ok, false);
  assert.equal((await r.call("downloads", "downloads-remove", running)).ok, false);
  assert.deepEqual(await r.call("downloads", "downloads-remove", blocked), { ok: true });
  assert.deepEqual(await r.call("downloads", "downloads-clear"), { ok: true });
  assert.deepEqual(r.downloads.list().map((d) => d.filename), ["c.zip"]);
});

test("site permissions: listed, taken back one by one, per site, or all (after a confirm)", async () => {
  const r = rig();
  r.permissions.set("https://meet.test", ["camera", "microphone"], "allow");
  r.permissions.set("https://news.test", ["notifications"], "block");
  const got = await r.call("permissions", "permissions-list");
  assert.deepEqual(got.permissions.map((p) => [p.origin, p.label, p.value]),
    [["https://meet.test", "Camera", "allow"], ["https://meet.test", "Microphone", "allow"], ["https://news.test", "Notifications", "block"]]);
  assert.deepEqual(await r.call("permissions", "permissions-remove", "https://meet.test", "camera"), { ok: true });
  assert.equal(r.permissions.get("https://meet.test", "camera"), null);
  assert.equal(r.permissions.get("https://meet.test", "microphone"), "allow");
  assert.deepEqual(await r.call("permissions", "permissions-remove", "https://meet.test", ""), { ok: true });
  assert.equal((await r.call("permissions", "permissions-remove", "https://meet.test", "")).ok, false);
  // Each answer taken back is taken from the open pages too; a miss revokes nothing.
  assert.deepEqual(r.calls.revoked, [["https://meet.test", "camera"], ["https://meet.test", null]]);
  assert.deepEqual(await r.call("permissions", "permissions-clear"), { ok: true, removed: 1 });
  assert.deepEqual(r.calls.revoked[2], [null, null], "Forget all revokes every open page");
  assert.equal(r.permissions.list().length, 0);
  const no = rig({ confirm: false });
  no.permissions.set("https://a.test", ["geolocation"], "allow");
  assert.deepEqual(await no.call("permissions", "permissions-clear"), { ok: false, cancelled: true });
  assert.deepEqual(no.calls.revoked, [], "a cancelled Forget all revokes nothing");
  assert.equal(no.permissions.list().length, 1);
});

test("clear browsing data: the plan says what goes, the owner confirms, then the host clears", async () => {
  const now = 50 * 24 * 3600 * 1000;
  assert.deepEqual(pages.clearPlan({ range: "nope", history: true }), { ok: false, error: "choose a time range" });
  assert.deepEqual(pages.clearPlan({ range: "hour" }), { ok: false, error: "nothing is ticked" });
  const hour = pages.clearPlan({ range: "hour", history: true, cookies: true, cache: 1, passwords: "yes" }, now);
  assert.deepEqual([hour.history, hour.cookies, hour.cache, hour.passwords, hour.since], [true, true, true, true, now - 3600 * 1000]);
  // Cookies and cache cannot be ranged: the confirm says so.
  assert.match(hour.lines.join("\n"), /Cookies and site data \(all of it: this cannot be limited to a time range\)/);
  assert.match(hour.lines.join("\n"), /Browsing history from the last hour/);
  const all = pages.clearPlan({ range: "all", cookies: true }, now);
  assert.equal(all.since, 0);
  assert.doesNotMatch(all.lines.join("\n"), /cannot be limited/);
  assert.deepEqual(Object.keys(pages.RANGES), ["hour", "day", "week", "month", "all"]);

  const r = rig();
  r.library.visit("https://a.test/", "A");
  assert.deepEqual(await r.call("clear-data", "clear-summary"), { ok: true, history: 1, passwords: 3,
    ranges: Object.keys(pages.RANGES).map((id) => ({ id, label: pages.RANGE_LABELS[id] })) });
  assert.equal((await r.call("clear-data", "clear-run", { range: "day" })).ok, false);
  assert.equal(r.calls.confirm.length, 0, "nothing to confirm when nothing is ticked");
  const ran = await r.call("clear-data", "clear-run", { range: "day", history: true, cache: true });
  assert.deepEqual(ran, { ok: true, history: 2, errors: [] });
  assert.equal(r.calls.confirm.length, 1);
  assert.match(r.calls.confirm[0].detail, /Only your own browsing profile/);
  assert.deepEqual([r.calls.cleared[0].history, r.calls.cleared[0].cache, r.calls.cleared[0].cookies, r.calls.cleared[0].passwords],
    [true, true, false, false]);
  assert.equal(r.calls.cleared[0].since, 10_000_000 - 24 * 3600 * 1000);

  const no = rig({ confirm: false });
  assert.deepEqual(await no.call("clear-data", "clear-run", { range: "all", history: true, passwords: true }), { ok: false, cancelled: true });
  assert.equal(no.calls.cleared.length, 0);
});

test("clearing is fenced to the owner's profile in the window's wiring", () => {
  const src = fs.readFileSync(path.join(__dirname, "browser-window.cjs"), "utf8");
  const fn = src.slice(src.indexOf("async function clearBrowsingData("), src.indexOf("const libraryHost ="));
  assert.match(fn, /session\.fromPartition\(PARTITION\)/);
  assert.doesNotMatch(fn, /AGENT_PARTITION|INTERNAL_PARTITION|onlinePartition|defaultSession/);
});

test("opening from a library page: web addresses only, and only the five pages by name", async () => {
  const r = rig();
  assert.deepEqual(await r.call("history", "open", "https://a.test/x"), { ok: true });
  for (const bad of ["aither://secrets/", "file:///C:/x", "javascript:alert(1)", "https://u:p@a.test/", "", 5]) {
    assert.equal((await r.call("history", "open", bad)).ok, false, String(bad));
  }
  assert.deepEqual(r.calls.open, ["https://a.test/x"]);
  assert.deepEqual(await r.call("downloads", "goto", "bookmarks"), { ok: true });
  for (const bad of ["secrets", "settings", "desktop", "", null]) assert.equal((await r.call("downloads", "goto", bad)).ok, false);
  assert.deepEqual(r.calls.goto, ["bookmarks"]);
});

test("the keys: Ctrl+H, Ctrl+J, Ctrl+Shift+O, Ctrl+Shift+B, Ctrl+Shift+Delete", () => {
  const key = (k, extra = {}) => keyAction({ type: "keyDown", key: k, control: true, ...extra });
  assert.deepEqual(key("h"), { action: "history" });
  assert.deepEqual(key("j"), { action: "downloads" });
  assert.deepEqual(key("O", { shift: true }), { action: "bookmarks" });
  assert.deepEqual(key("B", { shift: true }), { action: "bookmarks-bar" });
  assert.deepEqual(key("Delete", { shift: true }), { action: "clear-data" });
  assert.equal(key("Delete"), null, "plain Ctrl+Delete is the page's (delete a word)");
  assert.equal(key("o"), null);
  // Each action lands on a real page (or the bar) in the window's one action switch.
  const src = fs.readFileSync(path.join(__dirname, "browser-window.cjs"), "utf8");
  const sw = src.slice(src.indexOf("function runBrowserAction("), src.indexOf("function showContextMenu("));
  for (const name of ["history", "downloads", "bookmarks", "permissions", "clear-data", "bookmarks-bar"]) {
    assert.match(sw, new RegExp(`case "${name}":`), name);
  }
  assert.doesNotMatch(sw, /case "downloads": return false/);
});

test("the page script writes site text with textContent only", () => {
  const js = fs.readFileSync(path.join(__dirname, "library-page.js"), "utf8");
  assert.doesNotMatch(js, /innerHTML|outerHTML|insertAdjacentHTML|document\.write|eval\(/);
  for (const id of pages.PAGES) {
    const file = PANES.find((p) => p.id === id).file;
    const html = fs.readFileSync(path.join(__dirname, file), "utf8");
    assert.match(html, new RegExp(`<body data-page="${id}">`));
    assert.match(html, /default-src 'none'; style-src 'unsafe-inline' file:; script-src file:; img-src data:;/);
    assert.doesNotMatch(html, /<script(?![^>]*src=)/, "no inline script");
  }
});
