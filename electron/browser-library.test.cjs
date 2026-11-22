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
