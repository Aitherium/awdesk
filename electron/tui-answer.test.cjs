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

test("a number answer focuses the session but never claims it reached it", async () => {
  // Measured 2026-11-08: SendKeys reported typed:true and the probe tab got nothing.
  // Even a typer that SAYS it typed must not make the desk record the answer.
  const d = deps({ typeResult: { ok: true, typed: true, tab: "fix the mail plane" } });
  const r = await tui.answerInTerminal(CARD, "tui:2", d);
  assert.equal(r.ok, false);
  assert.equal(r.typed, false);
  assert.equal(r.flash, tui.FLASH_IN_FRONT);
  assert.equal(d.calls.record.length, 0, "the card stays open: nothing was answered");
});

test("Type something focuses the session and records that it was opened", async () => {
  const d = deps({ typeResult: { ok: true, typed: false, tab: "fix the mail plane" } });
  const r = await tui.answerInTerminal(CARD, "tui:type", d);
  assert.equal(r.ok, true);
  assert.equal(r.typed, false);
  assert.deepEqual(d.calls.type, [["fix the mail plane", ""]]);
  assert.match(d.calls.record[0][2], /opened the session/);
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

test("the script confirms the foreground and sends no keystroke at all", () => {
  const s = tui.typeScript();
  assert.ok(s.includes("$fg = [AitherTui]::GetForegroundWindow()"));
  assert.ok(s.includes("IsSelected"), "the tab's selection is re-read");
  assert.ok(!/SendKeys|SendInput|keybd_event|PostMessage|WM_CHAR/.test(s), "no keystroke API");
  assert.ok(!/typed = \$true|typed = \[bool\]/.test(s), "the script never reports typed");
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
  // Even if the script claimed typed:true, typeIntoSession never passes it on.
  assert.deepEqual(r, { ok: true, typed: false, tab: "fix the mail plane", error: undefined });
});

test("off Windows nothing is typed", async () => {
  const r = await tui.typeIntoSession("fix the mail plane", "1", { platform: "linux" });
  assert.equal(r.ok, false);
});
