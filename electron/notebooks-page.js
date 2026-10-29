/* global window, document */
/* aither://notebooks -- renders notebooks-client.cjs through window.aitherNotebooks
   (notebooks-preload.cjs). Text only (textContent). Rows come from this computer's index
   first, so the page renders instantly and offline; the platform is merged in after. */
(function () {
  "use strict";
  const api = window.aitherNotebooks;
  const $ = (id) => document.getElementById(id);
  const el = (tag, cls, text) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = String(text);
    return n;
  };
  let rows = [];
  let lastLive = null;

  function status(text, err) {
    $("status").textContent = text || "";
    $("status").className = err ? "err" : "";
  }

  function badge(live) {
    const chip = $("live");
    if (!live || !live.checked) {
      chip.textContent = "checking…";
      chip.className = "chip";
      return;
    }
    chip.textContent = live.live ? "Live" : "Offline";
    chip.className = "chip " + (live.live ? "ok" : "warn");
    chip.title = live.live ? "The platform answered" : String(live.error || "The platform did not answer");
  }

  function button(label, fn) {
    const b = el("button", "", label);
    b.type = "button";
    b.addEventListener("click", async () => {
      b.disabled = true;
      try { await fn(); } finally { b.disabled = false; }
    });
    return b;
  }

  function say(out, text, err) {
    out.textContent = text;
    out.className = "out" + (err ? " err" : "");
  }

  async function replay(row, out) {
    const look = await api.outline(row.notebook);
    if (!look || !look.ok) return say(out, "Could not read it from the platform: " + ((look && look.error) || "no answer"), true);
    const acting = Object.entries(look.acting || {});
    let allow = false;
    if (acting.length) {
      const list = acting.map(([k, v]) => v + " × " + k).join(", ");
      const empty = look.emptyTask
        ? "\n\n" + look.emptyTask + " of them have no prompt (recorded tool calls): each would start an agent with an EMPTY task."
        : "";
      // The owner decides: each of these cells runs an agent with full tools, a script or a call.
      allow = window.confirm("A replay runs these cells, and each can change things:\n\n"
        + list + empty + "\n\nRun it anyway?");
      if (!allow) return say(out, "Not replayed — it would run " + list + ".", false);
    }
    say(out, "Replaying " + look.cellCount + " cells on the platform…", false);
    const run = await api.replay(row.notebook, { allowSideEffects: allow });
    if (!run || !run.ok) return say(out, "Replay failed: " + ((run && run.error) || "no answer"), true);
    say(out, "Run " + run.runId + " — " + run.status, false);
  }

  function card(row) {
    const box = el("div", "n");
    const top = el("div", "top");
    // What the work was first; the id is the handle, not the headline.
    const title = row.title || row.name || "";
    if (title) top.append(el("span", "title", title));
    top.append(el("span", "id", row.notebook));
    if (row.name && row.name !== title) top.append(el("span", "", row.name));
    const where = { host: "this computer", platform: "platform", both: "this computer + platform" }[row.source] || row.source;
    top.append(el("span", "chip", where));
    box.append(top);
    const meta = [row.created ? row.created.replace("T", " ").slice(0, 16) : "", row.session ? "session " + row.session.slice(0, 8) : ""]
      .filter(Boolean).join(" · ");
    if (meta) box.append(el("div", "meta", meta));
    const out = el("div", "out");
    const acts = el("div", "acts");
    acts.append(
      button("View", async () => {
        const r = await api.view(row.notebook);
        if (!r || !r.ok) say(out, (r && r.error) || "Could not open it", true);
      }),
      button("Replay", () => replay(row, out)),
      button("Export .ipynb", async () => {
        const r = await api.exportTo(row.notebook);
        say(out, r && r.ok ? "Saved " + r.path : "Export failed: " + ((r && r.error) || "no answer"), !(r && r.ok));
      }),
    );
    if (row.log_path) {
      acts.append(button("Open transcript", async () => {
        const r = await api.transcript(row.log_path);
        if (!r || !r.ok) say(out, (r && r.error) || "No transcript", true);
      }));
    }
    box.append(acts, out);
    return box;
  }

  let lastSummary = { text: "", err: false };

  function render() {
    const q = String($("filter").value || "").trim().toLowerCase();
    const shown = q ? rows.filter((r) => [r.notebook, r.session, r.created, r.name, r.title].join(" ").toLowerCase().includes(q)) : rows;
    const list = $("list");
    list.replaceChildren();
    // The status line counts what is SHOWN while a filter is on, never the total alone.
    if (q) status(shown.length + " of " + rows.length + " notebooks match “" + q + "”", false);
    else if (lastSummary.text) status(lastSummary.text, lastSummary.err);
    if (!shown.length) {
      list.append(el("div", "empty", rows.length ? "Nothing matches that filter." : "No notebooks yet."));
      return;
    }
    for (const row of shown.slice(0, 300)) list.append(card(row));
  }

  function summary(data) {
    const host = (data.notebooks || []).filter((r) => r.source !== "platform").length;
    if (!data.index || !data.index.readable) return { text: "This computer's index: " + ((data.index && data.index.error) || "unreadable"), err: true };
    if (data.live && data.live.checked && !data.live.live) {
      return { text: "Platform unreachable — showing " + host + " notebooks from this computer (" + (data.live.error || "no answer") + ")", err: false };
    }
    return { text: (data.notebooks || []).length + " notebooks", err: false };
  }

  function show(data) {
    lastSummary = summary(data);
    render();
  }

  async function load() {
    if (!api) return status("This page needs the Aither desk.", true);
    // This computer first: instant and offline.
    const local = await api.list({ localOnly: true });
    if (local && local.ok) {
      rows = local.notebooks || [];
      show(local);
    }
    badge(lastLive);
    const full = await api.list({ localOnly: false });
    if (full && full.ok) {
      rows = full.notebooks || rows;
      lastLive = full.live;
      badge(full.live);
      show(full);
    } else {
      status("Could not list notebooks: " + ((full && full.error) || "no answer"), true);
    }
  }

  $("filter").addEventListener("input", render);
  $("refresh").addEventListener("click", () => void load());
  void load();
})();
