"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {
  WINDOWS_SCRIPT,
  brief,
  cleanTitle,
  parseLinuxXprop,
  parseMacForeground,
  parseWindowsForeground,
  sampleHostContext,
} = require("./host-context.cjs");

// --------------------------------------------------------------------------- //
// Parsers — every arm below can fail on a real regression
// --------------------------------------------------------------------------- //

test("parses the Windows foreground-window JSON", () => {
  assert.deepEqual(
    parseWindowsForeground(
      '{"pid":4242,"title":"main.py - Visual Studio Code","app":"Code","exe":"C:\\\\Apps\\\\Code.exe"}',
    ),
    { pid: 4242, app: "Code", title: "main.py - Visual Studio Code", exe: "C:\\Apps\\Code.exe" },
  );
});

test("a locked screen (pid 0) is NOT a foreground window", () => {
  assert.equal(parseWindowsForeground('{"pid":0}'), null);
});

test("unparseable Windows output is a failure, never an empty window", () => {
  assert.equal(parseWindowsForeground(""), null);
  assert.equal(parseWindowsForeground("Add-Type : Cannot add type"), null);
  assert.equal(parseWindowsForeground('{"title":"orphan"}'), null);
});

test("parses the macOS frontmost application", () => {
  assert.deepEqual(parseMacForeground("Google Chrome, 4242"), {
    pid: 4242,
    app: "Google Chrome",
    title: "",
    exe: "",
  });
});

test("a macOS app name containing a comma survives (split on the LAST comma)", () => {
  assert.deepEqual(parseMacForeground("Acme, Inc. Editor, 77"), {
    pid: 77,
    app: "Acme, Inc. Editor",
    title: "",
    exe: "",
  });
});

test("macOS output without a numeric pid is a failure", () => {
  assert.equal(parseMacForeground(""), null);
  assert.equal(parseMacForeground("Google Chrome"), null);
  assert.equal(parseMacForeground(", 12"), null);
});

test("parses an X11 active window with its class, title and pid", () => {
  const active = "_NET_ACTIVE_WINDOW(WINDOW): window id # 0x3a00007";
  const detail = [
    '_NET_WM_NAME(UTF8_STRING) = "notes.md — Neovim"',
    'WM_CLASS(STRING) = "nvim", "Nvim"',
    "_NET_WM_PID(CARDINAL) = 9137",
  ].join("\n");
  assert.deepEqual(parseLinuxXprop(active, detail), {
    pid: 9137,
    app: "Nvim",
    title: "notes.md — Neovim",
    exe: "",
    windowId: "0x3a00007",
  });
});

test("X11 with no active window (0x0) is a failure, not an empty desk", () => {
  assert.equal(parseLinuxXprop("_NET_ACTIVE_WINDOW(WINDOW): window id # 0x0", ""), null);
  assert.equal(parseLinuxXprop("", ""), null);
});

test("titles are collapsed to one line and capped", () => {
  assert.equal(cleanTitle("a\nb\tc"), "a b c");
  assert.equal(cleanTitle("x".repeat(400)).length, 301);
});

test("a title keeps its non-ASCII characters through the JSON probe", () => {
  // Measured on a real Windows box: the emoji arrived as "?" until the probe set
  // [Console]::OutputEncoding. A title is the field an agent actually reads.
  assert.deepEqual(parseWindowsForeground('{"pid":5,"title":"◑ Sync clipboard","app":"WindowsTerminal"}'), {
    pid: 5,
    app: "WindowsTerminal",
    title: "◑ Sync clipboard",
    exe: "",
  });
  assert.match(WINDOWS_SCRIPT, /\[Console\]::OutputEncoding\s*=\s*\[System\.Text\.Encoding\]::UTF8/);
});

test("brief names the app and title, and says why when unavailable", () => {
  assert.equal(brief({ ok: true, app: "Code", title: "main.py", pid: 7 }), "Code — main.py (pid 7)");
  assert.match(brief({ ok: false, reason: "no probe" }), /^host-context unavailable: no probe$/);
});

// --------------------------------------------------------------------------- //
// The sampler — silence must never read as a pass
// --------------------------------------------------------------------------- //

test("sampleHostContext reports ok:false when the probe THROWS", async () => {
  const context = await sampleHostContext({
    platform: "win32",
    run: async () => {
      throw new Error("Access is denied.");
    },
  });
  assert.equal(context.ok, false);
  assert.match(context.reason, /Access is denied/);
});

test("sampleHostContext reports ok:false when the probe answers with NOTHING", async () => {
  const context = await sampleHostContext({ platform: "win32", run: async () => "" });
  assert.equal(context.ok, false);
  assert.match(context.reason, /Could not parse/);
});

test("sampleHostContext refuses an unknown platform instead of guessing", async () => {
  const context = await sampleHostContext({ platform: "aix", run: async () => "{}" });
  assert.equal(context.ok, false);
  assert.match(context.reason, /No host-context probe/);
});

test("sampleHostContext returns the real shape on a good Windows read", async () => {
  const context = await sampleHostContext({
    platform: "win32",
    run: async () => '{"pid":99,"title":"Inbox","app":"Outlook","exe":"C:\\\\o.exe"}',
    now: () => 1234,
  });
  assert.deepEqual(context, {
    ok: true,
    platform: "win32",
    pid: 99,
    app: "Outlook",
    title: "Inbox",
    exe: "C:\\o.exe",
    sampledAt: 1234,
  });
});

test("sampleHostContext on macOS returns the frontmost app", async () => {
  const context = await sampleHostContext({ platform: "darwin", run: async () => "Xcode, 321\n" });
  assert.equal(context.ok, true);
  assert.equal(context.app, "Xcode");
  assert.equal(context.pid, 321);
});
