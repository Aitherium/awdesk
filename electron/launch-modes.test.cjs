"use strict";

/**
 * Owner, 2026-10-13: Sprite / Academy / Spaces from the AitherBrowser rail booted the
 * FULL-SCREEN Living Desktop with the app on top, every time ("we need to be able to
 * configure this"). Each app now has a launch mode; the default is the app alone.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const lm = require("./launch-modes.cjs");
const rail = require("./browser-rail.cjs");
const { PANES } = require("./console-window.cjs");

const ONLINE = "https://app.aitherium.com/";

test("the default opens the app ALONE, not the Living Desktop", () => {
  assert.equal(lm.launchModeFor({}, "sprite"), "tab");
  const url = new URL(lm.appUrl(ONLINE, "sprite", lm.launchModeFor({}, "sprite")));
  assert.equal(url.pathname, "/solo");
  assert.equal(url.searchParams.get("app"), "sprite");
  assert.equal(url.searchParams.get("spawn"), null, "?spawn= is the full desktop");
  assert.equal(new URL(lm.appUrl(ONLINE, "academy", "window")).pathname, "/solo");
});

test("desktop mode keeps the old door: the Living Desktop with the app spawned", () => {
  const url = new URL(lm.appUrl("https://app.aitherium.com/somewhere?x=1#h", "spaces", "desktop"));
  assert.equal(url.pathname, "/");
  assert.equal(url.search, "?spawn=spaces");
  assert.equal(url.hash, "");
});

test("a hand-edited layout file cannot smuggle a mode or an id", () => {
  assert.deepEqual(lm.normalizeLaunchModes({
    sprite: "desktop", academy: "window", spaces: "tab", "../x": "window", Bad: "desktop", lyra: "fullscreen",
  }), { sprite: "desktop", academy: "window" });
  for (const bad of [null, "x", [], 7]) assert.deepEqual(lm.normalizeLaunchModes(bad), {});
  assert.equal(lm.launchModeFor({ sprite: "nope" }, "sprite"), "tab");
  assert.equal(lm.appUrl(ONLINE, "../etc", "tab"), null);
  assert.equal(lm.appUrl("not a url", "sprite", "tab"), null);
});

test("the chip cycles tab -> window -> desktop -> tab and parses its argument", () => {
  assert.equal(lm.nextMode("tab"), "window");
  assert.equal(lm.nextMode("window"), "desktop");
  assert.equal(lm.nextMode("desktop"), "tab");
  assert.deepEqual(lm.parseModeArg("sprite:window"), { id: "sprite", mode: "window" });
  assert.equal(lm.parseModeArg("sprite:fullscreen"), null);
  assert.equal(lm.parseModeArg("sprite"), null);
  assert.deepEqual(lm.withMode({ academy: "window" }, "sprite", "desktop"), { academy: "window", sprite: "desktop" });
  assert.deepEqual(lm.withMode({ sprite: "desktop" }, "sprite", "tab"), {}, "back to default drops the entry");
  assert.equal(lm.withMode({}, "sprite", "huge"), null);
});

test("the layout persists launch modes and the rail rows carry them", () => {
  assert.deepEqual(rail.normalizeLayout({ launchModes: { sprite: "desktop" } }).launchModes, { sprite: "desktop" });
  const rows = rail.railSections(PANES, { modes: { sprite: "window" } }).flatMap((s) => s.rows);
  const sprite = rows.find((r) => r.kind === "online" && r.id === "sprite");
  const spaces = rows.find((r) => r.kind === "online" && r.id === "spaces");
  assert.equal(sprite.launch, "window");
  assert.equal(spaces.launch, "tab");
});

test("the rail's Online door goes through the launch mode, not a hardcoded ?spawn=", () => {
  const src = fs.readFileSync(path.join(__dirname, "browser-window.cjs"), "utf8");
  const body = src.slice(src.indexOf("function openAgentApp("), src.indexOf("function openWorkspacePage("));
  assert.match(body, /return openOnlineApp\(id\);/);
  assert.match(body, /launchModes\.launchModeFor\(getPrefs\(\)\.launchModes, id\)/);
  assert.doesNotMatch(body.slice(0, body.indexOf("\n}\n")), /\?spawn=/,
    "openAgentApp loaded <online>/?spawn=<id> unconditionally: the full desktop for every app");
  assert.match(src, /action === "launch-mode"/);
  const chrome = fs.readFileSync(path.join(__dirname, "browser-chrome.html"), "utf8");
  assert.match(chrome, /api\.rail\("launch-mode", `\$\{row\.id\}:\$\{mode\.next\}`\)/);
  for (const mode of lm.MODES) assert.ok(chrome.includes(`${mode}: { glyph: "${lm.MODE_LABELS[mode].glyph}"`), `chip glyph for ${mode}`);
});
