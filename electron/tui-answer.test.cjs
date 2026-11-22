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

test("fail closed: an unconfirmed focus records nothing and says why", async () => {
  const d = deps({ typeResult: { ok: false, typed: false, error: "could not confirm the session is in front" } });
  const r = await tui.answerInTerminal(CARD, "tui:3", d);
  assert.equal(r.ok, false);
  assert.equal(r.handled, true);
  assert.match(r.flash, /Windows kept it behind/);
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

// ── 2026-11-17, card d-yjmc ("Go live: openaw.org"): "Open the session" on the fairy's
// whisper flashed "Open the session to answer" and nothing came forward. ───────────

const D_YJMC = {
  id: "d-yjmc", agent: "claude-code", sessionId: "bf1f0eee-f1de-444b-9a5e-05dfe7dabd03",
  options: [{ key: "tui:type", label: "Open the session" }, { key: "later", label: "Not now" }],
};

test("d-yjmc: the script may raise the terminal from a desk window that never took focus", () => {
  // The whisper is focusable:false, so a bare SetForegroundWindow from the desk's child
  // is refused by Windows. The script must hand the foreground over through the
  // foreground thread's input queue -- and still send no keystroke.
  const s = tui.typeScript();
  assert.ok(s.includes("AttachThreadInput($me, $other, $true)"), "attaches to the foreground thread");
  assert.ok(s.includes("AttachThreadInput($me, $other, $false)"), "and detaches again");
  assert.ok(s.includes("SwitchToThisWindow"), "has a fallback raise");
  assert.ok(!/SendKeys|SendInput|keybd_event|PostMessage|WM_CHAR/.test(s), "no keystroke API");
  assert.ok(s.includes("'^[^"+String.fromCharCode(92)+"p{L}"+String.fromCharCode(92)+"p{N}]+'"), "the spinner glyph strip keeps its regex escapes");
});

test("d-yjmc: an exact tab name beats a prefix of another tab", () => {
  const s = tui.typeScript();
  const exact = s.indexOf("-eq $w");
  const prefix = s.indexOf("StartsWith($w)");
  assert.ok(exact > 0 && prefix > exact, "the exact pass runs before the prefix pass");
  assert.ok(s.includes("if (-not $found) { foreach ($w in $wants)"), "the prefix pass runs only when no tab matched exactly");
});

test("d-yjmc: a failed focus says WHY, never the bare 'Open the session to answer'", async () => {
  for (const error of ["no open terminal tab has that name (7 tabs open)", "Windows would not bring the terminal to the front", "the tab search timed out"]) {
    const d = deps({ name: "Domain name server config", typeResult: { ok: false, typed: false, error } });
    const r = await tui.answerInTerminal(D_YJMC, "tui:type", d);
    assert.equal(r.ok, false);
    assert.notEqual(r.flash, tui.FLASH_OPEN_SESSION, error);
    assert.match(r.flash, /Domain name server config/, error);
    assert.equal(d.calls.record.length, 0, "the card stays open");
  }
});

test("d-yjmc: every name the session goes by is tried (the tab and the journal can disagree)", async () => {
  const d = deps({ typeResult: { ok: true, typed: false, tab: "◑ Custom name server button" } });
  d.sessionName = async () => ["Domain name server config", "Custom name server button", "Domain name server config", "ab"];
  const r = await tui.answerInTerminal(D_YJMC, "tui:type", d);
  assert.equal(r.ok, true);
  assert.deepEqual(d.calls.type[0][0], ["Domain name server config", "Custom name server button"]);
});

test("d-yjmc: several names reach the script TAB-separated on stdin line 1", async () => {
  let stdinText = "";
  const spawn = () => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stdout.setEncoding = () => {};
    child.kill = () => {};
    child.stdin = { end: (t) => { stdinText = t; setImmediate(() => { child.stdout.emit("data", '{"ok":true,"tab":"x"}'); child.emit("close", 0); }); } };
    return child;
  };
  await tui.typeIntoSession(["Domain name server config", "Custom\tname\nserver button"], "", { spawn, platform: "win32" });
  assert.equal(stdinText, "Domain name server config\tCustom name server button\n\n");
});

test("a card's session id is read from where the store actually puts it", () => {
  assert.equal(tui.sessionIdOf({ sessionId: "s1" }), "s1");
  assert.equal(tui.sessionIdOf({ sessionId: null, source: { session_id: "d3d5" } }), "d3d5");
  assert.equal(tui.sessionIdOf({ dedupe_key: "cc-waiting:sid-9:perm-1" }), "sid-9");
  assert.equal(tui.sessionIdOf({ source: "not an object" }), "");
  assert.equal(tui.sessionIdOf({}), "");
  assert.equal(tui.sessionIdOf(null), "");
});

// The shape every open card had on 2026-11-17 (d-qh8f / d-jkv4): no top-level
// sessionId, the id only in source.session_id + the cc-waiting dedupe key. Reading
// the top-level field alone made "Open the session" answer "it has no name" every time.
test("the measured card shape resolves a session id, so the tab can be found", () => {
  const real = {
    id: "d-qh8f",
    sessionId: null,
    source: { session_id: "d3d56e47-1036-4f1b-b8c4-d9f83ea98fff", agent: "claude-code", cwd: "C:\\AitherOS-Fresh" },
    dedupe_key: "cc-waiting:d3d56e47-1036-4f1b-b8c4-d9f83ea98fff:perm-5ddba63599a5af04",
  };
  assert.equal(tui.sessionIdOf(real), "d3d56e47-1036-4f1b-b8c4-d9f83ea98fff");
});
