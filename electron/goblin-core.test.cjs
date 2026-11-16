"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const core = require("./goblin-core.cjs");

test("every weapon set ships every frame the page asks for", () => {
  for (const weapon of core.WEAPONS) {
    for (const rel of core.requiredFiles(weapon)) {
      assert.ok(fs.existsSync(path.join(core.frameRoot(__dirname), rel)), `missing goblin art: ${rel}`);
    }
  }
});

test("frame paths loop the idle clip and the talk frames; one still per other mood", () => {
  assert.equal(core.framePath("sword", "idle", 0), "sword/idle/frame_00.png");
  assert.equal(core.framePath("sword", "idle", 13), "sword/idle/frame_01.png");
  assert.equal(core.framePath("noodle", "talking", 5), "noodle/talking-1.png");
  assert.equal(core.framePath("sword", "thinking", 99), "sword/thinking.png");
  assert.equal(core.framePath("bogus", "bogus", 0), "sword/idle/frame_00.png");
});

test("goblin.html asks for the same frame names goblin-core.framePath makes", () => {
  const html = fs.readFileSync(path.join(__dirname, "goblin.html"), "utf8");
  assert.match(html, /idle\/frame_/);
  assert.match(html, /"\/talking-"|\/talking-/);
  assert.match(html, /IDLE = 12, TALK = 4/);
  assert.equal(core.IDLE_FRAMES, 12);
  assert.equal(core.TALK_FRAMES, 4);
});

test("the goblin stands beside the fairy, feet on its baseline, and never off the work area", () => {
  const area = { x: 0, y: 0, width: 1920, height: 1040 };
  const b = core.standBounds({ x: 1500, y: 900, width: 72, height: 72 }, area);
  assert.equal(b.x, 1500 - core.SIZE.width - 8);
  assert.equal(b.y + b.height, 900 + 72);
  const edge = core.standBounds({ x: 10, y: 5, width: 72, height: 72 }, area);
  assert.ok(edge.x >= 0 && edge.y >= 0);
  const none = core.standBounds(null, area);
  assert.equal(none.x + none.width + 24, 1920);
});
