"use strict";

// S1 (2026-11-18): the renderer's own frame rate must be visible where the stage's health
// already reports. The pieces are in three files (renderer sampler, preload channel, main's
// health payload) and none of them can be exercised without Electron — so this pins the
// WIRING, in the same source-assertion style desk-posture.test.cjs uses for main.cjs.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const read = (file) => fs.readFileSync(path.join(__dirname, file), "utf8");

test("main publishes the renderer frame stats on GET /health as stage.render", () => {
  const main = read("main.cjs");
  assert.match(main, /render:\s*\{\s*fps:\s*renderStats\.fps,\s*p95GapMs:\s*renderStats\.p95GapMs/);
  assert.match(main, /stageStatusProvider:\s*\(\)\s*=>\s*\(/);
  // The bridge serves `stage` from that provider.
  const bridge = read("bridge-server.cjs");
  assert.match(bridge, /stage = stageStatusProvider \? stageStatusProvider\(\) : null/);
  assert.match(bridge, /JSON\.stringify\(\{ ok: true, lastState: .*?, avatar, stage, memory \}\)/);
});

test("main publishes its own memory numbers on GET /health as memory", () => {
  // The soak gate (scripts/mem-soak.cjs) reads the desk's OWN accounting, not Task Manager.
  const main = read("main.cjs");
  assert.match(main, /memoryProvider: \(\) => \{/);
  assert.match(main, /mainMb: main \? mb\(main\) : 0/);
  const bridge = read("bridge-server.cjs");
  assert.match(bridge, /memory = memoryProvider \? memoryProvider\(\) : null/);
});

test("main accepts desk:frame-stats only from the avatar window", () => {
  const main = read("main.cjs");
  assert.match(main, /ipcMain\.on\("desk:frame-stats", \(event, stats\) => \{[\s\S]*?event\.sender !== avatarWindow\.webContents\) return;/);
  assert.match(main, /renderStats = \{ fps, p95GapMs, at: Date\.now\(\) \};/);
});

test("the preload exposes reportFrame with sanitised numbers", () => {
  const preload = read("preload.cjs");
  assert.match(preload, /reportFrame: \(stats\) => ipcRenderer\.send\("desk:frame-stats", \{/);
  assert.match(preload, /fps: Math\.max\(0, Number\(stats && stats\.fps\) \|\| 0\)/);
  assert.match(preload, /p95GapMs: Math\.max\(0, Number\(stats && stats\.p95GapMs\) \|\| 0\)/);
});

test("the Scene mounts the reporter, and the sampler module exists with a test", () => {
  const scene = read(path.join("..", "src", "components", "Scene.tsx"));
  assert.match(scene, /<RenderStatsReporter \/>/);
  assert.match(scene, /createFrameGap\(2000\)/);
  assert.ok(fs.existsSync(path.join(__dirname, "..", "src", "perf", "frameGap.ts")));
  assert.ok(fs.existsSync(path.join(__dirname, "..", "src", "perf", "frameGap.test.ts")));
});

test("the idle FPS mirror: Scene IDLE_FPS equals toolkit-core FRAME.idle", () => {
  // toolkit-core.cjs says FRAME.idle "mirrors src/components/Scene.tsx IDLE_FPS (asserted by
  // both test files)" — but until now no test read both ends, and the constant is duplicated.
  // A drift silently restores the 2026-11-18 lag (idle animation at the wrong speed), which is
  // the exact bug this slice fixes, so pin both.
  const scene = read(path.join("..", "src", "components", "Scene.tsx"));
  const m = /const IDLE_FPS = (\d+);/.exec(scene);
  assert.ok(m, "Scene.tsx defines IDLE_FPS");
  assert.equal(Number(m[1]), require("./toolkit-core.cjs").FRAME.idle,
    "Scene IDLE_FPS must equal toolkit-core FRAME.idle");
  assert.equal(Number(m[1]), 15, "idle is 15 fps (the S1 lag fix); deep idle stays 2");
});
