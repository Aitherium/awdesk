"use strict";

/** The aw* CLI rows: one argv per verb, system binaries only, 30 s cap, no shell. */

const test = require("node:test");
const assert = require("node:assert/strict");
const aw = require("./aw-cli.cjs");

test("plan builds exactly the argv each verb runs", () => {
  assert.deepEqual(aw.plan("aw-recall", "fleet disk", { home: "/h" }),
    { bin: "awm", args: ["recall", "--query", "fleet disk", "--limit", "8"], cwd: "/h", title: "Memory" });
  assert.deepEqual(aw.plan("aw-recall", "acme:me:proj fleet disk", { home: "/h" }).args,
    ["recall", "--scope", "acme:me:proj", "--query", "fleet disk", "--limit", "8"], "a leading scope token is --scope");
  assert.deepEqual(aw.plan("aw-graph", "orbWindow.run", { home: "/h" }).args, ["query", "orbWindow.run", "-k", "8"]);
  assert.deepEqual(aw.plan("aw-git", "", { home: "/h" }), { bin: "awgit", args: ["state"], cwd: "/h", title: "Git state" });
  assert.equal(aw.plan("aw-git", "D:/repo", { home: "/h" }).cwd, "D:/repo", "an arg is the repo dir");
  assert.deepEqual(aw.plan("aw-recover", "E:/snaps", { home: "/h" }).args, ["list", "--store", "E:/snaps"]);
  assert.deepEqual(aw.plan("aw-settings", "ignored", { home: "/h" }).args, ["--quiet", "pull"]);
});

test("a verb that needs a query says so instead of running empty", () => {
  assert.equal(aw.plan("aw-recall", "  ").error, "needs-arg");
  assert.equal(aw.plan("nope", "x").error, "unknown aw verb nope");
});

test("typed text is one cleaned argument (no newlines, capped)", () => {
  assert.equal(aw.cleanArg("a\nb\u0007c"), "a b c");
  assert.equal(aw.cleanArg("x".repeat(1000)).length, 400);
});

test("resolveBin uses where on Windows and skips .cmd/.bat shims", async () => {
  const seen = [];
  const execFile = (cmd, args, _opts, cb) => { seen.push([cmd, ...args]); cb(null, "C:\\bin\\awm.cmd\r\nC:\\py\\Scripts\\awm.exe\r\n"); };
  assert.equal(await aw.resolveBin("awm", { execFile, platform: "win32" }), "C:\\py\\Scripts\\awm.exe");
  assert.deepEqual(seen[0], ["where", "awm"]);
  const shimOnly = (_c, _a, _o, cb) => cb(null, "C:\\bin\\awm.cmd\r\n");
  assert.equal(await aw.resolveBin("awm", { execFile: shimOnly, platform: "win32" }), null);
  const missing = (_c, _a, _o, cb) => cb(new Error("not found"), "");
  assert.equal(await aw.resolveBin("awm", { execFile: missing, platform: "linux" }), null);
});

test("runAw runs the resolved system binary with no shell and a 30 s timeout", async () => {
  const runs = [];
  const execFile = (cmd, args, opts, cb) => { runs.push({ cmd, args, opts }); cb(null, "\u001b[32m3 facts\u001b[0m\n", ""); };
  const r = await aw.runAw("aw-recall", "disk", { execFile, resolve: async () => "C:\\py\\awm.exe", home: "/h" });
  assert.deepEqual(r, { ok: true, code: 0, title: "Memory", text: "3 facts" });
  assert.equal(runs[0].cmd, "C:\\py\\awm.exe");
  assert.notEqual(runs[0].cmd, process.execPath, "never Electron-as-node");
  assert.equal(runs[0].opts.shell, false);
  assert.equal(runs[0].opts.timeout, aw.TIMEOUT_MS);
  assert.equal(aw.TIMEOUT_MS, 30000);
});

test("runAw reports a missing binary, a timeout and a failure without throwing", async () => {
  const missing = await aw.runAw("aw-git", "", { resolve: async () => null });
  assert.equal(missing.missing, true);
  assert.match(missing.text, /awgit is not installed/);

  const slow = (_c, _a, _o, cb) => { const e = new Error("t"); e.killed = true; e.signal = "SIGTERM"; cb(e, "", ""); };
  const t = await aw.runAw("aw-settings", "", { execFile: slow, resolve: async () => "/bin/awsettings" });
  assert.equal(t.ok, false);
  assert.match(t.text, /timed out after 30 s/);

  const bad = (_c, _a, _o, cb) => { const e = new Error("x"); e.code = 2; cb(e, "", "usage: awgraph"); };
  const b = await aw.runAw("aw-graph", "q", { execFile: bad, resolve: async () => "/bin/awgraph" });
  assert.equal(b.ok, false);
  assert.equal(b.code, 2);
  assert.match(b.text, /awgraph failed \(2\)\nusage: awgraph/);

  const needs = await aw.runAw("aw-recall", "", { resolve: async () => "/bin/awm" });
  assert.equal(needs.needsArg, true);
});

test("output is clipped for the bubble", () => {
  assert.equal(aw.clip("y".repeat(5000)).length, aw.OUTPUT_MAX);
});

test("aw-recover-restore: exact argv, never --discard-replaced, refuses a root or a flag", () => {
  const p = aw.plan("aw-recover-restore", 'E:/snaps pre-fix "C:/My Notes"', { home: "/h" });
  assert.deepEqual(p.args, ["restore", "--store", "E:/snaps", "--label", "pre-fix", "--dest", "C:/My Notes"]);
  assert.equal(p.timeoutMs, 10 * 60 * 1000, "a restore gets a long cap, not 30 s");
  assert.ok(!p.args.includes("--discard-replaced"), "the replaced tree is always kept");
  assert.equal(aw.plan("aw-recover-restore", "E:/snaps pre-fix C:\\", { home: "/h" }).error.startsWith("Refusing"), true);
  assert.equal(aw.plan("aw-recover-restore", "E:/snaps pre-fix D:", { home: "/h" }).error.startsWith("Refusing"), true);
  assert.match(aw.plan("aw-recover-restore", "E:/snaps --discard-replaced C:/x", { home: "/h" }).error, /cannot start with '-'/);
  assert.match(aw.plan("aw-recover-restore", "E:/snaps only-two", { home: "/h" }).error, /exactly/);
  assert.equal(aw.plan("aw-recover-restore", "", { home: "/h" }).error, "needs-arg");
});
