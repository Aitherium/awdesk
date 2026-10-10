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
    return { state: "ok", data: d, models, stale: Boolean(result.stale), savedAt: result.savedAt || null,
      reason: result.reason || null };
  }

  /** "42%" of a total; "—" when there is no total to share. */
  function share(n, total) {
    const t = Number(total);
    const v = Number(n);
    if (!Number.isFinite(t) || t <= 0 || !Number.isFinite(v)) return "—";
    const pct = (v / t) * 100;
    return (pct > 0 && pct < 1 ? "<1" : String(Math.round(pct))) + "%";
  }

  /**
   * The budget line for one window: the 24h window against the daily budget, 7d
   * against 7 x daily, 30d against the monthly one (falling back to 30 x daily).
   * null when no budget covers this window.
   */
  function budgetView(totalUsd, hours, budget) {
    const b = budget || {};
    const daily = Number(b.daily_usd) > 0 ? Number(b.daily_usd) : 0;
    const monthly = Number(b.monthly_usd) > 0 ? Number(b.monthly_usd) : 0;
    let limit = 0;
    let basis = "";
    if (hours === 24 && daily) { limit = daily; basis = "daily budget"; }
    else if (hours === 168 && daily) { limit = daily * 7; basis = "7 x daily budget"; }
    else if (hours === 720 && monthly) { limit = monthly; basis = "monthly budget"; }
    else if (hours === 720 && daily) { limit = daily * 30; basis = "30 x daily budget"; }
    if (!limit) return null;
    const used = Number(totalUsd) || 0;
    const pct = (used / limit) * 100;
    return {
      limit, used, basis, pct,
      tone: pct >= 100 ? "bad" : pct >= 80 ? "warn" : "ok",
      label: fmtUsd(used) + " of " + fmtUsd(limit) + " " + basis + " (" + Math.round(pct) + "%)",
      left: used >= limit ? "over by " + fmtUsd(used - limit) : fmtUsd(limit - used) + " left",
    };
  }

  /**
   * Per-day bars from the report's by_day: the last `days` days ending on the newest
   * reported day, gaps filled with zero (the ledger row set is complete, so a day
   * with no row had no calls), heights relative to the busiest day. null when the
   * backend did not report by_day (an older MicroScheduler) -- never an empty chart.
   */
  function dayBars(byDay, days) {
    if (!Array.isArray(byDay)) return null;
    const rows = new Map(byDay.map((r) => [r.day, r]));
    const sorted = byDay.map((r) => r.day).sort();
    const last = sorted.length ? sorted[sorted.length - 1] : null;
    const span = Math.max(1, Math.min(31, Number(days) || 1));
    const out = [];
    if (last) {
      const end = Date.parse(last + "T00:00:00Z");
      for (let i = span - 1; i >= 0; i -= 1) {
        const day = new Date(end - i * 86400000).toISOString().slice(0, 10);
        const r = rows.get(day);
        out.push({ day, usd: r ? r.usd : 0, requests: r ? r.requests : 0, providers: r ? r.providers || {} : {} });
      }
    }
    const max = out.reduce((m, r) => Math.max(m, r.usd), 0);
    for (const r of out) r.pct = max > 0 ? Math.max(r.usd > 0 ? 2 : 0, Math.round((r.usd / max) * 100)) : 0;
    return out;
  }

  /** The line the page shows over an offline copy; null for a live answer. */
  function staleLine(result, nowMs) {
    if (!result || !result.stale) return null;
    const ms = Math.max(0, (nowMs || Date.now()) - Date.parse(result.savedAt));
    let ago = "at an unknown time";
    if (Number.isFinite(ms)) {
      ago = ms < 90000 ? "just now" : ms < 5400000 ? Math.round(ms / 60000) + " min ago"
        : ms < 172800000 ? Math.round(ms / 3600000) + " h ago" : Math.round(ms / 86400000) + " d ago";
    }
    return "Offline copy from " + ago + " -- live read failed: " + (result.reason || "no answer");
  }

  const pure = { fmtUsd, fmtTokens, balanceLine, viewModel, share, budgetView, dayBars, staleLine, WINDOWS, NOT_DEPLOYED };
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
  let budget = { daily_usd: 0, monthly_usd: 0 };
  let lastResult = null;

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

  function budgetCard(d) {
    const c = card("Budget");
    const view = budgetView(d.total_usd, hours, budget);
    if (view) {
      c.appendChild(el("div", "balance " + (view.tone === "ok" ? "" : view.tone), view.label));
      const meter = el("div", "meter");
      const fill = el("div", "fill " + view.tone);
      fill.style.width = Math.min(100, view.pct).toFixed(1) + "%";
      meter.appendChild(fill);
      c.appendChild(meter);
      c.appendChild(el("div", "muted small", view.left));
    } else {
      c.appendChild(el("div", "placeholder", "No budget covers this window. Set one below -- it stays on this desk."));
    }
    const form = el("div", "budget-form");
    const field = (label, value) => {
      const wrap = el("label", "small muted", label + " ");
      const input = el("input");
      input.type = "number"; input.min = "0"; input.step = "1"; input.placeholder = "none";
      input.value = value > 0 ? String(value) : "";
      wrap.appendChild(input);
      form.appendChild(wrap);
      return input;
    };
    const daily = field("Daily $", budget.daily_usd);
    const monthly = field("Monthly $", budget.monthly_usd);
    const save = el("button", "chip", "Save");
    save.addEventListener("click", async () => {
      if (typeof bridge.setBudget !== "function") return;
      const res = await bridge.setBudget(daily.value, monthly.value);
      if (res && res.ok) {
        budget = res.data;
        if (lastResult) render(viewModel(lastResult));
        say("budget saved");
      } else say("budget not saved: " + ((res && res.error) || "no answer"), true);
    });
    form.appendChild(save);
    c.appendChild(form);
    return c;
  }

  function dayCard(d) {
    const days = Math.round(hours / 24);
    const c = card(days > 1 ? "Spend per day (UTC)" : "Today and yesterday (UTC)", true);
    const bars = dayBars(d.by_day, Math.max(days, 2));
    if (bars === null) {
      c.appendChild(el("div", "placeholder", "This MicroScheduler does not report per-day spend yet (by_day ships with its next image)."));
      return c;
    }
    if (!bars.length) { c.appendChild(el("div", "placeholder", "No cloud LLM calls in this window.")); return c; }
    const chart = el("div", "days");
    for (const b of bars) {
      const col = el("div", "day");
      const split = Object.entries(b.providers).filter(([, v]) => v > 0).map(([k, v]) => k + " " + fmtUsd(v)).join(", ");
      col.title = b.day + ": " + fmtUsd(b.usd) + " · " + b.requests + " request(s)" + (split ? " · " + split : "");
      const track = el("div", "track");
      const bar = el("div", "bar-fill");
      bar.style.height = b.pct + "%";
      track.appendChild(bar);
      col.appendChild(el("div", "amt", b.usd > 0 ? fmtUsd(b.usd) : ""));
      col.appendChild(track);
      col.appendChild(el("div", "lbl", b.day.slice(5)));
      chart.appendChild(col);
    }
    c.appendChild(chart);
    return c;
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
        { label: "Share", num: true, get: (r) => share(r.usd, d.total_usd) },
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
        { label: "Share", num: true, get: (r) => share(r.usd, d.total_usd) },
        { label: "Requests", num: true, get: (r) => fmtTokens(r.requests) },
        { label: "Prompt", num: true, get: (r) => fmtTokens(r.prompt_tokens) },
        { label: "Completion", num: true, get: (r) => fmtTokens(r.completion_tokens) },
      ], vm.models));
    }

    const src = card("Top spenders (callers)", true);
    if (!d.top_sources.length) src.appendChild(el("div", "placeholder", "No attributed callers."));
    else {
      src.appendChild(table([
        { label: "Source", get: (r) => r.source },
        { label: "Spend", num: true, get: (r) => fmtUsd(r.usd) },
        { label: "Share", num: true, get: (r) => share(r.usd, d.total_usd) },
        { label: "Requests", num: true, get: (r) => fmtTokens(r.requests) },
        { label: "Tokens", num: true, get: (r) => fmtTokens(r.tokens) },
      ], d.top_sources));
    }
    const parts = [];
    if (vm.stale) {
      const off = card("Offline copy", true);
      off.classList.add("stale");
      off.appendChild(el("div", "summary warn", staleLine({ stale: true, savedAt: vm.savedAt, reason: vm.reason })));
      parts.push(off);
    }
    parts.push(totals, budgetCard(d), bal, dayCard(d), src, prov, mod);
    body.replaceChildren(...parts);
  }

  async function refresh(fresh) {
    if (busy) return;
    busy = true;
    say("reading…");
    try {
      lastResult = await bridge.report(hours, fresh);
      const vm = viewModel(lastResult);
      render(vm);
      if (vm.state === "ok" && vm.stale) say("OFFLINE COPY · " + staleLine(lastResult), true);
      else if (vm.state === "ok") say("updated " + new Date().toLocaleTimeString() + (vm.data.generated_at ? " · report " + vm.data.generated_at : ""));
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
    if (typeof bridge.budget === "function") {
      bridge.budget().then((res) => {
        if (res && res.ok) { budget = res.data; if (lastResult) render(viewModel(lastResult)); }
      }).catch(() => {});
    }
    void refresh(false);
    timer = root.setInterval(() => { if (doc.visibilityState === "visible") void refresh(false); }, REFRESH_MS);
  }
  void timer;
})(typeof window === "undefined" ? globalThis : window);
