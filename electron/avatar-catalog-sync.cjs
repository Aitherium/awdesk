"use strict";

/**
 * avatar-catalog-sync -- the agent avatars follow the person to every desk.
 *
 * Owner ask (2026-10-16): "bring my agent avatars to every device I own easily". The
 * platform catalog (aither-avatars GET /api/avatars/catalog) is the ONE record of which
 * avatar each agent wears; the web, the phone and every desk read it. This module is the
 * desk's half, both directions:
 *
 *   pull  syncFromCatalog(): for every agent the catalog dresses, make sure that model is
 *         on THIS desk (downloaded once, by digest -- avatar-library-sync.ensure*), then
 *         point cast.json `authors[<agent>].character` at it. cast.json is what awsettings
 *         syncs (domain `desk`, key `authors`), so the roster name travels with it too.
 *   push  pushAssignment(agent, character): the tray's "Assign current" also tells the
 *         catalog. A character that came FROM the library carries `library_id`; one that
 *         lives only on this desk is uploaded to the person's library first (their own
 *         file, into their own private library), its folder is stamped with the library
 *         id, and the model is ALSO given its canonical roster name (libraryRosterName:
 *         a hard link, no second copy of the bytes). Every desk then calls that agent's
 *         avatar by the same name, so the `authors` row awsettings carries between
 *         machines means the same thing on each of them -- no per-machine flapping.
 *   library  seedLibraryFromDesk(): every OTHER character on this desk goes into the
 *         person's own library too (owner ask 2026-10-17: the desk avatars sync into the
 *         Avatar library), skipped when the library already holds those bytes (sha256) or
 *         the folder is stamped with a library id it still has. Each upload carries the
 *         character's EFFECTIVE desk rating (content-rating.getRating: an unjudged one goes
 *         up "unknown", never "general"), so a child's Sprite-body picker -- which grants
 *         only "general" (lib/avatars/sprite_body.py grantable) -- never sees an adult or
 *         unjudged body. VRoid Hub references and forks (no mesh of their own) never upload.
 *   seed  seedFromDesk(): push every assignment this desk already has -- how the owner's
 *         existing setup becomes the catalog on day one. startCatalogSync does it ONCE by
 *         itself when the catalog names no agent yet and this desk has assignments (the
 *         person's own desk, signed in as them, uploading their own files to their own
 *         private library), so nobody has to run a command.
 *
 * Nothing here sends an owner, tenant or user id: the person's Identity token decides
 * (market-client.cjs storeRequest). A kid desk never starts this (main.cjs returns before).
 * Electron-free and injectable, so avatar-catalog-sync.test.cjs runs under `node --test`.
 *
 * CLI (from the desk folder):  node electron/avatar-catalog-sync.cjs --seed | --sync
 */

const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const { setImmediate: yieldToLoop } = require("node:timers/promises");

const nodeCrypto = require("node:crypto");
const localOnly = require("./local-only.cjs");

const PULL_INTERVAL_MS = 10 * 60 * 1000;
const LIBRARY_RATINGS = new Set(["general", "r15", "r18"]);
/** Stop a library pass after this many failures in a row (the service is down: the
 *  next tick retries, instead of timing out on every remaining character now). */
const LIBRARY_FAIL_STREAK = 3;
/**
 * The library seed used to read EVERY model.vrm whole (`readFileSync`) on the Electron
 * MAIN thread and hold the Buffers while each upload was in flight. On the owner's desk
 * (93 characters, 92 models, 2.0 GB, the largest 63 MiB) that walked the main process
 * from ~150 MB to ~650 MB in a pass, with 0.2-1 s of main-thread stall per file -- and
 * the resource watchdog reads that ramp as a runaway (`RUNAWAY_MB = 400` in a minute)
 * and restarts the desk. Measured 2026-11-20 on 0.1.35: main 150 -> 655 MB, then the
 * desk vanished. The seed is streamed now (a 1 MiB window, not the whole file), yields
 * between characters, and reads a file's bytes only when it must actually upload it.
 * A pass also stops after this many bytes and lets the next tick finish the rest, so a
 * single tick can never hold the whole roster.
 */
const SEED_READ_CHUNK = 1 * 1024 * 1024;
const MAX_SEED_BYTES_PER_PASS = 1024 * 1024 * 1024;
// Uploading a model makes the client hold the file as a Buffer AND a Blob (and the
// fetch body is a third copy), ~3x the model. A first seed with 27 unstamped 60 MB
// models otherwise kept ~5 of those alive between GCs -- the 300+ MB external peak
// measured 2026-11-20. At most this many uploads / bytes go up per pass; the rest are
// deferred to the next tick (each upload stamps its folder, so nothing repeats).
const MAX_SEED_UPLOADS_PER_PASS = 8;
const MAX_SEED_UPLOAD_BYTES_PER_PASS = 256 * 1024 * 1024;
/** The in-process FALLBACK (the utility process could not start) is stricter: its
 *  copies are the desk's own heap, so two models per tick at most. */
const FALLBACK_SEED_UPLOADS = 2;
const FALLBACK_SEED_UPLOAD_BYTES = 128 * 1024 * 1024;
const GLB_MAGIC = 0x46546c67;
const GLB_JSON_CHUNK = 0x4e4f534a;
const GLB_MAX_JSON = 16 * 1024 * 1024;

function defaults(deps = {}) {
  const roster = deps.roster || require("./character-roster.cjs");
  return {
    client: deps.client || require("./market-client.cjs"),
    library: deps.library || require("./avatar-library-sync.cjs"),
    agents: deps.agents || require("./agent-avatars.cjs"),
    roster,
    rosterDir: deps.rosterDir || roster.ROSTER_DIR,
    rating: deps.contentRating || null,
    log: deps.log || (() => {}),
  };
}

function readRecord(rosterDir, name) {
  try {
    return JSON.parse(fs.readFileSync(path.join(rosterDir, name, "character.json"), "utf8")) || {};
  } catch {
    return {};
  }
}

function stampLibraryId(rosterDir, name, record, digest = null) {
  const file = path.join(rosterDir, name, "character.json");
  const current = readRecord(rosterDir, name);
  const next = { ...current, library_id: String(record.id), library_sha256: String(record.sha256 || "") };
  // Keep the digest we just computed so a later pass can look the model up WITHOUT
  // re-reading a 63 MiB file (the factory already writes this field on a rebuild).
  if (typeof digest === "string" && /^[0-9a-f]{64}$/i.test(digest)) next.model_sha256 = digest.toLowerCase();
  try {
    fs.writeFileSync(file, JSON.stringify(next, null, 2));
    return true;
  } catch {
    return false;
  }
}

/** The first ~16 MiB of a GLB (its whole JSON chunk), or null when it is not a GLB.
 *  Bounded on purpose: the local-only stamp lives in that chunk, never in the mesh. */
async function readGlbPrefix(file) {
  let handle;
  try {
    handle = await fsp.open(file, "r");
    const head = Buffer.alloc(20);
    const first = await handle.read(head, 0, 20, 0);
    if (first.bytesRead < 20) return null;
    if (head.readUInt32LE(0) !== GLB_MAGIC || head.readUInt32LE(16) !== GLB_JSON_CHUNK) return null;
    const n = head.readUInt32LE(12);
    if (n <= 0 || n > GLB_MAX_JSON) return null;
    const json = Buffer.alloc(n);
    const second = await handle.read(json, 0, n, 20);
    if (second.bytesRead < n) return null;
    return Buffer.concat([head, json]);
  } catch {
    return null;
  } finally {
    try { await handle?.close(); } catch { /* already closed */ }
  }
}

/** sha256 of a file in 1 MiB chunks: memory stays flat whatever the model's size. */
function hashFileStreaming(file) {
  return new Promise((resolve, reject) => {
    const hash = nodeCrypto.createHash("sha256");
    const stream = fs.createReadStream(file, { highWaterMark: SEED_READ_CHUNK });
    stream.on("error", reject);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolve(hash.digest("hex")));
  });
}

async function fileSize(file) {
  try { return (await fsp.stat(file)).size; } catch { return 0; }
}

/** Where agent-avatar-defaults.json lives: beside cast.json (null when unresolvable). */
function defaultsDir(deps = {}) {
  if (deps.defaultsDir) return deps.defaultsDir;
  try {
    return path.dirname(require("./cast-config.cjs").CAST_FILE());
  } catch {
    return null;
  }
}

/** Agents a pull leaves alone: a desk move (agent-avatar-defaults.cjs) the catalog has not
 *  taken yet. Measured 2026-11-16: without this the next pull re-wrote the old bodies. */
function heldAgents(deps = {}) {
  if (typeof deps.held === "function") return deps.held();
  const dir = defaultsDir(deps);
  try {
    return dir ? require("./agent-avatar-defaults.cjs").heldAgents(dir) : new Set();
  } catch {
    return new Set();
  }
}

/** Push every pending registry move to the catalog; each one that lands stops being held. */
async function pushPendingDefaults(deps = {}) {
  const dir = defaultsDir(deps);
  if (!dir) return { ok: true, results: [] };
  const agentDefaults = require("./agent-avatar-defaults.cjs");
  const restored = agentDefaults.adoptRestored({ dir });
  if (restored.length) (deps.log || (() => {}))("bodies the person put back are kept and told to the catalog", restored);
  const again = agentDefaults.reassertPending({ dir, registry: deps.registry });
  if (again.length) (deps.log || (() => {}))("registry avatars re-applied (an older cast arrived first)", again);
  const results = [];
  for (const [agent, character] of Object.entries(agentDefaults.readState(dir).pending)) {
    const r = await pushAssignment(agent, character, deps);
    if (r.ok) agentDefaults.markPushed(dir, agent, character);
    results.push(r);
  }
  if (results.length) (deps.log || (() => {}))("registry avatars pushed to the catalog", results.map((r) => [r.agent, r.ok ? r.id : r.reason]));
  return { ok: results.every((r) => r.ok), results };
}

function pulledFor(deps) {
  try {
    const dir = defaultsDir(deps);
    return dir ? require("./agent-avatar-defaults.cjs").pulledMap(dir) : {};
  } catch {
    return {};
  }
}

function notePulled(deps, agent, name) {
  try {
    const dir = defaultsDir(deps);
    if (dir) require("./agent-avatar-defaults.cjs").markPulled(dir, agent, name);
  } catch { /* the note is a convenience */ }
}

/** The person assigned this body themselves: it is no longer a row a pull may replace. */
function clearPulled(deps, agent) {
  try {
    const dir = defaultsDir(deps);
    if (dir) require("./agent-avatar-defaults.cjs").markPulled(dir, agent, null);
  } catch { /* the note is a convenience */ }
}

/** Is `name` a character this desk can show right now? */
function onDesk(d, name) {
  try {
    const names = d.roster.listAllCharacters ? d.roster.listAllCharacters() : d.roster.listCharacters();
    return Array.isArray(names) && names.includes(name);
  } catch {
    return false;
  }
}

/** Pull: fetch the models the catalog names; only `replace: true` (the person's own act) writes a row. */
async function syncFromCatalog(deps = {}) {
  const d = defaults(deps);
  const cat = await d.client.avatarCatalog(deps.clientDeps);
  if (!cat.ok) return { ok: false, reason: cat.reason, results: [] };
  const byId = new Map();
  for (const r of [...cat.avatars, ...cat.starters]) if (r && typeof r.id === "string") byId.set(r.id, r);
  const held = heldAgents(deps);
  const results = [];
  for (const [agent, id] of Object.entries(cat.agents)) {
    if (held.has(agent)) {
      results.push({ agent, ok: true, held: true, reason: "a desk move the catalog has not taken yet" });
      continue;
    }
    const record = byId.get(id);
    if (!record) {
      results.push({ agent, ok: false, reason: "that avatar is not in the library" });
      continue;
    }
    // A body this desk already shows is the person's (owner 2026-11-16, P0: robots came back over
    // the bodies he knows). A pull only FILLS an empty row, or fetches the model a row already
    // names; replacing a shown body is the person's act (`replace`: the manual "sync now").
    // ...except a row an earlier PULL wrote (agent-avatar-defaults pulledMap): that was never his choice, so a
    // body assigned on another desk still follows the person here (review of #104).
    const shown = d.agents.getAgentAvatar(agent);
    const pulledBefore = pulledFor(deps)[agent];
    if (shown && deps.replace !== true && onDesk(d, shown) && pulledBefore !== shown) {
      results.push({ agent, ok: true, name: shown, installed: false, changed: false, kept: true, reason: "this desk already shows a body for it" });
      continue;
    }
    const ensured = record.source === "vroid"
      ? await d.library.ensureVroidReference(record, deps)
      : await d.library.ensureLibraryAvatar(record, deps);
    if (!ensured.ok) {
      results.push({ agent, ok: false, reason: ensured.reason });
      continue;
    }
    const current = d.agents.getAgentAvatar(agent);
    if (current && current !== ensured.name && deps.replace !== true && pulledBefore !== current) {
      // The row names a body whose model was missing: the catalog's record is fetched, the row stays.
      results.push({ agent, ok: true, name: current, installed: ensured.installed, changed: false, kept: true, reason: "this desk already names a body for it" });
      continue;
    }
    const changed = current !== ensured.name;
    // 🚩 An AUTOMATIC pull never puts a body on anyone (owner 2026-11-17: "I can't have Aither/bots
    // randomly selecting avatars"). The catalog is writable by agents; what it says is a PROPOSAL
    // the owner applies with one click. Only `replace` -- the person's own "sync now" -- writes.
    if (changed && deps.replace !== true) {
      results.push({ agent, ok: true, name: current || null, installed: ensured.installed, changed: false, proposed: ensured.name, reason: "the catalog proposes a body; only the owner applies it" });
      continue;
    }
    if (changed) {
      d.agents.setAgentAvatar(agent, ensured.name);
      notePulled(deps, agent, ensured.name); // only a row THIS pull wrote counts as pulled (review of #104)
    }
    results.push({ agent, ok: true, name: ensured.name, installed: ensured.installed, changed });
  }
  d.log("avatar catalog sync", results.filter((r) => r.changed || r.installed || !r.ok));
  return { ok: true, results };
}

/** Give an uploaded desk character its canonical roster name too (hard link, else copy). */
function adoptCanonical(d, character, record) {
  const canonical = d.library.libraryRosterName(record);
  if (!canonical || canonical === character) return character;
  const dest = path.join(d.rosterDir, canonical);
  if (fs.existsSync(path.join(dest, "model.vrm"))) return canonical;
  const model = d.roster.resolveModelFile ? d.roster.resolveModelFile(character) : path.join(d.rosterDir, character, "model.vrm");
  try {
    fs.mkdirSync(dest, { recursive: true });
    try {
      fs.linkSync(model, path.join(dest, "model.vrm"));
    } catch {
      fs.copyFileSync(model, path.join(dest, "model.vrm"));
    }
    for (const extra of ["thumbnail.jpg", "fullbody.jpg", "profile.json"]) {
      const src = path.join(d.rosterDir, character, extra);
      if (fs.existsSync(src)) fs.copyFileSync(src, path.join(dest, extra));
    }
    const rec = readRecord(d.rosterDir, character);
    fs.writeFileSync(path.join(dest, "character.json"), JSON.stringify({
      ...rec, library_id: String(record.id), library_sha256: String(record.sha256 || ""),
      display_name: String(rec.display_name || record.name || canonical).slice(0, 80),
    }, null, 2));
    return canonical;
  } catch {
    return character;
  }
}

/** The rating a desk character goes up with: its EFFECTIVE desk rating, never the raw
 *  character.json field (a rater "default" stamp reads "general" there but means nobody
 *  looked). Anything but general/r15/r18 is "unknown" -- private, never child-grantable. */
function uploadRating(d, character) {
  try {
    const cr = d.rating || require("./content-rating.cjs");
    const rating = String(cr.getRating(character) || "").toLowerCase();
    return LIBRARY_RATINGS.has(rating) ? rating : "unknown";
  } catch {
    return "unknown";
  }
}

/**
 * Does the folder's library stamp describe OTHER bytes than the model it holds now?
 *
 * Measured 2026-11-16: aither-v2 and aither-m were rebuilt by the avatar factory after
 * their first upload. The factory re-wrote character.json with the new `model_sha256`
 * and carried the old `library_id` / `library_sha256` forward, so the library (and every
 * other desk) kept the model from before the rebuild, forever: a stamped folder was
 * never looked at again. A record whose own `model_sha256` disagrees with its
 * `library_sha256` is stale; no model bytes are read to know it.
 */
function staleStamp(rec) {
  const model = String((rec && rec.model_sha256) || "").toLowerCase();
  const lib = String((rec && rec.library_sha256) || "").toLowerCase();
  return Boolean(model && lib && model !== lib);
}

/** The library id for a desk character, uploading it first when it lives only here. */
async function libraryIdFor(d, character, deps) {
  const rec = readRecord(d.rosterDir, character);
  if (localOnly.isLocalOnlyRecord(rec)) return { ok: false, reason: localOnly.LOCAL_ONLY_REASON, localOnly: true };
  if (typeof rec.library_id === "string" && rec.library_id && !staleStamp(rec)) {
    return { ok: true, id: rec.library_id, uploaded: false };
  }
  if (typeof rec.vroid_model_id === "string" && rec.vroid_model_id) {
    return { ok: true, id: `vroid-${rec.vroid_model_id}`, uploaded: false };
  }
  const model = d.roster.resolveModelFile ? d.roster.resolveModelFile(character) : path.join(d.rosterDir, character, "model.vrm");
  if (!model || !fs.existsSync(model)) return { ok: false, reason: `${character} has no model file on this desk` };
  const bytes = fs.readFileSync(model);
  if (localOnly.isLocalOnlyModel(bytes)) return { ok: false, reason: localOnly.LOCAL_ONLY_REASON, localOnly: true };
  const name = String(rec.display_name || (rec.profile && rec.profile.name) || character).slice(0, 80);
  const up = await d.client.uploadAvatar(bytes, name, uploadRating(d, character), deps.clientDeps);
  if (!up.ok) return { ok: false, reason: up.reason };
  stampLibraryId(d.rosterDir, character, up.record);
  const canonical = adoptCanonical(d, character, up.record);
  return { ok: true, id: up.record.id, uploaded: true, canonical };
}

const GATED_RATINGS = new Set(["r15", "r18"]);

/** Is this desk's adult-content gate open? Unreadable reads CLOSED (content-rating). */
function adultGateOpen(d) {
  try {
    const cr = d.rating || require("./content-rating.cjs");
    return Boolean(cr.isAdultContentVisible && cr.isAdultContentVisible());
  } catch {
    return false;
  }
}

/** Every desk character with a mesh of its own (forks and VRoid references excluded). */
function ownMeshCharacters(d) {
  let names;
  try {
    names = d.roster.listAllCharacters ? d.roster.listAllCharacters()
      : fs.readdirSync(d.rosterDir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);
  } catch {
    names = [];
  }
  return names.filter((name) => fs.existsSync(path.join(d.rosterDir, name, "model.vrm")));
}

/**
 * Library seed: every desk character the person's library does not hold yet is uploaded
 * into it (their own files, their own private library). Idempotent: a folder stamped with
 * a library id the library still lists is skipped without reading the model; otherwise the
 * model's sha256 is matched against the library's records and a match is only stamped.
 * r15/r18 are HELD while the adult-content gate is closed (the library refuses them then).
 * Returns {ok, reason, uploaded, present, skipped, held, failed, results}; ok=false with
 * `unavailable` when the library could not be listed (the caller retries later).
 */
async function seedLibraryFromDesk(deps = {}) {
  const d = defaults(deps);
  const budget = Number.isFinite(deps.maxSeedBytes) && deps.maxSeedBytes > 0
    ? deps.maxSeedBytes : MAX_SEED_BYTES_PER_PASS;
  const uploadCap = Number.isFinite(deps.maxSeedUploads) && deps.maxSeedUploads >= 0
    ? deps.maxSeedUploads : MAX_SEED_UPLOADS_PER_PASS;
  const uploadByteCap = Number.isFinite(deps.maxSeedUploadBytes) && deps.maxSeedUploadBytes > 0
    ? deps.maxSeedUploadBytes : MAX_SEED_UPLOAD_BYTES_PER_PASS;
  const lib = await d.client.avatarLibrary(deps.clientDeps);
  const out = {
    ok: false, reason: "", uploaded: 0, present: 0, skipped: 0, held: 0, failed: 0, deferred: 0,
    bytesRead: 0, uploads: 0, uploadBytes: 0, results: [],
  };
  if (!lib.ok) return { ...out, reason: lib.reason || "the avatar library is unavailable", unavailable: true };
  const ids = new Set();
  const byHash = new Map();
  for (const r of lib.avatars || []) {
    if (!r || typeof r.id !== "string") continue;
    ids.add(r.id);
    if (r.sha256) byHash.set(String(r.sha256).toLowerCase(), r);
  }
  let streak = 0;
  for (const name of ownMeshCharacters(d)) {
    // The main thread is shared with every window's IPC, the watchdog heartbeat and
    // the 50 ms lag ticker: never hand it a long synchronous run of file work.
    await yieldToLoop();
    if (out.bytesRead >= budget) {
      out.deferred += 1;
      continue;
    }
    const rec = readRecord(d.rosterDir, name);
    if (localOnly.isLocalOnlyRecord(rec)) {
      out.skipped += 1;
      out.results.push({ name, ok: true, skipped: "a local-only imported body, never uploaded" });
      continue;
    }
    if (typeof rec.vroid_model_id === "string" && rec.vroid_model_id) {
      out.skipped += 1;
      out.results.push({ name, ok: true, skipped: "a VRoid Hub reference, never uploaded" });
      continue;
    }
    if (typeof rec.library_id === "string" && ids.has(rec.library_id) && !staleStamp(rec)) {
      out.present += 1;
      continue;
    }
    const file = path.join(d.rosterDir, name, "model.vrm");
    // The local-only byte mark sits in the GLB's JSON chunk: peek at that, never the mesh.
    // A file whose prefix does not parse is treated exactly as before (no byte mark): the
    // digest/upload path below still handles it (and a broken model fails there).
    const prefix = await readGlbPrefix(file);
    if (prefix && localOnly.isLocalOnlyModel(prefix)) {
      out.skipped += 1;
      out.results.push({ name, ok: true, skipped: "a local-only imported body, never uploaded" });
      continue;
    }
    const size = await fileSize(file);
    let digest;
    try {
      digest = await hashFileStreaming(file);
      out.bytesRead += size;
    } catch (error) {
      out.failed += 1;
      out.results.push({ name, ok: false, reason: String((error && error.message) || error) });
      continue;
    }
    const held = byHash.get(digest);
    if (held) {
      stampLibraryId(d.rosterDir, name, held, digest);
      out.present += 1;
      out.results.push({ name, ok: true, id: held.id, present: true });
      continue;
    }
    const label = String(rec.display_name || (rec.profile && rec.profile.name) || name).slice(0, 80);
    const rating = uploadRating(d, name);
    if (GATED_RATINGS.has(rating) && !adultGateOpen(d)) {
      // The library refuses r15/r18 while the person's adult-content gate is closed
      // ("rating r15 needs the content gate open"): held, not failed -- a later tick
      // uploads it once they open the gate.
      out.held += 1;
      continue;
    }
    if (out.uploads >= uploadCap || out.uploadBytes + size > uploadByteCap) {
      // The upload makes the client hold ~3 copies of the model. Bounded per pass; the
      // next tick resumes (every upload stamps its folder, so nothing repeats).
      out.deferred += 1;
      continue;
    }
    let bytes;
    try {
      bytes = await fsp.readFile(file);
    } catch (error) {
      out.failed += 1;
      out.results.push({ name, ok: false, reason: String((error && error.message) || error) });
      continue;
    }
    let up;
    try {
      // Defence in depth: the bytes may carry the stamp even when the record does not.
      if (localOnly.isLocalOnlyModel(bytes)) {
        out.skipped += 1;
        out.results.push({ name, ok: true, skipped: "a local-only imported body, never uploaded" });
        continue;
      }
      up = await d.client.uploadAvatar(bytes, label, rating, deps.clientDeps);
    } catch (error) {
      out.failed += 1;
      out.results.push({ name, ok: false, reason: String((error && error.message) || error) });
      continue;
    }
    if (!up.ok && /content gate/i.test(String(up.reason || ""))) {
      out.held += 1;
      continue;
    }
    if (!up.ok) {
      out.failed += 1;
      out.results.push({ name, ok: false, reason: up.reason });
      streak += 1;
      if (streak >= LIBRARY_FAIL_STREAK) {
        out.reason = `stopped after ${streak} failures in a row: ${up.reason}`;
        out.unavailable = true;
        break;
      }
      continue;
    }
    streak = 0;
    out.uploads += 1;
    out.uploadBytes += size;
    stampLibraryId(d.rosterDir, name, up.record, digest);
    ids.add(String(up.record.id));
    if (up.record.sha256) byHash.set(String(up.record.sha256).toLowerCase(), up.record);
    out.uploaded += 1;
    out.results.push({ name, ok: true, id: up.record.id, uploaded: true, rating });
  }
  out.ok = out.failed === 0;
  d.log("avatar library seeded from this desk", {
    uploaded: out.uploaded, present: out.present, failed: out.failed, deferred: out.deferred,
    bytesRead: out.bytesRead,
  });
  return out;
}

/** Push: the catalog learns which avatar `agent` wears (the desk's own choice). */
async function pushAssignment(agent, character, deps = {}) {
  const d = defaults(deps);
  if (!character) return { ok: false, agent, reason: "no character" };
  const found = await libraryIdFor(d, character, deps);
  if (!found.ok) return { ok: false, agent, reason: found.reason };
  const put = await d.client.putAgentAvatar(agent, found.id, deps.clientDeps);
  if (!put.ok) return { ok: false, agent, reason: put.reason };
  if (found.canonical && found.canonical !== character) d.agents.setAgentAvatar(agent, found.canonical);
  clearPulled(deps, agent);
  return { ok: true, agent, id: found.id, uploaded: found.uploaded, name: found.canonical || character };
}

/** Seed: every assignment this desk already has goes into the catalog (idempotent:
 *  an upload of bytes the library already holds returns the existing record). */
async function seedFromDesk(deps = {}) {
  const d = defaults(deps);
  const map = d.agents.loadMap ? d.agents.loadMap() : {};
  const results = [];
  for (const [agent, character] of Object.entries(map || {})) {
    if (!character) continue;
    results.push(await pushAssignment(agent, character, deps));
  }
  return { ok: results.every((r) => r.ok), results };
}

/** First run on a desk: an empty catalog + local assignments -> seed, then pull.
 *  `retryAgents` (from a seed that partly failed) pushes just those agents again, and only
 *  while the catalog still names no avatar for them -- another device's choice wins. */
async function seedIfCatalogEmpty(deps = {}, retryAgents = null) {
  const d = defaults(deps);
  const cat = await d.client.avatarCatalog(deps.clientDeps);
  if (!cat.ok) return { ok: false, seeded: false, reason: cat.reason, failed: retryAgents || [] };
  const named = cat.agents || {};
  if (!retryAgents && Object.keys(named).length > 0) return { ok: true, seeded: false, failed: [] };
  const map = d.agents.loadMap ? d.agents.loadMap() : {};
  const todo = Object.entries(map || {}).filter(([agent, character]) =>
    character && (!retryAgents || (retryAgents.includes(agent) && !named[agent])));
  if (!todo.length) return { ok: true, seeded: false, failed: [] };
  const results = [];
  for (const [agent, character] of todo) results.push(await pushAssignment(agent, character, deps));
  d.log("avatar catalog seeded from this desk", results.map((r) => [r.agent, r.ok ? r.id : r.reason]));
  const failed = results.filter((r) => !r.ok).map((r) => r.agent);
  return { ok: failed.length === 0, seeded: true, results, failed };
}

/** Pull now and every PULL_INTERVAL_MS (and on resume). Returns a stop function. */
/**
 * The seed is retried on every tick until it lands (at most SEED_MAX_TRIES times per desk
 * start). It used to be tried ONCE: the owner's desk started at 06:43Z on 2026-10-17, before
 * aither-avatars answered, so the one attempt saw no catalog and his library stayed empty.
 */
const SEED_MAX_TRIES = 12;

function startCatalogSync(deps = {}) {
  let seedPending = true;
  let seedTries = 0;
  let retryAgents = null;
  // The registry's avatars reach this desk's cast once (agent-avatar-defaults.cjs), before
  // the first pull can re-write an inherited old body over them.
  if (deps.registryDefaults !== false) {
    try {
      require("./agent-avatar-defaults.cjs").runDefaults({ log: deps.log });
    } catch (error) {
      (deps.log || (() => {}))("agent avatar defaults failed", String((error && error.message) || error));
    }
  }
  // Passes are SERIALISED, not dropped: a tick that arrives while one is running waits
  // for it and then runs its own. The old `if (running) return;` silently lost the pass
  // (measured 2026-11-20: a tick fired while the library seed was still running and the
  // catalog retry it carried never happened). At most two are ever queued.
  let chain = Promise.resolve();
  let queued = 0;
  const tick = () => {
    if (queued >= 2) return chain;
    queued += 1;
    const next = chain.then(runPass, runPass).finally(() => { queued -= 1; });
    chain = next.catch(() => {});
    return next;
  };
  async function runPass() {
      // The whole pass (push, catalog pull with its model downloads, library seed) does
      // bulk I/O with big Buffers. Tell the caller the desk is doing deliberate work so
      // its memory guard reclaims but never restarts it (resource-watchdog.cjs `hold`).
      try { deps.onWork?.(true); } catch { /* cosmetic */ }
      try {
        if (deps.registryDefaults !== false) await pushPendingDefaults(deps);
        if (seedPending && seedTries < SEED_MAX_TRIES) {
          seedTries += 1;
          const out = await seedIfCatalogEmpty(deps, retryAgents);
          if (out.ok) seedPending = false;
          else if (out.seeded) retryAgents = out.failed;
          if (!out.ok) (deps.log || (() => {}))("avatar catalog seed will retry", out.reason || out.failed);
        }
        await syncFromCatalog(deps);
        // Every tick: new desk characters keep syncing, a failed pass (service down) is
        // simply tried again. Cheap once seeded -- stamped folders are never re-read.
        if (deps.librarySeed !== false) {
          // Off the main process when the caller can fork one (main.cjs passes Electron's
          // utilityProcess): two gigabytes of model reads and upload buffers must not be
          // the desk's own heap. `null` from the runner means "could not start": the
          // bounded, streaming in-process seed below still runs.
          let lib = null;
          if (typeof deps.seedRunner === "function") {
            try { lib = await deps.seedRunner(); } catch (error) {
              (deps.log || (() => {}))("avatar library seed worker failed", String((error && error.message) || error));
            }
          }
          if (!lib) {
            // In-process fallback: keep its upload copies to at most two models a tick.
            const fallback = typeof deps.seedRunner === "function"
              ? {
                maxSeedUploads: Number.isFinite(deps.maxSeedUploads) ? deps.maxSeedUploads : FALLBACK_SEED_UPLOADS,
                maxSeedUploadBytes: Number.isFinite(deps.maxSeedUploadBytes) ? deps.maxSeedUploadBytes : FALLBACK_SEED_UPLOAD_BYTES,
                ...deps,
              }
              : deps;
            lib = await seedLibraryFromDesk(fallback);
          }
          if (!lib.ok) (deps.log || (() => {}))("avatar library seed will retry", lib.reason || lib.failed);
        }
      } catch (error) {
        (deps.log || (() => {}))("avatar catalog sync failed", String((error && error.message) || error));
      } finally {
        try { deps.onWork?.(false); } catch { /* cosmetic */ }
      }
  }
  void tick();
  const timer = setInterval(() => void tick(), deps.intervalMs || PULL_INTERVAL_MS);
  if (timer.unref) timer.unref();
  return { stop: () => clearInterval(timer), tick };
}

module.exports = {
  staleStamp,
  heldAgents,
  pushPendingDefaults,
  PULL_INTERVAL_MS,
  SEED_MAX_TRIES,
  MAX_SEED_BYTES_PER_PASS,
  hashFileStreaming,
  readGlbPrefix,
  pushAssignment,
  seedFromDesk,
  seedLibraryFromDesk,
  seedIfCatalogEmpty,
  startCatalogSync,
  syncFromCatalog,
};

if (require.main === module) {
  const mode = process.argv.includes("--seed") ? "seed" : process.argv.includes("--sync") ? "sync"
    : process.argv.includes("--library") ? "library" : "";
  if (!mode) {
    process.stderr.write("usage: node electron/avatar-catalog-sync.cjs --seed | --sync | --library\n");
    process.exit(2);
  }
  if (mode === "library") {
    seedLibraryFromDesk({ log: () => {} }).then((out) => {
      for (const r of out.results) {
        process.stdout.write(`${r.ok ? "ok  " : "FAIL"} ${r.name}${r.id ? ` -> ${r.id}` : ""}${r.rating ? ` [${r.rating}]` : ""}${r.present ? " (already in library)" : ""}${r.uploaded ? " (uploaded)" : ""}${r.skipped ? ` (${r.skipped})` : ""}${r.reason ? `: ${r.reason}` : ""}\n`);
      }
      process.stdout.write(`uploaded=${out.uploaded} present=${out.present} skipped=${out.skipped} held=${out.held} failed=${out.failed}${out.reason ? ` reason=${out.reason}` : ""}\n`);
      process.exit(out.ok ? 0 : 1);
    }, (error) => {
      process.stderr.write(`DEAD ${String((error && error.message) || error)}\n`);
      process.exit(2);
    });
  } else {
  // The roster's own install funnel (safety consult + rater) runs exactly as in the app.
  const run = mode === "seed" ? seedFromDesk() : syncFromCatalog({ replace: true }); // the person ran it by hand: that is their OK
  run.then((out) => {
    for (const r of out.results || []) {
      process.stdout.write(`${r.ok ? "ok  " : "FAIL"} ${r.agent}${r.id ? ` -> ${r.id}` : ""}${r.name ? ` = ${r.name}` : ""}${r.uploaded ? " (uploaded)" : ""}${r.reason ? `: ${r.reason}` : ""}\n`);
    }
    if (out.reason) process.stdout.write(`FAIL ${out.reason}\n`);
    process.exit(out.ok ? 0 : 1);
  }, (error) => {
    process.stderr.write(`DEAD ${String((error && error.message) || error)}\n`);
    process.exit(2);
  });
  }
}
