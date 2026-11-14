"use strict";

// The Alt+Space verbs graph / wiki / context: parsing, the rows, the address they open,
// and the registry / launcher wiring that makes Enter land in aither://explore.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { exploreUrl, parseExploreVerb, verbGroup, verbRows } = require("./explore-verbs.cjs");

const SID = "11111111-2222-4333-8444-555555555555";

test("parse: the verb is the first word; aliases; a bare verb keeps the ordinary search", () => {
  assert.deepEqual(parseExploreVerb("graph  lyra   wiki "), { verb: "graph", arg: "lyra wiki", bare: false, keepSearch: false });
  assert.deepEqual(parseExploreVerb("Graphs x"), { verb: "graph", arg: "x", bare: false, keepSearch: false });
  assert.deepEqual(parseExploreVerb("kg x").verb, "graph");
  assert.deepEqual(parseExploreVerb("wiki agent loop"), { verb: "wiki", arg: "agent loop", bare: false, keepSearch: false });
  assert.equal(parseExploreVerb("lyrawiki x").verb, "wiki");
  assert.equal(parseExploreVerb("brain x").verb, "wiki");
  assert.deepEqual(parseExploreVerb("context deploy"), { verb: "context", arg: "deploy", bare: false, keepSearch: false });
  assert.deepEqual(parseExploreVerb(`ctx ${SID.toUpperCase()}`), { verb: "context", arg: SID.toUpperCase(), bare: false, keepSearch: false, session: SID });
  assert.deepEqual(parseExploreVerb("graph"), { verb: "graph", arg: "", bare: true, keepSearch: true });
  for (const not of ["", "  ", "graphql server", "wikipedia cats", "contextual", "> graph x", "?wiki x", "@context", "!graph", "draw", "the graph"]) {
    assert.equal(parseExploreVerb(not), null, not);
  }
  assert.equal(parseExploreVerb(`wiki ${"x".repeat(900)}`).arg.length, 200);
  assert.equal(parseExploreVerb("wiki a\u0000b\u0007c").arg, "a b c");
});

test("the address: only known keys, each bounded, an unknown tab is the graph", () => {
  assert.equal(exploreUrl({ tab: "graph", q: "lyra wiki", node: "faculty:ServiceGraph:LyraWiki" }),
    "aither://explore/?tab=graph&q=lyra+wiki&node=faculty%3AServiceGraph%3ALyraWiki");
  assert.equal(exploreUrl({ tab: "wiki", q: "loop", page: "agent-loop", source: "fixture" }), "aither://explore/?tab=wiki&q=loop&page=agent-loop&source=fixture");
  assert.equal(exploreUrl({ tab: "context", session: SID, node: "x", page: "y" }), `aither://explore/?tab=context&session=${SID}`);
  assert.equal(exploreUrl({ tab: "secrets", q: "x" }), "aither://explore/?tab=graph&q=x");
  assert.equal(exploreUrl({ tab: "wiki", source: "../etc", page: "a&tab=context" }), "aither://explore/?tab=wiki&page=a%26tab%3Dcontext");
  assert.equal(exploreUrl({ tab: "context", session: "not-an-id" }), "aither://explore/?tab=context");
  assert.equal(exploreUrl(null), "aither://explore/?tab=graph");
  assert.equal(exploreUrl("javascript:alert(1)"), "aither://explore/?tab=graph");
  const url = new URL(exploreUrl({ tab: "graph", q: "a/../b#c?d=1" }));
  assert.equal(url.hostname, "explore");
  assert.equal(url.searchParams.get("q"), "a/../b#c?d=1");
  // The pane's own address parser accepts every address this builds.
  const internal = require("./browser-internal.cjs");
  assert.equal(internal.parseInternalUrl(exploreUrl({ tab: "wiki", q: "x" })).paneId, "explore");
});

test("rows: the first row always opens Explore at the query; results follow; every action is explore.open", () => {
  const v = parseExploreVerb("graph lyra");
  const pending = verbRows(v, {});
  assert.deepEqual(pending.rows.map((r) => r.action), [{ type: "command", id: "explore.open", arg: { tab: "graph", q: "lyra" } }]);
  assert.equal(pending.status, "Searching the platform graphs…");
  const done = verbRows(v, { graph: { ok: true, graphs: { answered: ["A", "B"], searched: ["A", "B", "C"] },
    nodes: Array.from({ length: 7 }, (_, i) => ({ id: `n${i}`, title: `Node ${i}`, type: "service", graph: "AitherGraph" })) } });
  assert.equal(done.rows.length, 6);
  assert.deepEqual(done.rows[1].action.arg, { tab: "graph", q: "lyra", node: "n0" });
  assert.equal(done.rows[1].subtitle, "service · AitherGraph");
  assert.equal(done.status, "7 graph nodes from 2 graphs · +2 more in Explore");
  for (const r of done.rows) { assert.match(r.key, /^verb:explore-/); assert.equal(r.action.id, "explore.open"); }
  assert.equal(verbRows(v, { graph: { ok: true, nodes: [], graphs: { answered: [], searched: ["A", "B"] } } }).status, "0 graph nodes for “lyra” — 2 graphs searched");
  const group = verbGroup(v, done.rows);
  assert.equal(group.label, "Explore · Graph");
  assert.deepEqual(Object.keys(group.items[0]).sort(), ["key", "kind", "subtitle", "title"], "no action or node id reaches the launcher page");
});

test("rows: a source that could not look says so in the status, and Enter still opens the pane", () => {
  const down = { ok: false, unreachable: true, reason: "1 gateway did not answer — connect ECONNREFUSED 127.0.0.1:8182", remedy: "start the local gateway (127.0.0.1:8182)" };
  const g = verbRows(parseExploreVerb("graph x"), { graph: down });
  assert.equal(g.rows.length, 1);
  assert.match(g.status, /^1 graph source down — 1 gateway did not answer .* · start the local gateway/);
  const w = verbRows(parseExploreVerb("wiki x"), { wiki: { ...down, reason: "wiki_search: Name or service not known: aitheros-lyra" } });
  assert.match(w.status, /^1 wiki source down — wiki_search: Name or service not known: aitheros-lyra/);
  assert.deepEqual(w.rows[0].action.arg, { tab: "wiki", q: "x" });
});

test("rows: wiki results carry their source; context lists sessions or opens one by id", () => {
  const w = verbRows(parseExploreVerb("wiki loop"), { wiki: { ok: true, sourceId: "fixture", label: "Fixture", total: 1,
    results: [{ slug: "agent-loop", title: "Agent Loop", snippet: "The loop reads memory" }] } });
  assert.deepEqual(w.rows[1].action.arg, { tab: "wiki", q: "loop", page: "agent-loop", source: "fixture" });
  assert.equal(w.status, "1 wiki page in Fixture");
  assert.equal(verbRows(parseExploreVerb("wiki zzz"), { wiki: { ok: true, label: "Fixture", results: [], total: 0 } }).status, "0 wiki pages for “zzz” in Fixture");

  const c = verbRows(parseExploreVerb("context deploy"), { sessions: { ok: true, sessions: [{ id: SID, title: "Deploy the desk", status: "working", project: "C--proj" }] } });
  assert.deepEqual(c.rows.map((r) => r.action.arg), [{ tab: "context", q: "deploy" }, { tab: "context", session: SID }]);
  assert.equal(c.rows[1].subtitle, "working · C--proj · 11111111");
  const byId = verbRows(parseExploreVerb(`context ${SID}`), {});
  assert.deepEqual(byId.rows.map((r) => r.action.arg), [{ tab: "context", session: SID }]);
  assert.match(verbRows(parseExploreVerb("context zzz"), { sessions: { ok: true, sessions: [] } }).status, /^0 sessions match “zzz”/);
});

test("a bare verb answers one row that opens its tab", () => {
  for (const [word, tab] of [["graph", "graph"], ["wiki", "wiki"], ["context", "context"]]) {
    const { rows, status } = verbRows(parseExploreVerb(word), {});
    assert.deepEqual(rows.map((r) => r.action.arg), [{ tab }]);
    assert.ok(status.length > 10);
  }
  assert.deepEqual(verbRows(null), { rows: [], status: "" });
});

test("wiring: the registry row, main's handler, the launcher hook and the row verb's way in", () => {
  const registry = require("./command-registry.cjs");
  const row = registry.byId("explore.open");
  assert.ok(row, "explore.open is in the command registry");
  assert.deepEqual([...row.surfaces], ["palette"]);
  assert.ok(row.whySingle && row.whySingle.length > 20, "a single-surface row says why");
  assert.deepEqual(registry.conformance(), [], "the registry still conforms");
  const read = (name) => fs.readFileSync(path.join(__dirname, name), "utf8");
  assert.match(read("main.cjs"), /case "explore\.open": return void browserWindow\.openInternalUrl\(\s*require\("\.\/explore-verbs\.cjs"\)\.exploreUrl\(/);
  assert.match(read("main.cjs"), /require\("\.\/explore-window\.cjs"\)\.ensureExploreIpc\(/);
  const launcher = read("launcher-window.cjs");
  assert.match(launcher, /parseExploreVerb\(text\)/);
  assert.match(launcher, /"verb:explore-from-graph", \{ type: "command", id: "explore\.open", arg: verdict\.explore \}/);
  // ONE graph verb: the row verb's answer carries the pane's address instead of a second view.
  assert.match(read("command-center.cjs"), /explore: \{ tab: "graph", q: clip\(r\.title, 120\) \}/);
  assert.match(read("launcher.html"), /window\.aitherLauncher\.run\(g\.explore, ""\)/);
  // No desk or browser verb claims the same first words.
  for (const word of ["graph x", "wiki x", "context x"]) {
    assert.equal(require("./desk-verbs.cjs").parseDeskVerb(word), null, word);
  }
});
