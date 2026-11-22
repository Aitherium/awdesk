"use strict";

// game-posture: the desk stands down while the host posture is "Game on" (2026-10-16 21:33,
// owner: "i launched the game and there is a bunch of lag just in the start menu"). Measured
// that night: one HIDDEN desk renderer at 4.5-7 cores -- the owner box turns Chromium's
// background throttling off app-wide, so a hidden window kept animating in software.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { hostIsGaming, createGamePosture, BELOW } = require("./game-posture.cjs");

const NOW = Date.parse("2026-10-16T21:40:00-07:00");

function tmpHome() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "game-posture-"));
  fs.mkdirSync(path.join(dir, ".aither"));
  return dir;
}

function writePosture(home, doc) {
  fs.writeFileSync(path.join(home, ".aither", "posture.json"), JSON.stringify(doc));
}

test("posture.json desired=game with no until is gaming", () => {
  const home = tmpHome();
  writePosture(home, { desired: "game", source: "detected", until: null });
  assert.equal(hostIsGaming({ home, env: {}, now: NOW }), true);
});

test("an expired game override and an after-hours posture are not gaming", () => {
  const home = tmpHome();
  writePosture(home, { desired: "game", source: "cli", until: "2026-10-16T21:00:00-07:00" });
  assert.equal(hostIsGaming({ home, env: {}, now: NOW }), false);
  writePosture(home, { desired: "after", source: "cli", until: null });
  assert.equal(hostIsGaming({ home, env: {}, now: NOW }), false);
});

test("an active gaming.lock is gaming (fleet_verbs' rule: future expires, or fresh mtime)", () => {
  const home = tmpHome();
  const lock = path.join(home, ".aither", "gaming.lock");
  fs.writeFileSync(lock, JSON.stringify({ expires: "2026-10-17T09:00:00Z", by: "test" }));
  assert.equal(hostIsGaming({ home, env: {}, now: NOW }), true);
  fs.writeFileSync(lock, JSON.stringify({ expires: "2026-10-16T01:00:00Z" }));
  assert.equal(hostIsGaming({ home, env: {}, now: NOW }), false);
});

test("a corrupt posture file is not gaming and does not throw", () => {
  const home = tmpHome();
  fs.writeFileSync(path.join(home, ".aither", "posture.json"), "{nope");
  assert.equal(hostIsGaming({ home, env: {}, now: NOW }), false);
});

function fakeDesk() {
  const wins = [1, 2, 3].map((id) => {
    let throttled = false;
    return {
      id,
      isDestroyed: () => false,
      webContents: {
        id,
        getBackgroundThrottling: () => throttled,
        setBackgroundThrottling: (v) => { throttled = v; },
      },
      throttled: () => throttled,
    };
  });
  return {
    wins,
    BrowserWindow: { getAllWindows: () => wins },
    app: { getAppMetrics: () => [{ pid: 10 }, { pid: 11 }] },
  };
}

test("entering game throttles every window, hides the overlay, lowers every desk process", () => {
  const d = fakeDesk();
  let gaming = true;
  let overlay = true;
  const prio = [];
  const gp = createGamePosture({
    app: d.app, BrowserWindow: d.BrowserWindow, read: () => gaming,
    overlayVisible: () => overlay, hideOverlay: () => { overlay = false; },
    showOverlay: () => { overlay = true; }, restorePriority: -7,
    setPriority: (pid, p) => prio.push([pid, p]), log: () => {},
  });
  gp.tick();
  assert.equal(gp.active(), true);
  assert.ok(d.wins.every((w) => w.throttled()), "hidden windows stop animating");
  assert.equal(overlay, false, "the always-on-top overlay leaves the game's screen");
  assert.deepEqual(prio, [[10, BELOW], [11, BELOW]]);

  // the overlay was re-shown mid-game by something else: the next tick hides it again
  overlay = true;
  gp.tick();
  assert.equal(overlay, false);

  // game over: throttling back to what each window had, overlay back, priority restored
  gaming = false;
  prio.length = 0;
  gp.tick();
  assert.equal(gp.active(), false);
  assert.ok(d.wins.every((w) => !w.throttled()));
  assert.equal(overlay, true);
  assert.deepEqual(prio, [[10, -7], [11, -7]]);
});

test("an overlay that was hidden before the game stays hidden after it", () => {
  const d = fakeDesk();
  let gaming = true;
  let shown = 0;
  const gp = createGamePosture({
    app: d.app, BrowserWindow: d.BrowserWindow, read: () => gaming,
    overlayVisible: () => false, hideOverlay: () => {}, showOverlay: () => { shown += 1; },
    restorePriority: null, setPriority: () => {}, log: () => {},
  });
  gp.tick();
  gaming = false;
  gp.tick();
  assert.equal(shown, 0);
});

test("a throwing read never breaks the desk and counts as not gaming", () => {
  const d = fakeDesk();
  const gp = createGamePosture({
    app: d.app, BrowserWindow: d.BrowserWindow, read: () => { throw new Error("EIO"); },
    overlayVisible: () => true, hideOverlay: () => {}, showOverlay: () => {},
    restorePriority: null, setPriority: () => {}, log: () => {},
  });
  assert.doesNotThrow(() => gp.tick());
  assert.equal(gp.active(), false);
});
