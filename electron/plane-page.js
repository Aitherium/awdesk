/* global window, module */
"use strict";
// The plane pages: one status page per platform plane (plane-<id>.html sets
// <body data-plane="<id>">). Reads come from plane-client.cjs through the
// aitherPlane bridge; every value is rendered with textContent -- tool output is
// DATA, never markup. A failed read renders its error in its own card, so one
// dead service never reads as "nothing to show".
//
// The pure half (no DOM) is exported when a `module` object exists, which is how
// plane-page.test.cjs loads it (vm, since package.json makes .js files ESM).

(function main(root) {
  const MAX_ROWS = 50;
  const MAX_COLS = 6;
  const MAX_DEPTH = 3;
  const REFRESH_MS = 30000;

  function humanBytes(n) {
    const v = Number(n);
    if (!Number.isFinite(v) || v < 0) return String(n);
    const units = ["B", "KiB", "MiB", "GiB", "TiB"];
    let i = 0;
    let x = v;
    while (x >= 1024 && i < units.length - 1) { x /= 1024; i += 1; }
    return (i === 0 ? String(x) : x.toFixed(x >= 100 ? 0 : 1)) + " " + units[i];
  }

  /** One scalar as text, with a hint from its key (bytes, percent, time). */
  function formatScalar(key, value) {
    if (value === null || value === undefined) return "—";
    if (typeof value === "boolean") return value ? "yes" : "no";
    const k = String(key || "").toLowerCase();
    if (typeof value === "number") {
      if (/(^|_)(bytes|size)$|_bytes_|^bytes/.test(k)) return humanBytes(value);
      if (/(percent|pct|_pct|usage_ratio)$/.test(k)) return (Math.round(value * 10) / 10) + "%";
      if (/(_at|timestamp|_ts)$/.test(k) && value > 1e9) {
        const d = new Date(value < 1e12 ? value * 1000 : value);
        if (!isNaN(d)) return d.toLocaleString();
      }
      return String(value);
    }
    return String(value);
  }

  /**
   * A service read's verdict: "up" | "down" | "unknown" plus a sentence. Reads
   * Genesis /services rows ({services: {Name: {status, healthy}}}) and the
   * common {status|healthy|ok} shapes; anything else is "unknown", never "up".
   */
  function serviceVerdict(data, name) {
    if (!data || typeof data !== "object") return { state: "unknown", text: "no answer" };
    const want = String(name || data.service || "").toLowerCase();
    const rows = data.services && typeof data.services === "object" ? data.services : null;
    let pick = rows ? Object.values(rows).filter((r) => r && typeof r === "object") : [data];
    // Genesis answers the whole inventory; grade ONLY this plane's own row.
    if (rows && want) {
      const key = Object.keys(rows).find((k) => k.toLowerCase() === want);
      pick = key && rows[key] && typeof rows[key] === "object" ? [rows[key]] : [];
    }
    if (data.listed === false || !pick.length) return { state: "unknown", text: "not listed" };
    const states = pick.map((r) => {
      const status = String(r.status || r.state || "").toLowerCase();
      if (r.healthy === false || r.ok === false) return "down";
      if (["running", "healthy", "up", "ok", "online"].includes(status) || r.healthy === true) return "up";
      if (["stopped", "exited", "down", "unhealthy", "dead", "failed", "offline"].includes(status)) return "down";
      return "unknown";
    });
    const state = states.includes("down") ? "down" : states.every((s) => s === "up") ? "up" : "unknown";
    const first = pick[0];
    const text = String(first.status || first.state || (first.healthy === true ? "healthy" : state));
    return { state, text };
  }

  /** Columns for a table of objects: the union of scalar keys, first seen first. */
  function tableColumns(rows) {
    const cols = [];
    for (const row of rows.slice(0, 20)) {
      if (!row || typeof row !== "object" || Array.isArray(row)) continue;
      for (const [k, v] of Object.entries(row)) {
        if (v !== null && typeof v === "object") continue;
        if (!cols.includes(k)) cols.push(k);
        if (cols.length >= MAX_COLS) return cols;
      }
    }
    return cols;
  }

  /**
   * The Pulse page's cloud-spend card from one aitherSpend-shaped answer
   * ({ok, data} | {ok:false, reason, notDeployed}). An absent tool says so and
   * a failed read says why -- neither is ever drawn as $0.00.
   */
  function spendCardModel(result) {
    if (!result) return { pill: "no answer", tone: "bad", lines: ["The desk did not answer."] };
    if (!result.ok) {
      return result.notDeployed
        ? { pill: "not deployed", tone: "warn", lines: ["Spend reporting is not deployed yet."] }
        : { pill: "failed", tone: "bad", lines: ["Could not read spend: " + (result.reason || "no answer")] };
    }
    const d = result.data || {};
    const usd = (n) => "$" + (Number(n) || 0).toFixed(2);
    const lines = ["Last 24h: " + usd(d.total_usd) + " over " + (Number(d.requests) || 0) + " requests"];
    if (Number(d.unpriced_requests) > 0) lines.push(d.unpriced_requests + " unpriced request(s) not in the total");
    for (const p of (d.providers || []).slice(0, 3)) {
      lines.push(p.provider + ": " + usd(p.usd) + " · " + (Number(p.requests) || 0) + " req"
        + (Number(p.failed) > 0 ? " · " + p.failed + " failed" : ""));
    }
    const ds = d.balance && d.balance.deepseek;
    if (ds) {
      const n = Number(ds.total_balance);
      const amount = Number.isFinite(n) ? n.toFixed(2) : String(ds.total_balance);
      lines.push(ds.available
        ? "DeepSeek balance: " + (ds.currency === "USD" ? "$" + amount : amount + " " + ds.currency)
        : "DeepSeek balance unavailable" + (ds.error ? " (" + ds.error + ")" : ""));
    }
    if (result.stale) lines.unshift("Offline copy (saved " + (result.savedAt || "earlier") + ") -- live read failed");
    return { pill: usd(d.total_usd), tone: result.stale || Number(d.unpriced_requests) > 0 ? "warn" : "ok", lines };
  }

  /**
   * The Strata plane's storage-pool card from GET /strata/mesh/health (mesh SAN
   * milestone 1). Strata sends null for a number it could not read and names it in
   * `unknown`; this draws it "unknown" -- NEVER 0. "Under-replicated: 0" is a claim
   * that every owed copy exists, so it may only appear when Strata knows it.
   */
  function meshHealthModel(data) {
    if (!data || typeof data !== "object") {
      return { pill: "unknown", tone: "warn", lines: ["Strata sent no pool health."] };
    }
    const num = (v) => (v === null || v === undefined || v === "" || !Number.isFinite(Number(v))
      ? null : Number(v));
    const show = (v) => (num(v) === null ? "unknown" : String(num(v)));
    const bytes = (v) => (num(v) === null ? "unknown" : humanBytes(num(v)));
    const state = ["healthy", "degraded", "unknown", "off"].includes(data.state) ? data.state : "unknown";
    const tone = state === "healthy" ? "ok" : state === "degraded" ? "bad" : "warn";
    const lines = [];
    lines.push("Under-replicated: " + show(data.under_replicated)
      + (num(data.objects) === null ? "" : " of " + show(data.objects) + " objects"));
    const q = data.repair_queue && typeof data.repair_queue === "object" ? data.repair_queue : null;
    lines.push(q
      ? "Repair queue: " + show(data.repair_queue_total) + " (re-replicate " + show(q.rereplicate)
        + ", purge " + show(q.purge) + ", drop " + show(q.drop) + ", delete fan-out " + show(q.delete_fanout) + ")"
      : "Repair queue: unknown");
    lines.push("Enrolment pending: " + show(data.enroll_pending));
    const cap = data.capacity && typeof data.capacity === "object" ? data.capacity : null;
    lines.push(cap
      ? "Peers: " + show(cap.live) + " live of " + show(cap.peers) + " · " + show(cap.failure_domains)
        + " failure domains · " + bytes(cap.free_bytes) + " free of " + bytes(cap.contributed_bytes) + " lent"
      : "Capacity: unknown");
    if (num(data.misplaced) > 0) lines.push(show(data.misplaced) + " replica(s) on a peer not allowed to hold them");
    if (data.replicate === false) lines.push("Peer placement is OFF (distributed.enabled false)");
    const last = data.last_repair && typeof data.last_repair === "object" ? data.last_repair : null;
    lines.push(last
      ? "Last repair pass: " + (last.ok === false ? "FAILED " + String(last.error || "") : "ok")
        + (last.at ? " at " + String(last.at) : "") + (num(last.repaired) === null ? "" : " · " + show(last.repaired) + " placed")
      : "Last repair pass: none yet");
    const unknown = Array.isArray(data.unknown) ? data.unknown.map(String) : [];
    if (unknown.length) lines.push("Not readable: " + unknown.join(", "));
    return { pill: state, tone, lines };
  }

  /** The note on a card showing an offline copy: when it was saved and why the live read failed. */
  function staleNote(read, nowMs) {
    const ms = Math.max(0, (nowMs || Date.now()) - Date.parse(read && read.savedAt));
    let ago = "at an unknown time";
    if (Number.isFinite(ms)) {
      ago = ms < 90000 ? "just now" : ms < 5400000 ? Math.round(ms / 60000) + " min ago"
        : ms < 172800000 ? Math.round(ms / 3600000) + " h ago" : Math.round(ms / 86400000) + " d ago";
    }
    return "Offline copy from " + ago + " -- live read failed: " + ((read && read.error) || "no answer");
  }


  // ── Strata node browser (node-browser-client.cjs via the aitherPlane bridge) ──
  // Pure: a model from one storage_files_tree answer, and a view of it as plain
  // {tag, cls, text, children, action} nodes that the DOM half turns into elements
  // (textContent only). The test renders the view from a fixture.

  /** A child's full path in index spelling: roots are already full, the rest join with "/". */
  function childPath(parent, name) {
    if (!parent) return String(name);
    return (String(parent).endsWith("/") ? parent : parent + "/") + name;
  }

  /** "3 min ago" from an ISO string or epoch seconds; "unknown" when neither parses. */
  function agoText(when, nowMs) {
    const t = typeof when === "number" ? when * 1000 : Date.parse(when);
    if (!Number.isFinite(t)) return "unknown";
    const ms = Math.max(0, (nowMs || Date.now()) - t);
    return ms < 90000 ? "just now" : ms < 5400000 ? Math.round(ms / 60000) + " min ago"
      : ms < 172800000 ? Math.round(ms / 3600000) + " h ago" : Math.round(ms / 86400000) + " d ago";
  }

  /**
   * Which source answered and how fresh it is. "inventory" names the signed release,
   * when it was published and when its signature was verified; "genesis" names the
   * newest scan/push of the index. A stale index is a warning, never hidden.
   */
  function sourceModel(answer, nowMs) {
    const a = answer || {};
    if (a.source === "inventory") {
      const inv = a.inventory && !Array.isArray(a.inventory) ? a.inventory : {};
      const lines = ["Signed inventory " + (inv.release || "(release unknown)")
        + " · published " + agoText(inv.published_at, nowMs)
        + " · signature verified " + agoText(inv.verified_at, nowMs)];
      if (a.genesis_error) lines.push("Genesis did not answer: " + a.genesis_error);
      if (a.inventory_warning) lines.push(a.inventory_warning);
      return { pill: "inventory", tone: a.inventory_warning || a.stale ? "warn" : "ok", lines,
        publishedAt: inv.published_at || null };
    }
    const roots = Array.isArray(a.indexed_roots) ? a.indexed_roots : [];
    let newest = null;
    for (const r of roots) {
      for (const v of [r && r.last_push_at, r && r.scanned_at]) {
        if (typeof v === "string" && v && (newest === null || Date.parse(v) > Date.parse(newest))) newest = v;
      }
    }
    return { pill: "genesis", tone: a.stale ? "warn" : "ok", publishedAt: null,
      lines: ["Genesis index · updated " + (newest ? agoText(newest, nowMs) : "unknown")
        + (a.stale ? " · STALE (older than 48 h)" : "")] };
  }

  /** One folder level as rows: full path, size text, and whether it can be opened. */
  function nodeTreeModel(answer, nowMs) {
    const a = answer || {};
    const kids = Array.isArray(a.children) ? a.children : [];
    const rows = kids.filter((c) => c && typeof c === "object" && c.name != null).map((c) => ({
      name: String(c.name),
      path: childPath(a.path || "", String(c.name)),
      kind: String(c.kind || "file"),
      bytes: Number(c.bytes) || 0,
      size: humanBytes(Number(c.bytes) || 0),
      files: Number(c.files) || 0,
      modified: c.newest_mtime ? agoText(Number(c.newest_mtime), nowMs) : "—",
      open: c.kind === "dir" || c.kind === "root",
    }));
    const total = rows.reduce((n, r) => n + r.bytes, 0);
    return { node: String(a.node || ""), path: String(a.path || ""), rows,
      total: humanBytes(total), truncated: Boolean(a.truncated), source: sourceModel(a, nowMs) };
  }

  /**
   * The browser card as plain nodes. state: {nodes:[nodeRow], node, stack:[path],
   * answer, error, loading}. Actions: {type:"node", value}, {type:"open", path},
   * {type:"crumb", index}, {type:"reload"}.
   */
  function nodeBrowserView(state, nowMs) {
    const s = state || {};
    const n = (tag, cls, text, children, extra) => Object.assign({ tag, cls: cls || "", text: text == null ? null : String(text),
      children: children || [] }, extra || {});
    const options = (s.nodes || []).map((r) => n("option", "", r.node + (r.source === "inventory"
      ? " (inventory" + (r.inventory && r.inventory.verified ? "" : ", not yet verified") + ")" : ""),
    [], { value: r.node, selected: r.node === s.node }));
    const head = n("h3", "", null, [n("span", "", "Node browser"), n("span", "grow"),
      n("span", "tool muted", "storage_files_tree")]);
    const bar = n("div", "nb-bar", null, [
      n("select", "nb-node", null, [n("option", "", "pick a node…", [], { value: "" }), ...options],
        { action: { type: "node" } }),
      n("button", "chip", "Reload", [], { action: { type: "reload" } }),
    ]);
    const out = [head, bar];
    if (s.nodesError) out.push(n("div", "summary bad", "Nodes: " + s.nodesError));
    if (!s.node) {
      out.push(n("div", "placeholder", (s.nodes || []).length ? "Pick a node to browse its folders."
        : "No node has a file index or a signed inventory yet."));
      return n("section", "card wide nb", null, out);
    }
    const stack = s.stack && s.stack.length ? s.stack : [""];
    out.push(n("div", "nb-crumbs", null, stack.map((p, i) => n(i === stack.length - 1 ? "span" : "button",
      i === stack.length - 1 ? "nb-here" : "nb-crumb", i === 0 ? s.node : p.split("/").filter(Boolean).pop() || p,
      [], i === stack.length - 1 ? {} : { action: { type: "crumb", index: i } }))));
    if (s.loading) out.push(n("div", "placeholder", "reading…"));
    if (s.error) {
      out.push(n("div", "summary bad", "Could not read this folder: " + s.error));
      return n("section", "card wide nb", null, out);
    }
    if (!s.answer) return n("section", "card wide nb", null, out);
    const m = nodeTreeModel(s.answer, nowMs);
    out.push(n("div", "nb-source", null, [n("span", "pill " + m.source.tone, m.source.pill),
      ...m.source.lines.map((l) => n("span", m.source.tone === "warn" ? "summary warn" : "muted", l))]));
    if (!m.rows.length) {
      out.push(n("div", "placeholder", "Empty: nothing indexed under this path."));
      return n("section", "card wide nb", null, out);
    }
    const header = n("tr", "", null, ["name", "size", "files", "modified"].map((c) => n("th", "", c)));
    const rows = m.rows.map((r) => n("tr", r.open ? "nb-open" : "", null, [
      n("td", "", (r.open ? "▸ " : "") + r.name, [], r.open ? { action: { type: "open", path: r.path } } : {}),
      n("td", "nb-size", r.size), n("td", "", String(r.files)), n("td", "muted", r.modified)]));
    out.push(n("table", "nb-table", null, [header, ...rows]));
    out.push(n("div", "more", m.rows.length + " entries · " + m.total + (m.truncated ? " · more not shown" : "")));
    return n("section", "card wide nb", null, out);
  }

  const pure = { humanBytes, formatScalar, serviceVerdict, tableColumns, spendCardModel, meshHealthModel, staleNote,
    childPath, agoText, sourceModel, nodeTreeModel, nodeBrowserView, MAX_ROWS, MAX_COLS };
  if (typeof module === "object" && module.exports) {
    module.exports = pure;
    return;
  }

  // ── DOM half ────────────────────────────────────────────────────────────────
  const doc = root.document;
  const bridge = root.aitherPlane;
  const planeId = doc.body.dataset.plane || "";
  const $ = (id) => doc.getElementById(id);
  const stateEl = $("state");
  const grid = $("reads");
  let timer = null;
  let busy = false;

  function say(text, isError) {
    stateEl.textContent = text || "";
    stateEl.classList.toggle("err", Boolean(isError));
  }
  function el(tag, cls, text) {
    const e = doc.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = String(text);
    return e;
  }

  function renderValue(value, depth, key) {
    if (value === null || value === undefined || typeof value !== "object") {
      const span = el("span", "v", formatScalar(key, value));
      if (value === true) span.classList.add("yes");
      if (value === false) span.classList.add("no");
      return span;
    }
    if (depth >= MAX_DEPTH) return el("pre", "", JSON.stringify(value, null, 2));
    if (Array.isArray(value)) return renderArray(value, depth);
    return renderObject(value, depth);
  }

  function renderArray(items, depth) {
    if (!items.length) return el("div", "placeholder", "none");
    const box = el("div");
    const objects = items.every((x) => x && typeof x === "object" && !Array.isArray(x));
    if (objects) {
      const cols = tableColumns(items);
      if (cols.length) {
        const table = el("table");
        const head = el("tr");
        for (const c of cols) head.appendChild(el("th", "", c));
        table.appendChild(head);
        for (const row of items.slice(0, MAX_ROWS)) {
          const tr = el("tr");
          for (const c of cols) tr.appendChild(el("td", "", formatScalar(c, row[c])));
          table.appendChild(tr);
        }
        box.appendChild(table);
      } else {
        for (const row of items.slice(0, MAX_ROWS)) box.appendChild(renderValue(row, depth + 1));
      }
    } else {
      const ul = el("ul", "list");
      for (const item of items.slice(0, MAX_ROWS)) {
        const li = el("li");
        li.appendChild(renderValue(item, depth + 1));
        ul.appendChild(li);
      }
      box.appendChild(ul);
    }
    if (items.length > MAX_ROWS) box.appendChild(el("div", "more", "+" + (items.length - MAX_ROWS) + " more"));
    return box;
  }

  function renderObject(obj, depth) {
    const box = el("div");
    const entries = Object.entries(obj);
    if (!entries.length) { box.appendChild(el("div", "placeholder", "empty")); return box; }
    const kv = el("div", "kv");
    const nested = [];
    for (const [k, v] of entries) {
      if (v !== null && typeof v === "object") { nested.push([k, v]); continue; }
      kv.appendChild(el("span", "k", k));
      kv.appendChild(renderValue(v, depth + 1, k));
    }
    if (kv.childNodes.length) box.appendChild(kv);
    for (const [k, v] of nested) {
      const d = el("details");
      if (depth === 0 && nested.length <= 3) d.open = true;
      const size = Array.isArray(v) ? v.length : Object.keys(v).length;
      d.appendChild(el("summary", "", k + " (" + size + ")"));
      const inner = el("div", "inner");
      inner.appendChild(renderValue(v, depth + 1, k));
      d.appendChild(inner);
      box.appendChild(d);
    }
    return box;
  }

  function renderRead(read) {
    const card = el("section", "card");
    // A big answer gets the full row; a service verdict never needs it.
    if (read.id !== "service" && read.ok && JSON.stringify(read.data || "").length > 1600) {
      card.classList.add("wide");
    }
    const h = el("h3");
    h.appendChild(el("span", "", read.label));
    h.appendChild(el("span", "grow"));
    h.appendChild(el("span", "tool muted", read.tool));
    let pill;
    if (!read.ok) pill = el("span", "pill bad", "failed");
    else if (read.stale) pill = el("span", "pill warn", "offline copy");
    else if (read.id === "service") {
      const v = serviceVerdict(read.data);
      pill = el("span", "pill " + (v.state === "up" ? "ok" : v.state === "down" ? "bad" : "warn"), v.text);
    } else if (read.id === "mesh") {
      const m = meshHealthModel(read.data);
      pill = el("span", "pill " + m.tone, m.pill);
    } else pill = el("span", "pill ok", "ok");
    h.appendChild(pill);
    card.appendChild(h);
    if (!read.ok) {
      card.appendChild(el("div", "summary bad", "Could not read: " + (read.error || "no answer")));
      return card;
    }
    if (read.stale) {
      card.classList.add("stale");
      card.appendChild(el("div", "summary warn", staleNote(read)));
    }
    if (read.id === "mesh") {
      const m = meshHealthModel(read.data);
      for (const line of m.lines) card.appendChild(el("div", m.tone === "bad" ? "summary bad" : "summary", line));
      const d = el("details");
      d.appendChild(el("summary", "", "details"));
      const inner = el("div", "inner");
      inner.appendChild(renderValue(read.data, 1));
      d.appendChild(inner);
      card.appendChild(d);
      return card;
    }
    card.appendChild(renderValue(read.data, 0));
    return card;
  }

  function renderSpendCard(result) {
    const m = spendCardModel(result);
    const card = el("section", "card");
    const h = el("h3");
    h.appendChild(el("span", "", "Cloud LLM spend"));
    h.appendChild(el("span", "grow"));
    h.appendChild(el("span", "tool muted", "cloud_spend"));
    h.appendChild(el("span", "pill " + m.tone, m.pill));
    card.appendChild(h);
    for (const line of m.lines) card.appendChild(el("div", m.tone === "bad" ? "summary bad" : "", line));
    const open = el("button", "chip", "Open spend report");
    open.style.marginTop = "8px";
    open.addEventListener("click", () => { void bridge.openSpend(); });
    card.appendChild(open);
    return card;
  }


  // ── Strata node browser (DOM) ───────────────────────────────────────────────
  // One persistent card: the 30 s auto-refresh re-appends it, never re-reads it, so
  // a folder the owner drilled into stays put.
  const browserOn = planeId === "strata" && bridge && typeof bridge.filesNodes === "function";
  const nb = { nodes: [], node: "", stack: [""], answer: null, error: null, nodesError: null, loading: false };
  let nbCard = null;

  function materialize(v) {
    const e = el(v.tag, v.cls || "", v.text);
    if (v.value !== undefined) e.value = v.value;
    if (v.selected) e.selected = true;
    for (const c of v.children || []) e.appendChild(materialize(c));
    if (v.action) {
      const act = v.action;
      if (v.tag === "select") e.addEventListener("change", () => void nbAct({ type: "node", value: e.value }));
      else e.addEventListener("click", () => void nbAct(act));
    }
    return e;
  }

  function nbDraw() {
    const next = materialize(nodeBrowserView(nb));
    if (nbCard && nbCard.parentNode) nbCard.parentNode.replaceChild(next, nbCard);
    nbCard = next;
  }

  async function nbLoadNodes() {
    const res = await bridge.filesNodes().catch((e) => ({ ok: false, error: String((e && e.message) || e) }));
    if (res && res.ok) {
      nb.nodes = (res.data && res.data.nodes) || [];
      nb.nodesError = [res.data && res.data.genesisError ? "Genesis: " + res.data.genesisError : null,
        res.data && res.data.inventoryError ? res.data.inventoryError : null].filter(Boolean).join(" · ") || null;
    } else {
      nb.nodesError = (res && res.error) || "no answer";
    }
    nbDraw();
  }

  async function nbLoadTree() {
    nb.loading = true;
    nb.error = null;
    nbDraw();
    const res = await bridge.filesTree(nb.node, nb.stack[nb.stack.length - 1])
      .catch((e) => ({ ok: false, error: String((e && e.message) || e) }));
    nb.loading = false;
    if (res && res.ok) nb.answer = res.data;
    else { nb.answer = null; nb.error = (res && res.error) || "no answer"; }
    nbDraw();
  }

  async function nbAct(act) {
    if (act.type === "node") {
      nb.node = act.value || "";
      nb.stack = [""];
      nb.answer = null;
      nb.error = null;
      if (nb.node) await nbLoadTree(); else nbDraw();
    } else if (act.type === "open") {
      nb.stack = nb.stack.concat([act.path]);
      await nbLoadTree();
    } else if (act.type === "crumb") {
      nb.stack = nb.stack.slice(0, act.index + 1);
      await nbLoadTree();
    } else if (act.type === "reload") {
      await nbLoadNodes();
      if (nb.node) await nbLoadTree();
    }
  }

  function browserCard() {
    if (!browserOn) return null;
    if (!nbCard) { nbDraw(); void nbLoadNodes(); }
    return nbCard;
  }

  async function refresh() {
    if (busy) return;
    busy = true;
    say("refreshing…");
    try {
      // Pulse also carries the cloud-spend card (spend-window.cjs answers it).
      const spendAsk = planeId === "pulse" && typeof bridge.spend === "function"
        ? bridge.spend(24).catch((e) => ({ ok: false, reason: String((e && e.message) || e) }))
        : null;
      const res = await bridge.snapshot(planeId);
      if (!res || !res.ok) {
        grid.replaceChildren(el("div", "summary bad", "Could not read " + planeId + ": "
          + ((res && res.error) || "no answer")));
        const card = browserCard();
        if (card) grid.appendChild(card);
        say("read failed", true);
        return;
      }
      const snap = res.data || {};
      const reads = Array.isArray(snap.reads) ? snap.reads : [];
      grid.replaceChildren(...reads.map(renderRead));
      if (spendAsk) grid.appendChild(renderSpendCard(await spendAsk));
      if (!reads.length) grid.appendChild(el("div", "placeholder", "This plane has no reads."));
      const card = browserCard();
      if (card) grid.appendChild(card);
      const failed = Number(snap.failed) || 0;
      const stale = Number(snap.stale) || 0;
      say(failed ? failed + " of " + reads.length + " reads failed -- see below"
        : stale ? "OFFLINE COPY · " + stale + " of " + reads.length + " reads are the last good answer"
          : "updated " + new Date().toLocaleTimeString(), failed > 0 || stale > 0);
    } catch (error) {
      say("refresh failed: " + String((error && error.message) || error), true);
    } finally {
      busy = false;
    }
  }

  function setAuto(on) {
    if (timer) { root.clearInterval(timer); timer = null; }
    if (on) timer = root.setInterval(() => { if (doc.visibilityState === "visible") void refresh(); }, REFRESH_MS);
    $("auto").classList.toggle("on", Boolean(on));
    $("auto").textContent = on ? "Auto: on" : "Auto: off";
  }

  $("refresh").addEventListener("click", () => void refresh());
  $("auto").addEventListener("click", () => setAuto(!timer));
  if (!bridge) say("no plane bridge in this frame", true);
  else { setAuto(true); void refresh(); }
})(typeof window === "undefined" ? globalThis : window);
