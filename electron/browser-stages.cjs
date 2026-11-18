"use strict";

/**
 * browser-stages.cjs -- a STAGE: a named, saved Aither Browser arrangement bound to a
 * workspace (the owner's "keep my Garg work in one place, my own browsing in another").
 *
 * A stage holds, as one document:
 *   name        what the switcher shows
 *   workspace   the workspace slug this stage belongs to ("garg", "aitherium"), or "" for
 *               the owner's own session. Switching to a stage whose workspace is the one
 *               this desk is signed into loads that stage's tabs under the WORKSPACE
 *               PARTITION (browser-workspace-policy.cjs `persist:aither-work-<tenant>`),
 *               so one stage's cookies never reach another's tabs. A slug this desk is
 *               not signed into cannot make a partition out of nothing: its tabs open in
 *               the owner's own session and `resolveScope` says why (never a silent no-op).
 *   tabs        the tab descriptors to bring back when the stage is first shown
 *               (url, title, kind, owner, pinned, key, label). InPrivate tabs are never
 *               saved -- that is the whole point of InPrivate.
 *   splits      the split-pane layout, carried for the split-panes slice; validated and
 *               round-tripped here so the document does not have to change when it lands.
 *   terminals   the awsh harness session ids the stage had attached
 *   roots       the file-explorer root ids the stage was working in
 *
 * WHERE IT LIVES. Not in browser-layout.json: browser-rail.normalizeLayout drops every
 * key it does not name, so a stage document written there would vanish on the next read
 * (desk-layout.cjs says so in its own header). It is userData/stages.json, one file, with
 * the same discipline as that document: every read is normalized, so a hand-edited or
 * half-written file cannot wedge the browser -- it falls back to one default stage and
 * reports why. The layout store's PRESETS are geometry; a stage is content, and the two
 * are deliberately different stores.
 *
 * Pure apart from `load`/`save` (node:fs, injected in tests). The window wiring is in
 * browser-window.cjs (`stageAction`, `switchStage`); the chrome UI is a switcher left of
 * the tab strip. Avatar "stages" (stage-window.cjs) are a different thing; in new UI text
 * these are "Stage" and the avatar's remain "Room".
 */

const FILE_NAME = "stages.json";
const SCHEMA_VERSION = 1;
const DOC_KIND = "aither-browser-stages";

const MAX_STAGES = 12;
const MAX_NAME = 40;
const MAX_TABS = 30; // the browser's own per-stage strip cap (browser-tabs MAX_TABS)
const MAX_TERMINALS = 12;
const MAX_ROOTS = 12;
const MAX_SPLITS = 4;
const MAX_URL = 2048;
const MAX_TEXT = 200;
/** A workspace slug: the same shape a tenant id must have (browser-workspace-policy TENANT). */
const SLUG = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const TAB_KINDS = Object.freeze(["web", "internal", "hosted", "extension"]);
const TAB_OWNERS = Object.freeze(["you", "agent"]);
const DEFAULT_NAME = "Stage 1";
/** The owner's own session (browser-window PARTITION); the default scope of a stage with no workspace. */
const OWNER_PARTITION = "persist:aither-browser";

const isObj = (v) => Boolean(v) && typeof v === "object" && !Array.isArray(v);
// eslint-disable-next-line no-control-regex
const cleanText = (v, max = MAX_NAME) => (typeof v === "string" ? v.replace(/[\u0000-\u001f]/g, "").trim().slice(0, max) : "");

/** A saved tab: an address the browser can open again, and how it was opened. */
function normalizeTab(raw) {
  if (!isObj(raw)) return null;
  // InPrivate is a promise, not a preference: an in-memory tab leaves no descriptor.
  if (raw.private === true) return null;
  const url = cleanText(raw.url, MAX_URL);
  if (!url || !/^(https?:|aither:|about:blank|chrome-extension:)/i.test(url)) return null;
  const kind = TAB_KINDS.includes(raw.kind) ? raw.kind : "web";
  return {
    url,
    title: cleanText(raw.title, MAX_TEXT),
    kind,
    by: TAB_OWNERS.includes(raw.by) ? raw.by : "you",
    pinned: raw.pinned === true,
    key: cleanText(raw.key, MAX_NAME) || null,
    label: cleanText(raw.label, MAX_NAME),
  };
}

/** The saved tabs of one stage: in strip order, no duplicates, capped, never InPrivate. */
function normalizeTabs(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  const seen = new Set();
  for (const item of raw) {
    const tab = normalizeTab(item);
    if (!tab || seen.has(tab.url)) continue;
    seen.add(tab.url);
    out.push(tab);
    if (out.length >= MAX_TABS) break;
  }
  return out;
}

function normalizeTerminals(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const id of raw) {
    const clean = typeof id === "string" ? id.trim().slice(0, 80) : "";
    if (clean && !out.includes(clean)) out.push(clean);
    if (out.length >= MAX_TERMINALS) break;
  }
  return out;
}

function normalizeRoots(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const id of raw) {
    const clean = cleanText(id, MAX_TEXT);
    if (clean && !out.includes(clean)) out.push(clean);
    if (out.length >= MAX_ROOTS) break;
  }
  return out;
}

/**
 * The split layout a stage remembers. A split is one region of the page: its direction
 * and its share of the window. Carried now, applied by the split-panes slice; anything
 * out of range is clamped, never refused, so a file from a wider screen still loads.
 */
function normalizeSplits(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const item of raw) {
    if (!isObj(item)) continue;
    const dir = item.dir === "row" || item.dir === "column" ? item.dir : "row";
    const ratio = Number(item.ratio);
    out.push({ dir, ratio: Number.isFinite(ratio) ? Math.min(0.9, Math.max(0.1, Math.round(ratio * 100) / 100)) : 0.5 });
    if (out.length >= MAX_SPLITS) break;
  }
  return out;
}

function normalizeStage(raw, id) {
  const s = isObj(raw) ? raw : {};
  const workspace = typeof s.workspace === "string" && SLUG.test(s.workspace.trim().toLowerCase())
    ? s.workspace.trim().toLowerCase() : "";
  return {
    id,
    name: cleanText(s.name) || DEFAULT_NAME,
    workspace,
    tabs: normalizeTabs(s.tabs),
    splits: normalizeSplits(s.splits),
    terminals: normalizeTerminals(s.terminals),
    roots: normalizeRoots(s.roots),
  };
}

/**
 * The whole document, sanitized. A missing, empty or unreadable `stages` list becomes one
 * default stage; ids are unique and `active` always names one of them, so the browser can
 * always say which stage it is in.
 */
function normalizeDoc(raw) {
  const d = isObj(raw) ? raw : {};
  const stages = [];
  const used = new Set();
  const freeId = () => {
    let n = 1;
    while (used.has(`s${n}`)) n += 1;
    return `s${n}`;
  };
  if (Array.isArray(d.stages)) {
    for (const item of d.stages) {
      if (stages.length >= MAX_STAGES) break;
      const src = isObj(item) ? item : {};
      let id = cleanText(src.id, 32);
      if (!/^s[0-9]{1,6}$/.test(id) || used.has(id)) id = "";
      if (!id) id = freeId();
      used.add(id);
      const stage = normalizeStage(src, id);
      // Two stages cannot share a name: the switcher would be ambiguous.
      let name = stage.name;
      let n = 2;
      while (stages.some((x) => x.name === name)) name = `${stage.name.slice(0, MAX_NAME - 3)} ${n++}`;
      stage.name = name;
      stages.push(stage);
    }
  }
  if (!stages.length) stages.push(normalizeStage({ name: DEFAULT_NAME }, "s1"));
  let nextId = Number.isInteger(d.nextId) && d.nextId > 0 && d.nextId < 1_000_000 ? d.nextId : 0;
  if (!nextId) nextId = Math.max(...stages.map((s) => Number(s.id.slice(1)) || 0)) + 1;
  const active = cleanText(d.active, 32);
  return {
    v: SCHEMA_VERSION,
    kind: DOC_KIND,
    active: stages.some((s) => s.id === active) ? active : stages[0].id,
    nextId,
    stages,
  };
}

function defaultDoc() {
  return normalizeDoc({});
}

function clone(doc) {
  return JSON.parse(JSON.stringify(normalizeDoc(doc)));
}

function find(doc, id) {
  return normalizeDoc(doc).stages.find((s) => s.id === id) || null;
}

function activeStage(doc) {
  const d = normalizeDoc(doc);
  return d.stages.find((s) => s.id === d.active) || d.stages[0];
}

/** What the switcher draws: every stage, in order, with its workspace and how many tabs it holds. */
function list(doc) {
  const d = normalizeDoc(doc);
  return d.stages.map((s) => ({
    id: s.id, name: s.name, workspace: s.workspace, tabs: s.tabs.length, active: s.id === d.active,
  }));
}

function uniqueName(d, want) {
  const base = cleanText(want) || DEFAULT_NAME;
  if (!d.stages.some((s) => s.name === base)) return base;
  let n = 2;
  for (;;) {
    const name = `${base.slice(0, MAX_NAME - 3)} ${n++}`;
    if (!d.stages.some((s) => s.name === name)) return name;
  }
}

/**
 * Make a stage. `at` puts it next to another stage in the switcher (the UI's "new stage
 * after this one"); without it the new stage goes last and becomes the active one.
 */
function create(doc, { name = "", workspace = "", at = null } = {}) {
  const d = clone(doc);
  if (d.stages.length >= MAX_STAGES) return { ok: false, error: `at most ${MAX_STAGES} stages` };
  const taken = new Set(d.stages.map((s) => Number(s.id.slice(1)) || 0));
  let id = `s${d.nextId}`;
  while (taken.has(Number(id.slice(1)))) id = `s${(d.nextId += 1)}`;
  d.nextId = Math.max(d.nextId + 1, Number(id.slice(1)) + 1);
  const stage = normalizeStage({ name: uniqueName(d, name), workspace }, id);
  const index = at ? d.stages.findIndex((s) => s.id === at) : -1;
  if (index >= 0) d.stages.splice(index + 1, 0, stage);
  else d.stages.push(stage);
  d.active = id;
  return { ok: true, doc: normalizeDoc(d), stage: find(d, id) };
}

function rename(doc, id, name) {
  const d = clone(doc);
  const stage = d.stages.find((s) => s.id === id);
  if (!stage) return { ok: false, error: `no stage ${id}` };
  const want = cleanText(name);
  if (!want) return { ok: false, error: "a stage needs a name" };
  if (d.stages.some((s) => s.id !== id && s.name === want)) return { ok: false, error: `${want} already exists` };
  stage.name = want;
  return { ok: true, doc: normalizeDoc(d) };
}

/** Delete a stage. The last one is refused: the browser is always in a stage. */
function remove(doc, id) {
  const d = clone(doc);
  const index = d.stages.findIndex((s) => s.id === id);
  if (index < 0) return { ok: false, error: `no stage ${id}` };
  if (d.stages.length <= 1) return { ok: false, error: "the last stage cannot be deleted" };
  d.stages.splice(index, 1);
  if (d.active === id) d.active = d.stages[Math.min(index, d.stages.length - 1)].id;
  return { ok: true, doc: normalizeDoc(d), active: d.active };
}

/** Reorder: by absolute `index`, or `by` +1/-1 for the keyboard. */
function move(doc, id, { index = null, by = 0 } = {}) {
  const d = clone(doc);
  const now = d.stages.findIndex((s) => s.id === id);
  if (now < 0) return { ok: false, error: `no stage ${id}` };
  const [stage] = d.stages.splice(now, 1);
  const at = index != null
    ? Math.max(0, Math.min(d.stages.length, Math.round(Number(index) || 0)))
    : Math.max(0, Math.min(d.stages.length, now + (Number(by) < 0 ? -1 : 1)));
  d.stages.splice(at, 0, stage);
  return { ok: true, doc: normalizeDoc(d) };
}

/**
 * Bind a stage to a workspace slug ("" = the owner's own session). The slug does not
 * have to be one this desk is signed into -- the binding is a fact about the stage, and
 * `resolveScope` is what says whether the partition can be honoured right now.
 */
function assignWorkspace(doc, id, slug) {
  const d = clone(doc);
  const stage = d.stages.find((s) => s.id === id);
  if (!stage) return { ok: false, error: `no stage ${id}` };
  const want = String(slug == null ? "" : slug).trim().toLowerCase();
  if (want && !SLUG.test(want)) return { ok: false, error: "a workspace is a short slug: letters, digits, . _ -" };
  stage.workspace = want;
  return { ok: true, doc: normalizeDoc(d) };
}

function setActive(doc, id) {
  const d = clone(doc);
  if (!d.stages.some((s) => s.id === id)) return { ok: false, error: `no stage ${id}` };
  d.active = id;
  return { ok: true, doc: normalizeDoc(d) };
}

/** Replace a stage's saved tabs (a switch writes the live strip back here). */
function setTabs(doc, id, tabs) {
  const d = clone(doc);
  const stage = d.stages.find((s) => s.id === id);
  if (!stage) return { ok: false, error: `no stage ${id}` };
  stage.tabs = normalizeTabs(tabs);
  return { ok: true, doc: normalizeDoc(d) };
}

/** What the stage was working with: awsh session ids and file-explorer root ids. */
function setContext(doc, id, { terminals, roots } = {}) {
  const d = clone(doc);
  const stage = d.stages.find((s) => s.id === id);
  if (!stage) return { ok: false, error: `no stage ${id}` };
  if (terminals !== undefined) stage.terminals = normalizeTerminals(terminals);
  if (roots !== undefined) stage.roots = normalizeRoots(roots);
  return { ok: true, doc: normalizeDoc(d) };
}

function setSplits(doc, id, splits) {
  const d = clone(doc);
  const stage = d.stages.find((s) => s.id === id);
  if (!stage) return { ok: false, error: `no stage ${id}` };
  stage.splits = normalizeSplits(splits);
  return { ok: true, doc: normalizeDoc(d) };
}

/**
 * Which session a stage's tabs load under. This is the ONE decision the workspace
 * binding makes, and it fails toward the owner's own session, never toward a partition
 * that is not backed by a policy in force.
 *
 *   {workspace, partition, live, matched, reason}
 *
 * `matched` says the stage names the workspace this desk is actually in. `live` is true
 * only when that workspace ALSO has a signed policy in force, i.e. a real work partition
 * (`persist:aither-work-<tenant>`) exists; then the tabs ride it, cookies and all.
 * Otherwise the tabs ride `ownerPartition` and `reason` says why in words the switcher
 * shows ("this desk is in garg, not aitherium").
 */
function resolveScope(slug, { signed = "", workPartition = null, ownerPartition = OWNER_PARTITION } = {}) {
  const want = typeof slug === "string" ? slug.trim().toLowerCase() : "";
  const here = typeof signed === "string" ? signed.trim().toLowerCase() : "";
  const matched = Boolean(want) && want === here;
  if (!want) return { workspace: "", partition: ownerPartition, live: false, matched: false, reason: "" };
  if (matched) {
    if (workPartition) return { workspace: want, partition: workPartition, live: true, matched: true, reason: "" };
    return { workspace: want, partition: ownerPartition, live: false, matched: true,
      reason: `no workspace policy is in force here, so ${want}'s tabs open in your own session` };
  }
  return { workspace: want, partition: ownerPartition, live: false, matched: false,
    reason: here ? `this desk is in ${here}, not ${want}; its tabs open in your own session`
      : `this desk is not signed into ${want}; its tabs open in your own session` };
}

/**
 * Read the document. Never throws: a missing file is a fresh start, and a corrupt one is
 * a fresh start that SAYS SO (`warnings`), which the switcher shows once. `corrupt` tells
 * the caller the file was there and unreadable, so a bad file is not silently replaced
 * without the owner hearing about it.
 */
function load(file, { fsImpl = require("node:fs") } = {}) {
  let text;
  try {
    text = fsImpl.readFileSync(file, "utf8");
  } catch (error) {
    if (error && error.code === "ENOENT") return { doc: defaultDoc(), warnings: [], corrupt: false, exists: false };
    return { doc: defaultDoc(), warnings: [`stages: ${file} could not be read (${(error && error.code) || "error"}); starting with one stage`],
      corrupt: false, exists: false };
  }
  let raw;
  try {
    raw = JSON.parse(text);
  } catch {
    return { doc: defaultDoc(), warnings: [`stages: ${file} is not JSON; starting with one stage`], corrupt: true, exists: true };
  }
  const doc = normalizeDoc(raw);
  const warnings = [];
  if (isObj(raw) && raw.kind != null && raw.kind !== DOC_KIND) warnings.push(`stages: ignored a ${raw.kind} file`);
  if (Array.isArray(raw && raw.stages) && raw.stages.length > doc.stages.length) {
    warnings.push(`stages: only the first ${MAX_STAGES} stages are kept`);
  }
  return { doc, warnings, corrupt: false, exists: true };
}

/** Write the document atomically (tmp + rename), so a crash mid-write never truncates it. */
function save(file, doc, { fsImpl = require("node:fs"), pathImpl = require("node:path") } = {}) {
  const body = `${JSON.stringify(normalizeDoc(doc), null, 2)}\n`;
  const tmp = `${file}.tmp`;
  try {
    fsImpl.mkdirSync(pathImpl.dirname(file), { recursive: true });
    fsImpl.writeFileSync(tmp, body);
    fsImpl.renameSync(tmp, file);
    return { ok: true, file };
  } catch (error) {
    try { fsImpl.unlinkSync(tmp); } catch { /* nothing to clean */ }
    return { ok: false, file, error: String((error && error.message) || error) };
  }
}

module.exports = {
  FILE_NAME,
  SCHEMA_VERSION,
  DOC_KIND,
  MAX_STAGES,
  MAX_TABS,
  DEFAULT_NAME,
  OWNER_PARTITION,
  normalizeDoc,
  defaultDoc,
  find,
  activeStage,
  list,
  create,
  rename,
  remove,
  move,
  assignWorkspace,
  setActive,
  setTabs,
  setContext,
  setSplits,
  normalizeTabs,
  resolveScope,
  load,
  save,
};
