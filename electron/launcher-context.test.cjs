"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const { needsYouGroup } = require("./launcher-context.cjs");

function cardRow(id, extra = {}) {
  return {
    id,
    title: `Card ${id}`,
    kind: "decision",
    urgency: "normal",
    summary: "",
    defaultKey: "",
    needsYou: false,
    stale: false,
    options: [{ index: 1, key: "ack", label: "Ack", recommended: true }],
    ...extra,
  };
}

test("the empty launcher leads with the open cards, in the order it was given", () => {
  const { group, items } = needsYouGroup([cardRow("d-b"), cardRow("d-a")]);
  assert.equal(group.id, "needs-you");
  assert.equal(group.label, "Needs you", "the count is the badge, not the label");
  assert.equal(group.total, 2);
  assert.deepEqual(items.map((i) => i.key), ["card:d-b", "card:d-a"], "no second ranking");
  assert.equal(items[0].kind, "card");
  assert.equal(items[0].target, "d-b");
});

test("needsYouGroup caps the glance and reports the real remainder", () => {
  const rows = [1, 2, 3, 4, 5, 6, 7, 8].map((n) => cardRow(`d-${n}`));
  const { group } = needsYouGroup(rows);
  // Collapsed the overlay draws `shown` (5); expanding it draws `items`, which
  // is the same rows plus the rest -- never a different set, so no row moves.
  assert.equal(group.shown.length, 5);
  assert.equal(group.items.length, 8, "expanding a glance of 8 shows all 8");
  assert.equal(group.shown[0].key, group.items[0].key);
  assert.equal(group.total, 8);
  assert.equal(group.more, 3, "no fake 'N more' -- the exact count");
  // A store far larger than the overlay can draw stays bounded.
  const many = Array.from({ length: 300 }, (_, i) => cardRow(`d-${i}`));
  const big = needsYouGroup(many).group;
  assert.equal(big.items.length, 40, "the overlay never builds the whole store");
  assert.equal(big.total, 300);
  assert.equal(big.more, 295);
});

test("a credential card says so, and a recommendation comes through", () => {
  const { items } = needsYouGroup([
    cardRow("d-c", { kind: "credential", needsYou: true, summary: "Proton Bridge", options: [
      { index: 1, key: "paste", label: "I pasted it", recommended: true },
      { index: 2, key: "later", label: "Not now" },
    ] }),
  ]);
  assert.match(items[0].subtitle, /credential/);
  assert.match(items[0].subtitle, /2 options/);
  assert.match(items[0].subtitle, /Proton Bridge/);
  assert.equal(items[0].defaultKey, "");
  assert.equal(items[0].options[0].recommended, true);
});

test("no open cards is no group at all, never an empty heading", () => {
  assert.equal(needsYouGroup([]).group, null);
  assert.equal(needsYouGroup(null).group, null);
  assert.equal(needsYouGroup([{ title: "no id" }]).group, null);
});
