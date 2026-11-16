"use strict";

/**
 * assist-salt.cjs -- the per-install salt for the action log's content hashes.
 *
 * WHY. The log records a short hash of the text a verb saw ("this selection", "this reply")
 * so the owner can tell two actions touched the same text without the text being stored.
 * A bare SHA-256 prefix of a short or guessable string (a name, a PIN, a phrase) can be
 * brute-forced by anyone who can read the log. HMAC with a secret per-install salt makes
 * that useless: the hash only means something on this machine, and the salt sits behind a
 * user-only ACL like the pairing bearer.
 *
 * File: <userData>/assist-salt.json, beside assist-pair.json. If the salt cannot be read,
 * minted or locked down, the caller gets { ok:false } and the log omits hashes rather than
 * falling back to an unsalted one.
 */

const nodeCrypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const acl = require("./assist-acl.cjs");

const FILE = "assist-salt.json";
const VALID = /^[A-Za-z0-9_-]{40,100}$/;

function loadOrCreateSalt({ dir, fsImpl = fs, platform = process.platform, env = process.env, execFileSync, randomBytes = nodeCrypto.randomBytes, now = Date.now } = {}) {
  const file = path.join(String(dir || "."), FILE);
  try {
    const doc = JSON.parse(fsImpl.readFileSync(file, "utf8"));
    if (doc && typeof doc.salt === "string" && VALID.test(doc.salt)) return { ok: true, salt: Buffer.from(doc.salt, "base64url"), file, created: false };
  } catch { /* first run, or unreadable: mint below */ }
  try {
    const salt = randomBytes(32);
    fsImpl.writeFileSync(file, `${JSON.stringify({ version: 1, salt: salt.toString("base64url"), mintedAt: new Date(now()).toISOString() })}\n`, { mode: 0o600 });
    const locked = acl.lockFileSync({ file, fsImpl, platform, env, ...(execFileSync ? { execFileSync } : {}) });
    if (!locked.ok) {
      try { fsImpl.unlinkSync(file); } catch { /* gone */ }
      return { ok: false, error: `could not restrict the log salt to this user (${locked.error})` };
    }
    return { ok: true, salt, file, created: true };
  } catch (error) { return { ok: false, error: String((error && error.message) || error) }; }
}

module.exports = { loadOrCreateSalt, FILE };
