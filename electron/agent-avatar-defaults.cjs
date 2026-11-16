"use strict";

/**
 * agent-avatar-defaults.cjs -- every agent's registry avatar reaches a desk that already
 * has a cast, ONCE, without undoing anything the person chose.
 *
 * Owner, 2026-11-16: "all the fairy/agents and their avatars deployed properly". The ONE
 * record of which body each agent wears is AitherOS/config/agent-avatars.json, generated
 * from the avatar-factory builds; electron/agent-avatars.generated.json is its desk
 * projection (gen_agent_avatar_registry.py --desk-out; never hand-edited). A fresh desk
 * already follows it through the presence mirror. An EXISTING desk does not: measured the
 * same day, the owner's cast.json said atlas = charlie-5e48d775, demiurge =
 * celisia-arcroid-e97fbc35, lyra = clara-hsr-vrm-0-0-f0070392, iris =
 * herta-hsr-vrm-0-0-6076f3b1 -- the OLD declared defaults (and their library copies),
 * hand-pointed at the new builds at 06:28 and re-written back at 06:31 by the avatar
 * catalog, whose record still named the old bodies -- and nova and chaos had no row.
 *
 * THE MOVE (planDefaults, pure): for each registry agent this desk has the build for,
 *   no row                             -> the registry body
 *   anything else                      -> kept
 * RULE (owner, 2026-11-16, P0: "why do I still have these random robot avatars and not my
 * proper fairies/agent avatars"): a body this desk already shows is the person's choice and
 * is NEVER replaced without their OK. The first version also moved a SUPERSEDED default
 * (`supersedes`) onto the registry body as "inherited, nobody chose it" -- but a body the
 * owner has looked at for weeks is chosen by looking, and the new builds rendered as
 * white/pink robots. So the registry only FILLS an empty row now. Replacing is the person's
 * act (the tray's Assign current, the Cast pane, or avatar-catalog-sync with `replace`).
 * An agent is decided ONCE (agent-avatar-defaults.json `seen`, beside cast.json): a later
 * change the person makes is never undone, and an agent the registry adds later is
 * decided on the first boot that has its build. Aither is not here: aither-body.cjs owns
 * that row (female/male choice). Before the first write cast.json is copied beside itself
 * (cast.json.bak-agent-avatar-defaults-<stamp>).
 *
 * PENDING: a moved agent is `pending` until the person's avatar catalog has taken it
 * (avatar-catalog-sync pushes it on every tick). While it is pending a catalog pull does
 * not touch that agent -- otherwise the first pull re-writes the old body, which is
 * exactly what happened at 06:31.
 *
 * CLI (from the desk folder):  node electron/agent-avatar-defaults.cjs [--apply]
 *   prints the plan for this desk's cast; --apply writes it (the desk does this at boot).
 */

const fs = require("node:fs");
const path = require("node:path");

const MIRROR_FILE = path.join(__dirname, "agent-avatars.generated.json");
const STATE_FILE = "agent-avatar-defaults.json";
/** Owned by aither-body.cjs (the female/male choice), never moved here. */
const OWNED_ELSEWHERE = new Set(["aither"]);

function readJson(file) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** The desk projection of the registry: {agents:{agent:{character, supersedes, bodies}}}. */
function loadRegistry(file = MIRROR_FILE) {
  const doc = readJson(file);
  return doc && doc.agents && typeof doc.agents === "object" ? doc : { agents: {} };
}

function characterOf(row) {
  if (typeof row === "string") return row.trim() || null;
  if (row && typeof row === "object" && typeof row.character === "string" && row.character.trim()) return row.character.trim();
  return null;
}

/** `charlie-5e48d775` -> `charlie` (the catalog's canonical name for a library copy). */
function baseName(name) {
  const m = /^(.+)-[0-9a-f]{8}$/.exec(String(name || ""));
  return m ? m[1] : String(name || "");
}

/** Is `name` (with its character.json `record`) one of this registry entry's own builds? */
function isRegistryBuild(entry, name, record) {
  const bodies = Object.values((entry && entry.bodies) || {});
  if (bodies.some((b) => b.character === name)) return true;
  const rec = record && typeof record === "object" ? record : {};
  return bodies.some((b) => (rec.spec && rec.spec === b.spec) || (rec.library_id && rec.library_id === b.library_id));
}

function isSuperseded(entry, name) {
  const old = new Set((entry && entry.supersedes) || []);
  return old.has(name) || old.has(baseName(name));
}

/**
 * The plan for one desk. Pure.
 *
 * Args:
 *   registry: loadRegistry() output.
 *   authors: cast.json `authors` (raw rows).
 *   names: the roster names this desk can show.
 *   recordOf: name -> that folder's character.json (or null).
 *   state: agent-avatar-defaults.json ({seen, pending, from}).
 * Returns {changes:[{agent, from, to}], keep:[{agent, character, why}], waiting:[agent]}.
 */
function planDefaults({ registry, authors = {}, names = [], recordOf = () => null, state = {} } = {}) {
  const have = new Set(Array.isArray(names) ? names : []);
  const seen = (state && state.seen) || {};
  const out = { changes: [], keep: [], waiting: [] };
  for (const [agent, entry] of Object.entries((registry && registry.agents) || {}).sort(([a], [b]) => a.localeCompare(b))) {
    if (OWNED_ELSEWHERE.has(agent) || Object.prototype.hasOwnProperty.call(seen, agent)) continue;
    const target = entry && entry.character;
    if (!target || !have.has(target)) {
      out.waiting.push(agent); // the build is not on this desk yet: decide on a later boot
      continue;
    }
    const current = characterOf(authors && authors[agent]);
    if (!current) {
      out.changes.push({ agent, from: null, to: target });
    } else if (current === target || isRegistryBuild(entry, current, recordOf(current))) {
      out.keep.push({ agent, character: current, why: "already the registry body" });
    } else {
      out.keep.push({ agent, character: current, why: "the person's own choice" });
    }
  }
  return out;
}

function stateFile(dir) {
  return path.join(String(dir || "."), STATE_FILE);
}

function readState(dir) {
  const doc = readJson(stateFile(dir)) || {};
  const plain = (v) => (v && typeof v === "object" && !Array.isArray(v) ? v : {});
  return { ...doc, seen: plain(doc.seen), pending: plain(doc.pending), from: plain(doc.from) };
}

function writeState(dir, state) {
  const file = stateFile(dir);
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`);
    fs.renameSync(tmp, file);
    return true;
  } catch {
    try { fs.rmSync(tmp, { force: true }); } catch { /* nothing to clean */ }
    return false;
  }
}

/** Agents a catalog pull must leave alone: moved here and not yet taken by the catalog. */
function heldAgents(dir) {
  return new Set(Object.keys(readState(dir).pending));
}

function stamp(now) {
  return now.toISOString().replace(/[-:]/g, "").replace(/\..*$/, "").replace("T", "-");
}

function defaults(deps = {}) {
  const castConfig = deps.castConfig || require("./cast-config.cjs");
  const roster = deps.roster || require("./character-roster.cjs");
  const castFile = deps.castFile || castConfig.CAST_FILE();
  const rosterDir = deps.rosterDir || roster.ROSTER_DIR;
  return {
    castConfig,
    castFile,
    dir: path.dirname(castFile),
    names: deps.names || roster.listCharacters(),
    recordOf: deps.recordOf || ((name) => readJson(path.join(rosterDir, String(name), "character.json"))),
    registry: deps.registry || loadRegistry(),
    now: deps.now || (() => new Date()),
    log: deps.log || (() => {}),
  };
}

/**
 * Plan and (unless dryRun) apply the move. Returns {ok, plan, backup, applied}.
 * Never throws: a desk that cannot write its cast keeps the cast it has.
 */
function runDefaults(deps = {}, { dryRun = false } = {}) {
  let d;
  try {
    d = defaults(deps);
  } catch (error) {
    return { ok: false, reason: String((error && error.message) || error), plan: null };
  }
  const state = readState(d.dir);
  const authors = (readJson(d.castFile) || {}).authors || {};
  const plan = planDefaults({ registry: d.registry, authors, names: d.names, recordOf: d.recordOf, state });
  if (dryRun) return { ok: true, plan, applied: false, backup: null };
  const now = d.now();
  let backup = null;
  if (plan.changes.length && fs.existsSync(d.castFile)) {
    backup = path.join(d.dir, `${path.basename(d.castFile)}.bak-agent-avatar-defaults-${stamp(now)}`);
    try {
      fs.copyFileSync(d.castFile, backup, fs.constants.COPYFILE_EXCL);
    } catch (error) {
      if (!fs.existsSync(backup)) return { ok: false, reason: `no backup: ${error.message}`, plan, applied: false };
    }
  }
  if (plan.changes.length) {
    const result = d.castConfig.write((draft) => {
      if (!draft.authors || typeof draft.authors !== "object" || Array.isArray(draft.authors)) draft.authors = {};
      for (const c of plan.changes) {
        const key = d.castConfig.normaliseAuthor ? d.castConfig.normaliseAuthor(c.agent) : c.agent;
        if (!draft.authors[key] || typeof draft.authors[key] !== "object" || Array.isArray(draft.authors[key])) draft.authors[key] = {};
        draft.authors[key].character = c.to;
      }
      return draft;
    }, { file: d.castFile });
    if (!result || !result.ok) return { ok: false, reason: "cast.json could not be written", plan, applied: false, backup };
  }
  const next = { ...state, migratedAt: state.migratedAt || now.toISOString() };
  for (const c of plan.changes) {
    next.seen[c.agent] = c.to;
    next.pending[c.agent] = c.to;
    if (c.from) next.from[c.agent] = c.from;
  }
  for (const k of plan.keep) next.seen[k.agent] = k.character;
  if (backup) next.backup = path.basename(backup);
  if (plan.changes.length || plan.keep.length) writeState(d.dir, next);
  d.log("agent avatar defaults", plan.changes.map((c) => `${c.agent}: ${c.from || "(none)"} -> ${c.to}`));
  return { ok: true, plan, applied: plan.changes.length > 0, backup };
}

/**
 * While a FILL is pending, a settings pull at start (awsettings, settings-sync.cjs) merges
 * another machine's older `authors` leaf by leaf and can empty the row again: a pending
 * agent whose row is EMPTY is filled again. A row naming any body at all is the person's
 * (an old default included) and is never replaced.
 */
function reassertPending(deps = {}) {
  let d;
  try {
    const castConfig = deps.castConfig || require("./cast-config.cjs");
    const castFile = deps.castFile || castConfig.CAST_FILE();
    d = { castConfig, castFile, dir: deps.dir || path.dirname(castFile), registry: deps.registry || loadRegistry() };
  } catch {
    return [];
  }
  const pending = readState(d.dir).pending;
  const authors = (readJson(d.castFile) || {}).authors || {};
  const fix = Object.entries(pending).filter(([agent]) => {
    const now = characterOf(authors[agent]);
    return !now;
  });
  if (!fix.length) return [];
  const result = d.castConfig.write((draft) => {
    if (!draft.authors || typeof draft.authors !== "object" || Array.isArray(draft.authors)) draft.authors = {};
    for (const [agent, to] of fix) {
      if (!draft.authors[agent] || typeof draft.authors[agent] !== "object" || Array.isArray(draft.authors[agent])) draft.authors[agent] = {};
      draft.authors[agent].character = to;
    }
    return draft;
  }, { file: d.castFile });
  return result && result.ok ? fix.map(([agent, to]) => ({ agent, to })) : [];
}

/**
 * The person put a body back by hand (the P0 of 2026-11-16: the first version of this module
 * moved agents onto registry builds, the owner restored the bodies he knows in cast.json,
 * and the catalog -- which had been TOLD the registry bodies -- would have pulled them back).
 * Detected by its trace: `from[agent]` is the body the move replaced, and the row names it
 * again while `seen` still says the registry body. That row is now the person's choice:
 * recorded in `chosen`, and queued as `pending` so the catalog is told THIS body
 * (pushPendingDefaults pushes it; a pull leaves the agent alone until it has).
 * Returns [{agent, character}].
 */
function adoptRestored(deps = {}) {
  let d;
  try {
    const castConfig = deps.castConfig || require("./cast-config.cjs");
    const castFile = deps.castFile || castConfig.CAST_FILE();
    d = { castFile, dir: deps.dir || path.dirname(castFile) };
  } catch {
    return [];
  }
  const state = readState(d.dir);
  const authors = (readJson(d.castFile) || {}).authors || {};
  const adopted = [];
  for (const [agent, was] of Object.entries(state.from)) {
    const now = characterOf(authors[agent]);
    if (!now || now !== was || state.seen[agent] === now) continue;
    state.seen[agent] = now;
    state.pending[agent] = now;
    state.chosen = { ...(state.chosen || {}), [agent]: now };
    adopted.push({ agent, character: now });
  }
  if (adopted.length) writeState(d.dir, state);
  return adopted;
}

/** The catalog took `agent` = `character`: it is no longer pending. */
function markPushed(dir, agent, character) {
  const state = readState(dir);
  if (state.pending[agent] !== character) return false; // a newer move is on its way
  delete state.pending[agent];
  return writeState(dir, state);
}

module.exports = {
  MIRROR_FILE, STATE_FILE,
  loadRegistry, planDefaults, runDefaults, readState, writeState, heldAgents, markPushed, reassertPending, adoptRestored,
  baseName, isSuperseded, isRegistryBuild,
};

if (require.main === module) {
  const apply = process.argv.includes("--apply");
  const out = runDefaults({}, { dryRun: !apply });
  if (!out.ok) {
    process.stderr.write(`FAIL ${out.reason}\n`);
    process.exit(1);
  }
  for (const c of out.plan.changes) process.stdout.write(`${apply ? "moved" : "move "} ${c.agent}: ${c.from || "(no row)"} -> ${c.to}\n`);
  for (const k of out.plan.keep) process.stdout.write(`keep  ${k.agent}: ${k.character} (${k.why})\n`);
  for (const a of out.plan.waiting) process.stdout.write(`wait  ${a}: its build is not on this desk yet\n`);
  if (out.backup) process.stdout.write(`backup ${out.backup}\n`);
}
