"use strict";

// Owner 2026-10-04: "every time I click on the avatar it interrupts whatever it is saying
// and speaks a voice line that the microphone is muted ... that's annoying". main.cjs
// cannot load outside Electron, so this pins the source: the muted branch of
// toggleListening never speaks, and the on-screen hint is silent and throttled.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const src = fs.readFileSync(path.join(__dirname, "main.cjs"), "utf8");

function body(name) {
  const start = src.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `${name} not found`);
  const end = src.indexOf("\n}\n", start);
  return src.slice(start, end);
}

test("a click with the mic muted never speaks over the avatar", () => {
  const toggle = body("toggleListening");
  const muted = toggle.slice(toggle.indexOf("if (micMuted())"), toggle.indexOf("const mode"));
  assert.doesNotMatch(muted, /speakAloud\(/);
  assert.match(muted, /hintMicMuted\(\)/);
});

test("the muted hint is silent and shown at most once every 30 s", () => {
  const hint = body("hintMicMuted");
  assert.match(hint, /silent: true/);
  assert.match(hint, /now - lastMutedHintAt < 30_000/);
  assert.doesNotMatch(hint, /speakAloud\(/);
});
