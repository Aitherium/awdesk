"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const ny = require("./needs-you.cjs");
const { badgeBitmap, badgeLabel, badgeTooltip } = require("./badge.cjs");

const CRED = {
  id: "d-nwh4",
  title: "Proton Bridge password",
  kind: "credential",
  secretName: "proton_bridge_pw",
  agent: "claude-code",
  branch: "develop",
  sessionId: "0e0031f6-3b7e-4b1d",
};

test("askLine names the secret and who asked, never more than the tray can hold", () => {
  assert.equal(ny.askLine(CRED), "Secret needed: proton_bridge_pw (from claude-code · develop · session 0e0031f6)");
  assert.equal(ny.askLine({ id: "d-b", title: "Push blocked on you", kind: "blocked" }), "Needs you: Push blocked on you");
  assert.ok(ny.askLine({ ...CRED, secretName: "x".repeat(300) }).length <= 110);
});

test("trayRows: row 0 is the ask and a click opens THAT card; empty list = no rows", () => {
  const opened = [];
  const rows = ny.trayRows([CRED], (id) => opened.push(id));
  assert.match(rows[0].label, /^Secret needed: proton_bridge_pw/);
  rows[0].click();
  assert.deepEqual(opened, ["d-nwh4"]);
  assert.equal(rows[rows.length - 1].type, "separator");
  assert.deepEqual(ny.trayRows([], () => {}), []);
  const many = ny.trayRows([1, 2, 3, 4, 5].map((i) => ({ ...CRED, id: `d-${i}` })), () => {});
  assert.equal(many.length, 5, "three asks, '+2 more', separator -- a flood cannot bury the menu");
});

test("voiceLine leads with needsYou[0], backlog or not", () => {
  const prs = [{ id: "d-pr", title: "Review PR" }, CRED];
  assert.match(ny.voiceLine([CRED], prs, true), /^Aither needs you: a secret only you can give: proton_bridge_pw\. 1 other decision wait/);
  assert.match(ny.voiceLine([], prs, true), /You have 2 decisions waiting\. First up: Review PR/);
});

test("respeakDue: hourly, never while muted, never with nothing waiting", () => {
  const now = 10 * 3600_000;
  assert.equal(ny.respeakDue({ needsYou: [CRED], lastSpokenAt: now - 3600_000, nowMs: now }), true);
  assert.equal(ny.respeakDue({ needsYou: [CRED], lastSpokenAt: now - 60_000, nowMs: now }), false);
  assert.equal(ny.respeakDue({ needsYou: [CRED], lastSpokenAt: 0, nowMs: now, muted: true }), false);
  assert.equal(ny.respeakDue({ needsYou: [], lastSpokenAt: 0, nowMs: now }), false);
});

test("snooze: 4 h in the desk's own dir, expired rows dropped, junk ids refused", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "needs-you-"));
  const now = 1_000_000;
  ny.snooze(dir, "d-nwh4", now);
  assert.ok(ny.snoozedIds(dir, now + 1).has("d-nwh4"));
  assert.ok(!ny.snoozedIds(dir, now + ny.SNOOZE_MS + 1).has("d-nwh4"), "a snooze runs out");
  fs.writeFileSync(path.join(dir, ny.SNOOZE_FILE), JSON.stringify({ "../etc": now * 10, "d-ok": now * 10 }));
  assert.deepEqual([...ny.snoozedIds(dir, now)], ["d-ok"]);
  fs.writeFileSync(path.join(dir, ny.SNOOZE_FILE), "{garbage");
  assert.equal(ny.snoozedIds(dir, now).size, 0, "an unreadable file snoozes nothing: the strip shows MORE");
});

test("chipHtml escapes the card text and its link is the only door chipTarget accepts", () => {
  const evil = { ...CRED, id: "d-x1", secretName: '<img src=x onerror=alert(1)>' };
  const html = ny.chipHtml([evil, CRED]);
  assert.ok(!html.includes("<img"), "card text is escaped");
  assert.match(html, /aither-needs-you:\/\/open\/d-x1/);
  assert.match(html, /\+1/);
  assert.match(html, /default-src 'none'/, "no script, no remote load");
  assert.equal(ny.chipTarget("aither-needs-you://open/d-x1"), "d-x1");
  assert.equal(ny.chipTarget("https://evil.example/d-x1"), null);
  assert.equal(ny.chipTarget("aither-needs-you://open/..%2F..%2Fx"), null);
});

test("badge: a red KEY replaces the numeral while a secret waits; tooltip names it", () => {
  assert.equal(badgeLabel(5, { key: true }), "key");
  const px = badgeBitmap(0, 16, { key: true });
  assert.ok(px.some((b) => b !== 0), "the key draws even with zero numeric waiting");
  assert.notDeepEqual(badgeBitmap(1, 16, { key: true }), badgeBitmap(1, 16), "key differs from the numeral");
  assert.match(badgeTooltip(3, 5, [CRED]), /^Aither — Secret needed: proton_bridge_pw/);
  assert.equal(badgeTooltip(3, 5), "Aither — 3 decisions waiting · 5 cards in the inbox");
});
