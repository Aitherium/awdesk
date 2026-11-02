"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const snip = require("./snip-capture.cjs");

test("file name is 'Screenshot YYYY-MM-DD HHMMSS.png' in local time", () => {
  const d = new Date(2026, 0, 5, 9, 3, 7);
  assert.equal(snip.screenshotName(d), "Screenshot 2026-01-05 090307.png");
  assert.equal(snip.screenshotName(new Date(2026, 10, 30, 23, 59, 59)), "Screenshot 2026-11-30 235959.png");
});

test("folder is Pictures/Aither Screenshots, honouring a redirected Pictures", () => {
  assert.equal(snip.screenshotDir({ picturesDir: path.join("D:", "OneDrive", "Pictures") }),
    path.join("D:", "OneDrive", "Pictures", "Aither Screenshots"));
  assert.equal(snip.screenshotDir({ homeDir: path.join("C:", "Users", "x") }),
    path.join("C:", "Users", "x", "Pictures", "Aither Screenshots"));
});

test("two captures in one second never overwrite each other", () => {
  const taken = new Set([path.join("d", "a.png"), path.join("d", "a (2).png")]);
  assert.equal(snip.uniquePath("d", "a.png", (p) => taken.has(p)), path.join("d", "a (3).png"));
  assert.equal(snip.uniquePath("d", "b.png", (p) => taken.has(p)), path.join("d", "b.png"));
});

test("drag in any direction normalises; a click is not a region", () => {
  assert.deepEqual(snip.normalizeDrag({ x: 50, y: 40 }, { x: 10, y: 20 }), { x: 10, y: 20, width: 40, height: 20 });
  assert.equal(snip.isRegion({ x: 0, y: 0, width: 3, height: 100 }), false);
  assert.equal(snip.isRegion({ x: 0, y: 0, width: 4, height: 4 }), true);
});

test("region math: DIP rect -> device pixels under scaleFactor 1.5 and 2", () => {
  const d150 = { bounds: { x: 0, y: 0, width: 1707, height: 1067 }, scaleFactor: 1.5 };
  // frame size is what the capture REALLY returned (1707*1.5 = 2560.5 -> 2560)
  assert.deepEqual(snip.regionToDevice({ x: 100, y: 50, width: 200, height: 100 }, d150, { width: 2560, height: 1600 }),
    { x: 150, y: 75, width: 300, height: 150 });
  const d2 = { bounds: { x: 1920, y: 0, width: 1280, height: 720 }, scaleFactor: 2 };
  assert.deepEqual(snip.regionToDevice({ x: 10, y: 10, width: 20, height: 30 }, d2),
    { x: 20, y: 20, width: 40, height: 60 });
});

test("region math clamps to the frame and refuses an empty crop", () => {
  const d = { bounds: { width: 1000, height: 500 }, scaleFactor: 2 };
  const frame = { width: 2000, height: 1000 };
  assert.deepEqual(snip.regionToDevice({ x: 900, y: 400, width: 500, height: 500 }, d, frame),
    { x: 1800, y: 800, width: 200, height: 200 });
  assert.equal(snip.regionToDevice({ x: 1200, y: 0, width: 50, height: 50 }, d, frame), null);
  // A frame a pixel short of bounds*sf: the crop must not read past it.
  const r = snip.regionToDevice({ x: 0, y: 0, width: 1000, height: 500 }, d, { width: 1999, height: 999 });
  assert.deepEqual(r, { x: 0, y: 0, width: 1999, height: 999 });
});

test("thumbnail size covers the largest display at native pixels", () => {
  assert.deepEqual(snip.thumbnailSizeFor([
    { bounds: { width: 1920, height: 1080 }, scaleFactor: 1 },
    { bounds: { width: 1707, height: 1067 }, scaleFactor: 1.5 },
  ]), { width: 2561, height: 1601 });
});

test("sources pair to displays by display_id, then by order", () => {
  const displays = [{ id: 1 }, { id: 2 }];
  const byId = snip.matchSources(displays, [{ display_id: "2", n: "b" }, { display_id: "1", n: "a" }]);
  assert.deepEqual(byId.map((p) => p.source.n), ["a", "b"]);
  const byOrder = snip.matchSources(displays, [{ display_id: "", n: "x" }, { display_id: "", n: "y" }]);
  assert.deepEqual(byOrder.map((p) => p.source.n), ["x", "y"]);
});

test("a source naming ANOTHER display is never reused for a display without one", () => {
  // 2026-11-02: one source (the 1080p screen) came back for a 4K + 1080p desk.
  const displays = [{ id: 3319162582 }, { id: 3531739756 }];
  const pairs = snip.matchSources(displays, [{ display_id: "3531739756", n: "second" }]);
  assert.deepEqual(pairs.map((p) => [p.display.id, p.source.n]), [[3531739756, "second"]]);
});

test("saveCapture writes the PNG, copies it, and queues it for `screenshots`", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "snip-"));
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
  const clipped = [];
  const queued = [];
  const v = snip.saveCapture({
    png, dir, now: new Date(2026, 10, 1, 12, 0, 0),
    toClipboard: (p) => clipped.push(p),
    enqueue: (item) => { queued.push(item); return { ok: true }; },
  });
  assert.equal(v.ok, true);
  assert.equal(v.name, "Screenshot 2026-11-01 120000.png");
  assert.deepEqual(fs.readFileSync(v.path), png);
  assert.deepEqual(clipped, [v.path]);
  assert.equal(queued.length, 1);
  assert.equal(queued[0].folder, "screenshots");
  assert.equal(queued[0].contentType, "image/png");
  assert.equal(v.queued, true);
  // A second capture in the same second gets " (2)", and a throwing queue loses nothing.
  const v2 = snip.saveCapture({ png, dir, now: new Date(2026, 10, 1, 12, 0, 0), enqueue: () => { throw new Error("x"); } });
  assert.equal(v2.ok, true);
  assert.equal(v2.name, "Screenshot 2026-11-01 120000 (2).png");
  assert.equal(v2.queued, false);
  assert.equal(snip.saveCapture({ png: Buffer.alloc(0), dir }).ok, false);
});

test("PrintScreen registry: argv and query parsing", () => {
  assert.deepEqual(snip.printScreenRegArgs(false),
    ["add", "HKCU\\Control Panel\\Keyboard", "/v", "PrintScreenKeyForSnippingEnabled", "/t", "REG_DWORD", "/d", "0", "/f"]);
  assert.equal(snip.printScreenRegArgs(true)[7], "1");
  assert.equal(snip.parsePrintScreenQuery("    PrintScreenKeyForSnippingEnabled    REG_DWORD    0x0\r\n"), "aither");
  assert.equal(snip.parsePrintScreenQuery("    PrintScreenKeyForSnippingEnabled    REG_DWORD    0x1\r\n"), "snipping");
  assert.equal(snip.parsePrintScreenQuery("ERROR: The system was unable to find the specified registry key or value."), "unset");
});
