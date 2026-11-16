"use strict";

// ONE number for "waiting on you" (owner, 2026-11-16: the bell said 22, the fairy 40, the
// launcher fairy 39). decision-cards.waitingCount is the one function. These pin that the
// surfaces read it, so a new surface cannot grow its own tally without failing here.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const read = (f) => fs.readFileSync(path.join(__dirname, f), "utf8");
const MAIN = read("main.cjs");
const CARDS = read("decision-cards.cjs");

test("main's inboxCounts (tray, console rail, Inbox pill, deck badge) is decisionCards.waitingCount", () => {
  const body = MAIN.slice(MAIN.indexOf("function inboxCounts("), MAIN.indexOf("// -- the session behind a card"));
  assert.match(body, /decisionCards\.waitingCount\(cards, undefined, ended\)/);
  assert.doesNotMatch(body, /partitionCards|actionableCount|\.filter\(/, "inboxCounts grew its own tally");
});

test("the bridge answers `waiting` (the bell reads it) from the same function, beside `count`", () => {
  const body = CARDS.slice(CARDS.indexOf("async function bridgeQueue("), CARDS.indexOf("/** GET /needs-you"));
  assert.equal((body.match(/waiting: waitingCount\(decisions, undefined, /g) || []).length, 2, "daemon and local branches both carry it");
  assert.match(CARDS, /function waitingCount\(cards, patterns, ended = null\)[\s\S]*partitionCards\(cards, \{ patterns, ended \}\)\.decisions\.length/);
  assert.match(MAIN, /bridgeQueue\(\{ endedOf: endedIdSet \}\)/, "the bridge must leave ended-session cards out too");
});

test("the fairy's badge counts the queue main hands it, which is the same partition", () => {
  assert.match(MAIN, /orbWindow\.setAttentionCards\(decisionCards\.partitionCards\(openDecisions, \{ ended: endedIdSet\(openDecisions\) \}\)\.decisions, openDecisions\)/);
  const counts = require("./fairy-counts.cjs");
  const decisions = [{ id: "d-1" }, { id: "d-2" }];
  assert.equal(counts.fairyCounts({ decisions }).badge, decisions.length);
});

test("the ended-session sweep runs on every card change and on a timer, and only through ended-cards.sweep", () => {
  assert.match(MAIN, /onChange: \(cards\) => \{\s*openDecisions = cards;\s*sweepEndedSessionCards\(cards\);/);
  assert.match(MAIN, /setInterval\(\(\) => sweepEndedSessionCards\(openDecisions\), 150_000\)/);
  assert.match(MAIN, /endedCards\.sweep\(cards, live, \{[\s\S]*judged,/, "an unjudged liveness read must reach the sweep");
  assert.match(MAIN, /liveSessionsChecked\(\)/);
});

test("cards from ended sessions leave the one number but stay listed on their own line", () => {
  const cards = require("./decision-cards.cjs");
  const open = [
    { id: "d-1", kind: "decision", options: [{ key: "a", label: "A" }], createdAt: 1 },
    { id: "d-2", kind: "blocked", sessionId: "s", createdAt: 2 },
    { id: "d-3", kind: "approval", options: [{ key: "a", label: "A" }], sessionId: "s", createdAt: 3 },
  ];
  assert.equal(cards.waitingCount(open), 3, "nothing excluded without an ended set");
  const ended = new Set(["d-2", "d-3"]);
  assert.equal(cards.waitingCount(open, undefined, ended), 1);
  const part = cards.partitionCards(open, { ended });
  assert.deepEqual(part.ended.map((c) => c.id).sort(), ["d-2", "d-3"]);
  assert.deepEqual(part.needsYou, [], "a blocked card from an ended session is not on the red-key strip");
  assert.equal(part.decisions.length + part.fyi.length + part.ended.length, open.length, "no card is lost");
});

test("bridgeQueue reports `waiting` without ended cards and says how many it left out", async () => {
  const cards = require("./decision-cards.cjs");
  const open = [
    { id: "d-1", kind: "decision", options: [{ key: "a", label: "A" }] },
    { id: "d-2", kind: "approval", options: [{ key: "a", label: "A" }], sessionId: "s" },
  ];
  const q = await cards.bridgeQueue({ fetchOpen: async () => open, endedOf: () => new Set(["d-2"]) });
  assert.equal(q.count, 2);
  assert.equal(q.waiting, 1);
  assert.equal(q.endedSessions, 1);
  const none = await cards.bridgeQueue({ fetchOpen: async () => open });
  assert.equal(none.waiting, 2);
});
