"use strict";

// canvas-widgets.cjs + electron/canvas-widgets/*.cjs: a widget is ONE file, and every
// answer is shape-checked before it reaches the canvas page.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const W = require("./canvas-widgets.cjs");

test("the shipped widgets load, conform, and include the six the canvas promises", () => {
  const reg = W.loadRegistry();
  assert.deepEqual(reg.problems(), []);
  const ids = reg.list().map((w) => w.id).sort();
  assert.deepEqual(ids, ["clock", "inbox", "inference", "note", "sessions", "system"]);
  for (const w of reg.list()) {
    assert.ok(W.VIEWS.includes(w.view));
    assert.equal(typeof w.read, "undefined", "the page never receives a reader");
  }
});

test("a new widget is ONE file: drop it in the directory and it is listed", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "canvas-widgets-"));
  try {
    fs.writeFileSync(path.join(dir, "weather.cjs"),
      'module.exports = { id: "weather", label: "Weather", view: "stat", size: { w: 200, h: 120 }, refreshMs: 60000, read: async () => ({ value: 21, sub: "sunny" }) };');
    fs.writeFileSync(path.join(dir, "broken.cjs"), 'module.exports = { id: "wrong-name", label: "x", view: "stat", size: { w: 200, h: 120 } };');
    const reg = W.loadRegistry(dir);
    assert.deepEqual(reg.list().map((w) => w.id), ["weather"]);
    const problems = reg.problems().join(" | ");
    assert.match(problems, /must match the file name/);
    assert.match(problems, /needs read\(ctx\)/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("answers are shape-checked: five rows then +N more, strings cut, tones from the list", async () => {
  const reg = W.createRegistry([{ file: "big.cjs", mod: { id: "big", label: "Big", view: "list", size: { w: 200, h: 120 },
    read: async () => ({ rows: Array.from({ length: 8 }, (_, i) => ({ label: `row ${i}\u0007`, value: i, tone: i ? "ok" : "neon" })) }) } }]);
  const r = await reg.read("big");
  assert.equal(r.ok, true);
  assert.equal(r.rows.length, 5);
  assert.equal(r.more, 3);
  assert.equal(r.rows[0].label, "row 0 ", "control characters never reach the page");
  assert.equal(r.rows[0].tone, "muted", "an unknown tone falls back");
  assert.equal(r.rows[1].value, "1");
});

test("a reader that throws or answers ok:false is an error card, never a crash", async () => {
  const reg = W.createRegistry([
    { file: "boom.cjs", mod: { id: "boom", label: "Boom", view: "stat", size: { w: 200, h: 120 }, read: async () => { throw new Error("daemon down"); } } },
    { file: "nope.cjs", mod: { id: "nope", label: "Nope", view: "stat", size: { w: 200, h: 120 }, read: async () => ({ ok: false, error: "signed out" }) } },
  ]);
  assert.deepEqual(await reg.read("boom"), { ok: false, view: "stat", error: "daemon down" });
  assert.deepEqual(await reg.read("nope"), { ok: false, view: "stat", error: "signed out" });
  assert.equal((await reg.read("ghost")).ok, false);
});

test("the shipped readers turn their sources into read-outs (fakes for each source)", async () => {
  const reg = W.loadRegistry();
  const inbox = await reg.read("inbox", { inbox: () => 3 });
  assert.deepEqual([inbox.value, inbox.tone], [3, "warn"]);
  assert.equal((await reg.read("inbox", {})).ok, false, "no source = says so");
  const sessions = await reg.read("sessions", { sessions: async () => ({ ok: true, sessions: [
    { id: "a", label: "Claude Code", state: "running" }, { id: "b", label: "Shell", state: "exited" }] }) });
  assert.equal(sessions.rows.length, 2);
  assert.equal(sessions.rows[0].tone, "ok");
  assert.equal(sessions.sub, "2 sessions");
  const down = await reg.read("sessions", { sessions: async () => ({ ok: false, error: "the awsh daemon did not answer" }) });
  assert.equal(down.ok, false);
  const inf = await reg.read("inference", { inference: async () => ({ ok: true, reported: true,
    rows: [{ models: [{ key: "n:a", name: "bonsai", state: "serving", waiting: 2 }, { key: "n:b", name: "orch", state: "down" }] }] }) });
  assert.equal(inf.sub, "1/2 serving");
  assert.deepEqual(inf.rows.map((x) => x.tone), ["ok", "bad"]);
  const fakeOs = { cpus: () => [{ times: { user: 1, nice: 0, sys: 1, idle: 8, irq: 0 } }], totalmem: () => 16 * 1024 ** 3,
    freemem: () => 4 * 1024 ** 3, uptime: () => 90000, hostname: () => "box" };
  require("./canvas-widgets/system.cjs").reset();
  const sys = await reg.read("system", { os: fakeOs });
  assert.equal(sys.sub, "box");
  assert.equal(sys.rows[0].value, "measuring", "the first CPU read has nothing to diff against");
  assert.equal(sys.rows[1].value, "12.0 GB / 16.0 GB");
});
