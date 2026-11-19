"use strict";

// attention-log.cjs under node --test: the always-on nudge ledger writes one line per
// nudge, per outcome and per hold (deduped by reason), and rotates past its cap.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createAttentionLog } = require("./attention-log.cjs");

function tmpFile(name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "attention-log-"));
  return path.join(dir, name);
}

test("one line per nudge and outcome; a hold only when its reason changes or repeats after the gap", () => {
  const file = tmpFile("fairy-attention.log");
  let t = 1_800_000_000_000;
  const log = createAttentionLog({ file, now: () => t, repeatHoldMs: 10 * 60_000 });
  log.nudge({ id: "d-ennp", level: 3 });
  assert.equal(log.hold("nothing is due yet"), true);
  assert.equal(log.hold("nothing is due yet"), false, "the same hold is not re-logged every tick");
  assert.equal(log.hold("held while quiet: game on"), true, "a new reason is");
  t += 11 * 60_000;
  assert.equal(log.hold("held while quiet: game on"), true, "the same reason again after the gap");
  log.outcome({ id: "d-ennp", outcome: "close" });
  const lines = fs.readFileSync(file, "utf8").trim().split("\n");
  assert.equal(lines.length, 5);
  assert.match(lines[0], /^\d{4}-\d\d-\d\dT.* nudge \{"id":"d-ennp","level":3\}$/);
  assert.match(lines[1], / hold \{"reason":"nothing is due yet"\}$/);
  assert.match(lines[4], / end \{"id":"d-ennp","outcome":"close"\}$/);
  assert.equal(log.hold(""), false, "no reason, no line");
});

test("the log rotates to .1 past its cap and never throws on a bad path", () => {
  const file = tmpFile("fairy-attention.log");
  const log = createAttentionLog({ file, maxBytes: 200 });
  for (let i = 0; i < 20; i += 1) log.nudge({ id: `d-x${i}`, level: 1 });
  assert.ok(fs.existsSync(`${file}.1`), "rotated");
  assert.ok(fs.statSync(file).size < 400, "the live file stays small");
  const broken = createAttentionLog({ file: () => { throw new Error("no userData"); } });
  assert.doesNotThrow(() => broken.nudge({ id: "d-y" }));
});
