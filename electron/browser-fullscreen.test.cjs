"use strict";

// A video's full-screen button: the tab's view takes the whole window while the page is
// full screen, and the layout from before comes back when it leaves.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { EXIT_SCRIPT, createFullscreen, fullRect, fullscreenRects } = require("./browser-fullscreen.cjs");

const RECTS = Object.freeze({
  page: { x: 240, y: 78, width: 700, height: 600 },
  panel: { x: 940, y: 78, width: 380, height: 600 },
  taskbar: { x: 240, y: 678, width: 1080, height: 44 },
  dock: { x: 240, y: 500, width: 700, height: 178 },
  avatar: { x: 0, y: 78, width: 240, height: 240 },
});
const CONTENT = { x: 0, y: 0, width: 2400, height: 1350 };

test("the page takes the whole window; panel, taskbar and dock collapse; the avatar slot goes", () => {
  const out = fullscreenRects(RECTS, CONTENT);
  assert.deepEqual(out.page, { x: 0, y: 0, width: 2400, height: 1350 });
  for (const pane of ["panel", "taskbar", "dock"]) assert.deepEqual(out[pane], { x: 0, y: 0, width: 0, height: 0 }, pane);
  assert.equal(out.avatar, null);
  assert.deepEqual(RECTS.page, { x: 240, y: 78, width: 700, height: 600 }, "the input is not changed");
});

test("fullRect ignores the window's screen position and bad input", () => {
  assert.deepEqual(fullRect({ x: 755, y: 358, width: 890.4, height: 647 }), { x: 0, y: 0, width: 890, height: 647 });
  assert.deepEqual(fullRect(null), { x: 0, y: 0, width: 0, height: 0 });
});

test("only the tab on screen is laid out full screen, and leaving restores the same rects object", () => {
  const fsState = createFullscreen();
  assert.equal(fsState.rects(RECTS, CONTENT, 3), RECTS, "nobody is full screen");
  assert.equal(fsState.enter(3), true);
  assert.equal(fsState.enter(3), false, "entering twice changes nothing");
  assert.equal(fsState.tab(), 3);
  assert.deepEqual(fsState.rects(RECTS, CONTENT, 3).page, { x: 0, y: 0, width: 2400, height: 1350 });
  assert.equal(fsState.rects(RECTS, CONTENT, 4), RECTS, "another tab on screen keeps the normal layout");
  assert.equal(fsState.stale(4), 3, "and the full-screen tab is told to exit");
  assert.equal(fsState.stale(3), null);
  assert.equal(fsState.leave(9), false, "another tab leaving is not ours");
  assert.equal(fsState.leave(3), true);
  assert.equal(fsState.rects(RECTS, CONTENT, 3), RECTS, "the exact layout from before");
  assert.equal(fsState.leave(3), false);
});

test("leave() with no id ends whatever is full screen (the window closed)", () => {
  const fsState = createFullscreen();
  fsState.enter(7);
  assert.equal(fsState.leave(null), true);
  assert.equal(fsState.tab(), null);
});

test("the exit script only touches a page that is full screen", () => {
  assert.match(EXIT_SCRIPT, /document\.fullscreenElement \? document\.exitFullscreen\(\)/);
});

test("browser-window lays out through the full-screen state and listens for both events", () => {
  const src = fs.readFileSync(path.join(__dirname, "browser-window.cjs"), "utf8");
  const layout = src.slice(src.indexOf("function layout() {"), src.indexOf("// ── Hidden tabs give their renderer back"));
  assert.match(layout, /htmlFullscreen\.rects\(currentRects\(\), win\.getContentBounds\(\), tabs\.active\)/);
  assert.match(src, /"enter-html-full-screen"/);
  assert.match(src, /"leave-html-full-screen"/);
});
