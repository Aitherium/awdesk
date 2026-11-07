"use strict";

// recorder-window.cjs's native-recording lifecycle under node --test: a dragged
// region must restart ONE gdigrab segment after the drag settles (not one per
// poll tick), and no ffmpeg child may ever be orphaned by a resume landing in the
// retarget gap or by the session ending.

const test = require("node:test");
const assert = require("node:assert/strict");
const rec = require("./recorder-window.cjs");
const core = require("./recorder-core.cjs");

const DISPLAY = { id: 1, bounds: { x: 0, y: 0, width: 1920, height: 1080 }, scaleFactor: 1 };

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function fakeBar() {
  return {
    destroyed: false,
    isDestroyed() {
      return this.destroyed;
    },
    webContents: { id: 77, send() {} },
  };
}

function pausedSession(over = {}) {
  return {
    state: "paused",
    options: { fps: 30, format: "mp4" },
    display: DISPLAY,
    cropDip: { x: 100, y: 100, width: 640, height: 360 },
    native: {
      rect: { x: 100, y: 100, width: 640, height: 360 },
      stamp: "t", parts: [], live: null, chain: null, children: new Set(),
    },
    bar: null,
    frame: null,
    regionTimer: null,
    segments: [[Date.now(), null]],
    ...over,
  };
}

/** A fake child_process.spawn: records every ffmpeg the recorder starts. */
function fakeSpawn() {
  const calls = [];
  const kids = [];
  const cp = require("node:child_process");
  const original = cp.spawn;
  cp.spawn = (bin, args, opts) => {
    calls.push({ bin, args, opts });
    const handlers = new Map();
    const child = {
      killed: false,
      stdin: { write() {}, end() {} },
      stderr: { on() {} },
      on(ev, fn) {
        const list = handlers.get(ev) || [];
        list.push(fn);
        handlers.set(ev, list);
        return this;
      },
      /** ffmpeg exits by itself (code 0, i.e. it read "q"). */
      close(code = 0) {
        const list = handlers.get("close") || [];
        for (const fn of list) fn(code);
      },
      kill() {
        if (this.killed) return;
        this.killed = true;
        this.close(0);
      },
    };
    kids.push(child);
    return child;
  };
  return {
    calls,
    kids,
    restore() {
      cp.spawn = original;
    },
  };
}

test.afterEach(() => {
  rec.__setRegionSettleMsForTest(null);
  rec.__setStateForTest({ session: null, overlays: [], toastInfo: null });
});

test("a dragged region retargets the native grabber ONCE, after the drag settles", async () => {
  rec.__setRegionSettleMsForTest(25);
  const s = pausedSession();
  rec.__setStateForTest({ session: s });
  const original = s.native.rect;
  // The frame's poller emits a region on almost every tick of a 1-2 s drag.
  for (let i = 0; i < 20; i += 1) {
    rec.applyRegion({ x: 100 + i, y: 100, width: 640, height: 360 });
  }
  assert.equal(s.native.rect, original, "no retarget while the drag is still moving");
  await wait(70);
  // ONE settle at the LAST region, not twenty restarts.
  assert.deepEqual(s.native.rect, { x: 119, y: 100, width: 640, height: 360 });
  // An identical region later is a no-op (same object: nothing was rewritten).
  const settled = s.native.rect;
  rec.applyRegion({ x: 119, y: 100, width: 640, height: 360 });
  await wait(70);
  assert.equal(s.native.rect, settled);
});

test("a resume landing in the retarget gap never spawns a second ffmpeg (no orphan)", async () => {
  const spawn = fakeSpawn();
  try {
    rec.configureRecorder({ ffmpeg: "ffmpeg-fake" });
    rec.__setRegionSettleMsForTest(0);
    const bar = fakeBar();
    const s = pausedSession({ state: "starting", bar, segments: [] });
    rec.__setStateForTest({ session: s });
    const h = rec.handlers();
    const fromBar = { sender: { id: bar.webContents.id } };

    assert.equal(h["recorder:state"](fromBar, "recording").ok, true);
    await wait(20);
    assert.equal(spawn.calls.length, 1, "the first segment started");
    assert.ok(s.native.live, "its child is tracked as live");

    // The region moved while recording: the retarget stops segment 1 and waits
    // for ffmpeg to close the file before starting the next one.
    rec.applyRegion({ x: 200, y: 100, width: 640, height: 360 });
    await wait(20);
    assert.equal(s.native.live, null, "segment 1 is stopping; the gap is open");

    // A pause + resume arrives exactly inside that gap.
    h["recorder:state"](fromBar, "paused");
    h["recorder:state"](fromBar, "recording");
    // segment 1 finishes now: the retarget's queued start runs, then the resume
    // finds a live child and does nothing.
    spawn.kids[0].close(0);
    await wait(40);
    assert.equal(spawn.calls.length, 2, "exactly one restart, never a second into the gap");
    assert.ok(s.native.live);

    // A direct start attempt while one is live is refused, not an overwrite.
    assert.equal(rec.__nativeForTest.start(s), false);
    assert.equal(spawn.calls.length, 2);
  } finally {
    // Kill, never await stop: the fake child never answers "q" (the 8 s kill
    // timer would hold the suite open).
    rec.__nativeForTest.killAll(rec.__setStateForTest().session || {});
    spawn.restore();
  }
});

test("every tracked child is killed when the session ends", async () => {
  const spawn = fakeSpawn();
  try {
    rec.configureRecorder({ ffmpeg: "ffmpeg-fake" });
    const s = pausedSession({ state: "recording" });
    rec.__setStateForTest({ session: s });
    assert.equal(rec.__nativeForTest.start(s), true);
    assert.equal(s.native.children.size, 1);
    const killed = rec.__nativeForTest.killAll(s);
    assert.equal(killed, 1);
    assert.equal(spawn.kids[0].killed, true);
    assert.equal(s.native.children.size, 0);
    assert.equal(s.native.live, null);
  } finally {
    spawn.restore();
  }
});

test("a native region too small to grab is refused before the state moves", async () => {
  const spawn = fakeSpawn();
  try {
    rec.configureRecorder({ ffmpeg: "ffmpeg-fake" });
    const bar = fakeBar();
    const s = pausedSession({
      state: "starting", bar, segments: [],
      native: { rect: { x: 0, y: 0, width: 1, height: 9 }, stamp: "t", parts: [], live: null, chain: null, children: new Set() },
    });
    rec.__setStateForTest({ session: s });
    const h = rec.handlers();
    const fromBar = { sender: { id: bar.webContents.id } };
    const r = h["recorder:state"](fromBar, "recording");
    assert.equal(r.ok, false);
    assert.match(r.reason, /too small/);
    assert.equal(s.state, "starting", "the bar is never told it is recording");
    await wait(10);
    assert.equal(spawn.calls.length, 0);
    assert.equal(core.nativeGrabSize(s.native.rect), null);
  } finally {
    spawn.restore();
  }
});

test("a drag WHILE RECORDING restarts ffmpeg exactly once", async () => {
  const spawn = fakeSpawn();
  try {
    rec.configureRecorder({ ffmpeg: "ffmpeg-fake" });
    rec.__setRegionSettleMsForTest(25);
    const bar = fakeBar();
    const s = pausedSession({ state: "starting", bar, segments: [] });
    rec.__setStateForTest({ session: s });
    const h = rec.handlers();
    h["recorder:state"]({ sender: { id: bar.webContents.id } }, "recording");
    await wait(10);
    assert.equal(spawn.calls.length, 1);
    for (let i = 0; i < 20; i += 1) rec.applyRegion({ x: 100 + i, y: 100, width: 640, height: 360 });
    await wait(60);
    spawn.kids[0].close(0);
    await wait(30);
    assert.equal(spawn.calls.length, 2, "20 drag ticks -> one stop/start, not twenty");
  } finally {
    rec.__nativeForTest.killAll(rec.__setStateForTest().session || {});
    spawn.restore();
  }
});

test("a failure while a retarget is queued spawns no grabber afterwards", async () => {
  const spawn = fakeSpawn();
  try {
    rec.configureRecorder({ ffmpeg: "ffmpeg-fake" });
    rec.__setRegionSettleMsForTest(0);
    const bar = fakeBar();
    const s = pausedSession({
      state: "starting", bar, segments: [],
      writer: { close() {}, bytes: 1, path: "x" },
    });
    rec.__setStateForTest({ session: s });
    const h = rec.handlers();
    const fromBar = { sender: { id: bar.webContents.id } };
    h["recorder:state"](fromBar, "recording");
    await wait(10);
    rec.applyRegion({ x: 300, y: 100, width: 640, height: 360 });
    await wait(10); // the retarget is now waiting for segment 1 to close
    // The teardown runs before the toast; the toast needs a real Electron screen.
    try { h["recorder:failed"](fromBar, "test failure"); } catch { /* no electron.screen under node --test */ }
    const before = spawn.calls.length;
    spawn.kids[0].close(0);
    await wait(40);
    assert.equal(spawn.calls.length, before, "no ffmpeg after the failure teardown");
    assert.equal(s.state, "failed");
  } finally {
    rec.__nativeForTest.killAll({});
    spawn.restore();
  }
});
