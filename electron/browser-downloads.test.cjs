"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { MAX_ROWS, createDownloads } = require("./browser-downloads.cjs");

test("a download is a row from start to done, newest first", () => {
  const d = createDownloads({ now: () => 5 });
  const a = d.start({ filename: "a.vrm", url: "https://hub.test/a", total: 100 });
  const b = d.start({ filename: "b.zip", url: "https://x.test/b" });
  d.update(a, { received: 40 });
  d.update(a, { state: "completed", received: 100, path: "C:/Users/me/Downloads/a.vrm" });
  assert.deepEqual(d.list().map((r) => [r.id, r.state]), [[b, "progressing"], [a, "completed"]]);
  assert.equal(d.get(a).path, "C:/Users/me/Downloads/a.vrm");
  d.update(b, { state: "nonsense" });
  assert.equal(d.get(b).state, "progressing", "an unknown state is ignored");
});

test("an agent's download is a visible BLOCKED row, never silently gone, and stays blocked", () => {
  const d = createDownloads();
  const id = d.start({ filename: "payload.exe", url: "https://evil.test/p", blocked: true });
  assert.equal(d.get(id).state, "blocked");
  assert.equal(d.update(id, { state: "completed" }), false);
  assert.equal(d.get(id).state, "blocked");
});

test("finished rows clear, running ones stay, and the shelf is capped", () => {
  const d = createDownloads();
  const running = d.start({ filename: "big.iso" });
  const done = d.start({ filename: "x" });
  d.update(done, { state: "completed" });
  d.clearFinished();
  assert.deepEqual(d.list().map((r) => r.id), [running]);
  for (let i = 0; i < MAX_ROWS + 5; i += 1) d.start({ filename: `f${i}` });
  assert.equal(d.list().length, MAX_ROWS);
});
