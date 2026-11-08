"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const picker = require("./gif-picker-window.cjs");

const RESULT = { id: "tenor:1", provider: "tenor", title: "cat", url: "https://media.tenor.com/a/cat.gif",
  preview: "https://media.tenor.com/a/tiny.gif", width: 640, height: 360 };

function setup({ fetchImpl } = {}) {
  const pinned = [];
  const boarded = [];
  const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), "gif-cache-"));
  picker.configureGifPicker({
    gifs: { lookup: (id) => (id === RESULT.id ? RESULT : null), search: async () => ({ ok: true, provider: "tenor",
      rating: "high", query: "cat", results: [RESULT] }), keyStatus: async () => "ready" },
    pins: { addPin: (card) => { pinned.push(card); return { ok: true, pin: card }; } },
    boards: { addImageToCurrentBoard: (img) => { boarded.push(img); return { ok: true, boardId: "b" }; } },
    fetchImpl: fetchImpl || (async () => ({ ok: true, status: 200, headers: { get: () => "3" },
      arrayBuffer: async () => new Uint8Array([71, 73, 70]).buffer })),
    cacheDir,
  });
  return { pinned, boarded, cacheDir };
}

test("click pins the RESOLVED GIF, sized to at most 320 px, aspect kept", () => {
  const { pinned } = setup();
  const r = picker.pinGif("tenor:1");
  assert.equal(r.ok, true);
  assert.equal(pinned[0].kind, "gif");
  assert.equal(pinned[0].src, RESULT.url);
  assert.deepEqual([pinned[0].bounds.width, pinned[0].bounds.height], [320, 180]);
  assert.equal(picker.pinGif("tenor:unknown").ok, false, "an id main never handed out is refused");
});

test("Shift+click hands the board a data: URL of the downloaded bytes, cached to disk once", async () => {
  let calls = 0;
  const { boarded, cacheDir } = setup({ fetchImpl: async () => { calls += 1; return { ok: true, status: 200,
    headers: { get: () => "3" }, arrayBuffer: async () => new Uint8Array([71, 73, 70]).buffer }; } });
  const r = await picker.gifToBoard("tenor:1");
  assert.equal(r.ok, true);
  assert.equal(boarded[0].dataUrl, "data:image/gif;base64,R0lG");
  await picker.gifToBoard("tenor:1");
  assert.equal(calls, 1, "the second time is served from the cache");
  assert.equal(fs.readdirSync(cacheDir).length, 1);
});

test("download refuses a non-CDN address and an oversized GIF", async () => {
  setup();
  assert.equal((await picker.download({ id: "x", url: "https://evil.example/a.gif" })).ok, false);
  setup({ fetchImpl: async () => ({ ok: true, status: 200, headers: { get: () => String(50 * 1024 * 1024) },
    arrayBuffer: async () => new ArrayBuffer(1) }) });
  const r = await picker.download({ id: "big", url: "https://media.tenor.com/big.gif" });
  assert.equal(r.ok, false);
  assert.match(r.reason, /15 MB/);
});

test("the page sees ids and previews, never the full-size URL", () => {
  const view = picker.publicResults({ ok: true, provider: "tenor", rating: "high", query: "cat", results: [RESULT] });
  assert.deepEqual(Object.keys(view.results[0]).sort(), ["height", "id", "preview", "title", "width"]);
  assert.deepEqual(picker.publicResults({ ok: false, needsKey: true, reason: "x" }), { ok: false, needsKey: true, reason: "x" });
});

test("gif: handlers answer only the picker window", async () => {
  setup();
  const h = picker.handlers();
  for (const ch of ["gif:init", "gif:search", "gif:pin", "gif:to-board", "gif:prefetch", "gif:close"]) {
    const r = await h[ch]({ sender: {} }, "tenor:1");
    assert.equal(r.ok, false, ch);
  }
});
