"use strict";

// agent-update: Desk tells the person when their local agent and bricks need an update,
// and one click upgrades them through `adk bricks` (owner, 2026-10-25; editable bricks
// 2026-11-14: "why does desk only ever prompt me to update awgraph?").

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { createAgentUpdateNotices, updatable, noticeFor, needsSourceSync } = require("./agent-update.cjs");

const ROWS = [
  { id: "awfind", installed: "0.1.0", latest: "0.2.0", outdated: true, editable: false, state: "outdated" },
  { id: "awdk", installed: "3.8.91", latest: "3.8.92", outdated: true, editable: false, state: "outdated" },
  { id: "awm", installed: "1.0.0", latest: "1.0.0", outdated: false, editable: false, state: "current" },
];

// What `adk bricks list --json` said on the owner's machine (2026-11-14), trimmed.
const EDITABLE = [
  { id: "awkno", installed: "0.2.1", latest: "0.2.9", tree: "0.2.9", outdated: true, editable: true, state: "refresh" },
  { id: "awflow", installed: "0.2.1", latest: "0.2.2", tree: "0.2.2", outdated: true, editable: true, state: "refresh" },
  { id: "awmail", installed: "0.1.0", latest: "0.1.1", tree: "0.1.0", outdated: true, editable: true, state: "tree-behind-index" },
  { id: "aitherkvcache", installed: "2.1.0", latest: "2.4.2", tree: null, outdated: true, editable: true, state: "tree-missing" },
  { id: "awgit", installed: "1.14.1", latest: "1.14.1", tree: "1.14.1", outdated: false, editable: true, state: "current" },
  // an older awdk with no `state`: an editable row is still never offered
  { id: "awold", installed: "1.0.0", latest: "1.1.0", outdated: true, editable: true },
  { id: "awgraph", installed: "1.4.14", latest: "1.4.19", outdated: true, editable: false, state: "outdated" },
];

test("index updates count, the agent first", () => {
  assert.deepEqual(updatable(ROWS).map((r) => r.id), ["awdk", "awfind"]);
  assert.deepEqual(updatable(null), []);
});

test("editable bricks whose tree is newer than their metadata are offered, not only awgraph", () => {
  assert.deepEqual(updatable(EDITABLE).map((r) => r.id), ["awkno", "awflow", "awgraph"]);
  // A tree behind the index or gone is counted, never replaced from the desk.
  assert.deepEqual(needsSourceSync(EDITABLE).map((r) => r.id), ["awmail", "aitherkvcache"]);
});

test("one notice summarises them all, in plain words", () => {
  const n = noticeFor(updatable(EDITABLE), { behind: 2 });
  assert.equal(n.title, "3 bricks need an update");
  assert.deepEqual(n.ids, ["awkno", "awflow", "awgraph"]);
  assert.match(n.body, /Click to update all 3 \(awkno, awflow, awgraph\)/);
  assert.match(n.body, /rolled back/);
  assert.match(n.body, /2 more need a source sync: see Settings > Bricks/);
  assert.doesNotMatch(n.title + n.body, /\p{Extended_Pictographic}/u);
  const refreshOnly = noticeFor(updatable(EDITABLE.slice(0, 2)));
  assert.equal(refreshOnly.title, "2 bricks need a refresh");
  const one = noticeFor(updatable(EDITABLE.slice(0, 1)));
  assert.equal(one.title, "awkno needs a refresh (0.2.1 -> 0.2.9)");
});

test("the agent's own notice still leads with the agent", () => {
  const n = noticeFor(updatable(ROWS));
  assert.equal(n.id, "awdk");
  assert.match(n.title, /Aither agent update ready, and 1 more brick/);
  const solo = noticeFor(updatable(ROWS.slice(1)));
  assert.match(solo.title, /Aither agent update ready \(3\.8\.91 -> 3\.8\.92\)/);
  assert.equal(noticeFor([]), null);
});

test("one notice per set of versions; one click upgrades every brick, one at a time, one summary", async () => {
  const shown = [];
  const acted = [];
  const u = createAgentUpdateNotices({
    listBricks: async () => ({ ok: true, data: EDITABLE }),
    actOnBrick: async (verb, id) => { acted.push([verb, id]); return id === "awflow" ? { ok: false, error: "tree fails its test" } : { ok: true }; },
    notify: (n) => shown.push(n),
  });
  assert.equal((await u.check()).title, "3 bricks need an update");
  assert.equal(await u.check(), null); // same versions: not shown twice
  assert.equal(shown.length, 1);
  shown[0].click();
  for (let i = 0; i < 10 && shown.length < 2; i++) await new Promise((r) => setImmediate(r));
  assert.deepEqual(acted, [["upgrade", "awkno"], ["upgrade", "awflow"], ["upgrade", "awgraph"]]);
  assert.equal(shown[1].title, "2 of 3 bricks updated");
  assert.match(shown[1].body, /awflow \(tree fails its test\)/);
});

test("a single update still reports its own result", async () => {
  const shown = [];
  const u = createAgentUpdateNotices({
    listBricks: async () => ({ ok: true, data: ROWS.slice(1) }),
    actOnBrick: async () => ({ ok: true }),
    notify: (n) => shown.push(n),
  });
  await u.check();
  shown[0].click();
  for (let i = 0; i < 10 && shown.length < 2; i++) await new Promise((r) => setImmediate(r));
  assert.match(shown[1].title, /Aither agent updated/);
});

test("a failed upgrade says nothing changed; off, failing or empty lists show nothing", async () => {
  const shown = [];
  const u = createAgentUpdateNotices({
    listBricks: async () => ({ ok: true, data: ROWS }),
    actOnBrick: async () => ({ ok: false, error: "test failed, rolled back" }),
    notify: (n) => shown.push(n),
  });
  await u.upgrade("awdk");
  assert.match(shown[0].body, /Nothing changed: test failed, rolled back/);

  const quiet = [];
  for (const opts of [
    { allowed: () => false, listBricks: async () => ({ ok: true, data: ROWS }) },
    { listBricks: async () => { throw new Error("adk missing"); } },
    { listBricks: async () => ({ ok: false, error: "x" }) },
    { listBricks: async () => ({ ok: true, data: [] }) },
    { listBricks: async () => ({ ok: true, data: EDITABLE.filter((r) => r.state !== "refresh" && r.editable) }) },
  ]) {
    const v = createAgentUpdateNotices({ actOnBrick: async () => ({}), notify: (n) => quiet.push(n), ...opts });
    assert.equal(await v.check(), null);
  }
  assert.equal(quiet.length, 0);
});
