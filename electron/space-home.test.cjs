"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const sh = require("./space-home.cjs");
const overlayPolicy = require("./overlay-policy.cjs");
const cast = require("./cast-config.cjs");
const registry = require("./command-registry.cjs");

const SPACE = { id: "space", label: "Space", kind: "view" };
const SPACE_FLAGGED = { id: "space", label: "Space", kind: "view", query: "space=1" };

test("spaceHome off: every door is exactly as before (null = the old pane)", () => {
  for (const pane of ["cards", "inbox", "fleet", "settings"]) {
    assert.equal(sh.spaceTarget(pane, { spaceHome: false, spacePane: SPACE }), null, pane);
    assert.equal(sh.spaceTarget(pane, { spacePane: SPACE }), null, `${pane} (unset)`);
  }
  assert.equal(sh.spaceTarget("cards", { spaceHome: false, spacePane: SPACE, cardId: "dc-1" }), null);
});

test("spaceHome on but no Space pane in this build: still the old pane, never a 404", () => {
  assert.equal(sh.spaceTarget("cards", { spaceHome: true, spacePane: null }), null);
  assert.equal(sh.spaceTarget("fleet", { spaceHome: true, spacePane: null }), null);
});

test("spaceHome on: the bell / needs-you line / rail Inbox open the Space on the next ask", () => {
  assert.equal(sh.spaceTarget("cards", { spaceHome: true, spacePane: SPACE }), "aither://space/?focus=next");
  assert.equal(sh.spaceTarget("inbox", { spaceHome: true, spacePane: SPACE }), "aither://space/?focus=next");
  // A row that named its card lands on that card; a bad id falls back to "next".
  assert.equal(sh.spaceTarget("cards", { spaceHome: true, spacePane: SPACE, cardId: "dc-7" }),
    "aither://space/?card=dc-7");
  assert.equal(sh.spaceTarget("cards", { spaceHome: true, spacePane: SPACE, cardId: "a b" }),
    "aither://space/?focus=next");
  // The Space pane ignores ids outside /^[A-Za-z0-9_-]{1,80}$/, so main never builds one.
  assert.equal(sh.spaceTarget("cards", { spaceHome: true, spacePane: SPACE, cardId: "ask:proton.bridge_1" }),
    "aither://space/?focus=next");
  assert.equal(sh.cardLink("x".repeat(81)), null);
});

test("spaceHome on: the rail Fleet row opens the fleet galaxy", () => {
  assert.equal(sh.spaceTarget("fleet", { spaceHome: true, spacePane: SPACE }), "aither://space/?at=galaxy:fleet");
  assert.equal(sh.spaceTarget("settings", { spaceHome: true, spacePane: SPACE }), null, "other panes untouched");
});

test("only a real true turns it on", () => {
  for (const v of ["true", 1, "yes", null, undefined, {}]) {
    assert.equal(sh.spaceHomeOn({ spaceHome: v }), false, String(v));
  }
  assert.equal(sh.spaceHomeOn({ spaceHome: true }), true);
  assert.equal(sh.spaceHomeOn(null), false);
});

test("a view pane's own query flag rides first, so the renderer still picks the Space view", () => {
  assert.equal(sh.nextLink(SPACE_FLAGGED), "aither://space/?space=1&focus=next");
  assert.equal(sh.spaceTarget("fleet", { spaceHome: true, spacePane: SPACE_FLAGGED }),
    "aither://space/?space=1&at=galaxy:fleet");
});

test("canonicalSpaceLink: re-builds a page's link from its parts, or refuses it", () => {
  const ok = (url, want, pane = SPACE) => assert.equal(sh.canonicalSpaceLink(url, pane), want, url);
  ok("aither://space/?focus=next", "aither://space/?focus=next");
  ok("aither://space/?at=galaxy:fleet", "aither://space/?at=galaxy:fleet");
  ok("aither://space/?card=dc-9", "aither://space/?card=dc-9");
  ok("aither://space/", "aither://space/");
  ok("aither://space/?focus=next", "aither://space/?space=1&focus=next", SPACE_FLAGGED);
  ok("aither://space/?space=1&card=x1", "aither://space/?space=1&card=x1", SPACE_FLAGGED);
  for (const bad of [
    "https://space/?focus=next",
    "aither://fleet/?focus=next",
    "aither://space/index.html?focus=next",
    "aither://space/?focus=prev",
    "aither://space/?at=GALAXY",
    "aither://space/?at=galaxy:fleet&card=dc-1",
    "aither://space/?evil=1",
    "aither://space/?card=a%20b",
    "aither://space/?card=ask:proton.bridge_1",
    "not a url",
    "",
  ]) {
    ok(bad, null);
  }
});

test("overlay-policy carries spaceHome: default off, normalized, patchable", () => {
  assert.equal(overlayPolicy.DEFAULTS.spaceHome, false);
  assert.equal(overlayPolicy.normalize({}).spaceHome, false);
  assert.equal(overlayPolicy.normalize({ spaceHome: true }).spaceHome, true);
  assert.deepEqual(overlayPolicy.cleanPatch({ spaceHome: true }), { spaceHome: true });
  assert.deepEqual(overlayPolicy.cleanPatch({ spaceHome: "on" }), {});
  // Not a door: it never lets anything raise itself.
  const s = { spaceHome: true };
  for (const trigger of Object.values(overlayPolicy.TRIGGERS)) {
    if (trigger === overlayPolicy.TRIGGERS.USER || trigger === overlayPolicy.TRIGGERS.REQUEST) continue;
    assert.equal(overlayPolicy.decide(s, trigger).allow, false, trigger);
  }
});

test("cast.json stores it where the other desk prefs live (overlay.*), default false", () => {
  const off = cast.resolveDesk({ version: 1 }, { env: {} });
  assert.equal(off.overlay.spaceHome, false);
  const on = cast.resolveDesk({ version: 1, overlay: { spaceHome: true } }, { env: {} });
  assert.equal(on.overlay.spaceHome, true);
  assert.equal(on.problems.length, 0, JSON.stringify(on.problems));
});

test("one switch: the settings row and a palette/bridge command, never a tray row", () => {
  const html = fs.readFileSync(path.join(__dirname, "settings.html"), "utf8");
  assert.equal((html.match(/id="ovSpaceHome"/g) || []).length, 1, "one checkbox row");
  assert.match(html, /spaceHome: document\.getElementById\("ovSpaceHome"\)/, "wired into the overlay switches");
  const cmd = registry.byId("desktop.space-home");
  assert.ok(cmd, "registry command exists");
  assert.deepEqual([...cmd.surfaces], ["palette"]);
  assert.equal(cmd.checked({ overlayPolicy: { spaceHome: true } }), true);
});

test("main routes the Inbox door, the rail and the Fleet page through space-home", () => {
  const main = fs.readFileSync(path.join(__dirname, "main.cjs"), "utf8");
  const inbox = /function openInbox\(cardId = null\) \{([\s\S]*?)\n\}/.exec(main);
  assert.ok(inbox, "openInbox found");
  assert.match(inbox[1], /spaceHomeTarget\("cards", id\)/, "openInbox consults spaceHome first");
  assert.match(main, /homeFor: \(paneId\) => spaceHomeTarget\(paneId\)/, "the rail's page action is hooked");
  assert.match(main, /setFleetSpaceOpener\(\(url\) => openSpaceLink\(url\), \(\) => Boolean\(spacePane\(\)\)\)/,
    "the Fleet page's link is wired, and gated on a real Space pane");
  assert.match(main, /case "desktop\.space-home": return void toggleOverlaySetting\("spaceHome"\)/);
  const browser = fs.readFileSync(path.join(__dirname, "browser-window.cjs"), "utf8");
  assert.match(browser, /internalConfig\.homeFor\(String\(arg \|\| ""\)\)/, "browser rail asks main first");
  // A deep link is read once at mount: the same link clicked again must reload to refocus.
  assert.match(browser, /return showInternal\(pane, String\(url\), "always", opts\)/);
  assert.match(browser, /reload === "always" \|\| view\.webContents\.getURL\(\) !== url/);
});

test("fleet-window: Open in Space is available only with an opener AND a Space pane", () => {
  const fw = require("./fleet-window.cjs");
  try {
    fw.setSpaceOpener(null);
    assert.equal(fw.fleetSpaceAvailable(), false, "nothing wired");
    fw.setSpaceOpener(() => true);
    assert.equal(fw.fleetSpaceAvailable(), false, "an opener with no availability answer stays hidden");
    fw.setSpaceOpener(() => true, () => false);
    assert.equal(fw.fleetSpaceAvailable(), false, "no Space pane in this build");
    fw.setSpaceOpener(() => true, () => { throw new Error("x"); });
    assert.equal(fw.fleetSpaceAvailable(), false, "a throwing probe reads as no");
    fw.setSpaceOpener(() => true, () => true);
    assert.equal(fw.fleetSpaceAvailable(), true);
  } finally {
    fw.setSpaceOpener(null);
  }
});
