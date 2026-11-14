"use strict";

/**
 * explore-graph.cjs -- the Graph tab of aither://explore: ONE adapter over the platform's
 * own graph tools at the local gateway (gateway-mcp.cjs). No graph store here.
 *
 *   search     graph_find (every registered graph in one call) -- and graph_search too
 *              when a domain is chosen, since only that tool takes a domain filter
 *   neighbors  graph_traverse (one hop from a node)
 *   stats      graph_stats + graph_domains
 *
 * Shapes measured against the live gateway (2026-11-13):
 *   graph_find      {ok, result: {graphs_answered, graphs_searched, total_hits,
 *                    per_graph: {<Graph>: [hit...] | {error}}}}; a hit is
 *                    {id, name, domain, score} or {id, name, file, type, signature},
 *                    and RAG-style graphs answer {type: "document_answer", answer} (no id)
 *   graph_search    {query, domain, count, results: [...]}
 *   graph_traverse  {node_id, neighbors: [...]}
 *   graph_stats     {loaded_backends, failed_backends, available_domains, code, provenance}
 *   graph_domains   {domains: [{domain, status}]}
 *
 * "Could not look" never reads as "nothing there": a gateway that is down, a missing
 * bearer, a slow tool, a tool that answers prose or {error} each come back as
 * {ok:false, reason, remedy} (unreachable: true when the gateway itself is the problem).
 * A graph that errored inside an otherwise good answer is listed in `graphs.failed`.
 *
 * callTool is injected, so explore-graph.test.cjs runs every case under `node --test`.
 */

const { bounded } = require("./explore-wiki.cjs");

const MAX_QUERY = 200;
const GRAPH_REMEDY = "AitherGraph (:8154) did not answer the gateway: check the aitheros-graph service";

function clip(text, n) {
  const t = String(text == null ? "" : text).replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
}

function parse(raw) {
  if (raw && typeof raw === "object") return raw;
  try { return JSON.parse(String(raw || "")); } catch { return null; }
}

function failure(name, error) {
  const msg = String((error && error.message) || error || "no answer");
  if (/no session bearer/i.test(msg)) {
    return { ok: false, unreachable: true, reason: "0 gateway sessions — this desk has no session bearer",
      remedy: "sign in, or mint ~/.aither/session-bearer (mint_session_bearer.py)" };
  }
  if (/ECONNREFUSED|EHOSTUNREACH|ENETUNREACH|ENOTFOUND|EAI_AGAIN|gateway timeout|socket hang up|ECONNRESET/i.test(msg)) {
    return { ok: false, unreachable: true, reason: `1 gateway did not answer — ${clip(msg, 120)}`,
      remedy: "start the local gateway (127.0.0.1:8182) and AitherGraph (:8154)" };
  }
  if (/took over/i.test(msg)) return { ok: false, slow: true, reason: `${name}: ${clip(msg, 120)}`, remedy: "search again, or narrow it with a domain" };
  if (/HTTP 40[13]/.test(msg)) return { ok: false, unreachable: true, reason: `1 gateway refused this desk — ${clip(msg, 120)}`, remedy: "sign in again (the session bearer was refused)" };
  return { ok: false, reason: `${name}: ${clip(msg, 160)}`, remedy: GRAPH_REMEDY };
}

const SCALAR = (v) => v == null || ["string", "number", "boolean"].includes(typeof v);

/** One hit of any graph tool -> a node the pane can draw, or null when it names nothing. */
function nodeOf(hit, graph = "") {
  if (!hit || typeof hit !== "object") return null;
  const id = String(hit.id || hit.node_id || hit.uid || "");
  const title = String(hit.name || hit.title || hit.label || id);
  if (!id || !title) return null;
  const props = {};
  for (const [k, v] of Object.entries(hit)) {
    if (["id", "node_id", "uid", "name", "title", "label", "score", "domain", "type"].includes(k)) continue;
    if (Object.keys(props).length >= 24) break;
    props[k] = SCALAR(v) ? (typeof v === "string" ? clip(v, 400) : v) : clip(JSON.stringify(v), 400);
  }
  return { id: id.slice(0, 300), title: clip(title, 160), type: String(hit.type || hit.kind || hit.node_type || ""),
    domain: String(hit.domain || ""), graph: String(graph || hit.graph || hit.source || ""),
    score: Number.isFinite(Number(hit.score)) ? Number(hit.score) : null, props };
}

/** A traverse neighbour -> {node, relation}. The tool's rows have been seen as {id|name, relation}. */
function neighborOf(n) {
  if (typeof n === "string") return { node: { id: n, title: clip(n, 160), type: "", domain: "", graph: "", score: null, props: {} }, relation: "" };
  if (!n || typeof n !== "object") return null;
  const inner = n.node && typeof n.node === "object" ? { ...n.node } : { ...n };
  if (!inner.id && !inner.node_id && inner.name) inner.id = inner.name;
  const node = nodeOf(inner, n.graph || "");
  if (!node) return null;
  return { node, relation: clip(n.relation || n.edge_type || n.rel || n.relationship || n.edge || "", 60) };
}

function createGraphAdapter({ callTool = (...a) => require("./gateway-mcp.cjs").callTool(...a), timeoutMs = 25_000 } = {}) {
  async function tool(name, args) {
    let raw;
    try { raw = await bounded(Promise.resolve().then(() => callTool(name, args)), timeoutMs, name); }
    catch (error) { return failure(name, error); }
    const data = parse(raw);
    if (data == null || typeof data !== "object") {
      return { ok: false, reason: `${name} answered text, not JSON: ${clip(raw, 140)}`, remedy: GRAPH_REMEDY };
    }
    if (data.ok === false || (data.error && !data.result && !data.results && !data.neighbors)) {
      const why = typeof data.error === "string" ? data.error : JSON.stringify(data.error || data.reason || "refused");
      return { ok: false, unreachable: /not known|refused|unreachable|connect/i.test(why), reason: `${name}: ${clip(why, 160)}`, remedy: GRAPH_REMEDY };
    }
    return { ok: true, data };
  }

  /**
   * Search every graph. {ok, query, nodes, graphs: {answered, searched, failed}, notes}.
   * `domain` narrows it: graph_search runs with that domain and graph_find hits of
   * another domain are dropped.
   */
  async function search(query, { domain = "", limit = 12 } = {}) {
    const q = clip(query, MAX_QUERY);
    if (!q) return { ok: false, reason: "type what to look for" };
    const dom = String(domain || "").toLowerCase().replace(/[^a-z0-9_-]/g, "").slice(0, 40);
    const cap = Math.max(1, Math.min(50, Number(limit) || 12));
    const started = Date.now();
    const found = await tool("graph_find", { query: q, limit: cap });
    const byDomain = dom ? await tool("graph_search", { query: q, domain: dom, limit: cap }) : null;
    if (!found.ok && !(byDomain && byDomain.ok)) return found;
    const nodes = [];
    const seen = new Set();
    const notes = [];
    const graphs = { answered: [], searched: [], failed: [] };
    const push = (node) => {
      if (!node || seen.has(node.id)) return;
      if (dom && node.domain && node.domain.toLowerCase() !== dom) return;
      seen.add(node.id);
      nodes.push(node);
    };
    if (found.ok) {
      const res = found.data.result && typeof found.data.result === "object" ? found.data.result : found.data;
      graphs.answered = (res.graphs_answered || []).map(String);
      graphs.searched = (res.graphs_searched || []).map(String);
      for (const [name, hits] of Object.entries(res.per_graph || {})) {
        if (!Array.isArray(hits)) {
          if (hits && hits.error) graphs.failed.push({ graph: name, reason: clip(hits.error, 120) });
          continue;
        }
        for (const h of hits) {
          const node = nodeOf(h, name);
          if (node) push(node);
          else if (h && h.answer) notes.push(`${name}: ${clip(h.answer, 200)}`);
        }
      }
    } else {
      notes.push(`graph_find: ${found.reason}`);
    }
    if (byDomain) {
      if (byDomain.ok) for (const h of byDomain.data.results || []) push(nodeOf(h, `graph_search · ${dom}`));
      else notes.push(`graph_search: ${byDomain.reason}`);
    }
    nodes.sort((a, b) => (b.score == null ? -1 : b.score) - (a.score == null ? -1 : a.score));
    return { ok: true, query: q, domain: dom, nodes, graphs, notes, tookMs: Date.now() - started };
  }

  /** One hop out of a node: {ok, center, nodes, edges}. */
  async function neighbors(nodeId) {
    const id = String(nodeId == null ? "" : nodeId).trim();
    // eslint-disable-next-line no-control-regex
    if (!id || id.length > 300 || /[\u0000-\u001f]/.test(id)) return { ok: false, reason: "not a node id" };
    const r = await tool("graph_traverse", { node_id: id, max_hops: 1 });
    if (!r.ok) return r;
    const nodes = [];
    const edges = [];
    const seen = new Set([id]);
    for (const raw of Array.isArray(r.data.neighbors) ? r.data.neighbors.slice(0, 80) : []) {
      const n = neighborOf(raw);
      if (!n || seen.has(n.node.id)) continue;
      seen.add(n.node.id);
      nodes.push(n.node);
      edges.push({ source: id, target: n.node.id, relation: n.relation });
    }
    return { ok: true, center: id, nodes, edges };
  }

  /** What the graph service holds: backends, domains and their status, counts. Each half fails alone. */
  async function stats() {
    const [s, d] = [await tool("graph_stats", {}), await tool("graph_domains", {})];
    if (!s.ok && !d.ok) return s;
    const domains = d.ok && Array.isArray(d.data.domains)
      ? d.data.domains.map((x) => ({ domain: String(x.domain || ""), status: String(x.status || "") })).filter((x) => x.domain)
      : (s.ok ? (s.data.available_domains || []).map((x) => ({ domain: String(x), status: "" })) : []);
    const st = s.ok ? s.data : {};
    const counts = [];
    for (const [k, v] of Object.entries(st)) {
      if (!v || typeof v !== "object" || Array.isArray(v)) continue;
      for (const [kk, vv] of Object.entries(v)) if (typeof vv === "number") counts.push({ label: `${k} ${kk}`.replace(/_/g, " "), value: vv });
    }
    return { ok: true, domains, loaded: (st.loaded_backends || []).map(String), failed: (st.failed_backends || []).map(String),
      counts: counts.slice(0, 24), errors: [s.ok ? null : s.reason, d.ok ? null : d.reason].filter(Boolean) };
  }

  return { search, neighbors, stats };
}

module.exports = { GRAPH_REMEDY, createGraphAdapter, failure, neighborOf, nodeOf };
