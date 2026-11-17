"use strict";

/**
 * rating-resolve.cjs -- ONE rule that says how mature a body is, from what the model itself and
 * VRoid Hub already say about it. Owner, 2026-11-17: "cant we use the existing vroid rating
 * system and tags to help manage that" + "respect aithersafety content settings".
 *
 * Before this file a character's rating came from whoever wrote character.json last -- mostly a
 * vision model guessing from a full-body frame (70 of 93 rated bodies on the owner's desk). The
 * kitsunes were "teen" from a guess while their own VRM licence said sexual use is allowed. Every
 * signal below is something an AUTHOR declared; the vision guess is the floor they build on.
 *
 * PRECEDENCE (the label of record -- `rating_source` in character.json):
 *
 *   1. vroid-hub  VRoid Hub's record: age_limit.is_r18 / is_r15 (+ licence sexual/violent
 *                 expression), or the broker's r18 / r15 booleans.
 *   2. vroid-tags The Hub's TAGS: R18, R-18, NSFW, 18+, R15, R-15 ... case-, width- and
 *                 dash-insensitive (Ｒ－１８, R‐18 and 18禁 are the same tag).
 *   3. vrm-meta   The .vrm's own licence meta (VRM 1.0 allowExcessivelySexualUsage, VRM 0.x
 *                 sexualUssageName "Allow"). Used only when the Hub said nothing; a permission
 *                 is not a description, so it is a TEEN floor (see ratingFromVrmMeta).
 *   4. vision     The rater's guess (rate-characters.py --vision), or any other prior verdict.
 *   5. unrated    Nothing said anything: mature, per slice 1.
 *
 * 🚩 METADATA CAN ONLY TIGHTEN. Precedence picks the metadata verdict (a tag may raise the Hub's
 * record, never lower it); that verdict then only RAISES the one already held -- a Hub "general"
 * never lowers a vision "teen" -- or relabels it at equal strictness when it is the stronger
 * source ("Everyone · VRoid Hub" instead of "Everyone · vision guess"). A rating already on disk
 * is never lowered by this file.
 */

const fs = require("node:fs");
const path = require("node:path");

const RANK = Object.freeze({ general: 0, r15: 1, r18: 2 });
/** How much a source's verdict is worth at EQUAL strictness. Unknown sources rank lowest. */
const STRENGTH = Object.freeze({
  owner: 7,
  manual: 7,
  "vroid-hub": 6,
  vroid: 6,
  "vroid-tags": 5,
  "vrm-meta": 4,
  library: 3,
  vision: 2,
  "vision-thumb": 2,
  heuristic: 1,
});
/** Sources that mean "nobody looked": never a floor. */
const UNJUDGED = new Set(["", "default", "pending", "unrated"]);
/** The labels this file writes into `rating_source`. */
const DERIVED_SOURCES = Object.freeze(["vroid-hub", "vroid-tags", "vrm-meta"]);

/** The words the gallery badge shows after the tier ("Mature · VRoid Hub R18"). */
const SOURCE_LABEL = Object.freeze({
  "vroid-hub": "VRoid Hub",
  vroid: "VRoid Hub",
  "vroid-tags": "VRoid Hub tag",
  "vrm-meta": "VRM licence",
  vision: "vision guess",
  "vision-thumb": "vision guess",
  heuristic: "name guess",
  owner: "your rating",
  manual: "your rating",
  library: "library",
  forge: "made here",
  avatar_factory: "made here",
  fork: "its base",
  unrated: "not rated",
});

function plain(v) {
  return v && typeof v === "object" && !Array.isArray(v) ? v : {};
}

// ── tags ────────────────────────────────────────────────────────────────────────────────────

/** NFKC folds full-width (Ｒ１８) to ASCII; then case, spaces and every dash/bar are dropped. */
function normTag(raw) {
  return String(raw == null ? "" : raw)
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[\s_\-‐-―−ー－・.・]/g, "");
}

const R18_TAGS = new Set(["r18", "r18g", "r18+", "nsfw", "18+", "18禁", "adult", "adultonly", "成人向け", "成人向", "エロ", "r指定18"]);
const R15_TAGS = new Set(["r15", "r15g", "r15+", "15+", "15禁", "r指定15"]);

/** The rating the Hub's tags carry, or null. Tags are strings or {name}. */
function ratingFromTags(tags) {
  let best = null;
  for (const t of Array.isArray(tags) ? tags : []) {
    const raw = t && typeof t === "object" ? t.name : t;
    const n = normTag(raw);
    if (!n) continue;
    if (R18_TAGS.has(n)) return { rating: "r18", signal: `tag ${String(raw).slice(0, 24)}` };
    if (!best && R15_TAGS.has(n)) best = { rating: "r15", signal: `tag ${String(raw).slice(0, 24)}` };
  }
  return best;
}

// ── VRoid Hub record ────────────────────────────────────────────────────────────────────────

/**
 * The Hub record's verdict, or null. Takes the API v11 character_model (age_limit + license) or
 * the broker's shaped row ({r15, r18} booleans). Same mapping as avatar-gallery.ratingFromVroid.
 */
function ratingFromHub(rec) {
  const m = plain(rec);
  if (!Object.keys(m).length) return null;
  const age = plain(m.age_limit);
  const lic = plain(m.license);
  if (age.is_r18 === true || m.r18 === true) return { rating: "r18", signal: "R18" };
  if (age.is_r15 === true || m.r15 === true) return { rating: "r15", signal: "R15" };
  if (lic.sexual_expression === "allow") return { rating: "r15", signal: "sexual expression allowed" };
  if (lic.violent_expression === "allow") return { rating: "r15", signal: "violent expression allowed" };
  if ((age.is_r18 === false && age.is_r15 === false) || (m.r18 === false && m.r15 === false)) {
    return { rating: "general", signal: "all ages" };
  }
  return null;
}

// ── the .vrm's own meta ─────────────────────────────────────────────────────────────────────

const GLB_MAGIC = 0x46546c67; // "glTF"
const CHUNK_JSON = 0x4e4f534a; // "JSON"
const MAX_JSON = 64 * 1024 * 1024;

/** Parse the glTF JSON chunk out of a GLB header + chunk bytes. Null when it is not a GLB. */
function jsonChunkLength(head) {
  if (!Buffer.isBuffer(head) || head.length < 20) return null;
  if (head.readUInt32LE(0) !== GLB_MAGIC) return null;
  if (head.readUInt32LE(16) !== CHUNK_JSON) return null;
  const len = head.readUInt32LE(12);
  return len > 0 && len <= MAX_JSON ? len : null;
}

function metaOf(json) {
  const ext = plain(plain(json).extensions);
  if (ext.VRMC_vrm && typeof ext.VRMC_vrm === "object") return { version: "1.0", meta: plain(ext.VRMC_vrm.meta) };
  if (ext.VRM && typeof ext.VRM === "object") return { version: "0.x", meta: plain(ext.VRM.meta) };
  return null;
}

/** The VRM meta of a .vrm buffer, reading only the JSON chunk. Null when there is none. */
function vrmMetaFromBuffer(bytes) {
  const len = jsonChunkLength(Buffer.isBuffer(bytes) ? bytes.subarray(0, 20) : null);
  if (!len || bytes.length < 20 + len) return null;
  try {
    return metaOf(JSON.parse(bytes.subarray(20, 20 + len).toString("utf8")));
  } catch {
    return null;
  }
}

/** The VRM meta of a .vrm file: the 20-byte header and the JSON chunk, never the mesh. */
function readVrmMeta(file) {
  let fd;
  try {
    fd = fs.openSync(file, "r");
    const head = Buffer.alloc(20);
    if (fs.readSync(fd, head, 0, 20, 0) !== 20) return null;
    const len = jsonChunkLength(head);
    if (!len) return null;
    const body = Buffer.alloc(len);
    if (fs.readSync(fd, body, 0, len, 20) !== len) return null;
    return metaOf(JSON.parse(body.toString("utf8")));
  } catch {
    return null;
  } finally {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch { /* already closed */ }
    }
  }
}

const isAllow = (v) => String(v || "").trim().toLowerCase() === "allow";

/**
 * The licence meta's verdict, or null. Only ever raises: "Disallow" says nothing.
 *
 * 🚩 A LICENCE IS A PERMISSION, NOT A DESCRIPTION. Measured on the owner's roster 2026-11-17:
 * 78 of 94 .vrm files allow sexual use -- VRoid's OWN official samples (AvatarSample_T, whose Hub
 * record is all-ages) and our forge's Aither among them. Reading "sexual use allowed" as mature
 * would have hidden Aither from his family profile. So: sexual use allowed = at least TEEN (the
 * author made it to permit that, the same weight ratingFromHub gives the Hub licence), and a
 * violent-use permission alone is no content signal at all (the forge stamps it on every Aither).
 * Mature comes from what an author SAYS the body is -- the Hub's R18 flag or an R18 tag -- or
 * from a look at it (vision).
 */
function ratingFromVrmMeta(vrm) {
  if (!vrm || !vrm.meta) return null;
  const m = vrm.meta;
  if (vrm.version === "1.0") {
    return m.allowExcessivelySexualUsage === true ? { rating: "r15", signal: "sexual use allowed (VRM 1.0)" } : null;
  }
  return isAllow(m.sexualUssageName) ? { rating: "r15", signal: "sexual use allowed (VRM 0.x)" } : null;
}

// ── resolution ──────────────────────────────────────────────────────────────────────────────

function strength(source) {
  return STRENGTH[String(source || "")] ?? 0;
}

/** The record's current judged verdict ({rating, source}) or null when nobody judged it. */
function currentVerdict(record) {
  const r = plain(record);
  const rating = String(r.rating || "").toLowerCase();
  if (RANK[rating] === undefined) return null;
  const source = String(r.rating_source || r.source || "");
  if (UNJUDGED.has(source)) return null;
  return { rating, source };
}

/**
 * resolveRating -- the one function. `signals`:
 *   hub      VRoid Hub record (API or broker shape), or null
 *   tags     the Hub's tags (strings or {name})
 *   vrmMeta  {version, meta} from readVrmMeta / vrmMetaFromBuffer
 *   current  the verdict already held ({rating, source}: the vision guess or anything earlier)
 * Returns {rating, rating_source, signal}. `rating` is general | r15 | r18 | unrated.
 */
function resolveRating({ hub = null, tags = null, vrmMeta = null, current = null } = {}) {
  // The metadata verdict, in precedence order. The Hub's own record decides; its tags (the same
  // uploader's words) may only raise it; the .vrm licence speaks only when the Hub said nothing.
  let meta = null;
  const h = ratingFromHub(hub);
  if (h) meta = { ...h, source: "vroid-hub" };
  const t = ratingFromTags(tags || (hub && hub.tags));
  if (t && (!meta || RANK[t.rating] > RANK[meta.rating])) meta = { ...t, source: "vroid-tags" };
  const cur = current && RANK[current.rating] !== undefined && !UNJUDGED.has(String(current.source || "")) ? current : null;
  // A verdict already held FROM the Hub (enroll wrote it) or from the owner is "the Hub/owner
  // said something": the licence permission does not get a say over it either.
  if (!meta && !(cur && strength(cur.source) >= STRENGTH["vroid-hub"])) {
    const v = ratingFromVrmMeta(vrmMeta);
    if (v) meta = { ...v, source: "vrm-meta" };
  }
  if (!meta && !cur) return { rating: "unrated", rating_source: "unrated", signal: "" };
  // A licence permission is a FLOOR on a verdict, never a verdict by itself: alone, it would turn
  // an unrated (= mature, hidden) body into a teen one nobody looked at (review of slice 3).
  if (!cur && meta.source === "vrm-meta") return { rating: "unrated", rating_source: "unrated", signal: "" };
  if (!cur) return { rating: meta.rating, rating_source: meta.source, signal: meta.signal };
  const held = { rating: cur.rating, rating_source: String(cur.source), signal: String(current.signal || "") };
  if (!meta) return held;
  // Against the verdict already held (the vision guess, or anything earlier): metadata may only
  // RAISE it, or relabel it at equal strictness when it is the stronger source. Never lower.
  const dr = RANK[meta.rating] - RANK[cur.rating];
  if (dr > 0 || (dr === 0 && strength(meta.source) > strength(cur.source))) {
    return { rating: meta.rating, rating_source: meta.source, signal: meta.signal };
  }
  return held;
}

/** The Hub fields a character.json may carry from enroll (download or Deck install). */
function hubOf(record) {
  const r = plain(record);
  const hub = plain(r.vroid_hub);
  const out = { ...hub };
  if (r.vroid_age_limit && typeof r.vroid_age_limit === "object") out.age_limit = r.vroid_age_limit;
  if (r.vroid_license && typeof r.vroid_license === "object") out.license = r.vroid_license;
  return Object.keys(out).length ? out : null;
}

function tagsOf(record) {
  const r = plain(record);
  if (Array.isArray(r.vroid_tags)) return r.vroid_tags;
  if (Array.isArray(plain(r.vroid_hub).tags)) return r.vroid_hub.tags;
  return null;
}

/**
 * deriveCharacter -- resolve one roster folder and, when the derived verdict is STRICTER than
 * what is on disk (or equal but from a stronger source), write `rating`, `rating_source` and
 * `rating_signal` into its character.json. Every other key is kept. Never lowers.
 * `extra.hub` / `extra.tags` add signals the caller holds (an install that just fetched them).
 * Returns {name, changed, before, rating, rating_source, signal}.
 */
function deriveCharacter(rosterDir, name, { hub = null, tags = null, write = true } = {}) {
  const dir = path.join(rosterDir, name);
  const file = path.join(dir, "character.json");
  let record;
  let existed = false;
  try {
    record = plain(JSON.parse(fs.readFileSync(file, "utf8")));
    existed = true;
  } catch {
    record = {};
  }
  const vrmMeta = readVrmMeta(path.join(dir, "model.vrm"));
  const current = currentVerdict(record);
  const derived = resolveRating({
    hub: hub || hubOf(record),
    tags: tags || tagsOf(record),
    vrmMeta,
    current,
  });
  const before = current ? `${current.rating}/${current.source}` : String(record.rating || "unrated");
  const changed = derived.rating !== "unrated"
    && (!current || derived.rating !== current.rating || derived.rating_source !== current.source);
  if (changed && write && (existed || fs.existsSync(dir))) {
    const next = { ...record, rating: derived.rating, rating_source: derived.rating_source };
    if (derived.signal) next.rating_signal = derived.signal;
    else delete next.rating_signal;
    const tmp = `${file}.tmp-${process.pid}`;
    try {
      fs.writeFileSync(tmp, JSON.stringify(next, null, 2));
      fs.renameSync(tmp, file);
    } catch {
      try { fs.rmSync(tmp, { force: true }); } catch { /* nothing to clean */ }
      return { name, changed: false, before, ...derived, error: "could not write character.json" };
    }
  }
  return { name, changed, before, rating: derived.rating, rating_source: derived.rating_source, signal: derived.signal };
}

/** The re-derive pass over a whole roster (desk start). Returns the rows that changed. */
function rederiveRoster(rosterDir, { write = true } = {}) {
  let entries;
  try {
    entries = fs.readdirSync(rosterDir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
    const row = deriveCharacter(rosterDir, entry.name, { write });
    if (row.changed) out.push(row);
  }
  return out;
}

/** The badge text: "VRoid Hub R18", "VRM licence: sexual use allowed (VRM 0.x)", "vision guess". */
function sourceLabel(record) {
  const r = plain(record);
  const src = String(r.rating_source || r.source || "");
  if (UNJUDGED.has(src) || !r.rating || r.rating === "unrated") return SOURCE_LABEL.unrated;
  const label = SOURCE_LABEL[src] || src;
  const signal = typeof r.rating_signal === "string" ? r.rating_signal : "";
  if (!signal) return label;
  if (src === "vroid-hub") return `${label} ${signal}`;
  if (src === "vroid-tags") return `${label} ${signal.replace(/^tag /, "")}`;
  return `${label}: ${signal}`;
}

module.exports = {
  RANK,
  DERIVED_SOURCES,
  SOURCE_LABEL,
  normTag,
  ratingFromTags,
  ratingFromHub,
  ratingFromVrmMeta,
  readVrmMeta,
  vrmMetaFromBuffer,
  resolveRating,
  currentVerdict,
  deriveCharacter,
  rederiveRoster,
  sourceLabel,
};
