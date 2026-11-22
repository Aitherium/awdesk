"use strict";

// agent-update: Desk tells the person when their local agent has an update, and the
// click upgrades it through `adk bricks` (owner, 2026-10-25).

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { createAgentUpdateNotices, updatable, noticeFor } = require("./agent-update.cjs");

const ROWS = [
  { id: "awfind", installed: "0.1.0", latest: "0.2.0", outdated: true, editable: false },
  { id: "awdk", installed: "3.8.91", latest: "3.8.92", outdated: true, editable: false },
  { id: "awgit", installed: "1.0.0", latest: "1.1.0", outdated: true, editable: true },
  { id: "awm", installed: "1.0.0", latest: "1.0.0", outdated: false, editable: false },
];

test("only outdated index installs count, the agent first", () => {
  assert.deepEqual(updatable(ROWS).map((r) => r.id), ["awdk", "awfind"]);
  assert.deepEqual(updatable(null), []);
});

test("the notice names the agent update in plain words", () => {
  const n = noticeFor(updatable(ROWS));
  assert.equal(n.id, "awdk");
  assert.match(n.title, /Aither agent update ready \(3\.8\.91 -> 3\.8\.92\)/);
  assert.match(n.body, /rolls back/);
  assert.match(n.body, /1 more update in Settings > Bricks/);
  assert.doesNotMatch(n.title + n.body, /\p{Extended_Pictographic}/u);
  assert.equal(noticeFor([]), null);
});

test("one notice per version, a click upgrades, and the result is reported", async () => {
  const shown = [];
  const acted = [];
  const u = createAgentUpdateNotices({
    listBricks: async () => ({ ok: true, data: ROWS }),
    actOnBrick: async (verb, id) => { acted.push([verb, id]); return { ok: true }; },
    notify: (n) => shown.push(n),
  });
  assert.equal((await u.check()).id, "awdk");
  assert.equal(await u.check(), null); // same version: not shown twice
  assert.equal(shown.length, 1);
  shown[0].click();
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(acted, [["upgrade", "awdk"]]);
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
  ]) {
    const v = createAgentUpdateNotices({ actOnBrick: async () => ({}), notify: (n) => quiet.push(n), ...opts });
    assert.equal(await v.check(), null);
  }
  assert.equal(quiet.length, 0);
});
