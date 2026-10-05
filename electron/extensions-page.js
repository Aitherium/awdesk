/* global window, document */
/* aither://extensions -- renders extensions-window.cjs through window.aitherExtensions. Text only. */
(function () {
  "use strict";
  const api = window.aitherExtensions;
  const $ = (id) => document.getElementById(id);
  const el = (tag, cls, text) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = String(text);
    return n;
  };
  function status(text, err) { $("status").textContent = text || ""; $("status").className = err ? "err" : ""; }

  async function load() {
    const r = await api.list();
    const list = $("list");
    list.textContent = "";
    if (!r || !r.ok) return status((r && r.error) || "could not list extensions", true);
    if (!r.extensions.length) list.append(el("div", "sub", "No extensions are loaded."));
    for (const x of r.extensions) {
      const box = el("div", "x");
      const top = el("div", "top");
      top.append(el("span", "name", x.name), el("span", "ver", x.version));
      if (x.builtin) top.append(el("span", "tag", "built in"));
      else if (x.added) top.append(el("span", "tag", "added by you"));
      const acts = el("div", "acts");
      if (x.hasUi) {
        const o = el("button", "", "Open");
        o.onclick = async () => { const res = await api.open(x.id); if (!res || !res.ok) status((res && res.error) || "could not open", true); };
        acts.append(o);
      }
      if (!x.builtin) {
        const rm = el("button", "", "Remove");
        rm.onclick = async () => {
          const res = await api.remove(x.id);
          if (!res || !res.ok) return status((res && res.error) || "not removed", true);
          status(`Removed ${x.name}.`);
          void load();
        };
        acts.append(rm);
      }
      box.append(top, el("div", "desc", x.description), el("div", "path", x.path), acts);
      list.append(box);
    }
    if (!$("status").classList.contains("err")) status(`${r.extensions.length} extension(s)`);
  }

  async function loadPlugins() {
    const box = $("plugins");
    box.textContent = "";
    const r = await api.pluginStatus();
    if (!r || !r.ok) { box.append(el("div", "sub", (r && r.error) || "plugin status unavailable")); return; }
    const p = r.plugin;
    const x = el("div", "x");
    const top = el("div", "top");
    top.append(el("span", "name", p.name), el("span", "ver", p.version || "not installed"));
    top.append(el("span", "tag", p.active ? "active" : "not active"));
    if (p.stale) top.append(el("span", "tag", `update: ${p.source}`));
    const facts = el("div", "desc", `${p.installed ? "Installed" : "Not installed"} · function hooks ${p.hooks ? "on" : "off"}. ${p.note}`);
    const acts = el("div", "acts");
    if (!p.installed || p.stale || !p.active) {
      const b = el("button", "", p.installed ? "Update / repair" : "Install");
      b.onclick = async () => {
        status("Installing the awsh plugin\u2026");
        const res = await api.pluginInstall();
        status(res && res.ok ? "Done. Restart Claude Code to load it." : (res && res.error) || "not installed", !(res && res.ok));
        void loadPlugins();
      };
      acts.append(b);
    }
    x.append(top, facts, acts);
    box.append(x);
  }
  void loadPlugins();

  $("add").onclick = async () => {
    status("Choose a folder…");
    const r = await api.add();
    if (r && r.cancelled) return status("");
    if (!r || !r.ok) return status((r && r.error) || "not added", true);
    status(`Added ${r.name}.`);
    void load();
  };
  $("refresh").onclick = () => void load();
  void load();
})();
