"use strict";

/**
 * browser-workspace-policy.cjs -- the SIGNED workspace policy the browser enforces on
 * the app origins a workspace names (docs/WORKSPACE-POLICY.md).
 *
 *   { v: 1, tenant_id, serial, not_after,
 *     apps: [{ origin, private?: {host, port}, deny?: [...ACTIONS], watermark?, audit? }],
 *     sig }
 *
 * The rules, each of which fails CLOSED:
 *   - `sig` is an Ed25519 signature (base64) over SIGN_DOMAIN + canonical(policy without
 *     sig), checked against PINNED public keys. No pinned key, no policy.
 *   - `serial` only goes up. The highest serial seen (and the digest of the policy that
 *     carried it) is written to userData, so an older policy -- or a different one with
 *     the same serial -- is refused.
 *   - `not_after` is checked on every decision, not only on load.
 *   - the first good policy binds the tenant; another tenant's policy is refused.
 *   - the origins of the last good policy stay GOVERNED when the next one is tampered
 *     with, rolled back, expired or missing: they are refused until a good policy says
 *     otherwise. Origins no good policy ever named are not touched (ordinary browsing).
 *
 * Sources: a local signed file in userData, and GET <platform>/v1/workspace/browser-policy
 * with the Online bearer (fetchRemote; a 404 means "no policy", and nothing is invented
 * for a route that does not answer). The valid candidate with the highest serial wins.
 *
 * Pure: node:crypto and node:fs only, no electron.
 */

const nodeCrypto = require("node:crypto");
const fs = require("node:fs");
const net = require("node:net");
const path = require("node:path");

const VERSION = 1;
const SIGN_DOMAIN = "aither-browser-policy/1\n";
const ACTIONS = Object.freeze(["copy", "paste", "download", "upload", "print", "capture", "devtools"]);
const POLICY_FILE = "browser-workspace-policy.json";
const STATE_FILE = "browser-workspace-policy-state.json";
const REMOTE_PATH = "/v1/workspace/browser-policy";
const MAX_APPS = 200;
const MAX_BYTES = 256 * 1024;
const WORK_PARTITION_PREFIX = "persist:aither-work-";
/** How far the clock may sit behind the latest time seen before it counts as "went back". */
const CLOCK_SLACK_MS = 5 * 60 * 1000;
const UNCONFIRMED = "a private workspace app opens only after the platform has confirmed the policy in this session";

/**
 * The public keys a policy must be signed with: raw 32-byte Ed25519 keys, base64.
 * EMPTY until the key-custody decision is made (docs/WORKSPACE-POLICY.md "Not yet"):
 * with no pinned key every policy fails verification, so nothing is governed.
 * Never put a private key in this repository.
 */
const PINNED_KEYS = Object.freeze([]);

const TENANT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const HOSTNAME = /^(?=.{1,253}$)[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$/;
const RFC3339_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;
const SPKI_ED25519 = Buffer.from("302a300506032b6570032100", "hex");

/** Deterministic JSON: object keys sorted, no spaces; strings, safe integers, booleans, null only. */
function canonical(value) {
  if (value === null || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) throw new Error("only integers are signed");
    return String(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (typeof value === "object") {
    return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`).join(",")}}`;
  }
  throw new Error(`a ${typeof value} cannot be signed`);
}

function withoutSig(doc) {
  const rest = { ...doc };
  delete rest.sig;
  return rest;
}

/** The bytes the signature covers: the policy without `sig`, behind a domain line. */
function signedBytes(doc) {
  return Buffer.from(SIGN_DOMAIN + canonical(withoutSig(doc)), "utf8");
}

function publicKeyObject(raw) {
  const bytes = Buffer.isBuffer(raw) ? raw : Buffer.from(String(raw), "base64");
  if (bytes.length !== 32) throw new Error("a pinned key is 32 bytes");
  return nodeCrypto.createPublicKey({ key: Buffer.concat([SPKI_ED25519, bytes]), format: "der", type: "spki" });
}

/** A key object's raw public half, base64 (what PINNED_KEYS holds). */
function publicKeyRaw(key) {
  const pub = key && key.type === "public" ? key : nodeCrypto.createPublicKey(key);
  const der = pub.export({ format: "der", type: "spki" });
  return der.subarray(der.length - 32).toString("base64");
}

/** Sign a policy (the signer's side; tests and the smoke use it with a throwaway key). */
function signPolicy(doc, privateKey) {
  const rest = withoutSig(doc);
  return { ...rest, sig: nodeCrypto.sign(null, signedBytes(rest), privateKey).toString("base64") };
}

/** Is `doc.sig` a good signature by one of `keys`? Never throws. */
function verifySignature(doc, keys = PINNED_KEYS) {
  try {
    if (!doc || typeof doc !== "object" || typeof doc.sig !== "string") return { ok: false, error: "the policy is not signed" };
    const sig = Buffer.from(doc.sig, "base64");
    if (sig.length !== 64) return { ok: false, error: "the policy signature is malformed" };
    if (!Array.isArray(keys) || keys.length === 0) return { ok: false, error: "no signing key is pinned" };
    const data = signedBytes(doc);
    for (const raw of keys) {
      let key;
      try { key = publicKeyObject(raw); } catch { continue; }
      if (nodeCrypto.verify(null, data, key, sig)) return { ok: true };
    }
    return { ok: false, error: "the policy signature does not match a pinned key" };
  } catch (error) {
    return { ok: false, error: `the policy could not be verified: ${String((error && error.message) || error)}` };
  }
}

/** An http(s) origin string for a URL or origin; "" for anything that has none; throws on garbage. */
function originOf(value) {
  const text = String(value == null ? "" : value).trim();
  if (!text || text === "null") return "";
  const u = new URL(text);
  if (u.protocol === "blob:") return originOf(u.pathname);
  if (u.protocol !== "http:" && u.protocol !== "https:") return "";
  return u.origin;
}

/** A host name as it is compared: lower case, no brackets, no trailing dot. */
function bareHost(value) {
  return String(value == null ? "" : value).trim().toLowerCase().replace(/^\[|\]$/g, "").replace(/\.+$/, "");
}

/**
 * Why a private app may NOT be dialled at this address ("" = it may): this computer
 * itself, a link-local address (cloud metadata lives there), the unspecified address,
 * multicast, or something that looks like an address and is not one. A signed policy
 * does not get to point the door at the desk's own ports.
 */
function forbiddenAddress(value) {
  const host = bareHost(value);
  if (!host) return "empty";
  if (host === "localhost" || host.endsWith(".localhost")) return "loopback";
  if (/^[0-9.]+$/.test(host)) {
    if (!net.isIPv4(host)) return "not an address";
    const [a, b] = host.split(".").map(Number);
    if (a === 127) return "loopback";
    if (a === 0) return "unspecified";
    if (a === 169 && b === 254) return "link-local";
    if (a >= 224) return "multicast or reserved";
    return "";
  }
  if (host.includes(":")) {
    if (!net.isIPv6(host)) return "not an address";
    const mapped = /^(?:0*:)*:?(?:ffff:)?(\d+\.\d+\.\d+\.\d+)$/.exec(host);
    if (mapped) return forbiddenAddress(mapped[1]);
    const groups = expandV6(host);
    if (!groups) return "not an address";
    if (groups.every((g) => g === 0)) return "unspecified";
    if (groups.slice(0, 7).every((g) => g === 0) && groups[7] === 1) return "loopback";
    if (groups.slice(0, 5).every((g) => g === 0) && groups[5] === 0xffff) {
      return forbiddenAddress(`${groups[6] >> 8}.${groups[6] & 255}.${groups[7] >> 8}.${groups[7] & 255}`);
    }
    if ((groups[0] & 0xffc0) === 0xfe80) return "link-local";
    if ((groups[0] & 0xff00) === 0xff00) return "multicast or reserved";
    return "";
  }
  return "";
}

/** An IPv6 address as eight numbers, or null. */
function expandV6(host) {
  const [head, tail] = host.split("::");
  const parse = (part) => (part ? part.split(":").map((g) => parseInt(g, 16)) : []);
  const a = parse(head);
  const b = tail === undefined ? [] : parse(tail);
  if ([...a, ...b].some((g) => !Number.isInteger(g) || g < 0 || g > 0xffff)) return null;
  if (tail === undefined) return a.length === 8 ? a : null;
  if (a.length + b.length > 7) return null;
  return [...a, ...new Array(8 - a.length - b.length).fill(0), ...b];
}

function portOf(u) {
  return Number(u.port) || (u.protocol === "https:" ? 443 : 80);
}

const hasOnly = (obj, allowed) => Object.keys(obj).every((k) => allowed.includes(k));

/** The policy in its checked shape, or the reason it is not one. Strict: an unknown field is an error. */
function normalize(doc, { allowLoopback = false } = {}) {
  const bad = (error) => ({ ok: false, error });
  if (!doc || typeof doc !== "object" || Array.isArray(doc)) return bad("the policy is not an object");
  if (!hasOnly(doc, ["v", "tenant_id", "serial", "not_after", "apps", "sig"])) return bad("the policy has a field this browser does not know");
  if (doc.v !== VERSION) return bad(`policy version ${JSON.stringify(doc.v)} is not supported`);
  if (typeof doc.tenant_id !== "string" || !TENANT.test(doc.tenant_id)) return bad("tenant_id is missing or malformed");
  if (!Number.isSafeInteger(doc.serial) || doc.serial < 1) return bad("serial must be a positive integer");
  if (typeof doc.not_after !== "string" || !RFC3339_UTC.test(doc.not_after) || !Number.isFinite(Date.parse(doc.not_after))) {
    return bad("not_after must be a UTC time like 2027-01-01T00:00:00Z");
  }
  if (!Array.isArray(doc.apps) || doc.apps.length > MAX_APPS) return bad("apps must be a list");
  const apps = [];
  const seen = new Set();
  for (const app of doc.apps) {
    if (!app || typeof app !== "object" || Array.isArray(app)) return bad("an app is not an object");
    if (!hasOnly(app, ["origin", "private", "deny", "watermark", "audit"])) return bad("an app has a field this browser does not know");
    let u;
    try { u = new URL(String(app.origin)); } catch { return bad("an app origin is not a URL"); }
    if ((u.protocol !== "http:" && u.protocol !== "https:") || u.origin !== app.origin) return bad(`app origin ${JSON.stringify(app.origin)} is not a bare http(s) origin`);
    if (seen.has(u.origin)) return bad(`app origin ${u.origin} is listed twice`);
    seen.add(u.origin);
    let priv = null;
    if (app.private !== undefined) {
      const p = app.private;
      if (!p || typeof p !== "object" || !hasOnly(p, ["host", "port"])) return bad("private must be {host, port}");
      const host = bareHost(p.host);
      const isIp = net.isIP(host) !== 0;
      if (!isIp && (/^[0-9.]+$/.test(host) || host.includes(":") || !HOSTNAME.test(host))) return bad("private.host is not a host name or address");
      // An address is preferred (nothing to resolve). Either way: never this computer, never link-local.
      const why = forbiddenAddress(host);
      if (why && !(allowLoopback && why === "loopback")) return bad(`private.host ${host} is not allowed (${why})`);
      if (!Number.isSafeInteger(p.port) || p.port < 1 || p.port > 65535) return bad("private.port is not a port");
      priv = { host, port: p.port };
    }
    const deny = app.deny === undefined ? [] : app.deny;
    if (!Array.isArray(deny) || deny.some((a) => !ACTIONS.includes(a))) return bad("deny names an action this browser does not know");
    for (const flag of ["watermark", "audit"]) {
      if (app[flag] !== undefined && typeof app[flag] !== "boolean") return bad(`${flag} must be true or false`);
    }
    apps.push(Object.freeze({ origin: u.origin, hostname: bareHost(u.hostname), port: portOf(u), private: priv,
      deny: Object.freeze([...new Set(deny)]), watermark: app.watermark === true, audit: app.audit === true }));
  }
  return { ok: true, policy: Object.freeze({ v: VERSION, tenant_id: doc.tenant_id, serial: doc.serial,
    not_after: doc.not_after, notAfterMs: Date.parse(doc.not_after), apps: Object.freeze(apps) }) };
}

function digestOf(doc) {
  return nodeCrypto.createHash("sha256").update(signedBytes(doc)).digest("hex");
}

/**
 * Ask the platform for the workspace's policy. Never invents one:
 *   {status: "none"}  no token, or the route answered 404
 *   {status: "doc", doc}  a JSON object came back (still to be verified)
 *   {status: "error", error}  anything else; the caller keeps what it has
 */
async function fetchRemote({ origin, token, fetchImpl } = {}) {
  try {
    const base = new URL(String(origin || ""));
    const loopback = base.hostname === "127.0.0.1" || base.hostname === "localhost";
    if (base.protocol !== "https:" && !(base.protocol === "http:" && loopback)) return { status: "error", error: "the policy source is not https" };
    const bearer = typeof token === "function" ? await token() : token;
    if (!bearer || typeof bearer !== "string") return { status: "none" };
    const res = await fetchImpl(`${base.origin}${REMOTE_PATH}`, { method: "GET", redirect: "error",
      headers: { authorization: `Bearer ${bearer}`, accept: "application/json" } });
    if (res.status === 404) return { status: "none" };
    if (res.status !== 200) return { status: "error", error: `the policy source answered ${res.status}` };
    const text = await res.text();
    if (text.length > MAX_BYTES) return { status: "error", error: "the policy is too large" };
    const doc = JSON.parse(text);
    if (!doc || typeof doc !== "object" || Array.isArray(doc)) return { status: "error", error: "the policy source did not send a policy" };
    return { status: "doc", doc };
  } catch (error) {
    return { status: "error", error: String((error && error.message) || error) };
  }
}

/**
 * The policy as the browser holds it.
 * @param {object} opts
 * @param {string} opts.dir userData
 * @param {string[]} [opts.keys] pinned public keys (raw, base64); the app passes none (PINNED_KEYS)
 * @param {() => number} [opts.now]
 * @param {{origin: () => string, token: () => Promise<string>|string, fetchImpl: Function}|null} [opts.remote]
 * @param {() => string} [opts.unsafe] why this desk can be driven from outside right now ("" = it cannot)
 * @param {() => (string|null)} [opts.accountTenant] the signed-in account's workspace id (null = not known)
 * @param {boolean} [opts.allowLoopbackTargets] the live proof's seam: a private app on 127.0.0.1. Never set in the app.
 */
function createWorkspacePolicy({ dir, keys = PINNED_KEYS, now = Date.now, remote = null, unsafe = () => "", accountTenant = () => null,
  allowLoopbackTargets = false } = {}) {
  const policyFile = path.join(String(dir), POLICY_FILE);
  const stateFile = path.join(String(dir), STATE_FILE);
  const listeners = new Set();
  /**
   * What survives a restart: the tenant, the highest serial and its digest, the governed
   * origins, the private apps' host names and the latest time this browser has seen.
   */
  let state = { tenant_id: null, serial: 0, digest: null, governed: [], privateHosts: [], seen: 0 };
  let policy = null; // the last candidate that passed signature, schema, tenant and serial
  let problem = null; // why the newest candidate is not in force
  let present = false; // a candidate existed at the last load
  let byOrigin = new Map();
  let stateBroken = false;
  /**
   * The highest serial the PLATFORM has sent, verified, in THIS launch. Never persisted:
   * the state file is the user's to edit, so a rollback it cannot see is only ruled out
   * by the platform answering now. Private apps stay closed until it has.
   */
  let confirmedSerial = null;

  function readState() {
    let raw;
    try { raw = fs.readFileSync(stateFile, "utf8"); } catch { return; } // never written: nothing is governed yet
    try {
      const s = JSON.parse(raw);
      if (!s || typeof s !== "object" || !Number.isSafeInteger(s.serial) || !Array.isArray(s.governed)) throw new Error("shape");
      const strings = (list) => (Array.isArray(list) ? list.filter((o) => typeof o === "string") : []);
      state = { tenant_id: typeof s.tenant_id === "string" ? s.tenant_id : null, serial: s.serial,
        digest: typeof s.digest === "string" ? s.digest : null, governed: strings(s.governed), privateHosts: strings(s.privateHosts),
        seen: Number.isFinite(s.seen) && s.seen > 0 ? s.seen : 0 };
    } catch {
      // A state file that is there but unreadable: what it governed is unknown, so no policy is trusted.
      stateBroken = true;
    }
  }

  function writeFile(file, text) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, text, { mode: 0o600 });
    fs.renameSync(tmp, file);
  }

  function readLocal() {
    let raw;
    try { raw = fs.readFileSync(policyFile, "utf8"); } catch { return { present: false }; }
    if (raw.length > MAX_BYTES) return { present: true, error: "the policy file is too large" };
    try { return { present: true, doc: JSON.parse(raw) }; } catch { return { present: true, error: "the policy file is not JSON" }; }
  }

  /** The clock, or NaN when it cannot be read. */
  function clock() {
    try { const at = Number(now()); return Number.isFinite(at) ? at : NaN; } catch { return NaN; }
  }

  /** Signature, schema, tenant, serial -- everything but expiry (which is checked at decision time). */
  function check(doc) {
    const sig = verifySignature(doc, keys);
    if (!sig.ok) return sig;
    const norm = normalize(doc, { allowLoopback: allowLoopbackTargets === true });
    if (!norm.ok) return norm;
    const p = norm.policy;
    if (state.tenant_id && p.tenant_id !== state.tenant_id) return { ok: false, error: `the policy is for another workspace (${p.tenant_id})` };
    if (p.serial < state.serial) return { ok: false, error: `the policy was rolled back (serial ${p.serial}, already saw ${state.serial})` };
    const digest = digestOf(doc);
    if (p.serial === state.serial && state.digest && digest !== state.digest) return { ok: false, error: `a different policy reuses serial ${p.serial}` };
    return { ok: true, policy: p, digest, doc };
  }

  function snapshot() {
    const st = status();
    return JSON.stringify([policy ? [policy.serial, policy.tenant_id] : null, problem, st.state, st.reason, confirmed(), state.governed]);
  }

  /**
   * Re-read the local file (and judge `remoteDoc` when one was fetched). The valid
   * candidate with the highest serial comes into force; when candidates exist and none
   * is valid, or the file is gone while origins are governed, nothing is in force.
   */
  function load({ remoteDoc = null } = {}) {
    const before = snapshot();
    const local = readLocal();
    const candidates = [];
    const errors = [];
    if (stateBroken) errors.push("the saved policy state is unreadable");
    if (local.present && local.doc) candidates.push({ from: "file", doc: local.doc });
    else if (local.present) errors.push(local.error);
    if (remoteDoc) candidates.push({ from: "remote", doc: remoteDoc });
    present = local.present || Boolean(remoteDoc);
    let best = null;
    let confirmedNow = false;
    if (!stateBroken) {
      for (const c of candidates) {
        const r = check(c.doc);
        if (!r.ok) { errors.push(r.error); continue; }
        if (c.from === "remote") {
          confirmedSerial = Math.max(confirmedSerial == null ? 0 : confirmedSerial, r.policy.serial);
          confirmedNow = true;
        }
        if (!best || r.policy.serial > best.policy.serial) best = { ...r, from: c.from };
      }
    }
    // The latest time seen only goes forward -- except when the platform has just
    // answered with a good policy: then the clock as it is now is taken as right.
    const at = clock();
    let seen = state.seen;
    if (Number.isFinite(at) && (at > seen || confirmedNow)) seen = at;
    const seenMoved = Math.abs(seen - state.seen) > 60 * 1000;
    if (best) {
      policy = best.policy;
      problem = null;
      byOrigin = new Map(policy.apps.map((a) => [a.origin, a]));
      state = { tenant_id: policy.tenant_id, serial: policy.serial, digest: best.digest, governed: policy.apps.map((a) => a.origin),
        privateHosts: [...new Set(policy.apps.filter((a) => a.private).map((a) => a.hostname))], seen };
      try {
        writeFile(stateFile, JSON.stringify(state));
        // A policy the platform sent is kept for the next start (it is verified again then).
        if (best.from === "remote") writeFile(policyFile, JSON.stringify(best.doc));
      } catch (error) {
        // The serial could not be recorded: a rollback would go unseen, so this policy is not used.
        policy = null;
        byOrigin = new Map();
        problem = `the policy state could not be saved: ${String((error && error.message) || error)}`;
      }
    } else {
      policy = null;
      byOrigin = new Map();
      problem = errors[0] || (state.governed.length ? "the workspace policy is missing" : null);
      if (seenMoved && !stateBroken && state.governed.length) {
        state = { ...state, seen };
        try { writeFile(stateFile, JSON.stringify(state)); } catch { /* the next load tries again */ }
      }
    }
    if (snapshot() !== before) emit();
    return status();
  }

  function emit() {
    for (const fn of listeners) { try { fn(status()); } catch { /* a listener never breaks the policy */ } }
  }

  /**
   * {state, reason, tenant_id, serial, not_after, confirmed}. state is
   *   none     nothing was ever governed
   *   ok       a policy is in force
   *   expired  not_after has passed, the clock cannot be read, or it went back
   *   invalid  the newest candidate is not a good policy, or it is another workspace's
   *   missing  origins are governed and the policy is gone
   *   unsafe   this desk can be driven from outside (remote debugging): governed apps stay closed
   */
  function status() {
    const base = { tenant_id: policy ? policy.tenant_id : state.tenant_id, serial: policy ? policy.serial : state.serial,
      not_after: policy ? policy.not_after : null, confirmed: confirmed() };
    if (policy) {
      let door;
      try { door = String(unsafe() || ""); } catch { door = "the launch could not be checked"; }
      if (door) return { ...base, state: "unsafe", reason: `remote debugging is on (${door}), so workspace apps stay closed` };
      let signedIn;
      try { signedIn = accountTenant(); } catch { signedIn = null; }
      if (signedIn && String(signedIn).toLowerCase() !== policy.tenant_id.toLowerCase()) {
        return { ...base, state: "invalid", reason: `the policy is for workspace ${policy.tenant_id}, and you are signed in to another one` };
      }
      // A clock that cannot be read is not "not expired yet"; one that went back is not trusted.
      const at = clock();
      if (!(at < policy.notAfterMs)) return { ...base, state: "expired", reason: `the workspace policy expired on ${policy.not_after}` };
      if (at < state.seen - CLOCK_SLACK_MS) return { ...base, state: "expired", reason: "this computer's clock went back, so the workspace policy's expiry cannot be checked" };
      return { ...base, state: "ok", reason: "" };
    }
    if (problem) return { ...base, state: present || stateBroken ? "invalid" : "missing", reason: problem };
    return { ...base, state: "none", reason: "" };
  }

  /** The platform has sent, in this launch, a good policy with a serial at or above the one in force. */
  function confirmed() {
    return Boolean(policy) && confirmedSerial != null && confirmedSerial >= policy.serial;
  }

  function governs(value) {
    try {
      const origin = originOf(value);
      return Boolean(origin) && (byOrigin.has(origin) || state.governed.includes(origin));
    } catch {
      return true; // an address that cannot be read is not waved through
    }
  }

  /** The app entry for an origin while the policy is in force, else null. */
  function appFor(value) {
    try {
      if (status().state !== "ok") return null;
      return byOrigin.get(originOf(value)) || null;
    } catch {
      return null;
    }
  }

  /**
   * May `action` ("open" or one of ACTIONS) happen on `origin`? Never allows on an error.
   * @returns {{allow: boolean, governed: boolean, reason: string}}
   */
  function decide(origin, action) {
    try {
      const o = originOf(origin);
      if (!o || !(byOrigin.has(o) || state.governed.includes(o))) return { allow: true, governed: false, reason: "not a workspace app" };
      const st = status();
      if (st.state !== "ok") return { allow: false, governed: true, reason: st.reason || "the workspace policy is not in force" };
      const app = byOrigin.get(o);
      if (!app) return { allow: false, governed: true, reason: "the workspace policy no longer lists this app" };
      if (action === "open") {
        if (app.private && !confirmed()) return { allow: false, governed: true, reason: UNCONFIRMED };
        return { allow: true, governed: true, reason: "" };
      }
      if (!ACTIONS.includes(action)) return { allow: false, governed: true, reason: "not an action the workspace policy knows" };
      if (app.deny.includes(action)) return { allow: false, governed: true, reason: "turned off by the workspace policy" };
      return { allow: true, governed: true, reason: "" };
    } catch (error) {
      return { allow: false, governed: true, reason: `the workspace policy could not be read: ${String((error && error.message) || error)}` };
    }
  }

  /** The session partition governed apps open in, once a tenant is known. */
  function partition() {
    const tenant = policy ? policy.tenant_id : state.tenant_id;
    return tenant && TENANT.test(tenant) ? `${WORK_PARTITION_PREFIX}${tenant}` : null;
  }

  /**
   * Where a page may open. `partition` is the session the tab rides (or would ride).
   *   allow   nothing to do
   *   work    a governed app in an ordinary owner tab: it opens in the work partition
   *   refuse  a governed app in an agent's tab; a private app in an InPrivate tab
   *   closed  a governed app while the policy is not in force (or not yet confirmed, for a private app)
   */
  function gate({ url, by = "you", private: inPrivate = false, partition: current = null } = {}) {
    try {
      const o = originOf(url);
      if (!o || !(byOrigin.has(o) || state.governed.includes(o))) return { verdict: "allow" };
      // An agent never gets a workspace app, public or private, in force or not.
      if (by !== "you") return { verdict: "refuse", reason: "a workspace app does not open in an agent's tab" };
      const open = decide(o, "open");
      if (!open.allow) return { verdict: "closed", reason: open.reason };
      const app = byOrigin.get(o);
      const work = partition();
      if (inPrivate) {
        if (app.private) return { verdict: "refuse", reason: "a private workspace app does not open InPrivate" };
        return { verdict: "allow" };
      }
      if (current && current === work) return { verdict: "allow" };
      return { verdict: "work", partition: work };
    } catch (error) {
      return { verdict: "closed", reason: `the workspace policy could not be read: ${String((error && error.message) || error)}` };
    }
  }

  /** The apps of the policy in force (none while it is not). */
  function apps() {
    try { return status().state === "ok" ? policy.apps : []; } catch { return []; }
  }

  /** The private apps that may be reached right now: in force AND confirmed by the platform in this launch. */
  function privateHosts() {
    try {
      if (status().state !== "ok" || !confirmed()) return [];
      return [...new Set(policy.apps.filter((a) => a.private).map((a) => a.hostname))];
    } catch {
      return [];
    }
  }

  /**
   * Every host name that is, or last was, a private app -- whether or not it may be
   * reached now. The proxy script keeps sending these to the door (which refuses them)
   * so that a policy going out of force never turns into a direct connection.
   */
  function routedHosts() {
    const now_ = policy ? policy.apps.filter((a) => a.private).map((a) => a.hostname) : [];
    return [...new Set([...now_, ...state.privateHosts])].map(bareHost).filter(Boolean);
  }

  /** The mesh address a private app's host:port maps to, only while it may be reached (privateHosts). */
  function privateTarget(hostname, port) {
    try {
      if (status().state !== "ok" || !confirmed()) return null;
      const host = bareHost(hostname);
      const app = policy.apps.find((a) => a.private && a.hostname === host && a.port === Number(port));
      return app ? { host: app.private.host, port: app.private.port, origin: app.origin } : null;
    } catch {
      return null;
    }
  }

  /**
   * May this request leave? A request for a private app's host is let through only when
   * it IS the page (a top-level navigation, judged by gate) or the page it belongs to is
   * a governed app in force. An ungoverned page in the work session gets nothing from it.
   */
  function requestAllowed({ url, resourceType = "", topOrigin = "" } = {}) {
    try {
      const u = new URL(String(url));
      if (!routedHosts().includes(bareHost(u.hostname))) return true;
      if (resourceType === "mainFrame") return true;
      return Boolean(appFor(topOrigin));
    } catch {
      return false;
    }
  }

  async function refresh() {
    if (!remote) return load();
    let origin;
    try { origin = remote.origin(); } catch { origin = ""; }
    const got = await fetchRemote({ origin, token: remote.token, fetchImpl: remote.fetchImpl });
    return { ...load({ remoteDoc: got.status === "doc" ? got.doc : null }), remote: got.status, remoteError: got.error || null };
  }

  readState();
  return {
    appFor, apps, confirmed, decide, gate, governs, load, partition, privateHosts, privateTarget, refresh, requestAllowed, routedHosts, status,
    tenantId: () => (policy ? policy.tenant_id : state.tenant_id),
    onChange: (fn) => { listeners.add(fn); return () => listeners.delete(fn); },
    /** Something status() reads changed (the clock, the sign-in, the launch): tell the listeners. */
    tick: () => emit(),
    files: Object.freeze({ policy: policyFile, state: stateFile }),
  };
}

module.exports = {
  ACTIONS, CLOCK_SLACK_MS, PINNED_KEYS, POLICY_FILE, REMOTE_PATH, SIGN_DOMAIN, STATE_FILE, UNCONFIRMED, WORK_PARTITION_PREFIX,
  bareHost, canonical, createWorkspacePolicy, fetchRemote, forbiddenAddress, normalize, originOf, publicKeyRaw, signPolicy, signedBytes, verifySignature,
};
