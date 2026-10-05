/* global window, document, setInterval */
/* aither://windows -- renders window-manager.cjs through window.aitherWindows. Text only. */
(function () {
  "use strict";
  const api = window.aitherWindows;
  const $ = (id) => document.getElementById(id);
  const el = (tag, cls, text) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = String(text);
    return n;
  };
  function status(text, err) { $("status").textContent = text || ""; $("status").className = err ? "err" : ""; }
  async function act(p, done) {
    const r = await p;
    if (!r || !r.ok) status((r && r.error) || "did not work", true);
    else status(done || "");
    void load();
  }

  async function load() {
    const s = await api.state();
    if (!s || !s.ok) return status((s && s.error) || "could not read the windows", true);
    const map = $("map");
    map.textContent = "";
    for (const d of s.displays) {
      const m = el("div", "mon");
      const scale = 60 / Math.max(1, d.workArea.height);
      m.style.width = `${Math.max(60, Math.round(d.workArea.width * scale))}px`;
      m.append(el("b", "", d.label + (d.primary ? " · primary" : "")), el("div", "", `${d.size.width}×${d.size.height}`));
      map.append(m);
    }
    const list = $("list");
    list.textContent = "";
    for (const w of s.windows) {
      const row = el("div", "w" + (w.shown ? "" : " hidden"));
      const t = el("span", "t", w.title);
      t.append(el("div", "k", w.key));
      const pick = document.createElement("select");
      pick.setAttribute("aria-label", `Monitor for ${w.title}`);
      for (const d of s.displays) {
        const o = document.createElement("option");
        o.value = String(d.id);
        o.textContent = d.label + (d.primary ? " (primary)" : "");
        o.selected = d.id === w.displayId;
        pick.append(o);
      }
      pick.onchange = () => act(api.move(w.key, Number(pick.value)), `Moved ${w.title}.`);
      const vis = el("button", "", w.shown ? "Hide" : "Show");
      vis.onclick = () => act(w.shown ? api.hide(w.key) : api.show(w.key));
      const top = el("button", w.onTop ? "on" : "", w.onTop ? "Pinned on top" : "Pin on top");
      top.onclick = () => act(api.onTop(w.key, !w.onTop));
      row.append(t, pick, vis, top);
      list.append(row);
    }
    const lay = $("layouts");
    lay.textContent = "";
    if (!s.layouts.length) lay.append(el("div", "sub", "No arrangements saved yet."));
    for (const l of s.layouts) {
      const row = el("div", "w");
      row.append(el("span", "t", `${l.name} · ${l.windows} windows`));
      const r = el("button", "", "Restore");
      r.onclick = () => act(api.restore(l.name), `Restored ${l.name}.`);
      const x = el("button", "", "Delete");
      x.onclick = () => act(api.remove(l.name), `Deleted ${l.name}.`);
      row.append(r, x);
      lay.append(row);
    }
  }

  $("save").onclick = () => {
    const name = $("name").value.trim();
    if (!name) return status("Name the arrangement first.", true);
    $("name").value = "";
    void act(api.save(name), `Saved ${name}.`);
  };
  void load();
  setInterval(() => { if (!document.hidden) void load(); }, 4000);
})();
