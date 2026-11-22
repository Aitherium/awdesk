"use strict";

// The Aither Browser's Alt+Space verbs (browser-verbs.cjs): what each typed line
// parses to, the rows it answers with, and the registry row every row runs.

const test = require("node:test");
const assert = require("node:assert/strict");
const { MAX_ROWS, addressOf, matchEntries, parseBrowserVerb, verbRows, verbGroup } = require("./browser-verbs.cjs");
const registry = require("./command-registry.cjs");

const actions = (text, ctx) => verbRows(parseBrowserVerb(text), ctx).rows.map((r) => [r.action.id, r.action.arg]);

test("a bare address is offered as a tab; a file name, a version and a plain word are not", () => {
  assert.equal(addressOf("example.com"), "https://example.com");
  assert.equal(addressOf("example.com/a?b=1"), "https://example.com/a?b=1");
  assert.equal(addressOf("localhost:3000"), "https://localhost:3000");
  assert.equal(addressOf("127.0.0.1:8080/x"), "https://127.0.0.1:8080/x");
  assert.equal(addressOf("http://localhost:3000/x"), "http://localhost:3000/x");
  assert.equal(addressOf("aither://history"), "aither://history");
  for (const no of ["notes.txt", "setup.exe", "v1.2", "e.g", "hello", "two words.com", "", "javascript:alert(1)",
    "file:///C:/x", "mailto:a@b.co", "https://"]) {
    assert.equal(addressOf(no), null, no);
  }
  // Said with `go`, a host-shaped name is taken at its word.
  assert.equal(addressOf("notes.txt", { strict: false }), "https://notes.txt");
});

test("prefixes and ordinary words stay the launcher's: ?, >, @, !private, 'go pro', 'private equity'", () => {
  for (const text of ["? what is this", "> awsh status", "@ hello", "!private", "", "go", "go pro", "search",
    "private equity", "extension cord", "extension", "chrome", "open example.com", "finder"]) {
    assert.equal(parseBrowserVerb(text), null, text);
  }
});

test("a bare address and `go <address>` open it in an owner tab; only a typed scheme drops the ordinary search", () => {
  const bare = parseBrowserVerb("example.com");
  assert.equal(bare.verb, "go");
  assert.equal(bare.keepSearch, true, "node.js is also an app: the search stays underneath");
  assert.equal(parseBrowserVerb("https://example.com/x").keepSearch, false);
  assert.equal(parseBrowserVerb("aither://history").keepSearch, false);
  assert.deepEqual(actions("example.com"), [["browser.go", "example.com"], ["browser.tab.private", "example.com"]]);
  const go = parseBrowserVerb("GO  example.com/docs ");
  assert.equal(go.keepSearch, false);
  assert.equal(go.url, "https://example.com/docs");
  assert.deepEqual(actions("go example.com/docs"), [["browser.go", "example.com/docs"], ["browser.tab.private", "example.com/docs"]]);
  assert.deepEqual(actions("go notes.txt")[0], ["browser.go", "notes.txt"]);
  // An Aither page is the owner's own: no InPrivate twin.
  assert.deepEqual(actions("go aither://downloads"), [["browser.go", "aither://downloads"]]);
});

test("`search <words>` runs a web search", () => {
  const v = parseBrowserVerb("search best local  llm");
  assert.deepEqual([v.verb, v.arg, v.keepSearch], ["search", "best local llm", false]);
  const { rows, status } = verbRows(v);
  assert.match(rows[0].title, /Search the web for “best local llm”/);
  assert.deepEqual(rows[0].action, { type: "command", id: "browser.search", arg: "best local llm" });
  assert.match(status, /Enter/);
});

test("`private <address>` opens InPrivate; bare `private` offers a new InPrivate tab over the ordinary search", () => {
  assert.deepEqual(actions("private example.com"), [["browser.tab.private", "example.com"]]);
  assert.deepEqual(actions("inprivate https://example.com/a"), [["browser.tab.private", "https://example.com/a"]]);
  const bare = parseBrowserVerb("private");
  assert.equal(bare.keepSearch, true);
  assert.deepEqual(verbRows(bare).rows.map((r) => r.action), [{ type: "command", id: "browser.tab.private" }]);
  // An Aither page never opens InPrivate.
  assert.equal(parseBrowserVerb("private aither://history"), null);
});

test("`history <words>` lists matching visits, capped, and each opens on Enter", () => {
  const history = Array.from({ length: 20 }, (_, i) => ({ url: `https://docs.example.com/page-${i}`, title: `Docs page ${i}` }));
  history.push({ url: "https://other.test/", title: "Unrelated" });
  const v = parseBrowserVerb("history docs page");
  assert.deepEqual([v.verb, v.target, v.keepSearch], ["history", "match", false]);
  const { rows, status } = verbRows(v, { history });
  assert.equal(rows.length, MAX_ROWS + 1, "the cap, then the History page row");
  assert.deepEqual(rows[0].action, { type: "command", id: "browser.go", arg: "https://docs.example.com/page-0" });
  assert.equal(rows[0].kind, "history");
  assert.equal(rows[rows.length - 1].action.id, "browser.history");
  assert.match(status, new RegExp(`^${MAX_ROWS} pages from your history`));
  const none = verbRows(parseBrowserVerb("history zebra"), { history });
  assert.deepEqual(none.rows.map((r) => r.action.id), ["browser.history"]);
  assert.match(none.status, /^0 pages in your history match “zebra”/);
  // Bare: the page, with the ordinary search kept underneath.
  const bare = parseBrowserVerb("history");
  assert.equal(bare.keepSearch, true);
  assert.deepEqual(verbRows(bare).rows.map((r) => r.action.id), ["browser.history"]);
});

test("`bookmark(s) <words>` lists matching bookmarks; bare `bookmark` leads with bookmarking this page", () => {
  const bookmarks = [
    { url: "https://a.example/recipes", title: "Recipes", folder: "Food" },
    { url: "https://b.example/", title: "Bank", folder: "" },
  ];
  const { rows, status } = verbRows(parseBrowserVerb("bookmarks recipes"), { bookmarks });
  assert.deepEqual(rows.map((r) => [r.action.id, r.action.arg]), [["browser.go", "https://a.example/recipes"], ["browser.bookmarks", undefined]]);
  assert.match(rows[0].subtitle, /^Food · https:\/\/a\.example\/recipes/);
  assert.match(status, /^1 bookmark ·/);
  assert.deepEqual(actions("bookmark bank", { bookmarks })[0], ["browser.go", "https://b.example/"]);
  assert.deepEqual(actions("bookmark").map((a) => a[0]), ["browser.bookmark-page", "browser.bookmarks"]);
  assert.deepEqual(actions("bookmarks").map((a) => a[0]), ["browser.bookmarks", "browser.bookmark-page"]);
  assert.match(verbRows(parseBrowserVerb("bookmark zebra"), { bookmarks }).status, /^0 bookmarks match/);
});

test("`tab <words>` switches to a matching open tab by its id; bare `tabs` lists them", () => {
  const tabs = [
    { id: 4, url: "https://mail.example/inbox", title: "Inbox (3)", active: false },
    { id: 7, url: "https://docs.example/spec", title: "Spec", active: true },
  ];
  const { rows, status } = verbRows(parseBrowserVerb("tab spec"), { tabs });
  assert.deepEqual(rows.map((r) => r.action), [{ type: "command", id: "browser.tab.switch", arg: "#7" }]);
  assert.match(rows[0].subtitle, /^On screen · /);
  assert.match(status, /^1 open tab match/);
  assert.deepEqual(actions("tabs", { tabs }), [["browser.tab.switch", "#4"], ["browser.tab.switch", "#7"], ["browser.tab.new", undefined]]);
  assert.equal(parseBrowserVerb("tabs").keepSearch, true);
  const none = verbRows(parseBrowserVerb("tab zebra"), { tabs });
  assert.deepEqual(none.rows, []);
  assert.match(none.status, /^0 open tabs match “zebra”/);
});

test("`find <words>` finds on the page; bare `find` opens the find bar", () => {
  assert.deepEqual(actions("find quarterly report"), [["browser.find", "quarterly report"]]);
  assert.deepEqual(verbRows(parseBrowserVerb("find")).rows.map((r) => r.action), [{ type: "command", id: "browser.find" }]);
  assert.equal(parseBrowserVerb("find").keepSearch, true);
  assert.equal(parseBrowserVerb("find x").keepSearch, false);
});

test("`extension <store address>` adds it; any other address is an ordinary search", () => {
  const url = "https://chromewebstore.google.com/detail/ublock-origin-lite/ddkjiahejlhfcafbddmgiahcphecmpfh";
  assert.deepEqual(actions(`extension ${url}`), [["browser.extension.add", url]]);
  assert.equal(parseBrowserVerb("extension https://example.com/"), null);
});

test("matchEntries needs every word, in title or address, case-blind", () => {
  const list = [{ url: "https://a.test/Alpha", title: "First" }, { url: "https://b.test/", title: "alpha beta" }];
  assert.deepEqual(matchEntries(list, "ALPHA").map((e) => e.url), ["https://a.test/Alpha", "https://b.test/"]);
  assert.deepEqual(matchEntries(list, "alpha beta").map((e) => e.url), ["https://b.test/"]);
  assert.deepEqual(matchEntries(list, "").length, 2);
  assert.deepEqual(matchEntries(null, "x"), []);
});

test("every row runs a registry command that exists, routes to the browser, and keeps its action in main", () => {
  const ctx = {
    history: [{ url: "https://h.test/", title: "H" }], bookmarks: [{ url: "https://b.test/", title: "B" }],
    tabs: [{ id: 1, url: "https://t.test/", title: "T", active: true }],
  };
  const lines = ["example.com", "go example.com", "search cats", "private", "private example.com", "history", "history h",
    "bookmark", "bookmarks b", "tab", "tab t", "find", "find x",
    "extension https://microsoftedge.microsoft.com/addons/detail/x/odfafepnkmbhccpbejgmiehpchacaeak"];
  for (const line of lines) {
    const v = parseBrowserVerb(line);
    assert.ok(v, line);
    const { rows } = verbRows(v, ctx);
    assert.ok(rows.length > 0, `${line} answers with a row`);
    const keys = new Set();
    for (const r of rows) {
      assert.match(r.key, /^verb:b-/, "the launcher runs it through the verb path");
      assert.ok(!keys.has(r.key), `${line}: duplicate key ${r.key}`);
      keys.add(r.key);
      assert.equal(r.action.type, "command");
      const command = registry.byId(r.action.id);
      assert.ok(command && command.browser, `${line}: ${r.action.id} is a browser.* registry row`);
    }
    const group = verbGroup(v, rows);
    assert.equal(group.id, "verbs");
    assert.equal(group.items.length, rows.length);
    assert.ok(group.items.every((item) => !("action" in item)), "the action never crosses to the page");
  }
  assert.equal(verbGroup(parseBrowserVerb("tab zebra"), []), null);
});
