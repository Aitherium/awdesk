/* global window, document, localStorage, getComputedStyle, requestAnimationFrame, ResizeObserver, setTimeout, clearTimeout, URLSearchParams, location, history */
/* aither://terminal -- the awsh layer's page (terminal.html). Talks only to
   window.aitherTerminal (terminal-preload.cjs); renders with the vendored xterm.js. */
(function () {
  "use strict";
  const api = window.aitherTerminal;
  const $ = (id) => document.getElementById(id);
  const OPEN_KEY = "aither.terminal.open";
  /** id -> { term, fit, pane, tabEl, info, seq } */
  const tabs = new Map();
  let active = null;

  function status(text) {
    $("status").textContent = text || "";
  }
  function remember() {
    try { localStorage.setItem(OPEN_KEY, JSON.stringify([...tabs.keys()])); } catch { /* private storage */ }
  }
  function remembered() {
    try { return JSON.parse(localStorage.getItem(OPEN_KEY) || "[]").filter((x) => typeof x === "string"); } catch { return []; }
  }

  function theme() {
    const css = getComputedStyle(document.documentElement);
    const v = (name, fallback) => (css.getPropertyValue(name) || "").trim() || fallback;
    return { background: "#0b0d12", foreground: v("--fg", "#e6e6e6"), cursor: v("--primary", "#7cd"),
      selectionBackground: "rgba(120,200,220,.3)" };
  }

  function renderStrip() {
    const strip = $("strip");
    for (const el of Array.from(strip.querySelectorAll(".tab"))) el.remove();
    for (const [id, t] of tabs) {
      const el = document.createElement("div");
      el.className = "tab" + (id === active ? " active" : "") + (t.info.state === "exited" ? " exited" : "");
      el.setAttribute("role", "tab");
      el.title = `${t.info.label} (${t.info.harness})${t.info.cwd ? " in " + t.info.cwd : ""}`;
      const dot = document.createElement("span");
      dot.className = "dot";
      const label = document.createElement("span");
      label.className = "t";
      label.textContent = t.info.label; // never innerHTML
      const x = document.createElement("button");
      x.className = "x";
      x.textContent = "×";
      x.title = t.info.state === "exited" ? "Close the tab" : "End the session and close the tab";
      x.onclick = (e) => { e.stopPropagation(); void closeTab(id); };
      el.append(dot, label, x);
      el.onclick = () => show(id);
      el.onauxclick = (e) => { if (e.button === 1) void closeTab(id); };
      strip.insertBefore(el, $("add"));
    }
    $("empty").hidden = tabs.size > 0;
  }

  function fitTab(t) {
    try {
      t.fit.fit();
      void api.resize(t.info.id, t.term.rows, t.term.cols);
    } catch { /* a hidden pane has no size yet */ }
  }

  function show(id) {
    active = id;
    for (const [tid, t] of tabs) t.pane.hidden = tid !== id;
    renderStrip();
    const t = tabs.get(id);
    if (t) {
      requestAnimationFrame(() => { fitTab(t); t.term.focus(); });
    }
  }

  function addTab(info) {
    if (tabs.has(info.id)) return show(info.id);
    const pane = document.createElement("div");
    pane.className = "pane";
    pane.hidden = true;
    $("panes").appendChild(pane);
    const term = new window.Terminal({ fontFamily: "Cascadia Mono, Consolas, monospace", fontSize: 13,
      cursorBlink: true, scrollback: 10000, allowProposedApi: false, theme: theme() });
    const fit = new window.FitAddon.FitAddon();
    term.loadAddon(fit);
    term.open(pane);
    const t = { term, fit, pane, info, seq: 0 };
    tabs.set(info.id, t);
    term.onData((data) => {
      if (t.info.state === "exited") return;
      void api.input(info.id, data).then((r) => { if (r && !r.ok) status(r.error); });
    });
    void api.attach(info.id, 0);
    remember();
    show(info.id);
  }

  async function closeTab(id) {
    const t = tabs.get(id);
    if (!t) return;
    if (t.info.state !== "exited") await api.close(id);
    else await api.detach(id);
    t.term.dispose();
    t.pane.remove();
    tabs.delete(id);
    remember();
    if (active === id) {
      const next = [...tabs.keys()].pop();
      if (next) show(next); else { active = null; renderStrip(); }
    } else renderStrip();
  }

  api.onEvent((id, payload) => {
    const t = tabs.get(id);
    if (!t || !payload) return;
    if (payload.type === "end") {
      if (t.info.state !== "exited" && payload.error) status(`${t.info.label}: ${payload.error}`);
      return;
    }
    const ev = payload.event || {};
    if (Number(ev.seq) <= t.seq) return; // a re-attach replays; write each event once
    t.seq = Number(ev.seq) || t.seq;
    if (ev.kind === "text.delta" && ev.text) t.term.write(ev.text);
    else if (ev.kind === "session.exited") {
      t.info.state = "exited";
      const code = ev.data && ev.data.exit_code != null ? ev.data.exit_code : "";
      t.term.write(`\r\n\x1b[2m[session ended${code !== "" ? `, exit ${code}` : ""}]\x1b[0m\r\n`);
      renderStrip();
    } else if (ev.kind === "session.error" && ev.text) {
      t.term.write(`\r\n\x1b[31m${ev.text}\x1b[0m\r\n`);
    }
  });

  // The "+ New" menu: start a harness (optionally in a folder), or attach a running session.
  async function openMenu() {
    const menu = $("menu");
    if (!menu.hidden) { menu.hidden = true; return; }
    menu.textContent = "";
    const head = (text) => { const h = document.createElement("div"); h.className = "h"; h.textContent = text; menu.append(h); };
    const cwd = document.createElement("input");
    cwd.placeholder = "Folder (optional), e.g. C:\\Projects\\my-app";
    cwd.spellcheck = false;
    head("Start");
    menu.append(cwd);
    const [h, l] = await Promise.all([api.harnesses(), api.list()]);
    if (!h || !h.ok) {
      head(h && h.error ? h.error : "The awsh daemon did not answer.");
    } else {
      for (const harness of h.harnesses) {
        const b = document.createElement("button");
        b.textContent = harness.label;
        b.onclick = async () => {
          menu.hidden = true;
          status("Starting " + harness.label + "…");
          const r = await api.create({ harness: harness.id, cwd: cwd.value.trim(), rows: 30, cols: 100 });
          if (!r || !r.ok) return status((r && r.error) || "could not start");
          status("");
          addTab(r.session);
        };
        menu.append(b);
      }
    }
    const running = l && l.ok ? l.sessions.filter((s) => s.state !== "exited" && !tabs.has(s.id)) : [];
    if (running.length) {
      head("Running sessions");
      for (const s of running.slice(0, 12)) {
        const b = document.createElement("button");
        b.textContent = s.label;
        const sub = document.createElement("span");
        sub.className = "sub";
        sub.textContent = s.harness + (s.cwd ? " · " + s.cwd : "");
        b.append(sub);
        b.onclick = () => { menu.hidden = true; addTab(s); };
        menu.append(b);
      }
    }
    menu.hidden = false;
    cwd.focus();
  }
  $("add").onclick = () => void openMenu();
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") $("menu").hidden = true; });
  document.addEventListener("mousedown", (e) => {
    if (!$("menu").hidden && !$("menu").contains(e.target) && e.target !== $("add")) $("menu").hidden = true;
  });

  let resizeTimer = null;
  new ResizeObserver(() => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => { const t = tabs.get(active); if (t) fitTab(t); }, 80);
  }).observe($("panes"));

  // aither://terminal/?harness=claude&cwd=C:\\repo (Projects' "here" links): start that
  // session once, then drop the query so a reload does not start a second one.
  async function startFromQuery() {
    const q = new URLSearchParams(location.search);
    const harness = q.get("harness");
    if (!harness) return;
    try { history.replaceState(null, "", location.pathname); } catch { /* fine */ }
    status("Starting " + harness + "\u2026");
    const r = await api.create({ harness, cwd: q.get("cwd") || "", rows: 30, cols: 100 });
    if (!r || !r.ok) return status((r && r.error) || "could not start");
    status("");
    addTab(r.session);
  }

  // Reopen the tabs this page had, if their sessions are still known to the daemon.
  (async () => {
    await startFromQuery();
    const want = remembered();
    if (!want.length) return renderStrip();
    const l = await api.list();
    const known = new Map(((l && l.ok && l.sessions) || []).map((s) => [s.id, s]));
    for (const id of want) if (known.has(id)) addTab(known.get(id));
    renderStrip();
  })();
})();
