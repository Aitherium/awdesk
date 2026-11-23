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
  // A session stopped on a card whose own fallback is to stay stopped ("Wait"): top.
  assert.equal(fa.importance(card({ kind: "blocked", blocking: true }), NOW), 3);
  // Stopped, but the card suggests the answer that lets it go on: it matters, no more.
  assert.equal(fa.importance(card({ kind: "blocked", blocking: true, defaultKey: "cut" }), NOW), 2);
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
  assert.equal(d.level, fa.LEVEL.INSIST, "stopped work that defaults to waiting insists");
  assert.equal(d.more, 1, "the report is not counted as waiting");
});

test("the global gap holds a second nudge; a new important card may cut it short", () => {
  const cards = [card({ id: "d-aaaa" })];
  assert.equal(fa.plan(cards, {}, { nowMs: NOW, lastNudgeAt: NOW - 60_000 }).act, "none");
  // [2026-11-22] a FIRST ASK waits 3 min, not a glow's 15: a never-asked ordinary card
  // waited behind every repeat for hours on the live queue (the turn-taking test below)
  const first = fa.plan(cards, {}, { nowMs: NOW, lastNudgeAt: NOW - 4 * MIN });
  assert.equal(first.act, "nudge", "a first ask waits 3 min");
  assert.equal(first.level, fa.LEVEL.FLUTTER, "and comes to the pointer");
  assert.equal(first.firstAsk, true);
  // a REPEAT of a card that does not climb (a day-old ask) is still a glow and still waits 15 min
  const old = [card({ id: "d-olda", createdAt: sec(NOW - 30 * 60 * MIN) })];
  const asked = { "d-olda": fa.recordShown({}, NOW - 60 * MIN) };
  assert.equal(fa.plan(old, asked, { nowMs: NOW, lastNudgeAt: NOW - 10 * MIN }).act, "none", "a glow waits 15 min");
  const glow = fa.plan(old, asked, { nowMs: NOW, lastNudgeAt: NOW - 16 * MIN });
  assert.equal(glow.act, "nudge");
  assert.equal(glow.level, fa.LEVEL.GLOW);
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

test("voice is a FIRST ASK or the REPEAT at insist level, and paced", () => {
  const cards = [card({ id: "d-aaaa", deadline: sec(NOW + 10 * MIN) })];
  // [2026-11-22] a first ask is spoken (replayed on the live queue the fairy said nothing in 3 h) ...
  assert.equal(fa.plan(cards, {}, { nowMs: NOW }).voice, true, "a first ask is spoken");
  // ... but never closer than the voice gap
  assert.equal(fa.plan(cards, {}, { nowMs: NOW, lastVoiceAt: NOW - MIN }).voice, false, "paced by the voice gap");
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

test("the fairy summary says what each answer DOES, never repeating the title", () => {
  const c = card({
    title: "Owner terminal wants to send outside the fleet to 127.0.0.1:8182/mcp (G5)",
    options: [
      { key: "deny", label: "Deny", consequence: "The call stays blocked; the agent is told no." },
      { key: "approve", label: "Approve this one", consequence: "This exact call runs once for this session." },
    ],
  });
  assert.equal(fa.fairySummary(c),
    "Deny — The call stays blocked; Approve this one — This exact call runs once for this session.");
});

test("a consequence that only repeats its label is never printed twice", () => {
  // The owner's exact card (screenshot 2026-11-23 07:28).
  const repeated = card({
    title: "Restore Jason's administrator view in GargBot: add role workspace_admin to user jason",
    options: [
      { key: "done", label: "Done: I added workspace_admin to jason", consequence: "Done: I added workspace_admin to jason" },
      { key: "cannot", label: "I cannot find the page or it refuses me", consequence: "I cannot find the page or it refuses me" },
    ],
  });
  assert.equal(fa.fairySummary(repeated), "", "nothing the title does not already say: say nothing");
  // One repeated option and one that adds a fact: only the distinct one prints.
  const mixed = card({
    title: "Restore Jason's administrator view in GargBot",
    options: [
      { key: "done", label: "Done: I added workspace_admin to jason", consequence: "Done: I added workspace_admin to jason" },
      { key: "deny", label: "Deny", consequence: "Jason stays a plain member." },
    ],
  });
  assert.equal(fa.fairySummary(mixed), "Deny — Jason stays a plain member.");
});

test("the whisper never clips the title and carries the summary above the buttons", () => {
  const long = "Owner terminal wants to send outside the fleet to 127.0.0.1:8182/mcp (G5)";
  const view = fa.whisperView({
    card: card({ title: long, options: [
      { key: "deny", label: "Deny", consequence: "The call stays blocked." },
      { key: "ok", label: "Approve", consequence: "This call runs once." },
    ] }),
    level: 1,
  }, NOW);
  assert.equal(view.title, long, "the full title, never a 110-char cut");
  assert.equal(view.fairy, "Deny — The call stays blocked; Approve — This call runs once.");
  const cred = fa.whisperView({ card: card({ kind: "credential", title: "A secret" }), level: 1 }, NOW);
  assert.equal(cred.fairy, "It needs a secret; open it to enter it.", "a credential card says only that");
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

// ── an ignored card gets louder, never silent (owner, 2026-11-12, d-qabc) ────

/** The card he missed: a session stopped on a permission ask whose default is Deny. */
function qabc(over = {}) {
  return card({
    id: "d-qabc", kind: "blocked", urgency: "high", blocking: false,
    title: "Allow Claude to use: Bash(sync_worktree_clean_to_develop.py)",
    options: [{ key: "grant", label: "Grant this one rule" }, { key: "deny", label: "Deny" }],
    defaultKey: "deny", createdAt: sec(NOW - 2 * MIN), ...over,
  });
}

test("stopped work whose default is to hold ranks first, over a louder-looking backlog", () => {
  assert.equal(fa.holdsWork(qabc()), true);
  assert.equal(fa.holdsWork(qabc({ defaultKey: "grant" })), false, "its suggestion lets the work go on");
  assert.equal(fa.holdsWork(card({ defaultKey: "wait" })), false, "nobody is stopped on an ordinary ask");
  assert.equal(fa.holdsWork(qabc({ options: [{ key: "ack", label: "Noted" }] })), false, "a report holds nothing");
  const backlog = [];
  for (let i = 0; i < 30; i += 1) backlog.push(card({ id: `d-b${String(i).padStart(3, "0")}`, urgency: "critical", defaultKey: "cut" }));
  const d = fa.plan([...backlog, qabc()], {}, { nowMs: NOW });
  assert.equal(d.card.id, "d-qabc");
  assert.equal(d.level, fa.LEVEL.INSIST);
  assert.equal(d.hold, true);
});

test("d-qabc replay: ignored once, it comes back in 5 minutes, at the pointer, spoken, before any card never nudged", () => {
  // 36 cards wait, as on 2026-11-12. The old order nudged each of them once before any repeat.
  const others = [];
  for (let i = 0; i < 35; i += 1) others.push(card({ id: `d-o${String(i).padStart(3, "0")}`, urgency: "high", createdAt: sec(NOW - 3 * 60 * MIN) }));
  const cards = [...others, qabc()];
  let mems = {};
  let lastNudgeAt = 0;
  let lastVoiceAt = NOW - 3 * 60 * MIN;
  const first = fa.plan(cards, mems, { nowMs: NOW, lastNudgeAt, lastVoiceAt });
  assert.equal(first.card.id, "d-qabc");
  mems["d-qabc"] = fa.recordIgnored(fa.recordShown({}, NOW), { importance: first.importance, nowMs: NOW, climbs: first.climbs });
  lastNudgeAt = NOW;
  assert.equal(mems["d-qabc"].ignored, 1);
  assert.equal(mems["d-qabc"].snoozeUntil, undefined, "an ignored card is never put off by the fairy");
  // In between, the rest of the queue takes its turns; d-qabc is not due yet.
  const between = fa.plan(cards, mems, { nowMs: NOW + 2 * MIN, lastNudgeAt, lastVoiceAt });
  assert.notEqual(between.card && between.card.id, "d-qabc");
  if (between.act === "nudge") {
    mems[between.card.id] = fa.recordIgnored(fa.recordShown({}, NOW + 2 * MIN), { importance: between.importance, nowMs: NOW + 2 * MIN, climbs: between.climbs });
    lastNudgeAt = NOW + 2 * MIN;
  }
  const again = fa.plan(cards, mems, { nowMs: NOW + 5 * MIN + 1000, lastNudgeAt, lastVoiceAt });
  assert.equal(again.act, "nudge");
  assert.equal(again.card.id, "d-qabc", "the repeat outranks 34 cards that were never nudged");
  assert.equal(again.level, fa.LEVEL.INSIST, "the fairy flies to the pointer and insists");
  assert.equal(again.voice, true, "and reads it aloud");
  assert.equal(again.lead, "Still waiting on you");
});

test("an ordinary ask ignored once comes back as a flutter at the pointer, and keeps coming", () => {
  const ask = card({ id: "d-ask1", defaultKey: "cut", createdAt: sec(NOW - 5 * MIN) });
  assert.equal(fa.importance(ask, NOW), 1);
  assert.equal(fa.climbs(ask, NOW), true);
  // Its FIRST nudge is an arrival (raised 5 min ago, never shown): fluttered and
  // spoken whatever its urgency (2026-11-15). The ladder below starts after it.
  const first = fa.plan([ask], {}, { nowMs: NOW });
  assert.equal(first.level, fa.LEVEL.FLUTTER);
  assert.equal(first.arrival, true);
  assert.equal(first.voice, true);
  let mem = fa.recordIgnored(fa.recordShown({}, NOW), { importance: 1, nowMs: NOW, climbs: first.climbs });
  assert.equal(fa.plan([ask], { "d-ask1": mem }, { nowMs: NOW + 9 * MIN, lastNudgeAt: NOW }).act, "none");
  const second = fa.plan([ask], { "d-ask1": mem }, { nowMs: NOW + 10 * MIN + 1000, lastNudgeAt: NOW });
  assert.equal(second.act, "nudge");
  assert.equal(second.level, fa.LEVEL.FLUTTER, "the second nudge leaves the corner");
  // Ignored again and again: it never rests on its own, and never passes the flutter.
  let at = NOW + 10 * MIN + 1000;
  for (let i = 0; i < 6; i += 1) {
    mem = fa.recordIgnored(fa.recordShown(mem, at), { importance: 1, nowMs: at, climbs: true });
    at += 10 * MIN + 1000;
    const d = fa.plan([ask], { "d-ask1": mem }, { nowMs: at, lastNudgeAt: at - 10 * MIN - 1000 });
    assert.equal(d.act, "nudge", `repeat ${i + 3} still comes`);
    assert.equal(d.level, fa.LEVEL.FLUTTER);
  }
  assert.equal(mem.snoozeUntil, undefined);
});

test("only the owner puts a card off: Later snoozes it, Stop nudging silences it", () => {
  const cards = [qabc()];
  const later = fa.recordLater(fa.recordShown({}, NOW), NOW);
  assert.equal(fa.plan(cards, { "d-qabc": later }, { nowMs: NOW + 30 * MIN }).act, "none", "Later is respected");
  assert.equal(fa.plan(cards, { "d-qabc": later }, { nowMs: NOW + 61 * MIN }).act, "nudge", "and it comes back");
  assert.equal(fa.plan(cards, { "d-qabc": fa.recordMute({}) }, { nowMs: NOW + 61 * MIN }).act, "none");
});

test("the noise of 2026-11-10 stays quiet: a no-op suggestion and a day-old ask do not climb, and rest", () => {
  const skip = card({ id: "d-skip", options: [{ key: "run", label: "Run it" }, { key: "skip", label: "Skip" }], defaultKey: "skip" });
  const old = card({ id: "d-old1", defaultKey: "cut", createdAt: sec(NOW - 30 * 60 * MIN) });
  for (const c of [skip, old]) {
    assert.equal(fa.climbs(c, NOW), false, c.id);
    assert.equal(fa.plan([c], { [c.id]: { ignored: 2, lastNudgeAt: NOW - 60 * MIN } }, { nowMs: NOW }).level, fa.LEVEL.GLOW, c.id);
    let mem = {};
    for (let i = 0; i < 3; i += 1) mem = fa.recordIgnored(mem, { importance: 1, nowMs: NOW, climbs: false });
    assert.ok(mem.snoozeUntil > NOW, `${c.id} rests`);
  }
});

// ── arrivals + backlog triage (owner 2026-11-15: "fairies are still not getting my
// attention to answer these decision cards") ─────────────────────────────────

test("a NEW low/normal card among a 40-card backlog is nudged first, fluttered and spoken", () => {
  const backlog = [];
  for (let i = 0; i < 40; i += 1) {
    backlog.push(card({ id: `d-old${i}`, urgency: i % 3 ? "high" : "normal", createdAt: sec(NOW - (3 + i) * 24 * 60 * MIN) }));
  }
  for (let i = 0; i < 3; i += 1) backlog.push(card({ id: `d-day${i}`, urgency: "high", createdAt: sec(NOW - 5 * 60 * MIN) }));
  const fresh = card({ id: "d-new", urgency: "low", createdAt: sec(NOW - 2 * MIN) });
  const d = fa.plan([...backlog, fresh], {}, { nowMs: NOW, lastNudgeAt: NOW - 60_000 });
  assert.equal(d.act, "nudge");
  assert.equal(d.card.id, "d-new", "the arrival wins over 43 waiting cards");
  assert.equal(d.arrival, true);
  assert.equal(d.level, fa.LEVEL.FLUTTER, "flies to the pointer even at urgency low");
  assert.equal(d.voice, true, "the fairy speaks it");
  assert.equal(d.needNow, 4, "the 3 day-old cards + the new one need you now");
  assert.equal(d.older, 40, "the 40 multi-day cards are folded into 'older'");
  assert.equal(d.mentionOlder, true, "the older pile is mentioned once");
  const line = fa.arrivalLine(d.card, d);
  assert.match(line, /Cut Aither Android 0\.4\.4 release\?/);
  assert.match(line, /I suggest Wait\./);
  assert.match(line, /Say option one or two, or later\./);
  assert.match(line, /3 more need you after this\./);
  assert.match(line, /40 older cards are on the list/);
  const again = fa.plan([...backlog, fresh], {}, { nowMs: NOW, lastNudgeAt: NOW - 60_000, olderMentionedAt: NOW - 60 * MIN });
  assert.equal(again.mentionOlder, false, "and not again the same day");
});

test("the same card is not an arrival twice: shown once, persisted, no re-pop after a restart", () => {
  const fresh = card({ id: "d-new", createdAt: sec(NOW - 2 * MIN) });
  const first = fa.plan([fresh], {}, { nowMs: NOW });
  assert.equal(first.arrival, true);
  const mems = { "d-new": fa.recordShown({}, NOW) };
  // A desk restart reloads the memory file (sanitizeMems) -- the card is no arrival.
  const reloaded = fa.sanitizeMems(JSON.parse(JSON.stringify(mems)));
  assert.equal(fa.isArrival(fresh, reloaded["d-new"], NOW + 30_000), false);
  const next = fa.plan([fresh], reloaded, { nowMs: NOW + 30_000, lastNudgeAt: NOW });
  assert.equal(next.act, "none", "no repeat seconds later");
  // A card raised before the restart and never shown is not "new" an hour later.
  const old = card({ id: "d-hour", createdAt: sec(NOW - 60 * MIN) });
  assert.equal(fa.isArrival(old, {}, NOW), false);
  // A report ("Noted") never arrives loudly; a muted card never arrives.
  assert.equal(fa.isArrival(card({ options: [{ key: "ack", label: "Noted" }], createdAt: sec(NOW) }), {}, NOW), false);
  assert.equal(fa.isArrival(fresh, { muted: true }, NOW), false);
});

test("a high-urgency card ignored is re-nudged within 30 min until answered", () => {
  const hi = card({ id: "d-hi", urgency: "high", createdAt: sec(NOW - 3 * 60 * MIN) });
  let mem = {};
  let at = NOW;
  for (let i = 0; i < 6; i += 1) {
    const d = fa.plan([hi], { "d-hi": mem }, { nowMs: at, lastNudgeAt: at - 30 * MIN });
    assert.equal(d.act, "nudge", `nudge ${i + 1} comes`);
    mem = fa.recordIgnored(fa.recordShown(mem, at), { importance: d.importance, nowMs: at, climbs: d.climbs });
    at += 30 * MIN;
  }
});

test("held in a game / full screen: the arrival waits, it is never dropped", () => {
  const fresh = card({ id: "d-new", createdAt: sec(NOW - 1 * MIN) });
  assert.equal(fa.plan([fresh], {}, { nowMs: NOW, quiet: "game on" }).act, "none");
  assert.equal(fa.plan([fresh], {}, { nowMs: NOW + 60_000 }).card.id, "d-new");
});

test("the whisper header folds the backlog: 'N more need you · M older'", () => {
  assert.equal(fa.backlogLabel(3, 38), "3 more need you · 38 older");
  assert.equal(fa.backlogLabel(1, 0), "1 more needs you");
  assert.equal(fa.backlogLabel(0, 5), "5 older");
  const v = fa.whisperView({ card: card(), level: 2, more: 41, older: 38 }, NOW);
  assert.equal(v.moreLabel, "3 more need you · 38 older");
});

// ── 2026-11-17, card d-yjmc ("Go live: openaw.org"), exactly as awask raised it ──────
const D_YJMC_CARD = {
  id: "d-yjmc", agent: "claude-code", kind: "blocked", urgency: "high",
  sessionId: "bf1f0eee-f1de-444b-9a5e-05dfe7dabd03",
  title: "Go live: openaw.org doesn't resolve because the Cloudflare zone is active but has no DNS records yet. Should I put openaw.org and www.openaw.org live now?",
  options: [
    { key: "tui:type", label: "Open the session", consequence: "opens the session so you can answer it there", recommended: false },
    { key: "later", label: "Not now", consequence: "the session stays blocked; nothing is lost", recommended: false },
  ],
  defaultKey: "later",
  facts: [
    "Claude Code (openaw) is waiting on this question in the terminal.",
    "1. Go live now (Recommended) -- Run go-live.sh: deploy the Worker to openaw.org + www, then run the live checks. It can be undone by removing the custom domains.",
    "2. Placeholder only -- Serve a one-line 'OpenAW: coming Dec 1' page on openaw.org instead of the hub.",
    "3. Hold -- Leave openaw.org dark for now.",
  ],
  createdAt: 1794918981.9725223,
};
const D_YJMC_NOW = 1794918990 * 1000;

test("d-yjmc: the whisper shows the question's real answers, not only Open/Not now", () => {
  const v = fa.whisperView({ card: D_YJMC_CARD, level: 3 }, D_YJMC_NOW);
  assert.deepEqual(v.sessionChoices.map((c) => c.label), ["Go live now (Recommended)", "Placeholder only", "Hold"]);
  assert.equal(v.sessionChoices[0].recommended, true);
  assert.ok(!v.facts.some((f) => /^\d\. /.test(f)), "the choices are not repeated as hidden facts");
});

test("d-yjmc: a stopped session's question never suggests the no-op 'Not now'", () => {
  const why = fa.whyNow(D_YJMC_CARD, D_YJMC_NOW);
  assert.doesNotMatch(why, /Not now/);
  assert.match(why, /suggested: “Go live now \(Recommended\)” in the session/);
  assert.doesNotMatch(fa.arrivalLine(D_YJMC_CARD), /I suggest Not now/);
  assert.equal(fa.whisperView({ card: D_YJMC_CARD, level: 3 }, D_YJMC_NOW).options.find((o) => o.key === "later").recommended, false);
});

test("d-yjmc: a held ask (ans: keys) suggests its recommended option, not 'Not now'", () => {
  const hold = { ...D_YJMC_CARD, id: "d-qhc6", facts: [],
    options: [
      { key: "ans:1", label: "Go live now (Recommended)", recommended: true },
      { key: "ans:2", label: "Placeholder only" }, { key: "ans:3", label: "Hold" },
      { key: "ans:type", label: "Answer in the terminal" }, { key: "later", label: "Not now" },
    ] };
  assert.match(fa.whyNow(hold, D_YJMC_NOW), /suggested: “Go live now \(Recommended\)”$/);
  assert.deepEqual(fa.sessionChoices(hold), [], "a card that CAN answer lists buttons, not a read-only list");
  assert.deepEqual(fa.whisperView({ card: hold, level: 3 }, D_YJMC_NOW).options.slice(0, 3).map((o) => o.key), ["ans:1", "ans:2", "ans:3"]);
});

test("a blocked card with only a hold default suggests nothing; a real default still shows", () => {
  const holdOnly = { ...D_YJMC_CARD, facts: [] };
  assert.equal(fa.suggestedOption(holdOnly), null);
  const real = { id: "d-real", kind: "decision", options: [{ key: "go", label: "Go" }, { key: "stay", label: "Stay" }], defaultKey: "go", createdAt: 1794918981 };
  assert.deepEqual(fa.suggestedOption(real), { label: "Go", inSession: false });
});

// ── first asks and repeats take turns (2026-11-22) ──────────────────────────

test("a backlog is asked through while ignored cards keep repeating: neither starves the other", () => {
  // The live queue of 2026-11-22 in small: two cards the owner keeps ignoring, and a
  // dozen ordinary asks, hours old, that have never been nudged. Before: 36 nudges in
  // three hours, 18 + 18 on the two, none on the rest.
  const cards = [
    card({ id: "d-hog1", createdAt: sec(NOW - 40 * MIN) }),
    card({ id: "d-hog2", createdAt: sec(NOW - 50 * MIN) }),
  ];
  for (let i = 0; i < 12; i += 1) cards.push(card({ id: `d-w${String(i).padStart(3, "0")}`, createdAt: sec(NOW - (3 + i) * 60 * MIN) }));
  let mems = {
    "d-hog1": { lastNudgeAt: NOW - 11 * MIN, nudges: 5, ignored: 5 },
    "d-hog2": { lastNudgeAt: NOW - 16 * MIN, nudges: 2, ignored: 2 },
  };
  let lastNudgeAt = NOW - 11 * MIN, lastVoiceAt = 0;
  const got = {}, levels = {}, order = [];
  let spoken = 0;
  for (let t = NOW; t < NOW + 120 * MIN; t += 20_000) {
    const p = fa.plan(cards, mems, { nowMs: t, lastNudgeAt, lastVoiceAt, idleMs: 0 });
    if (p.act !== "nudge") continue;
    const id = p.card.id;
    got[id] = (got[id] || 0) + 1; order.push(id);
    if (!(id in levels)) levels[id] = p.level;
    if (p.voice) { spoken += 1; lastVoiceAt = t; }
    lastNudgeAt = t;
    mems = { ...mems, [id]: fa.recordIgnored(fa.recordShown(mems[id] || {}, t), { importance: p.importance, nowMs: t + p.showMs, climbs: p.climbs }) };
  }
  const waiting = cards.slice(2).map((c) => c.id);
  assert.deepEqual(waiting.filter((id) => !got[id]), [], "every never-asked card was asked within two hours");
  for (const id of waiting) assert.ok(levels[id] >= fa.LEVEL.FLUTTER, `${id}'s first ask came to the pointer`);
  assert.ok(got["d-hog1"] >= 3 && got["d-hog2"] >= 3, "the ignored cards still repeat (2026-11-12: a repeat is never starved)");
  // while the backlog is still being asked through, no card takes more than a third of the nudges
  // (once it is drained the two ignored cards are the only ones left and repeat on their own interval)
  const lastFirst = order.reduce((at, id, i) => (id.startsWith("d-w") ? i : at), -1);
  const during = order.slice(0, lastFirst + 1), share = {};
  for (const id of during) share[id] = (share[id] || 0) + 1;
  assert.ok(Math.max(...Object.values(share)) <= during.length / 3, `no card hogs the backlog's slots (${JSON.stringify(share)} of ${during.length})`);
  // three first asks, then a repeat, while both kinds wait
  const head = order.slice(0, 8).map((id) => (id.startsWith("d-w") ? "F" : "R")).join("");
  assert.match(head, /^(F{1,3}R){2}/, `first asks and repeats take turns (${head})`);
  assert.ok(spoken >= 6, `the fairy spoke (${spoken} times in two hours, never closer than the voice gap)`);
});

test("one kind waiting alone takes every slot", () => {
  // only repeats: nothing waits for a first ask that is not there
  const cards = [card({ id: "d-aaaa", createdAt: sec(NOW - 30 * MIN) })];
  const mems = { "d-aaaa": { lastNudgeAt: NOW - 11 * MIN, nudges: 1, ignored: 1 } };
  assert.equal(fa.plan(cards, mems, { nowMs: NOW, lastNudgeAt: NOW - 11 * MIN }).act, "nudge");
  // only first asks: three in a row do not stall waiting for a repeat
  const fresh = [0, 1, 2, 3].map((i) => card({ id: `d-f${i}`, createdAt: sec(NOW - (2 + i) * 60 * MIN) }));
  const asked = { "d-f0": fa.recordShown({}, NOW - 12 * MIN), "d-f1": fa.recordShown({}, NOW - 8 * MIN), "d-f2": fa.recordShown({}, NOW - 4 * MIN) };
  const p = fa.plan(fresh, asked, { nowMs: NOW, lastNudgeAt: NOW - 4 * MIN });
  assert.equal(p.act, "nudge");
  assert.equal(p.card.id, "d-f3", "the fourth never-asked card is asked, not held for a repeat that is not due");
});
