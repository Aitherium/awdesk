"use strict";
/* global window */

/**
 * sketch-core.cjs -- the Sketch pad's document model: layers, stroke ops and undo/redo.
 *
 * Pure data, no DOM and no electron: sketch.html replays a layer's ops onto its own
 * offscreen canvas, and node:test drives the same functions (sketch-core.test.cjs).
 *
 * A layer is {id, name, visible, opacity, ops, image}; `image` is an optional
 * "data:image/png;base64,..." that is drawn under the ops (a pasted / opened picture).
 * An op is {tool, color, size, opacity, points:[{x,y,p}], seed, tolerance}; every op is
 * clamped by sanitizeOp before it enters a layer, so a page bug cannot store garbage.
 */

const VERSION = 1;
const TOOLS = ["brush", "marker", "airbrush", "eraser", "fill"];
const MAX_POINTS = 20000;
const MAX_HISTORY = 200;
const MAX_DIM = 8192;
const MAX_LAYERS = 64;
const COLOR_RE = /^#[0-9a-f]{6}$/i;
const IMAGE_RE = /^data:image\/(png|jpeg|webp|gif);base64,[A-Za-z0-9+/=]+$/;

/**
 * Clamp a value into [lo, hi]; non-numbers become `dflt`.
 * @param {unknown} v @param {number} lo @param {number} hi @param {number} dflt
 * @returns {number}
 */
function clamp(v, lo, hi, dflt) {
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n)) return dflt;
  return Math.min(hi, Math.max(lo, n));
}

function dim(v, dflt) {
  return Math.round(clamp(v, 1, MAX_DIM, dflt));
}

/** Non-enumerable bookkeeping so a doc still looks like {width,height,layers,active}. */
function attachHistory(doc, seq) {
  Object.defineProperty(doc, "_history", { value: { undo: [], redo: [] }, writable: true, enumerable: false });
  Object.defineProperty(doc, "_seq", { value: seq, writable: true, enumerable: false });
  return doc;
}

function makeLayer(doc, name) {
  doc._seq += 1;
  return { id: "L" + doc._seq, name: String(name || "Layer " + doc._seq).slice(0, 60), visible: true, opacity: 1, ops: [], image: null };
}

/**
 * Create a document with one empty layer.
 * @param {{width?:number,height?:number}} [opts]
 * @returns {{width:number,height:number,layers:object[],active:string}}
 */
function createDoc(opts) {
  const o = opts && typeof opts === "object" ? opts : {};
  const doc = attachHistory({ width: dim(o.width, 1200), height: dim(o.height, 800), layers: [], active: "" }, 0);
  const layer = makeLayer(doc, "Layer 1");
  doc.layers.push(layer);
  doc.active = layer.id;
  return doc;
}

/**
 * Validate and clamp a stroke op. Never throws: bad fields fall back to safe defaults.
 * @param {object} op
 * @returns {{tool:string,color:string,size:number,opacity:number,points:{x:number,y:number,p:number}[],seed:number,tolerance:number}}
 */
function sanitizeOp(op) {
  const o = op && typeof op === "object" ? op : {};
  const tool = TOOLS.includes(o.tool) ? o.tool : "brush";
  const color = typeof o.color === "string" && COLOR_RE.test(o.color) ? o.color.toLowerCase() : "#000000";
  const points = [];
  const src = Array.isArray(o.points) ? o.points : [];
  for (let i = 0; i < src.length && points.length < MAX_POINTS; i += 1) {
    const pt = src[i];
    if (!pt || typeof pt !== "object") continue;
    const x = Number(pt.x);
    const y = Number(pt.y);
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    points.push({ x, y, p: clamp(pt.p, 0, 1, 1) });
  }
  return {
    tool,
    color,
    size: clamp(o.size, 1, 200, 8),
    opacity: clamp(o.opacity, 0, 1, 1),
    points,
    seed: Math.floor(clamp(o.seed, 0, 0x7fffffff, 1)),
    tolerance: Math.round(clamp(o.tolerance, 0, 255, 32)),
  };
}

function record(doc, action) {
  const h = doc._history;
  h.undo.push(action);
  if (h.undo.length > MAX_HISTORY) h.undo.shift();
  h.redo = [];
}

function indexOf(doc, id) {
  return doc.layers.findIndex((l) => l.id === id);
}

/**
 * Add a layer above the active one (or at `index`). Returns the new layer, or null at the cap.
 * @param {object} doc @param {{name?:string,image?:string,index?:number}} [opts]
 */
function addLayer(doc, opts) {
  const o = opts && typeof opts === "object" ? opts : {};
  if (doc.layers.length >= MAX_LAYERS) return null;
  const layer = makeLayer(doc, o.name);
  if (typeof o.image === "string" && IMAGE_RE.test(o.image)) layer.image = o.image;
  const at = Number.isInteger(o.index) ? Math.min(Math.max(o.index, 0), doc.layers.length) : indexOf(doc, doc.active) + 1;
  doc.layers.splice(at, 0, layer);
  doc.active = layer.id;
  record(doc, { type: "add", layer, index: at });
  return layer;
}

/**
 * Remove a layer; refuses (returns false) for the last remaining layer or an unknown id.
 * @param {object} doc @param {string} id @returns {boolean}
 */
function removeLayer(doc, id) {
  const i = indexOf(doc, id);
  if (i < 0 || doc.layers.length <= 1) return false;
  const [layer] = doc.layers.splice(i, 1);
  if (doc.active === id) doc.active = doc.layers[Math.min(i, doc.layers.length - 1)].id;
  record(doc, { type: "remove", layer, index: i });
  return true;
}

/**
 * Move a layer by `delta` positions (index 0 = bottom). Returns false when nothing moved.
 * @param {object} doc @param {string} id @param {number} delta @returns {boolean}
 */
function moveLayer(doc, id, delta) {
  const from = indexOf(doc, id);
  if (from < 0) return false;
  const to = Math.min(Math.max(from + Math.trunc(Number(delta) || 0), 0), doc.layers.length - 1);
  if (to === from) return false;
  const [layer] = doc.layers.splice(from, 1);
  doc.layers.splice(to, 0, layer);
  record(doc, { type: "move", id, from, to });
  return true;
}

/** Select the active layer. @returns {boolean} */
function setActive(doc, id) {
  if (indexOf(doc, id) < 0) return false;
  doc.active = id;
  return true;
}

/**
 * Change name / visible / opacity of a layer (not part of undo history).
 * @param {object} doc @param {string} id @param {{name?:string,visible?:boolean,opacity?:number}} props
 * @returns {boolean}
 */
function setLayerProps(doc, id, props) {
  const layer = doc.layers[indexOf(doc, id)];
  if (!layer || !props || typeof props !== "object") return false;
  if (typeof props.name === "string" && props.name.trim()) layer.name = props.name.trim().slice(0, 60);
  if (typeof props.visible === "boolean") layer.visible = props.visible;
  if (props.opacity !== undefined) layer.opacity = clamp(props.opacity, 0, 1, layer.opacity);
  return true;
}

/**
 * Append a sanitized op to the active layer (or `layerId`). Returns the stored op or null.
 * @param {object} doc @param {object} op @param {string} [layerId]
 */
function pushOp(doc, op, layerId) {
  const layer = doc.layers[indexOf(doc, layerId || doc.active)];
  if (!layer) return null;
  const clean = sanitizeOp(op);
  if (!clean.points.length) return null;
  layer.ops.push(clean);
  record(doc, { type: "op", layerId: layer.id, op: clean });
  return clean;
}

function apply(doc, a, forward) {
  if (a.type === "op") {
    const layer = doc.layers[indexOf(doc, a.layerId)];
    if (!layer) return;
    if (forward) layer.ops.push(a.op);
    else if (layer.ops[layer.ops.length - 1] === a.op) layer.ops.pop();
  } else if (a.type === "add" || a.type === "remove") {
    // redo-add and undo-remove put the layer back; the other two take it out
    if ((a.type === "add") === forward) {
      doc.layers.splice(Math.min(a.index, doc.layers.length), 0, a.layer);
      doc.active = a.layer.id;
    } else {
      const i = indexOf(doc, a.layer.id);
      if (i >= 0) doc.layers.splice(i, 1);
      if (indexOf(doc, doc.active) < 0) doc.active = doc.layers[Math.max(0, Math.min(i, doc.layers.length - 1))].id;
    }
  } else if (a.type === "move") {
    const i = indexOf(doc, a.id);
    if (i < 0) return;
    const [layer] = doc.layers.splice(i, 1);
    doc.layers.splice(forward ? a.to : a.from, 0, layer);
  }
}

/** Undo the last action. Returns the action ({type, ...}) or null when there is none. */
function undo(doc) {
  const a = doc._history.undo.pop();
  if (!a) return null;
  apply(doc, a, false);
  doc._history.redo.push(a);
  return a;
}

/** Redo the last undone action. Returns the action or null. */
function redo(doc) {
  const a = doc._history.redo.pop();
  if (!a) return null;
  apply(doc, a, true);
  doc._history.undo.push(a);
  return a;
}

function canUndo(doc) { return doc._history.undo.length > 0; }
function canRedo(doc) { return doc._history.redo.length > 0; }

/** JSON text of the document (version 1). History is not saved. @returns {string} */
function serialize(doc) {
  return JSON.stringify({ version: VERSION, width: doc.width, height: doc.height, active: doc.active, layers: doc.layers });
}

/**
 * Parse a serialized document. Throws an Error on anything that is not a version-1 sketch.
 * @param {string|object} input @returns {object}
 */
function deserialize(input) {
  let data = input;
  if (typeof input === "string") {
    try { data = JSON.parse(input); } catch (err) { throw new Error("sketch: not JSON (" + err.message + ")", { cause: err }); }
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error("sketch: not an object");
  if (data.version !== VERSION) throw new Error("sketch: unsupported version " + String(data.version));
  if (!Number.isFinite(data.width) || !Number.isFinite(data.height)) throw new Error("sketch: bad size");
  if (!Array.isArray(data.layers) || !data.layers.length || data.layers.length > MAX_LAYERS) throw new Error("sketch: bad layers");
  const doc = attachHistory({ width: dim(data.width, 1200), height: dim(data.height, 800), layers: [], active: "" }, 0);
  const seen = new Set();
  for (const raw of data.layers) {
    if (!raw || typeof raw !== "object" || typeof raw.id !== "string" || !/^L\d+$/.test(raw.id) || seen.has(raw.id)) {
      throw new Error("sketch: bad layer");
    }
    if (!Array.isArray(raw.ops)) throw new Error("sketch: layer " + raw.id + " has no ops array");
    seen.add(raw.id);
    doc._seq = Math.max(doc._seq, Number(raw.id.slice(1)));
    doc.layers.push({
      id: raw.id,
      name: String(raw.name || raw.id).slice(0, 60),
      visible: raw.visible !== false,
      opacity: clamp(raw.opacity, 0, 1, 1),
      ops: raw.ops.map(sanitizeOp).filter((op) => op.points.length > 0),
      image: typeof raw.image === "string" && IMAGE_RE.test(raw.image) ? raw.image : null,
    });
  }
  doc.active = seen.has(data.active) ? data.active : doc.layers[doc.layers.length - 1].id;
  return doc;
}

const api = {
  VERSION, TOOLS, MAX_POINTS, MAX_HISTORY,
  createDoc, sanitizeOp, addLayer, removeLayer, moveLayer, setActive, setLayerProps,
  pushOp, undo, redo, canUndo, canRedo, serialize, deserialize,
};

if (typeof module !== "undefined") module.exports = api; else window.sketchCore = api;
