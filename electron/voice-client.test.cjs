"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const { voiceSnapshot, listVoices, synthesize } = require("./voice-client.cjs");

function fakeCall(calls) {
  return async (name, args) => {
    calls.push({ name, args });
    if (name === "get_voice_status") {
      return JSON.stringify({ service: "aither-voice", healthy: true });
    }
    if (name === "get_available_voices") {
      return JSON.stringify({ voices: [{ id: "v1", name: "Aither" }] });
    }
    throw new Error(`unexpected tool ${name}`);
  };
}

test("voiceSnapshot aggregates status and voices", async () => {
  const calls = [];
  const snap = await voiceSnapshot(fakeCall(calls));
  assert.equal(snap.ok, true);
  assert.equal(snap.status.service, "aither-voice");
  assert.equal(snap.voices.voices.length, 1);
  assert.ok(snap.at > 0);
  assert.deepEqual(
    calls.map((c) => c.name),
    ["get_voice_status", "get_available_voices"],
  );
});

test("a failing source degrades to an ERROR note, not a failed snapshot", async () => {
  const snap = await voiceSnapshot(async (name) => {
    if (name === "get_voice_status") throw new Error("voice down");
    return JSON.stringify({ voices: [] });
  });
  assert.equal(snap.ok, true, "the snapshot survives one dead source");
  assert.match(snap.status.note, /voice down/);
});

test("a dead transport degrades every source to an ERROR note", async () => {
  const snap = await voiceSnapshot(async () => {
    throw new Error("no session bearer");
  });
  assert.equal(snap.ok, true);
  assert.match(snap.status.note, /no session bearer/);
  assert.match(snap.voices.note, /no session bearer/);
});

test("synthesize forwards text and optional voice", async () => {
  const calls = [];
  const result = await synthesize("hello", "v1", async (name, args) => {
    calls.push({ name, args });
    return JSON.stringify({ audio: "/data/audio/out.wav" });
  });
  assert.equal(result.audio, "/data/audio/out.wav");
  assert.deepEqual(calls[0], { name: "synthesize_speech", args: { text: "hello", voice: "v1" } });
});

test("listVoices parses prose-free json, falls back to a note", async () => {
  const ok = await listVoices(async () => JSON.stringify(["a", "b"]));
  assert.deepEqual(ok, ["a", "b"]);
  const prose = await listVoices(async () => "not json at all");
  assert.equal(typeof prose.note, "string");
});

// --- transcribeCloud: POST /api/voice/hear with the user's own login ---------------
const os = require("node:os");
const fsx = require("node:fs");
const pathx = require("node:path");
const { EventEmitter } = require("node:events");
const { transcribeCloud } = require("./voice-client.cjs");

function fakeHttp(status, body, seen) {
  return {
    request(url, opts, onRes) {
      const req = new EventEmitter();
      req.destroy = () => {};
      req.end = (buf) => {
        seen.push({ url, opts, body: buf });
        const res = new EventEmitter();
        res.statusCode = status;
        res.setEncoding = () => {};
        onRes(res);
        res.emit("data", body);
        res.emit("end");
      };
      return req;
    },
  };
}

function clip() {
  const p = pathx.join(os.tmpdir(), `vc-test-${process.pid}-${Math.random().toString(16).slice(2)}.wav`);
  fsx.writeFileSync(p, Buffer.from("RIFF....WAVEfmt "));
  return p;
}

test("transcribeCloud posts one multipart `audio` part with the bearer and returns the words", async () => {
  const seen = [];
  const p = clip();
  const text = await transcribeCloud(p, {
    base: "https://api.example.test/", token: "tok-1", request: fakeHttp(200, '{"text":"hello desk"}', seen),
  });
  fsx.unlinkSync(p);
  assert.equal(text, "hello desk");
  assert.equal(seen.length, 1);
  assert.equal(seen[0].url, "https://api.example.test/api/voice/hear");
  assert.equal(seen[0].opts.method, "POST");
  assert.equal(seen[0].opts.headers.Authorization, "Bearer tok-1");
  assert.match(seen[0].opts.headers["Content-Type"], /^multipart\/form-data; boundary=/);
  const body = seen[0].body.toString("latin1");
  assert.match(body, /name="audio"; filename="clip\.wav"/);
  assert.ok(body.includes("RIFF....WAVEfmt "));
  assert.equal(seen[0].opts.headers["Content-Length"], seen[0].body.length);
});

test("transcribeCloud: silence is an honest empty string, a refusal is null", async () => {
  const p = clip();
  assert.equal(await transcribeCloud(p, { token: "t", request: fakeHttp(200, '{"text":""}', []) }), "");
  assert.equal(await transcribeCloud(p, { token: "t", request: fakeHttp(401, '{"error":"x"}', []) }), null);
  assert.equal(await transcribeCloud(p, { token: "t", request: fakeHttp(503, "down", []) }), null);
  fsx.unlinkSync(p);
});

test("transcribeCloud never dials without a token or a readable clip", async () => {
  const seen = [];
  const p = clip();
  assert.equal(await transcribeCloud(p, { token: "", request: fakeHttp(200, '{"text":"x"}', seen) }), null);
  fsx.unlinkSync(p);
  assert.equal(await transcribeCloud(p, { token: "t", request: fakeHttp(200, '{"text":"x"}', seen) }), null);
  assert.equal(seen.length, 0);
});
