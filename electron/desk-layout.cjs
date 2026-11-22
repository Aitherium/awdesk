"use strict";

/**
 * desk-layout.cjs -- the Aither Browser's layout as ONE versioned document.
 *
 * Owner, 2026-11-07: "resize and detach/reattach, reorganize and rearrange, and have
 * access to a canvas for pinning apps and widgets."
 *
 * ONE STORE. The browser already persists its layout in userData/browser-layout.json
 * through browser-rail.normalizeLayout (rail/panel widths, collapsed flags, the dock,
 * the taskbar, folded sections). That file stays the only store: this module adds ONE
 * key to it, `desk`, holding only the facts that had no home before -- which side each
 * pane sits on, the rail's own arrangement (section order, moved / pinned / removed
 * rows), the layer-tile order, named presets, where each detached pane's window was,
 * and which whiteboard the canvas page shows (`canvasBoard`, a pointer: the boards
 * themselves live in boards-core's own files). Sizes and visibility keep their existing
 * keys; nothing is stored twice (docs/UX-REIMPLEMENTATION.md: one owner per fact).
 *
 * THE DOCUMENT. toModel(prefs) composes the full layout -- every pane's side, size,
 * visible flag and order -- from those two halves; fromModel(model) splits one back
 * into a prefs patch. Presets, export and import all speak the model, so a preset
 * written today and imported on another machine through awsettings is the same JSON.
 *
 * Pure (no electron, no fs): every rule here is asserted under `node --test`.
 */

const rail = require("./browser-rail.cjs");

const SCHEMA_VERSION = 1;
/** The export file's `kind`, so an import can refuse a file that is not a desk layout. */
const DOC_KIND = "aither-desk-layout";

/** Every pane the layout places, in the order the customize panel lists them. */
const PANE_IDS = Object.freeze(["rail", "panel", "dock", "avatar", "layers", "taskbar"]);

/**
 * Where each pane may sit. `rail`/`panel` are columns of the window; `dock` is a
 * band above or below the page; `avatar`/`layers` are blocks INSIDE the rail (top or
 * bottom of it); the taskbar is the window's bottom edge only (Veil's taskbar opens
 * its menus upward, so it has no other sensible side).
 */
const SIDES = Object.freeze({
  rail: Object.freeze(["left", "right"]),
  panel: Object.freeze(["right", "left"]),
  dock: Object.freeze(["bottom", "top"]),
  avatar: Object.freeze(["top", "bottom"]),
  layers: Object.freeze(["bottom", "top"]),
  taskbar: Object.freeze(["bottom"]),
});

/** Panes that can pop into their own window and come back (they are views, not chrome). */
const DETACHABLE = Object.freeze(["panel", "dock", "taskbar"]);

/** Human names, for menus, the palette and the edit-layout schematic. */
const PANE_LABELS = Object.freeze({
  rail: "Rail", panel: "Assistant panel", dock: "Terminal dock", avatar: "Avatar slot",
  layers: "Layer tiles", taskbar: "AitherOS taskbar",
});

const LAYER_KEYS = Object.freeze(rail.LAYERS.map((l) => l.key));
const NAME_MAX = 40;
const MAX_PRESETS = 20;
const MAX_ROW_KEYS = 200;
const ROW_KEY = /^[a-z]{2,12}:[^\s]{1,300}$/;
/** The section the owner's "Pin to rail" rows live in, always first and always shown. */
const PINNED_SECTION = "Pinned";

/** Built-in presets: partial models laid over the default. Never deleted or renamed. */
const BUILTIN_PRESETS = Object.freeze([
  Object.freeze({ name: "Default", layout: Object.freeze({}) }),
  Object.freeze({
    name: "Focus",
    layout: Object.freeze({ panes: Object.freeze({
      rail: Object.freeze({ visible: false }),
      panel: Object.freeze({ visible: false }),
      dock: Object.freeze({ open: false }),
    }) }),
  }),
  Object.freeze({
    name: "Ops",
    layout: Object.freeze({ panes: Object.freeze({
      panel: Object.freeze({ visible: true, size: 560 }),
      dock: Object.freeze({ visible: true, open: true, size: 520 }),
    }) }),
  }),
]);
const BUILTIN_NAMES = Object.freeze(BUILTIN_PRESETS.map((p) => p.name));

const isObj = (v) => Boolean(v) && typeof v === "object" && !Array.isArray(v);
// eslint-disable-next-line no-control-regex
const cleanName = (v) => (typeof v === "string" ? v.replace(/[\u0000-\u001f]/g, "").trim().slice(0, NAME_MAX) : "");

function pick(value, allowed, fallback) {
  return allowed.includes(value) ? value : fallback;
}

function clampInt(value, min, max, fallback) {
  if (value == null || value === "") return fallback;
  const n = Number(value);
  return Number.isFinite(n) ? Math.round(Math.min(max, Math.max(min, n))) : fallback;
}

function rowKeys(list) {
  if (!Array.isArray(list)) return [];
  return [...new Set(list.filter((k) => typeof k === "string" && ROW_KEY.test(k)))].slice(0, MAX_ROW_KEYS);
}

function sectionNames(list) {
  if (!Array.isArray(list)) return [];
  return [...new Set(list.map(cleanName).filter(Boolean))].slice(0, 40);
}

/** The rail's own arrangement, sanitized. */
function normalizeRailCustom(raw) {
  const r = isObj(raw) ? raw : {};
  const rowOrder = {};
  if (isObj(r.rowOrder)) {
    for (const [name, keys] of Object.entries(r.rowOrder).slice(0, 40)) {
      const n = cleanName(name);
      const k = rowKeys(keys);
      if (n && k.length) rowOrder[n] = k;
    }
  }
  const moved = {};
  if (isObj(r.moved)) {
    for (const [key, name] of Object.entries(r.moved).slice(0, MAX_ROW_KEYS)) {
      const n = cleanName(name);
      if (ROW_KEY.test(key) && n && n !== PINNED_SECTION) moved[key] = n;
    }
  }
  return {
    sectionOrder: sectionNames(r.sectionOrder),
    rowOrder,
    moved,
    pinned: rowKeys(r.pinned),
    hidden: rowKeys(r.hidden),
  };
}

function normalizeLayerOrder(raw) {
  const seen = Array.isArray(raw) ? raw.filter((k) => LAYER_KEYS.includes(k)) : [];
  const out = [...new Set(seen)];
  for (const k of LAYER_KEYS) if (!out.includes(k)) out.push(k);
  return out;
}

function normalizeBounds(raw) {
  if (!isObj(raw)) return null;
  const x = clampInt(raw.x, -20000, 20000, null);
  const y = clampInt(raw.y, -20000, 20000, null);
  const width = clampInt(raw.width, 240, 8000, null);
  const height = clampInt(raw.height, 120, 8000, null);
  if ([x, y, width, height].some((v) => v == null)) return null;
  return { x, y, width, height };
}

/**
 * The `desk` key of browser-layout.json, sanitized: everything unknown or out of range
 * falls back, so a hand-edited file cannot wedge the window (normalizeLayout's rule).
 */
function normalizeDesk(raw) {
  const d = isObj(raw) ? raw : {};
  const p = isObj(d.panes) ? d.panes : {};
  const panes = {};
  for (const id of ["rail", "panel", "dock", "avatar", "layers"]) {
    const src = isObj(p[id]) ? p[id] : {};
    const pane = { side: pick(src.side, SIDES[id], SIDES[id][0]) };
    if (id === "avatar" || id === "layers") pane.order = clampInt(src.order, 0, 1, id === "avatar" ? 0 : 1);
    if (id === "layers") pane.visible = src.visible !== false;
    panes[id] = pane;
  }
  const detached = {};
  if (isObj(d.detached)) {
    for (const id of DETACHABLE) {
      const b = normalizeBounds(isObj(d.detached[id]) ? d.detached[id].bounds : null);
      const open = Boolean(isObj(d.detached[id]) && d.detached[id].open === true);
      if (b || open) detached[id] = { bounds: b, open };
    }
  }
  const presets = [];
  if (Array.isArray(d.presets)) {
    for (const preset of d.presets) {
      const name = cleanName(preset && preset.name);
      if (!name || BUILTIN_NAMES.includes(name) || presets.some((x) => x.name === name)) continue;
      const checked = validateModel(preset.layout, { partial: true });
      if (!checked.ok) continue;
      presets.push({ name, layout: checked.model });
      if (presets.length >= MAX_PRESETS) break;
    }
  }
  const active = cleanName(d.activePreset);
  return {
    v: SCHEMA_VERSION,
    panes,
    rail: normalizeRailCustom(d.rail),
    layerOrder: normalizeLayerOrder(d.layerOrder),
    presets,
    activePreset: active && (BUILTIN_NAMES.includes(active) || presets.some((x) => x.name === active)) ? active : null,
    detached,
    // Which board aither://canvas shows: an id into ~/Aither Boards (boards-core.cjs).
    canvasBoard: typeof d.canvasBoard === "string" && /^[A-Za-z0-9._-]{1,120}$/.test(d.canvasBoard) ? d.canvasBoard : null,
  };
}

/**
 * The full layout model: every pane's side, size, visible flag and order, the rail's
 * arrangement and the layer order. Composed from the legacy prefs keys (sizes,
 * visibility) and the `desk` key (sides, order) -- this is the document presets,
 * export and import speak.
 */
function toModel(prefs) {
  const p = rail.normalizeLayout(prefs || {});
  const d = p.desk;
  return {
    v: SCHEMA_VERSION,
    panes: {
      rail: { side: d.panes.rail.side, size: p.railWidth, visible: !p.railCollapsed, order: 0 },
      panel: { side: d.panes.panel.side, size: p.panelWidth, visible: !p.panelCollapsed, order: 1 },
      dock: { side: d.panes.dock.side, size: p.dockHeight, visible: p.dock, open: p.dockOpen, order: 1 },
      avatar: { side: d.panes.avatar.side, visible: true, order: d.panes.avatar.order },
      layers: { side: d.panes.layers.side, visible: d.panes.layers.visible, order: d.panes.layers.order },
      taskbar: { side: "bottom", visible: p.taskbar, order: 0 },
    },
    rail: {
      ...d.rail,
      collapsedSections: p.collapsedSections,
    },
    layerOrder: d.layerOrder,
  };
}

/** Keys a model may carry, per level. Anything else is REJECTED on import, not ignored. */
const MODEL_KEYS = Object.freeze(["v", "panes", "rail", "layerOrder"]);
const PANE_KEYS = Object.freeze({
  rail: ["side", "size", "visible", "order"],
  panel: ["side", "size", "visible", "order"],
  dock: ["side", "size", "visible", "open", "order"],
  avatar: ["side", "visible", "order"],
  layers: ["side", "visible", "order"],
  taskbar: ["side", "visible", "order"],
});
const RAIL_KEYS = Object.freeze(["sectionOrder", "rowOrder", "moved", "pinned", "hidden", "collapsedSections"]);

/**
 * Check a model (an import, a preset). `partial` allows missing keys (a preset only
 * says what it changes). Unknown keys and wrong types are errors -- a typo in an
 * imported file is reported, never silently dropped. Sizes are CLAMPED, not refused:
 * a layout saved on a 4K screen still loads on a laptop.
 *
 * @returns {{ok: true, model: object} | {ok: false, errors: string[]}}
 */
function validateModel(raw, { partial = false } = {}) {
  const errors = [];
  if (!isObj(raw)) return { ok: false, errors: ["a layout must be a JSON object"] };
  for (const k of Object.keys(raw)) if (!MODEL_KEYS.includes(k)) errors.push(`unknown key: ${k}`);
  if (raw.v != null && raw.v !== SCHEMA_VERSION) errors.push(`unsupported version: ${raw.v}`);
  const model = {};
  if (raw.panes != null) {
    if (!isObj(raw.panes)) errors.push("panes must be an object");
    else {
      model.panes = {};
      for (const [id, pane] of Object.entries(raw.panes)) {
        if (!PANE_IDS.includes(id)) { errors.push(`unknown pane: ${id}`); continue; }
        if (!isObj(pane)) { errors.push(`panes.${id} must be an object`); continue; }
        const out = {};
        for (const [k, v] of Object.entries(pane)) {
          if (!PANE_KEYS[id].includes(k)) { errors.push(`unknown key: panes.${id}.${k}`); continue; }
          if (k === "side") {
            if (!SIDES[id].includes(v)) errors.push(`panes.${id}.side must be one of ${SIDES[id].join("/")}`);
            else out.side = v;
          } else if (k === "visible" || k === "open") {
            if (typeof v !== "boolean") errors.push(`panes.${id}.${k} must be true or false`);
            else out[k] = v;
          } else if (k === "size") {
            if (!Number.isFinite(Number(v))) errors.push(`panes.${id}.size must be a number`);
            else out.size = clampSize(id, v);
          } else if (k === "order") {
            if (!Number.isInteger(v) || v < 0 || v > 9) errors.push(`panes.${id}.order must be an integer 0-9`);
            else out.order = v;
          }
        }
        model.panes[id] = out;
      }
    }
  }
  if (raw.rail != null) {
    if (!isObj(raw.rail)) errors.push("rail must be an object");
    else {
      for (const k of Object.keys(raw.rail)) if (!RAIL_KEYS.includes(k)) errors.push(`unknown key: rail.${k}`);
      model.rail = {
        ...normalizeRailCustom(raw.rail),
        collapsedSections: sectionNames(raw.rail.collapsedSections),
      };
    }
  }
  if (raw.layerOrder != null) {
    if (!Array.isArray(raw.layerOrder)) errors.push("layerOrder must be a list");
    else {
      for (const k of raw.layerOrder) if (!LAYER_KEYS.includes(k)) errors.push(`unknown layer: ${k}`);
      model.layerOrder = normalizeLayerOrder(raw.layerOrder);
    }
  }
  if (!partial) for (const k of ["panes"]) if (model[k] == null) errors.push(`missing: ${k}`);
  return errors.length ? { ok: false, errors } : { ok: true, model };
}

function clampSize(id, v) {
  if (id === "rail") return clampInt(v, rail.RAIL_MIN, rail.RAIL_MAX, rail.RAIL_WIDTH);
  if (id === "panel") return clampInt(v, rail.PANEL_MIN, rail.PANEL_MAX, 340);
  if (id === "dock") return clampInt(v, rail.DOCK_MIN, rail.DOCK_MAX, rail.DOCK_HEIGHT);
  return undefined;
}

/**
 * A (possibly partial) model -> the prefs patch that makes it so. Keys the model does
 * not mention are left alone, which is how a preset "only changes what it says".
 */
function fromModel(model, prefs) {
  const current = rail.normalizeLayout(prefs || {});
  const m = isObj(model) ? model : {};
  const panes = isObj(m.panes) ? m.panes : {};
  const patch = {};
  const desk = JSON.parse(JSON.stringify(current.desk));
  const r = panes.rail || {};
  if (r.side) desk.panes.rail.side = r.side;
  if (r.size != null) patch.railWidth = r.size;
  if (typeof r.visible === "boolean") patch.railCollapsed = !r.visible;
  const pn = panes.panel || {};
  if (pn.side) desk.panes.panel.side = pn.side;
  if (pn.size != null) patch.panelWidth = pn.size;
  if (typeof pn.visible === "boolean") patch.panelCollapsed = !pn.visible;
  const dk = panes.dock || {};
  if (dk.side) desk.panes.dock.side = dk.side;
  if (dk.size != null) patch.dockHeight = dk.size;
  if (typeof dk.visible === "boolean") patch.dock = dk.visible;
  if (typeof dk.open === "boolean") patch.dockOpen = dk.open;
  for (const id of ["avatar", "layers"]) {
    const src = panes[id] || {};
    if (src.side) desk.panes[id].side = src.side;
    if (Number.isInteger(src.order)) desk.panes[id].order = Math.min(1, src.order);
    if (id === "layers" && typeof src.visible === "boolean") desk.panes.layers.visible = src.visible;
  }
  const tb = panes.taskbar || {};
  if (typeof tb.visible === "boolean") patch.taskbar = tb.visible;
  if (isObj(m.rail)) {
    const { collapsedSections, ...custom } = m.rail;
    desk.rail = normalizeRailCustom({ ...desk.rail, ...custom });
    if (Array.isArray(collapsedSections)) patch.collapsedSections = collapsedSections;
  }
  if (Array.isArray(m.layerOrder)) desk.layerOrder = normalizeLayerOrder(m.layerOrder);
  patch.desk = desk;
  return patch;
}

/** What "Default" means: every legacy key at its default, the desk's sides/orders reset. */
function defaultModel() {
  return toModel({});
}

/** Every preset the owner can pick: the three built-ins, then theirs. */
function presetList(desk) {
  const d = normalizeDesk(desk);
  return [
    ...BUILTIN_PRESETS.map((p) => ({ name: p.name, builtin: true })),
    ...d.presets.map((p) => ({ name: p.name, builtin: false })),
  ];
}

/**
 * Apply a preset by name. A built-in is laid over the DEFAULT model (so "Focus" from a
 * wild layout lands on a known state); an owner preset is a full model of its own.
 * Rail arrangement (pins, moved rows) is the owner's content, not geometry: presets
 * carry it only when they were saved with it.
 */
function applyPreset(prefs, name) {
  const current = rail.normalizeLayout(prefs || {});
  const want = cleanName(name);
  const builtin = BUILTIN_PRESETS.find((p) => p.name === want);
  let patch;
  if (builtin) {
    const base = defaultModel();
    delete base.rail; // the owner's rail arrangement survives a geometry preset
    delete base.layerOrder;
    const reset = fromModel(base, current);
    // Merge: the second patch only names what the preset changes.
    patch = { ...reset, ...fromModel(builtin.layout, { ...current, ...reset }) };
  } else {
    const own = current.desk.presets.find((p) => p.name === want);
    if (!own) return { ok: false, error: `no layout called ${want || "(empty)"}` };
    patch = fromModel(own.layout, current);
  }
  patch.desk.activePreset = want;
  return { ok: true, patch };
}

/** Save the current layout as a named preset (overwrites one of the owner's with that name). */
function savePreset(prefs, name) {
  const current = rail.normalizeLayout(prefs || {});
  const want = cleanName(name);
  if (!want) return { ok: false, error: "a layout needs a name" };
  if (BUILTIN_NAMES.includes(want)) return { ok: false, error: `${want} is built in; pick another name` };
  const presets = current.desk.presets.filter((p) => p.name !== want);
  if (presets.length >= MAX_PRESETS) return { ok: false, error: `at most ${MAX_PRESETS} saved layouts` };
  presets.push({ name: want, layout: toModel(current) });
  return { ok: true, patch: { desk: { ...current.desk, presets, activePreset: want } } };
}

function renamePreset(prefs, from, to) {
  const current = rail.normalizeLayout(prefs || {});
  const a = cleanName(from);
  const b = cleanName(to);
  if (BUILTIN_NAMES.includes(a)) return { ok: false, error: `${a} is built in` };
  if (!b || BUILTIN_NAMES.includes(b)) return { ok: false, error: "pick another name" };
  if (a !== b && current.desk.presets.some((p) => p.name === b)) return { ok: false, error: `${b} already exists` };
  const at = current.desk.presets.findIndex((p) => p.name === a);
  if (at < 0) return { ok: false, error: `no layout called ${a}` };
  const presets = current.desk.presets.map((p, i) => (i === at ? { ...p, name: b } : p));
  const activePreset = current.desk.activePreset === a ? b : current.desk.activePreset;
  return { ok: true, patch: { desk: { ...current.desk, presets, activePreset } } };
}

function deletePreset(prefs, name) {
  const current = rail.normalizeLayout(prefs || {});
  const want = cleanName(name);
  if (BUILTIN_NAMES.includes(want)) return { ok: false, error: `${want} is built in` };
  if (!current.desk.presets.some((p) => p.name === want)) return { ok: false, error: `no layout called ${want}` };
  const presets = current.desk.presets.filter((p) => p.name !== want);
  const activePreset = current.desk.activePreset === want ? null : current.desk.activePreset;
  return { ok: true, patch: { desk: { ...current.desk, presets, activePreset } } };
}

/** Move one pane to a side. A side the pane cannot take is refused with the ones it can. */
function setPaneSide(prefs, pane, side) {
  const current = rail.normalizeLayout(prefs || {});
  if (!PANE_IDS.includes(pane)) return { ok: false, error: `no pane called ${pane}` };
  if (!SIDES[pane].includes(side)) return { ok: false, error: `${PANE_LABELS[pane]} can sit ${SIDES[pane].join(" or ")}` };
  if (pane === "taskbar") return { ok: true, patch: {} };
  const desk = JSON.parse(JSON.stringify(current.desk));
  desk.panes[pane].side = side;
  desk.activePreset = null;
  return { ok: true, patch: { desk } };
}

/** "panel:left" -> {pane, side}; null when it is not that shape. */
function parsePaneSide(arg) {
  const m = /^([a-z]+):([a-z]+)$/.exec(String(arg || "").trim().toLowerCase());
  return m ? { pane: m[1], side: m[2] } : null;
}

/* ── the rail's arrangement ───────────────────────────────────────────────────── */

/** A rail row's identity for the arrangement: what a click opens (`kind:id`). */
function railRowKey(row) {
  return row && row.kind && row.id != null ? `${row.kind}:${row.id}` : "";
}

/**
 * railSections() output -> the owner's arrangement of it: sections reordered, rows
 * moved between sections and reordered inside one, removed rows dropped, and a
 * "Pinned" section first holding the rows they pinned (the row also stays where it
 * was: a pin is a shortcut, not a move). Runs BEFORE railView, so the five-row cap
 * and "+N more" apply to the arranged rail exactly as to the generated one.
 *
 * A key that names no row today (an app that left the catalogue) is skipped, never
 * an empty slot.
 */
function arrangeRail(sections, custom) {
  const c = normalizeRailCustom(custom);
  const hidden = new Set(c.hidden);
  const byKey = new Map();
  const groups = new Map();
  for (const sec of Array.isArray(sections) ? sections : []) {
    groups.set(sec.name, { ...sec, rows: [] });
    for (const row of sec.rows || []) byKey.set(railRowKey(row), { row, home: sec.name });
  }
  for (const [key, { row, home }] of byKey) {
    if (hidden.has(key)) continue;
    const target = c.moved[key] && groups.has(c.moved[key]) ? c.moved[key] : home;
    groups.get(target).rows.push(row);
  }
  for (const [name, sec] of groups) {
    const order = c.rowOrder[name];
    if (!order) continue;
    const rank = new Map(order.map((k, i) => [k, i]));
    sec.rows = sec.rows
      .map((row, i) => ({ row, i, r: rank.has(railRowKey(row)) ? rank.get(railRowKey(row)) : Infinity }))
      .sort((a, b) => (a.r - b.r) || (a.i - b.i))
      .map((x) => x.row);
  }
  let out = [...groups.values()];
  if (c.sectionOrder.length) {
    const rank = new Map(c.sectionOrder.map((n, i) => [n, i]));
    out = out
      .map((sec, i) => ({ sec, i, r: rank.has(sec.name) ? rank.get(sec.name) : Infinity }))
      .sort((a, b) => (a.r - b.r) || (a.i - b.i))
      .map((x) => x.sec);
  }
  out = out.filter((sec) => sec.rows.length > 0);
  const pinnedRows = c.pinned.map((k) => byKey.get(k)).filter(Boolean).map((x) => ({ ...x.row, pinned: true }));
  if (pinnedRows.length) out.unshift({ id: "pinned", name: PINNED_SECTION, rows: pinnedRows });
  for (const sec of out) {
    if (sec.name === PINNED_SECTION) continue;
    sec.rows = sec.rows.map((row) => (c.pinned.includes(railRowKey(row)) ? { ...row, pinned: true } : row));
  }
  return out;
}

/**
 * One arrangement edit. `op` is what the chrome page's drag-and-drop, the row's
 * right-click menu and the palette all send:
 *   {op:"pin", key} | {op:"unpin", key} | {op:"hide", key} | {op:"restore"}
 *   {op:"move-row", key, section, index}   -- index within the target section's rows
 *   {op:"move-section", name, index}
 *   {op:"nudge-row", key, by}              -- keyboard: +1 / -1 inside its section
 *   {op:"nudge-section", name, by}
 * `sections` is the ARRANGED rail the owner sees (arrangeRail output), so an index
 * means what was on screen.
 */
function editRail(custom, op, sections) {
  const c = normalizeRailCustom(custom);
  const o = isObj(op) ? op : {};
  const key = typeof o.key === "string" && ROW_KEY.test(o.key) ? o.key : null;
  const visible = (Array.isArray(sections) ? sections : []).filter((s) => s.name !== PINNED_SECTION);
  const names = visible.map((s) => s.name);
  const homeOf = (k) => (visible.find((s) => (s.rows || []).some((r) => railRowKey(r) === k)) || {}).name || null;
  const rowsOf = (name) => ((visible.find((s) => s.name === name) || {}).rows || []).map(railRowKey);
  switch (o.op) {
    case "pin":
      if (!key) return { ok: false, error: "no such row" };
      if (!c.pinned.includes(key)) c.pinned.push(key);
      return { ok: true, custom: c };
    case "unpin":
      if (!key) return { ok: false, error: "no such row" };
      c.pinned = c.pinned.filter((k) => k !== key);
      return { ok: true, custom: c };
    case "hide":
      if (!key) return { ok: false, error: "no such row" };
      if (!c.hidden.includes(key)) c.hidden.push(key);
      c.pinned = c.pinned.filter((k) => k !== key);
      return { ok: true, custom: c };
    case "restore":
      c.hidden = [];
      return { ok: true, custom: c };
    case "move-row":
    case "nudge-row": {
      if (!key) return { ok: false, error: "no such row" };
      const from = homeOf(key);
      if (!from) return { ok: false, error: "that row is not on the rail" };
      let target = o.op === "move-row" ? cleanName(o.section) : from;
      if (target === PINNED_SECTION) {
        // Dropping onto Pinned pins it; reordering inside Pinned reorders the pins.
        const pins = c.pinned.filter((k) => k !== key);
        const at = clampInt(o.index, 0, pins.length, pins.length);
        pins.splice(at, 0, key);
        c.pinned = pins;
        return { ok: true, custom: c };
      }
      if (!names.includes(target)) return { ok: false, error: `no section called ${target}` };
      const list = rowsOf(target).filter((k) => k !== key);
      let at;
      if (o.op === "nudge-row") {
        const now = rowsOf(target).indexOf(key);
        at = Math.max(0, Math.min(list.length, now + (Number(o.by) < 0 ? -1 : 1)));
      } else at = clampInt(o.index, 0, list.length, list.length);
      list.splice(at, 0, key);
      c.rowOrder[target] = list;
      if (target !== from) {
        c.moved[key] = target;
        c.rowOrder[from] = rowsOf(from).filter((k) => k !== key);
      }
      return { ok: true, custom: c };
    }
    case "move-section":
    case "nudge-section": {
      const name = cleanName(o.name);
      if (!names.includes(name)) return { ok: false, error: `no section called ${name}` };
      const list = names.filter((n) => n !== name);
      const now = names.indexOf(name);
      const at = o.op === "nudge-section"
        ? Math.max(0, Math.min(list.length, now + (Number(o.by) < 0 ? -1 : 1)))
        : clampInt(o.index, 0, list.length, list.length);
      list.splice(at, 0, name);
      c.sectionOrder = list;
      return { ok: true, custom: c };
    }
    default:
      return { ok: false, error: `unknown rail edit: ${o.op}` };
  }
}

/** Move one layer tile to `index` (or by +1/-1 with `by`). */
function moveLayer(order, key, { index = null, by = 0 } = {}) {
  const list = normalizeLayerOrder(order);
  if (!list.includes(key)) return { ok: false, error: `no layer called ${key}` };
  const now = list.indexOf(key);
  const rest = list.filter((k) => k !== key);
  const at = index != null ? clampInt(index, 0, rest.length, rest.length)
    : Math.max(0, Math.min(rest.length, now + (Number(by) < 0 ? -1 : 1)));
  rest.splice(at, 0, key);
  return { ok: true, order: rest };
}

/** layerRows() output in the owner's order. */
function orderLayers(rows, order) {
  const want = normalizeLayerOrder(order);
  return [...(rows || [])].sort((a, b) => want.indexOf(a.key) - want.indexOf(b.key));
}

/* ── detached windows ─────────────────────────────────────────────────────────── */

/**
 * Where a detached pane's window opens: its remembered bounds when they still land on
 * a screen, otherwise `fallback`. "Lands" = at least 80x40 px of its title area is on
 * some work area -- a monitor that was unplugged must not swallow the window.
 */
function fitBounds(saved, workAreas, fallback) {
  const b = normalizeBounds(saved);
  if (!b) return fallback;
  for (const a of Array.isArray(workAreas) ? workAreas : []) {
    const w = Math.min(b.x + b.width, a.x + a.width) - Math.max(b.x, a.x);
    const h = Math.min(b.y + 40, a.y + a.height) - Math.max(b.y, a.y);
    if (w >= 80 && h >= 40) return b;
  }
  return fallback;
}

/** Record a detached pane's window bounds / open state. */
function withDetached(desk, pane, { bounds, open } = {}) {
  const d = normalizeDesk(desk);
  if (!DETACHABLE.includes(pane)) return d;
  const prev = d.detached[pane] || { bounds: null, open: false };
  d.detached[pane] = {
    bounds: bounds === undefined ? prev.bounds : normalizeBounds(bounds),
    open: open === undefined ? prev.open : Boolean(open),
  };
  return d;
}

/* ── export / import ──────────────────────────────────────────────────────────── */

/**
 * The file "Export layout" writes: the model and the owner's presets. Boards are not
 * in it -- each is its own file in ~/Aither Boards, and a linked one syncs with
 * AitherOne (aitherone-link.cjs).
 */
function exportDoc(prefs, { now = new Date() } = {}) {
  const p = rail.normalizeLayout(prefs || {});
  return {
    kind: DOC_KIND,
    v: SCHEMA_VERSION,
    exportedAt: now.toISOString(),
    layout: toModel(p),
    presets: p.desk.presets,
  };
}

/**
 * An imported file -> the prefs patch, or every reason it was refused. Strict: an
 * unknown key anywhere is an error, so a file from a newer desk says so instead of
 * half-applying.
 */
function importDoc(prefs, raw) {
  const errors = [];
  let doc = raw;
  if (typeof raw === "string") {
    try { doc = JSON.parse(raw); } catch { return { ok: false, errors: ["not JSON"] }; }
  }
  if (!isObj(doc)) return { ok: false, errors: ["not a layout file"] };
  for (const k of Object.keys(doc)) {
    if (!["kind", "v", "exportedAt", "layout", "presets"].includes(k)) errors.push(`unknown key: ${k}`);
  }
  if (doc.kind !== DOC_KIND) errors.push(`kind must be ${DOC_KIND}`);
  if (doc.v !== SCHEMA_VERSION) errors.push(`unsupported version: ${doc.v}`);
  const layout = validateModel(doc.layout);
  if (!layout.ok) errors.push(...layout.errors.map((e) => `layout: ${e}`));
  const presets = [];
  if (doc.presets != null) {
    if (!Array.isArray(doc.presets)) errors.push("presets must be a list");
    else {
      for (const [i, pr] of doc.presets.entries()) {
        if (!isObj(pr)) { errors.push(`presets[${i}] must be an object`); continue; }
        for (const k of Object.keys(pr)) if (!["name", "layout"].includes(k)) errors.push(`unknown key: presets[${i}].${k}`);
        const v = validateModel(pr.layout, { partial: true });
        if (!v.ok) errors.push(...v.errors.map((e) => `presets[${i}]: ${e}`));
        else if (cleanName(pr.name)) presets.push({ name: cleanName(pr.name), layout: v.model });
      }
    }
  }
  if (errors.length) return { ok: false, errors };
  const current = rail.normalizeLayout(prefs || {});
  const patch = fromModel(layout.model, current);
  patch.desk.presets = normalizeDesk({ presets }).presets;
  patch.desk.activePreset = null;
  return { ok: true, patch };
}

module.exports = {
  SCHEMA_VERSION,
  DOC_KIND,
  PANE_IDS,
  PANE_LABELS,
  SIDES,
  DETACHABLE,
  BUILTIN_PRESETS,
  BUILTIN_NAMES,
  PINNED_SECTION,
  normalizeDesk,
  toModel,
  fromModel,
  validateModel,
  defaultModel,
  presetList,
  applyPreset,
  savePreset,
  renamePreset,
  deletePreset,
  setPaneSide,
  parsePaneSide,
  railRowKey,
  arrangeRail,
  editRail,
  moveLayer,
  orderLayers,
  fitBounds,
  withDetached,
  exportDoc,
  importDoc,
};
