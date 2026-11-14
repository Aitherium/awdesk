"use strict";

// The Alt+Space launcher's VERB path (desk-verbs.cjs wired into launcher-window.cjs):
// a verb answers with its own rows, Enter runs the row's action BY KEY, and a bare
// verb keeps the ordinary search underneath.

const test = require("node:test");
const assert = require("node:assert/strict");
const { createLauncher } = require("./launcher-window.cjs");

function launcher({ hasCanvas = false } = {}) {
  const ran = [];
  const electron = {
    BrowserWindow: class {}, ipcMain: { handle() {}, on() {} },
    screen: { getCursorScreenPoint: () => ({ x: 0, y: 0 }) }, shell: {}, clipboard: {},
  };
  const registry = { byId: (id) => (id === "canvas.open" && hasCanvas ? { id } : id === "orb.ask" ? null : null) };
  const l = createLauncher({ electron, registry, run: async (id, arg) => { ran.push([id, arg]); }, quickMenu: {} });
  return { l, ran };
}

test("'draw through' answers with the click-through row and Enter runs ink.passthrough", async () => {
  const { l, ran } = launcher();
  const r = await l.search("draw through");
  assert.equal(r.ok, true);
  assert.equal(r.groups[0].id, "verbs");
  const row = r.groups[0].shown[0];
  assert.equal(row.title, "Draw, clicks go through");
  assert.equal("action" in row, false, "the action stays in main");
  const done = await l.runRow(row.key, "");
  assert.equal(done.ok, true);
  assert.deepEqual(ran, [["ink.passthrough", undefined]]);
});

test("'youtube <words>' offers a YouTube search; 'pin <url>' a pin row; unknown verb keys expire", async () => {
  const { l } = launcher();
  const yt = await l.search("youtube lofi");
  assert.match(yt.groups[0].shown[0].title, /Search YouTube for “lofi”/);
  const pin = await l.search("pin https://media.tenor.com/x/cat.gif");
  assert.match(pin.groups[0].shown[0].title, /Pin this GIF/);
  const stale = await l.runRow("verb:nope", "");
  assert.equal(stale.ok, false);
  assert.match(stale.error, /expired/);
});

// A bare verb ("canvas", "draw") also runs the ordinary search underneath; that path
// starts the universal search's providers (powershell), so it is asserted in
// desk-verbs.test.cjs on verbRows, not here.
test("'canvas' rows follow the registry: a canvas row only when canvas.open exists", () => {
  const verbs = require("./desk-verbs.cjs");
  const v = verbs.parseDeskVerb("canvas");
  assert.deepEqual(verbs.verbRows(v, { hasCanvas: false }).rows.map((r) => r.action.id), ["board.new"]);
  assert.deepEqual(verbs.verbRows(v, { hasCanvas: true }).rows.map((r) => r.action.id), ["canvas.open", "board.new"]);
});

// ── the Aither Browser's verbs (browser-verbs.cjs wired into launcher-window.cjs) ──

function browserLauncher(source) {
  const ran = [];
  const electron = {
    BrowserWindow: class {}, ipcMain: { handle() {}, on() {} },
    screen: { getCursorScreenPoint: () => ({ x: 0, y: 0 }) }, shell: {}, clipboard: {},
  };
  const l = createLauncher({ electron, registry: { byId: () => null }, quickMenu: {}, browser: source,
    run: async (id, arg) => { ran.push([id, arg]); return { ok: true }; } });
  return { l, ran };
}

test("a typed address with a scheme answers with one Open row and Enter runs browser.go on it", async () => {
  const { l, ran } = browserLauncher(null);
  const r = await l.search("https://example.com/docs");
  assert.equal(r.ok, true);
  assert.equal(r.groups[0].id, "verbs");
  assert.equal(r.groups[0].label, "Aither browser");
  const row = r.groups[0].shown[0];
  assert.equal(row.title, "Open https://example.com/docs");
  assert.equal("action" in row, false, "the action stays in main");
  assert.deepEqual(await l.runRow(row.key, ""), { ok: true, did: "command" });
  assert.deepEqual(ran, [["browser.go", "https://example.com/docs"]]);
});

test("'go', 'search', 'private' and 'find' each run their registry row with the typed argument", async () => {
  const { l, ran } = browserLauncher(null);
  for (const [line, id, arg] of [
    ["go example.com", "browser.go", "example.com"],
    ["search best local llm", "browser.search", "best local llm"],
    ["private example.com", "browser.tab.private", "example.com"],
    ["find quarterly report", "browser.find", "quarterly report"],
  ]) {
    const r = await l.search(line);
    assert.equal(r.groups[0].id, "verbs", line);
    const done = await l.runRow(r.groups[0].shown[0].key, "");
    assert.equal(done.ok, true, line);
    assert.deepEqual(ran[ran.length - 1], [id, arg], line);
  }
});

test("'history <words>', 'bookmark <words>' and 'tab <words>' ask the browser's OWNER lists and open on Enter", async () => {
  const asked = [];
  const { l, ran } = browserLauncher({
    history: async (words, limit) => { asked.push(["history", words, limit]); return [{ url: "https://docs.example.com/guide", title: "The guide" }]; },
    bookmarks: (words, limit) => { asked.push(["bookmarks", words, limit]); return [{ url: "https://bank.example/", title: "Bank", folder: "Money" }]; },
    tabs: () => { asked.push(["tabs"]); return [{ id: 3, url: "https://mail.example/", title: "Mail", active: false }, { id: 9, url: "https://x.example/", title: "Other", active: true }]; },
  });
  const h = await l.search("history guide");
  assert.equal(h.groups[0].label, "History");
  assert.equal(h.groups[0].shown[0].title, "The guide");
  assert.equal(h.groups[0].shown[0].kind, "history");
  assert.match(h.status, /^1 page from your history/);
  await l.runRow(h.groups[0].shown[0].key, "");
  const b = await l.search("bookmarks bank");
  assert.equal(b.groups[0].shown[0].title, "Bank");
  await l.runRow(b.groups[0].shown[0].key, "");
  const t = await l.search("tab mail");
  assert.deepEqual(t.groups[0].shown.map((row) => row.title), ["Mail"]);
  await l.runRow(t.groups[0].shown[0].key, "");
  assert.deepEqual(asked, [["history", "guide", 8], ["bookmarks", "bank", 8], ["tabs"]]);
  assert.deepEqual(ran, [["browser.go", "https://docs.example.com/guide"], ["browser.go", "https://bank.example/"], ["browser.tab.switch", "#3"]]);
});

test("a browser list that throws, or no browser wired, still answers with the page row", async () => {
  const { l } = browserLauncher({ history: () => { throw new Error("library locked"); } });
  const h = await l.search("history guide");
  assert.deepEqual(h.groups[0].shown.map((row) => row.title), ["Open History"]);
  assert.match(h.status, /^0 pages in your history match/);
  const { l: bare } = browserLauncher(null);
  const none = await bare.search("tab mail");
  assert.deepEqual(none.groups, []);
  assert.match(none.status, /^0 open tabs match/);
});

test("a refused browser command keeps the box open with the reason; ? is still Ask Aither", async () => {
  const electron = {
    BrowserWindow: class {}, ipcMain: { handle() {}, on() {} },
    screen: { getCursorScreenPoint: () => ({ x: 0, y: 0 }) }, shell: {}, clipboard: {},
  };
  const l = createLauncher({ electron, registry: { byId: () => null }, quickMenu: {},
    run: async () => ({ ok: false, error: "1 tab on screen is the agent's — switch to one of your own tabs first" }) });
  const r = await l.search("find invoice");
  const done = await l.runRow(r.groups[0].shown[0].key, "");
  assert.equal(done.ok, false);
  assert.match(done.error, /the agent's/);
  const ask = await l.search("? example.com");
  assert.equal(ask.mode, "ask");
  assert.deepEqual(ask.groups, []);
});
