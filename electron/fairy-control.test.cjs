"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const fc = require("./fairy-control.cjs");
const agentFairy = require("./agent-fairy.cjs");

const lyra = { agent: "lyra", label: "Lyra", kind: "fleet", state: "waiting", count: 3, title: "Pick a model", bot: true };
const term = { agent: "session-ab12cd34", label: "awdesk terminal", kind: "session", state: "working", count: 0, title: "working" };
const sub = { agent: "sub-1", label: "reviewer", kind: "subagent", state: "idle", count: 0, title: "idle" };
const remote = { agent: "gpu-box", label: "gpu-box", kind: "remote", state: "idle", count: 0, title: "idle" };

test("the tooltip names the fairy, its kind, its status and what the badge means", () => {
  const lines = fc.detailLines(lyra);
  assert.equal(lines[0], "Lyra");
  assert.equal(lines[1], "Fleet agent");
  assert.match(lines[2], /^Waiting on you · Pick a model/);
  assert.equal(lines[3], "Badge 3 = 3 cards waiting on you");
  assert.match(lines[4], /right-click/);
  assert.equal(fc.detailLines(term)[1], "Claude terminal session");
  assert.equal(fc.detailLines(term)[2], "Working", "a bare state word is not repeated as a title");
  assert.equal(fc.detailLines(term).length, 4, "no badge line when it carries no number");
  assert.match(fc.detailLines({ ...lyra, count: 1 })[3], /1 card waiting on you$/);
  assert.match(fc.detailText(lyra, { muted: true }), /Waiting on you · Pick a model \(muted\)/);
  assert.match(fc.detailText(lyra, { pinned: true }), /rejoin/);
  assert.ok(fc.detailLines({ agent: "x", label: "y".repeat(200) })[0].length <= 40);
});

test("kinds sort into the filter groups", () => {
  assert.equal(fc.kindGroup(lyra), "agents");
  assert.equal(fc.kindGroup(term), "terminals");
  assert.equal(fc.kindGroup({ agent: "session-1" }), "terminals", "a session key is a terminal even with no kind");
  assert.equal(fc.kindGroup(sub), "subagents");
  assert.equal(fc.kindGroup(remote), "remote");
  assert.equal(fc.kindLabel({ agent: "x", bot: true }), "Discord bot agent");
  assert.equal(fc.kindLabel({ agent: "x" }), "Agent");
});

test("the view survives junk and is clamped", () => {
  const v = fc.normalizeView({ mode: "wobble", radius: 99, kind: "nope", hidden: ["A", "a", 5], pins: { Lyra: { x: "10.4", y: 20 }, bad: { x: "q" } } });
  assert.equal(v.mode, "gather");
  assert.equal(v.radius, fc.RADIUS_MAX);
  assert.equal(v.kind, "all");
  assert.deepEqual(v.hidden, ["a", "5"]);
  assert.deepEqual(v.pins, { lyra: { x: 10, y: 20 } });
  assert.equal(fc.normalizeView(null).radius, 1);
  assert.equal(fc.normalizeView({ radius: 0.01 }).radius, fc.RADIUS_MIN);
});

test("scroll changes the radius, a notch at a time, inside its bounds", () => {
  assert.equal(fc.stepRadius(1, -120), 1.1);
  assert.equal(fc.stepRadius(1, 120), 0.9);
  assert.equal(fc.stepRadius(fc.RADIUS_MAX, -120), fc.RADIUS_MAX);
  assert.equal(fc.stepRadius(fc.RADIUS_MIN, 120), fc.RADIUS_MIN);
  assert.equal(fc.stepRadius(1, 0), 1);
  const wide = fc.swarmExtent("gather", 8, 2);
  const tight = fc.swarmExtent("gather", 8, 0.8);
  assert.ok(wide > fc.swarmExtent("gather", 8, 1) && fc.swarmExtent("gather", 8, 1) > tight, "the window grows with the radius");
});

test("the first ring stays outside the 30 px disc at the tightest radius", () => {
  const slots = fc.swarmSlots("gather", 6, fc.RADIUS_MIN);
  for (const s of slots) assert.ok(s.radius * s.squash > 28, `ring 0 radius ${s.radius}`);
});

test("applyView splits the ring from the pinned, hidden and filtered-out", () => {
  const all = [lyra, term, sub, remote];
  const base = fc.applyView(all, null);
  assert.deepEqual(base.visible.map((c) => c.agent), ["lyra", "session-ab12cd34", "sub-1", "gpu-box"]);
  const one = fc.applyView(all, { hidden: ["sub-1"], pins: { "gpu-box": { x: 5, y: 6 } } });
  assert.deepEqual(one.visible.map((c) => c.agent), ["lyra", "session-ab12cd34"]);
  assert.deepEqual(one.pinned.map((c) => c.agent), ["gpu-box"]);
  assert.equal(one.hidden, 1);
  assert.equal(one.total, 4);
  const onlyTerm = fc.applyView(all, { kind: "terminals" });
  assert.deepEqual(onlyTerm.visible.map((c) => c.agent), ["session-ab12cd34"]);
  const pinnedWins = fc.applyView(all, { kind: "terminals", pins: { lyra: { x: 1, y: 1 } } });
  assert.deepEqual(pinnedWins.pinned.map((c) => c.agent), ["lyra"], "a pinned fairy ignores the kind filter");
});

test("decorate adds the tooltip text and the marks the page draws", () => {
  const d = fc.decorate(lyra, { muted: ["lyra"], pins: {} }, { selected: "lyra" });
  assert.equal(d.selected, true);
  assert.equal(d.muted, true);
  assert.equal(d.pinned, false);
  assert.equal(d.group, "agents");
  assert.match(d.detail, /^Lyra\nFleet agent\n/);
});

test("dock picks the nearest edge and lays a strip along it", () => {
  const area = { x: 0, y: 0, width: 1920, height: 1040 };
  assert.equal(fc.dockEdge({ x: 30, y: 500 }, area), "left");
  assert.equal(fc.dockEdge({ x: 1900, y: 500 }, area), "right");
  assert.equal(fc.dockEdge({ x: 900, y: 10 }, area), "top");
  assert.equal(fc.dockEdge({ x: 900, y: 1030 }, area), "bottom");
  const b = fc.boundsFor({ mode: "dock" }, 5, { x: 40, y: 520 }, area);
  assert.equal(b.edge, "left");
  assert.equal(b.width, fc.DOCK_THICK);
  assert.ok(b.height >= 5 * fc.DOCK_STEP);
  assert.ok(b.x >= 0 && b.y >= 0 && b.y + b.height <= 1040, "inside the work area");
  const top = fc.boundsFor({ mode: "dock" }, 3, { x: 2000, y: 3 }, area);
  assert.equal(top.edge, "top");
  assert.ok(top.x + top.width <= 1920, "a strip near the corner is pulled back inside");
  assert.deepEqual(fc.dockOffset(1, 3, "left"), { x: 0, y: 0 });
  assert.deepEqual(fc.dockOffset(0, 3, "top"), { x: -24, y: 0 });
});

test("dock mode sits ON the taskbar when its rect is known (plan A4)", () => {
  const area = { x: 0, y: 0, width: 1920, height: 1040 }; // work area: the taskbar is the 40 px below it
  const taskbar = { x: 0, y: 1040, width: 1920, height: 40 };
  assert.equal(fc.taskbarEdge(taskbar, area), "bottom");
  const onBar = fc.boundsFor({ mode: "dock" }, 5, { x: 900, y: 1030 }, area, taskbar);
  assert.equal(onBar.edge, "bottom");
  assert.equal(onBar.onTaskbar, true);
  assert.ok(onBar.y >= 1040 && onBar.y + onBar.height <= 1080, `the strip is inside the taskbar: ${JSON.stringify(onBar)}`);
  assert.ok(onBar.height <= 40, "never taller than the taskbar");
  assert.ok(onBar.x >= 0 && onBar.x + onBar.width <= 1920);

  // Without the rect the strip stays inside the work area -- the old behaviour.
  const noBar = fc.boundsFor({ mode: "dock" }, 5, { x: 900, y: 1030 }, area, null);
  assert.equal(noBar.onTaskbar, false);
  assert.ok(noBar.y + noBar.height <= 1040, "inside the work area");

  // A taskbar at the TOP is used for a top dock only.
  const topBar = { x: 0, y: 0, width: 1920, height: 40 };
  const topArea = { x: 0, y: 40, width: 1920, height: 1040 };
  assert.equal(fc.taskbarEdge(topBar, topArea), "top");
  const top = fc.boundsFor({ mode: "dock" }, 3, { x: 900, y: 45 }, topArea, topBar);
  assert.equal(top.onTaskbar, true);
  assert.ok(top.y >= 0 && top.y + top.height <= 40);

  // A known taskbar on a DIFFERENT edge is not used for this dock.
  const left = fc.boundsFor({ mode: "dock" }, 3, { x: 2, y: 500 }, area, taskbar);
  assert.equal(left.edge, "left");
  assert.equal(left.onTaskbar, false);

  // Junk is ignored, never thrown.
  assert.equal(fc.taskbarEdge(null, area), "");
  assert.equal(fc.taskbarEdge({ x: "q" }, area), "");
  assert.equal(fc.taskbarEdge({ x: 0, y: 0, width: 0, height: 0 }, area), "");
  assert.equal(fc.dockOnTaskbar("bottom", 3, { x: 900, y: 500 }, null, area), null);
});

test("the taskbar is chosen for the display the cluster is on, not the primary one", () => {
  // Two monitors side by side, each with its 40 px taskbar at the bottom.
  const primaryBounds = { x: 0, y: 0, width: 1920, height: 1080 };
  const secondBounds = { x: 1920, y: 0, width: 1920, height: 1080 };
  const primaryBar = { x: 0, y: 1040, width: 1920, height: 40 };
  const secondBar = { x: 1920, y: 1040, width: 1920, height: 40 };
  assert.equal(fc.taskbarForDisplay([primaryBar, secondBar], primaryBounds), primaryBar);
  assert.equal(fc.taskbarForDisplay([primaryBar, secondBar], secondBounds), secondBar,
    "the second monitor's own bar, never the first monitor's");

  // The STACKED layout is why bounds (not work-area adjacency) decide: the primary's
  // bottom bar sits exactly against the second monitor's work-area TOP, so an edge test
  // picked it for a cluster on the second monitor.
  const lowerBounds = { x: 0, y: 1080, width: 1920, height: 1080 };
  const lowerArea = { x: 0, y: 1080, width: 1920, height: 1040 };
  const lowerBar = { x: 0, y: 2120, width: 1920, height: 40 };
  assert.equal(fc.taskbarForDisplay([primaryBar, lowerBar], lowerBounds), lowerBar);
  assert.equal(fc.taskbarForDisplay([primaryBar, lowerBar], primaryBounds), primaryBar);
  assert.equal(fc.taskbarForDisplay([primaryBar, secondBar], lowerBounds), null, "no bar on that display: fall back");

  // A vertical (left) taskbar is inside its display just the same.
  const leftBar = { x: 0, y: 0, width: 40, height: 1040 };
  assert.equal(fc.taskbarForDisplay([leftBar], primaryBounds), leftBar);

  // Junk is ignored, never thrown; no bars = no choice.
  assert.equal(fc.taskbarForDisplay([], secondBounds), null);
  assert.equal(fc.taskbarForDisplay(null, secondBounds), null);
  assert.equal(fc.taskbarForDisplay([{ x: "q" }], secondBounds), null);

  // End to end: the strip lands on the second monitor's bar, not the first's.
  const strip = fc.boundsFor({ mode: "dock" }, 5, { x: 900, y: 2110 }, lowerArea,
    fc.taskbarForDisplay([primaryBar, lowerBar], lowerBounds));
  assert.equal(strip.onTaskbar, true);
  assert.ok(strip.x >= 0 && strip.x + strip.width <= 1920, `on the second monitor: ${JSON.stringify(strip)}`);
  assert.ok(strip.y >= 2120 && strip.y + strip.height <= 2160);
});

test("collapsed to one orb there is no window; gather and scatter are centred squares", () => {  const area = { x: 0, y: 0, width: 1920, height: 1040 };
  assert.equal(fc.boundsFor({ mode: "orb" }, 4, { x: 500, y: 500 }, area), null);
  assert.equal(fc.boundsFor({ mode: "gather" }, 0, { x: 500, y: 500 }, area), null);
  const g = fc.boundsFor({ mode: "gather" }, 4, { x: 500, y: 500 }, area);
  assert.equal(g.x + g.width / 2, 500);
  assert.equal(g.y + g.height / 2, 500);
  const sc = fc.boundsFor({ mode: "scatter" }, 4, { x: 500, y: 500 }, area);
  assert.ok(sc.width > g.width, "scatter spreads wider than gather");
});

test("scatter keeps every fairy outside the disc and apart from its neighbours", () => {
  const slots = fc.swarmSlots("scatter", 9, 1);
  const pts = slots.map((s) => fc.swarmOffset(s, 0));
  for (const p of pts) assert.ok(Math.hypot(p.x, p.y) > 40);
  for (let i = 0; i < pts.length; i += 1) for (let j = i + 1; j < pts.length; j += 1) {
    assert.ok(Math.hypot(pts[i].x - pts[j].x, pts[i].y - pts[j].y) > 20, `${i} and ${j} overlap`);
  }
});

test("a fairy inside the focused window's content is pushed to the nearest side, outside it", () => {
  const rect = { l: -50, t: -20, r: 150, b: 120 };
  const out = fc.avoidPoint({ x: 140, y: 50 }, rect, 10);
  assert.equal(out.x, 160);
  assert.equal(out.y, 50);
  const up = fc.avoidPoint({ x: 40, y: -15 }, rect, 10);
  assert.equal(up.y, -30);
  assert.deepEqual(fc.avoidPoint({ x: -200, y: 0 }, rect, 10), { x: -200, y: 0 }, "outside: untouched");
  assert.deepEqual(fc.avoidPoint({ x: 0, y: 0 }, null, 10), { x: 0, y: 0 }, "no focused window: untouched");
  // The title bar is not content: the ring may sit over it.
  const content = fc.contentRect({ x: 100, y: 100, width: 800, height: 600 });
  assert.equal(content.y, 100 + fc.TITLE_BAR);
  assert.equal(fc.contentRect({ x: 0, y: 0, width: 20, height: 20 }), null, "a tiny window is not content");
  assert.deepEqual(fc.relativeRect({ x: 110, y: 90, width: 100, height: 50 }, { x: 100, y: 100 }), { l: 10, t: -10, r: 110, b: 40 });
});

test("the foreground probe's line is parsed, and the desktop and shell are nobody's window", () => {
  const ok = fc.parseForeground('{"ok":true,"x":10,"y":20,"w":800,"h":600,"cls":"Chrome_WidgetWin_1","title":"Doc"}');
  assert.deepEqual({ x: ok.x, y: ok.y, width: ok.width, height: ok.height }, { x: 10, y: 20, width: 800, height: 600 });
  assert.equal(fc.parseForeground('{"ok":false}'), null);
  assert.equal(fc.parseForeground("garbage"), null);
  assert.equal(fc.parseForeground('{"ok":true,"x":0,"y":0,"w":1920,"h":1080,"cls":"Progman"}'), null);
  assert.equal(fc.parseForeground('{"ok":true,"x":0,"y":0,"w":0,"h":1080,"cls":"x"}'), null);
  assert.ok(fc.sameRect({ x: 0, y: 0, width: 10, height: 10 }, { x: 2, y: 1, width: 10, height: 11 }));
  assert.ok(!fc.sameRect({ x: 0, y: 0, width: 10, height: 10 }, { x: 9, y: 0, width: 10, height: 10 }));
});

test("dropped near the fairy a pinned fairy rejoins; anywhere else it stays out", () => {
  assert.ok(fc.joinsCluster({ x: 510, y: 505 }, { x: 500, y: 500 }));
  assert.ok(!fc.joinsCluster({ x: 700, y: 500 }, { x: 500, y: 500 }));
});

test("the fairy menu carries chat, grow, mute, pin, hide, open session and the layout door", () => {
  const rows = fc.controlItems({ label: "Lyra", agent: "lyra", hasSession: true });
  assert.deepEqual(rows.map((r) => r.id), ["fc:chat", "fc:grow", "fc:mute", "fc:pin", "fc:hide", "fc:session", "sv:menu"]);
  assert.equal(rows.find((r) => r.id === "fc:session").disabled, undefined);
  const no = fc.controlItems({ label: "Lyra", agent: "lyra", muted: true, pinned: true, hasSession: false, canGrow: false });
  assert.equal(no.find((r) => r.id === "fc:session").disabled, true, "no dead item that pretends to work");
  assert.equal(no.find((r) => r.id === "fc:grow").disabled, true);
  assert.equal(no.find((r) => r.id === "fc:mute").label, "Unmute");
  assert.match(no.find((r) => r.id === "fc:pin").label, /^Unpin/);
});

test("the fairy menu carries its own drop answer (fairy-drop.cjs), the one in force marked", () => {
  const rows = fc.controlItems({ label: "Lyra", agent: "lyra", drop: { mode: "return" } });
  const dropRows = rows.filter((r) => r && String(r.id || "").startsWith("fc:drop:"));
  assert.deepEqual(dropRows.map((r) => r.id), ["fc:drop:pin", "fc:drop:timed:10", "fc:drop:return"]);
  assert.match(dropRows[2].label, /✓/);
});

test("the swarm layout menu marks what is on and picks change the view", () => {
  const v = { mode: "scatter", kind: "terminals", radius: 1.4, hidden: ["a"], pins: { b: { x: 1, y: 1 } } };
  const m = fc.viewItems(v, { total: 5, hidden: 1, pinned: 1 });
  assert.equal(m.header, "Swarm · 5 agents");
  assert.match(m.items.find((i) => i.id === "sv:mode:scatter").label, /✓$/);
  assert.ok(!/✓/.test(m.items.find((i) => i.id === "sv:mode:gather").label));
  assert.match(m.items.find((i) => i.id === "sv:kind:terminals").label, /✓$/);
  assert.equal(m.items.find((i) => i.id === "sv:radius:reset").disabled, false);
  assert.match(m.items.find((i) => i.id === "sv:unhide").label, /Show 1 hidden fairy$/);
  const empty = fc.viewItems(fc.normalizeView(null), { total: 1 });
  assert.equal(empty.items.find((i) => i.id === "sv:unhide").disabled, true);
  assert.equal(empty.items.find((i) => i.id === "sv:radius:reset").disabled, true);

  assert.equal(fc.applyViewPick(v, "sv:mode:orb").view.mode, "orb");
  assert.equal(fc.applyViewPick(v, "sv:kind:all").view.kind, "all");
  assert.equal(fc.applyViewPick(v, "sv:radius:reset").view.radius, 1);
  assert.equal(fc.applyViewPick(v, "sv:avoid").view.avoid, false);
  assert.equal(fc.normalizeView(null).avoid, true, "keeping off the focused window is the default");
  assert.deepEqual(fc.applyViewPick(v, "sv:unhide").view.hidden, []);
  assert.deepEqual(fc.applyViewPick(v, "sv:unpin").view.pins, {});
  assert.equal(fc.applyViewPick(v, "sv:mode:wobble").error, "unknown mode wobble");
  assert.equal(fc.applyViewPick(v, "sv:mode:scatter").changed, false);
});

// -- the page's copy of the layout ---------------------------------------------------

function pageLayout() {
  const html = fs.readFileSync(path.join(__dirname, "orb.html"), "utf8");
  const m = html.match(/\/\* SWARM_LAYOUT:begin \*\/([\s\S]*?)\/\* SWARM_LAYOUT:end \*\//);
  assert.ok(m, "the layout block is in orb.html");
  return new Function(`${m[1]}; return { swarmSlots, swarmOffset, dockOffset, avoidPoint };`)();
}

test("orb.html's layout copy is fairy-control's, for every mode, radius and time", () => {
  const page = pageLayout();
  for (const mode of ["gather", "scatter"]) {
    for (const n of [1, 6, 7, 12, 30]) for (const scale of [0.8, 1, 2.5]) {
      assert.deepEqual(page.swarmSlots(mode, n, scale), fc.swarmSlots(mode, n, scale), `${mode} n=${n} x${scale}`);
      const slots = fc.swarmSlots(mode, n, scale);
      for (const t of [0, 12345, 9e6]) for (const s of slots) assert.deepEqual(page.swarmOffset(s, t), fc.swarmOffset(s, t));
    }
  }
  for (const edge of ["left", "top"]) for (let i = 0; i < 4; i += 1) assert.deepEqual(page.dockOffset(i, 4, edge), fc.dockOffset(i, 4, edge));
  const rect = { l: -30, t: -30, r: 60, b: 60 };
  for (const p of [{ x: 0, y: 0 }, { x: 55, y: 10 }, { x: -200, y: 0 }]) assert.deepEqual(page.avoidPoint(p, rect, 12), fc.avoidPoint(p, rect, 12));
});

test("gather at radius 1 is the original ring layout, so nothing moves for owners who never touch it", () => {
  for (const n of [1, 6, 7, 12, 30]) {
    const mine = fc.swarmSlots("gather", n, 1).map(({ squash, ...rest }) => { assert.equal(squash, 0.82); return rest; });
    assert.deepEqual(mine, agentFairy.swarmLayout(n), `n=${n}`);
  }
});

test("the page wires every gesture: select, wheel, drag out, double click, pin window, safe drag ends", () => {
  const html = fs.readFileSync(path.join(__dirname, "orb.html"), "utf8");
  for (const needle of [
    "api.select(", "api.swarmWheel(", 'api.swarmDrag("start"', 'api.swarmDrag("end"', "api.chatAgent(",
    'view === "pin"', "api.onPinMate", "api.onSwarmView", "avoidPoint(o, sv.avoid", "e.buttons === 0",
    '"pointercancel"', '"blur"', 'e.key === "Escape"',
  ]) assert.ok(html.includes(needle), `orb.html wires ${needle}`);
  const pre = fs.readFileSync(path.join(__dirname, "orb-preload.cjs"), "utf8");
  for (const ch of ["desk:swarm-select", "desk:swarm-wheel", "desk:swarm-drag", "orb:swarm-view", "orb:pin-mate"]) assert.ok(pre.includes(ch), ch);
});
