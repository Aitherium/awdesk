"use strict";

/**
 * last-good-cache.cjs -- the desk's offline memory for its aither:// pages.
 *
 * Owner, 2026-10-10: "there should be more local aither:// pages rather than going
 * to aitherium.com constantly -- cache the pages." The pages are already local
 * files; what they lacked was a memory. Spend and the plane pages (Strata, Nexus,
 * Pulse, ...) read the platform through the gateway, and when the gateway or the
 * service was down they showed an error and nothing else.
 *
 * This module keeps the LAST GOOD answer per key as JSON on disk (under the desk's
 * userData, `page-cache/<key>.json`) and hands it back when the live read fails --
 * always marked STALE with the time it was saved and why the live read failed, so a
 * cached number can never pass for a live one. A failure with nothing cached stays a
 * failure (never zeros).
 *
 * Pure node (fs/path only, electron resolved lazily by the caller), so all of it is
 * asserted under `node --test`.
 */

const fs = require("node:fs");
const path = require("node:path");

const KEY_RE = /^[a-z0-9][a-z0-9._-]{0,79}$/;
/** A cached answer older than this is still shown (it is all we have) but flagged old. */
const OLD_MS = 24 * 60 * 60 * 1000;

function checkKey(key) {
  const k = String(key || "");
  if (!KEY_RE.test(k)) throw new Error(`bad cache key: ${k || "(empty)"}`);
  return k;
}

/**
 * @param {{dir: string|(() => string), now?: () => number, fsImpl?: typeof fs}} opts
 *   `dir` may be a function so the electron userData path is resolved on first use.
 */
function createLastGoodCache({ dir, now = () => Date.now(), fsImpl = fs } = {}) {
  const resolveDir = () => (typeof dir === "function" ? dir() : dir);
  const memory = new Map(); // key -> {savedAt, value}

  function fileFor(key) {
    return path.join(resolveDir(), `${checkKey(key)}.json`);
  }

  /** Save a good answer. Atomic (tmp + rename); a write failure is swallowed (memory still holds it). */
  function remember(key, value) {
    const entry = { savedAt: new Date(now()).toISOString(), value };
    memory.set(checkKey(key), entry);
    try {
      const file = fileFor(key);
      fsImpl.mkdirSync(path.dirname(file), { recursive: true });
      const tmp = `${file}.${process.pid}.tmp`;
      fsImpl.writeFileSync(tmp, JSON.stringify(entry));
      fsImpl.renameSync(tmp, file);
      return true;
    } catch {
      return false;
    }
  }

  /** {savedAt, value} or null. Memory first, then disk (survives a desk restart). */
  function recall(key) {
    const k = checkKey(key);
    if (memory.has(k)) return memory.get(k);
    try {
      const entry = JSON.parse(fsImpl.readFileSync(fileFor(k), "utf8"));
      if (!entry || typeof entry !== "object" || typeof entry.savedAt !== "string" || !("value" in entry)) return null;
      memory.set(k, entry);
      return entry;
    } catch {
      return null;
    }
  }

  /** How old a saved entry is, and whether that is "old" (> 24 h). */
  function age(entry) {
    const ms = Math.max(0, now() - Date.parse(entry && entry.savedAt));
    return { ms: Number.isFinite(ms) ? ms : null, old: Number.isFinite(ms) ? ms > OLD_MS : true };
  }

  return { remember, recall, age, fileFor };
}

/** The stale marker every page renders: "cached 3 h ago -- live read failed: <why>". */
function staleText(savedAt, reason, nowMs = Date.now()) {
  const ms = Math.max(0, nowMs - Date.parse(savedAt));
  let ago;
  if (!Number.isFinite(ms)) ago = "at an unknown time";
  else if (ms < 90 * 1000) ago = "just now";
  else if (ms < 90 * 60 * 1000) ago = `${Math.round(ms / 60000)} min ago`;
  else if (ms < 48 * 3600 * 1000) ago = `${Math.round(ms / 3600000)} h ago`;
  else ago = `${Math.round(ms / 86400000)} d ago`;
  return `offline copy from ${ago}${reason ? ` -- live read failed: ${String(reason).slice(0, 160)}` : ""}`;
}

let shared = null;
/** The desk's one cache, under app.getPath("userData")/page-cache. */
function deskCache() {
  if (!shared) {
    shared = createLastGoodCache({
      dir: () => path.join(require("electron").app.getPath("userData"), "page-cache"),
    });
  }
  return shared;
}

module.exports = { createLastGoodCache, staleText, deskCache, OLD_MS };
