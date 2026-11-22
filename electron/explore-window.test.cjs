"use strict";

// Main's half of aither://explore: who may call it, which operations exist, the wiki
// folder list, and the pane's place in the console / the browser / the package.

const test = require("node:test");
const assert = require("node:assert/strict");
const { createHash } = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createFolderStore, exploreHandlers, exploreOps, fromExplorePage, verbLookup, PLATFORM_SOURCE, MAX_FOLDERS } = require("./explore-window.cjs");
const { createWikiFolders, withIds } = require("./explore-wiki.cjs");

const sender = (url) => ({ getURL: () => url });
const ev = (url) => ({ sender: sender(url) });

function world() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "explore-window-"));
  const wikiDir = path.join(base, "Notes Wiki");
  fs.mkdirSync(path.join(wikiDir, "wiki"), { recursive: true });
  fs.writeFileSync(path.join(wikiDir, "wiki", "alpha.md"), "# Alpha\n\nLinks to [[beta]].\n");
  fs.writeFileSync(path.join(wikiDir, "wiki", "beta.md"), "# Beta\n\nBack to [[alpha]].\n");
  const store = createFolderStore({ file: path.join(base, "userData", "explore.json") });
  const roots = () => withIds(store.load());
  const folders = createWikiFolders({ roots, cacheMs: 0 });
  const opened = [];
  const calls = [];
  const down = { ok: false, unreachable: true, reason: "wiki_search: Name or service not known: aitheros-lyra", remedy: "start it" };
  const deps = {
    store, roots, folders,
    graph: { search: async (q, o) => { calls.push(["graph.search", q, o]); return { ok: true, nodes: [], graphs: { answered: [], searched: [], failed: [] }, notes: [], tookMs: 1 }; },
      neighbors: async (id) => ({ ok: true, center: id, nodes: [], edges: [] }), stats: async () => ({ ok: true, domains: [], loaded: [], failed: [], counts: [], errors: [] }) },
    platform: { list: async () => down, search: async () => down, read: async () => down, stats: async () => down },
    context: { sessions: async (o) => ({ ok: true, sessions: [], total: 0, query: o.query }), facts: async (id) => ({ ok: true, id }),
      request: async () => ({ ok: true }), traces: async () => ({ ok: false, refused: true, reason: "not available on the platform tier" }),
      trace: async () => ({ ok: true }), recall: async (q) => ({ ok: true, query: q, memories: [] }) },
    openUrl: (url) => opened.push(url),
    pickFolder: async () => wikiDir,
  };
  return { base, wikiDir, deps, opened, calls, store, cleanup: () => fs.rmSync(base, { recursive: true, force: true }) };
}

test("only the aither://explore page is answered", async (t) => {
  const w = world();
  t.after(w.cleanup);
  assert.equal(fromExplorePage(sender("aither://explore/")), true);
  assert.equal(fromExplorePage(sender("aither://explore/?tab=wiki&q=x")), true);
  for (const url of ["aither://notebooks/", "aither://explorer/", "https://explore/", "https://evil.example/aither://explore/", "file:///C:/desk/electron/explore.html",
    "aither://secrets/?x=aither://explore/", "", "not a url"]) {
    assert.equal(fromExplorePage(sender(url)), false, url);
  }
  const handlers = exploreHandlers(exploreOps(w.deps));
  assert.deepEqual(Object.keys(handlers), ["desk:explore-call"]);
  const call = handlers["desk:explore-call"];
  for (const from of [ev("https://evil.example/"), ev("aither://settings/"), { sender: null }, null, { sender: { getURL: () => { throw new Error("gone"); } } }]) {
    assert.deepEqual(await call(from, "graph.search", "x"), { ok: false, reason: "not the explore page" });
  }
  assert.equal(w.calls.length, 0, "a refused caller reached no adapter");
  assert.equal((await call(ev("aither://explore/"), "graph.search", "x", { domain: "code" })).ok, true);
  assert.deepEqual(w.calls, [["graph.search", "x", { domain: "code", limit: undefined }]]);
});

test("the operation table is closed: an unknown name, a prototype name and a throw are answers", async (t) => {
  const w = world();
  t.after(w.cleanup);
  const ops = exploreOps(w.deps);
  assert.deepEqual(Object.keys(ops).sort(), ["context.facts", "context.limits", "context.recall", "context.request", "context.sessions", "context.trace",
    "context.traces", "graph.neighbors", "graph.search", "graph.stats", "open.external", "wiki.addFolder", "wiki.graph", "wiki.list", "wiki.read",
    "wiki.removeFolder", "wiki.search", "wiki.sources"]);
  const call = (op, ...args) => exploreHandlers(ops)["desk:explore-call"](ev("aither://explore/"), op, ...args);
  for (const name of ["", "nope", "constructor", "__proto__", "toString", "hasOwnProperty", "wiki.delete", null, 7]) {
    const r = await call(name);
    assert.equal(r.ok, false, String(name));
    assert.match(r.reason, /not offered/);
  }
  const broken = exploreHandlers({ boom: () => { throw new Error("adapter blew up"); } })["desk:explore-call"];
  assert.deepEqual(await broken(ev("aither://explore/"), "boom"), { ok: false, reason: "adapter blew up" });
  assert.match((await call("context.limits")).notAvailable[0], /assembled prompt/);
});

test("wiki sources: the platform, then the owner's folders; add, read, graph, remove", async (t) => {
  const w = world();
  t.after(w.cleanup);
  const ops = exploreOps(w.deps);
  assert.deepEqual((await ops["wiki.sources"]()).sources, [PLATFORM_SOURCE]);
  const added = await ops["wiki.addFolder"]();
  assert.equal(added.ok, true);
  assert.equal(added.selected, "notes-wiki");
  assert.deepEqual(added.sources.map((s) => [s.id, s.kind, s.removable || false]), [["platform", "platform", false], ["notes-wiki", "folder", true]]);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(w.base, "userData", "explore.json"), "utf8")), { wikiFolders: [{ dir: w.wikiDir, label: "Notes Wiki" }] });
  assert.equal((await ops["wiki.addFolder"]()).sources.length, 2, "adding the same folder twice keeps one");

  assert.deepEqual((await ops["wiki.list"]("notes-wiki")).pages.map((p) => p.slug), ["alpha", "beta"]);
  assert.equal((await ops["wiki.read"]("notes-wiki", "alpha")).page.backlinks[0].slug, "beta");
  assert.equal((await ops["wiki.search"]("notes-wiki", "beta")).results[0].slug, "beta");
  assert.equal((await ops["wiki.graph"]("notes-wiki", {})).nodes.length, 2);
  assert.equal((await ops["wiki.graph"]("notes-wiki", { around: "alpha" })).edges.length, 2);
  // The platform being down is its own stated answer, and it has no link graph to draw.
  assert.equal((await ops["wiki.list"]("platform")).unreachable, true);
  assert.match((await ops["wiki.graph"]("platform", {})).reason, /0 link graphs from the platform/);
  // A source that is not in the list -- or is a path -- reads nothing.
  for (const bad of ["", "nope", w.wikiDir, "../notes-wiki", "notes-wiki/..", null]) {
    for (const op of ["wiki.list", "wiki.search", "wiki.read", "wiki.graph"]) assert.equal((await ops[op](bad, "alpha")).ok, false, `${op} ${bad}`);
  }
  assert.equal((await ops["wiki.removeFolder"]("platform")).ok, false);
  const removed = await ops["wiki.removeFolder"]("notes-wiki");
  assert.deepEqual(removed.sources, [PLATFORM_SOURCE]);
  assert.equal((await ops["wiki.list"]("notes-wiki")).ok, false);
});

test("the folder store: only folders, a cap, a corrupt file is no folders, cancel changes nothing", async (t) => {
  const w = world();
  t.after(w.cleanup);
  assert.equal(w.store.add(path.join(w.wikiDir, "wiki", "alpha.md")).ok, false);
  assert.equal(w.store.add(path.join(w.base, "missing")).ok, false);
  for (let i = 0; i < MAX_FOLDERS; i += 1) {
    const dir = path.join(w.base, `w${i}`);
    fs.mkdirSync(dir);
    assert.equal(w.store.add(dir).ok, true);
  }
  assert.match(w.store.add(w.wikiDir).reason, /is the limit/);
  fs.writeFileSync(path.join(w.base, "userData", "explore.json"), "{ not json");
  assert.deepEqual(w.store.load(), []);
  fs.writeFileSync(path.join(w.base, "userData", "explore.json"), JSON.stringify({ wikiFolders: [{ dir: "relative/path" }, { dir: 7 }, null, { dir: w.wikiDir }] }));
  assert.deepEqual(w.store.load().map((r) => r.dir), [w.wikiDir], "a relative or non-string entry is dropped");
  const cancelled = await exploreOps({ ...w.deps, pickFolder: async () => null })["wiki.addFolder"]();
  assert.equal(cancelled.cancelled, true);
  assert.equal((await exploreOps({ ...w.deps, pickFolder: null })["wiki.addFolder"]()).ok, false);
});

test("an external link opens as an owner web tab: http and https only", async (t) => {
  const w = world();
  t.after(w.cleanup);
  const open = exploreOps(w.deps)["open.external"];
  assert.deepEqual(await open("https://example.com/a?b=1"), { ok: true, url: "https://example.com/a?b=1" });
  for (const bad of ["javascript:alert(1)", "file:///C:/Windows/win.ini", "aither://secrets/", "data:text/html,x", "", "example.com", "chrome://settings"]) {
    assert.equal((await open(bad)).ok, false, bad);
  }
  assert.deepEqual(w.opened, ["https://example.com/a?b=1"]);
  assert.equal((await exploreOps({ ...w.deps, openUrl: null })["open.external"]("https://example.com/")).ok, false);
});

test("verbLookup: graph and context ask their adapter; wiki falls back to a folder and says which", async (t) => {
  const w = world();
  t.after(w.cleanup);
  assert.deepEqual(await verbLookup({ verb: "graph", arg: "", bare: true }, w.deps), {});
  assert.equal((await verbLookup({ verb: "graph", arg: "lyra" }, w.deps)).graph.ok, true);
  assert.deepEqual(w.calls[0], ["graph.search", "lyra", { limit: 8 }]);
  assert.equal((await verbLookup({ verb: "context", arg: "deploy" }, w.deps)).sessions.query, "deploy");
  // No folder: the platform's failure is the answer.
  assert.equal((await verbLookup({ verb: "wiki", arg: "beta" }, w.deps)).wiki.unreachable, true);
  w.store.add(w.wikiDir);
  const local = (await verbLookup({ verb: "wiki", arg: "beta" }, w.deps)).wiki;
  assert.deepEqual([local.ok, local.sourceId, local.label, local.results[0].slug], [true, "notes-wiki", "Notes Wiki", "beta"]);
  const up = { ...w.deps, platform: { ...w.deps.platform, search: async () => ({ ok: true, results: [{ slug: "p" }], total: 1 }) } };
  assert.equal((await verbLookup({ verb: "wiki", arg: "beta" }, up)).wiki.sourceId, "platform");
});

test("the pane: registered once, in Data, with its own preload, page script and vendored engine", () => {
  const { PANES } = require("./console-window.cjs");
  const internal = require("./browser-internal.cjs");
  const panes = PANES.filter((p) => p.id === "explore");
  assert.equal(panes.length, 1);
  const pane = panes[0];
  assert.deepEqual([pane.kind, pane.file, pane.section], ["file", "explore.html", "Data"]);
  assert.equal(internal.preloadFor(pane), "explore-preload.cjs");
  assert.equal(internal.internalUrl("explore"), "aither://explore/");
  assert.deepEqual(internal.paneNamespaceViolations(), []);
  // The page may load exactly its two scripts; desk code and other panes' scripts are refused.
  const route = (rel) => internal.resolveRequest(`aither://explore/${rel}`);
  assert.equal(route("explore-page.js").type, "file");
  assert.equal(route("vendor/bead-space/bead-space.iife.js").type, "file");
  assert.equal(route("vendor/bead-space/bead-space.css").type, "file");
  assert.equal(route("vendor/bead-space/kenney-simple-space/station_A.png").type, "file");
  for (const rel of ["explore-window.cjs", "explore-preload.cjs", "main.cjs", "notebooks-page.js", "secrets.html", "../package.json", "vendor/xterm/xterm.js"]) {
    assert.equal(route(rel).type, "missing", rel);
  }
  // An agent's tab can never be an Aither page (browser-tabs.cjs), so it can never be this one.
  const { TabSet } = require("./browser-tabs.cjs");
  const tabs = new TabSet();
  assert.deepEqual(tabs.add("agent", { kind: "internal" }), { ok: false, error: "an agent may only open web tabs; Aither pages belong to the owner" });
  assert.equal(tabs.add("you", { kind: "internal" }).ok, true);
  for (const kind of ["web", "hosted"]) assert.equal(internal.navigationVerdict(kind, "aither://explore/"), "deny", kind);
  assert.equal(internal.navigationVerdict("web", "aither://explore/", { frame: true }), "deny");
});

test("the page: a strict CSP, no inline script, no remote address, the bridge it names exists", () => {
  const html = fs.readFileSync(path.join(__dirname, "explore.html"), "utf8");
  const csp = /http-equiv="Content-Security-Policy" content="([^"]+)"/.exec(html)[1];
  assert.match(csp, /default-src 'none'/);
  assert.equal(/unsafe-eval|https?:|\*/.test(csp), false);
  assert.equal(/script-src[^;]*unsafe-inline/.test(csp), false);
  assert.equal(/connect-src/.test(csp), false, "no connect-src: default-src 'none' forbids every fetch");
  assert.equal(/<script(?![^>]*\ssrc=)[^>]*>/.test(html), false, "no inline script");
  assert.equal(/\son[a-z]+="/i.test(html), false, "no inline handler");
  assert.equal(/(src|href)="(https?:)?\/\//.test(html), false);
  const page = fs.readFileSync(path.join(__dirname, "explore-page.js"), "utf8");
  assert.equal(/\bfetch\(|XMLHttpRequest|WebSocket|eval\(|new Function/.test(page), false, "the page reads only through its bridge");
  assert.match(fs.readFileSync(path.join(__dirname, "explore-preload.cjs"), "utf8"), /exposeInMainWorld\("aitherExplore"/);
  assert.match(fs.readFileSync(path.join(__dirname, "console-preload.cjs"), "utf8"), /href\.includes\("\/explore\.html"\)\) \{\s*require\("\.\/explore-preload\.cjs"\)/);
});

test("the vendored engine is the SAME build the Space pane loads (re-vendor both or this fails)", () => {
  const sha = (file) => createHash("sha256").update(fs.readFileSync(file)).digest("hex");
  const src = path.join(__dirname, "..", "src", "vendor", "bead-space", "engine");
  const mine = path.join(__dirname, "vendor", "bead-space");
  const build = JSON.parse(fs.readFileSync(path.join(src, "BUILD.json"), "utf8"));
  assert.equal(sha(path.join(mine, "bead-space.iife.js")), sha(path.join(src, "bead-space.iife.js")));
  assert.equal(sha(path.join(mine, "bead-space.css")), sha(path.join(src, "bead-space.css")));
  assert.equal(typeof build.bundle_sha256, "string");
  const sprites = path.join(__dirname, "..", "public", "bead-space", "kenney-simple-space");
  for (const name of fs.readdirSync(sprites)) assert.equal(sha(path.join(mine, "kenney-simple-space", name)), sha(path.join(sprites, name)), name);
  // electron-builder ships electron/**/*.{html,css,json,js,svg,png}: the copy is in the package.
  const files = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "package.json"), "utf8")).build.files;
  assert.ok(files.includes("electron/**/*.{html,css,json,js,svg,png}"));
});
