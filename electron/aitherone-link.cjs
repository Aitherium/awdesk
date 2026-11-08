"use strict";

/**
 * aitherone-link.cjs -- a desk board linked to an AitherOne Spatial Canvas doc.
 *
 * Owner, 2026-11-07: "proper integration with AitherOne and ForgeIDE". An AitherOne
 * canvas is an ordinary AitherOne document (`doc_kind: "canvas"`) whose `content` is
 * a SceneDoc JSON (Veil components/aitherone-canvas/types.ts): tenancy, RBAC, Strata
 * backing and history come from the doc routes. So a desk board does not get a second
 * cloud store: it can be LINKED to one doc and pulled from / pushed to it through the
 * same routes Veil's canvas uses (`/api/docs/*` on the Online site), authenticated by
 * the desk's existing Online session bearer -- no new credential path. An unlinked
 * board is local-only and stays fully usable offline.
 *
 * Mapping (lossless both ways; pin-item.cjs does the cards):
 *   board.pins     <-> scene items a pin can hold (link, embed, image, sticky, text)
 *   board.items    <-> strokes -> SceneStroke, shapes/text/notes/images -> SceneItem,
 *                      each carrying its desk original in `aw.board`
 *   board.view     <-> scene.view
 *   scene items the desk cannot show (file, folder, an arrow ...) are KEPT in
 *   link.aitherone.keep and written back on the next push -- never dropped.
 *
 * Conflicts: AitherOne has no compare-and-set on content, so sync is last-writer-wins
 * on the doc's `updated_at`, judged against what both sides were at the last sync
 * (link.aitherone.remoteUpdatedAt / localUpdatedAt). Both moved = a CONFLICT that is
 * reported, never resolved silently; the owner picks "keep desk" or "keep AitherOne".
 *
 * Pure except createClient, whose fetch is injected (tests use a fake).
 */

const pinItem = require("./pin-item.cjs");

const SCENE_VERSION = 1;
const KEEP_MAX = 200;
const isObj = (v) => Boolean(v) && typeof v === "object" && !Array.isArray(v);

/* ── board <-> scene ──────────────────────────────────────────────────────────── */

/** One boards-core drawing item -> a SceneItem or SceneStroke (with the original in aw.board). */
function itemToScene(item, z) {
  const aw = { board: item };
  if (item.type === "stroke") {
    return { stroke: { id: item.id, kind: "stroke", tool: "pen", points: item.points.map((p) => [p.x, p.y, 0.5]), color: item.color, width: item.width, z, aw } };
  }
  const base = { id: item.id, x: item.x, y: item.y, w: item.w, h: item.h, z, aw };
  if (item.type === "shape") return { item: { ...base, kind: "shape", shape: item.shape, stroke: item.color, strokeWidth: item.width } };
  if (item.type === "text") return { item: { ...base, kind: "text", text: item.text, color: item.color, fontSize: item.size } };
  if (item.type === "note") return { item: { ...base, kind: "sticky", text: item.text, fill: item.color } };
  if (item.type === "image") return { item: { ...base, kind: "image", src: item.dataUrl, alt: item.name } };
  return null;
}

/** A SceneItem/Stroke -> a boards-core drawing item, or null (a pin, or not representable). */
function itemFromScene(node, isStroke) {
  if (isObj(node.aw) && isObj(node.aw.board)) {
    const b = { ...node.aw.board };
    if (!isStroke) Object.assign(b, { x: node.x, y: node.y, w: node.w, h: node.h });
    if (b.type === "note" && typeof node.text === "string") b.text = node.text;
    if (b.type === "text" && typeof node.text === "string") b.text = node.text;
    return b;
  }
  if (isStroke) {
    const points = (Array.isArray(node.points) ? node.points : []).filter((p) => Array.isArray(p) && p.length >= 2)
      .map(([x, y]) => ({ x: Number(x), y: Number(y) }));
    if (points.length < 2) return null;
    const xs = points.map((p) => p.x);
    const ys = points.map((p) => p.y);
    return { id: String(node.id), type: "stroke", x: Math.min(...xs), y: Math.min(...ys),
      w: Math.max(1, Math.max(...xs) - Math.min(...xs)), h: Math.max(1, Math.max(...ys) - Math.min(...ys)),
      points, color: String(node.color || "#e6e8eb"), width: Number(node.width) || 3 };
  }
  if (node.kind === "shape" && ["rect", "ellipse", "line"].includes(node.shape)) {
    return { id: node.id, type: "shape", x: node.x, y: node.y, w: node.w, h: node.h, shape: node.shape,
      color: String(node.stroke || "#e6e8eb"), width: Number(node.strokeWidth) || 3 };
  }
  return null;
}

/**
 * A board -> the SceneDoc an AitherOne canvas doc holds. Pins and drawing share one
 * z order on AitherOne: drawing first (it sat under the cards on the desk), then pins.
 */
function boardToScene(board) {
  const scene = { version: SCENE_VERSION, view: { scale: 1, x: 0, y: 0 }, items: [], strokes: [] };
  if (!isObj(board)) return scene;
  if (isObj(board.view)) scene.view = { scale: Number(board.view.scale) || 1, x: Number(board.view.x) || 0, y: Number(board.view.y) || 0 };
  let z = 0;
  for (const item of Array.isArray(board.items) ? board.items : []) {
    const out = itemToScene(item, (z += 1));
    if (out && out.stroke) scene.strokes.push(out.stroke);
    else if (out && out.item) scene.items.push(out.item);
  }
  const pins = (Array.isArray(board.pins) ? board.pins : []).slice().sort((a, b) => a.z - b.z);
  for (const pin of pins) {
    const item = pinItem.toSceneItem({ ...pin, z: pin.z + z });
    if (item) scene.items.push(item);
  }
  const keep = board.link && board.link.aitherone && Array.isArray(board.link.aitherone.keep) ? board.link.aitherone.keep : [];
  for (const k of keep) {
    if (k && k.stroke) scene.strokes.push(k.stroke);
    else if (k && k.item) scene.items.push(k.item);
  }
  return scene;
}

/**
 * A SceneDoc -> the board patch {items, pins, view, keep}. Scene nodes the desk
 * cannot show come back in `keep` (stored on the link) so the next push returns them.
 * `report` counts what went where, for the canvas page to say.
 */
function sceneToBoard(scene) {
  const s = isObj(scene) ? scene : {};
  const drawn = []; // [z, item]: the desk's drawing keeps AitherOne's paint order
  const pins = [];
  const keep = [];
  let pinZ = 0;
  for (const node of Array.isArray(s.items) ? s.items : []) {
    if (!isObj(node) || typeof node.id !== "string") continue;
    const item = itemFromScene(node, false);
    if (item) { drawn.push([Number(node.z) || 0, item]); continue; }
    const pin = pinItem.fromSceneItem(node);
    if (pin) { pins.push({ ...pin, z: (pinZ += 1) }); continue; }
    if (keep.length < KEEP_MAX) keep.push({ item: node });
  }
  for (const node of Array.isArray(s.strokes) ? s.strokes : []) {
    if (!isObj(node)) continue;
    const item = itemFromScene(node, true);
    if (item) drawn.push([Number(node.z) || 0, item]);
    else if (keep.length < KEEP_MAX) keep.push({ stroke: node });
  }
  const items = drawn.sort((a, b) => a[0] - b[0]).map(([, item]) => item);
  const v = isObj(s.view) ? s.view : {};
  return {
    items, pins, keep,
    view: { scale: Number(v.scale) || 1, x: Number(v.x) || 0, y: Number(v.y) || 0 },
    report: { drawing: items.length, cards: pins.length, kept: keep.length },
  };
}

/** Parse a doc's content the way Veil does (sceneFromJson): junk = an empty scene. */
function parseScene(raw) {
  let parsed;
  try { parsed = typeof raw === "string" ? JSON.parse(raw) : raw; } catch { parsed = null; }
  if (!isObj(parsed)) return { version: SCENE_VERSION, view: { scale: 1, x: 0, y: 0 }, items: [], strokes: [] };
  return {
    version: SCENE_VERSION,
    rev: Number.isInteger(parsed.rev) ? parsed.rev : 0,
    view: isObj(parsed.view) ? parsed.view : { scale: 1, x: 0, y: 0 },
    items: Array.isArray(parsed.items) ? parsed.items.filter((i) => isObj(i) && typeof i.id === "string") : [],
    strokes: Array.isArray(parsed.strokes) ? parsed.strokes.filter((x) => isObj(x) && Array.isArray(x.points)) : [],
  };
}

/* ── who wins ─────────────────────────────────────────────────────────────────── */

/**
 * What a sync should do, from the board, its link and the doc's current meta.
 *   "push"     only the desk changed since the last sync (or it was never pushed)
 *   "pull"     only AitherOne changed
 *   "in-sync"  neither
 *   "conflict" both -- reported with both timestamps; nothing is written
 * `prefer` ("desk" | "aitherone") is the owner's answer to a conflict.
 */
function decide(board, remoteUpdatedAt, { prefer = null } = {}) {
  const link = board && board.link && board.link.aitherone;
  if (!link) return { action: "unlinked" };
  const localChanged = !link.localUpdatedAt || board.updatedAt !== link.localUpdatedAt;
  const remoteChanged = Boolean(link.remoteUpdatedAt) && remoteUpdatedAt !== link.remoteUpdatedAt;
  if (localChanged && remoteChanged) {
    if (prefer === "desk") return { action: "push", forced: true };
    if (prefer === "aitherone") return { action: "pull", forced: true };
    return { action: "conflict", local: board.updatedAt, remote: remoteUpdatedAt, since: link.remoteUpdatedAt };
  }
  if (!link.remoteUpdatedAt && remoteUpdatedAt && !link.localUpdatedAt) {
    // A first link to a doc that already exists: pulling would replace whatever this
    // board holds, so a board with content is a conflict the owner decides.
    const hasContent = (board.pins || []).length > 0 || (board.items || []).length > 0;
    if (hasContent && prefer == null) return { action: "conflict", local: board.updatedAt, remote: remoteUpdatedAt, since: null };
    return prefer === "desk" ? { action: "push", forced: true } : { action: "pull" };
  }
  // "Keep desk" after a server-side 409 (the hash moved while updated_at did not) is
  // still the owner's explicit overwrite.
  if (localChanged) return prefer === "desk" ? { action: "push", forced: true } : { action: "push" };
  if (remoteChanged) return { action: "pull" };
  return { action: "in-sync" };
}

/* ── the doc routes (the ones Veil's canvas uses) ─────────────────────────────── */

/**
 * @param {{base: string, token: () => (string|null|Promise<string|null>), fetchImpl: Function}} deps
 *   base   the Online site (https://app.aitherium.com); its /api/docs/* proxies AitherOne
 *   token  the desk's existing Online session bearer (browser-window onlineToken)
 */
function createClient({ base, token, fetchImpl }) {
  async function call(method, path, body) {
    const bearer = await token();
    if (!bearer) return { ok: false, signedOut: true, error: "sign in to AitherOS Online first (the desk's own sign-in)" };
    let res;
    try {
      res = await fetchImpl(new URL(path, base).href, {
        method,
        headers: { Authorization: `Bearer ${bearer}`, Accept: "application/json", ...(body ? { "Content-Type": "application/json" } : {}) },
        body: body ? JSON.stringify(body) : undefined,
      });
    } catch (error) {
      return { ok: false, offline: true, error: `AitherOne did not answer (${(error && error.message) || error})` };
    }
    let json;
    try { json = await res.json(); } catch { json = null; }
    if (res.status === 401) return { ok: false, signedOut: true, error: "AitherOS Online says you are signed out" };
    if (!res.ok || !json || json.success === false) {
      return { ok: false, status: (json && json.status_code) || res.status, error: (json && json.error) || `AitherOne answered ${res.status}`,
        data: (json && json.data) || null };
    }
    return { ok: true, data: json.data || {} };
  }
  const enc = encodeURIComponent;
  return {
    async create(title, scene) {
      const r = await call("POST", "/api/docs/create", { title, doc_kind: "canvas", content: JSON.stringify(scene) });
      if (!r.ok) return r;
      const doc = r.data.doc || {};
      return doc.doc_id ? { ok: true, docId: doc.doc_id, updatedAt: doc.updated_at || null } : { ok: false, error: "AitherOne made no document" };
    },
    async meta(docId) {
      const r = await call("GET", `/api/docs/${enc(docId)}`);
      if (!r.ok) return r;
      const doc = r.data.doc || {};
      if (doc.doc_kind && doc.doc_kind !== "canvas") return { ok: false, error: "that AitherOne document is not a canvas" };
      return { ok: true, updatedAt: doc.updated_at || null, title: doc.title || "" };
    },
    async content(docId) {
      const r = await call("GET", `/api/docs/content/${enc(docId)}`);
      return r.ok ? { ok: true, scene: parseScene(r.data.content), title: r.data.title || "",
        hash: typeof r.data.content_hash === "string" ? r.data.content_hash : null } : r;
    },
    /**
     * Save with `baseHash` (SYNC.md): AitherOne refuses a stale base with 409 "conflict"
     * instead of overwriting. Without a hash (an AitherOne that predates content_hash)
     * the save is last-writer-wins, guarded only by decide()'s updated_at check.
     */
    async save(docId, scene, title, baseHash = null) {
      const r = await call("POST", `/api/docs/content/${enc(docId)}`,
        { content: JSON.stringify(scene), title, ...(baseHash ? { base_hash: baseHash } : {}) });
      // SYNC.md: a stale base is {success:false, error:"conflict", status_code:409, data:{conflict:true}},
      // over HTTP 409 or 200 -- every spelling is the same conflict.
      if (!r.ok && (r.status === 409 || r.error === "conflict" || (r.data && r.data.conflict === true))) {
        return { ok: false, conflict: true, error: "AitherOne changed since this desk last read it" };
      }
      return r.ok ? { ok: true, hash: typeof r.data.content_hash === "string" ? r.data.content_hash : null } : r;
    },
  };
}

/**
 * One sync of `board` with its linked doc (or a first link: no docId = create one).
 * Returns {ok, action, patch?, stamp?, report?} -- `patch` is for
 * boards-window.updateBoard; `stamp` asks the caller to then record the saved version
 * as the agreed one (boards-window.stampLink) -- or {ok:false, action:"conflict", ...}.
 */
async function sync(board, client, { prefer = null, now = () => new Date().toISOString(), machine = null } = {}) {
  // SYNC.md: content.updatedBy names the writer, "desk:<machine>".
  const writer = `desk:${machine || require("node:os").hostname()}`;
  const link = board.link && board.link.aitherone;
  if (!link) {
    const scene = boardToScene(board);
    const made = await client.create(board.title, scene);
    if (!made.ok) return { ...made, action: "link" };
    const meta = await client.meta(made.docId);
    const stamp = now();
    return { ok: true, action: "linked", docId: made.docId,
      patch: { link: { aitherone: { docId: made.docId, remoteUpdatedAt: (meta.ok && meta.updatedAt) || made.updatedAt || stamp,
        localUpdatedAt: null, keep: [] } } }, stamp: true };
  }
  const meta = await client.meta(link.docId);
  if (!meta.ok) return { ...meta, action: "meta" };
  const verdict = decide(board, meta.updatedAt, { prefer });
  if (verdict.action === "conflict") return { ok: false, ...verdict, error: "AitherOne and the desk both changed this canvas since the last sync" };
  if (verdict.action === "in-sync") return { ok: true, action: "in-sync" };
  if (verdict.action === "push") {
    const scene = { ...boardToScene(board), rev: (Number(link.rev) || 0) + 1, updatedBy: writer };
    // A forced "keep desk" overwrites on purpose; otherwise the server's hash check guards
    // the gap between our meta read and this write.
    const saved = await client.save(link.docId, scene, board.title, verdict.forced ? null : link.remoteHash || null);
    if (!saved.ok && saved.conflict) {
      return { ok: false, action: "conflict", local: board.updatedAt, remote: meta.updatedAt, since: link.remoteUpdatedAt, error: saved.error };
    }
    if (!saved.ok) return { ...saved, action: "push" };
    const after = await client.meta(link.docId);
    return { ok: true, action: "pushed", forced: Boolean(verdict.forced),
      patch: { link: { aitherone: { ...link, rev: scene.rev, remoteHash: saved.hash || null,
        remoteUpdatedAt: (after.ok && after.updatedAt) || meta.updatedAt, localUpdatedAt: null } } }, stamp: true };
  }
  const got = await client.content(link.docId);
  if (!got.ok) return { ...got, action: "pull" };
  const into = sceneToBoard(got.scene);
  return { ok: true, action: "pulled", forced: Boolean(verdict.forced), report: into.report,
    patch: { items: into.items, pins: into.pins, view: into.view,
      link: { aitherone: { ...link, keep: into.keep, rev: Number(got.scene.rev) || Number(link.rev) || 0, remoteHash: got.hash || null,
        remoteUpdatedAt: meta.updatedAt, localUpdatedAt: null } } }, stamp: true };
}

/** Where "Open in AitherOne" goes: the canvas section of AitherOne, on that doc. */
function openUrl(base, docId) {
  return new URL(`/workspace/one?tab=canvas&doc=${encodeURIComponent(docId)}`, base).href;
}

module.exports = { boardToScene, sceneToBoard, parseScene, decide, createClient, sync, openUrl };
