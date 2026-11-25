"use strict";
// A customer desk opens its workspace in a full opaque framed application window,
// at first launch as on a second one (customer report 2026-11-25: full app view avoids
// colliding with Windows desktop icons/processes while preserving full tenant content).
// main.cjs wires electron at load, so the wiring is asserted on its source.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const main = fs.readFileSync(path.join(__dirname, "main.cjs"), "utf8");

test("first launch: a customer desk opens the full app window unless started in the background", () => {
  assert.match(main, /else if \(deskPostureState\.customer && !startInBackground\) showDesktopApp\(\);/);
});

test("second launch: a customer desk brings up the full app window, not the avatar stage", () => {
  assert.match(main, /if \(deskPostureState\.customer\) showDesktopApp\(\);\s*else showOverlay\(\{ focus: true \}\);/);
});

test("a customer desk with no character keeps the avatar stage hidden at launch", () => {
  assert.match(main, /if \(!deskPostureState\.customer \|\| listCharacters\(\)\.length > 0\) showOverlay\(\);/);
});
