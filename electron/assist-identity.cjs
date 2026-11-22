"use strict";

/**
 * assist-identity.cjs -- who this desk IS, so the AitherConnect extension can tell it from
 * an impostor on the same loopback port.
 *
 * WHY. The bearer proves the EXTENSION to the desk. Nothing proved the DESK to the
 * extension: any local process that wins the port (or sits on it first) would receive the
 * bearer and every selection the extension sends. So the desk owns a long-lived key pair:
 *
 *   key        ECDSA P-256, minted on first use, private half in
 *              <userData>/assist-desk-key.json behind a user-only ACL. It survives bearer
 *              rotation; a reinstall that loses userData gets a NEW key on purpose.
 *   pairing    /assist/pair/finish returns the public key (raw, base64url) and its
 *              fingerprint. The extension pins both at that moment, after the owner has
 *              compared the code in the native dialog (which also shows the fingerprint).
 *   challenge  before every session of use the extension POSTs /assist/hello {nonce}; the
 *              desk signs "aither-desk-hello-v1\n<nonce>". The extension verifies against
 *              the PINNED key and refuses the desk, sending nothing, when it does not match
 *              -- until the owner pairs again.
 *
 * Signature encoding is IEEE P1363 (r||s), exactly what WebCrypto ECDSA verify takes.
 * Electron-free; the file system, the ACL tool and the clock are injected.
 */

const nodeCrypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const acl = require("./assist-acl.cjs");

const FILE = "assist-desk-key.json";
const HELLO_PREFIX = "aither-desk-hello-v1\n";
const NONCE_RE = /^[A-Za-z0-9_-]{16,128}$/;

/** sha256 of the raw public key -> "AB12-CD34-..." : 32 hex chars in groups, easy to read aloud. */
function fingerprintOf(rawPublic) {
  const hex = nodeCrypto.createHash("sha256").update(rawPublic).digest("hex").slice(0, 32).toUpperCase();
  return hex.match(/.{4}/g).join("-");
}

function rawPublicOf(publicKeyObject) {
  const jwk = publicKeyObject.export({ format: "jwk" });
  return Buffer.concat([Buffer.from([4]), Buffer.from(jwk.x, "base64url"), Buffer.from(jwk.y, "base64url")]);
}

function createAssistIdentity({ dir, fsImpl = fs, platform = process.platform, env = process.env, execFileSync, now = Date.now } = {}) {
  const file = path.join(String(dir || "."), FILE);
  let loaded = null; // { privateKey, raw, fingerprint }

  function fromDoc(doc) {
    if (!doc || typeof doc.privateKey !== "string") return null;
    const privateKey = nodeCrypto.createPrivateKey({ key: Buffer.from(doc.privateKey, "base64url"), format: "der", type: "pkcs8" });
    const raw = rawPublicOf(nodeCrypto.createPublicKey(privateKey));
    return { privateKey, raw, fingerprint: fingerprintOf(raw) };
  }

  /** Load the key, or mint it behind the user-only ACL. { ok:false } means: do not claim an identity. */
  function ensure() {
    if (loaded) return { ok: true };
    try {
      loaded = fromDoc(JSON.parse(fsImpl.readFileSync(file, "utf8")));
      if (loaded) return { ok: true };
    } catch { /* first run, or unreadable: mint below */ }
    try {
      const pair = nodeCrypto.generateKeyPairSync("ec", { namedCurve: "P-256" });
      const der = pair.privateKey.export({ format: "der", type: "pkcs8" }).toString("base64url");
      fsImpl.writeFileSync(file, `${JSON.stringify({ version: 1, alg: "ECDSA-P256-SHA256", privateKey: der, createdAt: new Date(now()).toISOString() })}\n`, { mode: 0o600 });
      const locked = acl.lockFileSync({ file, fsImpl, platform, env, ...(execFileSync ? { execFileSync } : {}) });
      if (!locked.ok) {
        try { fsImpl.unlinkSync(file); } catch { /* gone */ }
        return { ok: false, error: `could not restrict the desk key to this user (${locked.error})` };
      }
      loaded = fromDoc({ privateKey: der });
      return loaded ? { ok: true } : { ok: false, error: "the desk key could not be loaded" };
    } catch (error) { return { ok: false, error: String((error && error.message) || error) }; }
  }

  /** The public half the extension pins: { ok, key (raw P-256 point, base64url), fingerprint }. */
  function info() {
    const made = ensure();
    if (!made.ok) return made;
    return { ok: true, key: loaded.raw.toString("base64url"), fingerprint: loaded.fingerprint };
  }

  /** Answer an extension's challenge: sign the fixed prefix + its nonce. */
  function hello(nonce) {
    if (typeof nonce !== "string" || !NONCE_RE.test(nonce)) return { ok: false, status: 400, error: "hello needs a nonce of 16-128 URL-safe characters" };
    const made = ensure();
    if (!made.ok) return { ok: false, status: 503, error: made.error };
    const sig = nodeCrypto.sign("sha256", Buffer.from(HELLO_PREFIX + nonce, "utf8"), { key: loaded.privateKey, dsaEncoding: "ieee-p1363" });
    return { ok: true, key: loaded.raw.toString("base64url"), fingerprint: loaded.fingerprint, sig: sig.toString("base64url") };
  }

  return { info, hello, ensure, file };
}

/** The check the extension performs, in Node form (tests, and the reference for the extension). */
function verifyHello({ key, nonce, sig }) {
  try {
    const raw = Buffer.from(String(key), "base64url");
    const jwk = { kty: "EC", crv: "P-256", x: raw.subarray(1, 33).toString("base64url"), y: raw.subarray(33, 65).toString("base64url") };
    return nodeCrypto.verify("sha256", Buffer.from(HELLO_PREFIX + nonce, "utf8"), { key: nodeCrypto.createPublicKey({ key: jwk, format: "jwk" }), dsaEncoding: "ieee-p1363" }, Buffer.from(String(sig), "base64url"));
  } catch { return false; }
}

module.exports = { createAssistIdentity, verifyHello, fingerprintOf, HELLO_PREFIX, FILE };
