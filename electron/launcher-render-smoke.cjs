"use strict";

/**
 * launcher-render-smoke -- does Alt+Space actually DRAW the decision cards?
 *
 * `test:space` drives the Space pane; nothing drove launcher.html, so a crash in
 * its render loop shipped with green unit tests and the overlay showed a heading
 * and nothing else (owner, 2026-11-06: "there is no decision card ... no way to
 * expand a list"). This loads the REAL page with a fake bridge and measures the
 * DOM the way the owner sees it:
 *
 *   1. the empty box leads with "Needs you (N)" and a REAL "+N more" row
 *   2. expanding a card does not move the rows above or below it
 *   3. clicking "+N more" expands the group in place
 *   4. a number key answers the FOCUSED card (empty box only)
 *   5. Esc collapses the card; only the second Esc closes the window
 *
 * Exit 0 pass · 1 a check failed · 2 the run broke (could not judge).
 */
const os = require("node:os");
const fs = require("node:fs");
const path = require("node:path");
const { app, BrowserWindow, ipcMain } = require("electron");
const context = require("./launcher-context.cjs");

const PRELOAD = path.join(os.tmpdir(), `awdesk-launcher-smoke-preload-${process.pid}.cjs`);
fs.writeFileSync(PRELOAD, `"use strict";
const { contextBridge, ipcRenderer } = require("electron");
contextBridge.exposeInMainWorld("aitherLauncher", {
  search: (text) => ipcRenderer.invoke("launcher:search", String(text || "")),
  run: (key, query) => ipcRenderer.invoke("launcher:run", String(key || ""), String(query || "")),
  command: () => Promise.resolve({ ok: false, error: "not in this smoke" }),
  ask: () => Promise.resolve({ ok: true }),
  spirit: () => Promise.resolve({ ok: true }),
  hide: () => ipcRenderer.invoke("launcher:hide"),
  release: () => {},
  onResults: (fn) => { ipcRenderer.on("launcher:results", (_event, payload) => fn(payload)); return () => {}; },
  onFocus: (fn) => { ipcRenderer.on("launcher:focus", () => fn()); return () => {}; },
});
`, "utf8");

const fails = [];
function expect(what, ok, detail) {
  const shown = detail === undefined ? "" : ` :: ${JSON.stringify(detail)}`;
  console.log(`${ok ? "PASS" : "FAIL"} ${what}${shown}`);
  if (!ok) fails.push(what);
}

const EIGHT = Array.from({ length: 8 }, (_, i) => ({
  id: `d-${i + 1}`,
  title: `Card ${i + 1} needs a decision`,
  summary: "A real question with options",
  kind: i === 0 ? "credential" : "decision",
  urgency: i === 0 ? "blocked" : "normal",
  createdAt: 1_760_000_000 - i * 60,
  deadline: null,
  defaultKey: "ack",
  needsYou: true,
  stale: false,
  position: i,
  options: [
    { index: 1, key: "ack", label: "Acknowledge", consequence: "", recommended: false },
    { index: 2, key: "later", label: "Not now", consequence: "", recommended: true },
    { index: 3, key: "deck", label: "Open the deck", consequence: "", recommended: false },
  ],
}));

const runCalls = [];
let hides = 0;

app.whenReady().then(async () => {
  const needs = context.needsYouGroup(EIGHT);
  // The "Right now" group has no `shown` -- it is the shape that used to blank
  // the whole list. It must render too.
  const now = context.rightNowGroup({ ok: true, app: "Notepad", title: "notes.txt" }, () => true);
  const payload = {
    token: 1,
    ignored: false,
    mode: "all",
    term: "",
    status: now.status || "",
    groups: [needs.group, now.group].filter(Boolean),
  };

  ipcMain.handle("launcher:search", () => payload);
  ipcMain.handle("launcher:run", (_event, key, query) => {
    runCalls.push({ key, query });
    return { ok: true, did: `ran ${key}` };
  });
  ipcMain.handle("launcher:hide", () => { hides += 1; return { ok: true }; });

  const win = new BrowserWindow({
    show: false,
    width: 760,
    height: 620,
    webPreferences: { preload: PRELOAD, contextIsolation: true, sandbox: false, nodeIntegration: false },
  });
  await win.loadFile(path.join(__dirname, "launcher.html"));
  const wc = win.webContents;
  const js = (code) => wc.executeJavaScript(code, true);
  const until = async (code, ms = 4000) => {
    const end = Date.now() + ms;
    for (;;) {
      const value = await js(code);
      if (value) return value;
      if (Date.now() > end) return null;
      await new Promise((r) => setTimeout(r, 60));
    }
  };

  // 1 -- the list is drawn, groups and all.
  const shape = await until(`(() => {
    const cards = document.querySelectorAll(".row.card").length;
    const labels = [...document.querySelectorAll(".group-label")].map((n) => n.textContent);
    const more = document.querySelector(".row.more");
    return cards ? { cards, labels, more: more ? more.textContent : null } : null;
  })()`);
  expect("the empty box draws the needs-you rows", shape && shape.cards === 5, shape && shape.cards);
  expect("both groups are labelled", shape && shape.labels.length === 2, shape && shape.labels);
  expect("the label carries the real count", Boolean(shape && /Needs you/i.test(shape.labels[0]) && /8/.test(shape.labels[0])), shape && shape.labels[0]);
  expect("a real '+3 more' row is offered", Boolean(shape && shape.more && /^\+3 more/.test(shape.more)), shape && shape.more);
  expect("a group with no `shown` still renders (the crash)", Boolean(shape && shape.labels.some((l) => /Right now/.test(l))), shape && shape.labels);

  // 2 -- expanding a card never moves the row you clicked or anything above it.
  // (Rows BELOW move down: that is the document, not a jump.)  Collapsing must
  // return every row to its exact old position -- drift is what the owner felt.
  const moved = await js(`(() => {
    const snap = () => [...document.querySelectorAll(".row.card")].map((r) => Math.round(r.getBoundingClientRect().top));
    const before = snap();
    const rows = [...document.querySelectorAll(".row.card")];
    rows[2].click();
    const after = snap();
    const body = document.querySelectorAll(".card-body").length;
    document.querySelectorAll(".row.card")[2].click();
    const restored = snap();
    return { before, after, restored, body };
  })()`);
  expect("clicking a card expands it in place", moved && moved.body === 1, moved && moved.body);
  expect(
    "the clicked row and every row above it hold their place",
    moved && moved.after.length === moved.before.length && moved.after.slice(0, 3).every((t, i) => t === moved.before[i]),
    moved && { before: moved.before.slice(0, 3), after: moved.after.slice(0, 3) },
  );
  expect(
    "collapsing restores every row exactly (no drift)",
    moved && moved.restored.length === moved.before.length && moved.restored.every((t, i) => t === moved.before[i]),
    moved && { before: moved.before, restored: moved.restored },
  );

  // 3 -- the number keys answer the FOCUSED card.
  const answered = await js(`(() => {
    const input = document.getElementById("input");
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "2", bubbles: true }));
    return true;
  })()`);
  await until(`true`, 200);
  const answerCall = runCalls.find((c) => /^card:/.test(c.key));
  expect("2 answers option 2 of the focused card", Boolean(answered && answerCall && answerCall.query === "2"), answerCall);

  // 4 -- "+3 more" expands the group in place, to all eight.
  const expanded = await js(`(() => {
    const more = document.querySelector(".row.more");
    if (more) more.click();
    return document.querySelectorAll(".row.card").length;
  })()`);
  expect("'+N more' expands the group in place", expanded === 8, expanded);

  // 4b -- a SUPERSEDED answer (a newer keystroke won) must not blank the list.
  win.webContents.send("launcher:results", { ok: true, token: 1, superseded: true, groups: [] });
  await until(`true`, 200);
  const afterSuperseded = await js(`document.querySelectorAll(".row.card").length`);
  expect("a superseded answer does not blank the list", afterSuperseded === 8, afterSuperseded);

  // 5 -- Esc collapses first, closes second.
  const escape = await js(`(() => {
    const rows = [...document.querySelectorAll(".row.card")];
    const closed = rows.find((r) => !r.querySelector(".card-body"));
    if (closed) closed.click();
    const opened = document.querySelectorAll(".card-body").length;
    const input = document.getElementById("input");
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    const afterFirst = document.querySelectorAll(".card-body").length;
    const hidesAfterFirst = ${hides};
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    return { opened, afterFirst, hidesAfterFirst };
  })()`);
  expect("a card was open before the first Esc", escape && escape.opened >= 1, escape && escape.opened);
  expect("the first Esc collapses only", escape && escape.afterFirst === 0, escape && escape.afterFirst);
  expect("the first Esc closes nothing", escape && escape.hidesAfterFirst === 0, escape && escape.hidesAfterFirst);
  const closed = await until(`${hides} === 1 ? 1 : null`, 2000);
  expect("the second Esc closes the window", Boolean(closed), hides);

  win.destroy();
  try { fs.unlinkSync(PRELOAD); } catch { /* temp file, best effort */ }
  console.log(fails.length ? `FAILED ${fails.length}` : "LAUNCHER RENDER: ALL PASS");
  app.exit(fails.length ? 1 : 0);
}).catch((error) => {
  console.log("BROKE " + ((error && error.stack) || error));
  app.exit(2);
});
