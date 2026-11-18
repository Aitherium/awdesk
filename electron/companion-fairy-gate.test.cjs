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

/** `saved` is the desk-companion.json body: a companion mode string, or an object
 *  (so the owner's saved `avatarHidden` can be exercised beside it). */
function harness(saved) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fairy-"));
  const file = path.join(dir, "desk-companion.json");
  if (saved) {
    const body = typeof saved === "string" ? { companion: saved } : saved;
    fs.writeFileSync(file, JSON.stringify(body));
  }
  const calls = { shown: 0, inactive: 0, focused: 0 };
  const win = {
    isMinimized: () => false, restore() {}, isVisible: () => false,
    show() { calls.shown++; }, showInactive() { calls.inactive++; }, focus() { calls.focused++; },
  };
  const body = `
    const COMPANION_FILE = ${JSON.stringify(file)};
    ${grab("readCompanionFile")}
    ${grab("avatarHiddenByOwner")}
    ${grab("setAvatarHiddenByOwner")}
    ${grab("companionMode")}
    ${grab("showOverlay")}
    return showOverlay;`;
  const make = new Function(
    "fs", "path", "debugLog", "createWindow",
    "scheduleHyprlandWindowConfiguration", "tray", "refreshTrayMenu", body,
  );
  const showOverlay = make(fs, path, () => {}, () => win, () => {}, null, () => {});
  const savedFile = () => {
    try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return {}; }
  };
  return { showOverlay, calls, savedFile };
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

// ── "stays hidden across a crash and a restart" (the PR's whole point) ──────────
test("avatar mode: an AUTOMATIC show is suppressed after the owner hid the avatar", () => {
  const { showOverlay, calls } = harness({ companion: "avatar", avatarHidden: true });
  showOverlay();
  assert.equal(calls.inactive + calls.shown, 0, "the saved hide survives a restart");
});

test("avatar mode: an EXPLICIT show clears the saved hide", () => {
  const { showOverlay, calls, savedFile } = harness({ companion: "avatar", avatarHidden: true });
  showOverlay({ focus: true });
  assert.equal(calls.shown, 1, "an explicit owner action still shows it");
  assert.equal(savedFile().avatarHidden, false, "and the stale hide is not re-applied next launch");
});

test("avatar mode: an automatic show does not resurrect a hidden avatar", () => {
  const { showOverlay, calls, savedFile } = harness({ companion: "avatar", avatarHidden: true });
  showOverlay(); // a voice session / slot spawn
  assert.equal(calls.inactive + calls.shown, 0);
  assert.equal(savedFile().avatarHidden, true, "the automatic path never clears the owner's hide");
});

test("fairy mode: the hide flag is irrelevant, fairy gating still wins", () => {
  const { showOverlay, calls } = harness({ companion: "fairy", avatarHidden: false });
  showOverlay();
  assert.equal(calls.inactive + calls.shown, 0);
});
