"use strict";

// Every key the desk binds, in ONE table: no chord may belong to two commands, and
// every ink / pin / GIF action has a default key (owner 2026-11-07).

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const registry = require("./command-registry.cjs");
const { LAUNCHER_ACCELS } = require("./search-window.cjs");

test("no chord is bound to two different commands (registry defaults, fallbacks and the launcher keys)", () => {
  // The launcher's keys belong to search.universal (its default + fallback).
  const extra = LAUNCHER_ACCELS.map((accel) => ({ accel, id: "search.universal" }));
  assert.deepEqual(registry.bindingConflicts(extra), []);
});

test("the conflict check can fail: a duplicate binding is reported", () => {
  const dup = [{ id: "a.one", accel: "Ctrl+Alt+D" }, { id: "b.two", accelFallback: "ctrl+alt+d" }];
  assert.deepEqual(registry.bindingConflicts([], dup), [{ accel: "Ctrl+Alt+D", ids: ["a.one", "b.two"] }]);
});

test("every ink, pin and GIF action has a default key", () => {
  const actions = registry.COMMANDS.filter((c) => /^(ink|pins|gif)\./.test(c.id));
  assert.ok(actions.length >= 12, `found ${actions.length}`);
  for (const c of actions) assert.ok(c.accel, `${c.id} has no default key`);
});

test("no module registers a global shortcut behind the registry's back", () => {
  // The only literal registrations allowed: main's registry loop and the launcher's.
  const offenders = [];
  for (const name of fs.readdirSync(__dirname).filter((n) => n.endsWith(".cjs") && !n.endsWith(".test.cjs"))) {
    const text = fs.readFileSync(path.join(__dirname, name), "utf8");
    for (const m of text.matchAll(/globalShortcut\.register\(\s*["'`]([^"'`]+)["'`]/g)) offenders.push(`${name}: ${m[1]}`);
  }
  assert.deepEqual(offenders, []);
});

test("the Shortcuts sheet lists every bound command, live vs fallback vs taken", () => {
  const sheet = registry.shortcutSheet({ liveAccels: { "gif.open": "Ctrl+Alt+Shift+I" }, deadAccels: ["Ctrl+Alt+I", "Ctrl+Alt+T"] });
  const row = (id) => sheet.find((r) => r.id === id);
  assert.equal(row("ink.toggle").state, "bound");
  assert.equal(row("gif.open").state, "fallback");
  assert.equal(row("pins.tab").state, "held by another app");
  assert.ok(row("shortcuts.open"), "the sheet lists itself");
  assert.match(registry.shortcutSheetText({}), /Ctrl\+Alt\+D\s+Draw on screen/);
});
