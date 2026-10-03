"use strict";

/**
 * avatar-library-sync — choosing a model in the Deck's Models section puts it on
 * this desk: into characters/<name>/ (through the roster's safety funnel), onto
 * the stage (installCharacter), and into party.json (party-manifest.exportParty).
 *
 * Two sources, both reached through the broker by market-client.cjs:
 *   * the signed-in person's own avatar library (Genesis /avatars, W2-11);
 *   * VRoid Hub with their own VRoid account (Genesis /avatars/vroid, W3-06).
 *     VRoid bytes are for local use by the authorizing account and are never
 *     re-served (.claude/skills/awdesk-avatar/SKILL.md): they land in this
 *     desk's own characters/ folder and nowhere else -- nothing here uploads them.
 *
 * INSTALLED ONCE: a library entry is keyed by the sha256 the library recorded, a
 * VRoid model by its id, both kept in characters/<name>/character.json. Choosing
 * it again only switches to it; nothing is downloaded or copied a second time.
 *
 * Electron-free: the client, the roster writer, the stage switch and the party
 * export are injectable, so avatar-library-sync.test.cjs runs under `node --test`.
 */

const nodeCrypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const GLB_MAGIC = Buffer.from("glTF", "ascii");
const NAME_MAX = 64;

/** characters/<name> for a library avatar: its id (already `slug-sha8`), folded to
 *  the roster grammar. */
function libraryRosterName(record) {
  const raw = String((record && record.id) || "").toLowerCase();
  const name = raw.replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, NAME_MAX);
  return name || null;
}

/** characters/<name> for a VRoid model. */
function vroidRosterName(modelId) {
  const id = String(modelId || "");
  return /^[A-Za-z0-9]{1,64}$/.test(id) ? `vroid-${id.toLowerCase()}` : null;
}

/** The rating the source already judged, or null for "nobody looked". */
function libraryRating(record) {
  const r = String((record && record.rating) || "").toLowerCase();
  return ["general", "r15", "r18"].includes(r) ? r : null;
}

function vroidRating(model) {
  if (!model) return null;
  if (model.r18) return "r18";
  if (model.r15) return "r15";
  return "general";
}

function readRecord(rosterDir, name) {
  try {
    return JSON.parse(fs.readFileSync(path.join(rosterDir, name, "character.json"), "utf8")) || {};
  } catch {
    return {};
  }
}

function hasModel(rosterDir, name) {
  return fs.existsSync(path.join(rosterDir, name, "model.vrm"));
}

/** A .vrm is a binary glTF: refuse anything else before it reaches the roster. */
function looksLikeVrm(bytes) {
  return Buffer.isBuffer(bytes) && bytes.length >= 20 && bytes.subarray(0, 4).equals(GLB_MAGIC);
}

function defaults(deps = {}) {
  const roster = deps.roster || require("./character-roster.cjs");
  return {
    client: deps.client || require("./market-client.cjs"),
    roster,
    rosterDir: deps.rosterDir || roster.ROSTER_DIR,
    apply: deps.apply || roster.installCharacter,
    exportParty: deps.exportParty || (() => require("./party-manifest.cjs").exportParty()),
    refusalFor: deps.refusalFor || ((name) => require("./content-rating.cjs").refusalFor(name)),
    enrollOptions: deps.enrollOptions || {},
  };
}

/** Write the bytes to a temp file beside the roster and enroll them through the funnel. */
async function enrollBytes(d, name, bytes, meta) {
  fs.mkdirSync(d.rosterDir, { recursive: true });
  const tmp = path.join(d.rosterDir, `.incoming-${name}-${process.pid}-${Date.now()}.vrm`);
  try {
    fs.writeFileSync(tmp, bytes);
    return await d.roster.enrollFileChecked({ base: name, from: tmp }, meta, d.enrollOptions);
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

/** Switch the stage to it and re-export the party. A refusal names its cause. */
function finish(d, name, installed) {
  const applied = d.apply(name) === true;
  const refusal = applied ? null : d.refusalFor(name);
  let party;
  try {
    party = d.exportParty();
  } catch (error) {
    party = { ok: false, error: String((error && error.message) || error) };
  }
  return {
    ok: true,
    name,
    installed,
    applied,
    reason: applied ? null : (refusal && refusal.reason) || `${name} is installed but could not be put on stage`,
    party: party ? { ok: party.ok === true, members: party.members ?? 0, error: party.error ?? null } : null,
  };
}

/**
 * Install one of the person's own library avatars on this desk.
 * @returns {Promise<{ok, name, installed, applied, reason, party}>}
 *   installed=false means it was already here (same bytes) and only switched to.
 */
async function installLibraryAvatar(avatarId, deps = {}) {
  const d = defaults(deps);
  const lib = await d.client.avatarLibrary(deps.clientDeps);
  if (!lib.ok) return { ok: false, name: null, installed: false, applied: false, reason: lib.reason };
  const record = lib.avatars.find((a) => a && a.id === avatarId);
  if (!record) return { ok: false, name: null, installed: false, applied: false, reason: "that avatar is not in your library" };
  const name = libraryRosterName(record);
  if (!name) return { ok: false, name: null, installed: false, applied: false, reason: "that avatar has no usable id" };

  const sha = String(record.sha256 || "");
  if (sha && hasModel(d.rosterDir, name) && readRecord(d.rosterDir, name).library_sha256 === sha) {
    return finish(d, name, false);
  }
  const got = await d.client.libraryModel(record.id, deps.clientDeps);
  if (!got.ok) return { ok: false, name, installed: false, applied: false, reason: got.reason };
  if (!looksLikeVrm(got.bytes)) return { ok: false, name, installed: false, applied: false, reason: "the library returned something that is not a .vrm" };
  if (sha && nodeCrypto.createHash("sha256").update(got.bytes).digest("hex") !== sha) {
    return { ok: false, name, installed: false, applied: false, reason: "the downloaded model does not match your library's copy" };
  }
  const enrolled = await enrollBytes(d, name, got.bytes, {
    rating: libraryRating(record),
    source: "library",
    extra: { library_id: record.id, library_sha256: sha, display_name: String(record.name || name).slice(0, 80) },
  });
  if (!enrolled.ok) return { ok: false, name, installed: false, applied: false, reason: enrolled.reason };
  return finish(d, name, true);
}

/**
 * Install a VRoid Hub model (fetched with the person's own VRoid account) on this desk.
 * `model` is the broker's shaped result the Deck chose ({id, name, downloadable, r15, r18}).
 */
async function installVroidModel(model, deps = {}) {
  const d = defaults(deps);
  const id = model && model.id;
  const name = vroidRosterName(id);
  if (!name) return { ok: false, name: null, installed: false, applied: false, reason: "not a VRoid model id" };
  if (model.downloadable !== true) {
    return { ok: false, name, installed: false, applied: false, reason: "VRoid Hub does not allow this account to download that model" };
  }
  if (hasModel(d.rosterDir, name) && readRecord(d.rosterDir, name).vroid_model_id === String(id)) {
    return finish(d, name, false);
  }
  const got = await d.client.vroidModel(String(id), deps.clientDeps);
  if (!got.ok) return { ok: false, name, installed: false, applied: false, reason: got.reason };
  if (!looksLikeVrm(got.bytes)) return { ok: false, name, installed: false, applied: false, reason: "VRoid Hub returned something that is not a .vrm" };
  const enrolled = await enrollBytes(d, name, got.bytes, {
    rating: vroidRating(model),
    source: "vroid",
    extra: { vroid_model_id: String(id), display_name: String(model.name || name).slice(0, 80) },
  });
  if (!enrolled.ok) return { ok: false, name, installed: false, applied: false, reason: enrolled.reason };
  return finish(d, name, true);
}

/**
 * The library as the Deck shows it: each entry with the roster name it installs
 * as and whether it is already on this desk.
 */
async function libraryView(deps = {}) {
  const d = defaults(deps);
  const lib = await d.client.avatarLibrary(deps.clientDeps);
  // R15/R18 entries are left out while the adult-content gate is closed.
  const open = gateOpen(deps);
  const listed = (lib.avatars || []).filter((a) => open || !["r15", "r18"].includes(libraryRating(a)));
  const avatars = listed.map((a) => {
    const name = libraryRosterName(a);
    const here = Boolean(name && hasModel(d.rosterDir, name)
      && readRecord(d.rosterDir, name).library_sha256 === String(a.sha256 || ""));
    return {
      id: String(a.id || ""),
      name: String(a.name || a.id || ""),
      rating: String(a.rating || "unknown"),
      size: Number(a.size) || 0,
      rosterName: name,
      installed: here,
    };
  });
  return { ok: lib.ok, avatars, active: lib.active || null, reason: lib.ok ? null : lib.reason };
}

/** The adult-content gate (content-rating.cjs; fails CLOSED). Injectable for tests. */
function gateOpen(deps = {}) {
  const read = deps.isAdultContentVisible || (() => require("./content-rating.cjs").isAdultContentVisible());
  try {
    return read() === true;
  } catch {
    return false;
  }
}

/** ACG004's invariant, carried over from model-browser.py: while the gate is
 *  closed no R15/R18 row reaches the Deck (and so none can be chosen). */
function visibleVroidModels(models, open) {
  return (Array.isArray(models) ? models : []).filter((m) => open || !(m && (m.r18 || m.r15)));
}

module.exports = {
  installLibraryAvatar,
  installVroidModel,
  libraryView,
  gateOpen,
  visibleVroidModels,
  libraryRosterName,
  vroidRosterName,
  looksLikeVrm,
};
