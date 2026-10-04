"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const ap = require("./agents-panel.cjs");

const read = (f) => fs.readFileSync(path.join(__dirname, f), "utf8");

const SESSIONS = {
  ok: true,
  sessions: [
    { id: "a", title: "idle one", status: "idle", harness: "claude_code", last_activity_at: 50 },
    { id: "b", title: "busy", status: "working", last_activity_at: 10, last_activity_summary: "running   tests\n now" },
    { id: "c", title: "asks", status: "waiting-input", last_activity_at: 5, focus: { goal: "fix it", next: "ask owner" } },
    { id: "d", title: "gone", status: "exited" },
    { title: "no id", status: "working" },
  ],
};

const CARD = {
  id: "d-1", title: "Ship?", summary: "green", urgency: "normal", createdAt: 20, deadline: 0,
  options: [{ key: "yes", label: "Ship", consequence: "", recommended: false }, { key: "no", label: "Hold" }],
  defaultKey: "yes", agent: "", tab: "", cwd: "C:\\wt\\my-branch",
};

test("sessions: live rows only, the ones needing the owner first, focus carried, statuses in shared words", () => {
  const s = ap.shapeSessions(SESSIONS);
  assert.equal(s.ok, true);
  assert.deepEqual(s.rows.map((r) => r.id), ["c", "b", "a"], "exited and id-less rows are dropped");
  assert.equal(s.rows[0].statusText, "needs you");
  assert.equal(s.rows[0].goal, "fix it");
  assert.equal(s.rows[0].next, "ask owner");
  assert.equal(s.rows[1].summary, "running tests now", "whitespace collapsed");
  assert.equal(s.note, "3 live");
});

test("sessions: 'could not look' is a failed section with the reason, never an empty success", () => {
  const s = ap.shapeSessions({ ok: false, sessions: [], note: "daemon unreachable (start it: adk harness serve)" });
  assert.equal(s.ok, false);
  assert.match(s.note, /daemon unreachable/);
  assert.deepEqual(s.rows, []);
  assert.equal(ap.shapeSessions(undefined).ok, false);
  assert.equal(ap.shapeSessions({ ok: true, sessions: [] }).note, "No live sessions.");
});

test("sessions are capped and the note says how many were cut", () => {
  const many = Array.from({ length: ap.MAX_SESSIONS + 5 }, (_, i) => ({ id: `s${i}`, status: "idle" }));
  const s = ap.shapeSessions({ ok: true, sessions: many });
  assert.equal(s.rows.length, ap.MAX_SESSIONS);
  assert.match(s.note, /\(\+5 more\)/);
});

test("cards: the card's OWN options, default marked recommended, 'from' falls back to the cwd leaf", () => {
  const c = ap.shapeCards([CARD]);
  assert.equal(c.ok, true);
  assert.equal(c.note, "1 waiting");
  const [card] = c.rows;
  assert.deepEqual(card.options.map((o) => [o.key, o.recommended]), [["yes", true], ["no", false]]);
  assert.equal(card.from, "my-branch");
  assert.equal(card.answerable, true);
  assert.equal(card.whyNot, "");
});

test("cards: urgent first, then oldest; an option-less card is shown but not answerable", () => {
  const rows = ap.shapeCards([
    { ...CARD, id: "old", createdAt: 1 },
    { ...CARD, id: "new", createdAt: 9 },
    { ...CARD, id: "hot", createdAt: 99, urgency: "high" },
    { ...CARD, id: "info", createdAt: 0, options: [] },
    { title: "no id" },
  ]).rows;
  assert.deepEqual(rows.map((r) => r.id), ["hot", "info", "old", "new"]);
  const info = rows.find((r) => r.id === "info");
  assert.equal(info.answerable, false);
  assert.match(info.whyNot, /Inbox/);
});

test("cards: an unreadable store is a failed section; none open says so", () => {
  assert.equal(ap.shapeCards(null).ok, false);
  assert.equal(ap.shapeCards([]).note, "Nothing is waiting on you.");
});

test("room: newest last, capped, a down room with nothing cached says why", () => {
  const rows = Array.from({ length: ap.MAX_ROOM + 3 }, (_, i) => ({ id: `r${i}`, author: "lyra", text: `t${i}`, agent: true }));
  const r = ap.shapeRoom(rows, "ok");
  assert.equal(r.rows.length, ap.MAX_ROOM);
  assert.equal(r.rows.at(-1).text, `t${ap.MAX_ROOM + 2}`);
  const down = ap.shapeRoom([], "connect ECONNREFUSED");
  assert.equal(down.ok, false);
  assert.match(down.note, /room unavailable: connect ECONNREFUSED/);
  assert.equal(ap.shapeRoom([], "ok").note, "The room is quiet.");
  // A stale-but-cached room still shows its rows.
  assert.equal(ap.shapeRoom([{ id: "x", text: "hi" }], "timeout").ok, true);
});

test("buildAgentsView: the v1 contract both side panels render", () => {
  const v = ap.buildAgentsView({ sessions: SESSIONS, cards: [CARD], room: [{ id: "1", author: "a", text: "b" }] });
  assert.deepEqual(Object.keys(v).sort(), ["cards", "room", "sessions", "v", "waiting"]);
  assert.equal(v.v, 1);
  assert.equal(v.waiting, 1);
  for (const key of ["sessions", "cards", "room"]) {
    assert.deepEqual(Object.keys(v[key]).sort(), ["note", "ok", "rows"], key);
  }
  const u = ap.unavailableView("not wired");
  assert.equal(u.sessions.ok || u.cards.ok || u.room.ok, false);
  assert.equal(u.waiting, 0);
});

test("checkAnswer: only an OPEN card, only one of ITS option keys", () => {
  assert.deepEqual(ap.checkAnswer([CARD], "d-1", "no"), { ok: true });
  assert.equal(ap.checkAnswer([CARD], "d-1", "delete-everything").ok, false);
  assert.match(ap.checkAnswer([CARD], "d-9", "yes").error, /no longer open/);
  assert.equal(ap.checkAnswer([CARD], "", "yes").ok, false);
  assert.equal(ap.checkAnswer([CARD], "d-1", 7).ok, false);
  assert.equal(ap.checkAnswer(null, "d-1", "yes").ok, false);
});

test("createAgentsSource: caches the daemon read, survives a throwing reader, checks against live cards", async () => {
  let t = 0;
  let calls = 0;
  let cards = [CARD];
  const source = ap.createAgentsSource({
    listSessions: async () => {
      calls += 1;
      if (calls === 2) throw new Error("boom");
      return SESSIONS;
    },
    getCards: () => cards,
    getRoom: () => [],
    getRoomStatus: () => "ok",
    now: () => t,
    ttlMs: 1000,
  });
  const [a, b] = await Promise.all([source.view(), source.view()]);
  assert.equal(calls, 1, "concurrent polls share one daemon read");
  assert.equal(a.sessions.ok, true);
  assert.equal(b.cards.rows.length, 1);
  t = 500;
  await source.view();
  assert.equal(calls, 1, "inside the TTL nothing is re-read");
  t = 2000;
  const failed = await source.view();
  assert.equal(calls, 2);
  assert.equal(failed.sessions.ok, false);
  assert.match(failed.sessions.note, /boom/);
  assert.equal(source.check("d-1", "yes").ok, true);
  cards = [];
  assert.equal(source.check("d-1", "yes").ok, false, "a card answered elsewhere is refused");
});

test("sessions: the daemon's 'blocked?' is flagged for the owner, ahead of working rows", () => {
  const s = ap.shapeSessions({ ok: true, sessions: [
    { id: "w", status: "working", last_activity_at: 9 },
    { id: "q", status: "blocked?", last_activity_at: 1 },
    { id: "p", status: "waiting-permission", last_activity_at: 1 },
  ] });
  assert.deepEqual(s.rows.map((r) => r.id), ["p", "q", "w"]);
  assert.equal(s.rows[1].statusText, "maybe blocked");
});

test("cards: 'from' falls back agent -> tab title -> cwd leaf", () => {
  assert.equal(ap.shapeCard(CARD).from, "my-branch");
  assert.equal(ap.shapeCard({ ...CARD, tab: "fleet fix" }).from, "fleet fix");
  assert.equal(ap.shapeCard({ ...CARD, tab: "fleet fix", agent: "demiurge" }).from, "demiurge");
});

test("createAgentsSource.answer: an answered card is held until the watcher drops it", async () => {
  let t = 0;
  let cards = [CARD];
  const sent = [];
  let reply = { ok: true };
  const source = ap.createAgentsSource({
    listSessions: async () => SESSIONS,
    getCards: () => cards,
    getRoom: () => [],
    answer: async (id, choice) => { sent.push([id, choice]); return reply; },
    now: () => t,
    answeredTtlMs: 1000,
  });
  assert.deepEqual(await source.answer("d-1", "yes"), { ok: true });
  // awask was only spawned: the store still lists the card.
  const again = await source.answer("d-1", "no");
  assert.equal(again.ok, false);
  assert.match(again.error, /Already answered/);
  assert.equal(source.check("d-1", "no").ok, false);
  const view = await source.view();
  assert.equal(view.cards.rows[0].answerable, false, "the view stops offering it");
  assert.match(view.cards.rows[0].whyNot, /Answered/);
  assert.deepEqual(sent, [["d-1", "yes"]], "exactly one answer reached main");
  // A refused answer can be retried once the hold expires.
  t = 1500;
  assert.equal(source.check("d-1", "no").ok, true);
  // The watcher dropping the card clears the hold; a re-raised card with that id is answerable.
  await source.answer("d-1", "no");
  cards = [];
  await source.view();
  cards = [CARD];
  assert.equal(source.check("d-1", "yes").ok, true);
  // A failed answer never holds the card.
  reply = { ok: false, error: "awask did not take the answer" };
  assert.equal((await source.answer("d-1", "yes")).ok, false);
  assert.equal(source.check("d-1", "yes").ok, true);
  // Concurrent double click: the second is refused before the first resolves.
  reply = { ok: true };
  const [x, y] = await Promise.all([source.answer("d-1", "yes"), source.answer("d-1", "no")]);
  assert.deepEqual([x.ok, y.ok], [true, false]);
  // Without an answer function the source exposes none (browser-window refuses that host).
  assert.equal(ap.createAgentsSource({ listSessions: async () => SESSIONS, getCards: () => [],
    getRoom: () => [] }).answer, undefined);
});

test("browser-window wires the Agents IPC behind fromPanel and re-checks before answering", () => {
  const src = read("browser-window.cjs");
  const i = src.indexOf('ipcMain.handle("desk:browser-agents",');
  const j = src.indexOf('ipcMain.handle("desk:browser-agents-answer",');
  assert.ok(i > 0 && j > 0, "both channels are handled");
  assert.match(src.slice(i, i + 200), /if \(!fromPanel\(event\)\) return null;/);
  const answer = src.slice(j, j + 700);
  assert.match(answer, /if \(!fromPanel\(event\)\) return \{ ok: false/);
  assert.ok(answer.indexOf("agentsHost.check(") < answer.indexOf("agentsHost.answer("), "check before answer");
  const bw = require("./browser-window.cjs");
  assert.equal(typeof bw.setAgentsHost, "function");
  bw.setAgentsHost({ view() {} }); // incomplete host is refused, not half-installed
  bw.setAgentsHost(null);
});

test("the panel preload and HTML expose the Agents tab and render it as text", () => {
  const preload = read("connect-panel-preload.cjs");
  assert.match(preload, /agents: \(\) => ipcRenderer\.invoke\("desk:browser-agents"\)/);
  assert.match(preload, /answerCard: \(id, choice\) => ipcRenderer\.invoke\("desk:browser-agents-answer", String\(id/);
  const html = read("connect-panel.html");
  for (const id of ["t-agents", "p-agents", "agcount", "ag-cards", "ag-sess", "ag-room"]) {
    assert.match(html, new RegExp(`id="${id}"`), id);
  }
  assert.doesNotMatch(html, /innerHTML\s*=/);
  assert.match(html, /api\.answerCard\(card\.id, option\.key\)/, "answers with the card's own key");
});
