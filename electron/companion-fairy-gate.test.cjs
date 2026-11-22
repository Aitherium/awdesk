"use strict";
// Exercises the REAL showOverlay + companionMode source from the patched main.cjs,
// extracted by name so the test fails if either is changed or the gate removed.
const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");

const src = fs.readFileSync(path.join(__dirname, "main.cjs"), "utf8");
function grab(name) {
  // From "function name(" to the first line that is exactly "}" -- the file's own
  // top-level style -- so braces inside comments and strings cannot fool it.
  const lines = src.split(String.fromCharCode(10));
  const first = lines.findIndex((line) => line.startsWith(`function ${name}(`));
  assert.ok(first >= 0, `${name} not found`);
  const last = lines.findIndex((line, index) => index > first && line === "}");
  assert.ok(last > first, `${name} has no closing brace`);
  return lines.slice(first, last + 1).join(String.fromCharCode(10));
}

function harness(mode) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fairy-"));
  const file = path.join(dir, "desk-companion.json");
  if (mode) fs.writeFileSync(file, JSON.stringify({ companion: mode }));
  const calls = { shown: 0, inactive: 0, focused: 0 };
  const win = {
    isMinimized: () => false, restore() {}, isVisible: () => false,
    show() { calls.shown++; }, showInactive() { calls.inactive++; }, focus() { calls.focused++; },
  };
  const body = `
    const COMPANION_FILE = ${JSON.stringify(file)};
    ${grab("companionMode")}
    ${grab("showOverlay")}
    return showOverlay;`;
  const make = new Function("fs", "createWindow", "scheduleHyprlandWindowConfiguration", "tray", "refreshTrayMenu", body);
  const showOverlay = make(fs, () => win, () => {}, null, () => {});
  return { showOverlay, calls };
}

test("fairy mode (the default, no file): an AUTOMATIC show is suppressed", () => {
  const { showOverlay, calls } = harness(null);
  showOverlay();
  assert.equal(calls.inactive + calls.shown, 0);
});

test("fairy mode: an EXPLICIT owner show (focus:true) still works", () => {
  const { showOverlay, calls } = harness("fairy");
  showOverlay({ focus: true });
  assert.equal(calls.shown, 1);
  assert.equal(calls.focused, 1);
});

test("avatar mode: automatic shows behave exactly as before", () => {
  const { showOverlay, calls } = harness("avatar");
  showOverlay();
  assert.equal(calls.inactive, 1);
});
