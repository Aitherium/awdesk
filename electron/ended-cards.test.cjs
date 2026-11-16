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
const known = () => true; // this machine holds a trace of every test session
const live = (...ids) => new Map(ids.map((id) => [id, { status: "idle" }]));

test("a card from a running session is kept; an ended one needs a second look", () => {
  const seen = new Map();
  const cards = [card("d-1"), card("d-2")];
  const first = ended.plan(cards, live("s-d-1"), { seen, known, nowMs: NOW });
  assert.deepEqual(first.closed, [], "one look is never enough");
  assert.equal(first.held["d-1"], "its session is running");
  assert.equal(first.held["d-2"], "waiting for a second look");
  const second = ended.plan(cards, live("s-d-1"), { seen, known, nowMs: NOW + ended.CONFIRM_MS });
  assert.deepEqual(second.closed.map((c) => c.id), ["d-2"]);
});

test("a session that comes back between the two looks resets the clock", () => {
  const seen = new Map();
  ended.plan([card("d-2")], live(), { seen, known, nowMs: NOW });
  ended.plan([card("d-2")], live("s-d-2"), { seen, known, nowMs: NOW + 60_000 });
  const again = ended.plan([card("d-2")], live(), { seen, known, nowMs: NOW + ended.CONFIRM_MS });
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
  const opts = { seen, known, host: "my-pc", nowMs: NOW };
  ended.plan(cards, live(), opts);
  const r = ended.plan(cards, live(), { ...opts, nowMs: NOW + ended.CONFIRM_MS });
  assert.deepEqual(r.closed.map((c) => c.id), ["d-here"]);
  assert.equal(r.held["d-nosess"], "no session behind it");
  assert.equal(r.held["d-far"], "raised on another machine");
  assert.equal(r.held["d-new"], "inside the grace period");
});

test("a liveness read that could not be judged closes NOTHING (an empty map is not 'all ended')", () => {
  const seen = new Map();
  const r = ended.plan([card("d-1")], live(), { seen, known, nowMs: NOW, judged: false });
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
    assert.deepEqual(ended.sweep(cards, live(), { cancel, file, seen, known, nowMs: NOW }).closed, []);
    const done = ended.sweep(cards, live(), { cancel, file, seen, known, nowMs: NOW + ended.CONFIRM_MS });
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
      known,
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
    const r = ended.sweep([card("d-3")], live(), { cancel: () => false, file, seen, known, nowMs: NOW });
    assert.deepEqual(r.closed, []);
    assert.deepEqual(r.failed, ["d-3"]);
    const steps = fs.readFileSync(file, "utf8").trim().split("\n").map((l) => JSON.parse(l).step);
    assert.deepEqual(steps, ["closing", "cancel-failed"]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a session this machine has no trace of is never closed, even with an empty host", () => {
  const seen = new Map();
  // d-wsl: asked from WSL/awnix or a container agent: no Claude state file or transcript here.
  const cards = [card("d-wsl", { host: "" }), card("d-claude", { host: "" })];
  const opts = { seen, known: (id) => id === "s-d-claude", nowMs: NOW };
  ended.plan(cards, live(), opts);
  const r = ended.plan(cards, live(), { ...opts, nowMs: NOW + ended.CONFIRM_MS });
  assert.deepEqual(r.closed.map((c) => c.id), ["d-claude"]);
  assert.equal(r.held["d-wsl"], "no trace of that session on this machine");
  const none = ended.plan([card("d-x")], live(), { seen: new Map(), nowMs: NOW }); // no `known` at all
  assert.equal(none.held["d-x"], "no trace of that session on this machine");
});

test("a non-Claude session id (a harness name, not a uuid) is held", () => {
  const seen = new Map();
  const cards = [card("d-h", { sessionId: "awsh:codex:7" })];
  const opts = { seen, known: () => false, nowMs: NOW };
  ended.plan(cards, live(), opts);
  const r = ended.plan(cards, live(), { ...opts, nowMs: NOW + ended.CONFIRM_MS });
  assert.deepEqual(r.closed, []);
});

test("credential cards from an ended session stay listed until the owner closes them", () => {
  const seen = new Map();
  const cards = [
    card("d-key", { kind: "credential", title: "Stripe TEST key for the sticker service proof" }),
    card("d-sec", { secretName: "DISCORD_TOKEN" }),
    card("d-plain"),
  ];
  const opts = { seen, known, nowMs: NOW };
  ended.plan(cards, live(), opts);
  const r = ended.plan(cards, live(), { ...opts, nowMs: NOW + ended.CONFIRM_MS });
  assert.deepEqual(r.closed.map((c) => c.id), ["d-plain"]);
  assert.match(r.held["d-key"], /key request/);
  assert.match(r.held["d-sec"], /key request/);
});

// The real card shapes from the owner's store (2026-11-16): host set to this machine's
// name, a Claude session id, and NO state file or transcript left on this machine.
const HOST = "DESKTOP-EG38V5F";
const HOURS = (n) => NOW / 1000 - n * 3600;
const real = (id, extra = {}) => ({
  id, title: `real ${id}`, kind: "decision", agent: "aither", host: HOST,
  sessionId: `11111111-2222-4333-8444-${id.replace(/\D/g, "").padStart(12, "0")}`, createdAt: HOURS(74), ...extra,
});
const untraced = () => false;

test("an untraced grant / approval nobody answered for a day expires, with its own audit reason", () => {
  const { dir, file } = scratch();
  try {
    const cards = [
      real("d-1", { kind: "blocked", agent: "claude-permission-grant", title: "Allow Claude to use: Bash(MSYS_NO_PATHCONV=1 ...)" }),
      real("d-2", { kind: "blocked", agent: "claude-permission-grant", sessionId: "", createdAt: HOURS(59) }),
      real("d-3", { kind: "approval", createdAt: HOURS(30), title: "Reboot the PC to finish enabling Windows" }),
      real("d-4", { kind: "approval", createdAt: HOURS(12), title: "Rotate leaked awdiscord GitHub token" }),
      real("d-5", { kind: "decision", createdAt: HOURS(39) }),
      real("d-6", { kind: "credential", createdAt: HOURS(100) }),
      real("d-7", { kind: "blocked", agent: "claude-permission-grant", createdAt: HOURS(23) }),
    ];
    const seen = new Map();
    const calls = [];
    const opts = { cancel: (id, note) => { calls.push([id, note]); return true; }, file, seen, known: untraced, host: HOST };
    assert.deepEqual(ended.sweep(cards, live(), { ...opts, nowMs: NOW }).closed, [], "one look closes nothing");
    const r = ended.sweep(cards, live(), { ...opts, nowMs: NOW + ended.CONFIRM_MS });
    assert.deepEqual(r.closed.sort(), ["d-1", "d-2", "d-3"]);
    assert.match(r.held["d-4"], /no trace/, "12 h old: still waiting, still counted");
    assert.match(r.held["d-5"], /no trace/, "a plain decision from an unknown session is never expired");
    assert.match(r.held["d-6"], /key request/);
    assert.match(r.held["d-7"], /no trace/, "23 h old is inside the day");
    assert.ok(calls.every(([, note]) => /^expired:/.test(note)));
    const rows = fs.readFileSync(file, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    assert.deepEqual(rows.map((x) => x.id).sort(), ["d-1", "d-2", "d-3"]);
    assert.ok(rows.every((x) => /^expired/.test(x.reason) && x.step === "closing"));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("endedIds is exactly the traced, local, not-running, non-credential cards", () => {
  const cards = [
    real("d-1"), real("d-2"), real("d-3", { host: "other-pc" }), real("d-4", { kind: "credential" }),
    real("d-5", { sessionId: "" }), real("d-6"),
  ];
  const known6 = (id) => id !== cards[0].sessionId; // d-1 is unknown here
  const ids = ended.endedIds(cards, live(cards[5].sessionId), { host: HOST, known: known6 });
  assert.deepEqual([...ids], ["d-2"]);
  assert.equal(ended.endedIds(cards, live(), { host: HOST, known: known6, judged: false }).size, 0, "unreadable = empty");
});

const fwd = (p) => p.split(String.fromCharCode(92)).join("/");

test("the audit file follows AITHER_DECISIONS_DIR so a scratch run never touches the real trail", () => {
  const real_ = ended.auditFile("C:/home", {});
  assert.match(fwd(real_), /C:\/home\/\.aither\/decisions-audit\/ended-sessions\.jsonl$/);
  const scratchRun = ended.auditFile("C:/home", { AITHER_DECISIONS_DIR: "D:/tmp/store" });
  assert.match(fwd(scratchRun), /^D:\/tmp\/store\/_audit\//);
  assert.ok(!scratchRun.includes(".aither"));
  const forced = ended.auditFile("C:/home", { AITHER_DECISIONS_DIR: "D:/tmp/store", AITHER_DECISIONS_AUDIT_DIR: "D:/a" });
  assert.match(fwd(forced), /^D:\/a\/ended-sessions\.jsonl$/);
});
