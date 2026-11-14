/* global window, document, localStorage, location, URLSearchParams */
/* aither://explore -- page script. Main does every read (explore-window.cjs); this draws.
 *
 * Wiki HTML arrives already rendered by explore-markdown.cjs, which writes no href, src
 * or handler; a click on a[data-wiki] opens that page HERE and a[data-ext] asks main to
 * open an owner tab. The page's CSP allows no inline script and no remote load either.
 *
 * window.__explore is read by explore-smoke.cjs: the model each canvas was given. */
(() => {
  "use strict";

  const bridge = window.aitherExplore;
  const $ = (id) => document.getElementById(id);
  const SPRITES = "vendor/bead-space/kenney-simple-space";
  const KINDS = ["text", "thinking", "tool_use", "tool_result", "other"];
  const KIND_LABEL = { text: "text", thinking: "thinking", tool_use: "tool calls", tool_result: "tool results", other: "other" };

  function h(tag, attrs, ...kids) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v == null || v === false) continue;
      if (k === "class") el.className = v;
      else if (k === "text") el.textContent = v;
      else if (k === "on") for (const [ev, fn] of Object.entries(v)) el.addEventListener(ev, fn);
      else if (k === "dataset") Object.assign(el.dataset, v);
      else if (k === "style") el.style.cssText = v;
      else el.setAttribute(k, v === true ? "" : String(v));
    }
    for (const kid of kids.flat(Infinity)) {
      if (kid == null || kid === false) continue;
      el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
    }
    return el;
  }
  const fill = (el, ...kids) => { el.replaceChildren(...kids.flat(Infinity).filter((k) => k != null && k !== false)); return el; };
  const num = (n) => Number(n || 0).toLocaleString("en-US");
  const bytes = (n) => {
    const v = Number(n) || 0;
    if (v >= 1024 * 1024 * 1024) return `${(v / 1024 / 1024 / 1024).toFixed(1)} GB`;
    if (v >= 1024 * 1024) return `${(v / 1024 / 1024).toFixed(1)} MB`;
    if (v >= 1024) return `${Math.round(v / 1024)} KB`;
    return `${v} B`;
  };
  const when = (ms) => (ms ? new Date(ms).toLocaleString() : "");
  const pct = (x) => `${Math.round((Number(x) || 0) * 100)}%`;

  async function call(op, ...args) {
    if (!bridge) return { ok: false, reason: "1 bridge is missing", remedy: "open this page as aither://explore in the Aither browser" };
    try {
      const r = await bridge.call(op, ...args);
      return r && typeof r === "object" ? r : { ok: false, reason: "main answered nothing" };
    } catch (error) {
      return { ok: false, reason: String((error && error.message) || error) };
    }
  }

  /** "Could not look" as a visible state, with what to start. Never an empty list. */
  function stateBox(answer, what) {
    const unreachable = answer && (answer.unreachable || answer.refused);
    return h("div", { class: "state", dataset: { state: unreachable ? "unreachable" : "failed" } },
      h("div", {}, h("b", { text: unreachable ? `${what} unreachable: ` : `${what} did not answer: ` }), (answer && answer.reason) || "no answer"),
      answer && answer.remedy ? h("div", { class: "fix", text: `To fix: ${answer.remedy}` }) : null);
  }

  const model = { tab: "graph", graph: { nodes: 0, links: 0, state: "idle" }, wiki: { nodes: 0, links: 0, state: "idle", source: "", page: "" },
    context: { sessions: 0, session: "", state: "idle" } };

  // ── the force view (the bead-space engine) ────────────────────────────────
  function createCanvas(host, onPick) {
    let handle = null;
    let picked = null;
    const space = h("div", { class: "bead-space-host", style: "position:absolute;inset:0" });
    function draw(nodes, links, message) {
      if (!nodes.length) {
        if (handle) { try { handle.destroy(); } catch { /* already gone */ } handle = null; }
        fill(host, message || h("div", { class: "empty", text: "0 nodes to draw." }));
        return;
      }
      const data = {
        nodes: nodes.map((n) => ({ id: n.id, title: n.title || n.id, cluster: n.cluster || "graph", status: n.center ? "in_progress" : "open",
          createdAt: "2026-01-01T00:00:00Z", meta: { type: n.type || "" } })),
        links: links.filter((l) => l.source !== l.target).map((l) => ({ source: l.source, target: l.target, kind: "related" })),
      };
      const engine = window.BeadSpace;
      if (!engine || typeof engine.createBeadSpace !== "function") {
        fill(host, h("div", { class: "state" }, h("b", { text: "Force view unavailable: " }), "the bead-space engine did not load (vendor/bead-space)."));
        return;
      }
      if (handle) { handle.update(data); return; }
      fill(host, space);
      handle = engine.createBeadSpace(space, data, {
        assetRoot: SPRITES, wheelZoom: true, labelsAlwaysBelow: 90, labelCollision: true, starfield: true,
        nodeLabel: (n) => (n.title.length > 28 ? `${n.title.slice(0, 27)}…` : n.title),
        onSelect: (n) => {
          const id = n ? n.id : null;
          if (id === picked) return;
          picked = id;
          if (id) onPick(id);
        },
      });
    }
    return { draw, select: (id) => { picked = id; if (handle) { try { handle.select(id); } catch { /* not drawn */ } } },
      resize: () => { if (handle) { try { handle.resize(); } catch { /* hidden */ } } } };
  }

  // ── Graph ──────────────────────────────────────────────────────────────────
  const g = { nodes: new Map(), links: [], hidden: new Set(), center: null, canvas: null, statsLoaded: false, seq: 0 };

  function graphVisible() {
    const nodes = [...g.nodes.values()].filter((n) => !g.hidden.has(n.type || "(untyped)"));
    const ids = new Set(nodes.map((n) => n.id));
    return { nodes, links: g.links.filter((l) => ids.has(l.source) && ids.has(l.target)) };
  }

  function drawGraph(message) {
    const { nodes, links } = graphVisible();
    model.graph.nodes = nodes.length;
    model.graph.links = links.length;
    g.canvas.draw(nodes.map((n) => ({ id: n.id, title: n.title, cluster: n.graph || n.domain || "graph", type: n.type, center: n.id === g.center })), links, message);
    const types = new Map();
    for (const n of g.nodes.values()) { const t = n.type || "(untyped)"; types.set(t, (types.get(t) || 0) + 1); }
    fill($("g-types"), types.size
      ? [...types.entries()].sort((a, b) => b[1] - a[1]).map(([t, c]) => h("button", { type: "button", class: `chip${g.hidden.has(t) ? "" : " on"}`,
        text: `${t} ${c}`, on: { click: () => { if (g.hidden.has(t)) g.hidden.delete(t); else g.hidden.add(t); drawGraph(); renderGraphList(); } } }))
      : h("span", { class: "empty", text: "Search to see node types." }));
  }

  function renderGraphList() {
    const { nodes } = graphVisible();
    const shown = nodes.slice(0, 60);
    fill($("g-list"), shown.length
      ? [...shown.map((n) => h("button", { type: "button", class: `row${n.id === g.center ? " on" : ""}`, on: { click: () => selectNode(n.id) } },
        h("div", { class: "t", text: n.title }),
        h("div", { class: "s", text: [n.type, n.graph || n.domain, n.score != null ? `score ${Number(n.score).toFixed(2)}` : ""].filter(Boolean).join(" · ") }))),
      nodes.length > shown.length ? h("div", { class: "empty", text: `+${nodes.length - shown.length} more on the canvas` }) : null]
      : h("div", { class: "empty", text: g.nodes.size ? "Every type is filtered out." : "0 nodes." }));
  }

  function selectNode(id) {
    const n = g.nodes.get(id);
    if (!n) return;
    g.center = id;
    g.canvas.select(id);
    renderGraphList();
    const props = Object.entries(n.props || {});
    const expand = h("button", { type: "button", class: "b", text: "Expand neighbours", on: { click: () => expandNode(id, expand) } });
    fill($("g-detail"),
      h("dl", {},
        h("dt", { text: "Name" }), h("dd", { text: n.title }),
        h("dt", { text: "Type" }), h("dd", { text: n.type || "(the graph gave no type)" }),
        h("dt", { text: "Source" }), h("dd", { text: n.graph || "(unnamed graph)" }),
        n.domain ? [h("dt", { text: "Domain" }), h("dd", { text: n.domain })] : null,
        n.relation ? [h("dt", { text: "Edge" }), h("dd", { text: n.relation })] : null,
        h("dt", { text: "Id" }), h("dd", { class: "mono", text: n.id }),
        props.map(([k, v]) => [h("dt", { text: k }), h("dd", { text: String(v) })])),
      h("div", { style: "margin-top:8px" }, expand), h("div", { class: "status", id: "g-expand-note" }));
  }

  async function expandNode(id, button) {
    if (button) button.disabled = true;
    const note = $("g-expand-note");
    if (note) note.textContent = "Reading one hop out (graph_traverse)…";
    const r = await call("graph.neighbors", id);
    if (button) button.disabled = false;
    if (!r.ok) { if (note) fill(note, stateBox(r, "Graph")); return; }
    for (const n of r.nodes) if (!g.nodes.has(n.id)) g.nodes.set(n.id, { ...n, relation: (r.edges.find((e) => e.target === n.id) || {}).relation || "" });
    for (const e of r.edges) if (!g.links.some((l) => l.source === e.source && l.target === e.target)) g.links.push(e);
    if (note) note.textContent = r.nodes.length ? `${r.nodes.length} neighbour${r.nodes.length === 1 ? "" : "s"} added` : "0 neighbours — graph_traverse returned none for this node";
    drawGraph();
    renderGraphList();
  }

  async function runGraphSearch(q, pick) {
    const query = String(q || "").trim();
    if (!query) return;
    const seq = ++g.seq;
    $("g-q").value = query;
    $("g-status").textContent = "Searching every graph…";
    model.graph.state = "searching";
    const r = await call("graph.search", query, { domain: $("g-domain").value });
    if (seq !== g.seq) return;
    g.nodes.clear(); g.links = []; g.hidden.clear(); g.center = null;
    if (!r.ok) {
      model.graph.state = r.unreachable ? "unreachable" : "failed";
      $("g-status").textContent = "";
      fill($("g-list"), stateBox(r, "Graph source"));
      fill($("g-detail"), h("div", { class: "empty", text: "Nothing to show until the source answers." }));
      drawGraph(stateBox(r, "Graph source"));
      return;
    }
    for (const n of r.nodes) g.nodes.set(n.id, n);
    model.graph.state = "ok";
    const failed = (r.graphs.failed || []).map((f) => `${f.graph} (${f.reason})`);
    $("g-status").textContent = `${r.nodes.length} node${r.nodes.length === 1 ? "" : "s"} · ${r.graphs.answered.length} of ${r.graphs.searched.length} graphs answered · ${Math.round(r.tookMs / 100) / 10} s`
      + (failed.length ? ` · ${failed.length} graph${failed.length === 1 ? "" : "s"} failed: ${failed.join(", ")}` : "")
      + (r.notes.length ? ` · ${r.notes.join(" · ")}` : "");
    drawGraph(r.nodes.length ? null : h("div", { class: "empty", text: `0 nodes for “${query}”. ${r.graphs.searched.length} graphs were searched and answered; this is a real empty result.` }));
    renderGraphList();
    fill($("g-detail"), h("div", { class: "empty", text: "Click a result or a node." }));
    if (pick && g.nodes.has(pick)) selectNode(pick);
  }

  async function loadGraphStats() {
    if (g.statsLoaded) return;
    g.statsLoaded = true;
    const r = await call("graph.stats");
    if (!r.ok) { g.statsLoaded = false; fill($("g-stats"), stateBox(r, "Graph source")); return; }
    const select = $("g-domain");
    for (const d of r.domains) select.append(h("option", { value: d.domain, text: d.status ? `${d.domain} (${d.status})` : d.domain }));
    fill($("g-stats"),
      h("div", { class: "chips" }, r.loaded.map((b) => h("span", { class: "chip ok", text: `${b} loaded` })), r.failed.map((b) => h("span", { class: "chip bad", text: `${b} failed` })),
        h("span", { class: "chip", text: `${r.domains.length} domains` })),
      r.counts.length ? h("dl", { style: "margin-top:8px" }, r.counts.map((c) => [h("dt", { text: c.label }), h("dd", { text: num(c.value) })])) : null,
      r.errors.length ? h("div", { class: "status", text: r.errors.join(" · ") }) : null);
  }

  // ── Wiki ───────────────────────────────────────────────────────────────────
  const w = { sources: [], source: "", history: [], page: null, canvas: null, graphMode: "page", seq: 0, loaded: false };

  function wikiStatus(text) { $("w-status").textContent = text || ""; }

  function renderSources() {
    fill($("w-source"), w.sources.map((s) => h("option", { value: s.id, text: s.kind === "folder" ? `${s.label} — folder on this computer` : s.label })));
    $("w-source").value = w.source;
    const cur = w.sources.find((s) => s.id === w.source);
    $("w-remove").hidden = !(cur && cur.removable);
    model.wiki.source = w.source;
  }

  function pageRows(rows, emptyText) {
    return rows.length
      ? rows.map((p) => h("button", { type: "button", class: `row${w.page && w.page.slug === p.slug ? " on" : ""}`, dataset: { slug: p.slug },
        on: { click: () => openPage(p.slug) } },
      h("div", { class: "t", text: p.title || p.slug }),
      h("div", { class: "s", text: p.snippet || [p.type, p.path].filter(Boolean).join(" · ") || p.slug })))
      : h("div", { class: "empty", text: emptyText });
  }

  async function listPages() {
    const seq = ++w.seq;
    $("w-list-title").textContent = "Pages";
    fill($("w-list"), h("div", { class: "empty", text: "Reading…" }));
    const r = await call("wiki.list", w.source);
    if (seq !== w.seq) return r;
    if (!r.ok) { fill($("w-list"), stateBox(r, "Wiki source")); model.wiki.state = r.unreachable ? "unreachable" : "failed"; return r; }
    model.wiki.state = "ok";
    const shown = r.pages.slice(0, 300);
    $("w-list-title").textContent = `Pages (${num(r.total)})`;
    fill($("w-list"), pageRows(shown, "0 pages in this wiki."),
      r.pages.length > shown.length ? h("div", { class: "empty", text: `+${r.pages.length - shown.length} more — search to find them` }) : null,
      r.note ? h("div", { class: "empty", text: r.note }) : null);
    return r;
  }

  async function searchWiki(q) {
    const query = String(q || "").trim();
    if (!query) return listPages();
    const seq = ++w.seq;
    $("w-q").value = query;
    fill($("w-list"), h("div", { class: "empty", text: "Searching…" }));
    const r = await call("wiki.search", w.source, query, { limit: 30 });
    if (seq !== w.seq) return r;
    if (!r.ok) { fill($("w-list"), stateBox(r, "Wiki source")); return r; }
    $("w-list-title").textContent = `Results (${num(r.total)})`;
    fill($("w-list"), pageRows(r.results, `0 pages match “${query}”.`));
    return r;
  }

  async function drawWikiGraph() {
    const around = w.graphMode === "page" && w.page ? w.page.slug : null;
    $("w-graph-page").classList.toggle("on", w.graphMode === "page");
    $("w-graph-all").classList.toggle("on", w.graphMode === "all");
    if (w.graphMode === "page" && !w.page) {
      model.wiki.nodes = 0; model.wiki.links = 0;
      w.canvas.draw([], [], h("div", { class: "empty", text: "Open a page to see what it links to and what links to it." }));
      $("w-graph-note").textContent = "";
      return;
    }
    const r = await call("wiki.graph", w.source, { around });
    if (!r.ok) {
      model.wiki.nodes = 0; model.wiki.links = 0;
      w.canvas.draw([], [], stateBox(r, "Link graph"));
      $("w-graph-note").textContent = "";
      return;
    }
    model.wiki.nodes = r.nodes.length; model.wiki.links = r.edges.length;
    $("w-graph-note").textContent = `${r.nodes.length} pages · ${r.edges.length} links${r.note ? ` · ${r.note}` : ""}`;
    w.canvas.draw(r.nodes.map((n) => ({ id: n.id, title: n.title, cluster: n.type || "page", type: n.type, center: n.id === around })), r.edges,
      h("div", { class: "empty", text: "0 pages to draw." }));
    if (around) w.canvas.select(around);
  }

  async function openPage(slug, { push = true } = {}) {
    wikiStatus("Opening…");
    const r = await call("wiki.read", w.source, slug);
    if (!r.ok) {
      wikiStatus("");
      fill($("w-page"), r.missing ? h("div", { class: "empty", text: `${r.reason}. It is linked but was never written.` }) : stateBox(r, "Wiki source"));
      return r;
    }
    if (push && w.page) w.history.push(w.page.slug);
    w.page = r.page;
    model.wiki.page = r.page.slug;
    $("w-back").disabled = !w.history.length;
    wikiStatus("");
    const meta = r.page.meta || {};
    fill($("w-meta"),
      r.page.type ? h("span", { class: "chip", text: r.page.type }) : null,
      r.page.path ? h("span", { class: "chip mono", text: r.page.path }) : null,
      r.page.updated ? h("span", { class: "chip", text: `updated ${when(r.page.updated)}` }) : null,
      meta.source ? h("span", { class: "chip", text: `source ${meta.source}${meta.span ? `:${meta.span}` : ""}` }) : null,
      meta.confidence ? h("span", { class: "chip", text: `confidence ${meta.confidence}` }) : null,
      r.page.truncated ? h("span", { class: "chip bad", text: "long page: the end is cut" }) : null);
    const article = $("w-page");
    // Rendered by explore-markdown.cjs: escaped text and its own tags only.
    article.innerHTML = r.page.html || "";
    if (!article.querySelector("h1")) article.prepend(h("h1", { text: r.page.title }));
    for (const a of article.querySelectorAll("a[data-wiki]")) {
      const hit = (r.page.links || []).find((l) => l.slug === a.dataset.wiki || l.title === a.dataset.wiki);
      if (hit && hit.exists === false) a.title = "This page has not been written";
    }
    fill($("w-links"), (r.page.links || []).length
      ? h("div", { class: "chips" }, r.page.links.map((l) => h("button", { type: "button", class: `chip${l.exists ? " on" : ""}`, text: l.exists ? l.title : `${l.title} (not written)`,
        on: { click: () => openPage(l.slug) } })))
      : h("div", { class: "empty", text: "0 links to other pages." }));
    fill($("w-backlinks"), r.page.backlinks == null
      ? h("div", { class: "empty", text: "Backlinks are not available from the platform source (the gateway has no backlinks tool). A wiki folder on this computer has them." })
      : (r.page.backlinks.length
        ? r.page.backlinks.map((b) => h("button", { type: "button", class: "row", on: { click: () => openPage(b.slug) } }, h("div", { class: "t", text: b.title })))
        : h("div", { class: "empty", text: "0 pages link here." })));
    for (const el of $("w-list").querySelectorAll(".row")) el.classList.toggle("on", el.dataset.slug === r.page.slug);
    await drawWikiGraph();
    return r;
  }

  async function chooseSource(id, { announce = "" } = {}) {
    w.source = id;
    w.history = []; w.page = null;
    $("w-back").disabled = true;
    try { localStorage.setItem("explore.wiki.source", id); } catch { /* storage off */ }
    renderSources();
    fill($("w-page"), h("div", { class: "empty", text: "Choose a page." }));
    fill($("w-meta")); fill($("w-links"), h("div", { class: "empty", text: "—" })); fill($("w-backlinks"), h("div", { class: "empty", text: "—" }));
    wikiStatus(announce);
    const r = await listPages();
    await drawWikiGraph();
    return r;
  }

  /** First load: the platform when it answers, else the first wiki folder -- and say which. */
  async function loadWiki({ source = "" } = {}) {
    if (w.loaded && !source) return;
    w.loaded = true;
    const s = await call("wiki.sources");
    w.sources = s.ok ? s.sources : [];
    if (!w.sources.length) { fill($("w-list"), stateBox(s, "Wiki sources")); return; }
    let stored;
    try { stored = localStorage.getItem("explore.wiki.source") || ""; } catch { stored = ""; }
    const wanted = [source, stored].find((id) => id && w.sources.some((x) => x.id === id));
    if (wanted) { await chooseSource(wanted); return; }
    const first = await chooseSource("platform");
    const folder = w.sources.find((x) => x.kind === "folder");
    if (first && !first.ok && folder) {
      await chooseSource(folder.id, { announce: `LyraWiki did not answer (${first.reason}) — showing the folder ${folder.label} instead.` });
    }
  }

  // ── Context ────────────────────────────────────────────────────────────────
  const c = { loaded: false, session: "", seq: 0 };

  function kindBars(kinds, total) {
    return [h("div", { class: "bars" }, KINDS.filter((k) => kinds[k] > 0).map((k) => h("span", { class: `k-${k}`, style: `width:${(kinds[k] / Math.max(1, total)) * 100}%`,
      title: `${KIND_LABEL[k]}: ${num(kinds[k])} chars` }))),
    h("div", { class: "legend" }, KINDS.filter((k) => kinds[k] > 0).map((k) => h("span", {}, h("i", { class: `k-${k}` }), `${KIND_LABEL[k]} ${pct(kinds[k] / Math.max(1, total))}`)))];
  }

  async function openRequest(sessionId, requestId, host) {
    fill(host, h("div", { class: "empty", text: "Reading the recorded request…" }));
    const r = await call("context.request", sessionId, requestId);
    if (!r.ok) { fill(host, stateBox(r, "Journal")); return; }
    const q = r.request;
    fill(host,
      h("h2", { text: `Recorded request ${q.id.slice(0, 8)} · ${when(q.at)}` }),
      h("dl", {},
        h("dt", { text: "Model" }), h("dd", { text: q.model || "(not recorded)" }),
        h("dt", { text: "From" }), h("dd", { text: q.source || "(not recorded)" }),
        h("dt", { text: "Settings" }), h("dd", { text: [`max ${num(q.maxTokens)} output tokens`, q.effort ? `effort ${q.effort}` : "", q.thinking ? `thinking ${q.thinking}` : "", `${q.betas} betas`].filter(Boolean).join(" · ") }),
        h("dt", { text: "Messages" }), h("dd", { text: `${num(q.keep)} carried over from the previous request${q.base ? ` (${q.base.slice(0, 8)})` : ""} + ${num(r.tailTotal)} new` })),
      h("h2", { style: "margin-top:10px", text: "System blocks (as recorded)" }),
      r.system ? r.system.map((b, i) => h("details", {}, h("summary", { text: `Block ${i + 1} · ${num(b.chars)} chars` }), h("pre", { class: "raw", text: b.preview + (b.chars > b.preview.length ? `\n… +${num(b.chars - b.preview.length)} chars not shown` : "") })))
        : h("div", { class: "empty", text: "The shape record for this request is not in the part of the journal that was read." }),
      r.tools ? h("details", {}, h("summary", { text: `${r.tools.length} tool definitions` }), h("div", { class: "chips", style: "margin-top:6px" }, r.tools.map((t) => h("span", { class: "chip", text: `${t.name} ${num(t.chars)}` })))) : null,
      h("h2", { style: "margin-top:10px", text: `New messages in this request (${r.messages.length}${r.tailTotal > r.messages.length ? ` of ${r.tailTotal}` : ""})` }),
      r.notRead ? h("div", { class: "empty", text: `${r.notRead} of them have no recorded blob in the bytes read; they are listed by hash and not guessed.` }) : null,
      h("table", { class: "t" }, h("tr", {}, ["Role", "Chars", "What"].map((x) => h("th", { text: x }))),
        r.messages.map((m) => h("tr", {}, h("td", { text: m.read ? m.role : "not read" }), h("td", { text: m.read ? num(m.chars) : "" }),
          h("td", {}, m.read ? [m.tools.length ? h("span", { class: "chip", text: m.tools.join(", ") }) : null, " ", m.preview.slice(0, 400)] : h("span", { class: "mono", text: m.hash }))))),
      h("div", { class: "empty", text: `Read ${bytes(r.window.bytes)} of a ${bytes(r.window.fileBytes)} journal.` }));
  }

  async function openSession(id) {
    const seq = ++c.seq;
    c.session = id;
    model.context.session = id;
    for (const el of $("c-sessions").querySelectorAll(".row")) el.classList.toggle("on", el.dataset.id === id);
    const host = $("c-facts");
    fill(host, h("div", { class: "panel" }, h("div", { class: "empty", text: "Measuring the journal…" })));
    const r = await call("context.facts", id);
    if (seq !== c.seq) return;
    if (!r.ok) { model.context.state = "failed"; fill(host, h("div", { class: "panel" }, stateBox(r, "Journal"))); return; }
    model.context.state = "ok";
    const t = r.totals;
    const last = r.lastCall;
    const requestHost = h("div", { class: "panel", id: "c-request" }, h("div", { class: "empty", text: "Click a recorded request to see its system blocks, tools and new messages." }));
    fill(host,
      h("div", { class: "panel" }, h("h2", { text: `Session ${id.slice(0, 8)}` }),
        h("div", { class: "cards" },
          h("div", { class: "card" }, h("div", { class: "v", text: last ? num(last.prompt) : "—" }), h("div", { class: "l", text: last ? `prompt tokens in its last call (API count): ${num(last.input)} new + ${num(last.cacheRead)} cache read + ${num(last.cacheWrite)} cache write` : "no API usage recorded in the bytes read" })),
          h("div", { class: "card" }, h("div", { class: "v", text: pct(t.toolShare) }), h("div", { class: "l", text: `of the characters are tool calls and tool results (${num(t.toolCalls)} calls)` })),
          h("div", { class: "card" }, h("div", { class: "v", text: num(t.messages) }), h("div", { class: "l", text: `messages · ${num(t.chars)} chars · ~${num(t.estTokens)} tokens (estimate: chars / 4)` })),
          h("div", { class: "card" }, h("div", { class: "v", text: num(t.usage.output) }), h("div", { class: "l", text: `output tokens over ${num(t.usage.turns)} API turns (API count)` }))),
        h("div", { style: "margin-top:10px" }, kindBars(t.kinds, t.chars)),
        h("div", { class: "empty", text: `Read ${bytes(r.window.bytes)} of a ${bytes(r.window.fileBytes)} journal${r.window.truncated ? " — the END of it; earlier messages are not counted" : " — all of it"}.` })),
      r.tools.length ? h("div", { class: "panel" }, h("h2", { text: "Tools it called" }), h("div", { class: "chips" }, r.tools.map((x) => h("span", { class: "chip", text: `${x.name} ${x.count}` })))) : null,
      h("div", { class: "panel" }, h("h2", { text: `Recorded API requests (${num(r.requestsTotal)})` }),
        r.requests.length
          ? h("table", { class: "t" }, h("tr", {}, ["When", "Model", "Messages", "System", "Tools"].map((x) => h("th", { text: x }))),
            r.requests.slice(-40).reverse().map((q) => h("tr", { class: "click", dataset: { request: q.id }, on: { click: () => openRequest(id, q.id, requestHost) } },
              h("td", { text: when(q.at) }), h("td", { text: q.model }), h("td", { text: `${num(q.keep)} + ${num(q.tail)} new` }),
              h("td", { text: q.system ? `${num(q.system.systemChars)} chars in ${q.system.systemBlocks}` : "not read" }),
              h("td", { text: q.system ? `${q.system.tools} (${num(q.system.toolChars)} chars)` : "" }))))
          : h("div", { class: "empty", text: "0 recorded requests in the bytes read. Claude Code journals them; other harnesses do not." }),
        r.requestsTotal > 40 ? h("div", { class: "empty", text: `Newest 40 shown · +${r.requestsTotal - 40} more recorded` }) : null),
      requestHost,
      h("div", { class: "panel" }, h("h2", { text: `Messages (${num(r.rowsTotal)})` }),
        h("table", { class: "t" }, h("tr", {}, ["When", "Who", "Chars", "~Tokens", "Prompt tokens (API)", "What"].map((x) => h("th", { text: x }))),
          r.rows.slice(-120).reverse().map((m) => h("tr", {},
            h("td", { text: m.at ? new Date(m.at).toLocaleTimeString() : "" }), h("td", { text: m.sidechain ? `${m.role} (subagent)` : m.role }),
            h("td", { text: num(m.chars) }), h("td", { text: `~${num(m.estTokens)}` }), h("td", { text: m.usage ? num(m.usage.prompt) : "" }),
            h("td", {}, m.tools.length ? h("span", { class: "chip", text: m.tools.join(", ") }) : null, " ", m.preview)))),
        r.rowsTotal > 120 ? h("div", { class: "empty", text: `Newest 120 shown · +${r.rowsTotal - 120} more counted above` }) : null));
  }

  async function loadSessions(query) {
    $("c-status").textContent = "Looking…";
    const r = await call("context.sessions", { query: query || "" });
    $("c-status").textContent = "";
    if (!r.ok) { model.context.state = "failed"; fill($("c-sessions"), stateBox(r, "Sessions")); return r; }
    model.context.sessions = r.sessions.length;
    fill($("c-sources"),
      h("span", { class: `chip ${r.sources.journals.ok ? "ok" : "bad"}`, text: r.sources.journals.ok ? r.sources.journals.note : `journals: ${r.sources.journals.note}` }),
      h("span", { class: `chip ${r.sources.daemon.ok ? "ok" : "bad"}`, text: r.sources.daemon.ok ? `live: ${r.sources.daemon.note}` : `live status off: ${r.sources.daemon.note}` }));
    const shown = r.sessions.slice(0, 40);
    fill($("c-sessions"), shown.length
      ? [...shown.map((s) => h("button", { type: "button", class: `row${s.id === c.session ? " on" : ""}`, dataset: { id: s.id }, disabled: !s.hasJournal,
        on: { click: () => openSession(s.id) } },
      h("div", { class: "t", text: s.title || s.id }),
      h("div", { class: "s", text: [s.status || "", s.project, s.hasJournal ? bytes(s.bytes) : "no journal on this computer", s.updated ? when(s.updated) : "", s.id.slice(0, 8)].filter(Boolean).join(" · ") }))),
      r.sessions.length > shown.length ? h("div", { class: "empty", text: `+${r.sessions.length - shown.length} more — filter to find them` }) : null]
      : h("div", { class: "empty", text: query ? `0 sessions match “${query}”.` : "0 sessions with a journal on this computer." }));
    return r;
  }

  async function runRecall(query) {
    const q = String(query || "").trim();
    if (!q) return;
    fill($("c-recall"), h("div", { class: "empty", text: "Asking memory…" }));
    const r = await call("context.recall", q);
    if (!r.ok) { fill($("c-recall"), stateBox({ ...r, unreachable: true }, "Memory")); return; }
    fill($("c-recall"), r.memories.length
      ? r.memories.map((m) => h("div", { class: "row", style: "cursor:default" }, h("div", { style: "white-space:normal", text: m.text }),
        h("div", { class: "s", text: [m.category, m.score != null ? `score ${Number(m.score).toFixed(2)}` : ""].filter(Boolean).join(" · ") })))
      : h("div", { class: "empty", text: `0 memories for “${q}”. Memory answered; this is a real empty result.` }));
  }

  async function loadTraces() {
    const r = await call("context.traces");
    if (!r.ok) { fill($("c-traces"), stateBox(r, "LLM traces")); return; }
    const out = h("div", {});
    fill($("c-traces"), r.traces.length
      ? [h("table", { class: "t" }, h("tr", {}, ["When", "Model", "Agent", "ms"].map((x) => h("th", { text: x }))),
        r.traces.map((t) => h("tr", { class: "click", on: { click: async () => {
          fill(out, h("div", { class: "empty", text: "Reading the trace…" }));
          const d = await call("context.trace", t.id);
          fill(out, d.ok ? h("pre", { class: "raw", text: d.text + (d.truncated ? "\n… cut" : "") }) : stateBox(d, "LLM trace"));
        } } }, h("td", { text: when(t.at) }), h("td", { text: t.model }), h("td", { text: t.agent || t.source }), h("td", { text: num(t.totalMs) })))), out]
      : h("div", { class: "empty", text: "0 traces recorded. The trace store answered; this is a real empty result." }));
  }

  async function loadContext() {
    if (c.loaded) return;
    c.loaded = true;
    const limits = await call("context.limits");
    fill($("c-limits"), (limits.ok ? limits.notAvailable : []).map((x) => h("li", { text: x })));
    void loadTraces();
    await loadSessions("");
  }

  // ── tabs, wiring, deep link ────────────────────────────────────────────────
  function show(tab) {
    const name = ["graph", "wiki", "context"].includes(tab) ? tab : "graph";
    model.tab = name;
    for (const b of document.querySelectorAll(".tabs button")) b.setAttribute("aria-selected", String(b.dataset.tab === name));
    for (const s of document.querySelectorAll("main section")) s.classList.toggle("on", s.id === `tab-${name}`);
    if (name === "graph") { void loadGraphStats(); g.canvas.resize(); }
    if (name === "wiki") { void loadWiki(); w.canvas.resize(); }
    if (name === "context") void loadContext();
  }

  g.canvas = createCanvas($("g-canvas"), (id) => selectNode(id));
  w.canvas = createCanvas($("w-canvas"), (id) => { if (!w.page || w.page.slug !== id) void openPage(id); });

  for (const b of document.querySelectorAll(".tabs button")) b.addEventListener("click", () => show(b.dataset.tab));
  $("g-go").addEventListener("click", () => runGraphSearch($("g-q").value));
  $("g-q").addEventListener("keydown", (e) => { if (e.key === "Enter") void runGraphSearch($("g-q").value); });
  $("g-domain").addEventListener("change", () => { if ($("g-q").value.trim()) void runGraphSearch($("g-q").value); });
  $("w-source").addEventListener("change", () => void chooseSource($("w-source").value));
  $("w-q").addEventListener("keydown", (e) => { if (e.key === "Enter") void searchWiki($("w-q").value); });
  $("w-all").addEventListener("click", () => { $("w-q").value = ""; void listPages(); });
  $("w-back").addEventListener("click", () => { const prev = w.history.pop(); if (prev) void openPage(prev, { push: false }); });
  $("w-graph-page").addEventListener("click", () => { w.graphMode = "page"; void drawWikiGraph(); });
  $("w-graph-all").addEventListener("click", () => { w.graphMode = "all"; void drawWikiGraph(); });
  $("w-add").addEventListener("click", async () => {
    const r = await call("wiki.addFolder");
    if (!r.ok) { wikiStatus(r.reason); return; }
    if (r.cancelled) return;
    w.sources = r.sources;
    await chooseSource(r.selected || w.source);
  });
  $("w-remove").addEventListener("click", async () => {
    const r = await call("wiki.removeFolder", w.source);
    if (!r.ok) { wikiStatus(r.reason); return; }
    w.sources = r.sources;
    await chooseSource((w.sources.find((s) => s.kind === "folder") || w.sources[0]).id);
  });
  $("w-page").addEventListener("click", (event) => {
    const a = event.target && event.target.closest ? event.target.closest("a") : null;
    if (!a) return;
    event.preventDefault();
    if (a.dataset.wiki) void openPage(a.dataset.wiki);
    else if (a.dataset.ext) void call("open.external", a.dataset.ext).then((r) => { if (!r.ok) wikiStatus(r.reason); });
  });
  const contextFind = () => { const q = $("c-q").value.trim(); void loadSessions(q); if (q) void runRecall(q); };
  $("c-go").addEventListener("click", contextFind);
  $("c-q").addEventListener("keydown", (e) => { if (e.key === "Enter") contextFind(); });
  window.addEventListener("resize", () => { g.canvas.resize(); w.canvas.resize(); });

  /** aither://explore/?tab=graph|wiki|context&q=&node=&page=&source=&session= (explore-verbs.cjs exploreUrl). */
  async function applyDeepLink() {
    const p = new URLSearchParams(location.search);
    const tab = p.get("tab") || "graph";
    const q = (p.get("q") || "").slice(0, 200);
    show(tab);
    if (model.tab === "graph" && q) await runGraphSearch(q, p.get("node") || null);
    if (model.tab === "wiki") {
      const source = p.get("source") || "";
      if (source) await loadWiki({ source });
      else await loadWiki();
      if (q) await searchWiki(q);
      if (p.get("page")) await openPage(p.get("page"));
    }
    if (model.tab === "context") {
      await loadContext();
      const session = p.get("session") || "";
      if (q) { $("c-q").value = q; await loadSessions(q); void runRecall(q); }
      if (/^[0-9a-f-]{36}$/i.test(session)) await openSession(session);
    }
  }

  window.__explore = {
    model: () => JSON.parse(JSON.stringify(model)),
    show, runGraphSearch, searchWiki, openPage, chooseSource, loadSessions, openSession,
    setGraphMode: (mode) => { w.graphMode = mode === "all" ? "all" : "page"; return drawWikiGraph(); },
    ready: applyDeepLink(),
  };
})();
