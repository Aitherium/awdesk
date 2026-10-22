/* global window, document, setTimeout, setInterval */
"use strict";

/* aither://local-ai -- page script. Everything comes from window.aitherLocalAi
   (local-ai-preload.cjs -> local-ai-window.cjs -> local-ai.cjs -> adk bonsai-local). */
(() => {
  const api = window.aitherLocalAi;
  const $ = (id) => document.getElementById(id);
  const gb = (bytes) => `${(Number(bytes) / 1e9).toFixed(bytes < 1e9 ? 2 : 1)} GB`;
  const where = (p) => (p === "gpu" ? "runs on the graphics card" : "runs on the processor");

  let route = null; // last desk:localai-route answer
  let busy = false;
  const messages = [];

  function setState(on, text) {
    $("state").querySelector(".dot").classList.toggle("on", on);
    $("stateText").textContent = text;
  }

  function progress(text, err = false) {
    $("progress").textContent = text || "";
    $("progress").classList.toggle("err", Boolean(err));
  }

  function tab(name) {
    const chat = name === "chat";
    $("tabChat").setAttribute("aria-selected", String(chat));
    $("tabModel").setAttribute("aria-selected", String(!chat));
    $("viewChat").hidden = !chat;
    $("viewModel").hidden = chat;
    if (chat) $("q").focus();
  }

  function banner() {
    const b = $("banner");
    const local = route && route.local;
    if (route && route.offline) {
      b.textContent = route.banner;
    } else if (!$("viewChat").hidden && local && local.running) {
      b.textContent = route.localNote;
    } else {
      b.textContent = "";
    }
    b.hidden = !b.textContent;
  }

  function label(s) {
    return (s && s.label) || "this model";
  }

  function render() {
    const s = route && route.local;
    if (!s || !s.ok) {
      setState(false, (s && s.error) || "Local AI is not available on this computer.");
      $("recName").textContent = "Not available";
      $("recMeta").textContent = "";
      $("recBtn").disabled = true;
      $("installed").hidden = true;
      $("tabChat").disabled = true;
      banner();
      return;
    }
    const sizes = Array.isArray(s.sizes) ? s.sizes : [];
    const mine = sizes.find((x) => x.id === s.model) || null;
    const rec = sizes.find((x) => x.id === s.recommended) || null;
    if (s.installed && s.running) setState(true, `${label(mine)} is running`);
    else if (s.installed) setState(false, `${label(mine)} is installed but stopped`);
    else setState(false, "Nothing installed yet");

    $("installed").hidden = !s.installed;
    $("chatBtn").disabled = !s.running;
    $("tabChat").disabled = !s.running;

    const btn = $("recBtn");
    if (!rec) {
      $("recLabel").textContent = "This computer";
      $("recName").textContent = "Too little memory";
      $("recMeta").textContent = "Even the smallest model does not fit.";
      btn.hidden = true;
    } else if (s.installed && s.model === rec.id) {
      $("recLabel").textContent = "On this computer";
      $("recName").textContent = rec.label;
      $("recMeta").textContent = `${where(s.placement || rec.placement)} · ${rec.quant}`;
      btn.hidden = false;
      btn.textContent = s.running ? "Chat" : "Start";
      btn.dataset.action = s.running ? "chat" : "install";
      btn.dataset.model = rec.id;
    } else {
      $("recLabel").textContent = "Recommended for this computer";
      $("recName").textContent = rec.label;
      $("recMeta").textContent = `${gb(rec.disk_bytes)} download · ${where(rec.placement)}`;
      btn.hidden = false;
      btn.textContent = s.installed ? `Switch to ${rec.label}` : "Install";
      btn.dataset.action = "install";
      btn.dataset.model = rec.id;
    }
    btn.disabled = busy;

    const list = $("sizes");
    list.textContent = "";
    for (const x of sizes) {
      const row = document.createElement("div");
      row.className = "row";
      const t = document.createElement("div");
      t.className = "t";
      const n = document.createElement("div");
      n.className = "n";
      n.textContent = x.label;
      const m = document.createElement("div");
      m.className = "m";
      m.textContent = x.fits ? `${gb(x.disk_bytes)} · ${where(x.placement)}` : `${gb(x.disk_bytes)} · too big for this computer`;
      m.title = x.reason || "";
      t.append(n, m);
      const b = document.createElement("button");
      b.className = "quiet";
      const current = s.installed && s.model === x.id;
      b.textContent = current ? "In use" : "Use";
      b.disabled = busy || current || !x.fits;
      b.addEventListener("click", () => install(x.id));
      row.append(t, b);
      list.append(row);
    }
    banner();
  }

  async function refresh() {
    try {
      route = await api.route();
    } catch (e) {
      route = { local: { ok: false, error: String((e && e.message) || e) } };
    }
    render();
    return route;
  }

  async function watchJob() {
    busy = true;
    render();
    for (;;) {
      await new Promise((r) => setTimeout(r, 1000));
      const j = await api.job();
      progress(j.line);
      if (!j.running) {
        busy = false;
        if (j.ok) progress(j.verb === "remove" ? "Removed." : "Ready. It starts by itself when you sign in.");
        else progress(j.error || "That did not work.", true);
        await refresh();
        return j;
      }
    }
  }

  async function install(model) {
    if (busy) return;
    progress("Getting ready…");
    const r = await api.install(model);
    if (!r.ok) return progress(r.error, true);
    const j = await watchJob();
    if (j && j.ok && route && route.local && route.local.running) tab("chat");
  }

  async function remove() {
    if (busy || !window.confirm("Remove the AI from this computer? This deletes its download.")) return;
    const r = await api.remove();
    if (!r.ok) return progress(r.error, true);
    await watchJob();
  }

  function addMsg(role, text, err = false) {
    $("empty")?.remove();
    const d = document.createElement("div");
    d.className = `msg ${role}${err ? " err" : ""}`;
    d.textContent = text;
    $("log").append(d);
    $("log").scrollTop = $("log").scrollHeight;
    return d;
  }

  async function send(ev) {
    ev.preventDefault();
    const q = $("q").value.trim();
    if (!q || busy) return;
    $("q").value = "";
    messages.push({ role: "user", content: q });
    addMsg("user", q);
    const wait = addMsg("ai", "…");
    $("send").disabled = true;
    const r = await api.chat(messages, route && route.port);
    $("send").disabled = false;
    wait.remove();
    if (r.ok) {
      messages.push({ role: "assistant", content: r.text });
      addMsg("ai", r.text);
    } else {
      messages.pop();
      addMsg("ai", r.error || "No answer.", true);
    }
  }

  $("tabChat").addEventListener("click", () => { tab("chat"); banner(); });
  $("tabModel").addEventListener("click", () => { tab("model"); banner(); });
  $("chatBtn").addEventListener("click", () => { tab("chat"); banner(); });
  $("removeBtn").addEventListener("click", remove);
  $("recBtn").addEventListener("click", () => {
    const b = $("recBtn");
    if (b.dataset.action === "chat") { tab("chat"); banner(); } else install(b.dataset.model);
  });
  $("ask").addEventListener("submit", send);

  (async () => {
    const r = await refresh();
    const j = await api.job();
    if (j && j.running) void watchJob();
    // Offline with a working local model: open straight on the chat.
    if (r && r.offline && r.local && r.local.running) tab("chat");
    banner();
    setInterval(() => { if (!busy) void refresh(); }, 60_000);
  })();
})();
