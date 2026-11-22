"use strict";

/** assist-caret: snapshot parsing, the password rule, the two chords, placement, the worker wire. */

const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const caretLib = require("./assist-caret.cjs");

test("a password field yields ONLY {sensitive:true}: no text leaves the parser", () => {
  const out = caretLib.parseSnapshot(JSON.stringify({ ok: true, sensitive: true, hwnd: 5, selection: "hunter2", field: "hunter2", caret: { x: 1, y: 2, h: 3 } }));
  assert.equal(out.sensitive, true);
  assert.equal(out.selection, undefined);
  assert.equal(out.field, undefined);
  assert.equal(out.caret, undefined);
});

test("snapshot parsing caps text, validates the caret, and survives garbage", () => {
  const out = caretLib.parseSnapshot(`noise\n${JSON.stringify({ ok: true, hwnd: 9, pid: 4, app: "chrome", selection: "s".repeat(99999), field: "f".repeat(99999), caret: { x: "12", y: 30.6, h: 18, via: "caret" }, canInsert: true })}`);
  assert.equal(out.selection.length, caretLib.SELECTION_MAX);
  assert.equal(out.field.length, caretLib.FIELD_MAX);
  assert.deepEqual(out.caret, { x: 12, y: 31, h: 18, via: "caret" });
  assert.equal(caretLib.parseSnapshot("nope").ok, false);
  assert.equal(caretLib.parseSnapshot(JSON.stringify({ ok: true, caret: { x: "abc", y: 1 } })).caret, null);
});

test("only paste and undo exist as chords", () => {
  assert.equal(caretLib.keysFor("paste"), "^v");
  assert.equal(caretLib.keysFor("undo"), "^z");
  assert.equal(caretLib.keysFor("focus"), "", "focus sends no key at all");
  assert.equal(caretLib.keysFor("^c"), null);
  assert.equal(caretLib.keysFor("%{F4}"), null);
});

test("the worker script picks the chord from a word and refuses anything else", () => {
  assert.match(caretLib.WORKER_SCRIPT, /'paste' \{ '\^v' \}/);
  assert.match(caretLib.WORKER_SCRIPT, /refused-chord/);
  assert.match(caretLib.WORKER_SCRIPT, /IsPassword/);
  assert.equal((caretLib.WORKER_SCRIPT.match(/SendWait/g) || []).length, 1, "ONE place injects a key");
  assert.match(caretLib.WORKER_SCRIPT, /if \(\$chord\) \{ \[System\.Windows\.Forms\.SendKeys\]::SendWait\(\$chord\) \}/, "focus sends nothing");
});

test("popup placement: under the caret, flipped above at the bottom edge, clamped to the display", () => {
  const work = { x: 0, y: 0, width: 1920, height: 1040 };
  const size = { width: 460, height: 360 };
  assert.deepEqual(caretLib.placePopup({ caret: { x: 100, y: 200, h: 18 }, size, work }), { x: 100, y: 226 });
  assert.deepEqual(caretLib.placePopup({ caret: { x: 100, y: 1000, h: 18 }, size, work }), { x: 100, y: 632 });
  assert.equal(caretLib.placePopup({ caret: { x: 1900, y: 100, h: 10 }, size, work }).x, 1920 - 460 - 8);
  assert.deepEqual(caretLib.placePopup({ caret: null, fallback: { x: 50, y: 60 }, size, work }), { x: 50, y: 68 });
});

function fakeSpawn(answers) {
  const procs = [];
  const spawn = () => {
    const p = new EventEmitter();
    p.stdout = new EventEmitter();
    p.stdout.setEncoding = () => {};
    p.written = [];
    p.stdin = { write: (s) => { p.written.push(s); const line = s.trim(); if (line.startsWith("snap") || line.startsWith("keys")) setImmediate(() => p.stdout.emit("data", `${answers(line)}\n`)); else setImmediate(() => p.stdout.emit("data", '{"ready":true}\n')); } };
    p.kill = () => { p.killed = true; };
    procs.push(p);
    return p;
  };
  return { spawn, procs };
}

test("the worker starts once, serialises requests, and the caret API maps answers", async () => {
  const { spawn, procs } = fakeSpawn((line) => (line.startsWith("snap") ? JSON.stringify({ ok: true, hwnd: 77, pid: 3, app: "notepad", selection: "sel", field: "all", canInsert: true, caret: { x: 5, y: 6, h: 7 } }) : '{"ok":true}'));
  const clip = { snapshot: () => ({ t: "orig" }), write: (t) => { clip.wrote = t; }, restore: (s) => { clip.restored = s; } };
  const caret = caretLib.createCaret({ spawn, platform: "win32", clipboard: clip, sleep: async () => {}, excludePids: [9] });
  const snap = await caret.snapshot();
  assert.equal(snap.app, "notepad");
  assert.equal(snap.hwnd, 77);
  assert.equal(procs.length, 1);
  assert.ok(procs[0].written.some((w) => w.trim() === "snap 9"));
  const ins = await caret.insert({ hwnd: 77, text: "hello" });
  assert.ok(ins.ok);
  assert.equal(clip.wrote, "hello");
  assert.deepEqual(clip.restored, { t: "orig" }, "the owner's clipboard comes back");
  assert.ok(procs[0].written.some((w) => w.trim() === "keys 77 paste"));
  assert.ok((await caret.undo({ hwnd: 77 })).ok);
  assert.ok(procs[0].written.some((w) => w.trim() === "keys 77 undo"));
  assert.equal(procs.length, 1, "one worker for every call");
  caret.stop();
});

test("insert refuses without a clipboard port, an empty text, or a target window; a bad chord never reaches the worker", async () => {
  const { spawn, procs } = fakeSpawn(() => '{"ok":true}');
  const caret = caretLib.createCaret({ spawn, platform: "win32", sleep: async () => {} });
  assert.equal((await caret.insert({ hwnd: 1, text: "x" })).reason, "no-clipboard");
  caret.setClipboard({ snapshot: () => ({}), write: () => {}, restore: () => {} });
  assert.equal((await caret.insert({ hwnd: 1, text: "" })).reason, "empty");
  assert.equal((await caret.insert({ hwnd: 0, text: "x" })).reason, "no-target-window");
  assert.equal((await caret.sendKeys(1, "^c")).reason, "refused-chord");
  assert.equal(procs.length, 0, "none of those started a worker");
});

test("off Windows every call is a stated 'unsupported', never a throw", async () => {
  const caret = caretLib.createCaret({ platform: "linux", clipboard: { snapshot: () => ({}), write: () => {}, restore: () => {} } });
  assert.equal((await caret.snapshot()).reason, "unsupported");
  assert.equal((await caret.insert({ hwnd: 3, text: "x" })).reason, "unsupported");
});

test("a worker that never answers is dropped with a timeout and the next call respawns it", async () => {
  let n = 0;
  const procs = [];
  const spawn = () => {
    const p = new EventEmitter();
    p.stdout = new EventEmitter(); p.stdout.setEncoding = () => {};
    const me = (n += 1);
    p.stdin = { write: (s) => { if (!/^(snap|keys)/.test(s.trim())) setImmediate(() => p.stdout.emit("data", '{"ready":true}\n')); else if (me > 1) setImmediate(() => p.stdout.emit("data", '{"ok":true,"app":"late"}\n')); } };
    p.kill = () => { p.killed = true; };
    procs.push(p);
    return p;
  };
  const caret = caretLib.createCaret({ spawn, platform: "win32", timeoutMs: 40 });
  const first = await caret.snapshot();
  assert.equal(first.ok, false);
  assert.equal(first.reason, "worker-timeout");
  assert.ok(procs[0].killed);
  const second = await caret.snapshot();
  assert.equal(second.app, "late");
  assert.equal(procs.length, 2);
});
