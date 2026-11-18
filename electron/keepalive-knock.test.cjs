"use strict";

// The logon shim's keepalive knocks a running desk whenever its /health probe times out
// on a stalled-but-alive main thread. The knock must never show or focus anything: it
// made the avatar vanish and reappear and windows flash every few minutes (2026-11-17).

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const main = fs.readFileSync(path.join(__dirname, "main.cjs"), "utf8");

test("a --keepalive knock returns before any second-instance handler can show a window", () => {
  const start = main.indexOf('app.on("second-instance"');
  assert.ok(start > 0, "second-instance handler not found");
  const body = main.slice(start, start + 4000);
  const knock = body.indexOf('argv.includes("--keepalive")');
  assert.ok(knock > 0, "the handler does not look for --keepalive");
  for (const shown of ["openKidClassroom()", "showOverlay(", "showLivingDesktop()", "createDeckWindow()"]) {
    const at = body.indexOf(shown);
    assert.ok(at < 0 || knock < at, `${shown} runs before the keepalive check`);
  }
  assert.match(body.slice(knock, knock + 200), /return;/);
});

test("a cold start with --keepalive still draws the avatar (it is not --background)", () => {
  assert.match(main, /const startInBackground = process\.argv\.includes\("--background"\);/);
  assert.ok(!/startInBackground\s*=.*--keepalive/.test(main));
});
