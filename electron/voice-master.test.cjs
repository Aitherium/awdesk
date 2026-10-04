"use strict";

/** voice-master tests -- the master switch's in-flight target (no Electron).
 *    node --test electron/voice-master.test.cjs */

const assert = require("node:assert/strict");
const { test } = require("node:test");

const { createVoiceMaster } = require("./voice-master.cjs");

function harness() {
  const state = { muted: false, writes: [], spoken: [], changes: 0, resolvers: [] };
  const cast = {
    allMuted: () => state.muted,
    setAllMuted: (on) => { state.muted = Boolean(on); state.writes.push(Boolean(on)); },
  };
  const speak = (text) => {
    state.spoken.push(text);
    return new Promise((resolve) => state.resolvers.push(resolve));
  };
  const master = createVoiceMaster({ cast, speak, onChange: () => { state.changes += 1; } });
  return { state, master };
}

const tick = () => new Promise((resolve) => setImmediate(resolve));

test("mute is announced first and lands only after the sentence ends", async () => {
  const { state, master } = harness();
  assert.equal(master.set(true), true);
  assert.deepEqual(state.spoken, ["Voices off."]);
  assert.equal(state.muted, false, "file is not muted while the confirmation plays");
  assert.equal(master.target(), true, "target reports the pending mute");
  state.resolvers[0]();
  await tick();
  assert.equal(state.muted, true);
  assert.equal(master.pending(), false);
  assert.equal(master.target(), true);
});

test("off then on inside the spoken window leaves the room UNMUTED", async () => {
  const { state, master } = harness();
  master.set(true);
  assert.equal(master.set(false), false, "unmute is not swallowed as already-done");
  assert.equal(master.target(), false);
  state.resolvers[0](); // the late "Voices off." finishes
  await tick();
  assert.equal(state.muted, false, "a superseded mute must not write");
  assert.deepEqual(state.writes, [false]);
});

test("off, on, off again: only the newest mute writes", async () => {
  const { state, master } = harness();
  master.set(true);
  master.set(false);
  master.set(true);
  state.resolvers[0]();
  await tick();
  assert.equal(state.muted, false, "the first mute was superseded");
  state.resolvers[2]();
  await tick();
  assert.equal(state.muted, true);
  assert.deepEqual(state.writes, [false, true]);
});

test("a repeated mute while one is pending is a no-op (no second sentence)", () => {
  const { state, master } = harness();
  master.set(true);
  assert.equal(master.set(true), true);
  assert.deepEqual(state.spoken, ["Voices off."]);
});

test("a failed speech still mutes (captions stay; the switch must not stick)", async () => {
  const state = { muted: false };
  const master = createVoiceMaster({
    cast: { allMuted: () => state.muted, setAllMuted: (on) => { state.muted = on; } },
    speak: () => Promise.reject(new Error("tts down")),
  });
  master.set(true);
  await tick();
  await tick();
  assert.equal(state.muted, true);
});

test("a speak that throws synchronously still mutes", async () => {
  const state = { muted: false };
  const master = createVoiceMaster({
    cast: { allMuted: () => state.muted, setAllMuted: (on) => { state.muted = on; } },
    speak: () => { throw new Error("boom"); },
  });
  assert.equal(master.set(true), true);
  await tick();
  await tick();
  assert.equal(state.muted, true);
});

test("unmute writes immediately and then says so", () => {
  const { state, master } = harness();
  state.muted = true;
  assert.equal(master.set(false), false);
  assert.equal(state.muted, false);
  assert.deepEqual(state.spoken, ["Voices on."]);
  assert.equal(master.set(false), false);
  assert.deepEqual(state.spoken, ["Voices on."], "already unmuted: no second sentence");
});
