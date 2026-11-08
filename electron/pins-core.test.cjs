"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const core = require("./pins-core.cjs");

const gif = (id, extra = {}) => ({ id, kind: "gif", src: `https://media.tenor.com/${id}.gif`, title: id, ...extra });

test("addPin lands on top; a re-add of the same id replaces, never duplicates", () => {
  let { store } = core.addPin(core.emptyStore(), gif("a"));
  ({ store } = core.addPin(store, gif("b")));
  const again = core.addPin(store, gif("a", { title: "renamed" }));
  assert.equal(again.store.pins.length, 2);
  assert.equal(again.pin.title, "renamed");
  assert.ok(again.pin.z > again.store.pins.find((p) => p.id === "b").z, "the re-added pin is on top");
});

test("over MAX_PINS the oldest pin is dropped AND named", () => {
  let store = core.emptyStore();
  for (let i = 0; i < core.MAX_PINS; i += 1) ({ store } = core.addPin(store, gif(`p${i}`)));
  const over = core.addPin(store, gif("newest"));
  assert.equal(over.store.pins.length, core.MAX_PINS);
  assert.deepEqual(over.dropped, ["p0"]);
});

test("patchPin changes only what a window may change", () => {
  const { store } = core.addPin(core.emptyStore(), gif("a"));
  const r = core.patchPin(store, "a", { opacity: 0.5, locked: true, onTop: false, muted: true,
    kind: "url", src: "https://evil.example/", id: "b" });
  assert.equal(r.pin.opacity, 0.5);
  assert.equal(r.pin.locked, true);
  assert.equal(r.pin.onTop, false);
  assert.equal(r.pin.muted, true);
  assert.equal(r.pin.kind, "gif", "kind is identity");
  assert.equal(r.pin.src, "https://media.tenor.com/a.gif", "a gif's src is identity");
  assert.equal(r.pin.id, "a");
  const note = core.addPin(core.emptyStore(), { id: "n", kind: "note", src: "hello" });
  assert.equal(core.patchPin(note.store, "n", { src: "edited" }).pin.src, "edited", "a note's text is editable");
  assert.equal(core.patchPin(store, "missing", { opacity: 1 }).pin, null);
});

test("normalizeStore survives a torn file and drops what no longer reads", () => {
  assert.deepEqual(core.normalizeStore(null), core.emptyStore());
  assert.deepEqual(core.normalizeStore({ pins: "x" }), core.emptyStore());
  const s = core.normalizeStore({ pins: [gif("a"), { id: "x", kind: "url", src: "javascript:1" }, gif("a"), null] });
  assert.deepEqual(s.pins.map((p) => p.id), ["a"]);
});

test("contentFor: images inline (https only), pages and YouTube sandboxed, apps launched not embedded", () => {
  const n = core.normalizeRecord;
  assert.deepEqual(core.contentFor(n(gif("a"))), { mode: "image", url: "https://media.tenor.com/a.gif" });
  assert.equal(core.contentFor(n({ id: "h", kind: "image", src: "http://example.com/x.png" })), null,
    "a plain-http image is not loaded into the pin page");
  const yt = core.contentFor(n({ id: "y", kind: "youtube", src: "https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ", muted: true }));
  assert.equal(yt.mode, "web");
  assert.match(yt.url, /^https:\/\/www\.youtube-nocookie\.com\/embed\/dQw4w9WgXcQ\?/);
  assert.match(yt.url, /mute=1/);
  assert.deepEqual(core.contentFor(n({ id: "u", kind: "url", src: "https://example.com" })), { mode: "web", url: "https://example.com/" });
  assert.deepEqual(core.contentFor(n({ id: "c", kind: "app", src: "aither://terminal" })), { mode: "app", target: "aither://terminal" });
  const notepad = "shell:AppsFolder\\Microsoft.WindowsNotepad_8wekyb3d8bbwe!App";
  const tile = core.launchPin(notepad, "Notepad");
  assert.equal(tile.kind, "widget");
  assert.deepEqual(core.contentFor(tile), { mode: "app", target: notepad });
  for (const bad of ["cmd.exe", "C:\\x\\..\\evil.lnk", "relative.lnk", "shell:AppsFolder\\a\"b"]) {
    assert.equal(core.launchPin(bad), null, bad);
  }
  assert.equal(core.contentFor(null), null);
});

test("youtubeEmbedUrl refuses anything that is not a video id", () => {
  assert.equal(core.youtubeEmbedUrl("../../etc"), null);
  assert.equal(core.youtubeEmbedUrl("dQw4w9WgXcQ\"><script>"), null);
});

test("viewBounds leaves the grab strip above the page", () => {
  assert.deepEqual(core.viewBounds({ x: 50, y: 50, width: 400, height: 300 }), { x: 0, y: core.STRIP, width: 400, height: 300 - core.STRIP });
});

test("visibleBounds pulls a pin off an unplugged monitor back onto a display", () => {
  const areas = [{ x: 0, y: 0, width: 1920, height: 1040 }];
  const kept = { x: 100, y: 100, width: 300, height: 200 };
  assert.deepEqual(core.visibleBounds(kept, areas), kept);
  const lost = core.visibleBounds({ x: 4000, y: 100, width: 300, height: 200 }, areas);
  assert.ok(lost.x >= 0 && lost.x + lost.width <= 1920);
});

test("listSummary: newest first, five rows, one honest +N more", () => {
  let store = core.emptyStore();
  for (let i = 0; i < 7; i += 1) ({ store } = core.addPin(store, gif(`g${i}`)));
  ({ store } = core.patchPin(store, "g6", { locked: true }));
  const sum = core.listSummary(store);
  assert.equal(sum.rows.length, 5);
  assert.equal(sum.more, 2);
  assert.equal(sum.total, 7);
  assert.equal(sum.rows[0].id, "g6");
  assert.match(sum.rows[0].label, /^GIF: g6 \(locked\)$/);
});
