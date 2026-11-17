"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const arb = require("./speech-arbiter.cjs");

/** A manual clock + timer wheel so "20 s later" costs nothing. */
function clock() {
  let t = 1000;
  const timers = [];
  return {
    now: () => t,
    setTimer: (fn, ms) => { const h = { fn, at: t + ms }; timers.push(h); return h; },
    clearTimer: (h) => { const i = timers.indexOf(h); if (i >= 0) timers.splice(i, 1); },
    advance(ms) {
      t += ms;
      for (;;) {
        const i = timers.findIndex((h) => h.at <= t);
        if (i < 0) return;
        timers.splice(i, 1)[0].fn();
      }
    },
  };
}
const tick = () => new Promise((r) => setImmediate(r));

function rig(over = {}) {
  const c = clock();
  const log = [];
  const dropped = [];
  const a = arb.createSpeechArbiter({
    now: c.now, setTimer: c.setTimer, clearTimer: c.clearTimer,
    run: async (job) => { log.push({ text: job.text, at: c.now() }); return { ok: true, durationMs: job.dur ?? 1000 }; },
    onDrop: (job, why) => dropped.push({ text: job.text, why }),
    ...over,
  });
  return { c, a, log, dropped };
}

test("priorityOf: owner conversation > decision cards > Aither > everything else", () => {
  assert.equal(arb.priorityOf({ origin: "service:awdesk-voice", slotId: "slot0" }), 0);
  assert.equal(arb.priorityOf({ origin: "service:awdesk-voice-answer" }), 0);
  assert.equal(arb.priorityOf({ origin: "desk:drop" }), 0);
  assert.equal(arb.priorityOf({ origin: "service:awdesk-decisions", slotId: "slot0" }), 1);
  assert.equal(arb.priorityOf({ origin: "service:awdesk", slotId: "slot0" }), 2);
  assert.equal(arb.priorityOf({ origin: "service:awdesk-swarm", slotId: "room-x", speaker: { agent: "aither" } }), 2);
  assert.equal(arb.priorityOf({ origin: "relay:#agents", slotId: "room-atlas", speaker: { agent: "atlas" } }), 3);
  assert.equal(arb.priorityOf({ origin: "claude_code:abcd", slotId: "slot0", speaker: { origin: "claude_code:abcd" } }), 3, "a session is never Aither's rank, even on slot0");
});

test("a coding session is recognised by its origin kind or an explicit flag", () => {
  for (const origin of ["claude_code:ab12", "terminal:7", "session:x", "codex:1"]) assert.equal(arb.isSessionSpeaker({ origin }), true, origin);
  assert.equal(arb.isSessionSpeaker({ origin: "service:awdesk" }), false);
  assert.equal(arb.isSessionSpeaker({ origin: "relay:#agents", speaker: { session: true } }), true);
  assert.equal(arb.isSessionSpeaker({ origin: "relay:#agents", speaker: { agent: "atlas" } }), false);
});

test("ONE voice at a time: a second line waits for the first clip to finish plus the gap, it never overlaps", async () => {
  const { c, a, log } = rig();
  const p1 = a.enqueue({ rank: 2, text: "first", dur: 3000 });
  const p2 = a.enqueue({ rank: 2, text: "second", dur: 2000 });
  await tick();
  assert.deepEqual(log.map((l) => l.text), ["first"]);
  c.advance(2900);
  await tick();
  assert.deepEqual(log.map((l) => l.text), ["first"], "still inside the first clip");
  c.advance(400); // 3300 > 3000 + 250 gap
  await tick();
  assert.deepEqual(log.map((l) => l.text), ["first", "second"]);
  assert.equal((await p1).ok, true);
  c.advance(5000);
  assert.equal((await p2).ok, true);
});

test("priority orders the waiting lines; a higher rank jumps the queue but never cuts the playing one", async () => {
  const { c, a, log } = rig();
  void a.enqueue({ rank: 3, text: "session chatter", dur: 2000 });
  await tick();
  void a.enqueue({ rank: 3, text: "other agent", dur: 1000 });
  void a.enqueue({ rank: 2, text: "aither", dur: 1000 });
  void a.enqueue({ rank: 0, text: "owner conversation", dur: 1000 });
  void a.enqueue({ rank: 1, text: "decision card", dur: 1000 });
  c.advance(2300); await tick();
  c.advance(1300); await tick();
  c.advance(1300); await tick();
  c.advance(1300); await tick();
  c.advance(1300); await tick();
  assert.deepEqual(log.map((l) => l.text), ["session chatter", "owner conversation", "decision card", "aither", "other agent"]);
});

test("a lower-priority line older than 20 s is dropped (with its caption), never spoken late", async () => {
  const { c, a, log, dropped } = rig();
  void a.enqueue({ rank: 2, text: "long monologue", dur: 30000 });
  await tick();
  const late = a.enqueue({ rank: 3, text: "pushed the branch", dur: 1000 });
  c.advance(31000); await tick();
  const r = await late;
  assert.equal(r.ok, false);
  assert.equal(r.refused, "arbiter");
  assert.deepEqual(log.map((l) => l.text), ["long monologue"], "the stale line never played");
  assert.equal(dropped.length, 1);
  assert.match(dropped[0].why, /stale/);
});

test("the owner's own conversation waits longer than 20 s before it is stale", async () => {
  const { c, a, log } = rig();
  void a.enqueue({ rank: 2, text: "long", dur: 30000 });
  await tick();
  const mine = a.enqueue({ rank: 0, text: "answer", dur: 1000 });
  c.advance(31000); await tick();
  assert.equal((await mine).ok, true);
  assert.deepEqual(log.map((l) => l.text), ["long", "answer"]);
});

test("the queue is bounded: the oldest lowest-ranked waiting line goes, a higher rank is kept", async () => {
  const { a, log, dropped } = rig({ maxWaiting: 3 });
  void a.enqueue({ rank: 2, text: "playing", dur: 5000 });
  await tick();
  void a.enqueue({ rank: 3, text: "s1" });
  void a.enqueue({ rank: 3, text: "s2" });
  void a.enqueue({ rank: 1, text: "card" });
  void a.enqueue({ rank: 3, text: "s3" });
  assert.deepEqual(dropped.map((d) => d.text), ["s1"], "oldest rank-3 line dropped");
  assert.deepEqual(log.map((l) => l.text), ["playing"]);
});

test("a refused or failed line releases the lane at once (no silent hold)", async () => {
  const c = clock();
  const log = [];
  const a = arb.createSpeechArbiter({
    now: c.now, setTimer: c.setTimer, clearTimer: c.clearTimer,
    run: async (job) => { log.push(job.text); return job.fail ? { ok: false, reason: "tts down" } : { ok: true, durationMs: 1000 }; },
  });
  void a.enqueue({ rank: 3, text: "fails", fail: true });
  void a.enqueue({ rank: 3, text: "next" });
  await tick(); await tick();
  assert.deepEqual(log, ["fails", "next"]);
  const thrown = arb.createSpeechArbiter({ now: c.now, setTimer: c.setTimer, clearTimer: c.clearTimer, run: async () => { throw new Error("boom"); } });
  assert.equal((await thrown.enqueue({ rank: 3, text: "x" })).ok, false);
});

test("session voices: silent until opted in, and the opt-in survives a restart; a bad file means nobody", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "desk-session-voice-"));
  try {
    const file = path.join(dir, "session-voices.json");
    const v = arb.createSessionVoices({ file });
    const key = arb.sessionKey({ speaker: { author: "AitherOS-Fresh", seat: 1, origin: "claude_code:zz" } });
    assert.equal(key, "aitheros-fresh:1");
    assert.equal(v.has(key), false, "silent by default");
    v.set(key, true);
    assert.equal(arb.createSessionVoices({ file }).has(key), true, "a fresh process still has it");
    v.set(key, false);
    assert.equal(arb.createSessionVoices({ file }).has(key), false);
    fs.writeFileSync(file, "{not json");
    assert.equal(arb.createSessionVoices({ file }).list().length, 0);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("main.cjs routes every spoken line through the arbiter and keeps sessions silent unless opted in", () => {
  const main = fs.readFileSync(path.join(__dirname, "main.cjs"), "utf8");
  assert.match(main, /require\("\.\/speech-arbiter\.cjs"\)/);
  assert.match(main, /async function speakAloud\(/);
  assert.match(main, /speechArbiter\(\)\.enqueue\(/);
  assert.match(main, /async function speakAloudNow\(/);
  assert.match(main, /isSessionSpeaker\(/);
  assert.match(main, /case "voice\.session"/);
});
