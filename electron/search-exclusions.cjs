"use strict";

/**
 * search-exclusions -- what Alt+Space / universal search never shows.
 *
 * Owner, 2026-11-06 (screenshot): typing "scre" listed "Succubus Nightmare" and
 * "Scarlet Skips" (Steam) as the 2nd and 5th result, ahead of Sound Recorder.
 * "We definitely need configurable default exclusions, like to exclude games and
 * stuff... some NSFW items appear in the list."
 *
 * The search box is the one surface the owner opens with a screen shared or
 * someone looking over a shoulder, so what it surfaces by default matters more
 * than anywhere else. Three rules, all in ONE file the owner can edit:
 *
 *   ~/.aither/search-exclusions.json
 *   {
 *     "hideGames": true,              // Steam / Epic / GOG / Xbox / Riot launch shortcuts
 *     "hideAdult": true,              // titles matching the adult word list below
 *     "folders":  ["Steam", ...],     // Start-menu folder (the row's subtitle) to hide
 *     "titles":   ["Some App", ...],  // exact titles to hide (case-insensitive)
 *     "patterns": ["\\bdemo\\b"],     // extra regexes, case-insensitive
 *     "allow":    ["Steam"]           // always show, beats every rule above
 *   }
 *
 * Defaults (file missing, unreadable or partial): games AND adult titles hidden.
 * A missing file must never mean "show everything" -- that is the exact state the
 * screenshot came from. The adult-content GATE (content-rating.cjs) governs the
 * avatar roster; search hides adult titles regardless of it, because "I opted in
 * to adult characters" is not "put them in my launcher while I screen-share".
 *
 * Pure decision + one tiny IO reader, so a fixture can fail every rule.
 */

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const FILE = path.join(os.homedir(), ".aither", "search-exclusions.json");

/** Start-menu folders (row subtitles) that are game-store launch shortcuts. */
const GAME_FOLDERS = Object.freeze([
  "steam", "steam library", "epic games", "epic games store", "gog galaxy", "gog.com",
  "xbox", "riot games", "ubisoft connect", "ea app", "origin", "battle.net", "itch",
  "itch.io", "amazon games", "rockstar games", "humble app",
]);

/**
 * Words that mark an adult title. Whole-word, case-insensitive. Deliberately short:
 * a word list that hides "Scarlet" or "Sound Recorder" would make the owner turn the
 * feature off, which is worse than missing an edge case they can add themselves.
 */
const ADULT_WORDS = Object.freeze([
  "succubus", "hentai", "nsfw", "lewd", "ecchi", "erotic", "erotica", "porn", "porno",
  "xxx", "r18", "r-18", "18\\+", "nude", "nudity", "uncensored", "milf", "futa",
  "harem", "brothel", "strip ?club", "sex", "sexy", "waifu ?sex", "lust", "lustful",
]);
const ADULT_RE = new RegExp(`(^|[^a-z0-9])(${ADULT_WORDS.join("|")})([^a-z0-9]|$)`, "i");

const DEFAULTS = Object.freeze({
  hideGames: true,
  hideAdult: true,
  folders: [],
  titles: [],
  patterns: [],
  allow: [],
});

function lower(list) {
  return (Array.isArray(list) ? list : []).map((s) => String(s || "").trim().toLowerCase()).filter(Boolean);
}

/** Compile a settings object into a predicate-ready rule set. Bad regexes are skipped, not fatal. */
function compile(settings = {}) {
  const s = { ...DEFAULTS, ...(settings && typeof settings === "object" ? settings : {}) };
  const patterns = [];
  for (const p of Array.isArray(s.patterns) ? s.patterns : []) {
    try { patterns.push(new RegExp(String(p), "i")); } catch { /* one bad pattern never disables the rest */ }
  }
  return {
    hideGames: s.hideGames !== false,
    hideAdult: s.hideAdult !== false,
    folders: new Set([...lower(s.folders), ...(s.hideGames !== false ? GAME_FOLDERS : [])]),
    titles: new Set(lower(s.titles)),
    patterns,
    allow: new Set(lower(s.allow)),
  };
}

/**
 * Why a row is hidden, or null. A row: {title, subtitle?, kind}.
 * `allow` (by title OR folder) beats every rule.
 */
function hiddenReason(row, rules) {
  if (!row) return null;
  const title = String(row.title || "").trim();
  const folder = String(row.subtitle || "").trim();
  const t = title.toLowerCase();
  const f = folder.toLowerCase();
  if (rules.allow.has(t) || (f && rules.allow.has(f))) return null;
  if (rules.titles.has(t)) return "excluded title";
  if (row.kind === "app" && f && rules.folders.has(f)) return rules.hideGames && GAME_FOLDERS.includes(f) ? "game" : "excluded folder";
  if (rules.hideAdult && (ADULT_RE.test(title) || (row.kind !== "file" && ADULT_RE.test(folder)))) return "adult";
  for (const re of rules.patterns) if (re.test(title)) return "excluded pattern";
  return null;
}

/** Filter rows; returns {rows, hidden} so a surface can say "N hidden" instead of lying about totals. */
function applyExclusions(rows, rules) {
  const kept = [];
  let hidden = 0;
  for (const row of rows || []) {
    if (hiddenReason(row, rules)) hidden += 1;
    else kept.push(row);
  }
  return { rows: kept, hidden };
}

/** Read the owner's file; anything wrong with it falls back to the SAFE defaults. */
function loadRules({ file = FILE, fsImpl = fs } = {}) {
  try {
    return compile(JSON.parse(fsImpl.readFileSync(file, "utf8")));
  } catch {
    return compile(DEFAULTS);
  }
}

/** Write the defaults once, so the owner has a file to edit. Never overwrites. */
function ensureFile({ file = FILE, fsImpl = fs } = {}) {
  try {
    if (fsImpl.existsSync(file)) return false;
    fsImpl.mkdirSync(path.dirname(file), { recursive: true });
    fsImpl.writeFileSync(file, JSON.stringify(DEFAULTS, null, 2) + "\n");
    return true;
  } catch {
    return false;
  }
}

module.exports = { FILE, DEFAULTS, GAME_FOLDERS, ADULT_RE, compile, hiddenReason, applyExclusions, loadRules, ensureFile };
