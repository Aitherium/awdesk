"use strict";

// aitherone-link.cjs: a desk board <-> an AitherOne canvas doc (SceneDoc JSON).

const test = require("node:test");
const assert = require("node:assert/strict");
const core = require("./boards-core.cjs");
const A = require("./aitherone-link.cjs");
const P = require("./pin-item.cjs");

function sampleBoard() {
  const b = core.newBoard({ kind: "board", id: "board-x", title: "Ideas", date: new Date("2026-11-07T12:00:00Z") });
  return core.applySave(b, {
    items: [
      { id: "s1", type: "stroke", x: 0, y: 0, w: 10, h: 10, points: [{ x: 0, y: 0 }, { x: 10, y: 10 }], color: "#fff", width: 3 },
      { id: "r1", type: "shape", shape: "rect", x: 5, y: 5, w: 40, h: 30, color: "#f00", width: 2 },
      { id: "t1", type: "text", x: 1, y: 2, w: 100, h: 20, text: "Hello", color: "#eee", size: 18 },
      { id: "n1", type: "note", x: 3, y: 4, w: 120, h: 90, text: "remember", color: "#3a3a2a" },
    ],
    pins: [P.pinItemFromUrl("https://youtu.be/dQw4w9WgXcQ", { id: "y1", z: 1 }), P.pinItemFromUrl("https://example.com", { id: "u1", z: 2 })],
    view: { scale: 1.5, x: 10, y: -20 },
  });
}

test("board -> scene -> board is lossless: drawing, cards and view", () => {
  const b = sampleBoard();
  const scene = A.boardToScene(b);
  assert.equal(scene.version, 1);
  assert.equal(scene.strokes.length, 1);
  assert.deepEqual(scene.strokes[0].points, [[0, 0, 0.5], [10, 10, 0.5]]);
  assert.deepEqual(scene.items.map((i) => i.kind), ["shape", "text", "sticky", "embed", "embed"]);
  assert.deepEqual([scene.strokes[0].kind, scene.strokes[0].tool], ["stroke", "pen"], "the agreed stroke shape");
  const back = A.sceneToBoard(JSON.parse(JSON.stringify(scene)));
  assert.deepEqual(back.items, b.items);
  assert.deepEqual(back.pins.map((p) => [p.id, p.kind, p.src]), b.pins.map((p) => [p.id, p.kind, p.src]));
  assert.deepEqual(back.view, b.view);
  assert.deepEqual(back.report, { drawing: 4, cards: 2, kept: 0 });
});

test("scene nodes the desk cannot show are KEPT and go back on the next push", () => {
  const scene = { version: 1, view: { scale: 1, x: 0, y: 0 }, items: [
    { id: "f1", kind: "file", node: "/a.pdf", x: 0, y: 0, w: 220, h: 92, z: 1 },
    { id: "a1", kind: "shape", shape: "arrow", x: 0, y: 0, w: 50, h: 10, z: 2 },
    { id: "r1", kind: "shape", shape: "rect", x: 0, y: 0, w: 50, h: 10, z: 3, stroke: "#0f0", strokeWidth: 2 },
  ], strokes: [{ id: "st", points: [[0, 0, 0.5]], color: "#fff", width: 2, z: 4 }] };
  const into = A.sceneToBoard(scene);
  assert.deepEqual(into.report, { drawing: 1, cards: 0, kept: 3 }, "a rect is drawable; a file, an arrow and a 1-point stroke are kept");
  const board = core.normalizeBoard({ ...core.newBoard({ id: "b", kind: "board" }), items: into.items,
    link: { aitherone: { docId: "d1", keep: into.keep } } });
  const out = A.boardToScene(board);
  assert.ok(out.items.some((i) => i.id === "f1") && out.items.some((i) => i.id === "a1"));
  assert.ok(out.strokes.some((s) => s.id === "st"));
});

test("decide: push / pull / in-sync / conflict, and a first link never overwrites a full board", () => {
  const link = (l) => ({ ...sampleBoard(), updatedAt: "L2", link: { aitherone: { docId: "d", ...l } } });
  assert.equal(A.decide(link({ localUpdatedAt: "L2", remoteUpdatedAt: "R1" }), "R1").action, "in-sync");
  assert.equal(A.decide(link({ localUpdatedAt: "L1", remoteUpdatedAt: "R1" }), "R1").action, "push");
  assert.equal(A.decide(link({ localUpdatedAt: "L2", remoteUpdatedAt: "R1" }), "R2").action, "pull");
  const c = A.decide(link({ localUpdatedAt: "L1", remoteUpdatedAt: "R1" }), "R2");
  assert.deepEqual([c.action, c.local, c.remote], ["conflict", "L2", "R2"]);
  assert.equal(A.decide(link({ localUpdatedAt: "L1", remoteUpdatedAt: "R1" }), "R2", { prefer: "desk" }).action, "push");
  assert.equal(A.decide(link({ localUpdatedAt: "L1", remoteUpdatedAt: "R1" }), "R2", { prefer: "aitherone" }).action, "pull");
  assert.equal(A.decide(link({}), "R9").action, "conflict", "linking a full board to an existing doc asks first");
  const empty = { ...core.newBoard({ id: "e", kind: "board" }), link: { aitherone: { docId: "d" } } };
  assert.equal(A.decide(empty, "R9").action, "pull", "an empty board just takes the doc");
  assert.equal(A.decide(sampleBoard(), "R1").action, "unlinked");
});

test("the client speaks Veil's /api/docs routes with the desk's own bearer; signed out and offline say so", async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    if (url.endsWith("/api/docs/create")) return { ok: true, status: 200, json: async () => ({ success: true, data: { doc: { doc_id: "doc_1" } } }) };
    if (url.includes("/api/docs/content/")) return { ok: true, status: 200, json: async () => ({ success: true, data: { content: "{\"items\":[]}" } }) };
    return { ok: true, status: 200, json: async () => ({ success: true, data: { doc: { doc_id: "doc_1", doc_kind: "canvas", updated_at: "T1" } } }) };
  };
  const client = A.createClient({ base: "https://app.aitherium.com", token: () => "tok", fetchImpl });
  assert.deepEqual(await client.create("Ideas", { items: [] }), { ok: true, docId: "doc_1", updatedAt: null });
  assert.equal(calls[0].url, "https://app.aitherium.com/api/docs/create");
  assert.equal(calls[0].init.headers.Authorization, "Bearer tok");
  assert.equal(JSON.parse(calls[0].init.body).doc_kind, "canvas");
  assert.deepEqual(await client.meta("doc_1"), { ok: true, updatedAt: "T1", title: "" });
  assert.equal((await client.content("doc_1")).scene.version, 1, "content parses like Veil's sceneFromJson");
  const signedOut = A.createClient({ base: "https://app.aitherium.com", token: () => null, fetchImpl });
  assert.equal((await signedOut.meta("doc_1")).signedOut, true);
  const offline = A.createClient({ base: "https://app.aitherium.com", token: () => "t", fetchImpl: async () => { throw new Error("ENOTFOUND"); } });
  assert.equal((await offline.meta("doc_1")).offline, true);
  const writer = A.createClient({ base: "https://app.aitherium.com", token: () => "t",
    fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ success: true, data: { doc: { doc_id: "w", doc_kind: "writer" } } }) }) });
  assert.match((await writer.meta("w")).error, /not a canvas/, "never overwrite a Writer document with scene JSON");
});

test("compare-and-set: a push sends base_hash; AitherOne's 409 'conflict' is the conflict path, never an overwrite", async () => {
  const seen = [];
  const fetchImpl = async (url, init) => {
    if (init.method === "POST") {
      seen.push(JSON.parse(init.body));
      return { ok: false, status: 409, json: async () => ({ success: false, error: "conflict", data: { conflict: true } }) };
    }
    return { ok: true, status: 200, json: async () => ({ success: true, data: { doc: { doc_id: "d", doc_kind: "canvas", updated_at: "R1" } } }) };
  };
  const client = A.createClient({ base: "https://app.aitherium.com", token: () => "t", fetchImpl });
  const board = { ...sampleBoard(), updatedAt: "L2",
    link: { aitherone: { docId: "d", remoteUpdatedAt: "R1", localUpdatedAt: "L1", remoteHash: "h-old", rev: 4, keep: [] } } };
  const r = await A.sync(board, client, { machine: "testbox" });
  assert.deepEqual([r.ok, r.action], [false, "conflict"]);
  assert.equal(seen[0].base_hash, "h-old");
  assert.equal(JSON.parse(seen[0].content).rev, 5, "the scene rev climbs on every desk write");
  assert.equal(JSON.parse(seen[0].content).updatedBy, "desk:testbox", "SYNC.md: updatedBy is desk:<machine>");
  // "Keep desk" is the owner's explicit overwrite: no base_hash.
  await A.sync(board, client, { prefer: "desk" });
  assert.equal("base_hash" in seen[1], false);
});

test("a conflict reported over HTTP 200 (success:false, data.conflict) is still the conflict path", async () => {
  const fetchImpl = async (url, init) => (init.method === "POST"
    ? { ok: true, status: 200, json: async () => ({ success: false, error: "stale base", status_code: 409, data: { conflict: true, content_hash: "h2" } }) }
    : { ok: true, status: 200, json: async () => ({ success: true, data: { doc: { doc_id: "d", doc_kind: "canvas", updated_at: "R1" } } }) });
  const client = A.createClient({ base: "https://app.aitherium.com", token: () => "t", fetchImpl });
  const saved = await client.save("d", { items: [] }, "T", "h1");
  assert.deepEqual([saved.ok, saved.conflict], [false, true]);
});
