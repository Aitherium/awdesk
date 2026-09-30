"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { readFleetHostSummary, fleetHostLine, MAX_AGE_S } = require("./fleet-host-cache.cjs");

test("fleet-host cache: fresh summary read, stale and absent are null", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "fh-"));
  const env = { AITHER_HOME: home };
  assert.equal(readFleetHostSummary({ env }), null);
  const now = Date.now();
  fs.writeFileSync(path.join(home, "fleet-host-status.json"), JSON.stringify({
    distro: "aitheros-fleet", verdict: "HEALTHY", containers_running: "88",
    checked_epoch: Math.floor(now / 1000), extra: "not carried",
  }));
  const s = readFleetHostSummary({ env, nowMs: now });
  assert.equal(s.distro, "aitheros-fleet");
  assert.equal(s.extra, undefined);
  assert.match(fleetHostLine(s), /aitheros-fleet · HEALTHY · 88 containers/);
  assert.equal(readFleetHostSummary({ env, nowMs: now + (MAX_AGE_S + 5) * 1000 }), null);
  assert.match(fleetHostLine(null), /not checked recently/);
});
