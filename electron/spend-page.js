/* global window, module */
"use strict";
// The Spend page (spend.html): cloud LLM spend over the aitherSpend bridge
// (spend-preload.cjs -> spend-window.cjs -> spend-client.cjs -> gateway
// `cloud_spend`). Every value is rendered with textContent -- tool output is
// DATA, never markup. A failed or absent report is SAID, never drawn as zeros.
//
// The pure half (no DOM) is exported when a `module` object exists, which is how
// spend-page.test.cjs loads it (vm, since package.json makes .js files ESM).

(function main(root) {
  const WINDOWS = [{ hours: 24, label: "24h" }, { hours: 168, label: "7d" }, { hours: 720, label: "30d" }];
  const REFRESH_MS = 60000;
  const NOT_DEPLOYED = "Spend reporting is not deployed yet -- the gateway has no cloud_spend tool. "
    + "Nothing is shown rather than zeros, because zeros would read as \"nothing spent\".";

  function fmtUsd(n) {
    const v = Number(n);
    if (!Number.isFinite(v)) return "—";
    if (v !== 0 && Math.abs(v) < 0.01) return "$" + v.toFixed(4);
    return "$" + v.toFixed(2);
  }

  function fmtTokens(n) {
    const v = Number(n);
    if (!Number.isFinite(v)) return "—";
    if (v >= 1e9) return (v / 1e9).toFixed(2) + "B";
    if (v >= 1e6) return (v / 1e6).toFixed(2) + "M";
    if (v >= 1e4) return (v / 1e3).toFixed(1) + "k";
    return String(Math.round(v));
  }

  function balanceLine(name, b) {
    if (!b) return name + ": no balance reported";
    if (!b.available) return name + ": balance unavailable" + (b.error ? " (" + b.error + ")" : "");
    const n = Number(b.total_balance);
    const amount = Number.isFinite(n) ? n.toFixed(2) : String(b.total_balance);
    return name + ": " + (b.currency === "USD" ? "$" + amount : amount + " " + b.currency);
  }

  /** What the page shows for one bridge answer: {state, message?, data?}. */
  function viewModel(result) {
    if (!result) return { state: "error", message: "no answer from the desk" };
    if (!result.ok) {
      return result.notDeployed
        ? { state: "not-deployed", message: NOT_DEPLOYED }
        : { state: "error", message: "Could not read spend: " + (result.reason || result.error || "no answer") };
    }
    const d = result.data || {};
    const models = [];
    for (const p of d.providers || []) {
      for (const m of p.models || []) models.push(Object.assign({ provider: p.provider }, m));
    }
    models.sort((a, b) => b.usd - a.usd || b.requests - a.requests);
    return { state: "ok", data: d, models };
  }

  const pure = { fmtUsd, fmtTokens, balanceLine, viewModel, WINDOWS, NOT_DEPLOYED };
  if (typeof module === "object" && module.exports) {
    module.exports = pure;
    return;
  }

  // ── DOM half ────────────────────────────────────────────────────────────────
  const doc = root.document;
  const bridge = root.aitherSpend;
  const $ = (id) => doc.getElementById(id);
  const stateEl = $("state");
  const body = $("body");
  let hours = 24;
  let busy = false;
  let timer = null;

  function el(tag, cls, text) {
    const e = doc.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = String(text);
    return e;
  }
  function say(text, isError) {
    stateEl.textContent = text || "";
    stateEl.classList.toggle("err", Boolean(isError));
  }
  function card(title, wide) {
    const s = el("section", "card" + (wide ? " wide" : ""));
    s.appendChild(el("h3", "", title));
    return s;
  }
  function table(cols, rows) {
    const t = el("table");
    const head = el("tr");
    for (const c of cols) head.appendChild(el("th", c.num ? "num" : "", c.label));
    t.appendChild(head);
    for (const row of rows) {
      const tr = el("tr");
      for (const c of cols) tr.appendChild(el("td", c.num ? "num" : "", c.get(row)));
      t.appendChild(tr);
    }
    return t;
  }
  function stat(label, value, cls) {
    const box = el("div", "stat");
    box.appendChild(el("div", "label", label));
    box.appendChild(el("div", "value" + (cls ? " " + cls : ""), value));
    return box;
  }

  function render(vm) {
    if (vm.state !== "ok") {
      const c = card(vm.state === "not-deployed" ? "Not deployed yet" : "Spend unavailable", true);
      c.appendChild(el("div", vm.state === "not-deployed" ? "summary warn" : "summary bad", vm.message));
      body.replaceChildren(c);
      return;
    }
    const d = vm.data;
    const label = (WINDOWS.find((w) => w.hours === hours) || WINDOWS[0]).label;

    const totals = card("Totals, last " + label, true);
    const stats = el("div", "stats");
    stats.appendChild(stat("Spend", fmtUsd(d.total_usd), "big"));
    stats.appendChild(stat("Requests", fmtTokens(d.requests)));
    stats.appendChild(stat("Failed", fmtTokens(d.failed), d.failed > 0 ? "bad" : ""));
    stats.appendChild(stat("Prompt tokens", fmtTokens(d.prompt_tokens)));
    stats.appendChild(stat("Completion tokens", fmtTokens(d.completion_tokens)));
    stats.appendChild(stat("Unpriced requests", fmtTokens(d.unpriced_requests), d.unpriced_requests > 0 ? "warn" : ""));
    totals.appendChild(stats);
    if (d.unpriced_requests > 0) {
      totals.appendChild(el("div", "note", d.unpriced_requests + " request(s) had no price on record -- the total understates the bill."));
    }

    const bal = card("Provider balance");
    const names = Object.keys(d.balance || {});
    if (!names.length) bal.appendChild(el("div", "placeholder", "No provider reported a balance."));
    for (const name of names) {
      const b = d.balance[name];
      bal.appendChild(el("div", "balance" + (b.available ? "" : " warn"), balanceLine(name === "deepseek" ? "DeepSeek" : name, b)));
      if (b.checked_at) bal.appendChild(el("div", "muted small", "checked " + b.checked_at));
    }

    const prov = card("By provider", true);
    if (!d.providers.length) prov.appendChild(el("div", "placeholder", "No cloud LLM calls in this window."));
    else {
      prov.appendChild(table([
        { label: "Provider", get: (r) => r.provider },
        { label: "Spend", num: true, get: (r) => fmtUsd(r.usd) },
        { label: "Requests", num: true, get: (r) => fmtTokens(r.requests) },
        { label: "Failed", num: true, get: (r) => fmtTokens(r.failed) },
        { label: "Prompt", num: true, get: (r) => fmtTokens(r.prompt_tokens) },
        { label: "Completion", num: true, get: (r) => fmtTokens(r.completion_tokens) },
      ], d.providers));
    }

    const mod = card("By model", true);
    if (!vm.models.length) mod.appendChild(el("div", "placeholder", "No model rows."));
    else {
      mod.appendChild(table([
        { label: "Model", get: (r) => r.model },
        { label: "Provider", get: (r) => r.provider },
        { label: "Spend", num: true, get: (r) => fmtUsd(r.usd) },
        { label: "Requests", num: true, get: (r) => fmtTokens(r.requests) },
        { label: "Prompt", num: true, get: (r) => fmtTokens(r.prompt_tokens) },
        { label: "Completion", num: true, get: (r) => fmtTokens(r.completion_tokens) },
      ], vm.models));
    }

    const src = card("Top callers", true);
    if (!d.top_sources.length) src.appendChild(el("div", "placeholder", "No attributed callers."));
    else {
      src.appendChild(table([
        { label: "Source", get: (r) => r.source },
        { label: "Spend", num: true, get: (r) => fmtUsd(r.usd) },
        { label: "Requests", num: true, get: (r) => fmtTokens(r.requests) },
        { label: "Tokens", num: true, get: (r) => fmtTokens(r.tokens) },
      ], d.top_sources));
    }
    body.replaceChildren(totals, bal, prov, mod, src);
  }

  async function refresh(fresh) {
    if (busy) return;
    busy = true;
    say("reading…");
    try {
      const vm = viewModel(await bridge.report(hours, fresh));
      render(vm);
      if (vm.state === "ok") say("updated " + new Date().toLocaleTimeString() + (vm.data.generated_at ? " · report " + vm.data.generated_at : ""));
      else say(vm.state === "not-deployed" ? "not deployed yet" : "read failed", vm.state !== "not-deployed");
    } catch (error) {
      say("refresh failed: " + String((error && error.message) || error), true);
    } finally {
      busy = false;
    }
  }

  for (const w of WINDOWS) {
    const b = $("w-" + w.hours);
    b.addEventListener("click", () => {
      hours = w.hours;
      for (const x of WINDOWS) $("w-" + x.hours).classList.toggle("on", x.hours === hours);
      void refresh(false);
    });
  }
  $("refresh").addEventListener("click", () => void refresh(true));
  if (!bridge) say("no spend bridge in this frame", true);
  else {
    void refresh(false);
    timer = root.setInterval(() => { if (doc.visibilityState === "visible") void refresh(false); }, REFRESH_MS);
  }
  void timer;
})(typeof window === "undefined" ? globalThis : window);
