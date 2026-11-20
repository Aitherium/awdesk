"use strict";

// Regression guard for the 2026-11-20 "Desk loses itself at 400 MB" bug.
//
// The avatar-library seed used to read EVERY model.vrm whole (readFileSync) on the
// Electron main thread and hold the Buffers while each upload was in flight. On the
// owner's desk (93 characters, 2.0 GB of models, largest 63 MiB) one pass walked the
// main process 150 -> 655 MB, and the resource watchdog read that ramp as a runaway
// (+400 MB in a minute) and restarted/quit the desk.
//
// These assertions are deliberately generous (a slow CI box must not flake) but they are
// orders of magnitude below the old behaviour: the old pass held every model at once and
// blocked the event loop for the whole read.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "awdesk-seed-soak-"));
process.env.DESK_ROSTER_DIR = ROOT;
const sync = require("./avatar-catalog-sync.cjs");

const MB = 1024 * 1024;

/** Write a VRM-shaped GLB of `size` bytes WITHOUT allocating `size` in this test process. */
function writeGlb(file, size, json = { asset: { version: "2.0" } }) {
  const body = Buffer.from(JSON.stringify(json), "utf8");
  const pad = (4 - (body.length % 4)) % 4;
  const jsonChunk = Buffer.concat([body, Buffer.alloc(pad, 0x20)]);
  const head = Buffer.alloc(20);
  head.writeUInt32LE(0x46546c67, 0); // glTF
  head.writeUInt32LE(2, 4);
  head.writeUInt32LE(size, 8);
  head.writeUInt32LE(jsonChunk.length, 12);
  head.writeUInt32LE(0x4e4f534a, 16); // JSON
  const fd = fs.openSync(file, "w");
  try {
    fs.writeSync(fd, head);
    fs.writeSync(fd, jsonChunk);
    const chunk = Buffer.alloc(1 * MB);
    let written = head.length + jsonChunk.length;
    while (written < size) {
      const n = Math.min(chunk.length, size - written);
      fs.writeSync(fd, chunk, 0, n);
      written += n;
    }
  } finally {
    fs.closeSync(fd);
  }
}

function character(name, size, record = {}) {
  const dir = path.join(ROOT, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "character.json"), JSON.stringify({ display_name: name, rating: "general", ...record }));
  writeGlb(path.join(dir, "model.vrm"), size);
}

/** One library for the whole file: a stamp written in one test stays valid in the next. */
const LIBRARY = [];
function fakeClient({ uploadMs = 25 } = {}) {
  const calls = { upload: 0 };
  const held = LIBRARY;
  return {
    calls,
    held,
    async avatarLibrary() { return { ok: true, avatars: [...held], active: null }; },
    async uploadAvatar() {
      calls.upload += 1;
      await new Promise((r) => setTimeout(r, uploadMs)); // the bytes live across the await, like a fetch
      const record = { id: `lib-${held.length + 1}`, sha256: "" };
      held.push(record);
      return { ok: true, record };
    },
  };
}

function meter() {
  const state = { peakExternal: 0, peakArrayBuffers: 0, maxLag: 0 };
  let expected = Date.now();
  const baseline = process.memoryUsage();
  const tick = () => {
    const now = Date.now();
    state.maxLag = Math.max(state.maxLag, now - expected);
    expected = now + 50;
    const m = process.memoryUsage();
    state.peakExternal = Math.max(state.peakExternal, m.external);
    state.peakArrayBuffers = Math.max(state.peakArrayBuffers, m.arrayBuffers);
  };
  const timer = setInterval(tick, 50);
  return {
    state,
    baseline,
    stop() { clearInterval(timer); tick(); return state; },
  };
}

test.after(() => fs.rmSync(ROOT, { recursive: true, force: true }));

test("a pass over 6 x 24 MB holds a bounded amount of memory and never blocks the loop", async () => {
  for (let i = 0; i < 6; i += 1) character(`model-${i}`, 24 * MB);
  const client = fakeClient();
  const m = meter();
  const out = await sync.seedLibraryFromDesk({ client });
  const state = m.stop();
  assert.equal(out.ok, true);
  assert.equal(out.uploaded, 6);
  assert.equal(client.calls.upload, 6);
  // 144 MB of models passed through; the old code held all of them at once. The bounds
  // are generous on purpose: a shared Windows CI runner measured 790 ms of timer delay
  // on this pass (2026-11-20 release run 44809442506) -- still a tenth of the 45 s hang
  // watchdog, and nothing like the old whole-file read. Flake the GATE, never the desk.
  const externalGrowthMb = (state.peakExternal - m.baseline.external) / MB;
  assert.ok(externalGrowthMb < 300, `peak external grew ${externalGrowthMb.toFixed(0)} MB (bound 300)`);
  assert.ok(state.maxLag < 2500, `the main thread stalled ${state.maxLag} ms (bound 2500)`);
});

test("a stamped model is never read again: the second pass is free", async () => {
  const before = (() => {
    const dirs = fs.readdirSync(ROOT).filter((d) => fs.existsSync(path.join(ROOT, d, "model.vrm")));
    return dirs.length;
  })();
  const client = fakeClient();
  const again = await sync.seedLibraryFromDesk({ client });
  assert.equal(again.uploaded, 0);
  assert.equal(again.present, before);
  assert.equal(again.bytesRead, 0, "a folder stamped last pass costs no file read");
  assert.equal(client.calls.upload, 0);
});

test("a local-only body is refused from its GLB JSON chunk, before any hashing", async () => {
  const name = "imported-body";
  character(name, 20 * MB, { source: "import" });
  writeGlb(path.join(ROOT, name, "model.vrm"), 20 * MB, {
    asset: { version: "2.0", extras: { dm_import: { local_only: true, not_for_distribution: true } } },
  });
  const client = fakeClient();
  const out = await sync.seedLibraryFromDesk({ client });
  const row = out.results.find((r) => r.name === name);
  assert.equal(row.skipped, "a local-only imported body, never uploaded");
  assert.equal(client.calls.upload, 0);
  // The prefix is read (a few KiB of JSON), never the 20 MB mesh.
  assert.ok(out.bytesRead < 1 * MB, `read ${out.bytesRead} bytes for a refused body`);
});

test("a pass stops at the byte budget and the next tick finishes the rest", async () => {
  for (let i = 0; i < 6; i += 1) character(`over-budget-${i}`, 8 * MB);
  const client = fakeClient({ uploadMs: 5 });
  // 10 MB budget: two 8 MB models are read, the pass then defers the rest.
  const first = await sync.seedLibraryFromDesk({ client, maxSeedBytes: 10 * MB });
  assert.ok(first.deferred >= 1, `expected deferred rows, got ${first.deferred}`);
  const second = await sync.seedLibraryFromDesk({ client, maxSeedBytes: 10 * MB });
  assert.ok(second.deferred >= 1);
  const third = await sync.seedLibraryFromDesk({ client, maxSeedBytes: 10 * MB });
  assert.equal(third.deferred, 0, "the pass that finishes the roster has nothing left");
  assert.equal(third.uploaded, 2, "the last two models are uploaded by the finishing pass");
  assert.equal(third.present, 10, "6 from the first test + the 4 stamped by earlier budget passes");
});
