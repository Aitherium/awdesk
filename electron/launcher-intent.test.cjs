"use strict";

/**
 * The intent bar inside the Alt+Space launcher (launcher-window.cjs + intent-bar.cjs):
 * `>` ranks the desk's commands (an argument after the name rides with a prompt row),
 * a sentence ends in a "Do it" row, Enter on it plans, runs what may run and holds the
 * rest for ONE confirm, and the empty box lists pinned + recent.
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const ib = require("./intent-bar.cjs");
const { createLauncher } = require("./launcher-window.cjs");

function harness({ plan = { steps: [] }, clipboardText = "" } = {}) {
  const ran = [];
  const asked = [];
  const memory = ib.createBarMemory({ file: path.join(fs.mkdtempSync(path.join(os.tmpdir(), "launcher-intent-")), "bar.json") });
  const bar = ib.createIntentBar({ memory, chat: async ({ messages }) => { harness.lastMessages = messages; return { ok: true, text: JSON.stringify(plan) }; },
    runTool: async (id, args) => { ran.push([id, args]); return { ok: true, did: `${id} ran` }; } });
  const electron = {
    BrowserWindow: class {}, ipcMain: { handle() {}, on() {} },
    screen: { getCursorScreenPoint: () => ({ x: 0, y: 0 }) }, shell: {}, clipboard: { readText: () => clipboardText },
  };
  const fake = { run: async (term, opts) => ({ ok: true, query: term, phase: opts.phase, groups: [], errors: [], notes: [], total: 0 }) };
  const l = createLauncher({ electron, registry: { byId: () => null }, quickMenu: {},
    run: async (id, arg) => { ran.push([id, arg]); return { ok: true }; },
    ask: async (t) => { asked.push(t); return { ok: true }; }, universalSearch: () => fake, intentBar: () => bar,
    looksSecret: (t) => /^sk-/.test(t) });
  return { l, ran, asked, memory };
}

test("`>` lists the desk's commands by fuzzy match; Enter runs the row and remembers it", async () => {
  const { l, ran, memory } = harness();
  const r = await l.search(">whiteboard");
  assert.equal(r.mode, "command");
  assert.equal(r.groups[0].id, "tools");
  const first = r.groups[0].shown[0];
  assert.equal(first.title, "New whiteboard");
  assert.equal(first.effect, "ui");
  const done = await l.runRow(first.key, "");
  assert.equal(done.ok, true);
  assert.deepEqual(ran, [["board.new", undefined]]);
  assert.deepEqual(memory.recent(), ["board.new"]);
});

test("`>timer 10m tea` offers the timer row WITH its argument; a prompt row without words says what to type", async () => {
  const { l, ran } = harness();
  const r = await l.search(">timer 10m tea");
  const row = r.groups[0].shown[0];
  assert.match(row.title, /^Start a timer… — “10m tea”$/);
  assert.equal((await l.runRow(row.key, "")).ok, true);
  assert.deepEqual(ran, [["timer.start", "10m tea"]]);
  const bare = await l.search(">timer");
  const refused = await l.runRow(bare.groups[0].shown[0].key, "");
  assert.equal(refused.ok, false);
  assert.match(refused.error, /needs words/);
});

test("a `>` row that changes something needs Enter twice on the same row", async () => {
  const { l, ran } = harness();
  const r = await l.search(">gpu sleep");
  const row = r.groups[0].shown.find((i) => /GPU sleep/.test(i.title));
  assert.match(row.subtitle, /Enter twice/);
  const first = await l.runRow(row.key, "");
  assert.equal(first.needsConfirm, true);
  assert.match(first.error, /^Enter again to run: GPU sleep \(game on\) \[write\]/);
  assert.deepEqual(ran, []);
  assert.equal((await l.runRow(row.key, "")).ok, true);
  assert.deepEqual(ran, [["fleet.gaming", undefined]]);
});

test("`>adk …` and `>awsh …` are still command lines, not command rows", async () => {
  const { l } = harness();
  const r = await l.search(">awsh status");
  assert.deepEqual(r.groups, []);
  assert.equal(r.mode, "command");
});

test("a sentence ends in “Do it”; Enter plans it, runs the window, and holds the change for one confirm", async () => {
  const { l, ran } = harness({ plan: { say: "Board up; GPU sleep needs you.", steps: [{ tool: "board.new" }, { tool: "fleet.gaming" }] } });
  const r = await l.search("give me a whiteboard and put the gpu to sleep");
  const ids = r.groups.map((g) => g.id);
  assert.deepEqual(ids.slice(-2), ["intent", "ask"], "Do it sits right above Ask Aither");
  const doIt = r.groups.find((g) => g.id === "intent").shown[0];
  const planned = await l.runRow(doIt.key, "");
  assert.equal(planned.kind, "intent");
  assert.deepEqual(ran, [["board.new", {}]]);
  assert.match(planned.pending.line, /^Enter to confirm: GPU sleep \(game on\) \[write\] — Esc cancels$/);
  assert.equal((await l.confirmIntent("not-the-id")).ok, false);
  const confirmed = await l.confirmIntent(planned.pending.id);
  assert.equal(confirmed.ok, true);
  assert.deepEqual(ran.map((x) => x[0]), ["board.new", "fleet.gaming"]);
  assert.equal((await l.confirmIntent(planned.pending.id)).ok, false, "one confirm, once");
});

test("Esc on a waiting plan runs nothing that changes anything", async () => {
  const { l, ran } = harness({ plan: { steps: [{ tool: "desk.restart" }] } });
  await l.search("restart the desk");
  const planned = await l.runIntent("restart the desk");
  assert.ok(planned.pending);
  assert.equal(l.cancelIntent(planned.pending.id).ok, true);
  assert.equal((await l.confirmIntent(planned.pending.id)).ok, false);
  assert.deepEqual(ran, []);
});

test("a secret on the clipboard is held back from the planner and the answer says so", async () => {
  const { l } = harness({ plan: { steps: [] }, clipboardText: "sk-live-123" });
  const planned = await l.runIntent("what is this");
  assert.deepEqual(planned.context, []);
  assert.match(planned.dropped.join(" "), /secret/);
  assert.doesNotMatch(JSON.stringify(harness.lastMessages), /sk-live-123/);
});

test("pinned and recent lead the empty box; Ctrl+P on a command row toggles its pin", async () => {
  const { l, memory } = harness();
  const r = await l.search(">fleet");
  const row = r.groups[0].shown[0];
  assert.equal(l.pinTool(row.key).pinned, true);
  memory.touch("note.new");
  const empty = await l.search("");
  const mine = empty.groups.filter((g) => g.id === "pinned" || g.id === "recent");
  assert.deepEqual(mine.map((g) => g.id), ["pinned", "recent"]);
  assert.equal(mine[0].shown[0].title, "★ Fleet window…");
  assert.equal(mine[1].shown[0].title, "New note");
  assert.equal(l.pinTool("tool:nothing").ok, false);
});
