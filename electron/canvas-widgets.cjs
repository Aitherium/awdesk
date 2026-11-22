"use strict";

/**
 * canvas-widgets.cjs -- the widget registry behind aither://canvas widget cards.
 *
 * A widget is ONE FILE in electron/canvas-widgets/: drop `<id>.cjs` there and it is on
 * the canvas's "Add widget" menu, with no edit anywhere else. A file exports:
 *
 *   id        lowercase, the file's own name (checked)
 *   label     what the menu and the card header say
 *   hint      one line, the menu's tooltip
 *   view      how the page draws it: "stat" | "list" | "clock" | "note"
 *   size      { w, h } a new card's size, in board pixels
 *   refreshMs how often the page asks for fresh data (0 = never; clock/note draw locally)
 *   read(ctx) async, main-process only, for "stat"/"list": returns
 *             { value, sub, tone } (stat) or { rows: [{label, value}] } (list).
 *             `ctx` is the host's read-only sources (inbox, sessions, inference, os),
 *             injected so every widget is asserted under node --test with fakes.
 *
 * The page can only DRAW the four views (an aither:// page may not load arbitrary
 * scripts, browser-internal.cjs PAGE_SCRIPT_TYPES), so a widget file is data plus a
 * reader -- never markup. Every answer is shape-checked here before it reaches the
 * renderer: strings are cut, numbers are numbers, a list shows at most five rows plus
 * "+N more" (the five law).
 */

const fs = require("node:fs");
const path = require("node:path");

const VIEWS = Object.freeze(["stat", "list", "clock", "note"]);
const TONES = Object.freeze(["ok", "warn", "bad", "muted"]);
const ID = /^[a-z][a-z0-9-]{0,39}$/;
const DIR = path.join(__dirname, "canvas-widgets");
const READ_TIMEOUT_MS = 6000;
const LIST_MAX = 5;

// eslint-disable-next-line no-control-regex
const str = (v, max = 80) => (v == null ? "" : String(v).replace(/[\u0000-\u001f]/g, " ").slice(0, max));

/** Problems with one widget module ([] = fine). */
function widgetProblems(mod, fileId = null) {
  const out = [];
  if (!mod || typeof mod !== "object") return ["exports nothing"];
  if (!ID.test(String(mod.id || ""))) out.push("id must be lowercase letters, digits, dashes");
  if (fileId && mod.id !== fileId) out.push(`id ${mod.id} must match the file name ${fileId}`);
  if (!mod.label || typeof mod.label !== "string") out.push("needs a label");
  if (!VIEWS.includes(mod.view)) out.push(`view must be one of ${VIEWS.join("/")}`);
  const s = mod.size || {};
  if (!(Number(s.w) >= 120 && Number(s.h) >= 80)) out.push("size must be at least 120 x 80");
  if ((mod.view === "stat" || mod.view === "list") && typeof mod.read !== "function") out.push(`a ${mod.view} widget needs read(ctx)`);
  if (mod.refreshMs != null && !(Number(mod.refreshMs) === 0 || Number(mod.refreshMs) >= 2000)) out.push("refreshMs is 0 or >= 2000");
  return out;
}

/** Build a registry from modules (pure; loadRegistry() feeds it the directory). */
function createRegistry(modules) {
  const byId = new Map();
  const problems = [];
  for (const { mod, file } of modules) {
    const fileId = file ? path.basename(file).replace(/\.cjs$/, "") : null;
    const bad = widgetProblems(mod, fileId);
    if (bad.length) { problems.push(`${file || (mod && mod.id) || "?"}: ${bad.join("; ")}`); continue; }
    if (byId.has(mod.id)) { problems.push(`${mod.id}: declared twice`); continue; }
    byId.set(mod.id, mod);
  }

  /** What the page may know about each widget: metadata, never the reader. */
  function list() {
    return [...byId.values()].map((w) => ({
      id: w.id, label: w.label, hint: str(w.hint, 160), view: w.view,
      size: { w: Math.round(w.size.w), h: Math.round(w.size.h) },
      refreshMs: Math.round(Number(w.refreshMs) || 0),
    }));
  }

  /** Read one widget. Never throws; a slow or failing reader answers {ok:false, error}. */
  async function read(id, ctx = {}) {
    const w = byId.get(String(id || ""));
    if (!w) return { ok: false, error: "no such widget" };
    if (typeof w.read !== "function") return { ok: true, view: w.view };
    let timer = null;
    try {
      const raw = await Promise.race([
        Promise.resolve().then(() => w.read(ctx)),
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("timed out")), READ_TIMEOUT_MS); }),
      ]);
      return shape(w.view, raw);
    } catch (error) {
      return { ok: false, view: w.view, error: str((error && error.message) || error, 160) };
    } finally {
      clearTimeout(timer);
    }
  }

  return { list, read, has: (id) => byId.has(String(id || "")), problems: () => problems.slice() };
}

/** A reader's answer, made safe for the page. */
function shape(view, raw) {
  const r = raw && typeof raw === "object" ? raw : {};
  if (r.ok === false) return { ok: false, view, error: str(r.error || "unavailable", 160) };
  if (view === "stat") {
    return {
      ok: true, view,
      value: typeof r.value === "number" && Number.isFinite(r.value) ? r.value : str(r.value, 24),
      sub: str(r.sub, 120),
      tone: TONES.includes(r.tone) ? r.tone : "muted",
    };
  }
  if (view === "list") {
    const rows = (Array.isArray(r.rows) ? r.rows : []).map((row) => ({
      label: str(row && row.label, 60), value: str(row && row.value, 40),
      tone: TONES.includes(row && row.tone) ? row.tone : "muted",
    }));
    return { ok: true, view, rows: rows.slice(0, LIST_MAX), more: Math.max(0, rows.length - LIST_MAX), sub: str(r.sub, 120) };
  }
  return { ok: true, view };
}

/** Every widget file in electron/canvas-widgets/. */
function loadRegistry(dir = DIR) {
  let files;
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith(".cjs") && !f.endsWith(".test.cjs")).sort();
  } catch {
    files = [];
  }
  const modules = [];
  for (const file of files) {
    try {
      modules.push({ mod: require(path.join(dir, file)), file });
    } catch (error) {
      modules.push({ mod: null, file: `${file} (${(error && error.message) || error})` });
    }
  }
  return createRegistry(modules);
}

module.exports = { VIEWS, TONES, LIST_MAX, DIR, widgetProblems, createRegistry, loadRegistry, shape };
