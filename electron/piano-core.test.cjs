"use strict";

/**
 * piano-core tests -- MIDI/WAV encoders and note math for the "Play notes" pad.
 *
 *   node --test electron/piano-core.test.cjs
 */

const assert = require("node:assert/strict");
const test = require("node:test");
const core = require("./piano-core.cjs");

const str = (bytes, off, len) => String.fromCharCode(...bytes.subarray(off, off + len));
const u32be = (b, o) => ((b[o] << 24) >>> 0) + (b[o + 1] << 16) + (b[o + 2] << 8) + b[o + 3];
const u16be = (b, o) => (b[o] << 8) + b[o + 1];

/** Parse the single MTrk into [{delta, status, data}] (channel + meta only). */
function parseTrack(bytes) {
  assert.equal(str(bytes, 14, 4), "MTrk");
  const len = u32be(bytes, 18);
  let i = 22;
  const end = 22 + len;
  const out = [];
  while (i < end) {
    let delta = 0;
    let b;
    do { b = bytes[i++]; delta = delta * 128 + (b & 0x7f); } while (b & 0x80);
    const status = bytes[i++];
    if (status === 0xff) {
      const type = bytes[i++];
      const l = bytes[i++];
      out.push({ delta, status, type, data: Array.from(bytes.subarray(i, i + l)) });
      i += l;
    } else {
      const n = (status & 0xf0) === 0xc0 ? 1 : 2;
      out.push({ delta, status, data: Array.from(bytes.subarray(i, i + n)) });
      i += n;
    }
  }
  assert.equal(i, end, "track length matches its contents");
  return out;
}

test("midiToFreq(69) = 440 and octaves double", () => {
  assert.equal(core.midiToFreq(69), 440);
  assert.ok(Math.abs(core.midiToFreq(81) - 880) < 1e-9);
  assert.ok(Math.abs(core.midiToFreq(60) - 261.6256) < 1e-3);
  assert.equal(core.noteName(60), "C4");
  assert.equal(core.NOTE_NAMES.length, 12);
});

test("keyMap is a DAW two-row layout C4..C5", () => {
  assert.equal(core.keyMap.a, 60);
  assert.equal(core.keyMap.w, 61);
  assert.equal(core.keyMap.k, 72);
  assert.equal(Object.keys(core.keyMap).length, 13);
  assert.deepEqual(core.OCTAVE_KEYS, { z: -1, x: 1 });
});

test("MIDI header: MThd, length 6, format 0, one track, ppq", () => {
  const b = core.encodeMidi([{ note: 60, velocity: 100, startMs: 0, durMs: 500 }], { ppq: 96 });
  assert.equal(str(b, 0, 4), "MThd");
  assert.equal(u32be(b, 4), 6);
  assert.equal(u16be(b, 8), 0);
  assert.equal(u16be(b, 10), 1);
  assert.equal(u16be(b, 12), 96);
  assert.equal(u16be(core.encodeMidi([]), 12), 480);
});

test("two-note melody: two note-ons, two note-offs, deltas in ticks", () => {
  // 120 bpm, ppq 480 -> 500 ms = 480 ticks
  const b = core.encodeMidi([
    { note: 60, velocity: 100, startMs: 0, durMs: 500 },
    { note: 64, velocity: 90, startMs: 500, durMs: 250 },
  ], { bpm: 120, ppq: 480 });
  const evs = parseTrack(b);
  const tempo = evs.find((e) => e.status === 0xff && e.type === 0x51);
  assert.deepEqual(tempo.data, [0x07, 0xa1, 0x20]); // 500000 us/quarter
  const notes = evs.filter((e) => (e.status & 0xf0) === 0x90 || (e.status & 0xf0) === 0x80);
  assert.equal(notes.filter((e) => e.status === 0x90).length, 2);
  assert.equal(notes.filter((e) => e.status === 0x80).length, 2);
  assert.deepEqual(notes.map((e) => [e.status, e.data[0], e.delta]), [
    [0x90, 60, 0],
    [0x80, 60, 480],
    [0x90, 64, 0],
    [0x80, 64, 240],
  ]);
  const last = evs[evs.length - 1];
  assert.equal(last.status, 0xff);
  assert.equal(last.type, 0x2f);
});

test("variable-length quantity encoding", () => {
  assert.deepEqual(core.encodeVlq(0), [0x00]);
  assert.deepEqual(core.encodeVlq(127), [0x7f]);
  assert.deepEqual(core.encodeVlq(128), [0x81, 0x00]);
  assert.deepEqual(core.encodeVlq(16383), [0xff, 0x7f]);
  assert.deepEqual(core.encodeVlq(2097151), [0xff, 0xff, 0x7f]);
});

test("WAV header chunks and sizes match", () => {
  const samples = new Float32Array([0, 0.5, -0.5, 1, -1, 2]);
  const b = core.encodeWav(samples, 22050);
  const dv = new DataView(b.buffer);
  assert.equal(str(b, 0, 4), "RIFF");
  assert.equal(dv.getUint32(4, true), b.length - 8);
  assert.equal(str(b, 8, 4), "WAVE");
  assert.equal(str(b, 12, 4), "fmt ");
  assert.equal(dv.getUint32(16, true), 16);
  assert.equal(dv.getUint16(20, true), 1);
  assert.equal(dv.getUint16(22, true), 1);
  assert.equal(dv.getUint32(24, true), 22050);
  assert.equal(dv.getUint16(34, true), 16);
  assert.equal(str(b, 36, 4), "data");
  assert.equal(dv.getUint32(40, true), samples.length * 2);
  assert.equal(b.length, 44 + samples.length * 2);
  assert.equal(dv.getInt16(44 + 3 * 2, true), 32767);
  assert.equal(dv.getInt16(44 + 4 * 2, true), -32768);
  assert.equal(dv.getInt16(44 + 5 * 2, true), 32767, "clipped");
});

test("renderMelody length = ceil(totalMs*sr/1000) and stays in range", () => {
  const evs = [
    { note: 60, velocity: 100, startMs: 0, durMs: 300 },
    { note: 67, velocity: 127, startMs: 250, durMs: 333 },
  ];
  const sr = 8000;
  const out = core.renderMelody(evs, sr);
  assert.equal(out.length, Math.ceil((core.totalMs(evs) * sr) / 1000));
  let peak = 0;
  for (const v of out) peak = Math.max(peak, Math.abs(v));
  assert.ok(peak > 0.01 && peak <= 1);
  assert.equal(core.renderMelody([], sr).length, 0);
});

test("quantize snaps to the grid with a minimum one-step duration", () => {
  // 120 bpm, grid 4 -> 125 ms steps
  const q = core.quantize([{ note: 60, velocity: 100, startMs: 130, durMs: 20 }], 120, 4);
  assert.equal(q[0].startMs, 125);
  assert.equal(q[0].durMs, 125);
  assert.equal(q[0].note, 60);
});

test("bytesToB64 round-trips a large array", () => {
  const big = new Uint8Array(200000).map((_, i) => i & 0xff);
  const b64 = core.bytesToB64(big);
  assert.deepEqual(new Uint8Array(Buffer.from(b64, "base64")), big);
});
