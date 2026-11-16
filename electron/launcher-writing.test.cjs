"use strict";

// Alt+Space on a selection or in a text field leads with the writing actions (owner
// 2026-11-16: "ctrl alt j? what about alt + space?" -- one box, one key). With nothing to
// write on, the box is exactly what it was.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const core = require("./assist-core.cjs");
const registry = require("./command-registry.cjs");
const { createLauncher } = require("./launcher-window.cjs");
const { createAssistWindow } = require("./assist-window.cjs");

const SEL = { ok: true, app: "WINWORD", title: "Q3.docx", hwnd: 42, pid: 7777, selection: "we was late on the budget", field: "we was late on the budget", editable: true, canInsert: true };
const FIELD = { ok: true, app: "notepad", title: "a.txt", hwnd: 43, pid: 7778, selection: "", field: "Hi team", editable: true, canInsert: true };

test("a selection in a text box: the writing verbs, in order, and what each one does to the text", () => {
  const w = core.writingGroup({ snap: SEL, typed: "", insertable: true });
  assert.deepEqual(w.group.items.map((i) => i.key), ["assist:rewrite", "assist:reply", "assist:explain", "assist:translate", "assist:summarize", "assist:send-agent"]);
  assert.match(w.group.items[0].subtitle, /replaces your selection/);
  assert.equal(w.group.label, "Write in WINWORD");
  assert.deepEqual(w.plan.get("assist:rewrite"), { verb: "rewrite", prompt: "", run: true, insert: true });
  assert.equal(w.plan.get("assist:explain").insert, false, "an explanation is shown, never typed into the field");
  assert.equal(w.plan.get("assist:translate").run, false, "translate asks its language first");
  assert.equal(w.plan.get("assist:send-agent").run, false, "send to an agent asks which agent");
});

test("what was typed in the box becomes the first row: Write: <words>", () => {
  const w = core.writingGroup({ snap: SEL, typed: "make it formal", insertable: true });
  assert.equal(w.group.items[0].key, "assist:write");
  assert.equal(w.group.items[0].title, "Write: make it formal");
  assert.deepEqual(w.plan.get("assist:write"), { verb: "write", prompt: "make it formal", run: true, insert: true });
});

test("a focused text field with nothing selected: up to 3 context chips that insert at the caret", () => {
  const w = core.writingGroup({ snap: FIELD, typed: "", insertable: true });
  assert.ok(w.group.items.length >= 1 && w.group.items.length <= 3);
  assert.ok(w.group.items.every((i) => i.key.startsWith("assist:chip:")));
  assert.match(w.group.items[0].subtitle, /inserts at the caret/);
  assert.equal([...w.plan.values()][0].run, true);
});

test("nothing to write on -> null, so Alt+Space is exactly as before", () => {
  assert.equal(core.writingGroup({ snap: { ok: true, app: "explorer", selection: "", editable: false, canInsert: true }, insertable: true }), null, "a button is focusable, not writable");
  assert.equal(core.writingGroup({ snap: null }), null);
  assert.equal(core.writingGroup({ snap: { ok: false } }), null);
  assert.equal(core.writingGroup({ snap: { ok: true, sensitive: true, selection: "pw", editable: true } , insertable: true }), null, "a password field shows nothing at all");
});

test("a selection somewhere text cannot be typed (a web page, a terminal): answer-only verbs, 'shown here; copy it'", () => {
  const w = core.writingGroup({ snap: { ...SEL, editable: false, canInsert: false }, typed: "", insertable: false });
  assert.deepEqual(w.group.items.map((i) => i.key), ["assist:explain", "assist:summarize", "assist:translate", "assist:send-agent"]);
  assert.ok([...w.plan.values()].every((a) => a.insert === false));
  assert.match(w.group.items[0].subtitle, /the selection/);
});

test("the caret snapshot reports 'editable' separately from 'focusable'", () => {
  const { parseSnapshot, WORKER_SCRIPT } = require("./assist-caret.cjs");
  assert.equal(parseSnapshot(JSON.stringify({ ok: true, editable: true })).editable, true);
  assert.equal(parseSnapshot(JSON.stringify({ ok: true, canInsert: true })).editable, false);
  assert.match(WORKER_SCRIPT, /\$out\.editable = \(\$ct -eq 'ControlType\.Edit' -or \$ct -eq 'ControlType\.Document'\)/);
});

// ---- the launcher -------------------------------------------------------------------------

function launcher({ assist = null, answer } = {}) {
  const electron = { BrowserWindow: class {}, ipcMain: { handle() {}, on() {} }, screen: { getCursorScreenPoint: () => ({ x: 0, y: 0 }) }, shell: {}, clipboard: {} };
  const fake = { registry: null, run: async (term, opts) => (answer ? answer(term, opts) : { ok: true, query: term, phase: opts.phase, groups: [], errors: [], notes: [], total: 0 }) };
  return createLauncher({ electron, registry: { byId: () => null }, quickMenu: {}, run: async () => ({ ok: true }), ask: async () => ({ ok: true }), universalSearch: () => fake, ...(assist ? { assist } : {}) });
}

function facade(snap, insertable = true) {
  const chose = [];
  const captured = { snap, canInsert: insertable, pid: 1 };
  return {
    chose, captured,
    assist: {
      capture: async () => captured,
      group: (c, typed) => { const g = core.writingGroup({ snap: c && c.snap, typed, insertable: c && c.canInsert }); return g ? g.group : null; },
      choose: async (c, key, typed) => { chose.push([c === captured, key, typed]); return { ok: true }; },
    },
  };
}

test("the EMPTY box leads with the writing group when a selection was captured; the other groups follow", async () => {
  const f = facade(SEL);
  const l = launcher({ assist: f.assist });
  l.__armAssist(Promise.resolve(f.captured));
  const r = await l.search("");
  assert.equal(r.groups[0].id, "assist");
  assert.equal(r.groups[0].shown[0].key, "assist:rewrite");
});

test("with NOTHING selected and no text field, Alt+Space is exactly what it was", async () => {
  const f = facade({ ok: true, app: "explorer", selection: "", editable: false });
  const withAssist = launcher({ assist: f.assist });
  withAssist.__armAssist(Promise.resolve(f.captured));
  const plain = launcher();
  const a = await withAssist.search("");
  const b = await plain.search("");
  assert.deepEqual(a.groups.map((g) => g.id), b.groups.map((g) => g.id));
  assert.equal(a.status, b.status);
  const none = launcher({ assist: f.assist });
  none.__armAssist(Promise.resolve(null));
  assert.deepEqual((await none.search("")).groups.map((g) => g.id), b.groups.map((g) => g.id), "a capture that failed changes nothing");
});

test("typed words: the Write row is first, then the ordinary search results and the Ask Aither row", async () => {
  const f = facade(SEL);
  const l = launcher({
    assist: f.assist,
    answer: (term, opts) => ({ ok: true, query: term, phase: opts.phase, groups: [{ id: "apps", label: "Apps on this PC", total: 1, items: [{ key: "a:1", group: "apps", kind: "app", title: "Notepad", subtitle: "", target: "Notepad", score: 80 }] }], errors: [], notes: [], total: 1 }),
  });
  l.__armAssist(Promise.resolve(f.captured));
  const r = await l.search("make it formal");
  assert.deepEqual(r.groups.map((g) => g.id).slice(0, 3), ["assist", "apps", "ask"]);
  assert.equal(r.groups[0].shown[0].title, "Write: make it formal");
});

test("a verb or a scope word is not a writing request: no writing group", async () => {
  const f = facade(SEL);
  const l = launcher({ assist: f.assist });
  l.__armAssist(Promise.resolve(f.captured));
  const r = await l.search("app notepad");
  assert.ok(!r.groups.some((g) => g.id === "assist"));
});

test("choosing a writing row hides the box FIRST, then opens the pop-up at the original caret with the typed words", async () => {
  const f = facade(SEL);
  const l = launcher({ assist: f.assist });
  l.__armAssist(Promise.resolve(f.captured));
  const r = await l.runRow("assist:rewrite", "ignored");
  assert.equal(r.ok, true);
  assert.deepEqual(f.chose, [[true, "assist:rewrite", "ignored"]], "the capture taken at key-down is the one used");
  const gone = launcher({ assist: f.assist });
  gone.__armAssist(null);
  f.chose.length = 0;
  assert.equal((await gone.runRow("assist:rewrite", "")).ok, true);
  assert.equal(f.chose[0][0], false, "no capture: choose is told so and answers the error itself");
});

test("a launcher built without the writing option refuses an assist row instead of throwing", async () => {
  const l = launcher();
  const r = await l.runRow("assist:rewrite", "");
  assert.equal(r.ok, false);
  assert.match(r.error, /not wired/);
});

test("the press path captures on KEY-DOWN, next to hostContext, before showAtCursor", () => {
  const src = fs.readFileSync(path.join(__dirname, "launcher-window.cjs"), "utf8");
  const press = src.slice(src.indexOf("  function press() {"), src.indexOf("  /** The renderer saw Space/Alt come up. */"));
  const call = press.indexOf("    showAtCursor();");
  assert.ok(press.indexOf("pressAssist = assist") > 0 && press.indexOf("pressAssist = assist") < call, "capture starts before the box takes focus");
  assert.ok(press.indexOf("pressContext = hostContext") < call);
});

// ---- the window side ----------------------------------------------------------------------

function fakeWindow(snap) {
  const handlers = new Map();
  const wins = [];
  class W {
    constructor() { wins.push(this); this.webContents = { send() {}, setWindowOpenHandler() {}, on() {}, isLoading: () => false }; this.vis = false; }
    on() {} setAlwaysOnTop() {} loadFile() { return Promise.resolve(); } isDestroyed() { return false; } isVisible() { return this.vis; }
    show() { this.vis = true; } showInactive() { this.vis = true; } hide() { this.vis = false; } focus() {} setBounds(b) { this.bounds = b; }
  }
  const electron = { BrowserWindow: W, ipcMain: { handle: (c, f) => handlers.set(c, f) }, screen: { getCursorScreenPoint: () => ({ x: 5, y: 5 }), getDisplayNearestPoint: () => ({ workArea: { x: 0, y: 0, width: 1920, height: 1040 } }) }, clipboard: { readText: () => "" } };
  const engine = { settings: () => ({ agent: "aither" }), suggest: () => ({ ok: true, chips: [], send: { text: "s" }, refine: null }), run: async () => ({ ok: true }), route: async () => ({ ok: true }), note: () => ({ ok: true }) };
  const w = createAssistWindow({ electron, engine, caret: { snapshot: async () => snap, setClipboard() {} }, agents: [] });
  return { w, wins };
}

test("window.launcher: capture does NOT show anything; choose presents the captured session with the verb auto-running", async () => {
  const { w, wins } = fakeWindow(SEL);
  const cap = await w.launcher.capture();
  assert.equal(wins.length, 0, "capturing is silent: no window, no focus");
  assert.equal(cap.ctx.selection, SEL.selection);
  const r = await w.launcher.choose(cap, "assist:rewrite", "");
  assert.ok(r.ok);
  assert.deepEqual(w.state().autoRun, { verb: "rewrite", prompt: "", insert: true });
  await w.launcher.choose(cap, "assist:write", "make it formal");
  assert.deepEqual(w.state().autoRun, { verb: "write", prompt: "make it formal", insert: true });
  const ask = await w.launcher.choose(cap, "assist:translate", "");
  assert.equal(w.state().autoRun, null);
  assert.equal(w.state().initialVerb, "translate", "translate opens its language question");
  assert.equal(ask.ok, true);
});

test("window.launcher: a capture that lost the focus race (the desk itself) offers nothing; a stale or forged key is refused", async () => {
  const mine = fakeWindow({ ...SEL, pid: process.pid });
  const cap = await mine.w.launcher.capture();
  assert.equal(mine.w.launcher.group(cap, ""), null);
  const { w } = fakeWindow(SEL);
  const c = await w.launcher.capture();
  assert.equal(w.launcher.choose(c, "assist:drop-tables", "").ok, false);
  assert.equal(w.launcher.choose(null, "assist:rewrite", "").ok, false);
  const pw = fakeWindow({ ok: true, sensitive: true, hwnd: 5, pid: 6, app: "chrome" });
  assert.equal(pw.w.launcher.group(await pw.w.launcher.capture(), "hi"), null, "a password field shows no writing rows");
});

test("a terminal host is never a paste target from Alt+Space either: answer-only rows", async () => {
  const { w } = fakeWindow({ ...SEL, app: "WindowsTerminal" });
  const g = w.launcher.group(await w.launcher.capture(), "");
  assert.deepEqual(g.items.map((i) => i.key), ["assist:explain", "assist:summarize", "assist:translate", "assist:send-agent"]);
});

test("the pop-up page runs the verb at once and inserts a TRANSFORM result with Undo ready, never an answer", () => {
  const html = fs.readFileSync(path.join(__dirname, "assist.html"), "utf8");
  assert.match(html, /async function autoRunNow\(a\)/);
  assert.match(html, /a\.insert && last && last\.kind === "transform"/);
  assert.match(html, /\$\("accept"\)\.click\(\)/);
});

// ---- the hidden alias ---------------------------------------------------------------------

test("Ctrl+Alt+J stays bound as a hidden alias and is printed nowhere", () => {
  const row = registry.byId("assist.open");
  assert.equal(row.accel, "Ctrl+Alt+J");
  assert.equal(row.hiddenAccel, true);
  assert.ok(registry.shortcuts().some((s) => s.accel === "Ctrl+Alt+J"), "the chord is still registered");
  assert.equal(registry.labelOf(row, {}).includes("Ctrl+Alt+J"), false, "no menu label carries it");
  assert.equal(registry.accelFor("assist.open", {}), null, "no hint may advertise it");
  assert.equal(registry.accelFor("search.universal", {}), "Alt+Space", "Alt+Space is the advertised key");
  for (const f of ["launcher.html", "assist.html", "command-registry.cjs", "assist-main.cjs", "assist-core.cjs"]) {
    const src = fs.readFileSync(path.join(__dirname, f), "utf8").split("\n").filter((l) => !/hiddenAccel|accel: "Ctrl\+Alt\+J"/.test(l)).join("\n");
    assert.equal(/Ctrl\+Alt\+J/.test(src), false, `${f} still mentions Ctrl+Alt+J`);
  }
});
