"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { createForegroundProbe } = require("./foreground-probe.cjs");

function fakeChild() {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.writes = [];
  child.stdin = { destroyed: false, write: (t) => { child.writes.push(t); }, end() { child.stdin.destroyed = true; } };
  child.kill = () => { child.killed = true; };
  return child;
}

test("one resident probe: a sample writes a line, the answer is DIP-converted and reported once", () => {
  const child = fakeChild();
  let spawned = 0;
  const seen = [];
  const probe = createForegroundProbe({
    platform: "win32",
    spawnImpl: () => { spawned += 1; return child; },
    toDip: (p) => ({ x: p.x / 2, y: p.y / 2 }),
    onChange: (r) => seen.push(r),
    setTimer: () => ({ unref() {} }),
    clearTimer: () => {},
  });
  probe.start();
  probe.sample(); // a second sample while the first is unanswered writes nothing
  assert.equal(spawned, 1);
  assert.equal(child.writes.length, 1);
  child.stdout.emit("data", '{"ok":true,"x":100,"y":200,"w":800,"h":600,"cls":"Chrome_WidgetWin_1","title":"Doc"}\n');
  assert.deepEqual({ ...seen[0], title: undefined, hwnd: undefined, pid: undefined, cls: undefined, quiet: undefined },
    { x: 50, y: 100, width: 400, height: 300, title: undefined, hwnd: undefined, pid: undefined, cls: undefined, quiet: undefined });
  probe.sample();
  child.stdout.emit("data", '{"ok":true,"x":101,"y":201,"w":800,"h":600,"cls":"Chrome_WidgetWin_1","title":"Doc"}\n');
  assert.equal(seen.length, 1, "a move under the tolerance is not a change");
  probe.sample();
  child.stdout.emit("data", '{"ok":false}\n');
  assert.equal(seen[1], null, "no window in front: the swarm keeps nothing clear");
});

test("a chunked answer is reassembled, stop kills the child, and other platforms never spawn", () => {
  const child = fakeChild();
  const seen = [];
  const probe = createForegroundProbe({
    platform: "win32", spawnImpl: () => child, onChange: (r) => seen.push(r), setTimer: () => ({ unref() {} }), clearTimer: () => {},
  });
  probe.start();
  child.stdout.emit("data", '{"ok":true,"x":0,"y":0,');
  child.stdout.emit("data", '"w":300,"h":300,"cls":"x","title":""}\n');
  assert.equal(seen.length, 1);
  probe.stop();
  assert.equal(child.killed, true);
  assert.equal(seen[seen.length - 1], null, "stopping reports no window");

  let spawned = 0;
  const mac = createForegroundProbe({ platform: "darwin", spawnImpl: () => { spawned += 1; return fakeChild(); } });
  mac.start();
  mac.sample();
  assert.equal(spawned, 0);
});

test("a probe that cannot start stays quiet instead of throwing", () => {
  const probe = createForegroundProbe({ platform: "win32", spawnImpl: () => { throw new Error("no powershell"); }, setTimer: () => ({ unref() {} }), clearTimer: () => {} });
  assert.doesNotThrow(() => { probe.start(); probe.sample(); probe.stop(); });
});

test("review of #101: a late exit of an old child does not null the new one; a broken pipe is not uncaught; a probe that keeps dying is given up", () => {
  const kids = [];
  let spawned = 0;
  const mk = () => { const c = fakeChild(); c.stdin.on = (ev, fn) => { c.stdin[`_${ev}`] = fn; }; kids.push(c); spawned += 1; return c; };
  const probe = createForegroundProbe({ platform: "win32", spawnImpl: mk, setTimer: () => ({ unref() {} }), clearTimer: () => {} });
  probe.start();
  const first = kids[0];
  probe.stop();
  probe.start();
  const second = kids[1];
  assert.equal(spawned, 2);
  first.emit("exit"); // the OLD child's late exit
  probe.sample();
  assert.equal(spawned, 2, "the new child is still the child: no third spawn");
  assert.equal(second.writes.length >= 1, true);
  // A broken pipe: the error handler exists and does not throw.
  assert.equal(typeof second.stdin._error, "function");
  assert.doesNotThrow(() => second.stdin._error(new Error("EPIPE")));
  // Four exits inside the window: given up.
  const dying = [];
  const p2 = createForegroundProbe({ platform: "win32", spawnImpl: () => { const c = fakeChild(); dying.push(c); return c; }, setTimer: () => ({ unref() {} }), clearTimer: () => {} });
  for (let i = 0; i < 6; i += 1) { p2.sample(); const k = dying[dying.length - 1]; if (k) k.emit("exit"); }
  assert.ok(dying.length <= 4, `gave up after ${dying.length} spawns`);
});

test("review of #101: stop/start cycles never count toward the respawn limit; a broken pipe kills its child", () => {
  const kids = [];
  const mk = () => { const c = fakeChild(); c.stdin.on = (ev, fn) => { c.stdin[`_${ev}`] = fn; }; kids.push(c); return c; };
  const probe = createForegroundProbe({ platform: "win32", spawnImpl: mk, setTimer: () => ({ unref() {} }), clearTimer: () => {} });
  for (let i = 0; i < 8; i += 1) { probe.start(); const k = kids[kids.length - 1]; probe.stop(); k.emit("exit"); }
  probe.start();
  assert.equal(kids.length, 9, "eight shown/hidden cycles later the probe still starts");
  const live = kids[kids.length - 1];
  live.stdin._error(new Error("EPIPE"));
  assert.equal(live.killed, true, "the child behind a broken pipe is killed");
});

test("the answer names the window and its quiet verdict, and a window change emits even without a move", () => {
  const child = fakeChild();
  const seen = [];
  const probe = createForegroundProbe({
    platform: "win32", spawnImpl: () => child, onChange: (r) => seen.push(r), setTimer: () => ({ unref() {} }), clearTimer: () => {},
  });
  probe.start();
  const row = (over = {}) => `${JSON.stringify({
    ok: true, x: 0, y: 0, w: 800, h: 600, cls: "Notepad", title: "Untitled", hwnd: 90210, pid: 777, quns: 1,
    mx: 0, my: 0, mw: 1920, mh: 1080, ...over,
  })}\n`;
  child.stdout.emit("data", row());
  assert.equal(seen.length, 1);
  assert.equal(seen[0].hwnd, 90210, "the window's identity leaves the probe");
  assert.equal(seen[0].pid, 777, "and its process, so the desk's own windows can be skipped");
  assert.equal(seen[0].quiet, "", "an ordinary window is not quiet");

  // The SAME rect, a different window: following needs to see this.
  child.stdout.emit("data", row({ hwnd: 555, title: "Other" }));
  assert.equal(seen.length, 2, "a different hwnd on the same rect is a change");

  // The same window and rect, but Windows now says the owner is in a full-screen game.
  child.stdout.emit("data", row({ hwnd: 555, title: "Other", quns: 3 }));
  assert.equal(seen.length, 3, "a new quiet verdict is a change");
  assert.match(seen[2].quiet, /full-screen game/);

  // Nothing changed at all: no third-party churn.
  child.stdout.emit("data", row({ hwnd: 555, title: "Other", quns: 3 }));
  assert.equal(seen.length, 3);
  probe.stop();
});

test("a maximized window (covers the work area, not the monitor) is not 'quiet'", () => {
  const child = fakeChild();
  const seen = [];
  const probe = createForegroundProbe({
    platform: "win32", spawnImpl: () => child, onChange: (r) => seen.push(r), setTimer: () => ({ unref() {} }), clearTimer: () => {},
  });
  probe.start();
  child.stdout.emit("data", `${JSON.stringify({
    ok: true, x: 0, y: 0, w: 1920, h: 1040, cls: "Chrome_WidgetWin_1", title: "Docs", hwnd: 1, pid: 2, quns: 1,
    mx: 0, my: 0, mw: 1920, mh: 1080,
  })}\n`);
  assert.equal(seen[0].quiet, "", "a maximized window keeps the work area only");
  probe.stop();
});
