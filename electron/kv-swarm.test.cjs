"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { readKvSwarm, summarizeKvSwarm } = require("./kv-swarm.cjs");

const snap = (over = {}) => JSON.stringify({
  relay: "wss://relay.example.invalid/holder",
  updated: 1000,
  identity: { ok: true, error: null },
  pending: ["kvh-pixel9"],
  swarm: {
    holders: [{ device_id: "kvh-fold", device: "kvh-fold (webgpu-f16)", held: 4096, used_bytes: 1 << 20, max_bytes: 2 ** 31, last_ms: 4.2, seen_s: 0.4 }],
    lent_bytes: 2 ** 31, used_bytes: 1 << 20, broken: null,
  },
  ...over,
});

test("a live snapshot reads as running, by device id", () => {
  const s = readKvSwarm({ file: "x", now: 1_004_000, readImpl: () => snap() });
  assert.equal(s.running, true);
  assert.equal(s.holders[0].device, "kvh-fold");
  assert.equal(summarizeKvSwarm(s), "KV 1 phone 2.0 GB lent, 1 waiting for you");
});

test("a snapshot that stopped updating is the relay being off", () => {
  const s = readKvSwarm({ file: "x", now: 1_000_000 + 60_000, readImpl: () => snap() });
  assert.equal(s.running, false);
  assert.equal(summarizeKvSwarm(s), "KV relay off");
});

test("no file is silence on the Fleet line, never a throw", () => {
  const s = readKvSwarm({ file: "x", readImpl: () => { const e = new Error("no"); e.code = "ENOENT"; throw e; } });
  assert.deepEqual([s.running, summarizeKvSwarm(s)], [false, ""]);
});
