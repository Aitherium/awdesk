"use strict";

/**
 * assist-pairing.cjs -- the per-install bearer for POST /assist/* and the one-time,
 * user-confirmed pairing that hands it to the AitherConnect extension.
 *
 * WHY. /assist/* carries page text and spends the owner's model budget (a `byok:` lane is
 * the owner's own key). The extension Origin alone is not a credential: any local process
 * can write `Origin: chrome-extension://<id>` in a request. So every /assist/* call needs a
 * bearer that only a paired extension holds.
 *
 *   secret   32 random bytes, minted on first use, stored in <userData>/assist-pair.json
 *            with a USER-ONLY ACL (icacls: inheritance removed, only the current user).
 *            Compared as sha256 digests with timingSafeEqual.
 *   pairing  1. the extension asks (POST /assist/pair/start, pinned extension Origin only);
 *               the desk mints a 6-digit code and opens a NATIVE dialog:
 *               "AitherConnect wants to use Aither at the caret. Your browser shows code
 *               482913 -- does it match?"  [Allow] [Deny]
 *            2. the user compares the code with the one the extension shows and clicks Allow;
 *            3. the extension collects the secret (POST /assist/pair/finish {id}) -- exactly
 *               once, to the holder of the pairing id the start answer returned.
 *            Every approval ROTATES the secret, so re-pairing revokes the old browser.
 *            One pending pairing at a time, one start per 20 s, 120 s to answer: a process
 *            hammering /pair/start cannot bury the owner in dialogs.
 *
 * A forged-Origin local process can still ASK to pair, but it cannot see the code the
 * owner's browser shows, so the owner denies it; it never gets the secret without the
 * owner's click. Electron-free; the dialog, the clock and the ACL tool are injected.
 */

const nodeCrypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const acl = require("./assist-acl.cjs");

const PAIR_TTL_MS = 120000;
const START_GAP_MS = 20000;
const FILE = "assist-pair.json";

function digest(value) { return nodeCrypto.createHash("sha256").update(String(value)).digest(); }

/** Constant-time equality of two secrets of any length. */
function safeEqual(a, b) { return nodeCrypto.timingSafeEqual(digest(a), digest(b)); }

/** "Authorization: Bearer <token>" -> token, or "". Pure. */
function bearerFrom(header) {
  const m = /^Bearer\s+([A-Za-z0-9_-]{20,200})$/.exec(String(header || "").trim());
  return m ? m[1] : "";
}

function createAssistPairing({
  dir, fsImpl = fs, execFile = require("node:child_process").execFile, platform = process.platform,
  env = process.env, confirm = null, now = Date.now, randomBytes = nodeCrypto.randomBytes,
} = {}) {
  const file = path.join(String(dir || "."), FILE);
  let secret = null;
  let pending = null; // { id, code, origin, state: "waiting"|"approved"|"denied", at }
  let lastStart = 0;

  /** The user-only ACL on the secret file (assist-acl.cjs). Never throws. */
  const lockDown = () => acl.lockFile({ file, fsImpl, execFile, platform, env });

  function load() {
    if (secret) return secret;
    try {
      const doc = JSON.parse(fsImpl.readFileSync(file, "utf8"));
      if (doc && typeof doc.secret === "string" && /^[A-Za-z0-9_-]{40,100}$/.test(doc.secret)) { secret = doc.secret; return secret; }
    } catch { /* first run, or unreadable: mint below */ }
    return null;
  }

  /** Mint (or rotate to) a fresh secret and persist it behind the user-only ACL. */
  async function mint() {
    const next = randomBytes(32).toString("base64url");
    fsImpl.writeFileSync(file, `${JSON.stringify({ version: 1, secret: next, mintedAt: new Date(now()).toISOString() })}\n`, { mode: 0o600 });
    const acl = await lockDown();
    if (!acl.ok) {
      // A secret on a file anyone can read is no secret: refuse to use it.
      try { fsImpl.unlinkSync(file); } catch { /* gone */ }
      secret = null;
      return { ok: false, error: `could not restrict the pairing file to this user (${acl.error})` };
    }
    secret = next;
    return { ok: true };
  }

  /** Is this Authorization header a valid bearer? A missing secret means NOTHING is paired: false. */
  function verify(header) {
    const token = bearerFrom(header);
    const s = load();
    if (!token || !s) return false;
    return safeEqual(token, s);
  }

  const isPaired = () => Boolean(load());

  /** Step 1. Returns the id + the code the extension must SHOW the user. */
  function start(origin) {
    const t = now();
    if (pending && pending.state === "waiting" && t - pending.at < PAIR_TTL_MS) return { ok: false, status: 429, error: "A pairing is already waiting for the owner's answer." };
    if (t - lastStart < START_GAP_MS) return { ok: false, status: 429, error: "Wait a few seconds before asking to pair again." };
    if (typeof confirm !== "function") return { ok: false, status: 503, error: "The desk cannot show a pairing dialog." };
    lastStart = t;
    const code = String(nodeCrypto.randomInt(0, 1000000)).padStart(6, "0");
    const id = randomBytes(12).toString("hex");
    const mine = { id, code, origin: String(origin || ""), state: "waiting", at: t };
    pending = mine;
    let asked;
    try { asked = Promise.resolve(confirm({ code, origin: mine.origin })); } catch { asked = Promise.resolve(false); }
    asked
      .then(async (allowed) => {
        if (pending !== mine || mine.state !== "waiting") return;
        if (allowed !== true) { mine.state = "denied"; return; }
        const made = await mint();
        mine.state = made.ok ? "approved" : "denied";
        mine.error = made.ok ? undefined : made.error;
      })
      .catch(() => { if (pending === mine) mine.state = "denied"; });
    return { ok: true, id, code, expiresInSec: Math.round(PAIR_TTL_MS / 1000) };
  }

  /** Step 3. The secret leaves ONCE, to the holder of the id, after the owner's Allow. */
  function finish(id) {
    const p = pending;
    if (!p || !id || !safeEqual(String(id), p.id)) return { ok: false, status: 404, error: "No such pairing." };
    if (now() - p.at > PAIR_TTL_MS && p.state === "waiting") { pending = null; return { ok: false, denied: true, error: "The pairing timed out." }; }
    if (p.state === "waiting") return { ok: false, pending: true };
    pending = null;
    if (p.state === "approved") return { ok: true, token: load() };
    return { ok: false, denied: true, error: p.error || "The owner did not allow it." };
  }

  return { verify, isPaired, start, finish, file, bearerFrom };
}

module.exports = { createAssistPairing, bearerFrom, safeEqual, PAIR_TTL_MS, START_GAP_MS, FILE };
