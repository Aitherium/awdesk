"use strict";

/** "Play Dark Matters": no game, no Electron, no real process -- the spawn is a fake. */
const test = require("node:test");
const assert = require("node:assert/strict");
const dm = require("./darkmatters-launch.cjs");
const registry = require("./command-registry.cjs");
const { LAUNCHERS } = require("./console-window.cjs");

function fakes() {
  const calls = { spawn: [], open: [], log: [] };
  return {
    calls,
    spawn: (cmd, args, opts) => { calls.spawn.push({ cmd, args, opts }); return { unref() {}, on() {} }; },
    openExternal: (url) => calls.open.push(url),
    log: (line) => calls.log.push(line),
  };
}

test("launch runs the game repo's launcher hidden, never a console", () => {
  const f = fakes();
  const r = dm.launch({ env: {}, exists: () => true, ...f });
  assert.equal(r.mode, "launch");
  assert.equal(f.calls.spawn.length, 1);
  const { cmd, args, opts } = f.calls.spawn[0];
  assert.equal(cmd, "powershell.exe");
  assert.ok(args.includes("-File") && args.includes(dm.DEFAULT_LAUNCHER));
  assert.deepEqual(args.slice(args.indexOf("-Port"), args.indexOf("-Port") + 2), ["-Port", "8799"]);
  assert.ok(!args.includes("-Restart"));
  assert.equal(opts.windowsHide, true, "no console window (no terminal tab spam)");
  assert.equal(opts.stdio, "ignore");
  assert.equal(f.calls.open.length, 0, "the launcher opens the browser itself");
});

test("restart passes -Restart and honours the port/launcher overrides", () => {
  const f = fakes();
  const env = { AWDESK_DM_PORT: "8811", AWDESK_DM_LAUNCHER: "X:\\dm\\launch.ps1" };
  const r = dm.launch({ restart: true, env, exists: () => true, ...f });
  assert.equal(r.url, "http://localhost:8811");
  const { args } = f.calls.spawn[0];
  assert.ok(args.includes("-Restart") && args.includes("X:\\dm\\launch.ps1") && args.includes("8811"));
});

test("no launcher on disk still opens the game URL and spawns nothing", () => {
  const f = fakes();
  const r = dm.launch({ env: {}, exists: () => false, ...f });
  assert.equal(r.mode, "open-only");
  assert.equal(f.calls.spawn.length, 0);
  assert.deepEqual(f.calls.open, ["http://localhost:8799"]);
});

test("a bad port override falls back to 8799", () => {
  assert.equal(dm.port({ AWDESK_DM_PORT: "nope" }), 8799);
  assert.equal(dm.port({ AWDESK_DM_PORT: "70000" }), 8799);
});

test("Play Dark Matters is a registry command and an Aither Console launcher", () => {
  assert.ok(registry.byId("darkmatters.play"), "registry row");
  assert.ok(registry.byId("darkmatters.restart"), "registry row");
  assert.ok(LAUNCHERS.some((l) => l.command === "darkmatters.play"), "console launcher");
});
