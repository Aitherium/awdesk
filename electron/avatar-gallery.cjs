"use strict";

/**
 * avatar-gallery.cjs -- the owner's rogues gallery: who may be seen, by whom, and which body each
 * persona wears. Owner, 2026-11-17: "I can't have Aither/bots randomly selecting avatars. I LIKE
 * this, but I can't let my mom, kids or strangers see this ... a proper rogues gallery / persona."
 *
 * THREE RULES this module is the single source of:
 *
 *   1. RATINGS speak the owner's words. A character.json rating (general | r15 | r18, set from
 *      VRoid Hub's own age/sexual/violent flags at enroll, by the rater, or by him) reads as
 *      everyone | teen | mature. No verdict = "unrated", which counts as MATURE.
 *
 *   2. AUDIENCE. The desk has one active profile -- Hearth (family) = everyone, Work = teen,
 *      Personal = mature -- and only bodies rated at or under it render. SAFE MODE (the panic
 *      key, or a detected screen share/stream) forces "everyone" over any profile, instantly.
 *      content-rating.cjs folds audienceCap() into the one hiddenReason() every door already
 *      asks, so the roster, the stage, the swarm and the gallery's own tiles all obey it.
 *
 *   3. ONLY THE OWNER ASSIGNS. Agents PROPOSE a body (avatar-proposals.json); he applies it with
 *      one click. Rotation picks only from a set HE defined, by date (no randomness), and only
 *      among the members the active profile allows.
 *
 * cast.json `gallery` section (synced with the rest of cast.json by awsettings):
 *   { profile, profiles: {hearth, work, personal}, safeMode, autoSafeOnShare, standIn,
 *     avatars: {<name>: {nickname, scale, idle, voice, physics}},
 *     rotation: {<persona>: {set: [names], every: "daily" | "weekly"}} }
 *
 * PURE apart from the proposals file helpers at the bottom.
 */

const fs = require("node:fs");
const path = require("node:path");

/** character.json rating -> the owner's word. */
const TIER_OF = Object.freeze({ general: "everyone", r15: "teen", r18: "mature" });
/** The owner's word -> the rating the roster stores. */
const RATING_OF = Object.freeze({ everyone: "general", teen: "r15", mature: "r18" });
const TIERS = Object.freeze(["everyone", "teen", "mature", "unrated"]);
const TIER_RANK = Object.freeze({ everyone: 0, teen: 1, mature: 2, unrated: 2 });

const PROFILE_IDS = Object.freeze(["hearth", "work", "personal"]);
const PROFILE_LABELS = Object.freeze({ hearth: "Hearth (family)", work: "Work", personal: "Personal" });
const DEFAULT_PROFILES = Object.freeze({ hearth: "everyone", work: "teen", personal: "mature" });
const ROTATION_EVERY = Object.freeze(["daily", "weekly"]);
const PHYSICS_PRESETS = Object.freeze(["default", "calm", "bouncy", "stiff", "off"]);
const IDLE_CHOICES = Object.freeze(["default", "calm", "lively", "still"]);
/** Not personas (owner 2026-11-17): Scribe and gobbonet are tools; Chaos is becoming Malfoid. */
const NOT_PERSONAS = Object.freeze(new Set(["scribe", "gobbonet", "awdesk"]));
const RENAMED = Object.freeze({ chaos: "malfoid" });

function plain(v) {
  return v && typeof v === "object" && !Array.isArray(v) ? v : {};
}

function str(v, max = 120) {
  return typeof v === "string" && v.trim() ? v.trim().slice(0, max) : "";
}

/** The owner's tier for a stored rating. Anything unknown is "unrated". */
function tierOf(rating) {
  return TIER_OF[String(rating || "").toLowerCase()] || "unrated";
}

/** May a body of `tier` be seen by an audience of `cap` (everyone|teen|mature)? */
function tierAllowed(tier, cap) {
  const want = TIER_RANK[tier] ?? 2;
  if (tier === "unrated" && cap !== "mature") return false;
  return want <= (TIER_RANK[cap] ?? 0);
}

/**
 * VRoid Hub's own fields -> a rating, or null when they say nothing. API v11 character_model:
 * `age_limit.is_r18`, `age_limit.is_r15`, and the licence's `sexual_expression` /
 * `violent_expression` ("allow" | "disallow"). An R18 flag is mature; R15 is teen; a model whose
 * licence allows sexual expression is at least teen (it was MADE to permit it) -- never everyone.
 */
function ratingFromVroid(model) {
  const m = plain(model);
  const age = plain(m.age_limit);
  const lic = plain(m.license);
  if (age.is_r18 === true) return "r18";
  if (age.is_r15 === true) return "r15";
  if (lic.sexual_expression === "allow" || lic.violent_expression === "allow") return "r15";
  if (age.is_r18 === false && age.is_r15 === false) return "general";
  return null;
}

/** The cast.json `gallery` section, normalised. Never throws. */
function readGallery(raw) {
  const g = plain(plain(raw).gallery);
  const profiles = { ...DEFAULT_PROFILES };
  for (const id of PROFILE_IDS) {
    const t = str(plain(g.profiles)[id], 16);
    if (t && TIER_RANK[t] !== undefined && t !== "unrated") profiles[id] = t;
  }
  const profile = PROFILE_IDS.includes(g.profile) ? g.profile : "personal";
  const avatars = {};
  for (const [name, cfg] of Object.entries(plain(g.avatars))) {
    const c = plain(cfg);
    const scale = Number(c.scale);
    avatars[name] = {
      nickname: str(c.nickname, 48),
      scale: Number.isFinite(scale) && scale >= 0.5 && scale <= 1.25 ? scale : 1,
      idle: IDLE_CHOICES.includes(c.idle) ? c.idle : "default",
      voice: str(c.voice, 40),
      physics: PHYSICS_PRESETS.includes(c.physics) ? c.physics : "default",
    };
  }
  const rotation = {};
  for (const [persona, r] of Object.entries(plain(g.rotation))) {
    const set = (Array.isArray(plain(r).set) ? r.set : []).map((n) => str(n)).filter(Boolean);
    if (!set.length) continue;
    rotation[persona] = { set: [...new Set(set)].slice(0, 24), every: ROTATION_EVERY.includes(r.every) ? r.every : "daily" };
  }
  return {
    profile,
    profiles,
    safeMode: g.safeMode === true,
    autoSafeOnShare: g.autoSafeOnShare !== false,
    standIn: str(g.standIn),
    avatars,
    rotation,
  };
}

/** Validator for cast-config (problems are reported, never fatal). */
function validateGallery(raw, problems) {
  if (raw === undefined || raw === null) return readGallery({});
  if (typeof raw !== "object" || Array.isArray(raw)) {
    problems.push({ path: "gallery", value: raw, reason: "expected an object" });
    return readGallery({});
  }
  if (raw.profile !== undefined && !PROFILE_IDS.includes(raw.profile)) {
    problems.push({ path: "gallery.profile", value: raw.profile, reason: `expected one of ${PROFILE_IDS.join(" | ")}` });
  }
  return readGallery({ gallery: raw });
}

/**
 * The audience cap right now: "everyone" in safe mode (his switch, or an auto trigger), else
 * the active profile's tier.
 */
function audienceCap(gallery, { autoSafe = false } = {}) {
  const g = gallery || readGallery({});
  if (g.safeMode || autoSafe) return "everyone";
  return g.profiles[g.profile] || "everyone";
}

/** The rating ceiling content-rating understands (general | r15 | r18) for a cap. */
function ceilingRating(cap) {
  return RATING_OF[cap] || "general";
}

/** Day index since the epoch in local time; a week is 7 of them. Deterministic, never random. */
function periodIndex(date, every) {
  const d = date instanceof Date ? date : new Date(date);
  const day = Math.floor((d.getTime() - d.getTimezoneOffset() * 60000) / 86400000);
  return every === "weekly" ? Math.floor(day / 7) : day;
}

/**
 * rotationPick -- the body a persona wears today from the set HE defined. Walks the set in his
 * order from today's index and takes the first member `allowed` (installed + rated for the
 * active audience). null when none is allowed: then the persona keeps what it has (or its fairy).
 */
function rotationPick(rotation, { date = new Date(), allowed = () => true } = {}) {
  const r = plain(rotation);
  const set = Array.isArray(r.set) ? r.set : [];
  if (!set.length) return null;
  const start = periodIndex(date, r.every) % set.length;
  for (let i = 0; i < set.length; i += 1) {
    const name = set[(start + i) % set.length];
    if (allowed(name)) return name;
  }
  return null;
}

/** The personas the gallery lists: cast.json authors + the platform roster, minus the tools. */
function personaIds({ authors = {}, rosterAgents = [] } = {}) {
  const out = new Set();
  for (const id of [...Object.keys(plain(authors)), ...(Array.isArray(rosterAgents) ? rosterAgents : [])]) {
    const k = String(id || "").trim().toLowerCase();
    if (!k || NOT_PERSONAS.has(k)) continue;
    out.add(RENAMED[k] || k);
  }
  return [...out].sort((a, b) => (a === "aither" ? -1 : b === "aither" ? 1 : a.localeCompare(b)));
}

// ── cast.json mutations (each one is an owner action from the gallery) ──────────────────────

function ensureGallery(draft) {
  if (!draft.gallery || typeof draft.gallery !== "object" || Array.isArray(draft.gallery)) draft.gallery = {};
  return draft.gallery;
}

function ensureAuthor(draft, persona) {
  if (!draft.authors || typeof draft.authors !== "object" || Array.isArray(draft.authors)) draft.authors = {};
  if (!draft.authors[persona] || typeof draft.authors[persona] !== "object" || Array.isArray(draft.authors[persona])) {
    draft.authors[persona] = {};
  }
  return draft.authors[persona];
}

/**
 * Assign `name` to `persona`. The body changes because he clicked it. The avatar's linked VOICE
 * is written only when the persona has none (#104's rule: a value he already has is never
 * overwritten by a side effect); `voice: true` in opts is his explicit "use this avatar's voice".
 */
function assignMutation(persona, name, { useAvatarVoice = false } = {}) {
  return (draft) => {
    const row = ensureAuthor(draft, persona);
    row.character = name;
    const linked = readGallery(draft).avatars[name];
    if (linked && linked.voice && (useAvatarVoice || !row.voice)) row.voice = linked.voice;
    return draft;
  };
}

function unassignMutation(persona) {
  return (draft) => {
    const row = plain(plain(draft.authors)[persona]);
    if (row && Object.prototype.hasOwnProperty.call(row, "character")) delete row.character;
    return draft;
  };
}

function avatarConfigMutation(name, patch) {
  return (draft) => {
    const g = ensureGallery(draft);
    if (!g.avatars || typeof g.avatars !== "object" || Array.isArray(g.avatars)) g.avatars = {};
    const cur = plain(g.avatars[name]);
    const next = { ...cur };
    for (const key of ["nickname", "scale", "idle", "voice", "physics"]) {
      if (Object.prototype.hasOwnProperty.call(plain(patch), key)) next[key] = patch[key];
    }
    g.avatars[name] = next;
    return draft;
  };
}

function rotationMutation(persona, set, every) {
  return (draft) => {
    const g = ensureGallery(draft);
    if (!g.rotation || typeof g.rotation !== "object" || Array.isArray(g.rotation)) g.rotation = {};
    const list = (Array.isArray(set) ? set : []).map((n) => str(n)).filter(Boolean);
    if (!list.length) delete g.rotation[persona];
    else g.rotation[persona] = { set: [...new Set(list)], every: ROTATION_EVERY.includes(every) ? every : "daily" };
    return draft;
  };
}

function profileMutation(profile) {
  return (draft) => {
    if (!PROFILE_IDS.includes(profile)) return draft;
    ensureGallery(draft).profile = profile;
    return draft;
  };
}

function safeModeMutation(on) {
  return (draft) => {
    ensureGallery(draft).safeMode = on === true;
    return draft;
  };
}

function standInMutation(name) {
  return (draft) => {
    const g = ensureGallery(draft);
    if (name) g.standIn = name;
    else delete g.standIn;
    return draft;
  };
}

/**
 * What a rotation tick would write: {persona: name} for every persona whose rotation's pick
 * today differs from the body on its row. Pure; main writes it (his own rotation, so his act).
 */
function planRotation(raw, { date = new Date(), allowed = () => true } = {}) {
  const g = readGallery(raw);
  const authors = plain(plain(raw).authors);
  const out = {};
  for (const [persona, rotation] of Object.entries(g.rotation)) {
    const pick = rotationPick(rotation, { date, allowed });
    if (!pick) continue;
    if (str(plain(authors[persona]).character) !== pick) out[persona] = pick;
  }
  return out;
}

// ── proposals: an agent says "this body for that persona"; only he applies it ───────────────

const PROPOSALS_FILE = "avatar-proposals.json";
const MAX_PROPOSALS = 50;

function proposalsPath(dir) {
  return path.join(String(dir || "."), PROPOSALS_FILE);
}

function readProposals(dir) {
  try {
    const list = JSON.parse(fs.readFileSync(proposalsPath(dir), "utf8"));
    return Array.isArray(list) ? list.filter((p) => p && typeof p.id === "string") : [];
  } catch {
    return [];
  }
}

function writeProposals(dir, list) {
  const file = proposalsPath(dir);
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(list.slice(-MAX_PROPOSALS), null, 2));
  fs.renameSync(tmp, file);
}

/** Record a proposal. Never touches cast.json. Returns the stored proposal. */
function propose(dir, { persona, character, by = "agent", why = "" } = {}, { now = () => new Date() } = {}) {
  const p = str(persona, 64).toLowerCase();
  const c = str(character);
  if (!p || !c) return null;
  const list = readProposals(dir).filter((x) => !(x.persona === p && x.character === c));
  const at = now().toISOString();
  const entry = { id: `${p}:${c}:${at}`, persona: p, character: c, by: str(by, 64) || "agent", why: str(why, 240), at };
  list.push(entry);
  writeProposals(dir, list);
  return entry;
}

/** Remove a proposal (applied or dismissed); returns it, or null. */
function takeProposal(dir, id) {
  const list = readProposals(dir);
  const hit = list.find((p) => p.id === id) || null;
  if (hit) writeProposals(dir, list.filter((p) => p.id !== id));
  return hit;
}

module.exports = {
  TIERS,
  TIER_OF,
  RATING_OF,
  PROFILE_IDS,
  PROFILE_LABELS,
  DEFAULT_PROFILES,
  PHYSICS_PRESETS,
  IDLE_CHOICES,
  ROTATION_EVERY,
  NOT_PERSONAS,
  tierOf,
  tierAllowed,
  ratingFromVroid,
  readGallery,
  validateGallery,
  audienceCap,
  ceilingRating,
  rotationPick,
  planRotation,
  personaIds,
  assignMutation,
  unassignMutation,
  avatarConfigMutation,
  rotationMutation,
  profileMutation,
  safeModeMutation,
  standInMutation,
  PROPOSALS_FILE,
  readProposals,
  propose,
  takeProposal,
};
