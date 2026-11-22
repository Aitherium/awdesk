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

test("trayRows: '&' in an agent title survives as a native menu label ('&&' draws one '&')", () => {
  const rows = ny.trayRows([
    { ...CRED, id: "d-a", secretName: "", title: "Allow Claude to use: Bash(git add && git commit)" },
    { ...CRED, id: "d-b", secretName: "", title: "A & B" },
    { ...CRED, id: "d-c", secretName: "", title: "plain" },
    { ...CRED, id: "d-d", secretName: "", title: "fourth" },
  ], () => {});
  assert.match(rows[0].label, /git add &&&& git commit/, "a literal && becomes &&&& so it draws &&");
  assert.match(rows[1].label, /A && B/);
  assert.equal(rows[0].label.includes("&&&&"), true);
});

// ── A5: P0 escalation ───────────────────────────────────────────────────────

const P0_CRED = { id: "d-p0cred", title: "Proton Bridge password", kind: "credential", secretName: "proton_bridge_pw" };
const P0_BLOCK = { id: "d-p0block", title: "Push blocked on you", kind: "blocked" };
const P0_URGENT = { id: "d-p0urgent", title: "Fleet is down", kind: "decision", urgency: "critical", options: [{ key: "a", label: "Fix it" }] };

test("isP0: credential / blocked / explicit blocking / high-critical; an info report never yells", () => {
  assert.equal(ny.isP0(P0_CRED), true);
  assert.equal(ny.isP0(P0_BLOCK), true);
  assert.equal(ny.isP0(P0_URGENT), true);
  assert.equal(ny.isP0({ id: "d-b", kind: "decision", blocking: true }), true);
  assert.equal(ny.isP0({ id: "d-n", kind: "decision", urgency: "normal", options: [{ key: "a" }] }), false);
  assert.equal(ny.isP0({ id: "d-i", kind: "info", urgency: "critical" }), false, "kind=info is a report whatever its urgency");
  assert.equal(ny.isP0(null), false);
  assert.equal(ny.isP0("d-x"), false);
});

test("p0Line is one ask, the secret (never a path) quoted verbatim", () => {
  assert.equal(ny.p0Line(P0_CRED), "Aither needs you now: a secret only you can give: proton_bridge_pw");
  assert.equal(ny.p0Line(P0_BLOCK), "Aither needs you now: Push blocked on you");
  assert.ok(ny.p0Line({ id: "d-long", title: "x".repeat(400) }).length <= 160);
});

test("p0AnnouncementPlan: muted still captions and never asks for audio; the A1 toast only when present", () => {
  assert.deepEqual(ny.p0AnnouncementPlan({ card: P0_CRED, muted: false, hasToast: true }),
    { caption: true, speak: true, toast: true, preempt: true });
  assert.deepEqual(ny.p0AnnouncementPlan({ card: P0_CRED, muted: true, hasToast: false }),
    { caption: true, speak: false, toast: false, preempt: true });
  const mutedWithToast = ny.p0AnnouncementPlan({ card: P0_BLOCK, muted: true, hasToast: true });
  assert.equal(mutedWithToast.caption, true, "a muted P0 is still readable");
  assert.equal(mutedWithToast.speak, false, "the owner's mute stands -- no audio");
  assert.equal(mutedWithToast.toast, true, "the A1 path carries it when it exists");
  assert.deepEqual(ny.p0AnnouncementPlan({ card: { id: "d-n", kind: "decision" }, muted: false, hasToast: true }),
    { caption: false, speak: false, toast: false, preempt: false }, "a non-P0 is never escalated");
});

test("createP0Claims: a P0 is spoken exactly once per card id, and a restart does not re-shout it", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "needs-you-p0-"));
  const spoken = [];
  const polls = [[P0_CRED], [P0_CRED], [P0_CRED, P0_BLOCK], [P0_CRED, P0_BLOCK]];
  const claims = ny.createP0Claims({ dir, now: () => 1_000 });
  for (const cards of polls) {
    for (const card of cards) if (ny.isP0(card) && claims.claim(card.id)) spoken.push(card.id);
  }
  assert.deepEqual(spoken, ["d-p0cred", "d-p0block"], "one line per card id, however many polls repeat it");
  const afterRestart = ny.createP0Claims({ dir, now: () => 2_000 });
  assert.equal(afterRestart.claim("d-p0cred"), false, "the ledger survives a restart");
  assert.equal(afterRestart.claim("d-p0block"), false);
  assert.equal(afterRestart.claim("d-p0new"), true);
  assert.equal(afterRestart.claim("../escape"), false, "only card ids are recorded");
  assert.equal(afterRestart.claim(""), false);
  // In-memory (no dir) is still once per process.
  const mem = ny.createP0Claims();
  assert.equal(mem.claim("d-a"), true);
  assert.equal(mem.claim("d-a"), false);
});
