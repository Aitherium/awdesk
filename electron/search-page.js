/* global window, document, URLSearchParams, setInterval, clearInterval, location, history */
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
    $("go").textContent = mode === "research" ? "Research" : mode === "forge" ? "Open Media Forge" : "Search";
    $("q").placeholder = mode === "research" ? "Ask a research question; you get a report where every claim cites its sources"
      : mode === "forge" ? "Media Forge opens in its own tab" : "Search the web and the platform";
    clearInterval(poll);
    poll = null;
    $("out").textContent = "";
    status("");
    if (mode === "research") void showJobs();
    if (mode === "forge") showForge();
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

  $("form").onsubmit = async (e) => {
    e.preventDefault();
    const q = $("q").value.trim();
    if (mode === "forge") return void openForge();
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
  const start = new URLSearchParams(location.search).get("q");
  if (start) {
    $("q").value = start;
    void $("form").requestSubmit();
  } else {
    $("q").focus();
  }
})();
