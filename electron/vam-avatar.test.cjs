"use strict";

/**
 * vam-avatar.cjs against FAKE local servers that speak the DarkLink contract
 * (AitherOS lib/darklink vam_frames.py :9341 and vam_avatar.py :9342): the fake
 * avatar server refuses exactly what the real one refuses (415 on a wrong
 * Content-Type, 400 on a non-object) and records every body it accepted, so the
 * assertions are about the bytes on the wire, not about a mock's call log.
 */

const assert = require("node:assert/strict");
const http = require("node:http");
const { test } = require("node:test");

const vam = require("./vam-avatar.cjs");

function listen(handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      resolve({
        server,
        base: `http://127.0.0.1:${port}`,
        close: () => new Promise((r) => {
          server.closeAllConnections?.();
          server.close(r);
        }),
      });
    });
  });
}

/** vam_frames.py's /health + /stream.mjpg, with a settable health body. */
async function fakeFrames(health) {
  const state = { health, hits: [] };
  const srv = await listen((req, res) => {
    state.hits.push(`${req.method} ${req.url}`);
    if (req.url === "/health") {
      const body = JSON.stringify(state.health);
      res.writeHead(200, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) });
      res.end(body);
      return;
    }
    if (req.url === "/stream.mjpg") {
      res.writeHead(200, { "Content-Type": "multipart/x-mixed-replace; boundary=darklinkframe" });
      res.end("--darklinkframe\r\nContent-Type: image/png\r\nContent-Length: 0\r\n\r\n\r\n");
      return;
    }
    res.writeHead(404);
    res.end();
  });
  return { ...srv, state };
}

/** vam_avatar.py's serve(): POST /avatar, application/json only, object only. */
async function fakeAvatar() {
  const received = [];
  const refused = [];
  const srv = await listen((req, res) => {
    const reply = (code, body) => {
      const data = JSON.stringify(body);
      res.writeHead(code, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) });
      res.end(data);
    };
    if (req.method !== "POST" || req.url !== "/avatar") return reply(404, { error: "POST /avatar" });
    const ctype = String(req.headers["content-type"] || "").split(";")[0].trim().toLowerCase();
    if (ctype !== "application/json") {
      refused.push(ctype);
      return reply(415, { error: "Content-Type must be application/json" });
    }
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      let ev;
      try {
        ev = JSON.parse(raw || "{}");
      } catch {
        return reply(400, { error: "bad json" });
      }
      if (!ev || typeof ev !== "object" || Array.isArray(ev)) return reply(400, { error: "event must be an object" });
      received.push(ev);
      reply(200, { ok: true, expression: ev.expression || "neutral", results: [] });
    });
  });
  return { ...srv, received, refused };
}

test("probeFrames: a healthy frame server yields its /stream.mjpg URL", async () => {
  const f = await fakeFrames({ ok: true, frames: 12, stale: false, age_s: 0.1, size: [1280, 720], error: "" });
  try {
    const p = await vam.probeFrames({ base: f.base });
    assert.equal(p.ok, true);
    assert.equal(p.streamUrl, `${f.base}/stream.mjpg`);
    assert.deepEqual(f.state.hits, ["GET /health"]);
    // The URL it hands the renderer really is the multipart stream.
    const res = await fetch(p.streamUrl);
    assert.match(res.headers.get("content-type"), /^multipart\/x-mixed-replace; boundary=darklinkframe/);
    await res.text();
  } finally {
    await f.close();
  }
});

test("probeFrames: /health ok:false carries vam_frames' own error as the reason; stale is named", async () => {
  const f = await fakeFrames({ ok: false, frames: 0, stale: false, age_s: null, size: null, error: "VaM.exe not running" });
  try {
    const p = await vam.probeFrames({ base: f.base });
    assert.equal(p.ok, false);
    assert.equal(p.reason, "VaM not capturable: VaM.exe not running");
    f.state.health = { ok: false, frames: 40, stale: true, age_s: 31, size: [1280, 720], error: "" };
    assert.equal((await vam.probeFrames({ base: f.base })).reason, "VaM not capturable: frames are stale");
  } finally {
    await f.close();
  }
});

test("probeFrames: nothing listening is a refused-connection reason, never a throw", async () => {
  const f = await fakeFrames({ ok: true });
  const base = f.base;
  await f.close(); // the port is now dead
  const p = await vam.probeFrames({ base });
  assert.equal(p.ok, false);
  assert.match(p.reason, /^VaM frame server on 127\.0\.0\.1:\d+: connection refused$/);
});

test("resolveSource: vam + failed probe falls back to vrm WITH the reason; vrm ignores the probe", () => {
  const down = vam.resolveSource("vam", { ok: false, reason: "VaM not capturable: window minimised" }, 'actors["service:awdesk"].avatar');
  assert.deepEqual(down, {
    type: "avatar-source",
    slotId: "slot0",
    requested: "vam",
    source: "vrm",
    streamUrl: null,
    reason: "VaM not capturable: window minimised",
    from: 'actors["service:awdesk"].avatar',
  });
  const up = vam.resolveSource("vam", { ok: true, streamUrl: "http://127.0.0.1:9341/stream.mjpg" });
  assert.equal(up.source, "vam");
  assert.equal(up.streamUrl, "http://127.0.0.1:9341/stream.mjpg");
  assert.equal(vam.resolveSource("vrm", { ok: true, streamUrl: "x" }).source, "vrm");
});

test("vamEvent: only the vam_avatar.py keys survive; speaking is a real boolean; text rides only with speaking:true", () => {
  assert.deepEqual(vam.vamEvent({ expression: " Happy ", junk: 1 }), { expression: "happy" });
  assert.equal(vam.vamEvent({ expression: "smug" }), null);
  assert.deepEqual(vam.vamEvent({ speaking: true, text: "hello there" }), { speaking: true, text: "hello there" });
  assert.deepEqual(vam.vamEvent({ speaking: false, text: "ignored" }), { speaking: false });
  assert.equal(vam.vamEvent({ speaking: "yes" }), null);
  assert.deepEqual(vam.vamEvent({ mood: "curious" }), { mood: "curious" });
});

test("forwarder: speaking start/stop, expression, mood and text reach POST /avatar as application/json, IN ORDER", async () => {
  const a = await fakeAvatar();
  const fwd = vam.createVamForwarder({ base: a.base });
  try {
    const r = await fwd.speakingStart("Hello from the desk, owner.");
    assert.equal(r.ok, true);
    assert.equal(r.status, 200);
    void fwd.expression("surprised");
    void fwd.mood("joyful");
    void fwd.speakingStop();
    void fwd.speakingStop(); // a second stop is a no-op, not a second POST
    await fwd.drain();
    assert.deepEqual(a.received, [
      { speaking: true, text: "Hello from the desk, owner." },
      { expression: "surprised" },
      { mood: "joyful" },
      { speaking: false },
    ]);
    assert.deepEqual(a.refused, []);
  } finally {
    fwd.close();
    await a.close();
  }
});

test("forwarder: a TTS duration schedules the matching speaking:false", async () => {
  const a = await fakeAvatar();
  const fwd = vam.createVamForwarder({ base: a.base });
  try {
    await fwd.speakingStart("short line", 40);
    await new Promise((r) => setTimeout(r, 150));
    await fwd.drain();
    assert.deepEqual(a.received, [{ speaking: true, text: "short line" }, { speaking: false }]);
    assert.equal(fwd.isSpeaking(), false);
  } finally {
    fwd.close();
    await a.close();
  }
});

test("forwarder.fromDeskEvent: voice-state speaking EDGES, Aeon mood, react emotion -> look; body-only animations ignored", async () => {
  const a = await fakeAvatar();
  const fwd = vam.createVamForwarder({ base: a.base });
  const speakingState = { type: "state", state: { phase: "active", activity: "speaking", microphoneMuted: true, outputMuted: false } };
  const idleState = { type: "state", state: { phase: "active", activity: "idle", microphoneMuted: true, outputMuted: false } };
  try {
    fwd.fromDeskEvent(speakingState);
    assert.equal(fwd.fromDeskEvent(speakingState), null); // still speaking: no edge, no POST
    fwd.fromDeskEvent(idleState);
    fwd.fromDeskEvent({ type: "aeon-mood", mood: "pensive" });
    fwd.fromDeskEvent({ type: "animation", animation: "HAPPY", source: "react", emotion: "joy" });
    assert.equal(fwd.fromDeskEvent({ type: "animation", animation: "TALK" }), null);
    assert.equal(fwd.fromDeskEvent({ type: "audio-level", level: 0.4 }), null);
    await fwd.drain();
    assert.deepEqual(a.received, [
      { speaking: true },
      { speaking: false },
      { mood: "pensive" },
      { expression: "happy" },
    ]);
  } finally {
    fwd.close();
    await a.close();
  }
});

test("forwarder: a dead avatar server is a soft {ok:false}, logged once per distinct failure", async () => {
  const a = await fakeAvatar();
  const base = a.base;
  await a.close();
  const lines = [];
  const fwd = vam.createVamForwarder({ base, log: (...x) => lines.push(x.join(" ")) });
  const r1 = await fwd.expression("sad");
  const r2 = await fwd.expression("angry");
  assert.equal(r1.ok, false);
  assert.equal(r1.reason, "connection refused");
  assert.equal(r2.ok, false);
  assert.deepEqual(lines, ["vam-avatar post failed connection refused"]);
  fwd.close();
});

test("defaults are the DarkLink loopback ports", () => {
  assert.equal(vam.VAM_FRAMES_BASE, "http://127.0.0.1:9341");
  assert.equal(vam.VAM_AVATAR_BASE, "http://127.0.0.1:9342");
});
