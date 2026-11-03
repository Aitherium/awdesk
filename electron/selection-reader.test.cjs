"use strict";

/** The selection reader: UI Automation via PowerShell, no keys, no clipboard, never rejects. */

const test = require("node:test");
const assert = require("node:assert/strict");
const sel = require("./selection-reader.cjs");

test("parseOutput takes the last JSON line's text, else empty", () => {
  assert.equal(sel.parseOutput('noise\n{"text":"hello world","via":"focused"}\n'), "hello world");
  assert.equal(sel.parseOutput("not json"), "");
  assert.equal(sel.parseOutput('{"via":"x"}'), "");
  assert.equal(sel.parseOutput(JSON.stringify({ text: "x".repeat(sel.TEXT_MAX + 50) })).length, sel.TEXT_MAX);
});

test("the script reads TextPattern selections and never injects input or touches the clipboard", () => {
  assert.match(sel.SCRIPT, /GetSelection\(\)/);
  assert.match(sel.SCRIPT, /AWDESK_EXCLUDE_PIDS/);
  assert.doesNotMatch(sel.SCRIPT, /SendKeys|SendInput|keybd_event|System\.Windows\.Forms\.Clipboard/);
  assert.match(sel.SCRIPT, /0x00B0/, "EM_GETSEL: the Win32 EDIT fallback reads the selection in place");
  assert.match(sel.SCRIPT, /0x000D/, "WM_GETTEXT: read-only");
});

test("readSelection passes the desk pids, hides the window, and resolves '' on error or off Windows", async () => {
  let seen = null;
  const fake = (exe, args, opts, cb) => { seen = { exe, args, opts }; cb(null, '{"text":"picked"}'); };
  assert.equal(await sel.readSelection({ execFile: fake, platform: "win32", excludePids: [11, 22] }), "picked");
  assert.equal(seen.exe, "powershell.exe");
  assert.ok(seen.args.includes("-STA"));
  assert.equal(seen.opts.env.AWDESK_EXCLUDE_PIDS, "11,22");
  assert.equal(seen.opts.windowsHide, true);
  assert.equal(seen.opts.shell, false);
  assert.equal(await sel.readSelection({ execFile: (e, a, o, cb) => cb(new Error("boom")), platform: "win32" }), "");
  assert.equal(await sel.readSelection({ execFile: () => { throw new Error("x"); }, platform: "win32" }), "");
  assert.equal(await sel.readSelection({ execFile: fake, platform: "linux" }), "");
});
