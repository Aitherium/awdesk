"use strict";

// fairy-queue.cjs under node --test: the list behind the fairy's "N more waiting"
// link. Repeats collapse to one entry with a count, needs-you cards lead, the
// search reads title/source/body, source chips count what the filters left, and
// the cards that answer themselves fold behind one toggle. No electron here.

const test = require("node:test");
const assert = require("node:assert/strict");
const queue = require("./fairy-queue.cjs");

const NOW = 1_800_000_000;

function card(over = {}) {
  return {
    id: "d-a",
    title: "Wake pr-housekeeping failed 5x",
    kind: "decision",
    urgency: "normal",
    createdAt: NOW - 3600,
    deadline: 0,
    options: [{ key: "keep", label: "Keep it scheduled" }, { key: "fix", label: "Fix it" }],
    defaultKey: "keep",
    summary: "",
    detail: "",
    facts: [],
    agent: "awrise",
    tab: "",
    host: "",
    cwd: "",
    blocking: false,
    ...over,
  };
}

test("repeats collapse: same source + same title is ONE entry with a count", () => {
  const groups = queue.groupRepeats([
    card({ id: "d-a1" }),
    card({ id: "d-a2" }),
    card({ id: "d-b", title: "Something else" }),
    card({ id: "d-c", title: "Wake pr-housekeeping failed 5x", agent: "claude-code" }),
  ]);
  assert.equal(groups.length, 3);
  const first = groups[0];
  assert.equal(first.count, 2);
  assert.deepEqual(first.ids, ["d-a1", "d-a2"]);
  assert.equal(first.id, "d-a1", "the first in rank order represents the group");
  assert.equal(groups[2].count, 1, "same title from ANOTHER source is its own ask");
});

test("a card with no title never merges, however alike it looks", () => {
  const groups = queue.groupRepeats([card({ id: "d-x", title: "" }), card({ id: "d-y", title: "" })]);
  assert.equal(groups.length, 2);
});

test("queueView: needs-you entries lead, rank order kept inside a tier", () => {
  const cards = [
    card({ id: "d-1", title: "First" }),
    card({ id: "d-2", title: "Second" }),
    card({ id: "d-c", title: "Secret needed", kind: "credential", agent: "secret" }),
  ];
  const view = queue.queueView(cards);
  assert.deepEqual(view.entries.map((e) => e.id), ["d-c", "d-1", "d-2"]);
  assert.equal(view.entries[0].needsYou, true);
});

test("queueView: the search reads title, source AND body; every token must match", () => {
  const cards = [
    card({ id: "d-title", title: "Proton Bridge certificate" }),
    card({ id: "d-src", title: "Revenue governor", agent: "revenue-governor" }),
    card({ id: "d-body", title: "Policy note", summary: "the grant was refused by policy" }),
    card({ id: "d-fact", title: "Grant card", facts: ["permission_rule: Bash(git push)"] }),
  ];
  const ids = (q) => queue.queueView(cards, { query: q }).entries.map((e) => e.id);
  assert.deepEqual(ids("proton"), ["d-title"]);
  assert.deepEqual(ids("revenue governor"), ["d-src"]);
  assert.deepEqual(ids("refused"), ["d-body"]);
  assert.deepEqual(ids("permission_rule"), ["d-fact"]);
  assert.deepEqual(ids("unrelated policy"), [], "tokens AND, never OR");
});

test("the search reads a repeat's body too, not only the first card's", () => {
  const cards = [
    card({ id: "d-r1", title: "Wake pruning failed", summary: "" }),
    card({ id: "d-r2", title: "Wake pruning failed", summary: "cannot reach the sink" }),
  ];
  const view = queue.queueView(cards, { query: "sink" });
  assert.deepEqual(view.entries.map((e) => e.id), ["d-r1"]);
  assert.equal(view.entries[0].count, 2);
});

test("queueView: source chips carry counts and the chip filters the list", () => {
  const cards = [
    card({ id: "d-1", title: "One", agent: "awrise" }),
    card({ id: "d-2", title: "Two", agent: "awrise" }),
    card({ id: "d-3", title: "Three", agent: "revenue-governor" }),
  ];
  const view = queue.queueView(cards);
  assert.deepEqual(view.sources, [
    { label: "awrise", count: 2 },
    { label: "revenue-governor", count: 1 },
  ]);
  const filtered = queue.queueView(cards, { source: "revenue-governor" });
  assert.deepEqual(filtered.entries.map((e) => e.id), ["d-3"]);
  assert.equal(filtered.filteredEntries, 3, "chips keep counting what the query left");
});

test("queueView: hideSelfAnswering folds entries whose every card answers itself", () => {
  const cards = [
    card({ id: "d-wake1" }),
    card({ id: "d-wake2" }),
    // A real ask from the same source: NOT hidden, and it keeps the entry's count honest.
    card({ id: "d-real", title: "A real question", agent: "awrise", deadline: 0, defaultKey: "",
      options: [{ key: "a", label: "Approve" }, { key: "b", label: "Deny" }] }),
    card({ id: "d-share", title: "Share: a blog post", agent: "ship-share", deadline: 0,
      options: [{ key: "go", label: "Share" }, { key: "skip", label: "Skip" }], defaultKey: "skip" }),
  ];
  const all = queue.queueView(cards);
  assert.equal(all.entries.length, 3);
  const hidden = queue.queueView(cards, { hideSelfAnswering: true });
  assert.deepEqual(hidden.entries.map((e) => e.id), ["d-real"]);
  assert.equal(hidden.shownCards, 1);
  assert.equal(hidden.totalCards, 4);
});

test("a mixed group is a needs-you entry even when its first card answers itself", () => {
  const groups = queue.groupRepeats([
    card({ id: "d-ask1" }),
    card({ id: "d-ask2", kind: "blocked", blocking: true, defaultKey: "" }),
  ]);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].needsYou, true);
  assert.equal(groups[0].selfAnswering, false);
});

test("source falls back to folder, then Other, so a chip always exists", () => {
  assert.equal(queue.cardSource(card({ agent: "", tab: "", host: "", cwd: "C:\\work\\desk" })), "desk");
  assert.equal(queue.cardSource(card({ agent: "", tab: "", host: "", cwd: "" })), "Other");
});

test("a repeat row explains its own suggestion", () => {
  assert.match(queue.suggestedLine(card()), /Keep it scheduled.*changes nothing/);
  const real = card({ defaultKey: "fix" });
  assert.match(queue.suggestedLine(real), /suggests “Fix it”/);
  assert.doesNotMatch(queue.suggestedLine(real), /changes nothing/);
});
