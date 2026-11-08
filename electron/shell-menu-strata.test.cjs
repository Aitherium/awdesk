"use strict";
// The desktop right-click Aither menu opens Aither Files and the Strata storage page
// directly (owner, 2026-11-07), and both ids are real registry commands main.cjs runs.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const sm = require("./shell-menu.cjs");
const registry = require("./command-registry.cjs");

test("the right-click menu leads with Aither Files and Strata storage", () => {
  const ids = sm.ENTRIES.map((e) => e.id);
  assert.deepEqual(ids.slice(0, 2), ["files.open", "strata.open"]);
});

test("both menu ids are registry commands", () => {
  for (const id of ["files.open", "strata.open"]) assert.ok(registry.byId(id), `${id} missing from the registry`);
});

test("main.cjs runs strata.open by opening the console's strata page", () => {
  const main = fs.readFileSync(path.join(__dirname, "main.cjs"), "utf8");
  assert.match(main, /case "strata\.open": return void openConsole\("strata"\);/);
});
