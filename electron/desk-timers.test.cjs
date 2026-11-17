"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { createTimers, parseTimer, spoken } = require("./desk-timers.cjs");

test("parseTimer reads the ways people say a duration", () => {
  const cases = {
    "10m tea": [600_000, "tea"], "1h30m stretch": [5_400_000, "stretch"], "90s": [90_000, "Timer"],
    "25 min focus": [1_500_000, "focus"], "tea 5m": [300_000, "tea"], "5": [300_000, "Timer"],
    "timer for 2 hours": [7_200_000, "Timer"],
  };
  for (const [text, [ms, label]] of Object.entries(cases)) {
    const p = parseTimer(text);
    assert.equal(p.ok, true, text);
    assert.equal(p.ms, ms, text);
    assert.equal(p.label, label, text);
  }
  assert.match(parseTimer("tea").error, /no duration/);
  assert.match(parseTimer("").error, /0 durations/);
  assert.match(parseTimer("30h").error, /24 h/);
});

test("a timer ends in one notification and says it does not survive a restart", () => {
  const pending = [];
  const notes = [];
  const t = createTimers({ notify: (n) => notes.push(n), setTimeoutImpl: (fn, ms) => { pending.push({ fn, ms }); return pending.length; }, now: () => 0 });
  const started = t.start("10m tea");
  assert.equal(started.ok, true);
  assert.match(started.did, /tea.*10 min.*until the desk restarts/);
  assert.equal(pending[0].ms, 600_000);
  assert.equal(t.list().length, 1);
  pending[0].fn();
  assert.deepEqual(notes, [{ title: "⏰ tea", body: "10 min timer is done" }]);
  assert.equal(t.list().length, 0);
  assert.equal(t.start("nope").ok, false);
  assert.equal(spoken(5_400_000), "1 h 30 min");
});
