"use strict";

/** assist-window: capture-before-show, the password refusal, accept/undo act on the CAPTURED window only. */

const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { createAssistWindow } = require("./assist-window.cjs");

function fakeElectron() {
  const handlers = new Map();
  let created = 0;
  const sent = [];
  const wins = [];
  class FakeWin extends EventEmitter {
    constructor() {
      super(); created += 1; wins.push(this);
      this.visible = false; this.destroyed = false; this.bounds = null;
      this.webContents = { id: 1, send: (ch, p) => sent.push([ch, p]), setWindowOpenHandler() {}, on() {}, isLoading: () => false };
    }
    setAlwaysOnTop() {} loadFile() { return Promise.resolve(); }
    isDestroyed() { return this.destroyed; } isVisible() { return this.visible; }
    show() { this.visible = true; } showInactive() { this.visible = true; this.inactive = true; } hide() { this.visible = false; } focus() {}
    setBounds(b) { this.bounds = b; }
  }
  const clip = { text: "", readText: () => clip.text, readHTML: () => "", readRTF: () => "", readImage: () => ({ isEmpty: () => true }), writeText: (t) => { clip.text = t; }, clear() {}, write() {} };
  const electron = {
    BrowserWindow: FakeWin,
    ipcMain: { handle: (ch, fn) => handlers.set(ch, fn) },
    screen: { getCursorScreenPoint: () => ({ x: 10, y: 10 }), screenToDipPoint: (pt) => ({ x: Math.round(pt.x / (global.__scale || 1)), y: Math.round(pt.y / (global.__scale || 1)) }), getDisplayNearestPoint: () => ({ workArea: { x: 0, y: 0, width: 1920, height: 1040 } }) },
    clipboard: clip,
  };
  return { electron, handlers, sent, wins, created: () => created };
}

function rig(snap) {
  const e = fakeElectron();
  const notes = [];
  const engine = {
    settings: () => ({ agent: "aither" }),
    suggest: (ctx) => ({ ok: true, chips: [{ text: "Reply", verb: "write" }], send: { text: "Sends nothing" }, refine: null, _ctx: ctx }),
    run: async (req) => ({ ok: true, id: "r1", verb: req.verb, kind: "transform", text: "Generated" }),
    route: async () => ({ ok: true }),
    note: (outcome, meta) => { notes.push([outcome, meta.verb]); return { ok: true }; },
  };
  const calls = [];
  const caret = {
    snapshot: async () => snap,
    insert: async (a) => { calls.push(["insert", a]); return { ok: true }; },
    undo: async (a) => { calls.push(["undo", a]); return { ok: true }; },
    setClipboard() {},
  };
  const w = createAssistWindow({ electron: e.electron, engine, caret, agents: ["aither"] });
  return { w, e, calls, notes, invoke: (ch, ...a) => e.handlers.get(ch)({ sender: e.wins[0].webContents }, ...a) };
}

const GOOD = { ok: true, hwnd: 4242, pid: 99999, app: "notepad", title: "x", canInsert: true, selection: "pick", field: "pick", caret: { x: 300, y: 400, h: 18 } };

test("open captures first, opens near the caret, and shows state without the window handle", async () => {
  const r = rig(GOOD);
  const res = await r.w.open();
  assert.ok(res.ok && res.hasSelection);
  const state = r.w.state();
  assert.equal(state.app, "notepad");
  assert.equal(state.canInsert, true);
  assert.equal(JSON.stringify(state).includes("4242"), false, "the renderer never learns the window handle");
  assert.ok(state.verbs.some((v) => v.id === "rewrite"), "selection verbs appear with a selection");
});

test("no selection: selection-only verbs are absent; a thread-less reply is absent", async () => {
  const r = rig({ ...GOOD, selection: "" });
  await r.w.open();
  const ids = r.w.state().verbs.map((v) => v.id);
  assert.equal(ids.includes("rewrite"), false);
  assert.equal(ids.includes("reply"), false);
});

test("a password field opens a refusal: no chips, no verbs, no field text anywhere", async () => {
  const r = rig({ ok: true, sensitive: true, hwnd: 5, pid: 6, app: "chrome" });
  const res = await r.w.open();
  assert.equal(res.refused, true);
  const s = r.w.state();
  assert.match(s.refused, /password/);
  assert.deepEqual(s.verbs, []);
  assert.deepEqual(s.chips, []);
});

test("the desk's own window is never a paste target", async () => {
  const r = rig({ ...GOOD, pid: process.pid });
  await r.w.open();
  assert.equal(r.w.state().canInsert, false);
});

test("accept logs first, hides, then pastes into the CAPTURED window; undo targets the same window", async () => {
  const r = rig(GOOD);
  await r.w.open();
  const gen = await r.invoke("assist:run", { verb: "rewrite", prompt: "" });
  assert.ok(gen.ok);
  const acc = await r.invoke("assist:accept", { text: "Edited text" });
  assert.ok(acc.ok);
  assert.deepEqual(r.notes[0], ["accepted", "rewrite"], "the decision is logged before the paste");
  assert.deepEqual(r.calls[0], ["insert", { hwnd: 4242, text: "Edited text" }]);
  assert.equal(r.w.isOpen(), true, "back on screen, inactive, so Undo is one click away");
  assert.equal(r.e.wins[0].inactive, true, "shown WITHOUT taking the focus from the app that was typed into");
  const undo = await r.invoke("assist:undo");
  assert.ok(undo.ok);
  assert.deepEqual(r.calls[1], ["undo", { hwnd: 4242 }]);
  assert.equal((await r.invoke("assist:undo")).ok, false, "nothing left to undo");
});

test("a renderer cannot name the window or the chord: extra fields are ignored", async () => {
  const r = rig(GOOD);
  await r.w.open();
  await r.invoke("assist:run", { verb: "write", prompt: "hi" });
  await r.invoke("assist:accept", { text: "t", hwnd: 1, keys: "%{F4}" });
  assert.equal(r.calls[0][1].hwnd, 4242);
  assert.equal(JSON.stringify(r.calls).includes("F4"), false);
});

test("accept refuses when the field cannot take text, and when there is nothing to insert", async () => {
  const r = rig({ ...GOOD, canInsert: false });
  await r.w.open();
  await r.invoke("assist:run", { verb: "write", prompt: "x" });
  assert.equal((await r.invoke("assist:accept", { text: "t" })).ok, false);
  assert.equal(r.calls.length, 0);
  const r2 = rig(GOOD);
  await r2.w.open();
  assert.equal((await r2.invoke("assist:accept", { text: "   " })).ok, false);
});

test("IPC from anything but the pop-up's own page is refused", async () => {
  const r = rig(GOOD);
  await r.w.open();
  const foreign = await r.e.handlers.get("assist:accept")({ sender: { id: 99 } }, { text: "x" });
  assert.equal(foreign.ok, false);
  assert.equal(r.calls.length, 0);
});

test("close after an unaccepted result logs 'cancelled' once", async () => {
  const r = rig(GOOD);
  await r.w.open();
  await r.invoke("assist:run", { verb: "write", prompt: "x" });
  await r.invoke("assist:close");
  await r.invoke("assist:close");
  assert.deepEqual(r.notes, [["cancelled", "write"]]);
});

test("open twice toggles closed", async () => {
  const r = rig(GOOD);
  await r.w.open();
  assert.equal((await r.w.open()).closed, true);
});

function fileRig(infoByPath, extra = {}) {
  const e = fakeElectron();
  const calls = [];
  const files = {
    inspect: (p) => infoByPath[String(Array.isArray(p) ? p[0] : p)] || { ok: false, error: "That file or folder is not there." },
    conversionsFor: () => [{ id: "png", label: "Image to PNG", available: true }],
    runVerb: async (a) => { calls.push(["runVerb", a.verb, a.info.path, a.prompt]); return { ok: true, id: "v1", verb: a.verb, kind: "answer", text: "Summary" }; },
    proposeRename: async (info) => { calls.push(["propose", info.path]); return { ok: true, from: info.path, to: "C:\\d\\New name.txt", name: "New name", extension: ".txt" }; },
    applyRename: (a) => { calls.push(["apply", a.from, a.name]); return { ok: true, from: a.from, to: "C:\\d\\New name.txt" }; },
    undoRename: () => { calls.push(["undo"]); return { ok: true, restored: "C:\\d\\a.txt" }; },
    convert: async (a) => { calls.push(["convert", a.to]); return { ok: true, text: "done" }; },
    sendToPipeline: async () => { calls.push(["pipeline"]); return { ok: true, text: "sent" }; },
    runPack: async (a) => { calls.push(["pack", a.pack, a.agent]); return { ok: true, text: "queued" }; },
    ...extra,
  };
  const engine = { settings: () => ({ agent: "hydra" }), suggest: () => ({ ok: true, chips: [], send: null }), run: async () => ({ ok: true }), route: async () => ({ ok: true }), note: () => ({ ok: true }) };
  const w = createAssistWindow({ electron: e.electron, engine, caret: { snapshot: async () => ({}), setClipboard() {} }, files });
  return { w, e, calls, invoke: (ch, ...a) => e.handlers.get(ch)({ sender: e.wins[0].webContents }, ...a) };
}

const FILE_A = { ok: true, kind: "file", path: "C:\\d\\a.txt", name: "a.txt", ext: ".txt", size: 2048, textable: true, text: "hello" };

test("openFile: the shell's path is inspected, the pop-up shows the file, no paste target exists", async () => {
  const r = fileRig({ "C:\\d\\a.txt": FILE_A });
  const res = await r.w.openFile({ path: "C:\\d\\a.txt", verb: "summarize" });
  assert.ok(res.ok);
  const s = r.w.state();
  assert.equal(s.file.name, "a.txt");
  assert.equal(s.canInsert, false);
  assert.equal(s.initialVerb, "summarize");
  assert.equal(JSON.stringify(s).includes("C:\\\\d\\\\a.txt"), false, "the renderer is not handed the full path");
  assert.deepEqual(s.file.conversions.map((c) => c.id), ["png"]);
});

test("openFile with a bad path shows the refusal and offers no verbs", async () => {
  const r = fileRig({});
  const res = await r.w.openFile({ path: "C:\\nope" });
  assert.equal(res.ok, false);
  assert.match(r.w.state().refused, /not there/);
  assert.equal(r.w.state().file, null);
});

test("assist:file acts only on the file the shell opened and maps each action", async () => {
  const r = fileRig({ "C:\\d\\a.txt": FILE_A });
  await r.w.openFile({ path: "C:\\d\\a.txt" });
  assert.ok((await r.invoke("assist:file", { action: "summarize" })).ok);
  assert.ok((await r.invoke("assist:file", { action: "ask", arg: "what is it?" })).ok);
  assert.ok((await r.invoke("assist:file", { action: "rename-propose" })).ok);
  assert.ok((await r.invoke("assist:file", { action: "rename-apply", arg: "New name" })).ok);
  assert.ok((await r.invoke("assist:file", { action: "rename-undo" })).ok);
  assert.ok((await r.invoke("assist:file", { action: "convert", arg: "png" })).ok);
  assert.ok((await r.invoke("assist:file", { action: "pipeline" })).ok);
  assert.ok((await r.invoke("assist:file", { action: "pack", arg: "dgg-research" })).ok);
  assert.deepEqual(r.calls.map((c) => c[0]), ["runVerb", "runVerb", "propose", "apply", "undo", "convert", "pipeline", "pack"]);
  assert.deepEqual(r.calls[1], ["runVerb", "ask", "C:\\d\\a.txt", "what is it?"]);
  assert.deepEqual(r.calls[3], ["apply", "C:\\d\\a.txt", "New name"], "the path comes from the session, not the page");
  assert.equal((await r.invoke("assist:file", { action: "delete" })).ok, false, "there is no delete action");
});

test("assist:file with no file open is refused", async () => {
  const r = rig(GOOD);
  await r.w.open();
  assert.equal((await r.invoke("assist:file", { action: "summarize" })).ok, false);
});

test("a whole-page 'element' rect is not a caret: the pop-up hangs off the mouse instead", async () => {
  const r = rig({ ...GOOD, caret: { x: 20, y: 100, h: 1900, via: "element" } });
  await r.w.open();
  const b = r.e.wins[0].bounds;
  assert.ok(b.x === 10 && b.y >= 10 && b.y < 100, `placed from the cursor (10,10), got ${JSON.stringify(b)}`);
  const r2 = rig({ ...GOOD, caret: { x: 300, y: 400, h: 20, via: "element" } });
  await r2.w.open();
  assert.equal(r2.e.wins[0].bounds.x, 300, "a small element rect is still a usable anchor");
});

test("UI Automation's physical pixels are converted to DIPs before the pop-up is placed", async () => {
  global.__scale = 2;
  try {
    const r = rig({ ...GOOD, caret: { x: 1200, y: 800, h: 40, via: "selection" } });
    await r.w.open();
    assert.deepEqual({ x: r.e.wins[0].bounds.x, y: r.e.wins[0].bounds.y }, { x: 600, y: 400 + 20 + 8 }, "x/2, and just under the DIP caret rect");
  } finally { delete global.__scale; }
});
