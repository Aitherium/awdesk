"use strict";
// A customer desk opens on its taskbar (the Living Desktop), at first launch as on a
// second one (customer report 2026-10-20: "when he opens the Aither app he just wants
// the taskbar"). main.cjs wires electron at load, so the wiring is asserted on its source.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const main = fs.readFileSync(path.join(__dirname, "main.cjs"), "utf8");

test("first launch: a customer desk shows the Living Desktop unless started in the background", () => {
  // ...and unless the user turned overlay.workspaceAutoOpen off (customer report 2026-11-19: "it
  // keeps popping up"): the customer taskbar at start asks the WORKSPACE door first.
  assert.match(main, /else if \(deskPostureState\.customer && !startInBackground\) \{\s*if \(overlayMayRaise\(overlayPolicy\.TRIGGERS\.WORKSPACE, "customer taskbar"\)\) showLivingDesktop\(\);/);
});

test("after a sign-in the workspace window asks the WORKSPACE door before opening by itself", () => {
  assert.match(main, /setAutoOpenGate\(\s*\(\) => overlayMayRaise\(overlayPolicy\.TRIGGERS\.WORKSPACE,/);
});

test("second launch: a customer desk brings up the Living Desktop, not the avatar stage", () => {
  assert.match(main, /if \(deskPostureState\.customer\) showLivingDesktop\(\);\s*else showOverlay\(\{ focus: true \}\);/);
});

test("a customer desk with no character keeps the avatar stage hidden at launch", () => {
  assert.match(main, /if \(!deskPostureState\.customer \|\| listCharacters\(\)\.length > 0\) showOverlay\(\);/);
});
