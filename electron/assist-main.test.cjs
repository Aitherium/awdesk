"use strict";

/** assist-main: Explorer verbs run ONLY from the shell menu; the bridge validates and rate-limits. */

const test = require("node:test");
const assert = require("node:assert/strict");
const { createAssistMain, cardConfirm } = require("./assist-main.cjs");

function fakeElectron() {
  class W { constructor() { this.webContents = { send() {}, setWindowOpenHandler() {}, on() {}, isLoading: () => false }; } on() {} setAlwaysOnTop() {} loadFile() { return Promise.resolve(); } isDestroyed() { return false; } isVisible() { return false; } show() {} hide() {} focus() {} setBounds() {} }
  return { BrowserWindow: W, ipcMain: { handle() {} }, screen: { getCursorScreenPoint: () => ({ x: 1, y: 1 }), getDisplayNearestPoint: () => ({ workArea: { x: 0, y: 0, width: 1920, height: 1040 } }) }, clipboard: { readText: () => "", writeText() {}, readHTML: () => "", readRTF: () => "", readImage: () => ({ isEmpty: () => true }), clear() {}, write() {} } };
}

function make() {
  const os = require("node:os"); const fs = require("node:fs"); const path = require("node:path");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "assist-main-"));
  const opened = [];
  const filesOverride = { inspect: (p) => { opened.push(p); return { ok: true, kind: "file", path: String(p), name: "a.txt", textable: true, text: "x" }; }, conversionsFor: () => [] };
  const m = createAssistMain({ electron: fakeElectron(), userDataDir: dir, spawn: () => { throw new Error("no worker in tests"); }, filesOverride, utilsOverride: { list: () => [], run: async () => ({ ok: false }), stop() {} }, post: async () => ({ status: 500, body: "{}" }) });
  return { m, opened, dir };
}

test("an Explorer file verb is refused from the bridge, the palette and any non-shell surface", async () => {
  const { m, opened } = make();
  for (const surface of ["bridge", "palette", "menu", "spirit", undefined]) {
    const r = await m.run("file:pipeline", { surface, arg: "C:\\Users\\me\\a.txt" });
    assert.equal(r.ok, false, String(surface));
    assert.match(r.error, /Explorer right-click/);
  }
  assert.equal(opened.length, 0, "the path was never even inspected");
  const ok = await m.run("file:summarize", { surface: "shell-menu", arg: "C:\\Users\\me\\a.txt" });
  assert.equal(ok.ok, true);
  assert.equal(opened.length, 1);
});

test("bridge: unknown routes refused, the limit is 30 a minute, a sensitive context is refused", async () => {
  const { m } = make();
  assert.equal((await m.bridge({ route: "nope", body: {} })).ok, false);
  const refused = await m.bridge({ route: "suggest", body: { ctx: { sensitive: true, selection: "pw" } } });
  assert.equal(refused.refused, true);
  let limited = 0;
  for (let i = 0; i < 40; i += 1) { const r = await m.bridge({ route: "suggest", body: { ctx: { selection: "x" } } }); if (r.status === 429) limited += 1; }
  assert.ok(limited >= 8, `limited ${limited}`);
});

test("the decision card fails closed: no gateway, an error, or an unreadable answer is not a yes", async () => {
  const opts = ["Send", "Do not send"];
  assert.equal(await cardConfirm(null)({ title: "t", options: opts }), null);
  assert.equal(await cardConfirm({ callTool: async () => { throw new Error("down"); } })({ title: "t", options: opts }), null);
  assert.equal(await cardConfirm({ callTool: async () => ({ content: [{ text: "not json" }] }) })({ title: "t", options: opts }), null);
  assert.equal(await cardConfirm({ callTool: async () => ({ content: [{ text: JSON.stringify({ answer: "Send" }) }] }) })({ title: "t", options: opts }), "Send");
  assert.equal(await cardConfirm({ callTool: async () => ({ content: [{ text: JSON.stringify({ answer: "Anything else" }) }] }) })({ title: "t", options: opts }), null);
});
