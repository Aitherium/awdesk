/* global window, document, localStorage, getComputedStyle, requestAnimationFrame, ResizeObserver, setTimeout, clearTimeout, setInterval, URLSearchParams, location, history */
/* aither://terminal -- the awsh layer's page (terminal.html). Talks only to
   window.aitherTerminal (terminal-preload.cjs); renders with the vendored xterm.js.

   ?dock=1 is the browser's bottom dock (browser-window.cjs ensureDock): the strip lists
   EVERY session the awsh daemon runs, wherever it was started, re-read every few seconds
   (terminal-dock-model.js); a click attaches and replays its stream from the start. */
(function () {
  "use strict";
  const api = window.aitherTerminal;
  const model = window.TerminalDockModel;
  const $ = (id) => document.getElementById(id);
  const query = new URLSearchParams(location.search);
  const DOCK = query.get("dock") === "1";
  // The dock and the full page are one origin: each remembers its own open tabs.
  const OPEN_KEY = DOCK ? "aither.terminal.dock.open" : "aither.terminal.open";
  /** id -> { term, fit, pane, info, seq } -- the sessions this page has attached. */
  const tabs = new Map();
  let active = null;
  /** Dock: the daemon's whole list, as last read, and whether it answered. */
  let known = [];
  let daemonUp = true;
  let dockOpen = false;

  if (DOCK) document.body.classList.add("dock");

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

  /** The strip's rows: the attached tabs, plus (docked) every session the daemon runs. */
  function stripRows() {
    if (!DOCK) return [...tabs.values()].map((t) => t.info);
    const byId = new Map(known.map((s) => [s.id, s]));
    for (const [id, t] of tabs) byId.set(id, t.info);
    return model.stripOrder([...byId.values()], tabs.keys());
  }

  function renderStrip() {
    const strip = $("strip");
    for (const el of Array.from(strip.querySelectorAll(".tab"))) el.remove();
    for (const info of stripRows()) {
      const id = info.id;
      const attached = tabs.has(id);
      const el = document.createElement("div");
      el.className = "tab" + (id === active && (dockOpen || !DOCK) ? " active" : "")
        + (info.state === "exited" ? " exited" : "") + (attached ? "" : " mirror");
      el.setAttribute("role", "tab");
      el.title = `${info.label} (${info.harness})${info.cwd ? " in " + info.cwd : ""}`
        + (attached ? "" : " -- click to attach");
      const dot = document.createElement("span");
      dot.className = "dot";
      const label = document.createElement("span");
      label.className = "t";
      label.textContent = info.label; // never innerHTML
      const x = document.createElement("button");
      x.className = "x";
      x.textContent = "×";
      x.title = info.state === "exited" ? "Close the tab" : "End the session and close the tab";
      x.onclick = (e) => { e.stopPropagation(); void closeTab(id); };
      el.append(dot, label, x);
      el.onclick = () => (DOCK ? openInDock(info) : show(id));
      el.onauxclick = (e) => { if (e.button === 1) void closeTab(id); };
      strip.insertBefore(el, $("add"));
    }
    $("empty").hidden = tabs.size > 0;
    if (DOCK) {
      $("summary").textContent = model.summary(known, { daemonUp });
      $("dock-pop").disabled = !active;
      $("dock-detach").disabled = !active;
    }
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
    const t = { term, fit, pane, info: { ...info }, seq: 0 };
    tabs.set(info.id, t);
    term.onData((data) => {
      if (t.info.state === "exited") return;
      void api.input(info.id, data).then((r) => { if (r && !r.ok) status(r.error); });
    });
    // since=0: the daemon replays the session's stream, so an attach shows its scrollback.
    void api.attach(info.id, 0);
    remember();
    show(info.id);
  }

  /** Stop showing a session here; it keeps running (and stays in the dock's strip). */
  async function detachTab(id) {
    const t = tabs.get(id);
    if (!t) return;
    await api.detach(id);
    t.term.dispose();
    t.pane.remove();
    tabs.delete(id);
    remember();
    if (active === id) {
      const next = [...tabs.keys()].pop();
      if (next) show(next); else { active = null; renderStrip(); }
    } else renderStrip();
  }

  async function closeTab(id) {
    const t = tabs.get(id);
    const info = t ? t.info : known.find((s) => s.id === id);
    if (!info) return;
    if (info.state !== "exited") await api.close(id);
    if (t) await detachTab(id);
    if (DOCK) { known = known.filter((s) => s.id !== id); renderStrip(); void refresh(); }
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

  // ── The dock: open on demand, mirror the daemon's list ─────────────────────────────
  function setDockOpen(open) {
    dockOpen = Boolean(open);
    document.body.classList.toggle("open", dockOpen);
    $("dock-toggle").textContent = dockOpen ? "\u25BE" : "\u25B4";
    $("dock-toggle").title = dockOpen ? "Close the terminal dock (Ctrl+`)" : "Open the terminal dock (Ctrl+`)";
    renderStrip();
    const t = tabs.get(active);
    if (dockOpen && t) requestAnimationFrame(() => { fitTab(t); t.term.focus(); });
  }

  async function openInDock(info) {
    if (!dockOpen) await api.dock("open");
    addTab(info);
  }

  async function refresh() {
    const l = await api.list();
    daemonUp = Boolean(l && l.ok);
    if (!daemonUp) return renderStrip();
    const next = l.sessions || [];
    const diff = model.diffSessions(known, next);
    known = next;
    // A session that ended elsewhere (the CLI, another window) ends here too.
    for (const s of next) {
      const t = tabs.get(s.id);
      if (t && s.state === "exited") t.info.state = "exited";
    }
    if (!diff.same) renderStrip();
    else $("summary").textContent = model.summary(known, { daemonUp });
  }

  // The "+ New" menu: start a harness (optionally in a folder), attach a running session,
  // or resume a Claude Code tab the daemon discovered elsewhere.
  async function openMenu() {
    const menu = $("menu");
    if (!menu.hidden) { menu.hidden = true; return; }
    if (DOCK && !dockOpen) await api.dock("open");
    menu.textContent = "";
    const head = (text) => { const h = document.createElement("div"); h.className = "h"; h.textContent = text; menu.append(h); };
    const item = (text, sub, onclick) => {
      const b = document.createElement("button");
      b.textContent = text;
      if (sub) {
        const s = document.createElement("span");
        s.className = "sub";
        s.textContent = sub;
        b.append(s);
      }
      b.onclick = () => { menu.hidden = true; void onclick(); };
      menu.append(b);
    };
    const cwd = document.createElement("input");
    cwd.placeholder = "Folder (optional), e.g. C:\\Projects\\my-app";
    cwd.spellcheck = false;
    head("Start");
    menu.append(cwd);
    const [h, l, x] = await Promise.all([api.harnesses(), api.list(), api.external()]);
    if (!h || !h.ok) {
      head(h && h.error ? h.error : "The awsh daemon did not answer.");
    } else {
      for (const harness of h.harnesses) {
        item(harness.label, "", async () => {
          status("Starting " + harness.label + "…");
          const r = await api.create({ harness: harness.id, cwd: cwd.value.trim(), rows: 30, cols: 100 });
          if (!r || !r.ok) return status((r && r.error) || "could not start");
          status("");
          addTab(r.session);
          if (DOCK) void refresh();
        });
      }
    }
    const sessions = l && l.ok ? l.sessions : [];
    const running = sessions.filter((s) => s.state !== "exited" && !tabs.has(s.id));
    if (running.length) {
      head("Running sessions");
      for (const s of running.slice(0, 12)) item(s.label, s.harness + (s.cwd ? " · " + s.cwd : ""), () => addTab(s));
    }
    // A Claude Code tab running in Windows Terminal or an IDE: its pty is not the
    // daemon's, so it cannot be mirrored -- only resumed as a new daemon session.
    const resumable = x && x.ok ? model.resumeChoices(x.sessions, sessions) : [];
    if (resumable.length) {
      head("Claude Code tabs elsewhere");
      for (const s of resumable) {
        item("Resume " + s.label, (s.status ? s.status + " · " : "") + s.cwd, async () => {
          status("Resuming " + s.label + "…");
          const r = await api.resume(s.id, s.cwd);
          if (!r || !r.ok) return status((r && r.error) || "could not resume");
          status("");
          addTab(r.session);
          if (DOCK) void refresh();
        });
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

  // aither://terminal/?harness=claude&cwd=C:\\repo (Projects' "here" links) starts that
  // session once; ?attach=<id> (the dock's "pop out") shows a running one. Either way
  // the query is dropped so a reload does not start or attach a second time.
  async function startFromQuery() {
    const harness = query.get("harness");
    const attach = query.get("attach");
    if (!harness && !attach) return;
    try { history.replaceState(null, "", location.pathname); } catch { /* fine */ }
    if (attach) {
      const l = await api.list();
      const s = ((l && l.ok && l.sessions) || []).find((row) => row.id === attach);
      if (s) addTab(s); else status("That session is no longer running.");
      return;
    }
    status("Starting " + harness + "\u2026");
    const r = await api.create({ harness, cwd: query.get("cwd") || "", rows: 30, cols: 100 });
    if (!r || !r.ok) return status((r && r.error) || "could not start");
    status("");
    addTab(r.session);
  }

  if (DOCK) {
    $("dock-toggle").onclick = () => void api.dock("toggle");
    $("dock-pop").onclick = () => {
      const id = active;
      if (!id) return;
      // The full terminal tab attaches it (replaying its stream); the dock lets go.
      void api.dock("popout", id).then((r) => {
        if (r && r.ok) void detachTab(id); else status((r && r.error) || "could not pop out");
      });
    };
    $("dock-detach").onclick = () => { if (active) void detachTab(active); };
    // A double click on the empty strip opens or closes the dock, like a title bar.
    $("strip").addEventListener("dblclick", (e) => { if (e.target === $("strip")) void api.dock("toggle"); });
    api.onDockState((s) => setDockOpen(s.open));
    void api.dock("state").then((s) => setDockOpen(Boolean(s && s.open)));
    setInterval(() => void refresh(), model.POLL_MS);
  }

  // Reopen the tabs this page had, if their sessions are still known to the daemon.
  (async () => {
    await startFromQuery();
    const want = remembered();
    const l = await api.list();
    if (DOCK) { daemonUp = Boolean(l && l.ok); known = (l && l.ok && l.sessions) || []; }
    const byId = new Map(((l && l.ok && l.sessions) || []).map((s) => [s.id, s]));
    for (const id of want) if (byId.has(id) && !tabs.has(id)) addTab(byId.get(id));
    renderStrip();
  })();
})();
