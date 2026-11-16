"use strict";

/**
 * aither-body.cjs -- which body Aither wears: "Aither (female)" or "Aither (male)".
 *
 * Owner, 2026-11-16: "can select male or female Aither and have it transform from fairy
 * to full avatar". Two avatar-factory builds stand behind the choice:
 *
 *   female  characters/aither-v2  (spec aither-v2, the default Aither since 2026-11-15)
 *   male    characters/aither-m   (spec aither-m)
 *
 * WHERE THE CHOICE LIVES: cast.json `authors.aither.character` -- the one record of
 * which avatar an agent wears (agent-avatars.cjs). It is the row awsettings carries
 * between machines (domain `desk`) and the row the person's avatar catalog writes
 * (avatar-catalog-sync.cjs), so the choice reaches every desk with no second store.
 * A character is matched to a body by its roster name OR by the `spec` its
 * character.json carries: the catalog gives an uploaded model a canonical roster name
 * (`aither-<sha8>`), and that folder still says which spec built it.
 *
 * THE ONE-TIME MOVE: before 2026-11-15 Aither's row named an older model (the
 * identity default was `mermaid`), and the catalog re-wrote that name into cast.json
 * every ten minutes. `planMigration` moves such a row to the default body ONCE and
 * remembers what it replaced (aither-body.json beside cast.json); after that the row is
 * the person's own and is never touched again. `pending` in the same file is a choice
 * the catalog has not been told yet (offline, signed out): it wins over the row until
 * the push lands, so a catalog pull cannot undo a choice made a minute ago.
 *
 * PURE except readState / writeState (one small JSON file). node --test.
 */

const fs = require("node:fs");
const path = require("node:path");

const AGENT = "aither";

const BODIES = Object.freeze([
  Object.freeze({ id: "female", label: "Aither (female)", character: "aither-v2", spec: "aither-v2" }),
  Object.freeze({ id: "male", label: "Aither (male)", character: "aither-m", spec: "aither-m" }),
]);

const DEFAULT_BODY = BODIES[0].id;
const STATE_FILE = "aither-body.json";

function bodyById(id) {
  return BODIES.find((b) => b.id === String(id || "")) || null;
}

/**
 * The body a roster character is, or null when it is not one of Aither's bodies.
 *
 * Args:
 *   name: the roster name (cast.json `authors.aither.character`).
 *   record: that character's character.json (only `spec` is read), or null.
 */
function bodyOfCharacter(name, record = null) {
  const n = String(name || "");
  const spec = record && typeof record === "object" ? String(record.spec || "") : "";
  const hit = BODIES.find((b) => b.character === n) || (spec ? BODIES.find((b) => b.spec === spec) : null);
  return hit ? hit.id : null;
}

/** The bodies this desk can show: the ones whose model is in `names` (the visible roster). */
function available(names) {
  const have = new Set(Array.isArray(names) ? names : []);
  return BODIES.filter((b) => have.has(b.character));
}

/**
 * The body in force: a pending choice, else the row's body, else the default. Never a
 * body this desk has no model for; null when it has none of them.
 *
 * Args:
 *   assigned: cast.json `authors.aither.character` (or null).
 *   record: character.json of `assigned` (or null).
 *   names: the visible roster.
 *   pending: aither-body.json `pending` (a body id not yet in the catalog), or null.
 */
function chosen({ assigned = null, record = null, names = [], pending = null } = {}) {
  const here = available(names);
  if (!here.length) return null;
  const want = bodyById(pending) ? String(pending) : bodyOfCharacter(assigned, record);
  if (want && here.some((b) => b.id === want)) return want;
  return here.some((b) => b.id === DEFAULT_BODY) ? DEFAULT_BODY : here[0].id;
}

/** The roster name the fairy grows into: the chosen body's model, else `fallback`
 *  (character-roster defaultAitherCharacter: a desk with neither build keeps its older Aither). */
function characterToShow({ assigned = null, record = null, names = [], pending = null, fallback = null } = {}) {
  const id = chosen({ assigned, record, names, pending });
  return id ? bodyById(id).character : (fallback || null);
}

/** The menu rows: one per body this desk has, the one in force checked. Fewer than two
 *  bodies = no rows (a choice of one is not a choice; never a dead item). */
function rows(opts = {}) {
  const here = available(opts.names);
  if (here.length < 2) return [];
  const on = chosen(opts);
  return here.map((b) => ({ id: b.id, label: b.label, character: b.character, checked: b.id === on }));
}

/**
 * The one-time move of an old Aither row to the default body.
 *
 * Returns null when there is nothing to do, else
 *   {mark: true}                      -- nothing to change, only remember it was looked at
 *   {mark: true, from, to, body}      -- write `to` into authors.aither.character
 */
function planMigration({ assigned = null, record = null, names = [], state = null } = {}) {
  if (state && state.migratedAt) return null;
  const here = available(names);
  // No build on this desk yet: look again on a later boot, when one has arrived.
  if (!here.length) return null;
  if (bodyOfCharacter(assigned, record)) return { mark: true };
  const body = here.some((b) => b.id === DEFAULT_BODY) ? DEFAULT_BODY : here[0].id;
  return { mark: true, from: assigned ? String(assigned) : null, to: bodyById(body).character, body };
}

function stateFile(dir) {
  return path.join(String(dir || "."), STATE_FILE);
}

/** aither-body.json: {migratedAt, from, pending}. Missing or unreadable = {}. */
function readState(dir) {
  try {
    const parsed = JSON.parse(fs.readFileSync(stateFile(dir), "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const out = {};
    if (typeof parsed.migratedAt === "string" && parsed.migratedAt) out.migratedAt = parsed.migratedAt;
    if (typeof parsed.from === "string" && parsed.from) out.from = parsed.from;
    if (bodyById(parsed.pending)) out.pending = String(parsed.pending);
    return out;
  } catch {
    return {};
  }
}

function writeState(dir, state) {
  const file = stateFile(dir);
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(tmp, `${JSON.stringify(state || {}, null, 2)}\n`);
    fs.renameSync(tmp, file);
    return true;
  } catch {
    try { fs.rmSync(tmp, { force: true }); } catch { /* nothing to clean */ }
    return false;
  }
}

module.exports = {
  AGENT, BODIES, DEFAULT_BODY, STATE_FILE,
  bodyById, bodyOfCharacter, available, chosen, characterToShow, rows, planMigration,
  readState, writeState,
};
