/* global window, document, URLSearchParams, setInterval, clearInterval, setTimeout, clearTimeout, location, history */
/* aither://search -- renders search-client.cjs results through window.aitherSearch
   (search-preload.cjs). Every value goes in as textContent; links are http(s) only
   (checked in main) and open as web tabs (the internal tab's navigation fence). */
(function () {
  "use strict";
  const api = window.aitherSearch;
  const $ = (id) => document.getElementById(id);
  let mode = "q";
  let seq = 0;
  let poll = null;
  // "This PC" state: the last run's groups, which groups the owner expanded past five,
  // the selected row (arrow keys), and the debounce timer for as-you-type.
  const pc = { groups: [], expanded: new Set(), selected: 0, timer: null, query: "" };
  const SHOW = 5;
  const launcher = new URLSearchParams(location.search).get("launcher") === "1";

  const el = (tag, cls, text) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = String(text);
    return n;
  };
  const link = (href, text, cls) => {
    const a = el("a", cls || "", text);
    a.href = href;
    a.rel = "noreferrer";
    return a;
  };
  function status(text, err) {
    $("status").textContent = text || "";
    $("status").className = err ? "err" : "";
  }
  function setMode(next) {
    mode = next;
    for (const b of document.querySelectorAll(".modes button")) b.setAttribute("aria-pressed", String(b.dataset.mode === mode));
    $("go").textContent = mode === "research" ? "Research" : mode === "forge" ? "Open Media Forge" : mode === "pc" ? "Open" : "Search";
    $("q").placeholder = mode === "research" ? "Ask a research question; you get a report where every claim cites its sources"
      : mode === "forge" ? "Media Forge opens in its own tab"
        : mode === "pc" ? "Apps, files, screenshots, clipboard, desk actions, agents and tools" : "Search the web and the platform";
    pc.groups = [];
    pc.expanded = new Set();
    clearInterval(poll);
    poll = null;
    $("out").textContent = "";
    status("");
    if (mode === "research") void showJobs();
    if (mode === "forge") showForge();
    if (mode === "pc") {
      status("Type to search this PC — Enter opens the top result, Tab asks Aither");
      if ($("q").value.trim()) schedulePc();
    }
  }
  for (const b of document.querySelectorAll(".modes button")) b.onclick = () => setMode(b.dataset.mode);

  function renderResults(r) {
    const out = $("out");
    out.textContent = "";
    if (r.answer) out.append(el("div", "answer", r.answer));
    for (const row of r.results || []) {
      const box = el("div", "r");
      box.append(link(row.url, row.title, "t"), el("div", "u", row.url), el("div", "s", row.snippet));
      out.append(box);
    }
    status(`${(r.results || []).length} results${r.mode === "deep" ? " (deep)" : ""} for “${r.query}”`);
  }
  function renderImages(r) {
    const out = $("out");
    out.textContent = "";
    const grid = el("div", "grid");
    for (const img of r.images || []) {
      const a = link(img.url, "");
      a.title = img.title;
      const i = document.createElement("img");
      i.src = img.thumb;
      i.alt = img.title;
      i.loading = "lazy";
      i.referrerPolicy = "no-referrer";
      a.append(i);
      grid.append(a);
    }
    out.append(grid);
    status(`${(r.images || []).length} images for “${r.query}”`);
  }

  // ── research ──
  async function showJobs(openId) {
    const r = await api.researchList();
    if (mode !== "research") return;
    const out = $("out");
    out.textContent = "";
    const depth = el("div", "depth");
    const std = el("label");
    const deep = el("label");
    const mk = (value, checked) => {
      const i = document.createElement("input");
      i.type = "radio";
      i.name = "depth";
      i.value = value;
      i.checked = checked;
      return i;
    };
    std.append(mk("standard", true), document.createTextNode(" Standard (a few minutes)"));
    deep.append(mk("deep", false), document.createTextNode(" Deep (longer, more sources)"));
    depth.append(std, deep);
    out.append(depth);
    const list = el("div", "jobs");
    const jobs = (r && r.ok && r.jobs) || [];
    if (!jobs.length) list.append(el("div", "", "No research yet. Ask a question above."));
    for (const j of jobs) {
      const row = el("div", "job");
      row.append(el("span", "st " + j.state, j.state), el("span", "", j.question));
      if (j.error) row.title = j.error;
      row.onclick = () => void openReport(j.id);
      list.append(row);
    }
    out.append(list);
    const running = jobs.some((j) => j.state === "running");
    if (running && !poll) poll = setInterval(() => { if (mode === "research") void refreshJobs(); }, 5000);
    if (!running && poll) { clearInterval(poll); poll = null; }
    if (openId) void openReport(openId);
  }
  async function refreshJobs() {
    if (document.querySelector(".report")) return; // reading a report: leave it alone
    await showJobs();
  }
  async function openReport(id) {
    const r = await api.researchRead(id);
    if (!r || !r.ok) return status((r && r.error) || "could not read the report", true);
    if (!r.report) return status(r.job.state === "failed" ? `Failed: ${r.job.error || "unknown"}` : "Still researching…", r.job.state === "failed");
    const rep = r.report;
    const out = $("out");
    out.textContent = "";
    const box = el("div", "report");
    const back = link("#", "← All research");
    back.onclick = (e) => { e.preventDefault(); void showJobs(); };
    box.append(back, el("h2", "", rep.question || r.job.question));
    for (const c of rep.claims) {
      const p = el("p", "claim", c.text);
      if (c.sources.length) {
        const sup = el("sup");
        for (const n of c.sources) {
          const s = rep.sources[n - 1];
          if (s && s.url) sup.append(link(s.url, `[${n}]`));
        }
        p.append(sup);
      } else {
        p.append(el("span", "uns", ` (unsourced${c.unsourcedReason ? ": " + c.unsourcedReason : ""})`));
      }
      box.append(p);
    }
    box.append(el("h3", "", "Sources"));
    const ol = el("ol");
    for (const s of rep.sources) {
      const li = el("li");
      if (s.url) li.append(link(s.url, s.title));
      else li.append(document.createTextNode(s.title));
      if (s.domain) li.append(document.createTextNode(` · ${s.domain}`));
      ol.append(li);
    }
    box.append(ol);
    out.append(box);
    status(`${rep.claims.length} claims, ${rep.sources.length} sources`);
  }

  function showForge() {
    const out = $("out");
    out.textContent = "";
    const box = el("div", "forge");
    box.append(el("div", "", "Media Forge makes images, short clips, 3D models and talking avatars on the fleet's GPU. It opens in its own tab, signed in through the desk."));
    const b = el("button", "", "Open Media Forge");
    b.onclick = () => void openForge();
    box.append(b);
    out.append(box);
  }
  async function openForge() {
    status("Finding Media Forge…");
    const r = await api.openForge();
    status(r && r.ok ? `Opened ${r.url}` : (r && r.error) || "Media Forge did not answer", !(r && r.ok));
  }

  // ── This PC (universal-search.cjs via search-window.cjs) ──
  // Two phases per query: "fast" (apps, actions, screenshots, clipboard) paints
  // FAST_MS after the last key; "all" adds files (Windows Search) and agents (adk
  // discover) only once typing has paused for ALL_MS in total -- each "all" run starts
  // a powershell.exe and a Python, and main aborts the one it supersedes.
  const FAST_MS = 140;
  const ALL_MS = 500;
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  function schedulePc() {
    clearTimeout(pc.timer);
    pc.timer = setTimeout(() => void runPc($("q").value.trim()), FAST_MS);
  }
  /**
   * One query. `launchTop` (Enter before the results painted) opens the top row as
   * soon as the FAST phase has one and skips the slow phase; only when the fast phase
   * has no row does it wait for files and agents.
   */
  async function runPc(q, { launchTop = false } = {}) {
    const mine = ++seq;
    if (!q) {
      pc.groups = [];
      $("out").textContent = "";
      return status("Type to search this PC — Enter opens the top result, Tab asks Aither");
    }
    if (q !== pc.query) { pc.expanded = new Set(); pc.selected = 0; pc.query = q; }
    const fast = await api.everything(q, "fast");
    if (mine !== seq || mode !== "pc") return;
    if (fast && fast.ok) renderPc(fast, true);
    if (launchTop) {
      const first = rows()[pc.selected];
      if (first) return void launch(first.dataset.key);
    } else {
      await sleep(Math.max(0, ALL_MS - FAST_MS));
      if (mine !== seq || mode !== "pc") return;
    }
    const all = await api.everything(q, "all");
    if (mine !== seq || mode !== "pc") return;
    if (!all || !all.ok) return status((all && all.error) || (all && all.reason) || "1 search failed — try again", true);
    renderPc(all, false);
    if (launchTop) {
      const first = rows()[pc.selected];
      if (first) void launch(first.dataset.key);
    }
  }
  function rows() {
    return [...document.querySelectorAll("#out .hit")];
  }
  function select(i) {
    const list = rows();
    if (!list.length) return;
    pc.selected = Math.max(0, Math.min(list.length - 1, i));
    list.forEach((n, k) => n.setAttribute("aria-selected", String(k === pc.selected)));
    list[pc.selected].scrollIntoView({ block: "nearest" });
  }
  function renderPc(r, partial) {
    pc.groups = r.groups || [];
    const out = $("out");
    out.textContent = "";
    const problems = (r.errors || []).length;
    if (problems) {
      // "<count> <thing> — <remedy>" (ux-shape law 5): each remedy is the provider's own reason.
      out.append(el("div", "notes", `${problems} source${problems === 1 ? "" : "s"} down — `
        + r.errors.map((x) => `${x.label}: ${x.reason}`).join("; ")));
    }
    for (const n of r.notes || []) out.append(el("div", "notes", `${n.label}: ${n.note}`));
    for (const g of pc.groups) {
      const box = el("div", "grp");
      const h = el("h3", "", g.label + " ");
      h.append(el("span", "count", `· ${g.total}`));
      box.append(h);
      const open = pc.expanded.has(g.id);
      const shown = open ? g.items : g.items.slice(0, SHOW);
      for (const it of shown) {
        const row = el("div", "hit");
        row.setAttribute("role", "option");
        row.dataset.key = it.key;
        row.append(el("span", "t", it.title), el("span", "s", it.subtitle || ""));
        row.onclick = () => void launch(it.key);
        box.append(row);
      }
      const more = g.items.length - shown.length;
      if (more > 0) {
        const b = el("button", "more", `+${more} more`);
        b.type = "button";
        b.onclick = () => { pc.expanded.add(g.id); renderPc(r, partial); };
        box.append(b);
      }
      out.append(box);
    }
    if (!pc.groups.length) {
      out.append(el("div", "", partial ? "Looking in files and agents…" : `Nothing on this PC matches “${r.query}”. Tab asks Aither instead.`));
    }
    out.append(el("div", "keys", "Enter opens · ↑↓ moves · Tab asks Aither · Esc closes"));
    select(pc.selected);
    const top = rows()[pc.selected];
    const lead = top ? `Enter opens “${top.querySelector(".t").textContent}”` : "Tab asks Aither";
    status(`${lead} · ${r.total} results in ${pc.groups.length} group${pc.groups.length === 1 ? "" : "s"}`
      + `${partial ? " · still searching files and agents…" : ""}`, false);
  }
  async function launch(key) {
    const r = await api.launch(key, $("q").value.trim());
    status(r && r.ok ? `Done — ${r.did}` : (r && r.error) || "1 result did not open — search again", !(r && r.ok));
  }
  async function askAither() {
    const q = $("q").value.trim();
    if (!q) return;
    const r = await api.askAither(q);
    status(r && r.ok ? `Done — ${r.did}` : (r && r.error) || "Aither chat did not answer — open Chat from the tray", !(r && r.ok));
  }
  $("q").addEventListener("input", () => { if (mode === "pc") schedulePc(); });
  $("q").addEventListener("keydown", (e) => {
    if (mode !== "pc") return;
    if (e.key === "ArrowDown") { e.preventDefault(); select(pc.selected + 1); }
    else if (e.key === "ArrowUp") { e.preventDefault(); select(pc.selected - 1); }
    else if (e.key === "Tab" && !e.shiftKey) { e.preventDefault(); void askAither(); }
    else if (e.key === "Escape") {
      e.preventDefault();
      if (launcher) void api.hide();
      else { $("q").value = ""; void runPc(""); }
    }
  });

  $("form").onsubmit = async (e) => {
    e.preventDefault();
    const q = $("q").value.trim();
    if (mode === "forge") return void openForge();
    if (mode === "pc") {
      clearTimeout(pc.timer);
      const row = rows()[pc.selected];
      if (row && pc.query === q) return void launch(row.dataset.key);
      // Enter before the results painted: open the top row of the FAST phase (~80 ms),
      // not after Windows Search and adk discover (10-16 s measured).
      return void runPc(q, { launchTop: true });
    }
    if (!q) return;
    const mine = ++seq;
    try { history.replaceState(null, "", `?q=${encodeURIComponent(q)}`); } catch { /* fine */ }
    if (mode === "research") {
      const depthEl = document.querySelector('input[name="depth"]:checked');
      const r = await api.research(q, depthEl ? depthEl.value : "standard");
      if (!r || !r.ok) return status((r && r.error) || "could not start", true);
      status("Researching… this takes a few minutes; the list updates on its own.");
      $("q").value = "";
      return void showJobs();
    }
    status(mode === "q" ? "Searching…" : mode === "images" ? "Finding images…" : "Reading pages… (up to a couple of minutes)");
    const r = mode === "images" ? await api.images(q) : await api.search(mode, q);
    if (mine !== seq) return;
    if (!r || !r.ok) return status((r && r.error) || "search failed", true);
    if (mode === "images") renderImages(r); else renderResults(r);
  };

  // aither://search/?q=... (the address bar sends plain words here) runs at once.
  const params = new URLSearchParams(location.search);
  const start = params.get("q");
  if (launcher) {
    document.body.classList.add("launcher");
    if (api.onFocus) api.onFocus(() => { $("q").focus(); $("q").select(); });
  }
  if (params.get("mode") === "pc" || launcher) {
    setMode("pc");
    if (start) $("q").value = start;
    $("q").focus();
    if (start) schedulePc();
  } else if (start) {
    $("q").value = start;
    void $("form").requestSubmit();
  } else {
    $("q").focus();
  }
})();
