"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const cluster = require("./fairy-cluster.cjs");

const NOW = 1_800_000_000_000;

function card(id, extra = {}) {
  return { id, title: `Card ${id}`, agent: "lyra", createdAt: NOW / 1000 - 60, status: "open", ...extra };
}

function claudeSessions(ids) {
  return new Map(ids.map((id) => [id, { name: `tab ${id}`, status: "busy", cwd: "C:\\x" }]));
}

test("grow: one fairy per queued decision and per live session", () => {
  const entries = cluster.liveEntries({
    cards: [card("d-a"), card("d-b"), card("d-c")],
    sessions: [claudeSessions(["aaaaaaaa-1", "bbbbbbbb-2"])],
    nowMs: NOW,
  });
  assert.equal(entries.length, 5);
  assert.deepEqual(entries.filter((e) => e.kind === "decision").map((e) => e.cardId).sort(), ["d-a", "d-b", "d-c"]);
  assert.equal(entries.filter((e) => e.kind === "session").length, 2);
  // Decisions lead the cluster.
  assert.equal(entries[0].kind, "decision");
});

test("empty sources = empty cluster (N=0)", () => {
  assert.deepEqual(cluster.liveEntries({ nowMs: NOW }), []);
  const r = cluster.createReaper();
  assert.deepEqual(r.reconcile([], { nowMs: NOW }).kept, []);
});

test("answered, cancelled and expired decisions are not fairies", () => {
  const entries = cluster.liveEntries({
    cards: [
      card("open"),
      card("answered", { status: "answered" }),
      card("cancelled", { status: "cancelled" }),
      card("expired", { deadline: NOW / 1000 - 5 }),
      card("later", { deadline: NOW / 1000 + 600 }),
    ],
    nowMs: NOW,
  });
  assert.deepEqual(entries.map((e) => e.cardId).sort(), ["later", "open"]);
});

test("awsh daemon rows and Claude tabs merge by session id; ended rows drop", () => {
  const rows = cluster.sessionRows([
    claudeSessions(["abcdef12-3456"]),
    [
      { session_id: "abcdef12-3456", status: "running", harness: "claude-code" }, // same session
      { session_id: "99999999-0000", status: "running", harness: "opencode", name: "awsh opencode" },
      { session_id: "77777777-0000", status: "ended" },
      { session_id: "66666666-0000", status: "running", alive: false },
    ],
  ]);
  assert.equal(rows.length, 2);
  assert.ok(rows.some((r) => r.label === "awsh opencode" && r.state === "working"));
});

test("shrink: a fairy whose decision was answered or whose session ended leaves on the next reconcile", () => {
  const r = cluster.createReaper();
  const first = cluster.liveEntries({ cards: [card("d-1"), card("d-2")], sessions: [claudeSessions(["s1aaaaaa"])], nowMs: NOW });
  assert.equal(r.reconcile(first, { nowMs: NOW }).kept.length, 3);
  const second = cluster.liveEntries({ cards: [card("d-2")], sessions: [new Map()], nowMs: NOW + 10_000 });
  const out = r.reconcile(second, { nowMs: NOW + 10_000, ok: { cards: true, sessions: true } });
  assert.deepEqual(out.kept.map((e) => e.key), ["d:d-2"]);
  assert.deepEqual(out.left.sort(), ["d:d-1", "s:session-s1aaaaaa"]);
});

test("reap: an unreadable source keeps its fairies for 30 s, then they are orphans and go", () => {
  const r = cluster.createReaper({ staleMs: 30_000 });
  r.reconcile(cluster.liveEntries({ cards: [card("d-1")], sessions: [claudeSessions(["s2bbbbbb"])], nowMs: NOW }), { nowMs: NOW });
  // The session daemon stops answering: no session rows, ok.sessions=false.
  const mid = r.reconcile(cluster.liveEntries({ cards: [card("d-1")], nowMs: NOW + 20_000 }),
    { nowMs: NOW + 20_000, ok: { cards: true, sessions: false } });
  assert.equal(mid.kept.length, 2, "held while the source is unreadable");
  const late = r.reconcile(cluster.liveEntries({ cards: [card("d-1")], nowMs: NOW + 31_000 }),
    { nowMs: NOW + 31_000, ok: { cards: true, sessions: false } });
  assert.deepEqual(late.kept.map((e) => e.key), ["d:d-1"]);
  assert.deepEqual(late.left, ["s:session-s2bbbbbb"]);
});

test("desk start: a fresh reaper carries no orphan from a previous run", () => {
  const r = cluster.createReaper();
  r.reconcile(cluster.liveEntries({ cards: [card("old")], nowMs: NOW }), { nowMs: NOW });
  r.reset();
  assert.equal(r.size(), 0);
  assert.deepEqual(r.reconcile([], { nowMs: NOW + 1 }).kept, []);
});

test("cap: past N the tail collapses into one counted bead (N=8, cap 6 -> 5 + bead of 3)", () => {
  const cards = Array.from({ length: 8 }, (_, i) => card(`d-${i}`, { createdAt: NOW / 1000 - i }));
  const all = cluster.liveEntries({ cards, nowMs: NOW });
  const c = cluster.collapse(all, 6);
  assert.equal(c.total, 8);
  assert.equal(c.shown.length, 6);
  const bead = c.shown[c.shown.length - 1];
  assert.equal(bead.kind, "more");
  assert.equal(bead.count, 3);
  assert.equal(c.hidden, 3);
  // At or under the cap nothing collapses (N=3).
  const three = cluster.collapse(all.slice(0, 3), 6);
  assert.equal(three.shown.length, 3);
  assert.ok(three.shown.every((e) => e.kind !== "more"));
});

test("count label says how many wait and how many agents work", () => {
  const all = cluster.liveEntries({ cards: [card("a"), card("b")], sessions: [claudeSessions(["cccccccc"])], nowMs: NOW });
  assert.equal(cluster.countLabel(all), "2 waiting · 1 agent");
  assert.equal(cluster.countLabel([]), "");
});

test("platform agents count only while working or waiting; sessions are not doubled", () => {
  const e = cluster.agentEntries([
    { agent: "atlas", state: "working", work: [{ title: "board sweep" }] },
    { agent: "lyra", state: "idle" },
    { agent: "session-abcdef12", state: "working" },
  ]);
  assert.deepEqual(e.map((x) => x.key), ["a:atlas"]);
});
