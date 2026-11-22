"use strict";

/**
 * follow-focus -- the attach decision behind "Fairies follow my window" (plan A4).
 *
 * These assert the RULE only: which foreground change becomes an attach target, which
 * becomes a release, and which is left alone. How fast the cluster then reaches the
 * window is the live 4 Hz tether + probe interval; nothing here claims a timing number.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const ff = require("./follow-focus.cjs");

const OWN_PID = 4242;
const notepad = { hwnd: 90210, pid: 777, cls: "Notepad", title: "Untitled - Notepad", x: 100, y: 120, width: 900, height: 700, quiet: "" };
const settled = { changedAt: 0, now: 10_000 };
const base = { enabled: true, ownPid: OWN_PID, ...settled };

test("a settled focus change becomes one attach target on that window", () => {
  const r = ff.decideFollow({ ...base, fg: notepad, attach: null });
  assert.equal(r.act, "attach");
  assert.equal(r.reason, "the focus moved");
  assert.equal(r.target.kind, "window");
  assert.equal(r.target.hwnd, 90210);
  assert.equal(r.target.follow, true, "the attach is marked as one FOLLOW made, so toggle-off can release it");
  assert.deepEqual(r.target.bounds, { x: 100, y: 120, width: 900, height: 700 });
  assert.match(r.target.title, /Notepad/);
});

test("the toggle off yields no decision at all, even with a perfect target", () => {
  const r = ff.decideFollow({ ...base, enabled: false, fg: notepad, attach: null });
  assert.equal(r.act, "none");
  assert.equal(r.reason, "follow is off");
});

test("an attach FOLLOW made is released when the toggle goes off; a hand attach is not", () => {
  assert.equal(ff.releaseOnDisable({ kind: "window", hwnd: 1, follow: true }), true);
  assert.equal(ff.releaseOnDisable({ kind: "avatar", slotId: "slot0" }), false);
  assert.equal(ff.releaseOnDisable({ kind: "desk", windowId: 3, auto: true }), false);
  assert.equal(ff.releaseOnDisable(null), false);
});

test("the AitherOS-window dock (auto) is never stolen by follow: one cluster (owner 2026-11-12)", () => {
  const r = ff.decideFollow({ ...base, fg: notepad, attach: { kind: "desk", windowId: 3, auto: true } });
  assert.equal(r.act, "none");
  assert.match(r.reason, /AitherOS/);
});

test("a focus that has not held yet moves nothing (alt-tab in flight)", () => {
  const r = ff.decideFollow({ ...base, fg: notepad, attach: null, changedAt: 9_900, now: 10_000 });
  assert.equal(r.act, "none");
  assert.equal(r.reason, "waiting for the focus to settle");
  // ...and once it holds, it attaches.
  assert.equal(ff.decideFollow({ ...base, fg: notepad, attach: null, changedAt: 9_900, now: 9_900 + ff.SETTLE_MS }).act, "attach");
});

test("the desk's own window is never followed and releases an existing follow attach", () => {
  const own = { ...notepad, pid: OWN_PID };
  const notAttached = ff.decideFollow({ ...base, fg: own, attach: null });
  assert.equal(notAttached.act, "none");
  assert.equal(notAttached.reason, "the desk's own window");

  const attached = ff.decideFollow({ ...base, fg: own, attach: { kind: "window", hwnd: 555, follow: true } });
  assert.equal(attached.act, "release", "focus back on the AitherOS desktop: the dock takes it back");

  // A hand attach is not touched by a desk-owned foreground either.
  const hand = ff.decideFollow({ ...base, fg: own, attach: { kind: "window", hwnd: 555 } });
  assert.equal(hand.act, "none");
});

test("a full-screen app or game is excluded, and clears a follow attach", () => {
  const game = { ...notepad, quiet: "Windows reports a full-screen game" };
  assert.equal(ff.decideFollow({ ...base, fg: game, attach: null }).act, "none");
  const released = ff.decideFollow({ ...base, fg: game, attach: { kind: "window", hwnd: 1, follow: true } });
  assert.equal(released.act, "release");
  assert.match(released.reason, /full-screen game/);
});

test("already riding that window: the tether moves it, the rule is silent", () => {
  const r = ff.decideFollow({ ...base, fg: notepad, attach: { kind: "window", hwnd: notepad.hwnd, follow: true } });
  assert.equal(r.act, "none");
  assert.equal(r.reason, "already following it");
});

test("a fairy the owner placed by hand is never stolen", () => {
  const r = ff.decideFollow({ ...base, fg: notepad, attach: { kind: "avatar", slotId: "lyra" } });
  assert.equal(r.act, "none");
  assert.equal(r.reason, "attached by hand");
});

test("a window too small to stand on is skipped, as is the shell", () => {
  const tiny = { ...notepad, width: 20, height: 20 };
  assert.equal(ff.decideFollow({ ...base, fg: tiny, attach: null }).act, "none");
  assert.equal(ff.targetFromForeground(tiny), null);
  const tray = { ...notepad, cls: "Shell_TrayWnd" };
  assert.equal(ff.decideFollow({ ...base, fg: tray, attach: null }).act, "none");
  assert.equal(ff.targetFromForeground(tray), null);
});

test("no foreground window changes nothing; junk never throws", () => {
  assert.equal(ff.decideFollow({ ...base, fg: null, attach: { kind: "window", hwnd: 1, follow: true } }).act, "none");
  assert.equal(ff.decideFollow({}).act, "none");
  assert.deepEqual(ff.decideFollow(), { act: "none", reason: "follow is off" });
  assert.equal(ff.targetFromForeground({ x: "q" }), null);
  assert.equal(ff.targetFromForeground(null), null);
  const odd = ff.decideFollow({ enabled: true, ownPid: OWN_PID, fg: notepad, attach: null, changedAt: undefined, now: undefined });
  assert.equal(odd.act, "attach", "an unknown clock counts as held, never as a permanent wait");
});
