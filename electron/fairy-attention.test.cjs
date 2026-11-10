"use strict";

// fairy-attention.cjs under node --test: the triage (what matters), the ladder
// (ignored nudges earn a louder one, capped by importance), the pacing (one at a
// time, held while quiet or away), the "why now" words and the flutter placement
// that never covers the pointer. Every clock is passed in.

const test = require("node:test");
const assert = require("node:assert/strict");
const fa = require("./fairy-attention.cjs");

const NOW = 1_800_000_000_000;
const MIN = 60_000;
const sec = (ms) => Math.floor(ms / 1000);

function card(over = {}) {
  return {
    id: "d-test",
    title: "Cut Aither Android 0.4.4 release?",
    kind: "decision",
    urgency: "normal",
    createdAt: sec(NOW - 30 * MIN),
    deadline: 0,
    options: [{ key: "cut", label: "Cut 0.4.4 now" }, { key: "wait", label: "Wait" }],
    defaultKey: "wait",
    blocking: false,
    ...over,
  };
}

// ── triage ──────────────────────────────────────────────────────────────────

test("a 'Noted'-only card is a report: badge only, unless critical", () => {
  const report = card({ options: [{ key: "ack", label: "Noted" }] });
  assert.equal(fa.ackOnly(report), true);
  assert.equal(fa.importance(report, NOW), 0);
  assert.equal(fa.importance({ ...report, urgency: "critical" }, NOW), 2);
});

test("blocked and credential cards matter; a stale blocked one stops shouting", () => {
  assert.equal(fa.importance(card({ kind: "blocked", blocking: true }), NOW), 2);
  assert.equal(fa.importance(card({ kind: "credential", options: [] }), NOW), 1);
  const oldBlocked = card({ kind: "blocked", blocking: true, createdAt: sec(NOW - 30 * 60 * MIN) });
  assert.equal(fa.importance(oldBlocked, NOW), 1);
  const ancient = card({ urgency: "high", createdAt: sec(NOW - 6 * 24 * 60 * MIN) });
  assert.equal(fa.importance(ancient, NOW), 0, "a six-day-old ask is the badge only");
});

test("a near deadline lifts a card; inside 30 min it insists", () => {
  assert.equal(fa.importance(card({ deadline: sec(NOW + 90 * MIN) }), NOW), 2);
  assert.equal(fa.importance(card({ deadline: sec(NOW + 20 * MIN) }), NOW), 3);
});

test("a no-op suggestion ('Skip', 'Keep it scheduled') glows at most, deadline or not", () => {
  const skip = card({
    deadline: sec(NOW + 10 * MIN),
    options: [{ key: "share", label: "Share" }, { key: "skip", label: "Skip" }],
    defaultKey: "skip",
  });
  assert.equal(fa.noopSuggestion(skip), true);
  assert.equal(fa.importance(skip, NOW), 1, "a 10-min deadline would be 3 -- it is a no-op answer");
  const scheduled = card({
    urgency: "critical",
    deadline: sec(NOW + 40 * MIN),
    options: [{ key: "keep", label: "Keep it scheduled (19 h)" }, { key: "stop", label: "Stop it" }],
    defaultKey: "keep",
  });
  assert.equal(fa.importance(scheduled, NOW), 1);
  const real = card({ deadline: sec(NOW + 10 * MIN), defaultKey: "wait" });
  assert.equal(fa.noopSuggestion(real), false, "a real recommendation is not a no-op");
});

test("keep pins at the top, mute drops to the badge, later comes back louder", () => {
  const c = card();
  assert.equal(fa.importance(c, NOW, fa.recordKeep({})), 3);
  assert.equal(fa.importance(c, NOW, fa.recordMute({})), 0);
  const later = fa.recordLater({}, NOW - 2 * 60 * MIN);
  assert.equal(fa.importance(c, NOW, later), 2, "normal (1) + came back after Later (+1)");
});

// ── the ladder ──────────────────────────────────────────────────────────────

test("ignored nudges escalate one level per two, capped by importance", () => {
  assert.equal(fa.levelFor(0, {}), fa.LEVEL.BADGE);
  assert.equal(fa.levelFor(1, {}), fa.LEVEL.GLOW);
  assert.equal(fa.levelFor(1, { ignored: 10 }), fa.LEVEL.GLOW, "an ordinary card never climbs past the glow");
  assert.equal(fa.levelFor(2, {}), fa.LEVEL.FLUTTER);
  assert.equal(fa.levelFor(2, { ignored: 2 }), fa.LEVEL.INSIST);
  assert.equal(fa.levelFor(3, {}), fa.LEVEL.INSIST);
});

test("an ordinary card RESTS after three ignored glows; an important one climbs", () => {
  let mem = {};
  for (let i = 0; i < 2; i += 1) mem = fa.recordIgnored(mem, { importance: 1, nowMs: NOW });
  assert.equal(mem.ignored, 2);
  mem = fa.recordIgnored(mem, { importance: 1, nowMs: NOW });
  assert.equal(mem.ignored, 0);
  assert.equal(mem.snoozeUntil, NOW + fa.DEFAULTS.restMs);
  assert.equal(fa.importance(card(), NOW + fa.DEFAULTS.restMs + 1, mem), 1, "a rest is not a Later: it does not come back louder");
  let hot = {};
  for (let i = 0; i < 3; i += 1) hot = fa.recordIgnored(hot, { importance: 2, nowMs: NOW });
  assert.equal(hot.ignored, 3);
  assert.equal(hot.snoozeUntil, undefined);
});

test("a day-old ordinary ask decays to a glow; credentials and critical do not", () => {
  const dayOld = sec(NOW - 30 * 60 * MIN);
  assert.equal(fa.importance(card({ urgency: "high", createdAt: dayOld }), NOW), 1);
  assert.equal(fa.importance(card({ kind: "credential", urgency: "high", options: [], createdAt: dayOld }), NOW), 2);
  assert.equal(fa.importance(card({ urgency: "critical", createdAt: dayOld }), NOW), 3);
});

// ── pacing ──────────────────────────────────────────────────────────────────

test("quiet, busy and away hold every nudge", () => {
  const cards = [card({ urgency: "high" })];
  assert.equal(fa.plan(cards, {}, { nowMs: NOW, quiet: "Do not disturb" }).act, "none");
  assert.equal(fa.plan(cards, {}, { nowMs: NOW, busy: true }).act, "none");
  assert.equal(fa.plan(cards, {}, { nowMs: NOW, idleMs: 3 * MIN }).act, "none");
  assert.equal(fa.plan(cards, {}, { nowMs: NOW }).act, "nudge");
});

test("one card per nudge, the loudest first, the rest ride as +N more", () => {
  const cards = [
    card({ id: "d-aaaa", urgency: "normal" }),
    card({ id: "d-bbbb", kind: "blocked", blocking: true }),
    card({ id: "d-cccc", options: [{ key: "ack", label: "Noted" }] }),
  ];
  const d = fa.plan(cards, {}, { nowMs: NOW });
  assert.equal(d.act, "nudge");
  assert.equal(d.card.id, "d-bbbb");
  assert.equal(d.level, fa.LEVEL.FLUTTER);
  assert.equal(d.more, 1, "the report is not counted as waiting");
});

test("the global gap holds a second nudge; a new important card may cut it short", () => {
  const cards = [card({ id: "d-aaaa" })];
  assert.equal(fa.plan(cards, {}, { nowMs: NOW, lastNudgeAt: NOW - 60_000 }).act, "none");
  assert.equal(fa.plan(cards, {}, { nowMs: NOW, lastNudgeAt: NOW - 10 * MIN }).act, "none", "a glow waits 15 min");
  assert.equal(fa.plan(cards, {}, { nowMs: NOW, lastNudgeAt: NOW - 16 * MIN }).act, "nudge");
  const urgent = [card({ id: "d-bbbb", urgency: "high", createdAt: sec(NOW - 2 * MIN) })];
  assert.equal(fa.plan(urgent, {}, { nowMs: NOW, lastNudgeAt: NOW - 30_000 }).act, "nudge");
});

test("a restart is not an arrival: an old, never-nudged card waits the normal gap", () => {
  const backlog = [card({ id: "d-old1", urgency: "high", createdAt: sec(NOW - 4 * 60 * MIN) })];
  const d = fa.plan(backlog, {}, { nowMs: NOW, lastNudgeAt: NOW - 30_000 });
  assert.equal(d.act, "none", "the backlog does not flutter 20 s apart");
  assert.equal(fa.plan(backlog, {}, { nowMs: NOW, lastNudgeAt: NOW - 6 * MIN }).act, "nudge");
});

test("a card is not re-nudged before its level's interval; coming back from away is", () => {
  const cards = [card({ id: "d-aaaa" })];
  const mems = { "d-aaaa": fa.recordShown({}, NOW - 10 * MIN) };
  assert.equal(fa.plan(cards, mems, { nowMs: NOW }).act, "none");
  const back = fa.plan(cards, mems, { nowMs: NOW, returned: true });
  assert.equal(back.act, "nudge");
  assert.equal(back.lead, "While you were away");
});

test("snoozed cards are skipped until Later runs out", () => {
  const cards = [card({ id: "d-aaaa" })];
  const mems = { "d-aaaa": fa.recordLater({}, NOW - 10 * MIN) };
  assert.equal(fa.plan(cards, mems, { nowMs: NOW }).act, "none");
});

test("voice is the REPEAT at insist level, never the arrival, and paced", () => {
  const cards = [card({ id: "d-aaaa", deadline: sec(NOW + 10 * MIN) })];
  assert.equal(fa.plan(cards, {}, { nowMs: NOW }).voice, false, "arrival is spoken by the desk already");
  const mems = { "d-aaaa": fa.recordShown({}, NOW - 7 * MIN) };
  assert.equal(fa.plan(cards, mems, { nowMs: NOW, lastNudgeAt: NOW - 7 * MIN }).voice, true);
  assert.equal(fa.plan(cards, mems, { nowMs: NOW, lastNudgeAt: NOW - 7 * MIN, lastVoiceAt: NOW - MIN }).voice, false);
});

// ── words ───────────────────────────────────────────────────────────────────

test("why-now names who is stuck, what the deadline picks, and the wait", () => {
  const blocked = card({ kind: "blocked", blocking: true, agent: "Steam publishing", createdAt: sec(NOW - 3 * 60 * MIN) });
  assert.match(fa.whyNow(blocked, NOW), /^Steam publishing is stopped until you answer · waiting 3 h$/);
  const due = card({ deadline: sec(NOW + 100 * MIN), defaultKey: "wait" });
  assert.match(fa.whyNow(due, NOW), /picks “Wait” for you in 2 h/i);
  const cred = card({ kind: "credential", options: [], secretName: "HETZNER_API_KEY" });
  assert.match(fa.whyNow(cred, NOW), /needs HETZNER_API_KEY to keep going/);
});

test("a critical REPORT says it is critical, not what 'Noted' the deadline picks", () => {
  const disk = card({ urgency: "critical", options: [{ key: "ack", label: "Noted" }], defaultKey: "ack",
    deadline: sec(NOW + 8 * 60 * MIN), createdAt: sec(NOW - 4 * 60 * MIN) });
  assert.equal(fa.whyNow(disk, NOW), "Marked critical · waiting 4 h");
});

test("a generic agent name falls back to the tab, then to 'A session'", () => {
  const c = card({ kind: "blocked", blocking: true, agent: "claude-code", tab: "Desktop canvas layout" });
  assert.match(fa.whyNow(c, NOW), /^Desktop canvas layout is stopped/);
  assert.match(fa.whyNow({ ...c, tab: "" }, NOW), /^A session is stopped/);
});

test("the voice line drops the 'Claude Code needs you' prefix", () => {
  const line = fa.voiceLine(card({ title: "Claude Code needs you: AitherOS-Fresh -- Desktop canvas" }), NOW, { more: 2 });
  assert.match(line, /^Hey\. AitherOS-Fresh -- Desktop canvas is still waiting for you\./);
  assert.match(line, /And 2 more after that\.$/);
});

test("the whisper offers the card's OWN options (max 3), none for a credential", () => {
  const d = fa.plan([card()], {}, { nowMs: NOW });
  const view = fa.whisperView(d, NOW);
  assert.deepEqual(view.options.map((o) => o.key), ["cut", "wait"]);
  assert.equal(view.options.find((o) => o.key === "wait").recommended, true);
  const cred = fa.whisperView({ card: card({ kind: "credential" }), level: 1 }, NOW);
  assert.equal(cred.credential, true);
  assert.equal(cred.options.length, 0);
});

// ── memory ──────────────────────────────────────────────────────────────────

test("memory is pruned to open cards and sanitized on load", () => {
  const mems = { "d-aaaa": { nudges: 2 }, "d-gone": { nudges: 9 } };
  assert.deepEqual(Object.keys(fa.pruneMems(mems, ["d-aaaa"])), ["d-aaaa"]);
  const clean = fa.sanitizeMems({ "d-aaaa": { nudges: "3", muted: true, evil: "x" }, "../etc": {} });
  assert.deepEqual(clean, { "d-aaaa": { nudges: 3, muted: true } });
});

// ── placement ───────────────────────────────────────────────────────────────

test("the flutter sits near the pointer and never covers it", () => {
  const area = { x: 0, y: 0, width: 1920, height: 1040 };
  const orb = { width: 72, height: 72 };
  const whisper = { width: 360, height: 150 };
  for (const cursor of [{ x: 960, y: 520 }, { x: 1900, y: 20 }, { x: 10, y: 1030 }, { x: 1900, y: 1030 }]) {
    const p = fa.nudgePlacement(cursor, area, orb, whisper);
    const wbox = { x: p.whisper.x, y: p.whisper.y, width: whisper.width, height: whisper.height };
    const inside = cursor.x >= wbox.x && cursor.x <= wbox.x + wbox.width
      && cursor.y >= wbox.y && cursor.y <= wbox.y + wbox.height;
    assert.equal(inside, false, `whisper covers the pointer at ${JSON.stringify(cursor)}`);
    assert.ok(wbox.x >= area.x && wbox.x + wbox.width <= area.x + area.width, "whisper fits horizontally");
    assert.ok(wbox.y >= area.y && wbox.y + wbox.height <= area.y + area.height, "whisper fits vertically");
    const dist = Math.hypot(p.orb.x - cursor.x, p.orb.y - cursor.y);
    assert.ok(dist >= 60, "the fairy is not on the pointer");
  }
});

test("the flutter offset stays small", () => {
  for (let t = 0; t < 5000; t += 137) {
    const o = fa.flutterOffset(NOW + t, 3);
    assert.ok(Math.abs(o.x) <= 16 && Math.abs(o.y) <= 16);
  }
});

// ── the chime and the chat (2026-11-08) ─────────────────────────────────────

test("the chime grows with the level: silent badge, one soft note, a two-note rise, three louder notes", () => {
  assert.deepEqual(fa.chimePattern(0), []);
  assert.deepEqual(fa.chimePattern(undefined), []);
  const l1 = fa.chimePattern(1);
  const l2 = fa.chimePattern(2);
  const l3 = fa.chimePattern(3);
  assert.equal(l1.length, 1);
  assert.equal(l2.length, 2);
  assert.equal(l3.length, 3);
  assert.ok(l2[1].freq > l2[0].freq && l2[1].at > l2[0].at, "L2 rises, one note after the other");
  assert.ok(l3[2].freq > l3[1].freq && l3[1].freq > l3[0].freq, "L3 rises through three notes");
  const peak = (p) => Math.max(...p.map((n) => n.gain));
  assert.ok(peak(l1) < peak(l2) && peak(l2) < peak(l3), "louder by level");
  assert.ok(peak(l3) <= 0.2, "never loud");
  assert.deepEqual(fa.chimePattern(9), l3, "clamped to the top level");
  l1[0].gain = 1; // a caller mutating its copy cannot change the next chime
  assert.equal(fa.chimePattern(1)[0].gain, 0.05);
});

test("the chat context carries the title, why now, the card's own options with consequences, and the session", () => {
  const card = {
    id: "d-chat1",
    title: "Claude Code needs you: Cut awsh 0.4.4?",
    kind: "decision",
    urgency: "high",
    blocking: true,
    createdAt: NOW / 1000 - 1200,
    tab: "awsh release",
    summary: "The registry push failed twice.",
    defaultKey: "cut",
    options: [
      { key: "cut", label: "Cut it now", consequence: "Publishes 0.4.4 to PyPI" },
      { key: "wait", label: "Wait a day", consequence: "" },
    ],
  };
  const text = fa.chatContext(card, NOW, { session: { ok: true, name: "awsh release", lastAsk: "ship it", lastSaid: "PyPI 403" } });
  assert.match(text, /"Cut awsh 0\.4\.4\?"/);
  assert.doesNotMatch(text, /Claude Code needs you/);
  assert.match(text, /Why it wants an answer now: Awsh release is stopped until you answer/);
  assert.match(text, /1\. Cut it now \(suggested\) -- Publishes 0\.4\.4 to PyPI/);
  assert.match(text, /2\. Wait a day$/m);
  assert.match(text, /registry push failed twice/);
  assert.match(text, /Its last instruction: ship it/);
  assert.match(text, /What it last said: PyPI 403/);
  // a session read that failed adds nothing
  assert.doesNotMatch(fa.chatContext(card, NOW, { session: { ok: false, error: "gone" } }), /last instruction/);
  assert.equal(fa.chatContext(null, NOW), "");
});

test("a credential card's chat context names the secret, lists no options, and says it is never typed in chat", () => {
  const text = fa.chatContext({ id: "d-cred1", title: "Needs a key", kind: "credential", secretName: "PYPI_TOKEN",
    options: [{ key: "x", label: "should not show" }], createdAt: NOW / 1000 }, NOW);
  assert.match(text, /PYPI_TOKEN/);
  assert.match(text, /never in chat/);
  assert.doesNotMatch(text, /should not show/);
});

test("the chat question puts the card first and the owner's words last", () => {
  const q = fa.chatQuestion("CARD CONTEXT", "  what breaks if I wait? ");
  assert.ok(q.startsWith("CARD CONTEXT"));
  assert.ok(q.endsWith("The owner asks: what breaks if I wait?"));
  assert.equal(fa.chatQuestion("", "hi"), "hi", "no card: the question is the owner's own");
});

test("the whisper keeps a long option label whole and shows up to four options", () => {
  const long = "I will run it under my own tenant and relaunch it there tonight";
  const c = card({ options: [1, 2, 3, 4, 5].map((i) => ({ key: `k${i}`, label: i === 1 ? long : `Option ${i}` })) });
  const view = fa.whisperView({ card: c, level: 2 }, NOW);
  assert.equal(view.options[0].label, long);
  assert.equal(view.options.length, 4);
});

// ── owner screenshots 2026-11-09 ────────────────────────────────────────────

test("a consequence that only repeats its label is dropped (case, spacing, punctuation ignored)", () => {
  assert.equal(fa.sameText("Stop all three now", " stop all three now. "), true);
  assert.equal(fa.sameText("Leave them", "Leave them!"), true);
  assert.equal(fa.sameText("Leave them", "Leave them running until morning"), false);
  assert.equal(fa.sameText("", ""), false, "two empties are not a repeat");
  const v = fa.whisperView({ card: card({ options: [
    { key: "stop", label: "Stop all three now", consequence: "Stop all three now" },
    { key: "leave", label: "Leave them", consequence: "leave them." },
    { key: "pause", label: "Pause", consequence: "Pauses the queue for an hour" },
  ] }), level: 1 }, NOW);
  assert.deepEqual(v.options.map((o) => o.consequence), ["", "", "Pauses the queue for an hour"]);
  const ctx = fa.chatContext(card({ options: [{ key: "leave", label: "Leave them", consequence: "Leave them" }] }), NOW);
  assert.doesNotMatch(ctx, /Leave them -- Leave them/);
});

test("a card older than staleMs never whispers on its own, not even after 'keep nudging'", () => {
  const old = card({ id: "d-pix8", urgency: "critical", blocking: true, createdAt: sec(NOW - 22 * 24 * 60 * MIN) });
  const day = card({ id: "d-h33", urgency: "high", createdAt: sec(NOW - 49 * 60 * MIN) });
  assert.equal(fa.isStale(old, NOW), true);
  assert.equal(fa.isStale(card(), NOW), false);
  assert.equal(fa.importance(old, NOW, fa.recordKeep({})), 0, "stale beats keep");
  assert.equal(fa.importance(day, NOW), 0);
  const p = fa.plan([old, day], { "d-pix8": fa.recordKeep({}) }, { nowMs: NOW, returned: true });
  assert.equal(p.act, "none");
});

test("an explicitly opened old card says it is old, with its age in the header", () => {
  const old = card({ createdAt: sec(NOW - 22 * 24 * 60 * MIN) });
  const v = fa.whisperView({ card: old, level: 1, lead: "From Atlas" }, NOW);
  assert.equal(v.old, "Old — still relevant?");
  assert.equal(v.lead, "From Atlas · 22 d old");
  const fresh = fa.whisperView({ card: card(), level: 1, lead: "From Atlas" }, NOW);
  assert.equal(fresh.old, "");
  assert.equal(fresh.lead, "From Atlas");
});

test("the whisper's count is the true count, '99+' past that, never '+99 more'", () => {
  assert.equal(fa.moreLabel(0), "");
  assert.equal(fa.moreLabel(15), "15 more waiting");
  assert.equal(fa.moreLabel(99), "99 more waiting");
  assert.equal(fa.moreLabel(240), "99+ more waiting");
  assert.equal(fa.whisperView({ card: card(), level: 1, more: 15 }, NOW).moreLabel, "15 more waiting");
});
