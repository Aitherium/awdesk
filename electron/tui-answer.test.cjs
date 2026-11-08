"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const tui = require("./tui-answer.cjs");

const CARD = { id: "d-ask1", agent: "claude-code", sessionId: "s1", options: [{ key: "tui:2" }] };

test("only a claude-code card with a tui key is a terminal answer", () => {
  assert.deepEqual(tui.tuiAction(CARD, "tui:2"), { keys: "2" });
  assert.deepEqual(tui.tuiAction(CARD, "tui:type"), { keys: "" });
  assert.deepEqual(tui.tuiAction({ source: { agent: "claude-code" } }, "tui:1"), { keys: "1" });
  assert.equal(tui.tuiAction(CARD, "ack"), null);
  assert.equal(tui.tuiAction(CARD, "tui:0"), null);
  assert.equal(tui.tuiAction(CARD, "tui:10"), null);
  assert.equal(tui.tuiAction(CARD, "tui:2; rm"), null);
  assert.equal(tui.tuiAction({ ...CARD, agent: "codex" }, "tui:2"), null);
  assert.equal(tui.tuiAction(null, "tui:2"), null);
});

function deps({ typeResult, recordResult = true, name = "fix the mail plane" } = {}) {
  const calls = { type: [], record: [] };
  return {
    calls,
    sessionName: async () => name,
    type: async (n, k) => { calls.type.push([n, k]); return typeResult; },
    record: (id, key, note) => { calls.record.push([id, key, note]); return recordResult; },
  };
}

test("a confirmed focus types the digit, then records the answer", async () => {
  const d = deps({ typeResult: { ok: true, typed: true, tab: "fix the mail plane" } });
  const r = await tui.answerInTerminal(CARD, "tui:2", d);
  assert.equal(r.ok, true);
  assert.deepEqual(d.calls.type, [["fix the mail plane", "2"]]);
  assert.equal(d.calls.record.length, 1);
  assert.equal(d.calls.record[0][1], "tui:2");
});

test("fail closed: an unconfirmed focus records nothing and says open the session", async () => {
  const d = deps({ typeResult: { ok: false, typed: false, error: "could not confirm the session is in front" } });
  const r = await tui.answerInTerminal(CARD, "tui:3", d);
  assert.equal(r.ok, false);
  assert.equal(r.handled, true);
  assert.equal(r.flash, tui.FLASH_OPEN_SESSION);
  assert.equal(d.calls.record.length, 0);
});

test("a throwing typer is a failure, not a crash", async () => {
  const d = deps();
  d.type = async () => { throw new Error("spawn EPERM"); };
  const r = await tui.answerInTerminal(CARD, "tui:1", d);
  assert.equal(r.ok, false);
  assert.equal(d.calls.record.length, 0);
});

test("an ordinary answer is not handled here", async () => {
  const d = deps({ typeResult: { ok: true } });
  const r = await tui.answerInTerminal(CARD, "later", d);
  assert.deepEqual(r, { ok: false, handled: false });
  assert.equal(d.calls.type.length, 0);
});

test("the script confirms the foreground before it types, and sends no Enter", () => {
  const s = tui.typeScript();
  const confirm = s.indexOf("$fg = [AitherTui]::GetForegroundWindow()");
  const send = s.indexOf("SendKeys]::SendWait");
  assert.ok(confirm > 0 && send > confirm, "the foreground check precedes the keystroke");
  assert.ok(s.includes("IsSelected"), "the tab's selection is re-read");
  assert.ok(!/\{ENTER\}|~/.test(s.slice(send)), "no Enter is sent");
  assert.ok(s.includes("'^[1-9]?$'"), "the script refuses anything but one digit");
});

test("typeIntoSession refuses a non-digit before spawning anything", async () => {
  let spawned = false;
  const spawn = () => { spawned = true; throw new Error("no"); };
  const r = await tui.typeIntoSession("fix the mail plane", "2{ENTER}", { spawn, platform: "win32" });
  assert.equal(r.ok, false);
  assert.equal(spawned, false);
});

test("typeIntoSession feeds the name and digit on stdin and parses the verdict", async () => {
  let stdinText = "";
  const spawn = (cmd, argv, opts) => {
    assert.equal(cmd, "powershell.exe");
    assert.equal(opts.windowsHide, true);
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stdout.setEncoding = () => {};
    child.kill = () => {};
    child.stdin = {
      end: (t) => {
        stdinText = t;
        setImmediate(() => {
          child.stdout.emit("data", '{"ok":true,"typed":true,"tab":"fix the mail plane"}\r\n');
          child.emit("close", 0);
        });
      },
    };
    return child;
  };
  const r = await tui.typeIntoSession("fix the mail plane", "2", { spawn, platform: "win32" });
  assert.equal(stdinText, "fix the mail plane\n2\n");
  assert.deepEqual(r, { ok: true, typed: true, tab: "fix the mail plane", error: undefined });
});

test("off Windows nothing is typed", async () => {
  const r = await tui.typeIntoSession("fix the mail plane", "1", { platform: "linux" });
  assert.equal(r.ok, false);
});
