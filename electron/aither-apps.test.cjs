"use strict";

/**
 * The desk opens the same Aither apps the phone's shortcuts do: one registry row per
 * app (palette + the Windows jump list), each opening that OS window on the
 * AitherDesktop app. Dropping a row or the main.cjs branch fails here.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { COMMANDS, conformance } = require("./command-registry.cjs");

const APPS = ["family", "learn", "sprite", "academy", "spaces", "avatar", "control", "image-studio"];

test("every Aither app has a palette + jump-list row", () => {
  for (const app of APPS) {
    const row = COMMANDS.find((c) => c.osApp === app);
    assert.ok(row, `no row opens ?app=${app}`);
    assert.deepEqual([...row.surfaces], ["palette", "jumplist"]);
  }
  assert.ok(COMMANDS.find((c) => c.id === "hearth.open"), "Hearth keeps its own row");
  assert.deepEqual(conformance(), []);
});

test("main.cjs opens a row's osApp on the desktop app window", () => {
  const src = fs.readFileSync(path.join(__dirname, "main.cjs"), "utf8");
  // The pin used to match the old one-liner. 632eca82b7d (decision cards,
  // owner 2026-10-05) gave osApp rows a browser-TAB door first -- Family opens
  // as a plain page in an Aither Browser tab -- with showDesktopApp as the
  // fallback. The pin was not moved with the door, so every leg of the v0.1.11
  // release went red (run 37425111896) on a test whose subject still worked.
  // Pin the DOOR and the FALLBACK, not the shape of one line.
  assert.match(src, /if \(command && command\.osApp\) \{/);
  assert.match(src, /commandRegistry\.osAppTabUrl\(command\.osApp\)/);
  assert.match(src, /return void showDesktopApp\(\{ app: command\.osApp \}\);/);
});
