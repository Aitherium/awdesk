"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  chromiumTimeToMs,
  edgeProfileDirs,
  parseBookmarks,
  readHistory,
  parsePasswordCsv,
  importPasswordCsv,
  importFromEdge,
} = require("./browser-edge-import.cjs");

let sqlite = null;
try {
  sqlite = require("node:sqlite");
} catch {
  sqlite = null;
}

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "awdesk-edge-"));
}

const BOOKMARKS = {
  version: 1,
  roots: {
    bookmark_bar: {
      type: "folder",
      name: "Favorites bar",
      children: [
        { type: "url", name: "Aither", url: "https://aitherium.com/" },
        {
          type: "folder",
          name: "Work",
          children: [
            { type: "url", name: "Docs", url: "https://docs.test/a" },
            { type: "folder", name: "Deep", children: [{ type: "url", name: "", url: "http://deep.test/" }] },
            { type: "url", name: "Script", url: "javascript:alert(1)" },
          ],
        },
      ],
    },
    other: {
      type: "folder",
      name: "Other favorites",
      children: [
        { type: "url", name: "Secret", url: "https://user:pw@creds.test/" },
        { type: "url", name: "Local", url: "file:///C:/x.html" },
        { type: "url", name: "Edge", url: "edge://settings" },
      ],
    },
    synced: { type: "folder", name: "Mobile favorites", children: [{ type: "url", name: "Phone", url: "https://phone.test/" }] },
  },
};

function makeHistoryDb(file, { wal = false } = {}) {
  const db = new sqlite.DatabaseSync(file);
  if (wal) db.exec("PRAGMA journal_mode=WAL");
  db.exec(
    "CREATE TABLE urls (id INTEGER PRIMARY KEY, url TEXT, title TEXT, visit_count INTEGER, typed_count INTEGER, last_visit_time INTEGER, hidden INTEGER DEFAULT 0)",
  );
  const ins = db.prepare("INSERT INTO urls (url, title, visit_count, last_visit_time, hidden) VALUES (?, ?, ?, ?, ?)");
  ins.run("https://old.test/", "Old", 3, 13300000000000000, 0);
  ins.run("https://new.test/", "New", 7, 13300000060000000, 0);
  ins.run("edge://newtab/", "New tab", 50, 13300000090000000, 0);
  ins.run("https://hidden.test/", "Hidden", 1, 13300000080000000, 1);
  ins.run("https://mid.test/", "", 1, 13300000030000000, 0);
  return db;
}

test("bookmarks flatten nested folders and skip non-web and credentialed URLs", () => {
  const out = parseBookmarks(JSON.stringify(BOOKMARKS));
  assert.deepEqual(out, [
    { url: "https://aitherium.com/", title: "Aither", folder: "Favorites bar" },
    { url: "https://docs.test/a", title: "Docs", folder: "Favorites bar/Work" },
    { url: "http://deep.test/", title: "http://deep.test/", folder: "Favorites bar/Work/Deep" },
    { url: "https://phone.test/", title: "Phone", folder: "Mobile favorites" },
  ]);
  assert.deepEqual(parseBookmarks("{not json"), []);
  assert.deepEqual(parseBookmarks({}), []);
});

test("Chromium time converts to Unix ms", () => {
  // 13300000000000000 us since 1601 = 2022-06-18T04:26:40Z.
  assert.equal(chromiumTimeToMs(13300000000000000), Date.UTC(2022, 5, 18, 4, 26, 40));
  assert.equal(chromiumTimeToMs(13300000000000000n), Date.UTC(2022, 5, 18, 4, 26, 40));
  assert.equal(chromiumTimeToMs(0), 0);
  assert.equal(chromiumTimeToMs("junk"), 0);
});

test("history reads from a copy, newest first, web pages only, and cleans up", (t) => {
  if (!sqlite) return t.skip("node:sqlite unavailable");
  for (const wal of [false, true]) {
    const dir = tmpDir();
    const file = path.join(dir, "History");
    const db = makeHistoryDb(file, { wal });
    // Keep the source open (like a running Edge) so a WAL file really exists.
    const tmpRoot = tmpDir();
    const res = readHistory(file, { sqlite, tmpRoot });
    db.close();
    assert.equal(res.ok, true, res.error);
    assert.deepEqual(
      res.entries.map((e) => [e.url, e.title, e.count]),
      [
        ["https://new.test/", "New", 7],
        ["https://mid.test/", "https://mid.test/", 1],
        ["https://old.test/", "Old", 3],
      ],
      `wal=${wal}`,
    );
    assert.equal(res.entries[2].at, Date.UTC(2022, 5, 18, 4, 26, 40));
    assert.deepEqual(fs.readdirSync(tmpRoot), [], "the temp copy is removed");
    assert.equal(readHistory(file, { sqlite, tmpRoot, limit: 1 }).entries.length, 1);
  }
});

test("history without node:sqlite reports instead of throwing", () => {
  const dir = tmpDir();
  const file = path.join(dir, "History");
  fs.writeFileSync(file, "x");
  const res = readHistory(file, { sqlite: {} });
  assert.equal(res.ok, false);
  assert.match(res.error, /sqlite/);
  assert.equal(readHistory(path.join(dir, "missing"), { sqlite: { DatabaseSync: function () {} } }).ok, false);
});

test("password CSV: quotes, commas, doubled quotes, CRLF, BOM, header order, skipped rows", () => {
  const edge =
    "\uFEFFname,url,username,password,note\r\n" +
    'site,https://a.test/login?x=1,"me, myself","p,""q""\r\nline2",hi\r\n' +
    "nopass,https://b.test/,bob,,\r\n" +
    "bad,not a url,eve,secret,\r\n" +
    "ftp,ftp://c.test/,f,secret,\r\n" +
    "plain,http://d.test:8080/x,,pw,\r\n";
  const rows = parsePasswordCsv(edge);
  assert.deepEqual(rows, [
    { origin: "https://a.test", url: "https://a.test/login?x=1", username: "me, myself", password: 'p,"q"\r\nline2', note: "hi" },
    { origin: "http://d.test:8080", url: "http://d.test:8080/x", username: "", password: "pw", note: "" },
  ]);
  const chrome = "url,username,password,name\nhttps://e.test/,ann,pw1,e\n";
  assert.deepEqual(parsePasswordCsv(chrome).map((r) => [r.origin, r.username, r.password]), [["https://e.test", "ann", "pw1"]]);
  assert.deepEqual(parsePasswordCsv(""), []);
});

test("importPasswordCsv adds each good row to the vault and counts skips", async () => {
  const added = [];
  const vault = { add: async (e) => (e.username === "dup" ? { ok: false } : (added.push(e), { ok: true })) };
  const text = "name,url,username,password,note\na,https://a.test/,ann,pw,\nb,https://b.test/,dup,pw,\nc,https://c.test/,cid,,\n";
  const res = await importPasswordCsv({ text, vault });
  assert.deepEqual(res, { ok: true, added: 1, skipped: 2 });
  assert.deepEqual(added, [{ origin: "https://a.test", username: "ann", password: "pw" }]);
  assert.equal((await importPasswordCsv({ text })).ok, false);
});

test("profile discovery finds Edge profiles with data and their display names", () => {
  const local = tmpDir();
  const ud = path.join(local, "Microsoft", "Edge", "User Data");
  for (const [p, f] of [["Default", "Bookmarks"], ["Profile 2", "History"], ["Profile 1", "Bookmarks"], ["Profile 3", null], ["System Profile", "History"], ["Crashpad", "History"]]) {
    fs.mkdirSync(path.join(ud, p), { recursive: true });
    if (f) fs.writeFileSync(path.join(ud, p, f), "{}");
  }
  fs.writeFileSync(path.join(ud, "Local State"), JSON.stringify({ profile: { info_cache: { Default: { name: "Personal" }, "Profile 2": { name: "Work" } } } }));
  assert.deepEqual(edgeProfileDirs({ localAppData: local }), [
    { name: "Personal", dir: path.join(ud, "Default") },
    { name: "Profile 1", dir: path.join(ud, "Profile 1") },
    { name: "Work", dir: path.join(ud, "Profile 2") },
  ]);
  assert.deepEqual(edgeProfileDirs({ localAppData: path.join(local, "nope") }), []);
  assert.deepEqual(edgeProfileDirs({ localAppData: "" }), []);
});

test("importFromEdge hands bookmarks and history to the library and uses its counts", async (t) => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, "Bookmarks"), JSON.stringify(BOOKMARKS));
  if (sqlite) makeHistoryDb(path.join(dir, "History")).close();
  let got = null;
  const library = {
    importEntries: ({ bookmarks, history }) => {
      got = { bookmarks, history };
      return { bookmarks: bookmarks.length - 1, history: history.length };
    },
  };
  const vaulted = [];
  const res = await importFromEdge({
    profileDir: dir,
    library,
    sqlite: sqlite || undefined,
    passwords: { text: "name,url,username,password\nx,https://x.test/,u,p\n", vault: { add: (e) => vaulted.push(e) } },
  });
  assert.equal(got.bookmarks.length, 4);
  // The folder a favorite sat in comes along (aither://bookmarks shows Edge's folders).
  assert.deepEqual(Object.keys(got.bookmarks[0]).sort(), ["folder", "title", "url"]);
  assert.equal(res.bookmarks, 3, "the library's count, not ours");
  assert.equal(res.passwords, 1);
  assert.equal(vaulted.length, 1);
  if (!sqlite) return t.skip("node:sqlite unavailable for the history half");
  assert.deepEqual(res, { ok: true, bookmarks: 3, history: 3, passwords: 1, errors: [] });
  assert.equal(got.history[0].url, "https://new.test/");

  const broken = await importFromEdge({ profileDir: dir, library, sqlite: {} });
  assert.equal(broken.ok, false);
  assert.equal(broken.bookmarks, 3, "bookmarks still import when history cannot");
  assert.match(broken.errors[0], /^history:/);
  assert.equal((await importFromEdge({ profileDir: dir })).ok, false);
});
