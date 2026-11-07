"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");

const probe = require("./spirit-probe.cjs");

function answerFor(req) {
  if (req.op === "ping") return { ok: true, pong: true };
  if (req.op === "rect") {
    return {
      ok: true,
      hwnd: Number(req.hwnd),
      title: "Notepad",
      className: "Notepad",
      process: "notepad",
      pid: 4242,
      visible: true,
      rect: { x: 10, y: 20, width: 800, height: 600 },
    };
  }
  return {
    ok: true,
    hwnd: 77,
    title: "Chrome",
    className: "Chrome_WidgetWin_1",
    process: "chrome",
    pid: 1234,
    visible: true,
    rect: { x: 100, y: 120, width: 1200, height: 900 },
  };
}

function fakeChild({ answers = true, onWrite = null, delayFor = null } = {}) {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stdout.setEncoding = () => {};
  child.stderr = new EventEmitter();
  child.stdin = {
    writes: [],
    on() {},
    write(line) {
      const req = JSON.parse(line);
      this.writes.push(req);
      if (!answers) return true;
      const body = onWrite ? onWrite(req) : answerFor(req);
      const delay = delayFor ? Number(delayFor(req)) || 0 : 0;
      const emit = () => child.stdout.emit("data", `${JSON.stringify({ id: req.id, ...body })}
`);
      if (delay) setTimeout(emit, delay); else setImmediate(emit);
      return true;
    },
  };
  child.kill = () => { child.killed = true; };
  child.killed = false;
  return child;
}

function fsRecorder() {
  return {
    writes: [],
    writeFileSync(file, body) { this.writes.push({ file, body }); },
  };
}

test("an answer becomes an attach target, or null when it is not usable", () => {
  const good = probe.targetFromAnswer({
    ok: true, hwnd: 77, title: "Chrome", process: "chrome", pid: 1234,
    rect: { x: 100.4, y: 120.6, width: 1200.2, height: 900.8 },
  });
  assert.equal(good.kind, "window");
  assert.equal(good.hwnd, 77);
  assert.equal(good.title, "Chrome");
  assert.deepEqual(good.bounds, { x: 100, y: 121, width: 1200, height: 901 });

  assert.equal(probe.targetFromAnswer({ ok: false }), null);
  assert.equal(probe.targetFromAnswer({ ok: true, rect: { width: 10, height: 10 } }), null, "too small to dock on");
  assert.equal(probe.targetFromAnswer({ ok: true, pid: 1234, rect: { width: 500, height: 500 } }, { excludePid: 1234 }), null,
    "the spirit never attaches to its own process");
  assert.equal(probe.targetFromAnswer({ ok: true, pid: 1234, rect: { width: 500, height: 500 } }, { excludePid: 99 }).pid, 1234);
});

test("the probe is ONE hidden PowerShell with a JSON line per request", async () => {
  const child = fakeChild();
  let spawnCall = null;
  const fsImpl = fsRecorder();
  const p = probe.createWindowProbe({
    spawn: (cmd, args, opts) => { spawnCall = { cmd, args, opts }; return child; },
    powershell: "powershell.exe",
    fsImpl,
  });
  const point = await p.pointAt(300.7, 400.2, { excludePid: 1 });
  assert.equal(point.title, "Chrome");
  assert.equal(spawnCall.cmd, "powershell.exe");
  assert.equal(spawnCall.opts.windowsHide, true, "a helper console must never flash");
  assert.deepEqual(child.stdin.writes[0], { id: "w1", op: "point", x: 301, y: 400 });
  assert.match(fsImpl.writes[0].body, /WindowFromPoint/);
  assert.match(fsImpl.writes[0].file, /aither-spirit-winprobe-/);

  const rect = await p.rectOf(77, {});
  assert.equal(rect.hwnd, 77);
  assert.equal(rect.title, "Notepad");
  assert.equal(child.stdin.writes[1].op, "rect");
  assert.equal(await p.ping(), true);
  assert.equal(p.running, true);
  p.stop();
  assert.equal(child.killed, true);
  assert.equal(p.running, false);
});

test("a probe that does not answer resolves false, never hangs", async () => {
  const child = fakeChild({ answers: false });
  const p = probe.createWindowProbe({ spawn: () => child, fsImpl: fsRecorder(), timeoutMs: 40, startupMs: 40 });
  const point = await p.pointAt(1, 1);
  assert.equal(point, null);
  p.stop();
});

test("pointAt maps a too-small target (a desktop sliver) to null", async () => {
  const child = fakeChild({
    onWrite: () => ({ ok: true, hwnd: 5, title: "sliver", pid: 9, rect: { x: 0, y: 0, width: 12, height: 12 } }),
  });
  const p = probe.createWindowProbe({ spawn: () => child, fsImpl: fsRecorder() });
  assert.equal(await p.pointAt(5, 5), null);
  p.stop();
});

test("a probe that cannot be spawned fails soft and backs off", async () => {
  let attempts = 0;
  const p = probe.createWindowProbe({
    spawn: () => { attempts += 1; throw new Error("powershell is missing"); },
    fsImpl: fsRecorder(),
  });
  assert.equal(await p.ping(), false);
  assert.equal(await p.ping(), false);
  assert.equal(attempts, 1, "a broken probe is not re-spawned on every request");
  assert.equal(p.running, false);
});

test("the FIRST request may spend seconds on Add-Type; later ones keep the short deadline", async () => {
  const child = fakeChild({ delayFor: () => 900 });
  const p = probe.createWindowProbe({
    spawn: () => child,
    fsImpl: fsRecorder(),
    timeoutMs: 100,
    startupMs: 3000,
  });
  assert.equal(await p.ping(), true, "a cold probe is not killed before PowerShell compiles");
  assert.equal(await p.ping(), false, "a wedged warmed probe still times out");
  p.stop();
});
