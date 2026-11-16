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
  assert.match(body, /decisionCards\.waitingCount\(cards\)/);
  assert.doesNotMatch(body, /partitionCards|actionableCount|\.filter\(/, "inboxCounts grew its own tally");
});

test("the bridge answers `waiting` (the bell reads it) from the same function, beside `count`", () => {
  const body = CARDS.slice(CARDS.indexOf("async function bridgeQueue("), CARDS.indexOf("/** GET /needs-you"));
  assert.equal((body.match(/waiting: waitingCount\(decisions\)/g) || []).length, 2, "daemon and local branches both carry it");
  assert.match(CARDS, /function waitingCount\(cards, patterns\)[\s\S]*partitionCards\(cards, \{ patterns \}\)\.decisions\.length/);
});

test("the fairy's badge counts the queue main hands it, which is the same partition", () => {
  assert.match(MAIN, /orbWindow\.setAttentionCards\(decisionCards\.partitionCards\(openDecisions\)\.decisions, openDecisions\)/);
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
