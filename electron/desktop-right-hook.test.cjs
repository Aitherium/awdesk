"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { createDesktopRightHook } = require("./desktop-right-hook.cjs");

function fakeChild() {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stdout.setEncoding = () => {};
  child.stderr = new EventEmitter();
  child.stdin = {
    written: [],
    write(line) {
      this.written.push(line);
      if (String(line).startsWith("stats")) {
        child.stdout.emit("data", '{"type":"stats","rights":3,"qualifying":1,"calls":3,"avgMs":0.12,"maxMs":0.4,"cpuMs":50}\n');
      }
      return true;
    },
  };
  child.kill = () => { child.killed = true; };
  return child;
}

function freshFs() {
  return {
    statSync(p) {
      if (String(p).endsWith("DeskMouseHook.cs")) return { mtimeMs: 1 };
      if (String(p).endsWith("DeskMouseHook.exe")) return { mtimeMs: 2 };
      throw new Error("ENOENT");
    },
    existsSync: () => true,
    mkdirSync() {},
  };
}

test("a qualifying right line calls onRight; other lines are ignored", () => {
  const got = [];
  const hook = createDesktopRightHook({ onRight: (p) => got.push(p) });
  assert.equal(hook.handleLine('{"type":"right","x":600,"y":2020}'), true);
  assert.deepEqual(got, [{ x: 600, y: 2020 }]);
  assert.equal(hook.handleLine('{"type":"right","x":"nope"}'), false);
  assert.equal(hook.handleLine("not json"), false);
  assert.equal(hook.handleLine('{"type":"ready"}'), true);
  assert.equal(hook.isReady(), true);
  let logged = "";
  assert.equal(hook.handleLine('{"type":"error","error":"the hook was refused"}'), true);
  hook.handleLine('{"type":"error","error":"the hook was refused"}');
  assert.equal(got.length, 1, "an error is never a click");
  void logged;
});

test("start spawns the helper (from a fresh EXE), stats resolves, stop sends quit", async () => {
  const child = fakeChild();
  let spawned = null;
  const hook = createDesktopRightHook({
    root: "D:/repo",
    fsImpl: freshFs(),
    spawnImpl: (exe, args, opts) => { spawned = { exe, args, opts }; return child; },
    onRight: () => {},
  });
  const started = hook.start();
  assert.equal(started.ok, true);
  assert.match(spawned.exe, /DeskMouseHook\.exe$/);
  assert.equal(spawned.opts.windowsHide, true);
  assert.equal(hook.isRunning(), true);
  const stats = await hook.stats();
  assert.equal(stats.calls, 3);
  hook.stop();
  assert.equal(child.stdin.written.at(-1), "quit\n");
  assert.equal(child.killed, true);
  assert.equal(hook.isRunning(), false);
});

test("no csc.exe means no hook and no throw -- the desktop keeps working", () => {
  const hook = createDesktopRightHook({
    root: "D:/repo",
    fsImpl: {
      statSync(p) {
        if (String(p).endsWith("DeskMouseHook.cs")) return { mtimeMs: 1 };
        throw new Error("ENOENT"); // no exe yet
      },
      existsSync: () => false, // no csc.exe either
      mkdirSync() {},
    },
    spawnImpl: () => { throw new Error("must not spawn"); },
  });
  const r = hook.start();
  assert.equal(r.ok, false);
  assert.match(r.error, /csc\.exe/);
  assert.equal(hook.isRunning(), false);
});

test("the stats line waits for its own reply and cannot hang the caller", async () => {
  const child = fakeChild();
  const hook = createDesktopRightHook({
    root: "D:/repo",
    fsImpl: freshFs(),
    spawnImpl: () => child,
  });
  hook.start();
  const pending = hook.stats();
  // A stray stats without the pending promise set would be ignored, never crash.
  hook.handleLine('{"type":"stats"}');
  const stats = await pending;
  assert.equal(stats.qualifying, 1);
  hook.stop();
});
