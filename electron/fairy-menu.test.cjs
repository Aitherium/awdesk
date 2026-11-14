"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const menu = require("./fairy-menu.cjs");

const card = (over = {}) => ({
  id: "d-1",
  title: "Approve the deploy",
  kind: "blocked",
  options: [{ key: "yes", label: "Ship it" }, { key: "no", label: "Hold" }],
  ...over,
});

test("the recommended option: marked first, then default_key; never for a credential", () => {
  assert.equal(menu.recommendedOption(card()), null, "nothing marked, no default: none");
  assert.equal(menu.recommendedOption(card({ default_key: "no" })).key, "no");
  assert.equal(menu.recommendedOption(card({
    default_key: "no", options: [{ key: "yes", label: "Ship it", recommended: true }, { key: "no" }],
  })).key, "yes");
  assert.equal(menu.recommendedOption(card({ kind: "credential", default_key: "yes" })), null);
  assert.equal(menu.recommendedOption(card({ default_key: "gone" })), null, "a default that is not an option");
});

test("snoozes: 1 h, 4 h, and tomorrow at 09:00 local", () => {
  const now = new Date(2026, 10, 12, 16, 30).getTime();
  assert.equal(menu.snoozeUntil("snooze:1h", now), now + 3600_000);
  assert.equal(menu.snoozeUntil("snooze:4h", now), now + 4 * 3600_000);
  const t = new Date(menu.snoozeUntil("snooze:tomorrow", now));
  assert.deepEqual([t.getDate(), t.getHours(), t.getMinutes()], [13, 9, 0]);
  assert.equal(menu.snoozeUntil("open", now), null);
  assert.deepEqual(menu.recordSnooze({ nudges: 2 }, 5), { nudges: 2, snoozeUntil: 5 });
});

test("a fairy's menu: every action the owner asked for, in order, the recommended option named", () => {
  const m = menu.fairyItems(card({ sessionId: "s-1", default_key: "yes" }), { label: "Lyra" });
  assert.equal(m.header, "Lyra · Approve the deploy");
  const ids = m.items.filter((i) => !i.sep).map((i) => i.id);
  assert.deepEqual(ids, ["open", "answer:yes", "snooze:1h", "snooze:4h", "snooze:tomorrow",
    "mute", "dismiss", "session", "copy"]);
  assert.equal(m.items.find((i) => i.id === "answer:yes").label, "Answer: Ship it");
  assert.equal(m.items.some((i) => i.disabled), false);
  const bare = menu.fairyItems(card(), { label: "Atlas" });
  assert.equal(bare.items.find((i) => i.id === "answer").disabled, true);
  assert.equal(bare.items.find((i) => i.id === "session").disabled, true, "no session behind it");
  const presence = menu.fairyItems(null, { label: "Iris", agent: "iris" });
  assert.deepEqual(presence.items.map((i) => i.id), ["talk"]);
});

test("the orb's menu: inbox, answer window, then every companion row, then more -- no dead item", () => {
  const now = 1_000_000;
  const m = menu.orbItems({ waiting: 3, quietUntil: 0, nowMs: now });
  assert.equal(m.header, "Aither · 3 waiting on you");
  assert.deepEqual(m.items.filter((i) => !i.sep).map((i) => i.id), ["inbox", "queue",
    "hide-this", "hide-all", "show-all", "open-desktop", "open-spaces", "open-chat", "settings",
    "quiet-1h", "quiet-4h", "quit", "more"]);
  const quiet = menu.orbItems({ waiting: 0, quietUntil: now + 10, tenantVisible: true, nowMs: now });
  const ids = quiet.items.filter((i) => !i.sep).map((i) => i.id);
  assert.ok(ids.includes("quiet-off") && !ids.includes("quiet-1h"), "quiet: the row ends it");
  assert.ok(!ids.includes("queue"), "nothing waiting: no list to open, so no row");
  assert.ok(!ids.includes("show-all"), "everything shows: no Show all");
  assert.equal(quiet.items.some((i) => i.disabled), false, "never a dead item");
  assert.ok(menu.orbItems({ mutedUntil: now + 10, nowMs: now }).items.some((i) => i.id === "quiet-off"), "the old name still reads");
});

test("a companion fairy's menu ends with the companion rows; the card rows stay first", () => {
  const m = menu.withCompanionRows(menu.fairyItems(card({ sessionId: "s-1" }), { label: "Lyra" }),
    { target: "fairy", fairyVisible: true, nowMs: 0 });
  const ids = m.items.filter((i) => !i.sep).map((i) => i.id);
  assert.equal(ids[0], "open");
  assert.ok(["hide-this", "hide-all", "show-all", "open-desktop", "open-spaces", "open-chat", "settings", "quiet-1h", "quit"]
    .every((id) => ids.includes(id)));
  assert.equal(m.header, "Lyra · Approve the deploy");
});

test("the menu fits its rows and stays on the work area, flipping at the edges", () => {
  const items = menu.fairyItems(card({ sessionId: "s" }), { label: "Lyra" }).items;
  const h = menu.menuHeight(items);
  assert.equal(h, 12 * 2 + 30 + 9 * 34 + 2 * 9);
  const area = { x: 0, y: 0, width: 1920, height: 1080 };
  assert.deepEqual(menu.menuPlacement({ x: 100, y: 100 }, area, { width: 268, height: h }), { x: 108, y: 104 });
  const corner = menu.menuPlacement({ x: 1900, y: 1070 }, area, { width: 268, height: h });
  assert.ok(corner.x + 268 <= 1920 && corner.y + h <= 1080 && corner.x >= 0 && corner.y >= 0);
  assert.ok(corner.x < 1900 && corner.y < 1070, "flipped left and up of the pointer");
});

test("the hover tip is one short line: who and what, never the card body", () => {
  assert.equal(menu.tipText({ label: "Lyra", title: "Approve the deploy", count: 3 }), "Lyra: Approve the deploy (+2)");
  assert.equal(menu.tipText({ agent: "iris", state: "working" }), "iris: working");
  const long = menu.tipText({ label: "Atlas", title: "x".repeat(200) });
  assert.ok(long.length <= menu.TIP_MAX);
  assert.ok(!long.includes("\n"));
  assert.equal(menu.TIP_DWELL_MS, 400);
});

test("copy link: the card's page on Online", () => {
  assert.equal(menu.cardLink("d-abc"), "https://aitherium.com/decide?id=d-abc");
});
