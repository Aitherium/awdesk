"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { compile, hiddenReason, applyExclusions, loadRules, DEFAULTS } = require("./search-exclusions.cjs");

// The exact rows from the owner's screenshot (2026-11-06, query "scre").
const SCREENSHOT = [
  { title: "On-Screen Keyboard", subtitle: "Accessibility", kind: "app" },
  { title: "Scarlet Skips", subtitle: "Steam", kind: "app" },
  { title: "Sound Recorder", subtitle: "App", kind: "app" },
  { title: "Steps Recorder", subtitle: "Accessories", kind: "app" },
  { title: "Succubus Nightmare", subtitle: "Steam", kind: "app" },
];

test("defaults hide both Steam titles from the screenshot and keep the real tools", () => {
  const { rows, hidden } = applyExclusions(SCREENSHOT, compile(DEFAULTS));
  assert.deepEqual(rows.map((r) => r.title), ["On-Screen Keyboard", "Sound Recorder", "Steps Recorder"]);
  assert.equal(hidden, 2);
});

test("an adult title is hidden even when it is NOT in a game folder", () => {
  const rules = compile({ ...DEFAULTS, hideGames: false });
  assert.equal(hiddenReason({ title: "Succubus Nightmare", subtitle: "Downloads", kind: "app" }, rules), "adult");
  assert.equal(hiddenReason({ title: "Scarlet Skips", subtitle: "Steam", kind: "app" }, rules), null);
});

test("the adult list does not over-match ordinary words", () => {
  const rules = compile(DEFAULTS);
  for (const title of ["Sound Recorder", "Scarlet", "Sussex Map", "Essex", "Lustre Paint", "Express VPN", "Sextant"]) {
    assert.equal(hiddenReason({ title, subtitle: "App", kind: "app" }, rules), null, title);
  }
});

test("allow beats every rule", () => {
  const rules = compile({ ...DEFAULTS, allow: ["Scarlet Skips"] });
  assert.equal(hiddenReason(SCREENSHOT[1], rules), null);
});

test("owner titles, folders and patterns are honoured; a bad regex disables nothing", () => {
  const rules = compile({ ...DEFAULTS, titles: ["Steps Recorder"], folders: ["Accessibility"], patterns: ["[", "^Sound"] });
  const { rows } = applyExclusions(SCREENSHOT, rules);
  assert.deepEqual(rows.map((r) => r.title), []);
});

test("a missing or corrupt settings file falls back to SAFE defaults, never 'show everything'", () => {
  const broken = { readFileSync: () => "{not json" };
  const rules = loadRules({ fsImpl: broken });
  assert.ok(hiddenReason(SCREENSHOT[4], rules), "the adult Steam title is hidden");
  const missing = { readFileSync: () => { throw new Error("ENOENT"); } };
  assert.equal(hiddenReason(SCREENSHOT[1], loadRules({ fsImpl: missing })), "game");
});
