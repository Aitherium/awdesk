"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const core = require("./sketch-core.cjs");

const stroke = (extra) => ({ tool: "brush", color: "#ff0000", size: 10, opacity: 0.5, points: [{ x: 1, y: 2, p: 0.5 }], ...extra });

test("createDoc: one active layer, clamped size", () => {
  const doc = core.createDoc({ width: 640, height: 480 });
  assert.equal(doc.width, 640);
  assert.equal(doc.height, 480);
  assert.equal(doc.layers.length, 1);
  assert.equal(doc.active, doc.layers[0].id);
  assert.deepEqual(Object.keys(doc).sort(), ["active", "height", "layers", "width"]);
  const big = core.createDoc({ width: 1e9, height: -5 });
  assert.equal(big.width, 8192);
  assert.equal(big.height, 1);
  const dflt = core.createDoc();
  assert.equal(dflt.width, 1200);
});

test("layers: add, active, move, remove (never the last)", () => {
  const doc = core.createDoc({ width: 10, height: 10 });
  const base = doc.layers[0].id;
  const a = core.addLayer(doc, { name: "A" });
  assert.equal(doc.layers.length, 2);
  assert.equal(doc.active, a.id);
  assert.deepEqual(doc.layers.map((l) => l.id), [base, a.id]);

  assert.equal(core.moveLayer(doc, a.id, -1), true);
  assert.deepEqual(doc.layers.map((l) => l.id), [a.id, base]);
  assert.equal(core.moveLayer(doc, a.id, -1), false, "already at the bottom");

  assert.equal(core.setActive(doc, base), true);
  assert.equal(core.setActive(doc, "L999"), false);
  assert.equal(doc.active, base);

  assert.equal(core.removeLayer(doc, base), true);
  assert.equal(doc.active, a.id, "active falls to a surviving layer");
  assert.equal(core.removeLayer(doc, a.id), false, "the last layer stays");
  assert.equal(core.removeLayer(doc, "nope"), false);
  assert.equal(doc.layers.length, 1);
});

test("setLayerProps: rename, visibility, opacity clamp", () => {
  const doc = core.createDoc();
  const id = doc.layers[0].id;
  assert.equal(core.setLayerProps(doc, id, { name: "  Ink  ", visible: false, opacity: 3 }), true);
  assert.equal(doc.layers[0].name, "Ink");
  assert.equal(doc.layers[0].visible, false);
  assert.equal(doc.layers[0].opacity, 1);
  core.setLayerProps(doc, id, { name: "   " });
  assert.equal(doc.layers[0].name, "Ink", "blank names are ignored");
});

test("pushOp: clamps size, opacity, colour, tool and points", () => {
  const doc = core.createDoc();
  const op = core.pushOp(doc, { tool: "laser", color: "red", size: 900, opacity: -2, points: [{ x: 1, y: 1, p: 9 }, { x: "a", y: 2 }, null] });
  assert.equal(op.tool, "brush");
  assert.equal(op.color, "#000000");
  assert.equal(op.size, 200);
  assert.equal(op.opacity, 0);
  assert.deepEqual(op.points, [{ x: 1, y: 1, p: 1 }]);
  assert.equal(core.sanitizeOp({ size: 0 }).size, 1);
  assert.equal(core.sanitizeOp({ color: "#ABCDEF" }).color, "#abcdef");
  assert.equal(core.sanitizeOp({ color: "#abc" }).color, "#000000");
  const many = Array.from({ length: 25000 }, (_, i) => ({ x: i, y: i }));
  assert.equal(core.sanitizeOp({ points: many }).points.length, core.MAX_POINTS);
  assert.equal(core.pushOp(doc, { points: [] }), null, "an empty stroke is not stored");
  assert.equal(doc.layers[0].ops.length, 1);
});

test("undo/redo: ops and layer structure", () => {
  const doc = core.createDoc();
  const base = doc.layers[0].id;
  core.pushOp(doc, stroke());
  core.pushOp(doc, stroke({ color: "#00ff00" }));
  const a = core.addLayer(doc);
  core.moveLayer(doc, a.id, -1);
  core.removeLayer(doc, base);
  assert.deepEqual(doc.layers.map((l) => l.id), [a.id]);

  assert.equal(core.undo(doc).type, "remove");
  assert.deepEqual(doc.layers.map((l) => l.id), [a.id, base]);
  assert.equal(core.undo(doc).type, "move");
  assert.deepEqual(doc.layers.map((l) => l.id), [base, a.id]);
  assert.equal(core.undo(doc).type, "add");
  assert.deepEqual(doc.layers.map((l) => l.id), [base]);
  assert.equal(doc.active, base);
  core.undo(doc);
  assert.equal(doc.layers[0].ops.length, 1);
  assert.equal(core.canRedo(doc), true);

  core.redo(doc);
  assert.equal(doc.layers[0].ops[1].color, "#00ff00");
  core.redo(doc); // add
  core.redo(doc); // move
  core.redo(doc); // remove
  assert.deepEqual(doc.layers.map((l) => l.id), [a.id]);
  assert.equal(core.redo(doc), null);

  core.undo(doc);
  core.pushOp(doc, stroke());
  assert.equal(core.canRedo(doc), false, "a new action clears redo");
});

test("undo history is capped", () => {
  const doc = core.createDoc();
  for (let i = 0; i < core.MAX_HISTORY + 50; i += 1) core.pushOp(doc, stroke());
  let n = 0;
  while (core.undo(doc)) n += 1;
  assert.equal(n, core.MAX_HISTORY);
  assert.equal(doc.layers[0].ops.length, 50);
  assert.equal(core.undo(doc), null);
});

test("serialize / deserialize round-trip", () => {
  const doc = core.createDoc({ width: 300, height: 200 });
  core.pushOp(doc, stroke({ tool: "airbrush", seed: 42 }));
  const b = core.addLayer(doc, { name: "Pic", image: "data:image/png;base64,iVBORw0KGgo=" });
  core.setLayerProps(doc, b.id, { opacity: 0.25, visible: false });
  core.pushOp(doc, stroke({ tool: "fill", tolerance: 10 }));
  const text = core.serialize(doc);
  assert.equal(JSON.parse(text).version, 1);
  const back = core.deserialize(text);
  assert.deepEqual(JSON.parse(core.serialize(back)), JSON.parse(text));
  assert.equal(back.active, b.id);
  assert.equal(core.canUndo(back), false);
  const c = core.addLayer(back);
  assert.ok(!doc.layers.some((l) => l.id === c.id), "new ids never collide with loaded ones");
});

test("deserialize rejects garbage", () => {
  const good = JSON.parse(core.serialize(core.createDoc()));
  const bad = [
    "not json{",
    "null",
    "[]",
    JSON.stringify({ ...good, version: 2 }),
    JSON.stringify({ ...good, width: "big" }),
    JSON.stringify({ ...good, layers: [] }),
    JSON.stringify({ ...good, layers: [{ id: "x", ops: [] }] }),
    JSON.stringify({ ...good, layers: [{ id: "L1" }] }),
    JSON.stringify({ ...good, layers: [{ id: "L1", ops: [] }, { id: "L1", ops: [] }] }),
  ];
  for (const input of bad) assert.throws(() => core.deserialize(input), Error, input);
  const evil = core.deserialize({ ...good, layers: [{ id: "L1", ops: [], image: "javascript:alert(1)" }] });
  assert.equal(evil.layers[0].image, null, "only data:image URLs survive");
});
