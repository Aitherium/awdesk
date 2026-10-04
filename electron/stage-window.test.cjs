"use strict";

/**
 * stage-window.test.cjs -- the desk:stage-* verbs, driven headless through the
 * pure `stageHandlers(getImpl)` seam (same technique as cast-window.test.cjs:
 * real Electron is never required), plus `withVoiceState`, the stamp that puts
 * each body's voice switch on the Stage pane's rows.
 *
 *   node --test electron/stage-window.test.cjs
 */

const assert = require("node:assert/strict");
const test = require("node:test");

const { stageHandlers, withVoiceState, STAGE_RUNNABLE } = require("./stage-window.cjs");

const CHANNELS = [
  "desk:stage-bodies",
  "desk:stage-arrange",
  "desk:stage-focus",
  "desk:stage-remove",
  "desk:stage-run",
  // Added 2026-10-04: the per-body speaker and the master "all voices" switch.
  "desk:stage-voice",
  "desk:stage-all-voices",
];

const handlersFor = (impl) => stageHandlers(() => impl);

test("the desk:stage-* channel set is exactly the documented seven", () => {
  assert.deepEqual(Object.keys(handlersFor({})).sort(), [...CHANNELS].sort());
});

test("every channel has a matching invoke in stage-preload.cjs", () => {
  const fs = require("node:fs");
  const preload = fs.readFileSync(require("node:path").join(__dirname, "stage-preload.cjs"), "utf8");
  for (const channel of CHANNELS) {
    assert.ok(preload.includes(`"${channel}"`), `${channel} is not exposed to the page`);
  }
});

test("bodies carries the master voice state beside the list", () => {
  const bodies = [{ slotId: "slot0", agent: "aither", resident: true, voiceMuted: false }];
  const result = handlersFor({ bodies: () => bodies, allVoicesMuted: () => true })["desk:stage-bodies"]();
  assert.equal(result.ok, true);
  assert.equal(result.allVoicesMuted, true);
  assert.deepEqual(result.bodies, bodies);
  const bare = handlersFor({})["desk:stage-bodies"]();
  assert.equal(bare.allVoicesMuted, false, "an impl without the switch reads as voices ON, not undefined");
});

test("stage-voice sets ONE body's voice to the stated state and returns it", () => {
  const calls = [];
  const impl = { setVoiceMuted: (slot, on) => { calls.push([slot, on]); return on; } };
  const handlers = handlersFor(impl);
  assert.deepEqual(handlers["desk:stage-voice"](null, "slot2", true),
    { ok: true, slotId: "slot2", voiceMuted: true });
  assert.deepEqual(handlers["desk:stage-voice"](null, "slot2", false),
    { ok: true, slotId: "slot2", voiceMuted: false });
  assert.deepEqual(calls, [["slot2", true], ["slot2", false]]);
});

test("stage-voice refuses a missing slot or a non-boolean target instead of flipping", () => {
  const calls = [];
  const handlers = handlersFor({ setVoiceMuted: (...a) => { calls.push(a); return true; } });
  assert.match(handlers["desk:stage-voice"](null, "", true).error, /^voice: no body named/);
  assert.match(handlers["desk:stage-voice"](null, "slot1", "yes").error, /true or false/);
  assert.match(handlers["desk:stage-voice"](null, "slot1", undefined).error, /true or false/);
  assert.deepEqual(calls, [], "a refused call must not reach main");
  assert.match(handlersFor({})["desk:stage-voice"](null, "slot1", true).error, /not wired/);
});

test("stage-voice reports main's refusal (a slot that names no agent) as ok:false", () => {
  const handlers = handlersFor({ setVoiceMuted: () => { throw new Error("slot9 is not a body on the stage"); } });
  assert.deepEqual(handlers["desk:stage-voice"](null, "slot9", true),
    { ok: false, error: "voice: slot9 is not a body on the stage" });
});

test("stage-all-voices sets the master switch to a stated state", () => {
  const calls = [];
  const handlers = handlersFor({ setAllVoicesMuted: (on) => { calls.push(on); return on; } });
  assert.deepEqual(handlers["desk:stage-all-voices"](null, true), { ok: true, allVoicesMuted: true });
  assert.deepEqual(handlers["desk:stage-all-voices"](null, false), { ok: true, allVoicesMuted: false });
  assert.match(handlers["desk:stage-all-voices"](null, 1).error, /true or false/);
  assert.deepEqual(calls, [true, false]);
});

test("stage-run still only runs the avatar-window ids", () => {
  const ran = [];
  const handlers = handlersFor({ run: (id) => ran.push(id) });
  assert.equal(handlers["desk:stage-run"](null, STAGE_RUNNABLE[0]).ok, true);
  assert.match(handlers["desk:stage-run"](null, "voice.mute-all").error, /cannot run from the stage page/);
  assert.deepEqual(ran, [STAGE_RUNNABLE[0]]);
});

test("withVoiceState stamps voiceMuted from the SAME agent lookup the right-click uses", () => {
  const agents = { slot0: "aither", slot1: "Atlas", slot2: null };
  const bodies = [
    { slotId: "slot0", agent: "aither", resident: true },
    { slotId: "slot1", agent: "", resident: false },          // agent only via agentFor (character name)
    { slotId: "slot2", agent: "Lyra", resident: false },      // agentFor knows nothing: falls back to agent
    { slotId: "slot3", agent: "", resident: false },          // nobody: never muted
  ];
  const out = withVoiceState(bodies, { agentFor: (s) => agents[s], mutedAgents: ["atlas", " LYRA "] });
  assert.deepEqual(out.map((b) => [b.slotId, b.voiceMuted]),
    [["slot0", false], ["slot1", true], ["slot2", true], ["slot3", false]]);
  assert.equal(out[1].agent, "", "the body's own fields are kept as they were");
  assert.equal(bodies[1].voiceMuted, undefined, "the input list is not mutated");
});

test("withVoiceState with no mute list leaves every voice on", () => {
  const out = withVoiceState([{ slotId: "slot0", agent: "aither" }], {});
  assert.deepEqual(out, [{ slotId: "slot0", agent: "aither", voiceMuted: false }]);
  assert.deepEqual(withVoiceState(null, {}), []);
});
