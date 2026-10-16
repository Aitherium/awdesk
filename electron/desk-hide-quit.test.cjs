"use strict";

// The overlay over a customer's Windows desktop has an obvious Hide and Quit (Veil's
// dock, desk-window-controls.tsx). Measured 2026-10-16: a customer had to kill the desk
// from Task Scheduler because quit lived only in the tray menu. The OS posts
// desk.hide / desk.quit; the desk allowlists them again and runs them here.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

test("the overlay may send Hide and Quit, and nothing new beyond them", () => {
  const host = require("./overlay-browser-host.cjs");
  assert.equal(host.allowedCommand("desk.hide"), true);
  assert.equal(host.allowedCommand("desk.quit"), true);
  assert.equal(host.allowedCommand("desk.restart"), false);
  assert.equal(host.allowedCommand("desk.quit; rm"), false);
});

test("main runs them: hide the overlay, quit the app like the tray's Quit", () => {
  const main = fs.readFileSync(path.join(__dirname, "main.cjs"), "utf8").replace(/\r\n/g, "\n");
  assert.match(main, /if \(id === "desk\.hide"\) return void hideLivingDesktop\(\);/);
  assert.match(main, /if \(id === "desk\.quit"\) \{\n\s*isQuitting = true;\n\s*return void app\.quit\(\);/);
  assert.match(main, /\n  hideLivingDesktop,\n[^]*?\} = require\("\.\/living-desktop-window\.cjs"\);/);
});
