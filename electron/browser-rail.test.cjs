"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const rail = require("./browser-rail.cjs");
const { PANES } = require("./console-window.cjs");
const registry = require("./command-registry.cjs");
const chromeHtml = require("node:fs").readFileSync(require("node:path").join(__dirname, "browser-chrome.html"), "utf8");

test("every console pane is a rail row: nothing collapsed into the browser is unreachable", () => {
  const rows = rail.railSections(PANES).flatMap((sec) => sec.rows);
  for (const pane of PANES) {
    assert.ok(rows.some((row) => row.kind === "page" && row.id === pane.id), `${pane.id} has no rail row`);
  }
});

test("sections read in the declared order; Apps carries the OS apps as commands", () => {
  const names = rail.railSections(PANES).map((sec) => sec.name);
  const declared = rail.SECTION_ORDER.filter((name) => names.includes(name));
  assert.deepEqual(names.slice(0, declared.length), declared);
  const apps = rail.railSections(PANES).find((sec) => sec.name === "Apps");
  assert.deepEqual(apps.rows.map((row) => row.id), rail.APP_ROWS.map((row) => row.command));
  assert.ok(apps.rows.every((row) => row.kind === "command"));
});

test("the active pane is marked, and only it", () => {
  const rows = rail.railSections(PANES, { activePane: "settings" }).flatMap((sec) => sec.rows);
  assert.deepEqual(rows.filter((row) => row.active).map((row) => row.id), ["settings"]);
});

test("the rail runs only its allowlisted commands, and each exists in the registry", () => {
  for (const id of rail.RAIL_COMMANDS) {
    assert.ok(rail.railMayRun(id));
    assert.ok(registry.byId(id), `${id} is not a registry command`);
  }
  for (const layer of rail.LAYERS) {
    if (layer.command) assert.ok(rail.railMayRun(layer.command), `layer ${layer.key} runs a command the rail refuses`);
    if (layer.page) assert.ok(PANES.some((pane) => pane.id === layer.page), `layer ${layer.key} opens a missing page`);
  }
  assert.equal(rail.railMayRun("quit"), false);
  assert.equal(rail.railMayRun("fleet.gaming"), false);
  assert.equal(rail.railMayRun(""), false);
});

test("the layers are the owner's stack, innermost first", () => {
  assert.deepEqual(rail.LAYERS.map((layer) => layer.key), ["shell", "avatar", "browser", "online"]);
  const rows = rail.layerRows({ docked: true, overlayVisible: false });
  assert.equal(rows.find((r) => r.key === "avatar").state, "docked");
  assert.equal(rows.find((r) => r.key === "online").on, false);
});

test("layout: rail | gutter | page | gutter | panel, never overlapping", () => {
  const G = rail.GUTTER;
  const r = rail.railLayout({ width: 1320, height: 880 }, { chromeHeight: 118, panelWidth: 340 });
  assert.deepEqual(r.rail, { x: 0, y: 0, width: 248, height: 880 });
  assert.equal(r.page.x, 248 + G);
  assert.equal(r.page.x + r.page.width + G, r.panel.x);
  assert.equal(r.panel.x + r.panel.width, 1320);
  assert.equal(r.page.y, 118);
  const c = rail.railLayout({ width: 1320, height: 880 }, { collapsed: true, chromeHeight: 118, panelWidth: 340 });
  assert.equal(c.page.x, rail.RAIL_COLLAPSED_WIDTH + G);
});

test("dragged widths are honoured and clamped; a collapsed panel gives the page its room", () => {
  const r = rail.railLayout({ width: 1600, height: 900 }, { chromeHeight: 118, railWidth: 320, panelWidth: 500 });
  assert.equal(r.rail.width, 320);
  assert.equal(r.panel.width, 500);
  const tiny = rail.railLayout({ width: 1600, height: 900 }, { chromeHeight: 118, railWidth: 5, panelWidth: 99999 });
  assert.equal(tiny.rail.width, rail.RAIL_MIN);
  assert.equal(tiny.panel.width, rail.PANEL_MAX);
  const off = rail.railLayout({ width: 1600, height: 900 }, { chromeHeight: 118, panelCollapsed: true });
  assert.equal(off.panel.width, 0);
  assert.equal(off.page.x + off.page.width, 1600);
});

test("the taskbar takes the bottom strip, full width; the rail and pages end above it", () => {
  const r = rail.railLayout({ width: 1320, height: 880 }, { chromeHeight: 118, taskbarHeight: rail.TASKBAR_HEIGHT });
  assert.deepEqual(r.taskbar, { x: 0, y: 880 - rail.TASKBAR_HEIGHT, width: 1320, height: rail.TASKBAR_HEIGHT });
  assert.equal(r.page.y + r.page.height, r.taskbar.y);
  assert.equal(r.rail.height, r.taskbar.y);
});

test("a hand-edited layout file cannot wedge the window", () => {
  assert.deepEqual(rail.normalizeLayout({ railWidth: "abc", panelWidth: -4, collapsedSections: [1, "Apps", "Apps"] }),
    { railWidth: rail.RAIL_WIDTH, panelWidth: rail.PANEL_MIN, railCollapsed: false, panelCollapsed: false,
      taskbar: true, collapsedSections: ["Apps"] });
  assert.equal(rail.normalizeLayout({ railWidth: null }).railWidth, rail.RAIL_WIDTH, "reset means default, not minimum");
  assert.equal(rail.normalizeLayout({ taskbar: false }).taskbar, false);
});

test("the avatar slot follows a dragged rail width", () => {
  const slot = rail.avatarSlot({ height: 1000 }, { docked: true, railWidth: 340 });
  assert.equal(slot.width, 340);
  assert.ok(slot.height > rail.AVATAR_SLOT_HEIGHT, "a wider rail is a bigger body");
});

test("the avatar slot exists only docked, expanded and tall enough", () => {
  assert.equal(rail.avatarSlot({ height: 880 }, { docked: false }), null);
  assert.equal(rail.avatarSlot({ height: 880 }, { docked: true, collapsed: true }), null);
  assert.deepEqual(rail.avatarSlot({ height: 880 }, { docked: true }),
    { x: 0, y: rail.BRAND_HEIGHT, width: rail.RAIL_WIDTH, height: rail.AVATAR_SLOT_HEIGHT });
  const short = rail.avatarSlot({ height: 480 }, { docked: true });
  assert.ok(short && short.height < rail.AVATAR_SLOT_HEIGHT && short.height >= 160);
  assert.equal(rail.avatarSlot({ height: 300 }, { docked: true }), null);
});

test("the slot rect is in screen space: the content origin plus the slot offset", () => {
  const rect = rail.avatarSlotRect({ x: 100, y: 50, width: 1320, height: 880 }, { docked: true });
  assert.deepEqual(rect, { x: 100, y: 50 + rail.BRAND_HEIGHT, width: rail.RAIL_WIDTH, height: rail.AVATAR_SLOT_HEIGHT });
  assert.equal(rail.avatarSlotRect(null, { docked: true }), null);
});

test("the chrome page's rail matches the module's sizes", () => {
  assert.match(chromeHtml, new RegExp(`--rail-w: ${rail.RAIL_WIDTH}px`));
  assert.match(chromeHtml, new RegExp(`\\.brand \\{ height: ${rail.BRAND_HEIGHT}px`));
  assert.match(chromeHtml, new RegExp(`#layers \\{[^}]*height: ${rail.LAYERS_HEIGHT}px`));
  for (const action of ["drag", "rail-width", "panel-width", "panel", "taskbar", "section", "reset-layout"]) {
    assert.ok(chromeHtml.includes(`"${action}"`), `the chrome never sends ${action}`);
  }
  // Labels are text, never markup: a pane label cannot inject into the chrome.
  assert.doesNotMatch(chromeHtml, /l\.innerHTML|name\.innerHTML|st\.innerHTML/);
});
