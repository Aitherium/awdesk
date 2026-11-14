"use strict";

// The Graph tab's adapter over the gateway's graph tools: up, down, slow, malformed.
// The "up" answers are the shapes the live gateway returned on 2026-11-13.

const test = require("node:test");
const assert = require("node:assert/strict");
const { createGraphAdapter, neighborOf, nodeOf } = require("./explore-graph.cjs");

const FIND = {
  ok: true,
  result: {
    query: "wiki", graphs_answered: ["AitherGraph", "RAGAnythingGraph", "CodeGraph:svc"],
    graphs_searched: ["AitherGraph", "BusinessGraph", "MediaGraph", "RAGAnythingGraph", "CodeGraph:svc"], total_hits: 3,
    per_graph: {
      AitherGraph: [{ id: "faculty:ServiceGraph:LyraWiki", name: "LyraWiki", domain: "service", score: 0.5 }],
      BusinessGraph: [],
      MediaGraph: { error: "timeout" },
      RAGAnythingGraph: [{ type: "document_answer", answer: "RAG-Anything engine not available.", mode: "mix" }],
      "CodeGraph:svc": [{ id: "func_wiki_e98647d7", name: "wiki", file: "/app/AitherOS/lib/fleetcontrol/research.py", type: "function",
        signature: "def wiki(query: str) -> WikiContent" }],
    },
  },
};

function fake(table) {
  const calls = [];
  const callTool = async (name, args) => {
    calls.push([name, args]);
    const answer = table[name];
    if (answer instanceof Error) throw answer;
    if (typeof answer === "function") return answer(args);
    return typeof answer === "string" ? answer : JSON.stringify(answer);
  };
  return { calls, adapter: createGraphAdapter({ callTool, timeoutMs: 200 }) };
}

test("up: graph_find hits become nodes with type, source and properties", async () => {
  const { adapter, calls } = fake({ graph_find: FIND });
  const r = await adapter.search("  wiki  ");
  assert.equal(r.ok, true);
  assert.deepEqual(calls, [["graph_find", { query: "wiki", limit: 12 }]]);
  assert.deepEqual(r.nodes.map((n) => [n.id, n.title, n.type, n.graph, n.domain]), [
    ["faculty:ServiceGraph:LyraWiki", "LyraWiki", "", "AitherGraph", "service"],
    ["func_wiki_e98647d7", "wiki", "function", "CodeGraph:svc", ""],
  ]);
  assert.equal(r.nodes[1].props.file, "/app/AitherOS/lib/fleetcontrol/research.py");
  assert.deepEqual(r.graphs.answered, ["AitherGraph", "RAGAnythingGraph", "CodeGraph:svc"]);
  // A graph that errored inside a good answer is named, and a prose answer is a note.
  assert.deepEqual(r.graphs.failed, [{ graph: "MediaGraph", reason: "timeout" }]);
  assert.deepEqual(r.notes, ["RAGAnythingGraph: RAG-Anything engine not available."]);
});

test("up: a domain filter also asks graph_search and drops hits of another domain", async () => {
  const { adapter, calls } = fake({ graph_find: FIND,
    graph_search: { query: "wiki", domain: "service", count: 1, results: [{ id: "svc:lyra", name: "aitheros-lyra", domain: "service", score: 0.9 }] } });
  const r = await adapter.search("wiki", { domain: "Service; DROP", limit: 500 });
  assert.deepEqual(calls[1], ["graph_search", { query: "wiki", domain: "servicedrop", limit: 50 }]);
  const again = await fake({ graph_find: FIND, graph_search: { results: [{ id: "svc:lyra", name: "aitheros-lyra", domain: "service", score: 0.9 }] } })
    .adapter.search("wiki", { domain: "service" });
  assert.deepEqual(again.nodes.map((n) => n.id), ["svc:lyra", "faculty:ServiceGraph:LyraWiki", "func_wiki_e98647d7"]);
  assert.equal(r.ok, true);
});

test("up but empty: a real empty result is ok with the graphs that were searched", async () => {
  const { adapter } = fake({ graph_find: { ok: true, result: { graphs_answered: [], graphs_searched: ["AitherGraph", "MemoryGraph"], per_graph: { AitherGraph: [], MemoryGraph: [] } } } });
  const r = await adapter.search("zzz");
  assert.equal(r.ok, true);
  assert.deepEqual(r.nodes, []);
  assert.equal(r.graphs.searched.length, 2);
});

test("down: a refused socket, a missing bearer and a refused bearer are UNREACHABLE with what to start", async () => {
  const refused = await fake({ graph_find: Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:8182"), { code: "ECONNREFUSED" }) }).adapter.search("x");
  assert.equal(refused.ok, false);
  assert.equal(refused.unreachable, true);
  assert.match(refused.remedy, /127\.0\.0\.1:8182/);
  assert.equal("nodes" in refused, false, "never an empty node list standing in for could-not-look");

  const noBearer = await fake({ graph_find: new Error("no session bearer") }).adapter.search("x");
  assert.equal(noBearer.unreachable, true);
  assert.match(noBearer.remedy, /session-bearer/);

  const denied = await fake({ graph_find: new Error("HTTP 401: invalid token") }).adapter.search("x");
  assert.equal(denied.unreachable, true);

  const svcDown = await fake({ graph_find: { error: "[Errno -2] Name or service not known: aitheros-graph" } }).adapter.search("x");
  assert.equal(svcDown.ok, false);
  assert.equal(svcDown.unreachable, true);
  assert.match(svcDown.reason, /aitheros-graph/);
});

test("slow: a tool that never answers is cut off and says so", async () => {
  const { adapter } = fake({ graph_find: () => new Promise(() => {}) });
  const started = Date.now();
  const r = await adapter.search("x");
  assert.ok(Date.now() - started < 2000);
  assert.equal(r.ok, false);
  assert.equal(r.slow, true);
  assert.match(r.reason, /graph_find: graph_find took over/);
});

test("malformed: prose, a bare number, {ok:false} and junk rows never throw or invent nodes", async () => {
  const prose = await fake({ graph_find: "Tool 'graph_find' is not available on the platform tier." }).adapter.search("x");
  assert.equal(prose.ok, false);
  assert.match(prose.reason, /answered text, not JSON: Tool 'graph_find' is not available/);
  assert.equal((await fake({ graph_find: "42" }).adapter.search("x")).ok, false);
  const refused = await fake({ graph_find: { ok: false, error: { code: 7, message: "tenant scope" } } }).adapter.search("x");
  assert.equal(refused.ok, false);
  assert.match(refused.reason, /tenant scope/);
  const junk = await fake({ graph_find: { ok: true, result: { per_graph: { G: [null, 3, "s", {}, { name: "no id" }, { id: "a" }], H: "nope", I: null } } } }).adapter.search("x");
  assert.equal(junk.ok, true);
  assert.deepEqual(junk.nodes.map((n) => [n.id, n.title]), [["a", "a"]]);
  assert.equal((await fake({}).adapter.search("   ")).reason, "type what to look for");
});

test("neighbors: one hop, the rows the tool has been seen to return, and a real empty", async () => {
  const { adapter, calls } = fake({ graph_traverse: { node_id: "n1", neighbors: [
    { id: "n2", name: "Two", relation: "depends_on", type: "service" }, "n3", { node: { id: "n4", name: "Four" }, edge_type: "calls" },
    { name: "name-only", relation: "mentions" }, { id: "n2", name: "dup" }, { id: "n1", name: "self" }, null] } });
  const r = await adapter.neighbors("n1");
  assert.deepEqual(calls, [["graph_traverse", { node_id: "n1", max_hops: 1 }]]);
  assert.deepEqual(r.nodes.map((n) => n.id), ["n2", "n3", "n4", "name-only"]);
  assert.deepEqual(r.edges, [{ source: "n1", target: "n2", relation: "depends_on" }, { source: "n1", target: "n3", relation: "" },
    { source: "n1", target: "n4", relation: "calls" }, { source: "n1", target: "name-only", relation: "mentions" }]);
  // Measured live: {"node_id": "...", "neighbors": []}.
  const none = await fake({ graph_traverse: { node_id: "faculty:ServiceGraph:LyraWiki", neighbors: [] } }).adapter.neighbors("faculty:ServiceGraph:LyraWiki");
  assert.deepEqual([none.ok, none.nodes.length], [true, 0]);
  for (const bad of ["", " ", "a\u0000b", "x".repeat(400)]) assert.equal((await adapter.neighbors(bad)).ok, false);
  assert.equal((await fake({ graph_traverse: new Error("gateway timeout") }).adapter.neighbors("n1")).unreachable, true);
});

test("stats: backends, domains and counts; each half fails alone", async () => {
  const stats = { loaded_backends: ["memory", "knowledge"], failed_backends: [], available_domains: ["code", "wiki"],
    code: { chunks: 0, files: 0 }, provenance: { nodes: 25423, edges: 18013, db_path: "/data/provenance/graph.db" } };
  const both = await fake({ graph_stats: stats, graph_domains: { domains: [{ domain: "memory", status: "loaded" }, { domain: "wiki", status: "available" }] } }).adapter.stats();
  assert.deepEqual(both.loaded, ["memory", "knowledge"]);
  assert.deepEqual(both.domains, [{ domain: "memory", status: "loaded" }, { domain: "wiki", status: "available" }]);
  assert.deepEqual(both.counts.find((c) => c.label === "provenance nodes"), { label: "provenance nodes", value: 25423 });
  const half = await fake({ graph_stats: stats, graph_domains: new Error("gateway timeout") }).adapter.stats();
  assert.equal(half.ok, true);
  assert.deepEqual(half.domains.map((d) => d.domain), ["code", "wiki"]);
  assert.equal(half.errors.length, 1);
  const none = await fake({ graph_stats: new Error("connect ECONNREFUSED"), graph_domains: new Error("connect ECONNREFUSED") }).adapter.stats();
  assert.equal(none.ok, false);
  assert.equal(none.unreachable, true);
});

test("nodeOf / neighborOf: properties are clipped scalars, objects are serialised, no id means no node", () => {
  const n = nodeOf({ id: "x", name: "X", score: "0.5", meta: { a: 1 }, long: "y".repeat(900) }, "G");
  assert.equal(n.score, 0.5);
  assert.equal(n.props.meta, "{\"a\":1}");
  assert.equal(n.props.long.length, 400);
  assert.equal(nodeOf({ name: "nameless" }), null);
  assert.equal(neighborOf(7), null);
});
