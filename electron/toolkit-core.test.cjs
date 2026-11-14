"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const core = require("./toolkit-core.cjs");

test("menu has three short groups, every id unique, missing tools drop out", () => {
  assert.deepEqual(core.MENU.map((g) => g.group), ["Create", "Capture", "Send"]);
  assert.equal(new Set(core.MENU_IDS).size, core.MENU_IDS.length);
  for (const g of core.MENU) assert.ok(g.items.length <= 7, `${g.group} stays short`);
  const only = core.menuGroups((id) => id === "snip.region");
  assert.deepEqual(only, [{ group: "Capture", items: [{ id: "snip.region", short: "Snip" }] }]);
  assert.deepEqual(core.menuGroups(() => { throw new Error("x"); }), []);
});

test("send targets: capture bodies carry the right `to` and refuse empty or oversize", () => {
  const notes = core.captureBody("notes", { text: "hello", title: "t" });
  assert.equal(notes.to, "notebook:desk-notes");
  assert.equal(notes.text, "hello");
  const img = core.captureBody("room", { kind: "image", name: "a.png", mime: "image/png", dataB64: "AAAA" });
  assert.equal(img.to, "thread:company");
  assert.deepEqual(img.attachments, [{ name: "a.png", mime: "image/png", data_b64: "AAAA" }]);
  assert.equal(core.captureBody("clipboard", { text: "x" }), null, "not a capture target");
  assert.match(core.captureBody("inbox", {}).error, /nothing/);
  assert.match(core.captureBody("inbox", { dataB64: "A".repeat(core.MAX_CAPTURE_B64 + 1) }).error, /limit/);
  assert.ok(core.publicTargets(false).every((t) => ["clipboard", "discord"].includes(t.id)));
  assert.ok(core.publicTargets(true).every((t) => !("via" in t)));
});

test("workspace isolation: keys are stable and cross-workspace delivery is refused", () => {
  assert.equal(core.workspaceKey(null), "personal");
  assert.equal(core.workspaceKey({ host: "Acme.Aitherium.com" }), "acme.aitherium.com");
  assert.equal(core.workspaceKey({ id: "t_42/../x" }), "t-42-..-x".replace("..", ".."));
  assert.ok(!core.workspaceKey({ id: "a/b\\c" }).includes("/"));
  assert.equal(core.mayDeliver("acme", "acme").ok, true);
  assert.equal(core.mayDeliver("acme", "personal").ok, false);
  assert.equal(core.mayDeliver("", "acme").ok, false);
});

test("save names never carry a path and only allowed types save", () => {
  const now = new Date(2026, 10, 13, 22, 5, 9);
  assert.equal(core.safeSaveName("..\\..\\evil.png", "image/png", "sketch", now), "evil.png");
  assert.equal(core.safeSaveName("", "audio/midi", "piano", now), "piano-20261113-220509.mid");
  assert.equal(core.safeSaveName("x.exe", "application/x-msdownload", "piano", now), null);
  assert.equal(core.safeSaveName("melody.mid", "audio/midi", "piano", now), "melody.mid");
});

test("voice commands: short verbs map, conversation does not", () => {
  assert.deepEqual(core.parseVoiceCommand("Record this."), { id: "record.region", arg: null });
  assert.deepEqual(core.parseVoiceCommand("hey aither, draw"), { id: "ink.toggle", arg: null });
  assert.deepEqual(core.parseVoiceCommand("open whiteboard"), { id: "board.new", arg: null });
  assert.deepEqual(core.parseVoiceCommand("send to Jason"), { id: "send.last", arg: "person:jason" });
  assert.deepEqual(core.parseVoiceCommand("send it to notes"), { id: "send.last", arg: "notes" });
  assert.deepEqual(core.parseVoiceCommand("mute"), { id: "voice.mute", arg: null });
  assert.equal(core.parseVoiceCommand("can you draw me a picture of the quarterly revenue trend"), null);
  assert.equal(core.parseVoiceCommand("what do you think about the board meeting"), null);
  assert.equal(core.parseVoiceCommand(""), null);
});

test("wake word: open mic acts only on the word; push-to-talk never needs it", () => {
  assert.deepEqual(core.wakeGate("record this", { wakeWord: "aither", openMic: true }), { pass: false, text: "" });
  assert.deepEqual(core.wakeGate("Hey Aither, record this", { wakeWord: "aither", openMic: true }), { pass: true, text: "record this" });
  assert.deepEqual(core.wakeGate("record this", { wakeWord: "aither", openMic: false }), { pass: true, text: "record this" });
  assert.deepEqual(core.wakeGate("record this", { openMic: true }), { pass: true, text: "record this" });
  assert.deepEqual(core.wakeGate("aither draw", { wakeWord: "aither", openMic: true }), { pass: true, text: "draw" });
});

test("frame budget: idle work falls off and hidden draws nothing", () => {
  assert.equal(core.frameBudget({ hidden: true, audible: true }), 0);
  assert.equal(core.frameBudget({ audible: true }), 60);
  assert.equal(core.frameBudget({ sinceInputMs: 100 }), 30);
  assert.equal(core.frameBudget({ sinceInputMs: 5000 }), 20);
  assert.equal(core.frameBudget({}), 10);
});

test("cropRect maps DIPs to device pixels inside one display and refuses slivers", () => {
  const display = { bounds: { x: 1920, y: 0, width: 1920, height: 1080 }, scaleFactor: 2 };
  assert.deepEqual(core.cropRect({ x: 2000, y: 100, width: 300, height: 200 }, display),
    { x: 160, y: 200, width: 600, height: 400 });
  assert.equal(core.cropRect({ x: 0, y: 0, width: 100, height: 100 }, display), null);
});

test("graphics: actions resolve and resize keeps aspect under the cap", () => {
  assert.equal(core.graphicsAction("remove_bg").mf, "remove_bg");
  assert.equal(core.graphicsAction("nope"), null);
  assert.deepEqual(core.resizeDims({ width: 400, height: 200 }, { width: 100 }), { width: 100, height: 50 });
  assert.deepEqual(core.resizeDims({ width: 400, height: 200 }, { scale: 100 }), { width: 8192, height: 4096 });
  assert.deepEqual(core.resizeDims({ width: 400, height: 200 }, {}), { width: 400, height: 200 });
});
