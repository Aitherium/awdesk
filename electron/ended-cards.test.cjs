"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const ended = require("./ended-cards.cjs");

const NOW = 1_800_000_000_000;
const OLD = NOW / 1000 - 3600; // an hour old: past the grace period
const card = (id, extra = {}) => ({ id, title: `card ${id}`, kind: "decision", sessionId: `s-${id}`, host: "", createdAt: OLD, ...extra });
const live = (...ids) => new Map(ids.map((id) => [id, { status: "idle" }]));

test("a card from a running session is kept; an ended one needs a second look", () => {
  const seen = new Map();
  const cards = [card("d-1"), card("d-2")];
  const first = ended.plan(cards, live("s-d-1"), { seen, nowMs: NOW });
  assert.deepEqual(first.closed, [], "one look is never enough");
  assert.equal(first.held["d-1"], "its session is running");
  assert.equal(first.held["d-2"], "waiting for a second look");
  const second = ended.plan(cards, live("s-d-1"), { seen, nowMs: NOW + ended.CONFIRM_MS });
  assert.deepEqual(second.closed.map((c) => c.id), ["d-2"]);
});

test("a session that comes back between the two looks resets the clock", () => {
  const seen = new Map();
  ended.plan([card("d-2")], live(), { seen, nowMs: NOW });
  ended.plan([card("d-2")], live("s-d-2"), { seen, nowMs: NOW + 60_000 });
  const again = ended.plan([card("d-2")], live(), { seen, nowMs: NOW + ended.CONFIRM_MS });
  assert.deepEqual(again.closed, [], "it was running in between, so the first look no longer counts");
});

test("cards with no session, another machine, or inside the grace period are never closed", () => {
  const seen = new Map();
  const cards = [
    card("d-nosess", { sessionId: "" }),
    card("d-far", { host: "other-pc" }),
    card("d-new", { createdAt: NOW / 1000 - 60 }),
    card("d-here", { host: "MY-PC.local" }),
  ];
  const opts = { seen, host: "my-pc", nowMs: NOW };
  ended.plan(cards, live(), opts);
  const r = ended.plan(cards, live(), { ...opts, nowMs: NOW + ended.CONFIRM_MS });
  assert.deepEqual(r.closed.map((c) => c.id), ["d-here"]);
  assert.equal(r.held["d-nosess"], "no session behind it");
  assert.equal(r.held["d-far"], "raised on another machine");
  assert.equal(r.held["d-new"], "inside the grace period");
});

test("a liveness read that could not be judged closes NOTHING (an empty map is not 'all ended')", () => {
  const seen = new Map();
  const r = ended.plan([card("d-1")], live(), { seen, nowMs: NOW, judged: false });
  assert.equal(r.judged, false);
  assert.deepEqual(r.closed, []);
  assert.equal(seen.size, 0, "and it remembers nothing, so the next good read starts its own two looks");
});

function scratch() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ended-cards-"));
  return { dir, file: path.join(dir, "audit", "ended.jsonl") };
}

test("sweep writes the audit line FIRST, then cancels with the reason; nothing is closed without the audit", () => {
  const { dir, file } = scratch();
  try {
    const seen = new Map();
    const calls = [];
    const cancel = (id, note) => { calls.push([id, note, fs.existsSync(file)]); return true; };
    const cards = [card("d-9", { kind: "blocked", title: "Allow Claude to use: Bash(gh api ...)" })];
    assert.deepEqual(ended.sweep(cards, live(), { cancel, file, seen, nowMs: NOW }).closed, []);
    const done = ended.sweep(cards, live(), { cancel, file, seen, nowMs: NOW + ended.CONFIRM_MS });
    assert.deepEqual(done.closed, ["d-9"]);
    assert.equal(calls.length, 1);
    assert.equal(calls[0][0], "d-9");
    assert.match(calls[0][1], /session ended/);
    assert.equal(calls[0][2], true, "the audit file existed before the cancel ran");
    const rows = fs.readFileSync(file, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    assert.equal(rows.length, 1);
    assert.equal(rows[0].id, "d-9");
    assert.equal(rows[0].title, "Allow Claude to use: Bash(gh api ...)");
    assert.equal(rows[0].sessionId, "s-d-9");
    assert.equal(rows[0].by, "desk:ended-sweep");

    const calls2 = [];
    const refused = ended.sweep([card("d-10")], live(), {
      cancel: (id) => { calls2.push(id); return true; },
      file,
      seen: new Map([["d-10", NOW - ended.CONFIRM_MS]]),
      nowMs: NOW,
      appendFn: () => { throw new Error("disk full"); },
    });
    assert.deepEqual(calls2, [], "audit failed: no card was closed");
    assert.match(refused.error, /nothing closed/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a cancel that fails is reported and audited, not counted as closed", () => {
  const { dir, file } = scratch();
  try {
    const seen = new Map([["d-3", NOW - ended.CONFIRM_MS]]);
    const r = ended.sweep([card("d-3")], live(), { cancel: () => false, file, seen, nowMs: NOW });
    assert.deepEqual(r.closed, []);
    assert.deepEqual(r.failed, ["d-3"]);
    const steps = fs.readFileSync(file, "utf8").trim().split("\n").map((l) => JSON.parse(l).step);
    assert.deepEqual(steps, ["closing", "cancel-failed"]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
