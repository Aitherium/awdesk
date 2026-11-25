"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { buildUniverse, dim, appOfTab, APP_BODIES, routinesFromJobs } = require("./universe-client.cjs");

const NOW = () => Date.parse("2026-11-24T20:00:00Z");

function ids(u) { return u.nodes.map((n) => n.id).sort(); }

test("every app is a body whether or not it is open, and says how many windows it holds", () => {
  const u = buildUniverse({ now: NOW });
  for (const app of APP_BODIES) assert.ok(ids(u).includes(app.id), `${app.id} missing`);
  assert.equal(u.nodes.find((n) => n.id === "app:rooms").status, "idle");
  const open = buildUniverse({ now: NOW, tabs: [{ id: "t1", url: "https://x/companyroom", title: "Rooms" }] });
  assert.equal(open.nodes.find((n) => n.id === "app:rooms").status, "active");
  assert.equal(open.nodes.find((n) => n.id === "app:rooms").meta.open, 1);
});

test("every open window appears exactly once, linked to its app", () => {
  const tabs = [
    { id: "a", url: "https://app.aitherium.com/companyroom", title: "Rooms" },
    { id: "b", url: "https://app.aitherium.com/workspace/one", title: "Pages" },
    { id: "c", url: "https://shadowbroker.aitherium.com/", title: "World" },
  ];
  const u = buildUniverse({ now: NOW, tabs });
  const wins = u.nodes.filter((n) => n.meta && n.meta.kind === "window");
  assert.equal(wins.length, tabs.length, "one body per open window");
  assert.deepEqual(wins.map((w) => w.id).sort(), ["win:a", "win:b", "win:c"]);
  const edges = Object.fromEntries(u.links.map((l) => [l.target, l.source]));
  assert.equal(edges["win:a"], "app:rooms");
  assert.equal(edges["win:b"], "app:pages");
  assert.equal(edges["win:c"], "app:world");
  assert.ok(u.links.every((l) => l.kind === "parent-child"));
});

test("an agent is a SHIP on the body it touches, never a planet of its own", () => {
  const u = buildUniverse({
    now: NOW,
    tabs: [{ id: "a", url: "https://app.aitherium.com/companyroom", title: "Garg film desk" }],
    agents: [{ id: "s1", label: "garg", kind: "session", state: "working" }],
  });
  assert.ok(!ids(u).some((id) => id.startsWith("agent:") || id === "s1"), "an agent must not be a node");
  assert.equal(u.nodes.find((n) => n.id === "win:a").assignee, "s1");
});

test("two agents on one body are a crew; an agent that matches nothing works the room", () => {
  const u = buildUniverse({
    now: NOW,
    tabs: [{ id: "a", url: "https://x/companyroom", title: "Rooms" }],
    agents: [{ id: "s1", label: "rooms" }, { id: "s2", label: "rooms" }, { id: "s3", label: "elsewhere" }],
  });
  const win = u.nodes.find((n) => n.id === "win:a");
  assert.equal(win.assignee, "s1");
  assert.deepEqual(win.meta.crew, ["s1", "s2"]);
  assert.equal(u.nodes.find((n) => n.id === "app:rooms").assignee, "s3", "no match: it works the room");
});

test("a routine is a station, and a starved one is blocked rather than gone", () => {
  const u = buildUniverse({ now: NOW, routines: [
    { name: "awmine", state: "running", lastRun: "2026-11-24T19:00:00Z" },
    { name: "harvest", state: "starved" },
    { name: "nightly", state: "idle" },
  ] });
  const by = Object.fromEntries(u.nodes.filter((n) => n.cluster === "routines").map((n) => [n.title, n]));
  assert.equal(by.awmine.status, "active");
  assert.equal(by.harvest.status, "blocked");
  assert.equal(by.nightly.status, "idle");
  assert.equal(by.awmine.meta.unassigned, true, "unassigned work is the engine's slow station");
});

test("the platform galaxies and the world's pins ride along, and links only survive between real nodes", () => {
  const u = buildUniverse({
    now: NOW,
    platform: {
      nodes: [{ id: "galaxy:fleet", title: "Fleet", cluster: "galaxies" }, { id: "svc:genesis", title: "Genesis" }],
      links: [{ source: "galaxy:fleet", target: "svc:genesis", kind: "parent-child" },
        { source: "galaxy:fleet", target: "svc:missing", kind: "parent-child" }],
    },
    pins: [{ id: "p1", label: "Port", lat: 44, lng: 33 }],
  });
  assert.ok(ids(u).includes("galaxy:fleet"));
  assert.ok(ids(u).includes("world:p1"));
  assert.equal(u.links.filter((l) => l.target === "svc:missing").length, 0, "a dangling link is dropped");
});

test("nothing is ever emitted twice, whatever the sources overlap", () => {
  const u = buildUniverse({
    now: NOW,
    tabs: [{ id: "a", url: "https://x/companyroom", title: "Rooms" }, { id: "a", url: "https://x/companyroom", title: "Rooms" }],
    platform: { nodes: [{ id: "app:rooms", title: "dupe" }], links: [] },
  });
  const seen = new Set();
  for (const n of u.nodes) {
    assert.ok(!seen.has(n.id), `${n.id} emitted twice`);
    seen.add(n.id);
  }
});

test("a dead source DIMS the last good map, never empties it", () => {
  const last = buildUniverse({ now: NOW, routines: [{ name: "awmine", state: "running" }] });
  const dimmed = dim(last, "routines", "awrise did not answer");
  assert.equal(dimmed.nodes.length, last.nodes.length);
  assert.ok(dimmed.nodes.every((n) => n.status === "unknown"));
  assert.deepEqual(dimmed.degraded, [{ source: "routines", error: "awrise did not answer" }]);
  assert.deepEqual(dim(null, "tabs", "no state").nodes, []);
});

test("appOfTab reads the desk's own vocabulary", () => {
  assert.equal(appOfTab({ url: "https://app.aitherium.com/companyroom" }), "app:rooms");
  assert.equal(appOfTab({ url: "https://app.aitherium.com/workspace/one" }), "app:pages");
  assert.equal(appOfTab({ url: "aither://search/?mode=q" }), "app:search");
  assert.equal(appOfTab({ url: "https://shadowbroker.aitherium.com/" }), "app:world");
  assert.equal(appOfTab({ url: "https://arc.aitherium.com/aithernet" }), "app:net");
  assert.equal(appOfTab({ url: "https://aitherium.com/spaces/view" }), "app:spaces");
  assert.equal(appOfTab({ url: "https://aitherium.com/workspaces" }), "app:workspaces");
  assert.equal(appOfTab({ url: "https://news.example/" }), "app:browse");
});

test("awrise jobs become stations: failing is starved, disabled is kept and marked", () => {
  const rows = routinesFromJobs({
    awmine: { enabled: true, last_state: "ok", last_finished_at: "2026-11-24T19:00:00Z" },
    harvest: { enabled: true, consecutive_failures: 3 },
    nightly: { enabled: false },
    junk: "not a job",
  });
  assert.deepEqual(rows.map((r) => [r.name, r.state]), [["awmine", "idle"], ["harvest", "starved"], ["nightly", "disabled"]]);
  const u = buildUniverse({ now: NOW, routines: rows });
  const stations = u.nodes.filter((n) => n.cluster === "routines");
  assert.equal(stations.length, 3);
  assert.equal(stations.find((n) => n.title === "harvest").status, "blocked");
});
