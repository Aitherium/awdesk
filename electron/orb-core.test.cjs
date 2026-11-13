"use strict";

// orb-core.cjs under node --test: the spirit-guide pacing (one line up at a
// time, a hold for its reading time, preemption, pin), the prompt builders,
// the vision-answer interpreter and the failure cards with their remedies, and
// the geometry that keeps the orb and its bubble on the screen.
//
// Every clock is passed in (`now`), so the holds are asserted without a timer.

const test = require("node:test");
const assert = require("node:assert/strict");
const core = require("./orb-core.cjs");

// ── reading time ────────────────────────────────────────────────────────────

test("readingTimeMs scales with words and is bounded at both ends", () => {
  assert.equal(core.readingTimeMs("yes"), core.MIN_HOLD_MS);
  assert.equal(core.readingTimeMs("word ".repeat(2000)), core.MAX_HOLD_MS);
  const short = core.readingTimeMs("The color of the circle in this image is red.");
  const long = core.readingTimeMs("word ".repeat(40));
  assert.ok(short >= core.MIN_HOLD_MS && short <= core.MAX_HOLD_MS);
  assert.ok(long > short, "more words hold longer until the cap");
});

test("an answer of 40 words holds about seven seconds", () => {
  // 1.2 s settle + 40 words at 240 wpm = 10 s of reading + 1.2 s settle.
  const ms = core.readingTimeMs("word ".repeat(40));
  assert.ok(ms >= 9000 && ms <= 12000, `expected ~11s, got ${ms}`);
});

// ── queue: one line at a time ───────────────────────────────────────────────

function at(ms) {
  return 1000 + ms;
}

test("a pushed line shows only on the next tick, one at a time", () => {
  const q = core.createQueue();
  const a = core.push(q, { kind: "answer", text: "First answer" }, at(0));
  assert.ok(a && a.id);
  let t = core.tick(q, at(0));
  assert.equal(t.show && t.show.text, "First answer");
  assert.equal(q.cur.text, "First answer");

  core.push(q, { kind: "answer", text: "Second answer" }, at(100));
  t = core.tick(q, at(200));
  assert.equal(t.show, null, "the first answer is still up");
  assert.equal(t.hide, null);

  t = core.tick(q, at(100 + core.MIN_HOLD_MS));
  assert.equal(t.hide.text, "First answer");
  assert.equal(t.show.text, "Second answer");
});

test("a line leaves after its hold and no line means no hide", () => {
  const q = core.createQueue();
  core.push(q, { kind: "answer", text: "Gone soon", holdMs: 1000 }, at(0));
  core.tick(q, at(0));
  assert.equal(core.tick(q, at(999)).hide, null);
  const t = core.tick(q, at(1000));
  assert.equal(t.hide.text, "Gone soon");
  assert.equal(t.show, null);
  assert.equal(q.cur, null);
});

test("identical answers do not queue twice, nor repeat what is up", () => {
  const q = core.createQueue();
  assert.ok(core.push(q, { kind: "answer", text: "Same" }, at(0)));
  assert.equal(core.push(q, { kind: "answer", text: "Same" }, at(1)), null);
  core.tick(q, at(0));
  assert.equal(core.push(q, { kind: "answer", text: "Same" }, at(2)), null);
});

test("an error preempts a quiet answer, and the answer goes back in the queue", () => {
  const q = core.createQueue();
  core.push(q, { kind: "answer", text: "A long answer", holdMs: 60000 }, at(0));
  core.tick(q, at(0));
  core.push(q, { kind: "error", text: "Vision could not answer" }, at(10));
  const t = core.tick(q, at(20));
  assert.equal(t.hide.text, "A long answer");
  assert.equal(t.show.kind, "error");
  // ...and the answer was not lost.
  const later = core.tick(q, at(20 + core.HOLD_MS.error));
  assert.equal(later.show.text, "A long answer");
});

test("two answers of equal urgency keep their order (no endless preemption)", () => {
  const q = core.createQueue();
  core.push(q, { kind: "answer", text: "Answer one", holdMs: 60000 }, at(0));
  core.tick(q, at(0));
  core.push(q, { kind: "answer", text: "Answer two" }, at(10));
  const t = core.tick(q, at(20));
  assert.equal(t.show, null);
  assert.equal(q.cur.text, "Answer one");
});

test("a new status replaces the old status and never queues behind an answer", () => {
  const q = core.createQueue();
  core.push(q, { kind: "status", text: "Looking at your screen" }, at(0));
  assert.equal(q.items.length, 1);
  core.push(q, { kind: "status", text: "Looking at the region" }, at(1));
  assert.equal(q.items.length, 1);
  assert.equal(q.items[0].text, "Looking at the region");
});

test("a stale status is dropped rather than shown later", () => {
  const q = core.createQueue({ chatty: false });
  core.push(q, { kind: "status", text: "Looking at your screen" }, at(0));
  const t = core.tick(q, at(core.STATUS_TTL_MS + 1));
  assert.equal(t.show, null);
  assert.equal(q.items.length, 0);
});

test("pin holds a line past its reading time; unpin resumes the countdown", () => {
  const q = core.createQueue();
  core.push(q, { kind: "answer", text: "Pinned answer", holdMs: 1000 }, at(0));
  const shown = core.tick(q, at(0)).show;
  const pin = core.setPinned(q, shown.id, true, at(100));
  assert.equal(pin.ok, true);
  assert.equal(core.tick(q, at(99999)).hide, null, "a pinned line never expires");
  assert.equal(core.setPinned(q, shown.id, false, at(100000)).ok, true);
  assert.equal(core.tick(q, at(101001)).hide.text, "Pinned answer");
});

test("pinning a line that is gone says so instead of lying", () => {
  const q = core.createQueue();
  const r = core.setPinned(q, "orb-missing", true, at(0));
  assert.equal(r.ok, false);
  assert.match(r.reason, /no longer up/);
});

test("clear empties the queue and reports what was up", () => {
  const q = core.createQueue();
  core.push(q, { kind: "answer", text: "Up" }, at(0));
  core.tick(q, at(0));
  core.push(q, { kind: "answer", text: "Waiting" }, at(1));
  const r = core.clear(q);
  assert.equal(r.had, true);
  assert.equal(r.hide.text, "Up");
  assert.equal(q.items.length, 0);
  assert.equal(q.cur, null);
});

test("the queue is bounded and drops the oldest unpinned line", () => {
  const q = core.createQueue({ max: 3 });
  for (let i = 0; i < 6; i += 1) core.push(q, { kind: "answer", text: `Line ${i}` }, at(i));
  assert.equal(q.items.length, 3);
  assert.deepEqual(q.items.map((x) => x.text), ["Line 3", "Line 4", "Line 5"]);
});

test("a pinned line survives the bound", () => {
  const q = core.createQueue({ max: 2 });
  core.push(q, { kind: "answer", text: "Keep me", pinned: true }, at(0));
  core.push(q, { kind: "answer", text: "Drop me" }, at(1));
  core.push(q, { kind: "answer", text: "New one" }, at(2));
  assert.deepEqual(q.items.map((x) => x.text), ["Keep me", "New one"]);
});

test("queueSummary and unreadCount speak in counts", () => {
  const q = core.createQueue();
  assert.equal(core.queueSummary(q), "");
  assert.equal(core.unreadCount(q), 0);
  core.push(q, { kind: "answer", text: "One" }, at(0));
  core.push(q, { kind: "answer", text: "Two" }, at(1));
  assert.equal(core.queueSummary(q), "2 answers waiting");
  assert.equal(core.unreadCount(q), 2);
  core.tick(q, at(2));
  assert.equal(core.unreadCount(q), 2, "the answer on screen still counts as unread");
  core.push(q, { kind: "error", text: "Three" }, at(3));
  assert.match(core.queueSummary(q), /waiting \(1 error\)/);
});

// ── prompts ─────────────────────────────────────────────────────────────────

test("the screen prompt forbids describing the screenshot itself", () => {
  const p = core.buildPrompt("screen", "");
  assert.match(p, /screenshot of the desktop/);
  assert.match(p, /Never describe the screenshot itself/);
});

test("a typed question is passed through with the answer style appended", () => {
  const p = core.buildPrompt("text", "  What error is that?  ");
  assert.match(p, /^What error is that\?/);
  assert.match(p, /2-4 short sentences/);
});

test("a follow-up carries the earlier question", () => {
  const p = core.buildPrompt("text", "And what about the button?", { isFollowUp: true, lastQuestion: "What error is that?" });
  assert.match(p, /Earlier the user asked about this same screen: "What error is that\?"/);
  assert.match(p, /Now they ask: And what about the button\?/);
});

test("a blank follow-up asks what else is worth knowing", () => {
  const p = core.buildPrompt("text", "", { isFollowUp: true, lastQuestion: "What is this?" });
  assert.match(p, /what else is worth knowing/);
});

test("the region prompt says it is a selected region", () => {
  assert.match(core.buildPrompt("region", ""), /region the user selected/);
  assert.match(core.buildPrompt("region", "Read that number"), /Read that number/);
});

// ── interpreting the gateway's answer ───────────────────────────────────────

test("a JSON answer from the gateway is the answer", () => {
  const r = core.interpretGatewayAnswer({ analysis: "The circle is red.", provider: "bonsai" });
  assert.deepEqual(r, { ok: true, text: "The circle is red." });
});

test("a plain-text answer kept in `note` is still an answer", () => {
  const r = core.interpretGatewayAnswer({ note: "The circle is red." });
  assert.deepEqual(r, { ok: true, text: "The circle is red." });
});

test("a gateway Error is a failure, never an answer", () => {
  const r = core.interpretGatewayAnswer({ note: "Error: Vision upload-analyze: Server disconnected without sending a response." });
  assert.equal(r.ok, false);
  assert.match(r.error, /Server disconnected/);
  assert.equal(core.interpretGatewayAnswer({ error: "boom" }).ok, false);
  assert.equal(core.interpretGatewayAnswer(null).ok, false);
  assert.equal(core.interpretGatewayAnswer("   ").ok, false);
});

// ── failure cards: loud, with a remedy ──────────────────────────────────────

test("the measured TLS mismatch gets its exact remedy", () => {
  const f = core.classifyVisionFailure("Error: Vision upload-analyze: Server disconnected without sending a response.");
  assert.equal(f.code, "tls-mismatch");
  assert.match(f.remedy, /AITHER_PERCEPTIONMEDIA_URL=https:\/\/aitheros-perception-media:8084/);
  assert.match(f.remedy, /restart aitheros-mcpgateway/);
});

test("a refused socket says the gateway is not answering, with the health command", () => {
  const f = core.classifyVisionFailure("connect ECONNREFUSED 127.0.0.1:8182");
  assert.equal(f.code, "unreachable");
  assert.match(f.remedy, /8182\/health/);
});

test("an auth failure names the bearer mint tool", () => {
  const f = core.classifyVisionFailure("HTTP 401 Unauthorized");
  assert.equal(f.code, "auth");
  assert.match(f.remedy, /mint_session_bearer/);
});

test("an unavailable vision lane points at the status endpoint", () => {
  const f = core.classifyVisionFailure("vision lane unavailable: model returned no analysis");
  assert.equal(f.code, "no-provider");
  assert.match(f.remedy, /8084\/status/);
});

test("a timeout warns about the cold load and the provider table", () => {
  const f = core.classifyVisionFailure("vision request timed out after 90 s");
  assert.equal(f.code, "timeout");
  assert.match(f.remedy, /available:false/);
});

test("anything else is still loud and never blank", () => {
  const f = core.classifyVisionFailure("");
  assert.equal(f.code, "unknown");
  assert.match(f.text, /no reason was given/);
  const card = core.failureCard("kaput");
  assert.match(card.text, /kaput/);
  assert.match(card.text, /Retry once/);
});

// ── geometry ────────────────────────────────────────────────────────────────

test("the first-run orb sits inside the work area's bottom-right corner", () => {
  const p = core.defaultOrbPosition({ x: 0, y: 0, width: 1920, height: 1040 }, { width: 64, height: 64 }, 28);
  assert.deepEqual(p, { x: 1920 - 64 - 28, y: 1040 - 64 - 28 });
});

test("a saved position is clamped into the work area, including a negative or huge one", () => {
  const area = { x: 0, y: 0, width: 1920, height: 1040 };
  assert.deepEqual(core.clampToWorkArea({ x: -500, y: 5000 }, { width: 64, height: 64 }, area), { x: 0, y: 1040 - 64 });
  assert.deepEqual(core.clampToWorkArea({ x: 100, y: 100 }, { width: 64, height: 64 }, area), { x: 100, y: 100 });
});

test("the bubble sits to the right of the orb, and flips left at the screen edge", () => {
  const area = { x: 0, y: 0, width: 1920, height: 1040 };
  const bubble = { width: 380, height: 460 };
  const middle = core.bubblePosition({ x: 800, y: 400, width: 64, height: 64 }, bubble, area, 10);
  assert.deepEqual(middle, { x: 800 + 64 + 10, y: 400 });
  const corner = core.bubblePosition({ x: 1800, y: 400, width: 64, height: 64 }, bubble, area, 10);
  assert.equal(corner.x, 1800 - 380 - 10, "flipped to the left of the orb");
});

test("the bubble flips up when its bottom would overflow", () => {
  const area = { x: 0, y: 0, width: 1920, height: 1040 };
  const p = core.bubblePosition({ x: 300, y: 900, width: 64, height: 64 }, { width: 380, height: 460 }, area, 10);
  assert.equal(p.y, 1040 - 460);
});

test("a bubble is never placed off-screen when the orb is in a negative-origin display", () => {
  const area = { x: -1920, y: 0, width: 1920, height: 1040 };
  const p = core.bubblePosition({ x: -1900, y: 10, width: 64, height: 64 }, { width: 380, height: 460 }, area, 10);
  assert.ok(p.x >= -1920);
});

// ── state file ──────────────────────────────────────────────────────────────

test("a saved state is small and sanitized; junk costs settings, not a launch", () => {
  assert.deepEqual(core.sanitizeState(null), { visible: true, pinned: false, x: null, y: null, freeRoam: false, sounds: true, muteUntil: 0 });
  assert.deepEqual(core.sanitizeState({ visible: false, x: "12.7", y: 400 }), { visible: false, pinned: false, x: 13, y: 400, freeRoam: false, sounds: true, muteUntil: 0 });
  assert.deepEqual(core.sanitizeState({ x: "nope", y: 1e9 }), { visible: true, pinned: false, x: null, y: 1000000000, freeRoam: false, sounds: true, muteUntil: 0 });
  assert.equal(core.sanitizeState({ pinned: true }).pinned, true);
});

test("fairy sounds default on and turn off only when explicitly false", () => {
  assert.equal(core.sanitizeState(null).sounds, true);
  assert.equal(core.sanitizeState({ sounds: "no" }).sounds, true);
  assert.equal(core.sanitizeState({ sounds: false }).sounds, false);
});

test("a nudge mute from the fairy's menu is remembered as a time, junk = not muted", () => {
  assert.equal(core.sanitizeState({ muteUntil: 1_800_000_000_000 }).muteUntil, 1_800_000_000_000);
  assert.equal(core.sanitizeState({ muteUntil: "soon" }).muteUntil, 0);
  assert.equal(core.sanitizeState({ muteUntil: -5 }).muteUntil, 0);
});

test("freeRoam is remembered only when explicitly true", () => {
  assert.equal(core.sanitizeState({ freeRoam: true }).freeRoam, true);
  assert.equal(core.sanitizeState({ freeRoam: "yes" }).freeRoam, false);
  assert.equal(core.sanitizeState(null).freeRoam, false);
});

test("areaAvoiding: the fairy's area leaves out a box the tenant site owns (GARG's goblin)", () => {
  const area = { x: 0, y: 0, width: 2194, height: 1206 };
  const goblin = { x: 2054, y: 962, width: 132, height: 132 }; // right:8, bottom:112
  const free = core.areaAvoiding(area, goblin, 124);
  // The largest rectangle that misses the padded box is everything left of it.
  assert.deepEqual(free, { x: 0, y: 0, width: 1930, height: 1206 });
  // The first-run spot and a saved spot inside the corner both land outside the box.
  for (const pos of [core.defaultOrbPosition(free, { width: 72, height: 72 }),
    core.clampToWorkArea({ x: 2100, y: 1000 }, { width: 72, height: 72 }, free)]) {
    assert.ok(pos.x + 72 <= goblin.x - 124, `fairy at ${pos.x} still reaches the goblin`);
  }
  // No box, an empty box, a box on another display: the area is untouched.
  assert.equal(core.areaAvoiding(area, null, 124), area);
  assert.equal(core.areaAvoiding(area, { x: 10, y: 10, width: 0, height: 0 }, 124), area);
  assert.equal(core.areaAvoiding(area, { x: 5000, y: 10, width: 132, height: 132 }, 124), area);
  // A box that would leave nothing usable does not shrink the area to a sliver.
  const small = { x: 0, y: 0, width: 400, height: 400 };
  assert.equal(core.areaAvoiding(small, { x: 100, y: 100, width: 200, height: 200 }, 0), small);
});

test("pageRectOnScreen: a page rect becomes a screen rect; junk is no box", () => {
  assert.deepEqual(core.pageRectOnScreen({ x: 2054, y: 962, width: 132, height: 132 }, { x: 0, y: 0, width: 2194, height: 1206 }),
    { x: 2054, y: 962, width: 132, height: 132 });
  assert.deepEqual(core.pageRectOnScreen({ x: 10, y: 20, width: 132, height: 132 }, { x: -1920, y: 40, width: 1920, height: 1040 }),
    { x: -1910, y: 60, width: 132, height: 132 });
  for (const bad of [null, {}, { x: 0, y: 0, width: 0, height: 10 }, { x: "a", y: 0, width: 5, height: 5 }, { x: 0, y: 0, width: 4000, height: 50 }]) {
    assert.equal(core.pageRectOnScreen(bad, { x: 0, y: 0, width: 100, height: 100 }), null);
  }
});

test("every resting path of the fairy asks restSpot, the hover included", () => {
  // 2026-11-12: placeOrb kept out of the goblin's box and the 33 ms hover loop put the
  // fairy straight back on the saved spot, because it read state.x/y itself.
  const src = require("node:fs").readFileSync(require("node:path").join(__dirname, "orb-window.cjs"), "utf8");
  assert.ok(src.includes("const rest = restSpot();"), "the hover asks restSpot");
  assert.doesNotMatch(src, /setOrbCenter\(\{ x: state\.x \+/);
  assert.ok(src.includes("  if (!alive(orbWindow)) return;\n  const pos = restSpot();"), "placeOrb asks restSpot");
});
