"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { parseDeskVerb, verbRows, verbGroup } = require("./desk-verbs.cjs");

const actionOf = (rows, i = 0) => rows[i].action;

test("draw: bare, its modes, and 'ink' as an alias; an ordinary search is not hijacked", () => {
  assert.deepEqual(parseDeskVerb("draw"), { verb: "draw", arg: "", bare: true, mode: "toggle" });
  assert.equal(parseDeskVerb("ink through").mode, "through");
  assert.equal(parseDeskVerb("Draw BOARD").mode, "board");
  assert.equal(parseDeskVerb("draw.io"), null);
  assert.equal(parseDeskVerb("draw a cat"), null);
  const { rows } = verbRows(parseDeskVerb("draw"));
  assert.deepEqual(rows.map((r) => r.action.id), ["ink.toggle", "ink.passthrough", "ink.board", "ink.snip", "ink.clear"]);
  assert.equal(actionOf(verbRows(parseDeskVerb("draw snip")).rows).id, "ink.snip");
});

test("gif <words>: inline results, Enter pins the top one; no key says so", () => {
  const v = parseDeskVerb("gif  happy   cat ");
  assert.equal(v.verb, "gif");
  assert.equal(v.arg, "happy cat");
  const ok = verbRows(v, { gifs: { ok: true, results: [
    { id: "tenor:1", title: "cat", width: 200, height: 100, provider: "tenor" },
    { id: "tenor:2", title: "cat 2", width: 200, height: 100, provider: "tenor" }] } });
  assert.deepEqual(actionOf(ok.rows), { type: "gif-pin", id: "tenor:1" });
  assert.equal(ok.rows[ok.rows.length - 1].action.type, "gif-picker", "the picker is the last row");
  const noKey = verbRows(v, { gifs: { ok: false, needsKey: true, reason: "x" } });
  assert.match(noKey.status, /web search is offline; a GIF key/);
  assert.deepEqual(actionOf(noKey.rows), { type: "gif-picker", query: "happy cat" });
  assert.equal(parseDeskVerb("gifs").target, "picker");
});

test("pin: an address, this tab, an app name", () => {
  const url = parseDeskVerb("pin https://youtu.be/dQw4w9WgXcQ");
  assert.equal(url.target, "url");
  const r = verbRows(url);
  assert.equal(r.rows[0].action.type, "pin");
  assert.equal(r.rows[0].action.card.kind, "youtube");
  assert.match(r.rows[0].title, /YouTube video/);
  assert.equal(parseDeskVerb("pin this tab").target, "tab");
  assert.equal(verbRows(parseDeskVerb("pin tab")).rows[0].action.type, "pin-tab");
  const app = parseDeskVerb("pin notepad");
  assert.equal(app.target, "app");
  const apps = [{ title: "Notepad", subtitle: "App", target: "shell:AppsFolder\\Microsoft.WindowsNotepad_8wekyb3d8bbwe!App" },
    { title: "Bad", target: "cmd.exe" }];
  const ar = verbRows(app, { apps });
  assert.equal(ar.rows.length, 1, "a target pin-item refuses is dropped");
  // A native app is a launch tile (pin-item keeps "app" for aither:// pages).
  assert.equal(ar.rows[0].action.card.kind, "widget");
  assert.equal(ar.rows[0].action.card.widget, "launch");
  assert.equal(ar.rows[0].action.card.extra.launch, apps[0].target);
  assert.match(verbRows(app, { apps: [] }).status, /^0 apps/);
  assert.equal(parseDeskVerb("pin").target, "help");
});

test("youtube: a link pins or opens; words search YouTube in the Aither browser", () => {
  const vid = verbRows(parseDeskVerb("yt https://www.youtube.com/watch?v=dQw4w9WgXcQ"));
  assert.deepEqual(vid.rows.map((r) => r.action.type), ["pin", "browse"]);
  const s = verbRows(parseDeskVerb("youtube lofi beats"));
  assert.equal(s.rows[0].action.url, "https://www.youtube.com/results?search_query=lofi%20beats");
});

test("board / canvas / pins: bare only; with words they are ordinary searches", () => {
  assert.deepEqual(verbRows(parseDeskVerb("board")).rows.map((r) => r.action.id), ["board.new", "boards.open"]);
  assert.equal(parseDeskVerb("board games"), null);
  assert.equal(parseDeskVerb("canvas print"), null);
  assert.deepEqual(verbRows(parseDeskVerb("canvas"), { hasCanvas: true }).rows.map((r) => r.action.id), ["canvas.open", "board.new"]);
  assert.deepEqual(verbRows(parseDeskVerb("canvas")).rows.map((r) => r.action.id), ["board.new"], "no canvas command, no canvas row");
  const pins = verbRows(parseDeskVerb("pins"), { pins: [{ id: "a", title: "cat", kind: "gif", z: 1 }, { id: "b", title: "docs", kind: "url", z: 5, locked: true }] });
  assert.deepEqual(pins.rows.slice(0, 2).map((r) => r.action), [{ type: "pin-show", id: "b" }, { type: "pin-show", id: "a" }]);
  assert.ok(pins.rows.some((r) => r.action.type === "pin-close" && r.action.id === "a"));
  assert.match(pins.status, /^2 pins/);
});

test("prefixes and ordinary words are never verbs", () => {
  for (const t of ["", ">draw", "?pin x", "@gif", "!private", "notepad", "pinball", "gifted", "drawing"]) {
    assert.equal(parseDeskVerb(t), null, t);
  }
});

test("verbGroup strips actions from what the page sees", () => {
  const v = parseDeskVerb("draw");
  const g = verbGroup(v, verbRows(v).rows);
  assert.equal(g.id, "verbs");
  assert.ok(g.items.every((i) => !("action" in i) && i.key.startsWith("verb:")));
  assert.equal(verbGroup(v, []), null);
});
