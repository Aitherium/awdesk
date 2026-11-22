"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const core = require("./spirit-core.cjs");

// ── spirit.go's argument ────────────────────────────────────────────────────

test("an agent may send JSON, and a plain sentence is a search", () => {
  const json = core.parseArg('{"kind":"file","target":"C:\\\\notes.md","question":"what is it","requester":"atlas","slotId":"slot2"}');
  assert.equal(json.ok, true);
  assert.equal(json.request.kind, "file");
  assert.equal(json.request.target, "C:\\notes.md");
  assert.equal(json.request.question, "what is it");
  assert.equal(json.request.requester, "atlas");
  assert.equal(json.request.slotId, "slot2");

  const sentence = core.parseArg("go find notes.md");
  assert.equal(sentence.ok, true);
  assert.equal(sentence.request.kind, "search");
  assert.equal(sentence.request.target, "go find notes.md");
});

test("a spirit command that cannot be run says why, in the request", () => {
  assert.equal(core.parseArg("").ok, false);
  assert.match(core.parseArg("   ").error, /something to do/);
  assert.match(core.parseArg('{"kind":"teleport","target":"x"}').error, /unknown spirit kind/);
  assert.match(core.parseArg('{"kind":"file"}').error, /needs a target/);
  assert.equal(core.parseArg({ kind: "region" }).ok, true, "a region trip needs no target");
  assert.match(core.parseArg([1, 2]).error, /JSON object/);
});

test("a trip is normalized: id, kind, question, requester and slot", () => {
  const trip = core.normalizeTrip({ kind: "web", target: "bonsai 2", requester: "iris", slot: "slot3" }, 1234);
  assert.match(trip.id, /^trip-1234-/);
  assert.equal(trip.kind, "web");
  assert.equal(trip.target, "bonsai 2");
  assert.equal(trip.slotId, "slot3");
  assert.equal(core.normalizeTrip({ kind: "nope", target: "x" }, 1).kind, "search");
});

// ── one trip at a time, the rest wait ──────────────────────────────────────

test("the trip queue runs one at a time and says how many wait", () => {
  const q = core.createTripQueue();
  const a = core.enqueue(q, { kind: "search", target: "a" });
  const b = core.enqueue(q, { kind: "search", target: "b" });
  assert.equal(a.position, 1);
  assert.equal(b.position, 2);
  assert.equal(core.queueLine(q), "2 more trips waiting");
  assert.equal(core.dequeue(q).id, a.trip.id);
  assert.equal(core.queueLine(q), "1 more trip waiting");
  assert.equal(core.dequeue(q), null, "a second dequeue while one runs takes nothing");
  core.finish(q, a.trip.id);
  assert.equal(core.dequeue(q).id, b.trip.id);
  core.finish(q, b.trip.id);
  assert.equal(core.queueCount(q), 0);
  assert.equal(core.queueLine(q), "");
});

test("bounded queue drops the oldest, and cancel leaves the rest waiting", () => {
  const q = core.createTripQueue({ max: 2 });
  core.enqueue(q, { kind: "search", target: "a" });
  core.enqueue(q, { kind: "search", target: "b" });
  core.enqueue(q, { kind: "search", target: "c" });
  assert.deepEqual(q.items.map((t) => t.target), ["b", "c"]);
  assert.equal(core.dequeue(q).target, "b");
  assert.equal(core.cancel(q, "wrong-id").ok, false);
  assert.equal(core.cancel(q, q.cur.id).ok, true);
  assert.equal(q.cur, null);
  assert.equal(q.items.length, 1, "cancelling one trip does not abandon the rest");
});

// ── the visible log ────────────────────────────────────────────────────────

test("the trip log keeps five and counts the rest as +N more", () => {
  const log = core.createTripLog();
  for (let i = 0; i < 8; i += 1) core.logTrip(log, { label: `trip ${i}`, ok: i !== 6 }, i);
  const view = core.logView(log);
  assert.equal(view.items.length, 5);
  assert.equal(view.items[0].label, "trip 7");
  assert.equal(view.items[1].ok, false, "a failed trip keeps its flag");
  assert.equal(view.more, 3);
  assert.equal(view.moreLine, "+3 more");
});

// ── flight ─────────────────────────────────────────────────────────────────

test("a flight arcs between two points and never jumps", () => {
  const from = { x: 100, y: 900 };
  const to = { x: 2100, y: 400 };
  const path = core.flightPath(from, to);
  assert.deepEqual(core.pointAt(path, 0), from);
  assert.deepEqual(core.pointAt(path, 1), to);
  const mid = core.pointAt(path, core.easeInOut(0.5));
  assert.ok(mid.x > from.x && mid.x < to.x);
  assert.ok(mid.y < from.y + 1, "the arc rises off the straight line");
  const duration = core.flightDurationMs(from, to);
  assert.ok(duration >= 600 && duration <= 2200);
  assert.equal(core.returnDurationMs(), 480);
});

test("easeInOut is pinned at 0 and 1 and monotonic-ish in between", () => {
  assert.equal(core.easeInOut(0), 0);
  assert.equal(core.easeInOut(1), 1);
  assert.equal(core.easeInOut(-5), 0);
  const a = core.easeInOut(0.25);
  const b = core.easeInOut(0.75);
  assert.ok(a < b && a > 0 && b < 1);
});

// ── attach ─────────────────────────────────────────────────────────────────

test("a drop prefers an avatar, then a desk window, then the smallest window", () => {
  const point = { x: 300, y: 300 };
  const big = { kind: "window", title: "Chrome", bounds: { x: 0, y: 0, width: 1200, height: 900 } };
  const small = { kind: "window", title: "Notepad", bounds: { x: 200, y: 200, width: 300, height: 300 } };
  const desk = { kind: "desk", title: "Board", bounds: { x: 0, y: 0, width: 1000, height: 800 } };
  const avatar = { kind: "avatar", slotId: "slot1", bounds: { x: 240, y: 240, width: 320, height: 520 } };
  assert.equal(core.pickAttachTarget(point, [big, small]).title, "Notepad");
  // A desk window outranks an external one by design: it is the surface the
  // owner lives in and the one the spirit can follow without the OS probe.
  assert.equal(core.pickAttachTarget(point, [big, small, desk]).title, "Board");
  assert.equal(core.pickAttachTarget(point, [big, small, desk, avatar]).slotId, "slot1");
  assert.equal(core.pickAttachTarget({ x: 2000, y: 2000 }, [big, small]), null);
  assert.equal(core.pickAttachTarget(point, [{ kind: "window", bounds: { width: 0, height: 0 } }]), null);
});

test("the dock sits on an avatar's shoulder and a window's top-right", () => {
  const size = { width: 72, height: 72 };
  const avatar = core.dockPosition({ kind: "avatar", bounds: { x: 100, y: 200, width: 400, height: 600 } }, size);
  assert.ok(avatar.x > 100 + 400 - 72 * 0.6, "against the right edge");
  assert.ok(avatar.y > 200 && avatar.y < 200 + 600 * 0.3);
  const win = core.dockPosition({ kind: "window", bounds: { x: 0, y: 0, width: 1000, height: 800 } }, size);
  assert.deepEqual(win, { x: 1000 - 72 - 14, y: 14 });
  assert.equal(core.attachLabel(null), "free");
  assert.match(core.attachLabel({ kind: "avatar", title: "Iris" }), /Iris/);
});

// ── guardrails ─────────────────────────────────────────────────────────────

test("credentials are refused before anything is opened", () => {
  const refused = [
    "C:\\Users\\wzns\\.env",
    "C:\\Users\\wzns\\.env.local",
    "C:\\keys\\server.pem",
    "C:\\keys\\id_rsa",
    "C:\\Users\\wzns\\.ssh\\config",
    "C:\\Users\\wzns\\credentials.json",
    "C:\\AitherOS\\.aither\\session-bearer",
    "C:\\app\\my-secret-notes.txt",
  ];
  for (const file of refused) {
    const verdict = core.secretPathReason(file);
    assert.ok(verdict, `${file} must be refused`);
    assert.equal(verdict.line, "1 file refused — it looks like a credential");
  }
  assert.equal(core.secretPathReason("C:\\Projects\\notes.md"), null);
  assert.equal(core.secretPathReason("C:\\Projects\\secretary\\agenda.md"), null, "a word, not a credential");
  assert.ok(core.secretPathReason("C:/keys/id_rsa.pub"), "the .pub twin is refused too");
});

// ── results as rows ────────────────────────────────────────────────────────

test("universal-search groups become top five and +N more", () => {
  const run = {
    ok: true,
    query: "notes",
    groups: [
      { id: "files", total: 7, items: [
        { kind: "file", title: "notes.md", target: "C:\\a\\notes.md" },
        { kind: "file", title: "notes.txt", target: "C:\\a\\notes.txt" },
      ] },
      { id: "screenshots", total: 3, items: [
        { kind: "screenshot", title: "shot", target: "C:\\s\\shot.png" },
      ] },
      { id: "apps", total: 1, items: [
        { kind: "app", title: "Notes", target: "C:\\Apps\\notes.exe" },
      ] },
      { id: "web", total: 99, items: [{ title: "ignored", target: "x" }] },
    ],
  };
  const rows = core.fileRows(run);
  assert.equal(rows.ok, true);
  assert.deepEqual(rows.rows.map((r) => r.title), ["notes.md", "notes.txt", "shot", "Notes"]);
  assert.equal(rows.total, 11);
  assert.equal(rows.more, 7);
  assert.equal(core.fileRows({ ok: false, reason: "index gone" }).ok, false);
});

test("duplicate paths collapse, and one group's page is still cut at five", () => {
  const run = { ok: true, groups: [
    { id: "files", total: 9, items: Array.from({ length: 9 }, (_, i) => ({ title: `f${i}`, target: `C:\\same\\f${i}.md` })) },
  ] };
  const got = core.fileRows(run);
  assert.equal(got.rows.length, 5);
  assert.equal(got.more, 4);
  const dupes = core.fileRows({ ok: true, groups: [
    { id: "files", total: 2, items: [{ title: "a", target: "C:\\A.md" }, { title: "a again", target: "c:\\a.md" }] },
  ] });
  assert.equal(dupes.rows.length, 1);
});

test("only http(s) web results survive, with a domain", () => {
  const r = core.webRows({
    ok: true,
    query: "bonsai",
    results: [
      { title: "A", url: "https://www.example.com/a", snippet: "s", source: "google" },
      { title: "B", url: "javascript:alert(1)" },
      { title: "C", url: "http://example.org/c" },
    ],
  });
  assert.deepEqual(r.rows.map((x) => x.domain), ["example.com", "example.org"]);
  assert.equal(r.more, 0);
  assert.equal(r.total, 2);
  assert.equal(core.webRows({ ok: false, error: "awfind is not installed" }).ok, false);
  assert.equal(core.resultCountLine({ rows: r.rows, more: 3 }), "2 of 5");
});

// ── holds ──────────────────────────────────────────────────────────────────

test("a held file offers drag-out actions; an image adds What is this", () => {
  const doc = core.holdFromFile("C:\\Projects\\notes.md");
  assert.equal(doc.name, "notes.md");
  assert.equal(doc.dir, "C:\\Projects");
  assert.deepEqual(core.holdActions(doc).map((a) => a.id), ["open", "show", "copy", "read"]);
  const img = core.holdFromFile("C:\\Pictures\\shot.png");
  assert.deepEqual(core.holdActions(img).map((a) => a.id), ["open", "show", "copy", "what", "read"]);
  assert.equal(core.holdLabel(doc), "notes.md");
});

test("a multi-file hold remembers every path and counts itself", () => {
  const hold = core.holdFromFiles(["C:\\a\\one.md", "C:\\a\\two.md"]);
  assert.equal(hold.kind, "file");
  assert.equal(hold.files.length, 2);
  assert.equal(core.holdLabel(hold), "2 files");
  assert.equal(core.holdFromFiles([]), null);
});

test("a web hold keeps a title and a URL; dropped text is bounded", () => {
  const web = core.holdFromWeb({ url: "https://www.example.com/x", title: "Example" });
  assert.equal(web.domain, "example.com");
  assert.deepEqual(core.holdActions(web).map((a) => a.id), ["open", "copy", "read"]);
  assert.equal(core.holdFromWeb({ url: "file:///etc/passwd" }), null);
  const long = core.holdFromText("x".repeat(9000));
  assert.equal(long.text.length, core.DROP_TEXT_MAX);
  assert.ok(long.label.endsWith("…"));
  const textActions = core.holdActions(long, { hasBoard: true });
  assert.deepEqual(textActions.map((a) => a.id), ["summarize", "board"]);
  assert.deepEqual(core.holdActions(long, { hasBoard: false }).map((a) => a.id), ["summarize"]);
});

// ── tint + geometry for the window layer ───────────────────────────────────

test("a body's tint is stable, slot0 is the white fairy, and a supplied colour wins", () => {
  assert.equal(core.tintFor("slot0").name, "white");
  assert.equal(core.tintFor("slot4").css, core.tintFor("slot4").css);
  assert.notEqual(core.tintFor("slot4").css, core.tintFor("slot5").css);
  assert.deepEqual(core.tintFor("slot2", "#12ab34"), { name: "body", css: "#12ab34" });
  assert.equal(core.tintFor("slot2", "nonsense").name !== "body", true);
});

test("clampOrbPoint keeps a whole orb box on its work area", () => {
  const area = { x: 1920, y: 2160, width: 1920, height: 1080 };
  assert.deepEqual(core.clampOrbPoint({ x: 100, y: 100 }, { width: 72, height: 72 }, area), { x: 1956, y: 2196 });
  assert.deepEqual(core.clampOrbPoint({ x: 9000, y: 9000 }, { width: 72, height: 72 }, area), { x: 3804, y: 3204 });
  assert.equal(core.shortenPath("C:\\Users\\wzns\\Projects\\a\\b\\notes.md", 20).startsWith("…"), true);
  assert.equal(core.baseName("C:\\a\\b\\"), "b");
  assert.equal(core.quote("hi"), "“hi”");
});

test("the spirit orbits an avatar's upper body on a tilted ellipse, front then behind", () => {
  const b = { x: 1000, y: 500, width: 300, height: 600 };
  const p0 = core.orbitPoint(b, 0, { periodMs: 8000 });
  const pq = core.orbitPoint(b, 2000, { periodMs: 8000 });
  const ph = core.orbitPoint(b, 6000, { periodMs: 8000 });
  assert.equal(p0.x, 1150 + 126); // rx = max(56, 300 * 0.42)
  assert.equal(p0.y, Math.round(500 + 600 * 0.36));
  assert.equal(pq.front, 1, "the lower half of the ellipse is in front");
  assert.equal(ph.front, -1, "the upper half is behind");
  assert.ok(Math.abs(pq.y - ph.y) < 80, "a flat ring, not a circle");
  assert.equal(core.orbitPoint(null, 0), null);
});

test("a free spirit hovers within a few pixels of its spot", () => {
  for (let t = 0; t < 60000; t += 777) {
    const d = core.hoverOffset(t);
    assert.ok(Math.abs(d.x) <= 13 && Math.abs(d.y) <= 6, `drift ${d.x},${d.y}`);
  }
  assert.notDeepEqual(core.hoverOffset(0), core.hoverOffset(900), "it moves");
});
