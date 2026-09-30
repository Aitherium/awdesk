"use strict";

/**
 * Hearth on the desk: one registry row, one runCommand arm, and a desktop-app URL
 * that opens the `hearth` window on arrival. Removing any of the three fails here.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { COMMANDS } = require("./command-registry.cjs");

const read = (f) => fs.readFileSync(path.join(__dirname, f), "utf8");

test("the registry lists Hearth on the tray and the palette", () => {
  const row = COMMANDS.find((c) => c.id === "hearth.open");
  assert.ok(row, "hearth.open is not in the command registry");
  assert.deepEqual([...row.surfaces], ["tray", "palette"]);
});

test("runCommand opens the desktop app on the hearth window", () => {
  assert.match(read("main.cjs"), /case "hearth\.open": return void showDesktopApp\(\{ app: "hearth" \}\);/);
});

test("the desktop app URL carries ?app= and the first load uses it", () => {
  const src = read("living-desktop-window.cjs");
  assert.match(src, /if \(app\) url\.searchParams\.set\("app", app\);/);
  assert.match(src, /const target = desktopAppUrl\(app\);/);
});
