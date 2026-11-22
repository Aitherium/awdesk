/* global window, document, URL, setTimeout, clearTimeout */
/* The Aither Browser's library pages -- aither://history, bookmarks, downloads, permissions,
   clear-data -- drawn from window.aitherLibrary (library-preload.cjs). <body data-page>
   says which one. Text only: every string from a site (a title, an address, a file name)
   goes in through textContent, never as markup. */
(function () {
  "use strict";
  const api = window.aitherLibrary;
  const page = document.body.dataset.page;
  const root = document.getElementById("page");
  const $ = (id) => document.getElementById(id);
  const el = (tag, cls, text) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = String(text);
    return n;
  };
  const button = (label, onClick, cls) => {
    const b = el("button", cls || "", label);
    b.type = "button";
    b.onclick = onClick;
    return b;
  };
  const input = (type, placeholder, cls) => {
    const i = el("input", cls || "");
    i.type = type;
    i.placeholder = placeholder || "";
    i.spellcheck = false;
    i.autocomplete = "off";
    i.setAttribute("aria-label", placeholder || type);
    return i;
  };
  function status(text, err) {
    $("status").textContent = text || "";
    $("status").className = err ? "err" : "";
  }
  /** Run one bridge call; say what went wrong; true when it worked. */
  async function act(promise, okText) {
    const r = await promise;
    if (r && r.ok) { if (okText != null) status(typeof okText === "function" ? okText(r) : okText); return r; }
    if (r && r.cancelled) { status(""); return null; }
    status((r && r.error) || "that did not work", true);
    return null;
  }
  const hostOf = (url) => { try { return new URL(url).host; } catch { return url; } };

  const NAV = [["history", "History"], ["bookmarks", "Bookmarks"], ["downloads", "Downloads"],
    ["permissions", "Site permissions"], ["clear-data", "Clear browsing data"]];
  const nav = $("nav");
  for (const [id, label] of NAV) {
    const b = button(label, () => { if (id !== page) void api.goto(id); });
    if (id === page) b.setAttribute("aria-current", "page");
    nav.append(b);
  }

  // ------------------------------------------------------------------ history
  function historyPage() {
    const q = input("search", "Search history", "grow");
    q.id = "q";
    const who = el("select");
    who.id = "who";
    who.setAttribute("aria-label", "Who visited");
    for (const [v, t] of [["", "Everyone"], ["you", "You"], ["agent", "Agents"]]) { const o = el("option", "", t); o.value = v; who.append(o); }
    const range = el("select");
    range.id = "range";
    range.setAttribute("aria-label", "Range to delete");
    for (const [v, t] of [["hour", "Last hour"], ["day", "Last 24 hours"], ["week", "Last 7 days"], ["month", "Last 4 weeks"]]) {
      const o = el("option", "", t); o.value = v; range.append(o);
    }
    const bar = el("div", "bar");
    const bar2 = el("div", "bar");
    bar.append(q, who);
    bar2.append(range,
      button("Delete this range…", async () => { if (await act(api.history.removeRange({ range: range.value }), (r) => `${r.removed} deleted.`)) void load(); }, "danger"),
      el("span", "grow"),
      button("Clear all history…", async () => { if (await act(api.history.clear(), "History cleared.")) void load(); }, "danger"));
    const list = el("div");
    list.id = "list";
    root.append(bar, bar2, list);
    let limit = 200;
    const dayStart = (ms) => { const d = new Date(ms); d.setHours(0, 0, 0, 0); return d.getTime(); };
    const dayName = (start, now) => {
      const today = dayStart(now);
      const text = new Date(start).toLocaleDateString(undefined, { weekday: "long", year: "numeric", month: "long", day: "numeric" });
      if (start === today) return `Today - ${text}`;
      if (start === dayStart(today - 1)) return `Yesterday - ${text}`;
      return text;
    };
    async function load() {
      const r = await api.history.list({ q: q.value, by: who.value, limit });
      list.textContent = "";
      if (!r || !r.ok) return status((r && r.error) || "could not read history", true);
      if (!r.entries.length) list.append(el("div", "empty", q.value || who.value ? "Nothing in history matches." : "No history yet."));
      let day = null;
      for (const h of r.entries) {
        const start = h.at ? dayStart(h.at) : 0;
        if (start !== day) {
          day = start;
          const head = el("h2", "day");
          head.append(el("span", "grow", start ? dayName(start, r.now) : "Earlier (imported, no date)"));
          if (start) {
            const end = new Date(start);
            end.setDate(end.getDate() + 1);
            const label = new Date(start).toLocaleDateString();
            head.append(button("Delete this day…", async () => {
              if (await act(api.history.removeRange({ from: start, to: end.getTime(), label }), (x) => `${x.removed} deleted.`)) void load();
            }, "small danger"));
          }
          list.append(head);
        }
        const row = el("div", "row");
        row.dataset.url = h.url;
        const main = el("div", "main");
        const title = button(h.title || h.url, () => void api.open(h.url), "title");
        title.title = h.url;
        main.append(title, el("div", "url", h.url));
        const del = button("Delete", async () => { if (await act(api.history.remove(h.url), "")) void load(); }, "small");
        del.setAttribute("aria-label", `Delete ${h.title || h.url} from history`);
        row.append(el("span", "time", h.at ? new Date(h.at).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" }) : ""),
          main, el("span", h.by === "agent" ? "tag agent" : "tag", h.by === "agent" ? "agent" : "you"));
        if (h.count > 1) row.append(el("span", "tag", `${h.count} visits`));
        row.append(del);
        list.append(row);
      }
      if (r.total > r.entries.length) {
        list.append(button(`Show more (${r.total - r.entries.length} older)`, () => { limit += 200; void load(); }));
      }
      if (!$("status").classList.contains("err")) status(`${r.total} page${r.total === 1 ? "" : "s"}`);
    }
    let timer = null;
    q.addEventListener("input", () => { clearTimeout(timer); timer = setTimeout(load, 150); });
    who.addEventListener("change", load);
    return load;
  }

  // ------------------------------------------------------------------ bookmarks
  function bookmarksPage() {
    const q = input("search", "Search bookmarks", "grow");
    q.id = "q";
    const folderList = el("datalist");
    folderList.id = "folders";
    const barToggle = el("input");
    barToggle.type = "checkbox";
    barToggle.id = "bar";
    const barLabel = el("label", "check");
    barLabel.append(barToggle, el("span", "", "Show the bookmarks bar (Ctrl+Shift+B)"));
    barToggle.onchange = () => void act(api.bookmarks.setBar(barToggle.checked), "");

    const addForm = el("div", "form");
    addForm.id = "addform";
    addForm.hidden = true;
    const aUrl = input("url", "Address (https://...)", "grow");
    aUrl.id = "add-url";
    const aTitle = input("text", "Name");
    aTitle.id = "add-title";
    const aFolder = input("text", "Folder (empty = top level)");
    aFolder.id = "add-folder";
    aFolder.setAttribute("list", "folders");
    addForm.append(aUrl, aTitle, aFolder, button("Save", async () => {
      if (await act(api.bookmarks.add({ url: aUrl.value, title: aTitle.value, folder: aFolder.value }), "Bookmark saved.")) {
        aUrl.value = ""; aTitle.value = ""; addForm.hidden = true; void load();
      }
    }), button("Cancel", () => { addForm.hidden = true; }));
    addForm.lastChild.previousSibling.id = "add-save";

    const folderForm = el("div", "form");
    folderForm.id = "folderform";
    folderForm.hidden = true;
    const fName = input("text", "Folder name (Work, or Work/Clients)", "grow");
    fName.id = "folder-name";
    folderForm.append(fName, button("Create", async () => {
      if (await act(api.bookmarks.addFolder(fName.value), "Folder created.")) { fName.value = ""; folderForm.hidden = true; void load(); }
    }), button("Cancel", () => { folderForm.hidden = true; }));

    const bar = el("div", "bar");
    const addBtn = button("Add a bookmark", () => { addForm.hidden = !addForm.hidden; if (!addForm.hidden) aUrl.focus(); });
    addBtn.id = "add";
    bar.append(q, addBtn,
      button("New folder", () => { folderForm.hidden = !folderForm.hidden; if (!folderForm.hidden) fName.focus(); }),
      button("Import…", async () => { if (await act(api.bookmarks.importHtml(), (r) => `${r.added} of ${r.found} bookmarks added (the rest were already here).`)) void load(); }),
      button("Export…", () => void act(api.bookmarks.exportHtml(), (r) => `${r.count} bookmarks written to ${r.file}`)));
    const list = el("div");
    list.id = "list";
    root.append(bar, barLabel, addForm, folderForm, folderList, list);

    let editing = false;
    function bookmarkRow(b) {
      const row = el("div", "row");
      row.dataset.url = b.url;
      const show = () => {
        editing = false;
        row.textContent = "";
        const main = el("div", "main");
        const title = button(b.title || b.url, () => void api.open(b.url), "title");
        title.title = b.url;
        main.append(title, el("div", "url", b.url));
        const edit = button("Edit", () => form(), "small");
        edit.dataset.act = "edit";
        const del = button("Delete", async () => { if (await act(api.bookmarks.remove(b.url), "Bookmark deleted.")) void load(); }, "small");
        del.dataset.act = "delete";
        row.append(main, edit, del);
      };
      const form = () => {
        editing = true;
        row.textContent = "";
        const t = input("text", "Name", "grow");
        t.value = b.title || "";
        t.dataset.field = "title";
        const u = input("url", "Address", "grow");
        u.value = b.url;
        u.dataset.field = "url";
        const f = input("text", "Folder (empty = top level)");
        f.value = b.folder || "";
        f.dataset.field = "folder";
        f.setAttribute("list", "folders");
        const save = button("Save", async () => {
          if (await act(api.bookmarks.update(b.url, { title: t.value, url: u.value, folder: f.value }), "Bookmark saved.")) { editing = false; void load(); }
        }, "small");
        save.dataset.act = "save";
        row.append(t, u, f, save, button("Cancel", show, "small"));
        t.focus();
        t.select();
      };
      show();
      return row;
    }
    function folderHead(name, count) {
      const head = el("h2", "folder");
      head.dataset.folder = name;
      const show = () => {
        head.textContent = "";
        head.append(el("span", "grow", `${name} (${count})`),
          button("Rename", edit, "small"),
          button("Delete folder, keep bookmarks", async () => { if (await act(api.bookmarks.removeFolder(name, true), "Folder deleted; its bookmarks are at the top level.")) void load(); }, "small"),
          button("Delete folder…", async () => { if (await act(api.bookmarks.removeFolder(name, false), "Folder deleted.")) void load(); }, "small danger"));
      };
      const edit = () => {
        head.textContent = "";
        const n = input("text", "Folder name", "grow");
        n.value = name;
        head.append(n, button("Save", async () => { if (await act(api.bookmarks.renameFolder(name, n.value), "Folder renamed.")) void load(); }, "small"),
          button("Cancel", show, "small"));
        n.focus();
      };
      show();
      return head;
    }
    async function load() {
      if (editing) return; // an open edit form is not thrown away by a refresh
      const r = await api.bookmarks.list();
      list.textContent = "";
      if (!r || !r.ok) return status((r && r.error) || "could not read bookmarks", true);
      barToggle.checked = Boolean(r.bar);
      folderList.textContent = "";
      for (const f of r.folders) { const o = el("option"); o.value = f; folderList.append(o); }
      const text = q.value.trim().toLowerCase();
      const rows = r.bookmarks.filter((b) => !text || b.url.toLowerCase().includes(text) || String(b.title || "").toLowerCase().includes(text)
        || String(b.folder || "").toLowerCase().includes(text));
      const groups = new Map([["", []]]);
      if (!text) for (const f of r.folders) groups.set(f, []);
      for (const b of rows) {
        const f = b.folder || "";
        if (!groups.has(f)) groups.set(f, []);
        groups.get(f).push(b);
      }
      if (!rows.length && groups.size === 1) list.append(el("div", "empty", text ? "No bookmark matches." : "No bookmarks yet. Press the star in the toolbar (Ctrl+D), or add one here."));
      for (const [folder, items] of groups) {
        if (folder) list.append(folderHead(folder, items.length));
        else if (items.length && groups.size > 1) list.append(el("h2", "", "Top level"));
        for (const b of items) list.append(bookmarkRow(b));
      }
      if (!$("status").classList.contains("err")) status(`${r.bookmarks.length} bookmark${r.bookmarks.length === 1 ? "" : "s"}`);
    }
    q.addEventListener("input", () => { editing = false; void load(); });
    return load;
  }

  // ------------------------------------------------------------------ downloads
  function downloadsPage() {
    const bar = el("div", "bar");
    bar.append(button("Clear finished", async () => { if (await act(api.downloads.clear(), "")) void load(); }));
    const list = el("div");
    list.id = "list";
    root.append(bar, list);
    const size = (n) => (n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : n >= 1024 ? `${Math.round(n / 1024)} KB` : `${n} B`);
    const STATE = { progressing: "Downloading", completed: "Done", cancelled: "Cancelled", interrupted: "Failed",
      blocked: "Blocked: an agent started it" };
    async function load() {
      const r = await api.downloads.list();
      list.textContent = "";
      if (!r || !r.ok) return status((r && r.error) || "could not read downloads", true);
      if (!r.downloads.length) list.append(el("div", "empty", "Nothing downloaded since the browser started."));
      for (const d of r.downloads) {
        const row = el("div", "row");
        row.dataset.id = String(d.id);
        const main = el("div", "main");
        const name = el("div", "title", d.filename);
        name.title = d.path || d.url;
        const meta = `${STATE[d.state] || d.state}${d.received ? ` - ${size(d.received)}${d.total ? ` of ${size(d.total)}` : ""}` : ""} - ${hostOf(d.url)}`;
        main.append(name, el("div", "meta", d.state === "completed" && d.path ? `${meta} - ${d.path}` : meta));
        row.append(main);
        if (d.state === "progressing" && d.total > 0) {
          const p = el("progress");
          p.max = d.total;
          p.value = d.received;
          row.append(p);
        }
        const again = async (promise, okText) => { if (await act(promise, okText)) void load(); };
        if (d.canOpen) row.append(button("Open", () => void act(api.downloads.open(d.id), ""), "small"));
        if (d.canShow) row.append(button("Show in folder", () => void act(api.downloads.show(d.id), ""), "small"));
        if (d.canRetry) row.append(button("Try again", () => void again(api.downloads.retry(d.id), "Downloading again."), "small"));
        if (d.canRemove) row.append(button("Remove", () => void again(api.downloads.remove(d.id), ""), "small"));
        list.append(row);
      }
      if (!$("status").classList.contains("err")) status(`${r.downloads.length} download${r.downloads.length === 1 ? "" : "s"}. This list starts again when the browser restarts; the files stay.`);
    }
    return load;
  }

  // ------------------------------------------------------------------ site permissions
  function permissionsPage() {
    const bar = el("div", "bar");
    bar.append(button("Forget all…", async () => { if (await act(api.permissions.clear(), "Every site asks again.")) void load(); }, "danger"));
    const list = el("div");
    list.id = "list";
    root.append(bar, list);
    async function load() {
      const r = await api.permissions.list();
      list.textContent = "";
      if (!r || !r.ok) return status((r && r.error) || "could not read permissions", true);
      if (!r.permissions.length) {
        list.append(el("div", "empty", "No site has been allowed or blocked yet. A site asks the first time it wants your camera, microphone, location, notifications or clipboard."));
      }
      let site = null;
      for (const p of r.permissions) {
        if (p.origin !== site) {
          site = p.origin;
          const head = el("h2");
          const origin = p.origin;
          head.append(el("span", "grow", origin), button("Forget this site", async () => {
            if (await act(api.permissions.remove(origin, ""), `${origin} asks again.`)) void load();
          }, "small"));
          list.append(head);
        }
        const row = el("div", "row");
        row.dataset.origin = p.origin;
        row.dataset.kind = p.kind;
        const main = el("div", "main");
        main.append(el("div", "title", p.label), el("div", "meta", p.at ? `Decided ${new Date(p.at).toLocaleString()}` : ""));
        row.append(main, el("span", p.value === "block" ? "tag block" : "tag", p.value === "block" ? "Blocked" : "Allowed"),
          button("Remove", async () => { if (await act(api.permissions.remove(p.origin, p.kind), "Removed. The site asks again.")) void load(); }, "small"));
        list.append(row);
      }
      if (!$("status").classList.contains("err")) status(`${r.permissions.length} remembered answer${r.permissions.length === 1 ? "" : "s"}`);
    }
    return load;
  }

  // ------------------------------------------------------------------ clear browsing data
  function clearPage() {
    const range = el("select");
    range.id = "range";
    range.setAttribute("aria-label", "Time range");
    const boxes = {};
    const check = (id, label, note, on) => {
      const box = el("input");
      box.type = "checkbox";
      box.id = id;
      box.checked = on;
      boxes[id] = box;
      const text = el("span", "", label);
      const l = el("label", "check");
      l.append(box, text);
      root.append(l);
      if (note) root.append(el("div", "note", note));
      return text;
    };
    const bar = el("div", "bar");
    bar.append(el("span", "", "Time range"), range);
    root.append(bar);
    const hText = check("history", "Browsing history", "", true);
    check("cookies", "Cookies and other site data", "Signs you out of websites. Always cleared whole: it cannot be limited to a time range.", false);
    check("cache", "Cached images and files", "Always cleared whole: it cannot be limited to a time range.", true);
    const pText = check("passwords", "Saved passwords", "Passwords saved in the chosen time range are deleted for good.", false);
    const go = button("Clear data…", async () => {
      const r = await act(api.clearData.run({ range: range.value, history: boxes.history.checked, cookies: boxes.cookies.checked,
        cache: boxes.cache.checked, passwords: boxes.passwords.checked }), (x) => {
        const done = [];
        if (x.history != null) done.push(`${x.history} history entr${x.history === 1 ? "y" : "ies"}`);
        if (x.cookies) done.push("cookies and site data");
        if (x.cache) done.push("the cache");
        if (x.passwords != null) done.push(`${x.passwords} saved password${x.passwords === 1 ? "" : "s"}`);
        return `Cleared: ${done.join(", ") || "nothing"}.${x.errors && x.errors.length ? ` Not cleared: ${x.errors.join("; ")}.` : ""}`;
      });
      if (r) void load(true);
    }, "danger");
    go.id = "go";
    root.append(el("div", "note", "Only your own browsing profile is cleared. Your AitherOS sign-in, your agents' browser session and InPrivate tabs are separate."), go);
    async function load(keep) {
      const r = await api.clearData.summary();
      if (!r || !r.ok) return status((r && r.error) || "could not read the summary", true);
      if (!range.options.length) {
        for (const x of r.ranges) { const o = el("option", "", x.label[0].toUpperCase() + x.label.slice(1)); o.value = x.id; range.append(o); }
        range.value = "hour";
      }
      hText.textContent = `Browsing history (${r.history} page${r.history === 1 ? "" : "s"} in all)`;
      pText.textContent = `Saved passwords (${r.passwords} in all)`;
      if (keep !== true && !$("status").classList.contains("err")) status("");
    }
    return load;
  }

  const pages = { history: historyPage, bookmarks: bookmarksPage, downloads: downloadsPage, permissions: permissionsPage, "clear-data": clearPage };
  const load = (pages[page] || (() => () => status("unknown page", true)))();
  void load();
  // Main says the data moved (a visit, a download's progress): redraw, at most twice a second.
  let pending = null;
  api.onChanged(() => {
    if (pending) return;
    pending = setTimeout(() => { pending = null; void load(true); }, 500);
  });
}());
