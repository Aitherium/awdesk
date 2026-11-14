"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createLibrary, storable } = require("./browser-library.cjs");

function tmpFile() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), "awdesk-lib-")), "browser-library.json");
}

test("only http(s) pages without credentials are kept", () => {
  assert.equal(storable("https://a.test/x"), true);
  for (const url of ["about:blank", "data:text/html,x", "file:///C:/x", "https://u:p@a.test/", "javascript:1", ""]) {
    assert.equal(storable(url), false, url);
  }
  const lib = createLibrary({ file: tmpFile() });
  assert.equal(lib.visit("data:text/html,x"), false);
  assert.equal(lib.history().length, 0);
});

test("a revisit moves to the top, counts, and keeps who visited", () => {
  let t = 0;
  const lib = createLibrary({ file: tmpFile(), now: () => ++t });
  lib.visit("https://a.test/", "A");
  lib.visit("https://b.test/", "B", "agent");
  lib.visit("https://a.test/", "");
  const h = lib.history();
  assert.deepEqual(h.map((e) => [e.url, e.count, e.by, e.title]), [
    ["https://a.test/", 2, "you", "A"],
    ["https://b.test/", 1, "agent", "B"],
  ]);
  // The owner visiting an agent's page makes it the owner's.
  lib.visit("https://b.test/", "B", "you");
  assert.equal(lib.history()[0].by, "you");
});

test("history is capped and survives a reload from disk; a corrupt file starts clean", () => {
  const file = tmpFile();
  const lib = createLibrary({ file, maxHistory: 3 });
  for (const n of [1, 2, 3, 4]) lib.visit(`https://p${n}.test/`, `P${n}`);
  assert.deepEqual(lib.history().map((e) => e.title), ["P4", "P3", "P2"]);
  assert.deepEqual(createLibrary({ file }).history().map((e) => e.title), ["P4", "P3", "P2"]);
  fs.writeFileSync(file, "{not json");
  assert.deepEqual(createLibrary({ file }).history(), []);
  assert.ok(!fs.readdirSync(path.dirname(file)).some((f) => f.endsWith(".tmp")), "no temp file is left behind");
});

test("bookmarks toggle, persist and lead the suggestions", () => {
  const file = tmpFile();
  const lib = createLibrary({ file });
  lib.visit("https://vroid.test/models", "VRoid models");
  lib.visit("https://vroid.test/agent-page", "VRoid agent page", "agent");
  assert.equal(lib.toggleBookmark("https://vroid.test/hub", "VRoid Hub"), true);
  assert.equal(createLibrary({ file }).isBookmarked("https://vroid.test/hub"), true);
  const s = lib.suggest("vroid");
  assert.deepEqual(s.map((e) => e.kind), ["bookmark", "history", "agent"], "bookmarks, then yours, then an agent's");
  assert.equal(lib.toggleBookmark("https://vroid.test/hub"), false);
  assert.equal(lib.isBookmarked("https://vroid.test/hub"), false);
  assert.deepEqual(lib.suggest(""), []);
  lib.clearHistory();
  assert.deepEqual(lib.history(), []);
});

test("import adds new bookmarks and history, keeps what is already here", () => {
  const lib = createLibrary({ file: tmpFile(), now: () => 5 });
  lib.toggleBookmark("https://keep.test/", "Mine");
  lib.visit("https://seen.test/", "Seen");
  const r = lib.importEntries({
    bookmarks: [{ url: "https://keep.test/", title: "Edge name" }, { url: "https://new.test/", title: "New" }, { url: "javascript:1" }],
    history: [{ url: "https://seen.test/", title: "x", at: 1, count: 9 }, { url: "https://old.test/", title: "Old", at: 2, count: 3 }],
  });
  assert.deepEqual(r, { bookmarks: 1, history: 1 });
  assert.equal(lib.bookmarks().find((b) => b.url === "https://keep.test/").title, "Mine");
  assert.deepEqual(lib.history().map((h) => h.url), ["https://seen.test/", "https://old.test/"]);
  assert.equal(lib.history()[1].by, "you");
});

test("applySync adds and removes bookmarks, merges newer history as the owner's, and honours a clear", () => {
  let t = 100;
  const file = tmpFile();
  const lib = createLibrary({ file, now: () => ++t });
  lib.toggleBookmark("https://keep.test/", "Keep");
  lib.toggleBookmark("https://drop.test/", "Drop");
  lib.visit("https://old.test/", "Old", "agent");
  lib.visit("https://same.test/", "Same");
  const sameAt = lib.history().find((h) => h.url === "https://same.test/").at;
  const out = lib.applySync({
    addBookmarks: [{ url: "https://new.test/", title: "New", at: 5 }, { url: "https://keep.test/", title: "dup" }, { url: "javascript:1" }],
    removeBookmarks: ["https://drop.test/", "https://never-here.test/"],
    history: [{ url: "https://old.test/", title: "", at: 500, count: 4 }, { url: "https://same.test/", title: "x", at: sameAt - 1 },
      { url: "https://far.test/", title: "Far", at: 50 }, { url: "file:///x", at: 900 }],
    clearHistoryBefore: 60,
  });
  assert.deepEqual(out, { bookmarksAdded: 1, bookmarksRemoved: 1, history: 1 });
  assert.deepEqual(lib.bookmarks().map((b) => b.url).sort(), ["https://keep.test/", "https://new.test/"]);
  const h = lib.history();
  assert.deepEqual(h.map((e) => e.url), ["https://old.test/", "https://same.test/"]);
  assert.deepEqual({ title: h[0].title, count: h[0].count, by: h[0].by, at: h[0].at }, { title: "Old", count: 4, by: "you", at: 500 });
  // It is on disk.
  assert.equal(createLibrary({ file }).bookmarks().length, 2);
  assert.deepEqual(lib.applySync({}), { bookmarksAdded: 0, bookmarksRemoved: 0, history: 0 });
});

test("the file's generation id survives a restart and changes only when the file is lost or reset", () => {
  const file = tmpFile();
  const lib = createLibrary({ file });
  const id = lib.generation();
  assert.match(id, /^[a-f0-9]{16}$/);
  assert.equal(fs.existsSync(file), false, "an unused library wrote a file");
  lib.toggleBookmark("https://a.test/", "A");
  assert.equal(createLibrary({ file }).generation(), id);
  // A good file from before the id existed gets one, on disk, once.
  fs.writeFileSync(file, JSON.stringify({ version: 1, history: [], bookmarks: [{ url: "https://old.test/", title: "Old", at: 1 }] }));
  const stamped = createLibrary({ file }).generation();
  assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).id, stamped);
  assert.equal(createLibrary({ file }).generation(), stamped);
  assert.equal(createLibrary({ file }).bookmarks().length, 1);
  // Truncated, or from another version: a new generation, and the file is left as it is until used.
  for (const broken of ["{\"version\":1,\"book", JSON.stringify({ version: 99, id: stamped, bookmarks: [] })]) {
    fs.writeFileSync(file, broken);
    const reset = createLibrary({ file });
    assert.notEqual(reset.generation(), stamped);
    assert.equal(reset.bookmarks().length, 0);
    assert.equal(fs.readFileSync(file, "utf8"), broken);
  }
});
