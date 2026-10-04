"use strict";

/**
 * custom-voice.cjs against a FAKE Genesis bridge on an ephemeral loopback port --
 * the real wire (method, path, bearer, JSON body), no fleet. Zero custom voices
 * exist on the live fleet yet, so the empty list is the first case, not an edge.
 *
 *   node --test electron/custom-voice.test.cjs
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");

const cv = require("./custom-voice.cjs");

/** A tiny real RIFF/WAVE: 22050 Hz 16-bit mono, `ms` of silence. */
function wavBase64(ms = 500, rate = 22050) {
  const dataBytes = Math.round((rate * 2 * ms) / 1000);
  const buf = Buffer.alloc(44 + dataBytes);
  buf.write("RIFF", 0, "ascii");
  buf.writeUInt32LE(36 + dataBytes, 4);
  buf.write("WAVE", 8, "ascii");
  buf.write("fmt ", 12, "ascii");
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20); // PCM
  buf.writeUInt16LE(1, 22); // mono
  buf.writeUInt32LE(rate, 24);
  buf.writeUInt32LE(rate * 2, 28); // byteRate
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write("data", 36, "ascii");
  buf.writeUInt32LE(dataBytes, 40);
  return buf.toString("base64");
}

/** Start a fake bridge; `handler(req, body)` returns [status, json]. */
async function fakeBridge(handler) {
  const seen = [];
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => { raw += c; });
    req.on("end", () => {
      const body = raw ? JSON.parse(raw) : null;
      seen.push({ method: req.method, url: req.url, auth: req.headers.authorization, body });
      const [status, json] = handler(req, body);
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(json));
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}/api/bridge/genesis`;
  return { base, seen, close: () => new Promise((r) => server.close(r)) };
}

test("isCustomVoice / customVoiceName: only a non-empty custom:<name> is custom", () => {
  assert.equal(cv.isCustomVoice("custom:ana"), true);
  assert.equal(cv.customVoiceName("custom:ana"), "ana");
  for (const v of ["nova", "en-US-AvaNeural", "custom:", "", null, undefined, 7]) {
    assert.equal(cv.isCustomVoice(v), false, String(v));
    assert.equal(cv.customVoiceName(v), "");
  }
});

test("listCustomVoices: an empty workspace is {ok:true, voices:[]} and hits GET /voice-builds/voices with the bearer", async () => {
  const bridge = await fakeBridge(() => [200, { voices: [] }]);
  try {
    const out = await cv.listCustomVoices({ base: bridge.base, token: "t0k" });
    assert.deepEqual(out, { ok: true, voices: [] });
    assert.equal(bridge.seen[0].method, "GET");
    assert.equal(bridge.seen[0].url, "/api/bridge/genesis/voice-builds/voices");
    assert.equal(bridge.seen[0].auth, "Bearer t0k");
  } finally {
    await bridge.close();
  }
});

test("listCustomVoices: one built voice becomes a custom:<name> picker row", async () => {
  const bridge = await fakeBridge(() => [200, { voices: [
    { id: "v1", name: "ana", reader: "r", language: "en-US", built_at: "2026-10-03", gate: { passed: true } },
    { id: "v2", name: "" }, // nameless rows are dropped, not rendered as "custom:"
  ] }]);
  try {
    const out = await cv.listCustomVoices({ base: bridge.base, token: "t" });
    assert.equal(out.ok, true);
    assert.deepEqual(out.voices, [{ id: "custom:ana", name: "ana", language: "en-US", gate: { passed: true } }]);
  } finally {
    await bridge.close();
  }
});

test("listCustomVoices: 401, a refused port and a missing bearer are {ok:false, voices:[]}, never a throw", async () => {
  const bridge = await fakeBridge(() => [401, { detail: "Sign in to a workspace first" }]);
  try {
    const denied = await cv.listCustomVoices({ base: bridge.base, token: "t" });
    assert.equal(denied.ok, false);
    assert.deepEqual(denied.voices, []);
    assert.match(denied.reason, /401/);
  } finally {
    await bridge.close();
  }
  const dead = await cv.listCustomVoices({ base: bridge.base, token: "t" }); // server now closed
  assert.equal(dead.ok, false);
  assert.deepEqual(dead.voices, []);
  const anon = await cv.listCustomVoices({ base: bridge.base, token: "" });
  assert.equal(anon.ok, false);
  assert.match(anon.reason, /no session bearer/);
});

test("synthesizeCustom: success returns synthesizeVerdict's shape with the WAV's true duration", async () => {
  const audio = wavBase64(500);
  const bridge = await fakeBridge(() => [200, { audio_base64: audio, format: "wav", voice: "custom:ana" }]);
  try {
    const out = await cv.synthesizeCustom("hello there", "custom:ana", { speed: 1.2, base: bridge.base, token: "t" });
    assert.equal(out.ok, true, out.reason);
    assert.equal(out.audioBase64, audio);
    assert.equal(out.durationMs, 500, "22.05 kHz WAV must be timed from its header, not a 24 kHz guess");
    assert.equal(bridge.seen[0].method, "POST");
    assert.equal(bridge.seen[0].url, "/api/bridge/genesis/voice-builds/voices/ana/say");
    assert.deepEqual(bridge.seen[0].body, { text: "hello there", speed: 1.2 });
  } finally {
    await bridge.close();
  }
});

test("synthesizeCustom: a 404 names the voice and the workspace", async () => {
  const bridge = await fakeBridge(() => [404, { detail: "No such voice in this workspace" }]);
  try {
    const out = await cv.synthesizeCustom("hi", "custom:ghost", { base: bridge.base, token: "t" });
    assert.deepEqual(out, { ok: false, reason: "custom voice ghost not found in this workspace" });
  } finally {
    await bridge.close();
  }
});

test("synthesizeCustom: text over 1000 chars is cut and speed is clamped to Genesis's 0.5-2.0", async () => {
  const bridge = await fakeBridge(() => [200, { audio_base64: wavBase64(100) }]);
  try {
    await cv.synthesizeCustom("x".repeat(1500), "custom:ana", { speed: 3, maxChars: 5000, base: bridge.base, token: "t" });
    await cv.synthesizeCustom("y", "custom:ana", { speed: 0.1, base: bridge.base, token: "t" });
    assert.equal(bridge.seen[0].body.text.length, 1000);
    assert.equal(bridge.seen[0].body.speed, 2);
    assert.equal(bridge.seen[1].body.speed, 0.5);
  } finally {
    await bridge.close();
  }
});

test("synthesizeCustom: a name with a slash is path-encoded, not a second path segment", async () => {
  const bridge = await fakeBridge(() => [404, {}]);
  try {
    await cv.synthesizeCustom("hi", "custom:a/b", { base: bridge.base, token: "t" });
    assert.equal(bridge.seen[0].url, "/api/bridge/genesis/voice-builds/voices/a%2Fb/say");
  } finally {
    await bridge.close();
  }
});

test("synthesizeCustom: a 503 or a dead bridge is {ok:false, reason}, never a throw", async () => {
  const bridge = await fakeBridge(() => [503, { detail: "Voice unavailable" }]);
  try {
    const out = await cv.synthesizeCustom("hi", "custom:ana", { base: bridge.base, token: "t" });
    assert.equal(out.ok, false);
    assert.match(out.reason, /503/);
  } finally {
    await bridge.close();
  }
  const dead = await cv.synthesizeCustom("hi", "custom:ana", { base: bridge.base, token: "t" });
  assert.equal(dead.ok, false);
  assert.ok(dead.reason);
});
