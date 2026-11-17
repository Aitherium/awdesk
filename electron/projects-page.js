/* global window, document */
/* aither://projects -- renders projects-client.cjs through window.aitherProjects
   (projects-preload.cjs). Text only (textContent); PR links are https only (main). */
(function () {
  "use strict";
  const api = window.aitherProjects;
  const $ = (id) => document.getElementById(id);
  const el = (tag, cls, text) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = String(text);
    return n;
  };
  const chip = (text, kind) => el("span", "chip" + (kind ? " " + kind : ""), text);
  function status(text, err) { $("status").textContent = text || ""; $("status").className = err ? "err" : ""; }

  /** An aither:// link: the internal tab opens Terminal in this browser (same-scheme navigation). */
  function termLink(label, harness, dir) {
    const a = el("a", "", label);
    a.href = `aither://terminal/?harness=${encodeURIComponent(harness)}&cwd=${encodeURIComponent(dir)}`;
    a.target = "_blank"; // a new tab beside this one (browser-window wirePage: aither -> aither)
    return a;
  }

  /** How old a shown result is. */
  function ago(ms) {
    const s = Math.max(0, Math.round((Number(ms) || 0) / 1000));
    if (s < 45) return "just now";
    const m = Math.round(s / 60);
    if (m < 60) return `${m} min ago`;
    const h = Math.round(m / 60);
    return h < 48 ? `${h} h ago` : `${Math.round(h / 24)} d ago`;
  }

  /** A bridge call that never throws (an older main may not have `cached` / `cachedPr`). */
  async function ask(name, ...args) {
    if (!api || typeof api[name] !== "function") return null;
    try { return await api[name](...args); } catch (error) { return { ok: false, error: String((error && error.message) || error) }; }
  }

  /** The repo's facts as chips, then one dashed note saying how fresh they are. A `partial`
   *  state (branch from .git/HEAD, never read yet) says what is still being counted. */
  function showFacts(facts, s, note) {
    facts.textContent = "";
    facts.append(chip(s.detached ? "detached HEAD" : s.branch || "?"));
    if (s.partial) {
      facts.append(chip("counting changes…", "note"));
    } else {
      facts.append(s.dirty ? chip(`${s.dirty} changed`, "warn") : chip("clean", "ok"));
      if (s.ahead) facts.append(chip(`${s.ahead} ahead`, "warn"));
      if (s.behind) facts.append(chip(`${s.behind} behind`, "warn"));
      if (s.merging) facts.append(chip("merging", "bad"));
      if (s.conflicts) facts.append(chip(`${s.conflicts} conflicts`, "bad"));
    }
    if (note) facts.append(chip(note.text, "note" + (note.kind ? " " + note.kind : "")));
  }

  function showPr(prLine, pr, note) {
    prLine.textContent = "";
    const a = el("a", "", `#${pr.number} ${pr.title}`);
    if (pr.url) a.href = pr.url;
    prLine.append(a, document.createTextNode(pr.draft ? " (draft) " : " "));
    const c = pr.checks || { verdict: "none", failing: [] };
    const kind = c.verdict === "green" ? "ok" : c.verdict === "failing" ? "bad" : "warn";
    prLine.append(chip(c.verdict === "none" ? "no checks" : `CI ${c.verdict}: ${c.pass} pass, ${c.fail} fail, ${c.pending} running`, kind));
    if (c.failing && c.failing.length) prLine.append(document.createTextNode(` failing: ${c.failing.slice(0, 4).join(", ")}`));
    if (note) prLine.append(document.createTextNode(" "), chip(note.text, "note" + (note.kind ? " " + note.kind : "")));
  }

  async function card(p) {
    const box = el("div", "p");
    const top = el("div", "top");
    top.append(el("span", "name", p.name), el("span", "dir", p.dir));
    if (p.pinned) {
      const rm = el("button", "", "Remove");
      rm.onclick = async () => { await api.remove(p.dir); void load(); };
      top.append(rm);
    }
    const facts = el("div", "facts");
    facts.append(chip("checking git status…", "note"));
    const prLine = el("div", "pr");
    const acts = el("div", "acts");
    acts.append(termLink("Shell here", "terminal", p.dir), termLink("Claude Code here", "claude", p.dir),
      termLink("Aither here", "aither", p.dir));
    box.append(top, facts, prLine, acts);

    // The PR line: the last read at once, then (fresh) the new one. `gen` keeps a slow,
    // older answer from painting over a newer one.
    let gen = 0;
    async function prFor(n, fresh) {
      const mine = ++gen;
      if (!n) { prLine.textContent = "No open PR for this branch."; return; }
      const last = await ask("cachedPr", p.dir, n);
      if (mine !== gen) return;
      if (last && last.ok) showPr(prLine, last, { text: `as of ${ago(last.ageMs)}${fresh ? " · refreshing…" : ""}` });
      else prLine.textContent = `PR #${n}: checking its CI…`;
      if (!fresh) return;
      const pr = await ask("pr", p.dir, n);
      if (mine !== gen) return;
      if (pr && pr.ok) showPr(prLine, pr, null);
      else if (last && last.ok) showPr(prLine, last, { text: `${(pr && pr.error) || "unreadable"} · showing ${ago(last.ageMs)}`, kind: "warn" });
      else prLine.textContent = `PR #${n}: ${(pr && pr.error) || "unreadable"}`;
    }

    void (async () => {
      // 1. The last result, at once: nothing runs to answer it.
      const last = await ask("cached", p.dir);
      if (last && last.ok) {
        showFacts(facts, last, last.partial ? null : { text: `as of ${ago(last.ageMs)} · refreshing…` });
        if (!last.partial) void prFor(last.pr, false);
      }
      // 2. The fresh read, in the background (main bounds it with a timeout).
      const s = await ask("state", p.dir);
      if (s && s.ok) { showFacts(facts, s, null); await prFor(s.pr, true); return; }
      const why = (s && s.error) || "no state";
      const keep = (s && s.last) || (last && last.ok && !last.partial ? last : null);
      if (!keep) { facts.textContent = ""; facts.append(chip(why, "bad")); return; }
      showFacts(facts, keep, { text: `${why} · showing ${ago(keep.ageMs)}`, kind: "warn" });
      await prFor(keep.pr, true);
    })();
    return box;
  }

  async function load() {
    status("Finding your repositories…");
    const r = await api.list();
    const list = $("list");
    list.textContent = "";
    if (!r || !r.ok) return status((r && r.error) || "could not list projects", true);
    if (!r.projects.length) {
      list.append(el("div", "empty", "No repositories yet. Add a folder above, or start an awsh session in one."));
      return status("");
    }
    for (const p of r.projects) list.append(await card(p));
    status(`${r.projects.length} repositories`);
  }

  $("form").onsubmit = async (e) => {
    e.preventDefault();
    const dir = $("dir").value.trim();
    if (!dir) return;
    const r = await api.add(dir);
    if (!r || !r.ok) return status((r && r.error) || "not added", true);
    $("dir").value = "";
    void load();
  };
  $("refresh").onclick = () => void load();
  void load();
})();
