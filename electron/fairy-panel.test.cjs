"use strict";

// fairy-panel: the Aither panel's view model (owner 2026-11-14: "make this little menu
// card not look like shit, and make it actually functional and useful").

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { panelView, pickSession, cardsFor, recordExchange, fitHeight } = require("./fairy-panel.cjs");

const SESSIONS = [
  { id: "s-1", title: "Discord workflow launch", status: "working", statusText: "working", summary: "running the bot tests" },
  { id: "s-2", title: "AitherOS-Fresh", status: "idle", statusText: "idle", summary: "" },
];

test("the panel is about the session the fairy is attached to, or the one picked", () => {
  assert.equal(pickSession(SESSIONS, { attachTitle: "Windows Terminal - Discord workflow launch" }).id, "s-1");
  assert.equal(pickSession(SESSIONS, { chosenId: "s-2", attachTitle: "Discord workflow launch" }).id, "s-2");
  assert.equal(pickSession(SESSIONS, { attachTitle: "Notepad" }), null);
  assert.equal(pickSession(null, { attachTitle: "x" }), null);
});

test("one session line with its live state and last line; no empty box repeating 'attached to'", () => {
  const v = panelView({ sessions: SESSIONS, attach: { kind: "window", title: "Discord workflow launch" } });
  assert.deepEqual(v.line, {
    kind: "session", id: "s-1", title: "Discord workflow launch", status: "working",
    statusText: "working", last: "running the bot tests",
  });
  assert.equal(v.attached, true);
  assert.equal(v.choices.length, 2, "switchable");
  const loose = panelView({ sessions: [], attach: { kind: "window", title: "Notepad" } });
  assert.equal(loose.line.kind, "window");
  assert.equal(panelView({}).line.kind, "free");
});

test("the session's own open cards, answerable, most urgent first; other sessions' cards stay out", () => {
  const cards = [
    { id: "c-low", sessionId: "s-1", title: "low", urgency: "low", options: [{ key: "y", label: "Yes" }], createdAt: 1 },
    { id: "c-hi", sessionId: "s-1", title: "hi", urgency: "high", options: [{ key: "a", label: "Approve" }, { key: "n", label: "No" }], defaultKey: "a", createdAt: 2 },
    { id: "c-other", sessionId: "s-2", title: "not this one", options: [] },
  ];
  const got = cardsFor(cards, SESSIONS[0]);
  assert.deepEqual(got.map((c) => c.id), ["c-hi", "c-low"]);
  assert.equal(got[0].options[0].recommended, true);
  assert.deepEqual(cardsFor(cards, null), []);
});

test("history keeps the last few exchanges per session and never repeats the answer on screen", () => {
  const store = new Map();
  for (let i = 0; i < 7; i++) recordExchange(store, "s-1", { q: `q${i}`, a: `a${i}` });
  const v = panelView({ sessions: SESSIONS, attach: { title: "Discord workflow launch" }, history: store, current: { text: "a6" } });
  assert.deepEqual(v.history.map((h) => h.a), ["a2", "a3", "a4", "a5"]);
  assert.deepEqual(panelView({ history: store }).history, [], "the free panel has its own history");
});

test("the window fits its content, inside bounds", () => {
  assert.equal(fitHeight(140), 140);
  assert.equal(fitHeight(20), 112);
  assert.equal(fitHeight(9000), 480);
});
