"use strict";

/**
 * piano-core.cjs -- the pure half of the "Play notes" piano pad (piano.html).
 *
 * No electron, no DOM: note math, the computer-keyboard map, quantize, a Standard MIDI
 * File (format 0) encoder, a 16-bit PCM WAV encoder and an offline additive renderer so
 * WAV export never needs OfflineAudioContext. Loaded by node (tests) through
 * module.exports and by the page through <script src="piano-core.cjs"> as window.pianoCore.
 *
 * Event shape everywhere: {note: MIDI 0..127, velocity: 1..127, startMs, durMs}.
 */

/* global window */
(function () {
  const NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];

  /** MIDI note number -> frequency in Hz (A4 = 69 = 440 Hz). */
  function midiToFreq(n) {
    return 440 * Math.pow(2, (Number(n) - 69) / 12);
  }

  /** MIDI note number -> "C4" style name (C4 = 60). */
  function noteName(n) {
    const v = Math.round(Number(n));
    return NOTE_NAMES[((v % 12) + 12) % 12] + (Math.floor(v / 12) - 1);
  }

  /**
   * Computer keys -> MIDI at octave shift 0 (DAW layout): home row is white keys,
   * the row above is black keys. z / x shift the octave (handled by the page).
   */
  const keyMap = Object.freeze({
    a: 60, w: 61, s: 62, e: 63, d: 64, f: 65, t: 66, g: 67, y: 68, h: 69, u: 70, j: 71, k: 72,
  });
  const OCTAVE_KEYS = Object.freeze({ z: -1, x: 1 });

  /**
   * Snap start and duration to a grid.
   * @param {Array} events recorded events
   * @param {number} bpm tempo
   * @param {number} grid subdivisions per quarter note (4 = sixteenths)
   * @returns {Array} new events, start/dur rounded to the grid, dur >= one step
   */
  function quantize(events, bpm = 120, grid = 4) {
    const step = 60000 / Math.max(1, Number(bpm) || 120) / Math.max(1, Number(grid) || 4);
    return (events || []).map((ev) => ({
      ...ev,
      startMs: Math.round(ev.startMs / step) * step,
      durMs: Math.max(step, Math.round(ev.durMs / step) * step),
    }));
  }

  /** Variable-length quantity (MIDI delta times), 7 bits per byte, big-endian. */
  function encodeVlq(value) {
    let v = Math.max(0, Math.floor(Number(value) || 0));
    const out = [v & 0x7f];
    v = Math.floor(v / 128);
    while (v > 0) {
      out.unshift((v & 0x7f) | 0x80);
      v = Math.floor(v / 128);
    }
    return out;
  }

  function u32(n) { return [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff]; }
  function u16(n) { return [(n >>> 8) & 0xff, n & 0xff]; }
  function ascii(s) { return Array.from(s, (c) => c.charCodeAt(0)); }

  /**
   * Standard MIDI File, format 0, one track: tempo meta, program change, note on/off.
   * @returns {Uint8Array}
   */
  function encodeMidi(events, opts = {}) {
    const bpm = Number(opts.bpm) > 0 ? Number(opts.bpm) : 120;
    const ppq = Number(opts.ppq) > 0 ? Math.floor(Number(opts.ppq)) : 480;
    const program = Math.max(0, Math.min(127, Math.floor(Number(opts.program) || 0)));
    const msToTicks = (ms) => Math.max(0, Math.round((ms * ppq * bpm) / 60000));
    const usPerQuarter = Math.round(60000000 / bpm);

    const msgs = [];
    for (const ev of events || []) {
      const note = Math.max(0, Math.min(127, Math.round(ev.note)));
      const vel = Math.max(1, Math.min(127, Math.round(ev.velocity || 100)));
      const on = msToTicks(ev.startMs);
      const off = Math.max(on + 1, msToTicks(ev.startMs + ev.durMs));
      msgs.push({ tick: on, order: 1, bytes: [0x90, note, vel] });
      msgs.push({ tick: off, order: 0, bytes: [0x80, note, 0] });
    }
    // offs before ons at the same tick so a repeated note re-triggers cleanly
    msgs.sort((a, b) => a.tick - b.tick || a.order - b.order);

    const track = [
      0x00, 0xff, 0x51, 0x03, (usPerQuarter >>> 16) & 0xff, (usPerQuarter >>> 8) & 0xff, usPerQuarter & 0xff,
      0x00, 0xc0, program,
    ];
    let last = 0;
    for (const m of msgs) {
      track.push(...encodeVlq(m.tick - last), ...m.bytes);
      last = m.tick;
    }
    track.push(0x00, 0xff, 0x2f, 0x00);

    const head = [...ascii("MThd"), ...u32(6), ...u16(0), ...u16(1), ...u16(ppq)];
    return Uint8Array.from([...head, ...ascii("MTrk"), ...u32(track.length), ...track]);
  }

  /** 16-bit PCM mono RIFF/WAVE from float samples in [-1, 1]. */
  function encodeWav(samples, sampleRate = 44100) {
    const n = samples.length;
    const buf = new ArrayBuffer(44 + n * 2);
    const dv = new DataView(buf);
    const str = (off, s) => { for (let i = 0; i < s.length; i++) dv.setUint8(off + i, s.charCodeAt(i)); };
    str(0, "RIFF"); dv.setUint32(4, 36 + n * 2, true); str(8, "WAVE");
    str(12, "fmt "); dv.setUint32(16, 16, true); dv.setUint16(20, 1, true); dv.setUint16(22, 1, true);
    dv.setUint32(24, sampleRate, true); dv.setUint32(28, sampleRate * 2, true);
    dv.setUint16(32, 2, true); dv.setUint16(34, 16, true);
    str(36, "data"); dv.setUint32(40, n * 2, true);
    for (let i = 0; i < n; i++) {
      const s = Math.max(-1, Math.min(1, samples[i] || 0));
      dv.setInt16(44 + i * 2, s < 0 ? Math.round(s * 0x8000) : Math.round(s * 0x7fff), true);
    }
    return new Uint8Array(buf);
  }

  /** Total length of a melody in ms (last note end + release tail). */
  const RELEASE_MS = 200;
  function totalMs(events) {
    let end = 0;
    for (const ev of events || []) end = Math.max(end, ev.startMs + ev.durMs);
    return end > 0 ? end + RELEASE_MS : 0;
  }

  /**
   * Offline additive render (sine + 2 harmonics, ADSR) for WAV export.
   * Length = ceil(totalMs(events) * sr / 1000).
   */
  function renderMelody(events, sampleRate = 44100) {
    const sr = sampleRate;
    const out = new Float32Array(Math.ceil((totalMs(events) * sr) / 1000));
    const A = 0.01, D = 0.12, S = 0.6, R = RELEASE_MS / 1000;
    for (const ev of events || []) {
      const f = midiToFreq(ev.note);
      const amp = 0.25 * Math.max(0.05, Math.min(1, (ev.velocity || 100) / 127));
      const start = Math.floor((ev.startMs * sr) / 1000);
      const hold = ev.durMs / 1000;
      const len = Math.ceil((hold + R) * sr);
      for (let i = 0; i < len && start + i < out.length; i++) {
        const t = i / sr;
        let env;
        if (t < A) env = t / A;
        else if (t < A + D) env = 1 - (1 - S) * ((t - A) / D);
        else env = S;
        if (t > hold) env = Math.max(0, (t < A + D ? env : S) * (1 - (t - hold) / R));
        const w = 2 * Math.PI * f * t;
        out[start + i] += amp * env * (Math.sin(w) + 0.5 * Math.sin(2 * w) + 0.25 * Math.sin(3 * w)) / 1.75;
      }
    }
    for (let i = 0; i < out.length; i++) out[i] = Math.max(-1, Math.min(1, out[i]));
    return out;
  }

  /** Base64 for large byte arrays (chunked so String.fromCharCode never overflows). */
  function bytesToB64(bytes) {
    if (typeof Buffer !== "undefined") return Buffer.from(bytes).toString("base64");
    let s = "";
    for (let i = 0; i < bytes.length; i += 0x8000) {
      s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    }
    return btoa(s);
  }

  const api = {
    NOTE_NAMES, midiToFreq, noteName, keyMap, OCTAVE_KEYS, quantize, encodeVlq,
    encodeMidi, encodeWav, renderMelody, totalMs, bytesToB64,
  };
  if (typeof module !== "undefined") module.exports = api;
  else window.pianoCore = api;
})();
