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
const path = require("node:path");

const nodeCrypto = require("node:crypto");

const PULL_INTERVAL_MS = 10 * 60 * 1000;
const LIBRARY_RATINGS = new Set(["general", "r15", "r18"]);
/** Stop a library pass after this many failures in a row (the service is down: the
 *  next tick retries, instead of timing out on every remaining character now). */
const LIBRARY_FAIL_STREAK = 3;

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

function stampLibraryId(rosterDir, name, record) {
  const file = path.join(rosterDir, name, "character.json");
  const current = readRecord(rosterDir, name);
  const next = { ...current, library_id: String(record.id), library_sha256: String(record.sha256 || "") };
  try {
    fs.writeFileSync(file, JSON.stringify(next, null, 2));
    return true;
  } catch {
    return false;
  }
}

/** Pull: dress this desk's agents the way the catalog says. */
async function syncFromCatalog(deps = {}) {
  const d = defaults(deps);
  const cat = await d.client.avatarCatalog(deps.clientDeps);
  if (!cat.ok) return { ok: false, reason: cat.reason, results: [] };
  const byId = new Map();
  for (const r of [...cat.avatars, ...cat.starters]) if (r && typeof r.id === "string") byId.set(r.id, r);
  const results = [];
  for (const [agent, id] of Object.entries(cat.agents)) {
    const record = byId.get(id);
    if (!record) {
      results.push({ agent, ok: false, reason: "that avatar is not in the library" });
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
    const changed = current !== ensured.name;
    if (changed) d.agents.setAgentAvatar(agent, ensured.name);
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

/** The library id for a desk character, uploading it first when it lives only here. */
async function libraryIdFor(d, character, deps) {
  const rec = readRecord(d.rosterDir, character);
  if (typeof rec.library_id === "string" && rec.library_id) return { ok: true, id: rec.library_id, uploaded: false };
  if (typeof rec.vroid_model_id === "string" && rec.vroid_model_id) {
    return { ok: true, id: `vroid-${rec.vroid_model_id}`, uploaded: false };
  }
  const model = d.roster.resolveModelFile ? d.roster.resolveModelFile(character) : path.join(d.rosterDir, character, "model.vrm");
  if (!model || !fs.existsSync(model)) return { ok: false, reason: `${character} has no model file on this desk` };
  const bytes = fs.readFileSync(model);
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
  let names = [];
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
  const lib = await d.client.avatarLibrary(deps.clientDeps);
  const out = { ok: false, reason: "", uploaded: 0, present: 0, skipped: 0, held: 0, failed: 0, results: [] };
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
    const rec = readRecord(d.rosterDir, name);
    if (typeof rec.vroid_model_id === "string" && rec.vroid_model_id) {
      out.skipped += 1;
      out.results.push({ name, ok: true, skipped: "a VRoid Hub reference, never uploaded" });
      continue;
    }
    if (typeof rec.library_id === "string" && ids.has(rec.library_id)) {
      out.present += 1;
      continue;
    }
    let bytes;
    try {
      bytes = fs.readFileSync(path.join(d.rosterDir, name, "model.vrm"));
    } catch (error) {
      out.failed += 1;
      out.results.push({ name, ok: false, reason: String((error && error.message) || error) });
      continue;
    }
    const digest = nodeCrypto.createHash("sha256").update(bytes).digest("hex");
    const held = byHash.get(digest);
    if (held) {
      stampLibraryId(d.rosterDir, name, held);
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
    const up = await d.client.uploadAvatar(bytes, label, rating, deps.clientDeps);
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
    stampLibraryId(d.rosterDir, name, up.record);
    ids.add(String(up.record.id));
    if (up.record.sha256) byHash.set(String(up.record.sha256).toLowerCase(), up.record);
    out.uploaded += 1;
    out.results.push({ name, ok: true, id: up.record.id, uploaded: true, rating });
  }
  out.ok = out.failed === 0;
  d.log("avatar library seeded from this desk", { uploaded: out.uploaded, present: out.present, failed: out.failed });
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
  let running = false;
  let seedPending = true;
  let seedTries = 0;
  let retryAgents = null;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
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
        const lib = await seedLibraryFromDesk(deps);
        if (!lib.ok) (deps.log || (() => {}))("avatar library seed will retry", lib.reason || lib.failed);
      }
    } catch (error) {
      (deps.log || (() => {}))("avatar catalog sync failed", String((error && error.message) || error));
    } finally {
      running = false;
    }
  };
  void tick();
  const timer = setInterval(() => void tick(), deps.intervalMs || PULL_INTERVAL_MS);
  if (timer.unref) timer.unref();
  return { stop: () => clearInterval(timer), tick };
}

module.exports = {
  PULL_INTERVAL_MS,
  SEED_MAX_TRIES,
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
  const run = mode === "seed" ? seedFromDesk() : syncFromCatalog();
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
