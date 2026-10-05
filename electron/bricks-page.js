/* global window, document */
/* aither://bricks -- the awkno catalog joined with what is installed (adk bricks), through
   window.aitherBricks (bricks-preload.cjs). Text only. */
(function () {
  "use strict";
  const api = window.aitherBricks;
  const $ = (id) => document.getElementById(id);
  let items = [];
  /** id -> {installed, latest, outdated, editable, action} from `adk bricks list` */
  let installed = new Map();
  let filter = "all";
  let skills = null; // [{name, description, source, path}] once Skills is opened
  let packs = null; // awpack list, once Packs is opened

  function renderPacks(q) {
    const list = $("list");
    list.textContent = "";
    if (!packs) { $("status").textContent = "Reading packs\u2026"; return; }
    for (const p of packs) {
      if (q && !(p.id.includes(q) || p.summary.toLowerCase().includes(q))) continue;
      const row = el("div", "b" + (p.id === current ? " on" : ""));
      row.append(el("span", "dot in"), el("span", "n", p.id), el("span", "s", `${p.version} ${p.status} \u00b7 ${p.summary}`));
      row.onclick = () => void openPack(p);
      list.append(row);
    }
    $("status").textContent = `${packs.length} first-party packs (awpack)`;
  }

  async function openPack(p) {
    current = p.id;
    renderPacks($("q").value.trim().toLowerCase());
    const head = $("head");
    head.textContent = "";
    head.append(el("b", "", `${p.id} ${p.version}`), el("div", "act", p.summary));
    const acts = el("div", "acts");
    for (const [verb, label] of [["install", "Install"], ["verify", "Verify"], ["remove", "Remove"]]) {
      const b = el("button", "", label);
      b.onclick = async () => {
        b.disabled = true;
        const r = await api.packAct(verb, p.id);
        head.append(el("div", "act", r && r.ok ? `${label}: done${r.data && r.data.detail ? " \u2014 " + r.data.detail : ""}` : `${label}: ${(r && r.error) || "failed"}`));
        b.disabled = false;
      };
      acts.append(b);
    }
    head.append(acts);
    const r = await api.packAct("show", p.id);
    $("page").textContent = r && r.ok ? JSON.stringify(r.data, null, 2) : (r && r.error) || "no details";
  }
  let current = "";
  const el = (tag, cls, text) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = String(text);
    return n;
  };
  const isBrick = (it) => it.section === "bricks";
  const info = (name) => installed.get(name) || null;

  function renderSkills(q) {
    const list = $("list");
    list.textContent = "";
    if (!skills) { $("status").textContent = "Reading skills\u2026"; return; }
    let lastSource = "";
    let shown = 0;
    for (const s of skills) {
      if (q && !(s.name.toLowerCase().includes(q) || s.description.toLowerCase().includes(q))) continue;
      if (s.source !== lastSource) { list.append(el("div", "sec", s.source)); lastSource = s.source; }
      const row = el("div", "b" + (s.path === current ? " on" : ""));
      row.append(el("span", "dot in"), el("span", "n", s.name), el("span", "s", s.description));
      row.onclick = async () => {
        current = s.path;
        renderSkills(q);
        $("head").textContent = "";
        $("head").append(el("b", "", s.name), el("div", "act", s.path));
        $("page").textContent = "Reading\u2026";
        const r = await api.skill(s.path);
        $("page").textContent = r && r.ok ? r.text : (r && r.error) || "unreadable";
      };
      list.append(row);
      shown++;
    }
    $("status").textContent = `${shown} of ${skills.length} skills`;
  }

  function render() {
    const q = $("q").value.trim().toLowerCase();
    if (filter === "skills") return renderSkills(q);
    if (filter === "packs") return renderPacks(q);
    const list = $("list");
    list.textContent = "";
    let lastSection = "";
    let shown = 0;
    for (const it of items) {
      const inst = info(it.name);
      if (filter !== "all" && !isBrick(it)) continue;
      if (filter === "installed" && !inst) continue;
      if (filter === "missing" && inst) continue;
      if (filter === "outdated" && !(inst && inst.outdated)) continue;
      if (q && !(it.name.includes(q) || it.summary.toLowerCase().includes(q))) continue;
      if (it.section !== lastSection) { list.append(el("div", "sec", it.section)); lastSection = it.section; }
      const row = el("div", "b" + (it.name === current ? " on" : ""));
      const dot = el("span", "dot" + (inst ? " in" : ""));
      dot.title = !isBrick(it) ? "" : inst ? `installed ${inst.installed}${inst.outdated ? `, ${inst.latest} available` : ""}` : "not installed here";
      row.append(dot, el("span", "n", it.name), el("span", "s", inst && inst.outdated ? `update ${inst.latest} · ${it.summary}` : it.summary));
      row.onclick = () => void open(it.name);
      list.append(row);
      shown++;
    }
    const bricks = items.filter(isBrick);
    const have = bricks.filter((b) => info(b.name)).length;
    const old = bricks.filter((b) => info(b.name) && info(b.name).outdated).length;
    $("status").textContent = `${shown} shown · ${have} of ${bricks.length} bricks installed · ${old} with an update`;
  }

  async function open(name) {
    current = name;
    render();
    const head = $("head");
    head.textContent = "";
    const inst = info(name);
    if (inst) {
      head.append(el("b", "", `${name} ${inst.installed}`),
        document.createTextNode(inst.outdated ? ` · ${inst.latest} available` : " · up to date"));
      if (inst.action) head.append(el("div", "act", inst.action));
      const acts = el("div", "acts");
      const verb = (v, label) => {
        const b = el("button", "", label);
        b.onclick = async () => {
          b.disabled = true;
          head.append(el("div", "act", `${label}…`));
          const r = await api.act(v, name);
          head.append(el("div", "act", r && r.ok ? `${label}: done` : `${label}: ${(r && r.error) || "failed"}`));
          await loadInstalled();
          b.disabled = false;
        };
        acts.append(b);
      };
      if (inst.outdated && !inst.editable) verb("upgrade", "Upgrade");
      verb("test", "Test");
      head.append(acts);
    }
    $("page").textContent = "Reading…";
    const r = await api.page(name);
    $("page").textContent = r && r.ok ? r.text : (r && r.error) || "no page";
  }

  async function loadInstalled() {
    const r = await api.installed();
    const rows = r && r.ok && Array.isArray(r.data) ? r.data : [];
    installed = new Map(rows.filter((b) => b && b.id && b.installed).map((b) => [b.id, b]));
    render();
  }

  for (const b of document.querySelectorAll(".filters button")) {
    b.onclick = () => {
      filter = b.dataset.f;
      for (const x of document.querySelectorAll(".filters button")) x.setAttribute("aria-pressed", String(x === b));
      if (filter === "packs" && !packs) {
        void api.packs().then((r) => { packs = r && r.ok ? r.packs : []; render(); });
      }
      if (filter === "skills" && !skills) {
        void api.skills().then((r) => { skills = r && r.ok ? r.skills : []; render(); });
      }
      render();
    };
  }
  $("q").oninput = render;
  (async () => {
    const r = await api.list();
    if (!r || !r.ok) { $("status").textContent = (r && r.error) || "could not read the catalog"; $("status").className = "err"; return; }
    items = r.items;
    render();
    void loadInstalled();
  })();
})();
