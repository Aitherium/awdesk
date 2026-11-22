"use strict";

// The Aither menu is a RADIAL fan (owner 2026-11-20: today it is a long vertical
// stack). These tests pin the pure layout: every action survives paging, a ring
// shows at most five actions + More, the four Display modes are the inner ring with
// the tick on the active one, every button is inside the window, and at a screen
// edge the fan opens inward instead of hanging off the work area.

const test = require("node:test");
const assert = require("node:assert/strict");
const radial = require("./orb-radial-menu.cjs");
const dm = require("./display-mode.cjs");

const AREA = { x: 0, y: 0, width: 1920, height: 1080 };

/** The real orb menu rows, without a window: the inner display ring + many actions. */
function menuItems() {
  return [
    { id: "inbox", label: "Open inbox", hint: "The Inbox" },
    { id: "queue", label: "Answer window" },
    { id: "show-all", label: "Show all companions" },
    { id: "open-desktop", label: "Open AitherOS desktop" },
    { id: "open-spaces", label: "Open Spaces" },
    { id: "open-chat", label: "Chat with Aither" },
    { id: "settings", label: "Settings" },
    { id: "quiet-1h", label: "Quiet for 1 hour" },
    { id: "quit", label: "Quit Aither" },
    { sep: true },
    ...dm.modeItems({ mode: "both" }),
    { id: "more", label: "More…" },
  ];
}

function insideWindow(node, model) {
  const halfW = node.width / 2;
  const halfH = node.height / 2;
  return node.x - halfW >= -0.5 && node.y - halfH >= -0.5
    && node.x + halfW <= model.window.width + 0.5 && node.y + halfH <= model.window.height + 0.5;
}

test("every action survives: at most five + More per ring, and the pages union to the whole list", () => {
  const items = menuItems();
  const seen = new Set();
  const pages = radial.plan(items, { page: 0 }).pages;
  for (let page = 0; page < pages; page += 1) {
    const p = radial.plan(items, { page });
    assert.ok(p.outer.length <= radial.PER_RING, "never more than five actions on a ring");
    for (const item of p.outer) seen.add(item.id);
  }
  const actions = items.filter((i) => i && !i.sep && !/^dm:/.test(i.id)).map((i) => i.id);
  for (const id of actions) assert.ok(seen.has(id), `${id} is reachable`);
  assert.equal(seen.size, actions.length, "and nothing appears that is not an action");
});

test("the four Display modes own the inner ring, tick on the one in force", () => {
  const p = radial.plan(menuItems(), { page: 0 });
  assert.deepEqual(p.inner.map((i) => i.id), ["dm:avatar", "dm:fairy", "dm:both", "dm:swarm"]);
  assert.equal(p.inner.filter((i) => i.checked).length, 1);
  assert.equal(p.inner.find((i) => i.checked).id, "dm:both");
  assert.ok(!p.outer.some((i) => /^dm:/.test(i.id)), "the modes are not repeated outside");
});

test("the model places every button inside the window, numbers keys 1..N, hub at the centre", () => {
  const model = radial.radialModel(menuItems(), { at: { x: 900, y: 500 }, area: AREA, page: 0 });
  assert.equal(model.layout, "radial");
  assert.deepEqual(model.hub, {
    x: model.window.width / 2, y: model.window.height / 2,
    width: radial.RING.hub, height: radial.RING.hub, label: "Aither",
  });
  for (const node of model.nodes) assert.ok(insideWindow(node, model), `${node.id} is inside the window`);
  // Window-local coordinates around the centre: the inner ring is closer than the outer.
  const inner = model.nodes.filter((n) => n.ring === "inner");
  const outer = model.nodes.filter((n) => n.ring === "outer");
  for (const node of inner) {
    assert.ok(Math.hypot(node.x - model.hub.x, node.y - model.hub.y) < radial.RING.outerRadius);
  }
  for (const node of outer) {
    assert.ok(Math.hypot(node.x - model.hub.x, node.y - model.hub.y) >= radial.RING.outerRadius - 1);
  }
  assert.deepEqual(model.nodes.filter((n) => n.ring === "inner").map((n) => n.key), ["1", "2", "3", "4"]);
  assert.deepEqual(model.nodes.filter((n) => n.ring === "outer").map((n) => n.key), ["5", "6", "7", "8", "9", "10"]);
  assert.equal(model.window.width, radial.RING.size);
  assert.equal(model.window.height, radial.RING.size);
});

test("the window is centred on the click and clamped onto the work area", () => {
  const mid = radial.radialModel(menuItems(), { at: { x: 900, y: 500 }, area: AREA });
  assert.equal(mid.window.x, Math.round(900 - radial.RING.size / 2));
  assert.equal(mid.window.y, Math.round(500 - radial.RING.size / 2));
  const edge = radial.radialModel(menuItems(), { at: { x: 4, y: 4 }, area: AREA });
  assert.ok(edge.window.x >= 8 && edge.window.y >= 8, "never off the work area");
});

test("at a screen edge the fan flips INWARD: a left-edge click uses only the right half", () => {
  const model = radial.radialModel(menuItems(), { at: { x: 4, y: 500 }, area: AREA });
  assert.ok(model.window.center === undefined, "the model carries window bounds");
  const centre = { x: model.window.x + model.window.width / 2 };
  const outer = model.nodes.filter((n) => n.ring === "outer");
  for (const node of outer) {
    assert.ok(model.window.x + node.x > centre.x, `${node.id} opens to the right of the ring centre`);
  }
  assert.deepEqual(model.fan, { start: -90, span: 180 }, "the right half of the ring");
  // A top-left corner: one quarter, opening down-right.
  const corner = radial.radialModel(menuItems(), { at: { x: 2, y: 2 }, area: AREA });
  assert.deepEqual(corner.fan, { start: 0, span: 90 });
  // Mid-screen: the full ring.
  assert.deepEqual(radial.radialModel(menuItems(), { at: { x: 900, y: 500 }, area: AREA }).fan, { start: -90, span: 360 });
});

test("the next page is a keyed More button, and a page id parses back", () => {
  const model = radial.radialModel(menuItems(), { at: { x: 900, y: 500 }, area: AREA, page: 0 });
  const more = model.nodes.find((n) => n.more);
  assert.ok(more, "a second page exists");
  assert.equal(more.id, "radial:page:1");
  assert.equal(radial.pageFromId(more.id), 1);
  assert.equal(radial.pageFromId("dm:avatar"), null);
  assert.equal(radial.pageFromId(""), null);
  const last = radial.plan(menuItems(), { page: 1 });
  assert.equal(last.page, 1);
  assert.equal(last.more.page, 0, "More wraps, so no page is a dead end");
  // A page past the end is clamped, never blank.
  assert.equal(radial.plan(menuItems(), { page: 99 }).page, last.pages - 1);
});

test("the module does not fork the item list: node ids are the rows it was given", () => {
  const items = menuItems();
  const model = radial.radialModel(items, { at: { x: 900, y: 500 }, area: AREA });
  const ids = model.nodes.map((n) => n.id);
  for (const id of ids) {
    assert.ok(items.some((i) => i && !i.sep && i.id === id) || /^radial:page:/.test(id), `${id} came from the rows`);
  }
  const inbox = model.nodes.find((n) => n.id === "inbox");
  assert.equal(inbox.label, "Open inbox");
  assert.equal(inbox.hint, "The Inbox", "hints travel with the row");
});
