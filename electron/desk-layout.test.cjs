"use strict";

// desk-layout.cjs: the browser's layout as ONE versioned document, stored as one key of
// the existing browser-layout.json. Every arm here can fail on a real regression.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const rail = require("./browser-rail.cjs");
const L = require("./desk-layout.cjs");

const prefs = (extra = {}) => rail.normalizeLayout(extra);

test("one store: the desk document is a key of browser-layout.json, not a second file", () => {
  const p = prefs();
  assert.ok(p.desk, "normalizeLayout keeps `desk` (a key it forgets is lost on the next read)");
  assert.equal(p.desk.v, L.SCHEMA_VERSION);
  // Round trip through the same sanitizer getPrefs() runs on every read.
  const again = rail.normalizeLayout(JSON.parse(JSON.stringify(p)));
  assert.deepEqual(again.desk, p.desk);
  // browser-window persists to browser-layout.json only; no new file name appears.
  const src = fs.readFileSync(path.join(__dirname, "browser-window.cjs"), "utf8");
  assert.ok(src.includes('"browser-layout.json"'));
  assert.ok(!/desk-layout\.json|canvas\.json|boards\.json/.test(src), "a second layout store appeared");
  assert.equal("boards" in p.desk, false, "boards are boards-core's files, not a layout key");
});

test("the model: every pane has side, visible and order; sizes come from the legacy keys (migration)", () => {
  // A file written BEFORE this module existed: only the legacy keys.
  const old = { railWidth: 300, panelWidth: 500, panelCollapsed: true, dock: true, dockOpen: true, dockHeight: 400,
    taskbar: false, collapsedSections: ["Know"] };
  const m = L.toModel(old);
  assert.deepEqual(Object.keys(m.panes), L.PANE_IDS);
  for (const id of L.PANE_IDS) {
    assert.ok(L.SIDES[id].includes(m.panes[id].side), `${id} side`);
    assert.equal(typeof m.panes[id].visible, "boolean", `${id} visible`);
    assert.ok(Number.isInteger(m.panes[id].order), `${id} order`);
  }
  assert.equal(m.panes.rail.size, 300);
  assert.equal(m.panes.panel.size, 500);
  assert.equal(m.panes.panel.visible, false, "panelCollapsed migrates to panel.visible=false");
  assert.equal(m.panes.dock.size, 400);
  assert.equal(m.panes.dock.open, true);
  assert.equal(m.panes.taskbar.visible, false);
  assert.deepEqual(m.rail.collapsedSections, ["Know"]);
  assert.equal(m.panes.rail.side, "left", "an old file lands on today's sides");
  assert.equal(m.panes.panel.side, "right");
});

test("fromModel writes sizes back to the legacy keys and sides to desk; sizes are clamped", () => {
  const patch = L.fromModel({ panes: { rail: { side: "right", size: 9999 }, panel: { size: 1, visible: false },
    dock: { side: "top", size: 333, open: true } } }, prefs());
  assert.equal(patch.desk.panes.rail.side, "right");
  assert.equal(patch.desk.panes.dock.side, "top");
  const p = rail.normalizeLayout({ ...prefs(), ...patch });
  assert.equal(p.railWidth, rail.RAIL_MAX, "an absurd width is clamped, not refused");
  assert.equal(p.panelWidth, rail.PANEL_MIN);
  assert.equal(p.panelCollapsed, true);
  assert.equal(p.dockHeight, 333);
  assert.equal(p.dockOpen, true);
});

test("validateModel rejects unknown keys and wrong sides instead of dropping them", () => {
  assert.equal(L.validateModel({ panes: {} }).ok, true);
  const bad = L.validateModel({ panes: { rail: { side: "top", colour: "red" }, wings: {} }, extra: 1 });
  assert.equal(bad.ok, false);
  const text = bad.errors.join(" | ");
  assert.match(text, /unknown key: extra/);
  assert.match(text, /unknown pane: wings/);
  assert.match(text, /unknown key: panes\.rail\.colour/);
  assert.match(text, /panes\.rail\.side must be one of left\/right/);
  assert.equal(L.validateModel({ v: 2, panes: {} }).ok, false, "a newer version says so");
  assert.equal(L.validateModel({ layerOrder: ["shell", "nope"] }, { partial: true }).ok, false);
});

test("presets: three built-ins; Focus collapses the rail and hides the panel; Ops is tall dock + wide panel", () => {
  assert.deepEqual(L.presetList({}).map((p) => p.name), ["Default", "Focus", "Ops"]);
  const wild = prefs({ railWidth: 333 });
  const focus = L.applyPreset(wild, "Focus");
  assert.equal(focus.ok, true);
  const f = rail.normalizeLayout({ ...wild, ...focus.patch });
  assert.equal(f.railCollapsed, true);
  assert.equal(f.panelCollapsed, true);
  assert.equal(f.railWidth, rail.RAIL_WIDTH, "a built-in starts from Default, not from whatever was there");
  assert.equal(f.desk.activePreset, "Focus");
  const ops = rail.normalizeLayout({ ...prefs(), ...L.applyPreset(prefs(), "Ops").patch });
  assert.equal(ops.dockOpen, true);
  assert.ok(ops.dockHeight >= 500, "Ops: the dock is tall");
  assert.ok(ops.panelWidth >= 500, "Ops: the panel is wide");
  assert.equal(ops.panelCollapsed, false);
  assert.equal(L.applyPreset(prefs(), "Nope").ok, false);
});

test("a built-in preset keeps the owner's rail arrangement (pins are content, not geometry)", () => {
  let p = prefs({ desk: { rail: { pinned: ["page:files"], hidden: ["page:chat"] } } });
  p = rail.normalizeLayout({ ...p, ...L.applyPreset(p, "Focus").patch });
  assert.deepEqual(p.desk.rail.pinned, ["page:files"]);
  assert.deepEqual(p.desk.rail.hidden, ["page:chat"]);
});

test("save / load / rename / delete an owner preset; built-ins are protected", () => {
  let p = prefs({ railWidth: 300, desk: { panes: { panel: { side: "left" } } } });
  const saved = L.savePreset(p, "Coding");
  assert.equal(saved.ok, true);
  p = rail.normalizeLayout({ ...p, ...saved.patch });
  assert.deepEqual(L.presetList(p.desk).map((x) => x.name), ["Default", "Focus", "Ops", "Coding"]);
  // Wander off, then load it back.
  p = rail.normalizeLayout({ ...p, ...L.applyPreset(p, "Default").patch });
  assert.equal(p.railWidth, rail.RAIL_WIDTH);
  assert.equal(p.desk.panes.panel.side, "right");
  p = rail.normalizeLayout({ ...p, ...L.applyPreset(p, "Coding").patch });
  assert.equal(p.railWidth, 300);
  assert.equal(p.desk.panes.panel.side, "left");
  const renamed = L.renamePreset(p, "Coding", "Deep work");
  p = rail.normalizeLayout({ ...p, ...renamed.patch });
  assert.equal(p.desk.activePreset, "Deep work");
  assert.equal(L.renamePreset(p, "Focus", "Mine").ok, false, "a built-in cannot be renamed");
  assert.equal(L.savePreset(p, "Ops").ok, false, "a built-in cannot be overwritten");
  assert.equal(L.deletePreset(p, "Default").ok, false);
  p = rail.normalizeLayout({ ...p, ...L.deletePreset(p, "Deep work").patch });
  assert.deepEqual(L.presetList(p.desk).map((x) => x.name), ["Default", "Focus", "Ops"]);
  assert.equal(p.desk.activePreset, null);
});

test("setPaneSide accepts only a side the pane can take", () => {
  assert.equal(L.setPaneSide(prefs(), "panel", "left").ok, true);
  assert.equal(L.setPaneSide(prefs(), "dock", "top").ok, true);
  assert.match(L.setPaneSide(prefs(), "dock", "left").error, /bottom or top/);
  assert.equal(L.setPaneSide(prefs(), "taskbar", "top").ok, false);
  assert.equal(L.setPaneSide(prefs(), "wings", "left").ok, false);
  assert.deepEqual(L.parsePaneSide("Panel:LEFT"), { pane: "panel", side: "left" });
  assert.equal(L.parsePaneSide("panel left"), null);
});

const SECTIONS = [
  { id: "today", name: "Today", rows: [{ kind: "page", id: "cards", label: "Inbox" }, { kind: "page", id: "space", label: "Space" }] },
  { id: "work", name: "Work", rows: [{ kind: "page", id: "files", label: "Files" }, { kind: "page", id: "projects", label: "Projects" },
    { kind: "workspace", id: "/workspace/mail", label: "Mail" }] },
  { id: "know", name: "Know", rows: [{ kind: "page", id: "search", label: "Search" }] },
];
const names = (secs) => secs.map((s) => s.name);
const ids = (sec) => sec.rows.map((r) => r.id);

test("arrangeRail: pins first, moved and reordered rows, removed rows gone, section order", () => {
  const arranged = L.arrangeRail(SECTIONS, {
    sectionOrder: ["Know", "Today"], pinned: ["page:files"], hidden: ["page:space"],
    moved: { "page:search": "Work" }, rowOrder: { Work: ["page:projects", "page:search"] },
  });
  assert.deepEqual(names(arranged), ["Pinned", "Today", "Work"], "Know emptied (its row moved) so it is not drawn");
  assert.deepEqual(ids(arranged[0]), ["files"]);
  assert.deepEqual(ids(arranged[1]), ["cards"], "a removed row is gone");
  assert.deepEqual(ids(arranged[2]), ["projects", "search", "files", "/workspace/mail"]);
  assert.equal(arranged[2].rows.find((r) => r.id === "files").pinned, true, "a pin is a shortcut: the row stays home too");
  // A key that names no row today is skipped, never an empty slot.
  assert.deepEqual(names(L.arrangeRail(SECTIONS, { pinned: ["page:gone"] })), ["Today", "Work", "Know"]);
  // No arrangement = the generated rail, untouched.
  assert.deepEqual(L.arrangeRail(SECTIONS, {}).map(ids), SECTIONS.map(ids));
});

test("editRail: drag a row within and between sections, nudge it, pin/unpin, hide/restore, move a section", () => {
  let c = {};
  const apply = (op) => {
    const r = L.editRail(c, op, L.arrangeRail(SECTIONS, c));
    assert.equal(r.ok, true, `${op.op}: ${r.error}`);
    c = r.custom;
    return L.arrangeRail(SECTIONS, c);
  };
  let a = apply({ op: "move-row", key: "page:files", section: "Today", index: 1 });
  assert.deepEqual(ids(a.find((s) => s.name === "Today")), ["cards", "files", "space"]);
  assert.ok(!ids(a.find((s) => s.name === "Work")).includes("files"), "it left its old section");
  a = apply({ op: "nudge-row", key: "page:files", by: -1 });
  assert.deepEqual(ids(a.find((s) => s.name === "Today")), ["files", "cards", "space"]);
  a = apply({ op: "pin", key: "page:search" });
  assert.equal(a[0].name, "Pinned");
  a = apply({ op: "move-row", key: "page:cards", section: "Pinned", index: 0 });
  assert.deepEqual(ids(a[0]), ["cards", "search"], "dropping on Pinned pins, at that place");
  a = apply({ op: "unpin", key: "page:search" });
  assert.deepEqual(ids(a[0]), ["cards"]);
  a = apply({ op: "hide", key: "page:projects" });
  assert.ok(!a.flatMap(ids).includes("projects"));
  a = apply({ op: "restore" });
  assert.ok(a.flatMap(ids).includes("projects"));
  a = apply({ op: "move-section", name: "Know", index: 0 });
  assert.deepEqual(names(a).filter((n) => n !== "Pinned"), ["Know", "Today", "Work"]);
  a = apply({ op: "nudge-section", name: "Work", by: -1 });
  assert.deepEqual(names(a).filter((n) => n !== "Pinned"), ["Know", "Work", "Today"]);
  assert.equal(L.editRail(c, { op: "move-row", key: "page:nope", section: "Work" }, a).ok, false);
  assert.equal(L.editRail(c, { op: "move-row", key: "page:files", section: "Nowhere" }, a).ok, false);
  assert.equal(L.editRail(c, { op: "explode" }, a).ok, false);
});

test("layer tiles reorder by index or by one step; unknown keys refused", () => {
  assert.deepEqual(L.moveLayer(undefined, "online", { index: 0 }).order, ["online", "shell", "avatar", "browser"]);
  assert.deepEqual(L.moveLayer(["shell", "avatar", "browser", "online"], "shell", { by: 1 }).order,
    ["avatar", "shell", "browser", "online"]);
  assert.equal(L.moveLayer(undefined, "ghost", { by: 1 }).ok, false);
  const rows = rail.layerRows({});
  assert.deepEqual(L.orderLayers(rows, ["online", "browser", "avatar", "shell"]).map((r) => r.key),
    ["online", "browser", "avatar", "shell"]);
});

test("detached windows: bounds remembered per pane; an unplugged monitor falls back", () => {
  let desk = L.withDetached({}, "panel", { bounds: { x: 2000, y: 100, width: 400, height: 700 }, open: true });
  assert.deepEqual(desk.detached.panel, { bounds: { x: 2000, y: 100, width: 400, height: 700 }, open: true });
  desk = L.withDetached(desk, "panel", { open: false });
  assert.equal(desk.detached.panel.open, false);
  assert.ok(desk.detached.panel.bounds, "closing keeps where it was");
  assert.deepEqual(L.withDetached({}, "rail", { open: true }).detached, {}, "the rail is not detachable");
  const fallback = { x: 1, y: 2, width: 3, height: 4 };
  const one = [{ x: 0, y: 0, width: 1920, height: 1040 }];
  const two = [...one, { x: 1920, y: 0, width: 2560, height: 1400 }];
  assert.deepEqual(L.fitBounds(desk.detached.panel.bounds, two, fallback), desk.detached.panel.bounds);
  assert.deepEqual(L.fitBounds(desk.detached.panel.bounds, one, fallback), fallback, "the second screen is gone");
  assert.deepEqual(L.fitBounds(null, one, fallback), fallback);
});

test("export -> import round-trips the layout and the presets", () => {
  let p = prefs({ railWidth: 280, desk: { panes: { dock: { side: "top" } }, rail: { pinned: ["page:files"] } } });
  p = rail.normalizeLayout({ ...p, ...L.savePreset(p, "Mine").patch });
  const doc = L.exportDoc(p, { now: new Date("2026-11-07T00:00:00Z") });
  assert.equal(doc.kind, L.DOC_KIND);
  assert.equal(doc.exportedAt, "2026-11-07T00:00:00.000Z");
  const fresh = prefs();
  const imported = L.importDoc(fresh, JSON.stringify(doc));
  assert.equal(imported.ok, true, JSON.stringify(imported.errors));
  const q = rail.normalizeLayout({ ...fresh, ...imported.patch });
  assert.equal(q.railWidth, 280);
  assert.equal(q.desk.panes.dock.side, "top");
  assert.deepEqual(q.desk.rail.pinned, ["page:files"]);
  assert.deepEqual(q.desk.presets.map((x) => x.name), ["Mine"]);
  assert.equal("boards" in doc, false, "boards live in their own files, not in the layout file");
});

test("import is strict: junk, a wrong kind or an unknown key changes NOTHING and says why", () => {
  assert.deepEqual(L.importDoc(prefs(), "{not json").errors, ["not JSON"]);
  const doc = L.exportDoc(prefs());
  const wrongKind = L.importDoc(prefs(), { ...doc, kind: "something-else" });
  assert.equal(wrongKind.ok, false);
  const extra = L.importDoc(prefs(), { ...doc, surprise: true });
  assert.match(extra.errors.join(" "), /unknown key: surprise/);
  const deep = JSON.parse(JSON.stringify(doc));
  deep.layout.panes.panel.wings = 2;
  assert.match(L.importDoc(prefs(), deep).errors.join(" "), /panes\.panel\.wings/);
  assert.match(L.importDoc(prefs(), { ...doc, boards: {} }).errors.join(" "), /unknown key: boards/);
});

test("a hand-edited desk key cannot wedge the window", () => {
  const d = L.normalizeDesk({ panes: { rail: { side: "up" }, layers: { visible: "no", order: 9 } },
    rail: { pinned: ["not a key", "page:files", "page:files"], moved: { "page:x": "Pinned" } },
    layerOrder: ["online", "online", 7], presets: [{ name: "Focus", layout: {} }, { name: "x".repeat(99), layout: {} }],
    activePreset: "Ghost", detached: { panel: { bounds: { x: "a" }, open: true }, rail: { open: true } } });
  assert.equal(d.panes.rail.side, "left");
  assert.equal(d.panes.layers.visible, true, "visible unless exactly false");
  assert.equal(d.panes.layers.order, 1);
  assert.deepEqual(d.rail.pinned, ["page:files"]);
  assert.deepEqual(d.rail.moved, {}, "a row cannot be MOVED into Pinned (pinning is its own list)");
  assert.deepEqual(d.layerOrder, ["online", "shell", "avatar", "browser"]);
  assert.deepEqual(d.presets.map((p) => p.name), ["x".repeat(40)], "a built-in name is not an owner preset");
  assert.equal(d.activePreset, null);
  assert.deepEqual(d.detached, { panel: { bounds: null, open: true } });
  assert.equal(L.normalizeDesk({ canvasBoard: "../etc" }).canvasBoard, null, "the canvas pointer is an id, never a path");
  assert.equal(L.normalizeDesk({ canvasBoard: "board-20261107-1200-ab12" }).canvasBoard, "board-20261107-1200-ab12");
});
