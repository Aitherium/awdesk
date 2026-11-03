"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const audio = require("./system-audio.cjs");

test("clampPercent keeps every wire value inside 0..100", () => {
  assert.equal(audio.clampPercent(47), 47);
  assert.equal(audio.clampPercent("47"), 47);
  assert.equal(audio.clampPercent(47.6), 48);
  assert.equal(audio.clampPercent(-12), 0);
  assert.equal(audio.clampPercent(150), 100);
  assert.equal(audio.clampPercent(undefined), 0);
  assert.equal(audio.clampPercent("nonsense"), 0);
});

test("normalizeState trusts nothing on the wire and survives a missing endpoint", () => {
  const state = audio.normalizeState({
    ok: true,
    render: { id: "{0.0.0.00000000}.{abc}", name: "Speakers (Realtek(R) Audio)", volume: 73.4, muted: 0 },
    capture: null,
  });
  assert.equal(state.ok, true);
  assert.deepEqual(state.render, {
    id: "{0.0.0.00000000}.{abc}", name: "Speakers (Realtek(R) Audio)", volume: 73, muted: false,
  });
  assert.equal(state.capture, null);

  const failed = audio.normalizeState({ ok: false, error: "no default microphone is selected" });
  assert.equal(failed.ok, false);
  assert.match(failed.error, /microphone/);
  assert.equal(failed.render, null);
  assert.equal(audio.normalizeState(null).ok, false);
});

test("normalizeList counts devices and keeps the default flag", () => {
  const list = audio.normalizeList({
    ok: true,
    render: [
      { id: "a", name: "Speakers", default: true },
      { id: "b", name: "HDMI", default: false },
    ],
    capture: [{ id: "c", name: "Microphone", default: true }],
  });
  assert.equal(list.ok, true);
  assert.equal(list.render.length, 2);
  assert.equal(list.capture.length, 1);
  assert.equal(list.render[0].default, true);
  assert.deepEqual(audio.normalizeList({ ok: false, error: "boom" }).render, []);
  assert.equal(audio.normalizeList({ ok: false, error: "boom" }).ok, false);
});

test("parseReply turns a malformed helper line into a visible failure, never a throw", () => {
  assert.deepEqual(audio.parseReply('{"ok":true,"render":null,"capture":null}'),
    { ok: true, render: null, capture: null });
  assert.equal(audio.parseReply("not json").ok, false);
  assert.match(audio.parseReply("not json").error, /unreadable reply/);
  assert.equal(audio.parseReply("").ok, false);
  assert.equal(audio.parseReply("[1,2]").ok, false);
});

test("flowFor accepts the words a caller might use", () => {
  assert.equal(audio.flowFor("render"), "render");
  assert.equal(audio.flowFor("output"), "render");
  assert.equal(audio.flowFor(undefined), "render");
  assert.equal(audio.flowFor("capture"), "capture");
  assert.equal(audio.flowFor("input"), "capture");
  assert.equal(audio.flowFor("MIC"), "capture");
});

test("osdModel: the 1.2 s line states the new value, or why it could not", () => {
  const up = audio.osdModel({ flow: "render", endpoint: { id: "x", name: "Speakers", volume: 45, muted: false } });
  assert.equal(up.title, "Speakers");
  assert.equal(up.value, "45%");
  assert.equal(up.percent, 45);
  assert.equal(up.muted, false);
  assert.equal(up.icon, "volume");

  const muted = audio.osdModel({ flow: "render", endpoint: { id: "x", name: "Speakers", volume: 45, muted: true } });
  assert.equal(muted.value, "Muted");
  assert.equal(muted.icon, "volume-off");

  const mic = audio.osdModel({ flow: "capture", endpoint: { id: "y", name: "Microphone", volume: 80, muted: true } });
  assert.equal(mic.title, "Microphone");
  assert.equal(mic.kind, "mic");
  assert.equal(mic.icon, "mic-off");
  assert.equal(mic.value, "Muted");

  const bad = audio.osdModel({ flow: "render", endpoint: null, error: "no default speaker is selected" });
  assert.equal(bad.value, "Unavailable");
  assert.match(bad.note, /no default speaker/);
});

test("the helper script is a literal here-string with the C# intact", () => {
  const script = audio.buildHelperScript();
  assert.match(script, /^\$ErrorActionPreference = 'Stop'/);
  assert.match(script, /\nAdd-Type -TypeDefinition @'\nusing System;/);
  // The terminator must own its line (PowerShell refuses a padded one).
  assert.match(script, /\n'@\n\[Console\]::Out\.WriteLine\('ready'\)/);
  assert.match(script, /interface IMMDeviceEnumerator/);
  assert.match(script, /interface IAudioEndpointVolume/);
  assert.match(script, /SetDefaultEndpoint/);
  assert.match(script, /while \(\$null -ne \(\$line = \[Console\]::In\.ReadLine\(\)\)\)/);
  // No JS template interpolation leaked into the C#.
  assert.doesNotMatch(script, /\$\{/);
});

test("one endpoint without IAudioEndpointVolume cannot fail the whole state", () => {
  const script = audio.buildHelperScript();
  // Scope to the read path: the setters may still require Volume (a write to a
  // device with no volume control must fail loudly).
  const start = script.indexOf("static string EndpointJson");
  const end = script.indexOf("static string ListEndpointJson");
  assert.ok(start >= 0 && end > start);
  const endpointJson = script.slice(start, end);
  // The old code called Check() unconditionally, so one HDMI/DP sink turned
  // `state` into {ok:false} and disabled the whole flyout.
  assert.doesNotMatch(endpointJson, /Check\(vol\.GetMasterVolumeLevelScalar/);
  assert.doesNotMatch(endpointJson, /Check\(vol\.GetMute/);
  assert.ok(endpointJson.includes("int volume = 0;"));
  assert.ok(endpointJson.includes("if (vol.GetMasterVolumeLevelScalar(out scalar) == 0)"));
  assert.ok(endpointJson.includes("if (vol.GetMute(out m) == 0) muted = m;"));
});

test("each helper spawn gets its own script file (a dead helper cannot unlink its replacement's)", () => {
  const first = audio.scriptFile();
  const second = audio.scriptFile();
  assert.notEqual(first, second);
  assert.ok(first.endsWith(".ps1"));
  assert.ok(first.includes(`aither-system-audio-${process.pid}-`));
});

/** An in-process stand-in for the resident helper record. */
function fakeHelper({ ready = Promise.resolve(true), writeThrows = false } = {}) {
  const state = { killed: false };
  const g = {
    child: {
      kill: () => { state.killed = true; },
      stdin: { write: () => { if (writeThrows) throw new Error("EPIPE"); } },
    },
    waiters: [],
    chain: Promise.resolve(),
    ready,
  };
  return { g, state };
}

test("a helper that never finishes Add-Type cannot hang the first request", { skip: process.platform !== "win32" }, async () => {
  audio.__setHelperForTest(null);
  const { g, state } = fakeHelper({ ready: new Promise(() => {}) });
  audio.__setHelperForTest(g);
  try {
    const reply = await audio.__requestForTest("state", { timeoutMs: 40 });
    assert.equal(reply.ok, false);
    assert.match(reply.error, /did not start in time/);
    assert.equal(state.killed, true, "the wedged helper is torn down");
  } finally { audio.__setHelperForTest(null); }
});

test("warm() is bounded by the same startup timeout", { skip: process.platform !== "win32" }, async () => {
  audio.__setHelperForTest(null);
  const { g, state } = fakeHelper({ ready: new Promise(() => {}) });
  audio.__setHelperForTest(g);
  try {
    const reply = await audio.warm({ timeoutMs: 40 });
    assert.equal(reply.ok, false);
    assert.match(reply.error, /did not start in time/);
    assert.equal(state.killed, true);
  } finally { audio.__setHelperForTest(null); }
});

test("a timed-out request never kills the helper that replaced it", { skip: process.platform !== "win32" }, async () => {
  const first = fakeHelper();
  const second = fakeHelper();
  audio.__setHelperForTest(first.g);
  try {
    const pending = audio.__requestForTest("state", { timeoutMs: 40 });
    // A resume/recovery replaced the helper while this request was still waiting.
    audio.__setHelperForTest(second.g);
    const reply = await pending;
    assert.equal(reply.ok, false);
    assert.match(reply.error, /did not answer/);
    assert.equal(second.state.killed, false, "the newer helper must survive a stale timer");
    assert.equal(first.state.killed, false, "the stale helper was already detached");
    assert.equal(first.g.waiters.length, 0, "the stale waiter cannot eat a later reply");
  } finally { audio.__setHelperForTest(null); }
});
