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
    facts.append(chip("reading…"));
    const prLine = el("div", "pr");
    const acts = el("div", "acts");
    acts.append(termLink("Shell here", "terminal", p.dir), termLink("Claude Code here", "claude", p.dir),
      termLink("Aither here", "aither", p.dir));
    box.append(top, facts, prLine, acts);
    void (async () => {
      const s = await api.state(p.dir);
      facts.textContent = "";
      if (!s || !s.ok) { facts.append(chip((s && s.error) || "no state", "bad")); return; }
      facts.append(chip(s.detached ? "detached HEAD" : s.branch || "?"));
      facts.append(s.dirty ? chip(`${s.dirty} changed`, "warn") : chip("clean", "ok"));
      if (s.ahead) facts.append(chip(`${s.ahead} ahead`, "warn"));
      if (s.behind) facts.append(chip(`${s.behind} behind`, "warn"));
      if (s.merging) facts.append(chip("merging", "bad"));
      if (s.conflicts) facts.append(chip(`${s.conflicts} conflicts`, "bad"));
      if (!s.pr) { prLine.textContent = "No open PR for this branch."; return; }
      prLine.textContent = `PR #${s.pr}: reading…`;
      const pr = await api.pr(p.dir, s.pr);
      prLine.textContent = "";
      if (!pr || !pr.ok) { prLine.textContent = `PR #${s.pr}: ${(pr && pr.error) || "unreadable"}`; return; }
      const a = el("a", "", `#${pr.number} ${pr.title}`);
      if (pr.url) a.href = pr.url;
      prLine.append(a, document.createTextNode(pr.draft ? " (draft) " : " "));
      const c = pr.checks;
      const kind = c.verdict === "green" ? "ok" : c.verdict === "failing" ? "bad" : "warn";
      prLine.append(chip(c.verdict === "none" ? "no checks" : `CI ${c.verdict}: ${c.pass} pass, ${c.fail} fail, ${c.pending} running`, kind));
      if (c.failing.length) prLine.append(document.createTextNode(` failing: ${c.failing.slice(0, 4).join(", ")}`));
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
