"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const awtab = require("./awtab.cjs");

const snapshot = () => ({
  browser: "chrome",
  profile: "Default",
  at: 1000,
  windows: [
    {
      id: 1, active: true, tabs: [
        { id: "a", url: "https://github.com/Aitherium/awdesk/pulls", title: "Pull requests", active: true, index: 0, groupId: 7 },
        { id: "b", url: "https://github.com/Aitherium/awdesk/issues", title: "Issues", index: 1, groupId: 7 },
        { id: "c", url: "https://example.com/report?token=ok", title: "Report", index: 2, groupId: -1 },
        { id: "d", url: "chrome://settings", title: "Settings", index: 3, groupId: -1 },
        { id: "e", url: "https://user:pass@example.org/secret", title: "Creds", index: 4, groupId: -1 },
      ],
    },
    { id: 2, active: false, tabs: [{ id: "f", url: "https://news.ycombinator.com/", title: "HN", active: true, index: 0, groupId: -1 }] },
    { id: 3, incognito: true, tabs: [{ id: "g", url: "https://private.example/", title: "Private", index: 0, groupId: -1 }] },
  ],
  groups: [
    { id: 7, windowId: 1, title: "GitHub", color: "blue" },
    { id: 9, windowId: 1, title: "Empty", color: "red" },
  ],
});

test("normalizeSnapshot drops private windows, non-http pages and credentials", () => {
  const s = awtab.normalizeSnapshot(snapshot());
  assert.equal(s.browser, "chrome");
  assert.equal(s.windows.length, 2, "the incognito window is never mirrored");
  const urls = s.windows.flatMap((w) => w.tabs.map((t) => t.url));
  assert.ok(!urls.some((u) => u.startsWith("chrome://")), "browser-internal pages are not tabs");
  const creds = urls.find((u) => u.includes("example.org"));
  assert.ok(creds && !creds.includes("pass@"), "a URL never carries a password into the desk");
  assert.equal(awtab.normalizeSnapshot(null), null);
  assert.equal(awtab.normalizeSnapshot({ browser: "netscape" }), null, "an unknown browser is refused");
});

test("planGroups: native groups keep name and colour, loose tabs group by window", () => {
  const groups = awtab.planGroups(awtab.normalizeSnapshot(snapshot()));
  assert.equal(groups.length, 3, "two native groups (one empty, dropped) + two windows… minus the empty one");
  const gh = groups.find((g) => g.name === "GitHub");
  assert.equal(gh.colour, "blue");
  assert.equal(gh.tabs.length, 2);
  assert.equal(gh.key, "awtab:chrome:Default:g7");
  assert.ok(!groups.some((g) => g.name === "Empty"), "a group with no http tab is dropped");
  const w1 = groups.find((g) => g.kind === "w" && g.windowId === 1);
  assert.deepEqual(w1.tabs.map((t) => t.url),
    ["https://example.com/report?token=ok", "https://example.org/secret"],
    "only the loose, safe tabs -- and the credential tab keeps its address, never its password");
  const w2 = groups.find((g) => g.kind === "w" && g.windowId === 2);
  assert.equal(w2.name, "HN", "an ungrouped window is named after its active tab");
  assert.equal(groups[0].kind, "g", "native groups lead");
});

test("planGroups caps tabs and groups", () => {
  const raw = { browser: "edge", profile: "Work", windows: [], groups: [] };
  for (let i = 0; i < 20; i += 1) {
    raw.windows.push({ id: i, tabs: Array.from({ length: 30 }, (_, j) => ({ id: `${i}-${j}`, url: `https://site${i}.example/p${j}`, title: `T${j}`, index: j })) });
  }
  const groups = awtab.planGroups(awtab.normalizeSnapshot(raw));
  assert.ok(groups.length <= awtab.MAX_GROUPS);
  assert.ok(groups.every((g) => g.tabs.length <= awtab.MAX_GROUP_TABS));
});

test("diff creates, updates and removes by group key", () => {
  const plan = awtab.planGroups(awtab.normalizeSnapshot(snapshot()));
  const current = [
    { stageId: "s2", key: plan[0].key, name: plan[0].name, colour: plan[0].colour, urls: ["https://stale/"] },
    { stageId: "s3", key: "awtab:chrome:Default:g99", name: "Gone", colour: "red", urls: [] },
  ];
  const d = awtab.diff(current, plan);
  assert.equal(d.update.length, 1);
  assert.equal(d.update[0].stageId, "s2", "an existing mirror is updated in place");
  assert.deepEqual(d.remove, ["s3"], "a group that vanished removes its stage");
  assert.equal(d.create.length, plan.length - 1);
  assert.deepEqual(awtab.diff([], []), { create: [], update: [], remove: [] });
});

test("sameGroups compares keys, names and tab order", () => {
  const plan = awtab.planGroups(awtab.normalizeSnapshot(snapshot()));
  assert.equal(awtab.sameGroups(plan, plan), true);
  const moved = plan.map((g, i) => (i ? g : { ...g, tabs: [...g.tabs].reverse() }));
  assert.equal(awtab.sameGroups(plan, moved), false);
});

test("ringModel: inner ring is groups, outer ring is the picked group's tabs", () => {
  const groups = awtab.planGroups(awtab.normalizeSnapshot(snapshot()));
  const closed = awtab.ringModel(groups, "");
  assert.equal(closed.inner.length, groups.length);
  assert.deepEqual(closed.outer, [], "no pick, no outer ring");
  assert.ok(closed.inner[0].id.startsWith("aithertab:group:awtab:chrome:Default:g7"));

  const gh = groups.find((g) => g.name === "GitHub");
  const open = awtab.ringModel(groups, gh.key);
  assert.equal(open.selected, gh.key);
  assert.equal(open.outer.length, 2);
  assert.equal(open.outer[0].url, "https://github.com/Aitherium/awdesk/pulls");
  const many = awtab.ringModel([{ ...gh, tabs: Array.from({ length: 20 }, (_, i) => ({ url: `https://x/${i}`, title: `x${i}` })) }], gh.key);
  assert.equal(many.outer.length, awtab.MAX_GROUP_TABS + 1, "a 12-tab cap plus one 'open all' slice");
  assert.match(many.outer.at(-1).id, /^aithertab:more:/);
});

test("fairyEntry: one companion with the group count, none when nothing is mirrored", () => {
  assert.equal(awtab.fairyEntry([]), null);
  const groups = awtab.planGroups(awtab.normalizeSnapshot(snapshot()));
  const f = awtab.fairyEntry(groups, 42);
  assert.equal(f.key, "t:aithertab");
  assert.equal(f.kind, "aithertab");
  assert.equal(f.count, groups.length);
  assert.match(f.title, /mirrored group/);
  assert.equal(f.at, 42);
});
