"use strict";
/**
 * card-ui -- draw a decision card's generated UI (A2UI v0.9), or refuse to.
 *
 * Owner, 2026-11-08: "make the cards integrate with A2UI ... to generate
 * appropriate cards" (after the fairy's buttons were cut off). The backend
 * (awdk `adk.decisions.card_ui`, Aitherium/AitherOS #15477) may attach
 *
 *     card.ui = {"a2ui": "v0.9", "card_hash": "<sha256>", "messages": [
 *       {"version": "v0.9", "createSurface": {...}},
 *       {"version": "v0.9", "updateComponents": {...}}]}
 *
 * A `ui` is PRESENTATION, never authority. This module holds the desk's half of
 * that contract, so a generated surface can never ask a different question than
 * the card:
 *
 *   - `cardHash` is a byte-exact port of `card_ui.card_hash` (the test pins a
 *     vector produced by the Python). A `ui` compiled against an older revision of
 *     the card is NOT drawn (`isCurrent`) -- the surface falls back to the card.
 *   - `validateUi` ports `card_ui.validate_ui`: only Column/Row/Text/Button from
 *     the Basic catalog, at most 30 components, no URL anywhere, every Button's
 *     event exactly `answer:<a key this card offers>`.
 *   - `buildTree` turns a valid `ui` into a small, inert render tree
 *     ({type, text, variant, key, align, justify, children}) -- plain data both
 *     the fairy page (DOM createElement/textContent) and the Inbox (React) draw.
 *     No HTML, no URL, no handler ever crosses: a button carries only its key,
 *     and main re-checks that key against the card's options on every answer.
 *
 * Pure: no Electron, no fs. Every failure is a `null` tree, which every surface
 * reads as "draw the card the way it always has".
 */

const nodeCrypto = require("node:crypto");

const UI_VERSION = "v0.9";
/** Identical to awdk card_ui.BASIC_CATALOG_ID / AitherOS lib/a2ui.py. */
const BASIC_CATALOG_ID = "https://a2ui.org/specification/v0_9/catalogs/basic/catalog.json";
const CARD_COMPONENTS = Object.freeze(["Column", "Row", "Text", "Button"]);
const ALLOWED_PROPS = new Set([
  "id", "component", "children", "text", "variant", "action", "align", "justify", "weight",
]);
const MAX_COMPONENTS = 30;
/** A serialized `ui` larger than this is not carried at all (a card is not a document). */
const MAX_UI_BYTES = 32 * 1024;
const MAX_DEPTH = 8;
const ANSWER_PREFIX = "answer:";
const ROOT_ID = "root";

const VERSION_RE = /^v?0\.9(\.|$)/;
// Same alternatives as the Python. JS `\b` is ASCII-only, so it finds a boundary
// everywhere Python's Unicode `\b` does (and a few more): strictly MORE refusals.
const URL_RE = /\b[a-z][a-z0-9+.-]*:\/\/|\bjavascript:|\bvbscript:|\bdata:[a-z]+\/|\bwww\./i;

const TEXT_VARIANTS = new Set(["h1", "h2", "h3", "h4", "h5", "body", "caption"]);
const BUTTON_VARIANTS = new Set(["primary", "borderless", "default"]);
const ALIGNS = new Set(["start", "center", "end", "stretch"]);
const JUSTIFIES = new Set(["start", "center", "end", "spaceBetween", "spaceAround", "spaceEvenly", "stretch"]);

// ── card_hash, byte-exact ────────────────────────────────────────────────────

// Python's str.strip() with no argument removes every char whose isspace() is
// true. JS trim() differs (it keeps \x1c-\x1f and \x85, and drops \ufeff), so the
// set is spelled out.
const PY_WS = "\t\n\x0b\x0c\r\x1c\x1d\x1e\x1f \u0085\u00a0\u1680\u2000\u2001\u2002\u2003"
  + "\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000";

function pyStrip(text) {
  let a = 0;
  let b = text.length;
  while (a < b && PY_WS.includes(text[a])) a += 1;
  while (b > a && PY_WS.includes(text[b - 1])) b -= 1;
  return text.slice(a, b);
}

class Unhashable extends Error {}

/** Python `str(value or "")` for what a JSON card can hold; objects cannot be matched. */
function pyText(value) {
  if (value === undefined || value === null || value === false || value === 0 || value === "") return "";
  if (typeof value === "string") return value;
  if (value === true) return "True";
  if (typeof value === "number" && Number.isInteger(value)) return String(value);
  throw new Unhashable("not reproducible");
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/**
 * sha256 hex over what the card SAYS -- awdk `card_ui.card_hash` on the RAW stored
 * card (title, summary, every fact, every option's key+label), or "" when a field
 * holds something the Python would stringify in a way JS cannot reproduce (then no
 * `ui` is ever current for that card, which only means the fallback is drawn).
 */
function cardHash(raw) {
  if (!isPlainObject(raw)) return "";
  try {
    const facts = raw.facts === undefined || raw.facts === null ? [] : raw.facts;
    if (!Array.isArray(facts)) throw new Unhashable("facts");
    const options = raw.options === undefined || raw.options === null ? [] : raw.options;
    if (!Array.isArray(options)) throw new Unhashable("options");
    const payload = [
      pyStrip(pyText(raw.title)),
      pyStrip(pyText(raw.summary)),
      // Python: str(f).strip() -- no `or ""`, so None is "None", False "False".
      facts.map((f) => pyStrip(f === null ? "None" : f === false ? "False" : f === 0 ? "0" : pyText(f))),
      options.map((o) => (isPlainObject(o)
        ? [pyStrip(pyText(o.key)), pyStrip(pyText(o.label))]
        : ["", ""])),
    ];
    // json.dumps(ensure_ascii=False, separators=(",", ":")) escapes exactly what
    // JSON.stringify escapes for strings ( " \ and U+0000-U+001F, lowercase hex).
    return nodeCrypto.createHash("sha256").update(JSON.stringify(payload), "utf8").digest("hex");
  } catch {
    return "";
  }
}

/** True when the raw card carries a `ui` compiled against its present text. */
function isCurrent(raw) {
  if (!isPlainObject(raw) || !isPlainObject(raw.ui)) return false;
  const digest = cardHash(raw);
  return Boolean(digest) && raw.ui.card_hash === digest;
}

// ── validate (port of card_ui.validate_ui) ──────────────────────────────────

function* strings(value) {
  if (typeof value === "string") {
    yield value;
  } else if (Array.isArray(value)) {
    for (const v of value) yield* strings(v);
  } else if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value)) {
      yield k;
      yield* strings(v);
    }
  }
}

function checkButton(cid, comp, keys, errors) {
  const action = comp.action;
  const event = isPlainObject(action) ? action.event : undefined;
  if (!isPlainObject(action) || Object.keys(action).join() !== "event" || !isPlainObject(event)) {
    errors.push(`button ${cid}: action must be exactly {event: {name}}`);
    return;
  }
  const extra = Object.keys(event).filter((k) => k !== "name");
  if (extra.length) errors.push(`button ${cid}: an answer carries no context (${extra.sort().join(", ")})`);
  const name = event.name;
  if (typeof name !== "string" || !name.startsWith(ANSWER_PREFIX)) {
    errors.push(`button ${cid}: event ${JSON.stringify(name)} is not answer:<option key>`);
    return;
  }
  const key = name.slice(ANSWER_PREFIX.length);
  if (!keys.includes(key)) {
    errors.push(`button ${cid}: event ${JSON.stringify(name)} names no option of this card`);
  }
}

/** Every reason `ui` does not bind to a card offering `optionKeys`. [] = valid. */
function validateUi(ui, optionKeys) {
  const keys = Array.isArray(optionKeys) ? optionKeys.filter((k) => typeof k === "string") : [];
  if (ui === undefined || ui === null) return [];
  if (!isPlainObject(ui)) return ["ui must be an object"];
  const errors = [];
  const unknown = Object.keys(ui).filter((k) => !["a2ui", "card_hash", "messages"].includes(k));
  if (unknown.length) errors.push(`ui has unknown keys ${unknown.sort().join(", ")}`);
  if (!VERSION_RE.test(String(ui.a2ui === undefined ? UI_VERSION : ui.a2ui))) {
    errors.push(`ui.a2ui must be ${UI_VERSION}`);
  }
  const msgs = ui.messages;
  if (!Array.isArray(msgs) || msgs.length === 0) return [...errors, "ui.messages must be a non-empty list"];
  let surface = null;
  const comps = new Map();
  let count = 0;
  msgs.forEach((m, i) => {
    const at = `messages[${i}]`;
    if (!isPlainObject(m)) { errors.push(`${at} must be an object`); return; }
    const kinds = ["createSurface", "updateComponents"].filter((k) => k in m);
    const stray = Object.keys(m).filter((k) => !["version", "createSurface", "updateComponents"].includes(k));
    if (stray.length || kinds.length !== 1) {
      errors.push(`${at} must be exactly one of createSurface/updateComponents`);
      return;
    }
    if (!VERSION_RE.test(String(m.version === undefined ? "" : m.version))) {
      errors.push(`${at}.version must be ${UI_VERSION}`);
      return;
    }
    const body = m[kinds[0]];
    const sid = isPlainObject(body) ? body.surfaceId : undefined;
    if (typeof sid !== "string" || !sid) { errors.push(`${at}.surfaceId is required`); return; }
    if (kinds[0] === "createSurface") {
      if (surface !== null) errors.push(`${at}: a card has exactly one surface`);
      if (body.catalogId !== BASIC_CATALOG_ID) errors.push(`${at}: only the Basic catalog is allowed`);
      surface = sid;
      return;
    }
    if (sid !== surface) { errors.push(`${at}: surface ${sid} was never created`); return; }
    const items = body.components;
    if (!Array.isArray(items)) { errors.push(`${at}.components must be a list`); return; }
    for (const comp of items) {
      count += 1;
      const cid = isPlainObject(comp) ? comp.id : undefined;
      if (typeof cid !== "string" || !cid) { errors.push(`${at}: a component needs a string id`); continue; }
      const kind = comp.component;
      if (!CARD_COMPONENTS.includes(kind)) {
        errors.push(`component ${cid}: ${JSON.stringify(kind)} is not one of ${CARD_COMPONENTS.join(", ")}`);
        continue;
      }
      for (const t of strings(comp)) {
        if (URL_RE.test(t)) {
          errors.push(`component ${cid}: carries a URL; a card links nowhere`);
          break;
        }
      }
      const extra = Object.keys(comp).filter((k) => !ALLOWED_PROPS.has(k));
      if (extra.length) errors.push(`component ${cid}: unsupported properties ${extra.sort().join(", ")}`);
      if ((kind === "Text" || kind === "Button") && typeof comp.text !== "string") {
        errors.push(`component ${cid}: text must be a literal string`);
      }
      if (kind === "Button") checkButton(cid, comp, keys, errors);
      else if ("action" in comp) errors.push(`component ${cid}: only a Button has an action`);
      comps.set(cid, comp);
    }
  });
  if (count > MAX_COMPONENTS) errors.push(`ui has ${count} components (max ${MAX_COMPONENTS})`);
  if (surface === null) errors.push("ui never creates its surface");
  else if (!comps.has(ROOT_ID)) errors.push('no component has id "root"');
  for (const [cid, comp] of comps) {
    const ch = comp.children;
    if (ch === undefined || ch === null) continue;
    if (!Array.isArray(ch) || !ch.every((r) => typeof r === "string")) {
      errors.push(`component ${cid}: children must be a list of ids`);
      continue;
    }
    for (const ref of ch) {
      if (!comps.has(ref)) errors.push(`component ${cid} references missing component ${ref}`);
    }
  }
  return errors;
}

// ── render tree ──────────────────────────────────────────────────────────────

/**
 * A VALID `ui` -> {type: "column"|"row"|"text"|"button", ...}. Every component is
 * drawn at most once (a DAG or cycle cannot multiply it) and no deeper than
 * MAX_DEPTH. Variants/alignments outside the known sets are dropped, never passed
 * through as class names.
 */
function buildTree(ui) {
  const comps = new Map();
  for (const m of ui.messages) {
    const body = m.updateComponents;
    if (isPlainObject(body) && Array.isArray(body.components)) {
      for (const c of body.components) comps.set(c.id, c);
    }
  }
  const seen = new Set();
  function walk(cid, depth) {
    const c = comps.get(cid);
    if (!c || seen.has(cid) || depth > MAX_DEPTH) return null;
    seen.add(cid);
    if (c.component === "Text") {
      return { type: "text", text: c.text, variant: TEXT_VARIANTS.has(c.variant) ? c.variant : "body" };
    }
    if (c.component === "Button") {
      return {
        type: "button",
        text: c.text,
        key: c.action.event.name.slice(ANSWER_PREFIX.length),
        variant: BUTTON_VARIANTS.has(c.variant) ? c.variant : "default",
      };
    }
    const children = (Array.isArray(c.children) ? c.children : [])
      .map((ref) => walk(ref, depth + 1))
      .filter(Boolean);
    if (c.component === "Row") {
      return { type: "row", justify: JUSTIFIES.has(c.justify) ? c.justify : "start", children };
    }
    return { type: "column", align: ALIGNS.has(c.align) ? c.align : "stretch", children };
  }
  return walk(ROOT_ID, 0);
}

/**
 * Re-check a render tree that crossed a process boundary (the fairy page, the
 * Inbox): only the four node types, only keys the card offers, bounded. Returns
 * the number of buttons, or -1 when the tree must not be drawn.
 */
function checkTree(tree, optionKeys) {
  const keys = Array.isArray(optionKeys) ? optionKeys : [];
  let nodes = 0;
  let buttons = 0;
  function ok(n, depth) {
    nodes += 1;
    if (!isPlainObject(n) || depth > MAX_DEPTH || nodes > MAX_COMPONENTS) return false;
    if (n.type === "text") return typeof n.text === "string";
    if (n.type === "button") {
      buttons += 1;
      return typeof n.text === "string" && typeof n.key === "string" && keys.includes(n.key);
    }
    if (n.type === "row" || n.type === "column") {
      return Array.isArray(n.children) && n.children.every((c) => ok(c, depth + 1));
    }
    return false;
  }
  return ok(tree, 0) ? buttons : -1;
}

/**
 * Everything a desk surface needs from a raw stored card's `ui`:
 *   ui        the raw `ui` (null when absent, oversized, or on a credential card)
 *   uiCurrent its card_hash matches the card's present text
 *   uiTree    the render tree, ONLY when current AND valid AND it offers at least
 *             one answer button; null otherwise (= draw the card as before)
 *   uiErrors  why it was refused (for a debug surface; never shown as UI)
 * `optionKeys` are the keys the desk itself accepted from the card.
 */
function cardUi(raw, optionKeys) {
  const none = { ui: null, uiCurrent: false, uiTree: null, uiErrors: [] };
  if (!isPlainObject(raw) || raw.ui === undefined || raw.ui === null) return none;
  // A credential ask is drawn by its masked field, never a generated surface.
  if (String(raw.kind || "").toLowerCase() === "credential") {
    return { ...none, uiErrors: ["a credential card never carries ui"] };
  }
  let size = Infinity;
  try { size = Buffer.byteLength(JSON.stringify(raw.ui), "utf8"); } catch { /* cyclic: refused */ }
  if (!isPlainObject(raw.ui) || size > MAX_UI_BYTES) {
    return { ...none, uiErrors: [`ui is not an object of at most ${MAX_UI_BYTES} bytes`] };
  }
  const uiCurrent = isCurrent(raw);
  const out = { ui: raw.ui, uiCurrent, uiTree: null, uiErrors: [] };
  if (!uiCurrent) {
    out.uiErrors = ["ui was compiled for an older revision of this card"];
    return out;
  }
  const errors = validateUi(raw.ui, optionKeys);
  if (errors.length) {
    out.uiErrors = errors;
    return out;
  }
  const tree = buildTree(raw.ui);
  if (!tree || checkTree(tree, optionKeys) < 1) {
    out.uiErrors = ["ui offers no answer button"];
    return out;
  }
  out.uiTree = tree;
  return out;
}

module.exports = {
  UI_VERSION,
  BASIC_CATALOG_ID,
  CARD_COMPONENTS,
  MAX_COMPONENTS,
  MAX_UI_BYTES,
  ANSWER_PREFIX,
  pyStrip,
  cardHash,
  isCurrent,
  validateUi,
  buildTree,
  checkTree,
  cardUi,
};
