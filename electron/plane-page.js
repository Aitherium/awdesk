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
    return { pill: usd(d.total_usd), tone: Number(d.unpriced_requests) > 0 ? "warn" : "ok", lines };
  }

  const pure = { humanBytes, formatScalar, serviceVerdict, tableColumns, spendCardModel, MAX_ROWS, MAX_COLS };
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
    else if (read.id === "service") {
      const v = serviceVerdict(read.data);
      pill = el("span", "pill " + (v.state === "up" ? "ok" : v.state === "down" ? "bad" : "warn"), v.text);
    } else pill = el("span", "pill ok", "ok");
    h.appendChild(pill);
    card.appendChild(h);
    if (!read.ok) {
      card.appendChild(el("div", "summary bad", "Could not read: " + (read.error || "no answer")));
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
        say("read failed", true);
        return;
      }
      const snap = res.data || {};
      const reads = Array.isArray(snap.reads) ? snap.reads : [];
      grid.replaceChildren(...reads.map(renderRead));
      if (spendAsk) grid.appendChild(renderSpendCard(await spendAsk));
      if (!reads.length) grid.appendChild(el("div", "placeholder", "This plane has no reads."));
      const failed = Number(snap.failed) || 0;
      say(failed ? failed + " of " + reads.length + " reads failed -- see below"
        : "updated " + new Date().toLocaleTimeString(), failed > 0);
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
