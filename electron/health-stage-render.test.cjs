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
  assert.match(bridge, /JSON\.stringify\(\{ ok: true, lastState: .*?, avatar, stage \}\)/);
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
