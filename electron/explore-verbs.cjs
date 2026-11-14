"use strict";

/**
 * explore-verbs.cjs -- the Alt+Space verbs that jump into aither://explore (owner,
 * 2026-11-13: "an easy way to query view knowledge graph and graphs and lyrawiki /
 * llm.wiki + agent/llm context"). The verb is the first word:
 *
 *   graph <words>              search every platform graph; Enter opens the Graph tab there
 *   wiki <words>               search the wiki (platform, else a wiki folder on this computer)
 *   context <words | session>  sessions matching the words (or one session id); Enter opens
 *                              the Context tab, where the same words also run a memory recall
 *
 * Aliases: graphs, kg -> graph; lyrawiki, brain -> wiki; ctx -> context.
 *
 * A bare verb ("graph") keeps the ordinary search underneath and adds one row that
 * opens the tab. A verb with words answers with its own rows: the first is always
 * "Open Explore at <words>", then the top results inline.
 *
 * This is the TYPED graph verb. The row verb Ctrl+G (command-center.cjs graph()) stays
 * the one-neighbourhood peek; its answer now carries `explore`, the same address this
 * module builds, so the peek and the pane are one path and not two graph views.
 *
 * Every action is {type: "command", id: "explore.open", arg}: one registry row, run by
 * main. parseExploreVerb(), exploreUrl() and verbRows() are pure (explore-verbs.test.cjs).
 */

const ALIASES = Object.freeze({
  graph: "graph", graphs: "graph", kg: "graph",
  wiki: "wiki", lyrawiki: "wiki", brain: "wiki",
  context: "context", ctx: "context",
});
const TABS = Object.freeze(["graph", "wiki", "context"]);
const MAX_ARG = 200;
const MAX_ROWS = 5;
const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LABEL = Object.freeze({ graph: "Graph", wiki: "Wiki", context: "Context" });

function clip(text, n) {
  const t = String(text == null ? "" : text).replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
}

/**
 * The explore verb in a launcher query, or null when the text is an ordinary search.
 * @param {string} text
 * @returns {null | {verb: "graph"|"wiki"|"context", arg: string, bare: boolean, keepSearch: boolean, session?: string}}
 */
function parseExploreVerb(text) {
  const raw = String(text == null ? "" : text).trim();
  if (!raw || /^[>?@!]/.test(raw)) return null;
  const m = /^(\S+)(?:\s+([\s\S]*))?$/.exec(raw);
  if (!m) return null;
  const verb = ALIASES[m[1].toLowerCase()];
  if (!verb) return null;
  // eslint-disable-next-line no-control-regex
  const arg = String(m[2] || "").replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, MAX_ARG);
  const out = { verb, arg, bare: !arg, keepSearch: !arg };
  if (verb === "context" && SESSION_ID.test(arg)) out.session = arg.toLowerCase();
  return out;
}

/**
 * The aither://explore address for a tab and what to show in it. Only known keys ride,
 * each cut to a safe length; the page re-validates everything it reads.
 * @param {{tab?: string, q?: string, node?: string, page?: string, source?: string, session?: string}} [target]
 */
function exploreUrl(target = {}) {
  const t = target && typeof target === "object" ? target : {};
  const tab = TABS.includes(String(t.tab)) ? String(t.tab) : "graph";
  const params = new URLSearchParams();
  params.set("tab", tab);
  // eslint-disable-next-line no-control-regex
  const put = (key, value, max) => { const v = String(value == null ? "" : value).replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, max); if (v) params.set(key, v); };
  put("q", t.q, MAX_ARG);
  if (tab === "graph") put("node", t.node, 300);
  if (tab === "wiki") { put("page", t.page, 160); if (/^[a-z0-9][a-z0-9-]{0,39}$/.test(String(t.source || ""))) params.set("source", String(t.source)); }
  if (tab === "context" && SESSION_ID.test(String(t.session || ""))) params.set("session", String(t.session).toLowerCase());
  return `aither://explore/?${params.toString()}`;
}

function row(key, title, subtitle, arg, kind = "explore") {
  return { key: `verb:explore-${key}`, kind, title, subtitle, action: { type: "command", id: "explore.open", arg } };
}

/** "<count> <thing> — <remedy>" for a source that could not look. */
function downLine(answer, what) {
  if (!answer || answer.ok !== false) return "";
  return `1 ${what} source down — ${clip(answer.reason || "no answer", 110)}${answer.remedy ? ` · ${clip(answer.remedy, 90)}` : ""}`;
}

/**
 * The launcher rows an explore verb answers with.
 * @param {ReturnType<typeof parseExploreVerb>} v
 * @param {{graph?: object|null, wiki?: object|null, sessions?: object|null}} [ctx]
 *   graph     explore-graph search() answer for v.arg (null = still searching)
 *   wiki      {source, label, ...search answer} for v.arg (null = still searching)
 *   sessions  explore-context sessions({query}) answer (null = still looking)
 * @returns {{rows: object[], status: string}}
 */
function verbRows(v, { graph = null, wiki = null, sessions = null } = {}) {
  if (!v) return { rows: [], status: "" };
  const name = LABEL[v.verb];
  if (v.bare) {
    const hint = { graph: "graph <words> searches every platform graph", wiki: "wiki <words> searches the wiki",
      context: "context <words> finds a session; the Context tab shows what it had" }[v.verb];
    return { rows: [row(`open-${v.verb}`, `Open Explore · ${name}`, "aither://explore", { tab: v.verb })], status: hint };
  }
  const q = v.arg;
  if (v.verb === "graph") {
    const rows = [row("open-graph", `Explore the graph for “${clip(q, 60)}”`, "Results, neighbours and node detail in the Graph tab", { tab: "graph", q })];
    if (!graph) return { rows, status: "Searching the platform graphs…" };
    if (graph.ok === false) return { rows, status: downLine(graph, "graph") };
    const hits = (graph.nodes || []).slice(0, MAX_ROWS);
    for (const [i, n] of hits.entries()) {
      rows.push(row(`node-${i}`, clip(n.title, 80), clip([n.type, n.graph || n.domain].filter(Boolean).join(" · ") || "graph node", 110),
        { tab: "graph", q, node: n.id }, "graph"));
    }
    const total = (graph.nodes || []).length;
    const more = total > hits.length ? ` · +${total - hits.length} more in Explore` : "";
    return { rows, status: total ? `${total} graph node${total === 1 ? "" : "s"} from ${(graph.graphs && graph.graphs.answered.length) || 0} graphs${more}`
      : `0 graph nodes for “${clip(q, 40)}” — ${(graph.graphs && graph.graphs.searched.length) || 0} graphs searched` };
  }
  if (v.verb === "wiki") {
    const rows = [row("open-wiki", `Search the wiki for “${clip(q, 60)}”`, "Pages, backlinks and the link graph in the Wiki tab", { tab: "wiki", q })];
    if (!wiki) return { rows, status: "Searching the wiki…" };
    if (wiki.ok === false) return { rows, status: downLine(wiki, "wiki") };
    const hits = (wiki.results || []).slice(0, MAX_ROWS);
    for (const [i, p] of hits.entries()) {
      rows.push(row(`page-${i}`, clip(p.title || p.slug, 80), clip(p.snippet || p.type || p.path || "wiki page", 110),
        { tab: "wiki", q, page: p.slug, source: wiki.sourceId || "" }, "wiki"));
    }
    const total = Number(wiki.total) || hits.length;
    const more = total > hits.length ? ` · +${total - hits.length} more in Explore` : "";
    return { rows, status: total ? `${total} wiki page${total === 1 ? "" : "s"} in ${clip(wiki.label || "the wiki", 40)}${more}`
      : `0 wiki pages for “${clip(q, 40)}” in ${clip(wiki.label || "the wiki", 40)}` };
  }
  const rows = [v.session
    ? row("open-session", `Open the context of session ${v.session.slice(0, 8)}`, "What it had: messages, tool share, recorded API requests", { tab: "context", session: v.session })
    : row("open-context", `Context for “${clip(q, 60)}”`, "Matching sessions and a memory recall in the Context tab", { tab: "context", q })];
  if (v.session) return { rows, status: "Enter opens that session's context" };
  if (!sessions) return { rows, status: "Looking through the sessions on this computer…" };
  if (sessions.ok === false) return { rows, status: downLine(sessions, "session") };
  const hits = (sessions.sessions || []).slice(0, MAX_ROWS);
  for (const [i, s] of hits.entries()) {
    rows.push(row(`session-${i}`, clip(s.title || s.id, 80), clip([s.status || "ended", s.project, s.id.slice(0, 8)].filter(Boolean).join(" · "), 110),
      { tab: "context", session: s.id }, "session-context"));
  }
  const total = (sessions.sessions || []).length;
  const more = total > hits.length ? ` · +${total - hits.length} more in Explore` : "";
  return { rows, status: total ? `${total} session${total === 1 ? "" : "s"} match${more}` : `0 sessions match “${clip(q, 40)}” — Enter still runs the memory recall` };
}

/** The verb rows as ONE launcher group (the page renders it like any other). */
function verbGroup(v, rows) {
  if (!rows || !rows.length) return null;
  return { id: "verbs", label: `Explore · ${LABEL[v.verb] || "Knowledge"}`, total: rows.length,
    items: rows.map((r) => ({ key: r.key, kind: r.kind, title: r.title, subtitle: r.subtitle })) };
}

module.exports = { ALIASES, MAX_ROWS, SESSION_ID, TABS, exploreUrl, parseExploreVerb, verbGroup, verbRows };
