"use strict";

// Owner 2026-11-12: "Why do the fairy counts not match the one in my current desktop?"
// One queue was on screen as 32 (panel), "24 more waiting" (whisper), 1 (orb badge) and
// per-companion badges. This pins the identities between the numbers that claim to be
// the same thing, over a fixture shaped like that day: cards from several agents and
// several Claude sessions, reports mixed in, some stale.

const test = require("node:test");
const assert = require("node:assert/strict");
const fc = require("./fairy-counts.cjs");
const agentFairy = require("./agent-fairy.cjs");
const fairyAttention = require("./fairy-attention.cjs");
const decisionCards = require("./decision-cards.cjs");

const NOW = Date.now();
let seq = 0;
function card(over = {}) {
  seq += 1;
  return {
    id: `d-${String(seq).padStart(4, "0")}`, kind: "decision", urgency: "normal", title: `ask ${seq}`,
    agent: "aither", createdAt: (NOW - 10 * 60_000) / 1000,
    options: [{ key: "yes", label: "Do it" }, { key: "no", label: "Leave it" }], ...over,
  };
}

function fixture() {
  seq = 0;
  const cards = [];
  for (let i = 0; i < 12; i += 1) cards.push(card({ agent: "aither" }));
  for (let i = 0; i < 7; i += 1) cards.push(card({ agent: "ship-share" }));
  // Two Claude sessions: every card says "claude-code"; the session id tells them apart.
  for (let i = 0; i < 3; i += 1) cards.push(card({ agent: "claude-code", sessionId: "346d93a0-a4ec-4901-abb7-5d3f01898b45" }));
  for (let i = 0; i < 2; i += 1) cards.push(card({ agent: "claude-code", sessionId: "9c0f702f-0000-4000-8000-000000000000" }));
  cards.push(card({ agent: "mail-receive", kind: "credential", secretName: "x" }));
  cards.push(card({ agent: "awrise", createdAt: (NOW - 9 * 24 * 3600_000) / 1000 })); // stale: badge only
  cards.push(card({ agent: "awrise" }));
  return cards;
}

/** `reports` stand in for what decision-cards.partitionCards files under fyi. */
function counted() {
  const decisions = fixture();
  const reports = [card({ agent: "garg-validate", kind: "info", options: [] }),
    card({ agent: "garg-validate", kind: "info", options: [] })];
  const open = [...decisions, ...reports];
  const companions = agentFairy.companionsFor(decisions, { current: "aither", presence: [] });
  const counts = fc.fairyCounts({
    decisions, open, agentOf: agentFairy.cardAgent, worn: agentFairy.crewKey("aither"), blockers: 1, unread: 4,
  });
  return { open, decisions, companions, counts };
}

test("the real partition keeps every decision card and both Claude sessions' cards", () => {
  const decisions = fixture();
  const kept = decisionCards.partitionCards(decisions).decisions;
  assert.equal(kept.length, decisions.length, "a decision card was filed as a report");
});

test("the orb badge IS the queue's need-you count; unread answers are never added to it", () => {
  const { counts, decisions } = counted();
  assert.equal(counts.needYou, decisions.length);
  assert.equal(counts.needYou, 27);
  assert.equal(counts.badge, counts.needYou);
  assert.equal(counts.unread, 4);
  assert.notEqual(counts.badge, counts.unread + counts.blockers, "the old badge: answers + blockers");
});

test("open = need you + reports: the panel's number is the fairy's number plus named reports", () => {
  const { counts, open } = counted();
  assert.equal(counts.open, open.length);
  assert.equal(counts.reports, 2);
  assert.equal(counts.needYou + counts.reports, counts.open);
});

test("'N more waiting' is the total minus the one shown, for a nudge and for a click alike", () => {
  const { counts, decisions } = counted();
  assert.equal(counts.more, counts.needYou - 1);
  assert.equal(fc.moreAfter(decisions, decisions[0].id), counts.needYou - 1);
  assert.equal(fc.moreAfter(decisions, decisions[decisions.length - 1].id), counts.needYou - 1);
  // The planner's own `more` counts only cards DUE a nudge (the stale one is left out):
  // that is the smaller number the whisper used to print.
  const plan = fairyAttention.plan(decisions, {}, { nowMs: NOW, returned: true });
  assert.equal(plan.act, "nudge");
  assert.ok(plan.more < counts.more, `the planner's ${plan.more} is the nudgeable subset of ${counts.more}`);
  assert.equal(fairyAttention.moreLabel(counts.more), `${counts.needYou - 1} more waiting`);
});

test("a companion badge is that agent's cards; badges plus the worn fairy's share are the total", () => {
  const { counts, companions } = counted();
  const drawn = companions.reduce((a, m) => a + m.count, 0);
  assert.equal(drawn + counts.wornCount + counts.unowned, counts.needYou);
  assert.equal(counts.wornCount, 12);
  for (const m of companions) assert.equal(m.count, counts.perAgent[m.agent], `${m.agent} badge`);
  // Two Claude sessions are two companions, not one "claude-code" with 5.
  const sessions = companions.filter((m) => m.agent.startsWith("session-"));
  assert.deepEqual(sessions.map((m) => m.count).sort(), [2, 3]);
  assert.ok(companions.every((m) => m.count < counts.needYou), "no companion carries the whole queue");
});

test("problems() is empty on a consistent set and names each broken identity", () => {
  const { counts, companions } = counted();
  assert.deepEqual(fc.problems(counts, companions), []);
  assert.match(fc.problems({ ...counts, badge: 1 }, companions).join("|"), /badge 1 is not needYou/);
  assert.match(fc.problems({ ...counts, more: 23 }, companions).join("|"), /more 23 is not needYou - 1/);
  assert.match(fc.problems({ ...counts, open: 99 }, companions).join("|"), /open 99 is not needYou \+ reports/);
  const lying = companions.map((m, i) => (i === 0 ? { ...m, count: 32 } : m));
  assert.match(fc.problems(counts, lying).join("|"), /companion badges .* is not needYou/);
});

test("every number is labelled with what it counts and its scope", () => {
  const { counts } = counted();
  assert.equal(fc.badgeTitle(counts), "27 need you · 2 reports · 4 answers to read · all workspaces");
  assert.equal(fc.badgeTitle({ needYou: 1, scope: fc.SCOPE }), "1 needs you · all workspaces");
  assert.equal(fc.queueHeader(counts), "27 need you · all workspaces");
  assert.equal(fc.queueHeader(counts, { shown: 5 }), "5 of 27 need you · all workspaces");
});

test("nothing waiting: zeros, no negative 'more', nothing invented", () => {
  const counts = fc.fairyCounts({ decisions: [], open: [] });
  assert.equal(counts.needYou, 0);
  assert.equal(counts.more, 0);
  assert.equal(fc.moreAfter([], "d-x"), 0);
  assert.deepEqual(fc.problems(counts, []), []);
});

test("the orb window and the pages use the one function (no second count)", () => {
  const fs = require("node:fs");
  const path = require("node:path");
  const win = fs.readFileSync(path.join(__dirname, "orb-window.cjs"), "utf8");
  assert.ok(!/orbCore\.unreadCount\(queue\) \+ attention\.count/.test(win), "the old badge sum is back");
  assert.ok(!/more: Math\.max\(0, attentionCards\.length - 1\)/.test(win), "a hand-rolled 'more' is back");
  assert.match(win, /fairyCounts\.moreAfter\(attentionCards, decision\.card\.id\)/);
  assert.match(win, /fairyCounts\.moreAfter\(attentionCards, card\.id\)/);
  assert.ok(!/Needs you \(\$\{attention\.count\}\)/.test(win), "the menu's 'Needs you (n)' counts blockers again");
  const queuePage = fs.readFileSync(path.join(__dirname, "fairy-queue.html"), "utf8");
  assert.match(queuePage, /need you · all workspaces/);
});
