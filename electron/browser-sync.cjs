"use strict";

/**
 * browser-sync.cjs -- the Aither Browser's bookmarks, history and open tabs follow the
 * owner to the next device.
 *
 * Owner, 2026-11-13: an Edge user has bookmarks, history and open tabs on the phone
 * and the other PCs; the Aither Browser kept everything in local JSON files.
 *
 * THE STORE ALREADY EXISTS. The platform keeps a per-user preferences object:
 *   GET /api/settings/preferences  -> { preferences: { <namespace>: {...} } }  (ETag)
 *   PUT /api/settings/preferences  <- { preferences: { <namespace>: <merge-patch> } }  (If-Match)
 * Veil forwards it to AitherDirectory /directory/self/preferences, which takes the user
 * from the VERIFIED bearer (never a payload field), merges RFC 7386 patches under a
 * per-user lock, and answers 409 on a stale If-Match. awsettings and the desk's
 * settings-sync already use it. No new endpoint was built.
 *
 * ITS LIMITS SHAPE THE WIRE. A namespace holds 16 KiB, a user 256 KiB. So the document
 * is sharded by the item's id, each shard is kept under SHARD_BUDGET_BYTES, and what
 * does not fit is counted and shown ("not synced"), never dropped from this computer:
 *   awbrowser_bm0..3   bookmarks   { <id>: {u, t, m} | {m, d:1} }   (d = tombstone)
 *   awbrowser_hi0..1   history     { <id>: {u, t, m, c} }           (newest MAX_HISTORY)
 *   awbrowser_dev_<id> one device  { n, m, tabs: [{u, t}] }
 *   awbrowser_meta     { v, hc }   (hc = history cleared at)
 * An item is its own key, so the server's merge-patch changes one bookmark without
 * rewriting the others, and a patch carries only what changed. A device writes its own
 * awbrowser_dev_ namespace and only reads the others, so a device that turned sync off
 * is not put back by the next one. Over budget, a bookmark shard drops its oldest live
 * bookmarks and KEEPS its tombstones (a dropped delete would never reach the other
 * device, and both would rewrite the store for ever); a device drops its last tabs.
 *
 * THE STORE IS THE PLATFORM, never the page host. In tenant mode the desk's pages come
 * from the tenant's site, which has no store; the wiring passes the fixed platform
 * origin, so the Online bearer goes to the platform and nowhere else.
 *
 * ONE ACCOUNT. The state file records which account it was agreed with (a hash of the
 * bearer's subject). The transport works out the account BEFORE it sends anything: an
 * unknown account sends nothing, and another account's bearer sends nothing either.
 * Sync then turns itself off and says so; ticking it again is the owner's yes to adding
 * this computer's bookmarks to the new account.
 *
 * A RESET LIBRARY IS NOT A DELETE. The library file carries a generation id. When it
 * differs from the one recorded here (the file was lost, truncated or written by
 * another build), this is a fresh device: nothing is tombstoned, the store restores it.
 *
 * THE MERGE is per item, last writer wins by timestamp, and a delete is a tombstone
 * that outlives the bookmark (180 days), so a bookmark deleted on one device does not
 * come back from another. merge() is commutative and idempotent: two devices that
 * exchange documents in any order end with the same one.
 *
 * WHAT NEVER LEAVES. InPrivate tabs, agent tabs and agent visits; a URL with
 * credentials or a secret-looking query (?token=, ?code=, ...); passwords (they stay
 * in the local vault until the platform vault is live). Default OFF: nothing is sent
 * until the owner turns "Sync this browser" on, and only when signed in.
 *
 * Electron-free: the library, the tab list, fetch, the token and the clock are
 * injected, so browser-sync.test.cjs runs two devices against a local server.
 */

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const nodeCrypto = require("node:crypto");

const VERSION = 1;
const PREFIX = "awbrowser";
const PREFS_PATH = "/api/settings/preferences";
const BOOKMARK_SHARDS = 4;
const HISTORY_SHARDS = 2;
/** Directory refuses a namespace over 16 KiB (413 for the whole write). */
const SHARD_BUDGET_BYTES = 15000;
const MAX_HISTORY = 150;
const MAX_TABS = 30;
const MAX_TITLE = 80;
const MAX_URL = 600;
const DAY_MS = 24 * 60 * 60 * 1000;
const TOMBSTONE_TTL_MS = 180 * DAY_MS;
/** A device that has not synced for this long is removed from the store. */
const DEVICE_TTL_MS = 90 * DAY_MS;
/** ...and is not offered in "Tabs from other devices" after this long. */
const DEVICE_FRESH_MS = 30 * DAY_MS;
const SYNC_INTERVAL_MS = 5 * 60 * 1000;
const SYNC_DEBOUNCE_MS = 15000;
const FETCH_TIMEOUT_MS = 20000;

const SECRET_QUERY = /[?&#;](?:[\w.-]*(?:token|secret|password|passwd|pwd|signature|sig|apikey|api_key|auth|session|sid|code|key))=/i;
/** The shapes Veil's stripCredentials removes on the way in; sent, they would never match what is stored. */
const CREDENTIAL_VALUE = [
  /^\s*sk-[A-Za-z0-9_-]{8,}/, /^\s*(ghp|gho|ghs|ghu|ghr|github_pat)_[A-Za-z0-9_]{10,}/, /^\s*aither_sk_[A-Za-z0-9_]{6,}/,
  /^\s*xox[abprs]-[A-Za-z0-9-]{6,}/, /^\s*(AKIA|ASIA)[0-9A-Z]{16}(?![0-9A-Z])/, /^\s*(sk|rk|pk)_live_[A-Za-z0-9]{8,}/,
  /[a-z][a-z0-9+.-]*:\/\/[^\s/:@]+:[^\s/@]+@/i,
];

// ---------------------------------------------------------------- the document

/** May this URL leave the computer? http(s), no credentials, no secret-looking query. */
function syncable(url) {
  const text = String(url || "");
  if (!text || text.length > MAX_URL) return false;
  let u;
  try { u = new URL(text); } catch { return false; }
  if (u.protocol !== "http:" && u.protocol !== "https:") return false;
  if (u.username || u.password) return false;
  return !SECRET_QUERY.test(u.search + u.hash) && !CREDENTIAL_VALUE.some((re) => re.test(text));
}

function cleanTitle(title) {
  const t = String(title || "").replace(/\s+/g, " ").trim().slice(0, MAX_TITLE);
  return CREDENTIAL_VALUE.some((re) => re.test(t)) ? "" : t;
}

/** An item's key: stable across devices, says nothing about the URL (a tombstone is only this and a time). */
function itemId(url) {
  return nodeCrypto.createHash("sha1").update(String(url)).digest("hex").slice(0, 12);
}

function emptyDoc(deviceId = "") {
  return { version: VERSION, deviceId, updatedAt: 0, bookmarks: {}, history: {}, historyClearedAt: 0, openTabs: {} };
}

/** JSON with sorted keys: the same value is the same text on every device. */
function stable(value) {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${stable(value[k])}`).join(",")}}`;
  }
  return JSON.stringify(value === undefined ? null : value);
}

/** The later of two versions of one item. Equal times: a delete wins, then the text order. */
function newer(a, b) {
  if (!a) return b;
  if (!b) return a;
  const at = (a.at || 0) - (b.at || 0);
  if (at !== 0) return at > 0 ? a : b;
  if (Boolean(a.deleted) !== Boolean(b.deleted)) return a.deleted ? a : b;
  return stable(a) >= stable(b) ? a : b;
}

/** Drop what has expired: old tombstones, devices long gone, history from before a clear or past the cap. */
function compact(doc, now) {
  const out = { ...doc, bookmarks: {}, history: {}, openTabs: {} };
  for (const [id, b] of Object.entries(doc.bookmarks || {})) {
    if (b.deleted && now && now - (b.at || 0) > TOMBSTONE_TTL_MS) continue;
    out.bookmarks[id] = b;
  }
  const cleared = Number(doc.historyClearedAt) || 0;
  const kept = Object.entries(doc.history || {}).filter(([, h]) => (h.at || 0) > cleared)
    .sort(([ia, a], [ib, b]) => (b.at || 0) - (a.at || 0) || (ia < ib ? -1 : 1)).slice(0, MAX_HISTORY);
  for (const [id, h] of kept) out.history[id] = h;
  for (const [id, d] of Object.entries(doc.openTabs || {})) {
    if (now && now - (d.at || 0) > DEVICE_TTL_MS) continue;
    out.openTabs[id] = d;
  }
  return out;
}

/**
 * Two documents into one. Per item the later write wins; a tombstone is an item, so a
 * delete beats an older bookmark and loses to a later re-add. `a` names the device.
 */
function merge(a, b, { now = 0 } = {}) {
  const left = a || emptyDoc();
  const right = b || emptyDoc();
  const out = emptyDoc(left.deviceId || right.deviceId || "");
  out.updatedAt = Math.max(left.updatedAt || 0, right.updatedAt || 0);
  out.historyClearedAt = Math.max(Number(left.historyClearedAt) || 0, Number(right.historyClearedAt) || 0);
  for (const field of ["bookmarks", "openTabs"]) {
    const ids = new Set([...Object.keys(left[field] || {}), ...Object.keys(right[field] || {})]);
    for (const id of ids) out[field][id] = newer((left[field] || {})[id], (right[field] || {})[id]);
  }
  const ids = new Set([...Object.keys(left.history || {}), ...Object.keys(right.history || {})]);
  for (const id of ids) {
    const x = (left.history || {})[id];
    const y = (right.history || {})[id];
    const win = newer(x, y);
    out.history[id] = { ...win, count: Math.max((x && x.count) || 1, (y && y.count) || 1) };
  }
  return compact(out, now);
}

// ---------------------------------------------------------------- this computer <-> the document

function tabsOf(list) {
  return (Array.isArray(list) ? list : [])
    .filter((t) => t && t.by === "you" && (t.kind === undefined || t.kind === "web") && !t.private && syncable(t.url))
    .slice(0, MAX_TABS)
    .map((t) => ({ url: String(t.url), title: cleanTitle(t.title) }));
}

/**
 * Fold this computer's library and open tabs into the document it last agreed on.
 * `mirrored` is the set of bookmark ids that were in the library after the last sync:
 * one of those missing now is a delete the owner made here (a tombstone). A bookmark
 * that never reached the library (it was full) is not in `mirrored`, so it is never
 * mistaken for a delete.
 * @returns {{doc: object, skipped: number}} skipped = local entries that may not leave.
 */
function captureLocal(doc, { bookmarks = [], history = [], tabs = [], mirrored = [], deviceId, deviceName = "", now }) {
  const out = { ...emptyDoc(deviceId), ...doc, deviceId, bookmarks: { ...(doc && doc.bookmarks) }, history: { ...(doc && doc.history) },
    openTabs: { ...(doc && doc.openTabs) } };
  let skipped = 0;
  const here = new Set();
  for (const b of bookmarks) {
    if (!b || !syncable(b.url)) { skipped += 1; continue; }
    const id = itemId(b.url);
    here.add(id);
    const cur = out.bookmarks[id];
    if (!cur) out.bookmarks[id] = { url: b.url, title: cleanTitle(b.title), at: Number(b.at) || now };
    // Deleted in the document but back in the library: the owner added it again, after the delete.
    else if (cur.deleted) out.bookmarks[id] = { url: b.url, title: cleanTitle(b.title), at: Math.max(now, (cur.at || 0) + 1) };
  }
  for (const id of mirrored) {
    const cur = out.bookmarks[id];
    if (cur && !cur.deleted && !here.has(id)) out.bookmarks[id] = { at: now, deleted: true };
  }
  const cleared = Number(out.historyClearedAt) || 0;
  let taken = 0;
  for (const h of history) {
    if (taken >= MAX_HISTORY) break;
    if (!h || h.by === "agent") continue;
    if (!syncable(h.url)) { skipped += 1; continue; }
    taken += 1;
    const at = Number(h.at) || 0;
    if (at <= cleared) continue;
    const id = itemId(h.url);
    const cur = out.history[id];
    if (!cur || at > (cur.at || 0)) {
      out.history[id] = { url: h.url, title: cleanTitle(h.title), at, count: Math.max(Number(h.count) || 1, (cur && cur.count) || 1) };
    }
  }
  if (deviceId) {
    const name = cleanTitle(deviceName) || "This computer";
    const all = tabsOf(tabs);
    // The document holds what the store can hold, so the two agree after a sync.
    const over = fitTabs({ n: name, m: now, tabs: all.map((t) => ({ u: t.url, t: t.title })) });
    skipped += over;
    const mine = { name, tabs: all.slice(0, all.length - over) };
    const cur = out.openTabs[deviceId];
    const same = cur && stable({ name: cur.name, tabs: cur.tabs }) === stable(mine);
    // Unchanged tabs are re-stamped once a day, so a device in use never looks gone.
    if (!same || now - (cur.at || 0) > DAY_MS) out.openTabs[deviceId] = { ...mine, at: now };
  }
  out.updatedAt = now;
  return { doc: out, skipped };
}

/** What the library must change to match the document. */
function planApply(doc, { bookmarks = [], history = [] } = {}) {
  const local = new Map(bookmarks.map((b) => [itemId(b.url), b]));
  const addBookmarks = [];
  const removeBookmarks = [];
  for (const [id, b] of Object.entries(doc.bookmarks || {})) {
    if (b.deleted) { if (local.has(id)) removeBookmarks.push(local.get(id).url); } else if (!local.has(id) && b.url) addBookmarks.push({ url: b.url, title: b.title || "", at: b.at });
  }
  const seen = new Map(history.map((h) => [h.url, h]));
  const add = [];
  for (const h of Object.values(doc.history || {})) {
    const cur = seen.get(h.url);
    if (!cur || (cur.at || 0) < (h.at || 0)) add.push({ url: h.url, title: h.title || "", at: h.at, count: h.count || 1 });
  }
  return { addBookmarks, removeBookmarks, history: add, clearHistoryBefore: Number(doc.historyClearedAt) || 0 };
}

// ---------------------------------------------------------------- the wire

/** Bytes as Directory counts them: compact JSON, sorted keys, non-ASCII as \uXXXX. */
function wireBytes(value) {
  const text = stable(value);
  let n = text.length;
  for (let i = 0; i < text.length; i += 1) if (text.charCodeAt(i) > 0x7e) n += 5;
  return n;
}

function shardOf(id, shards) {
  return (parseInt(String(id).slice(0, 6), 16) || 0) % shards;
}

/**
 * Keep a shard under the budget: the oldest live items go first. A tombstone (about 30
 * bytes) goes only when tombstones alone are over the budget: a delete that is dropped
 * never reaches the other devices, and they would put the bookmark back on every sync.
 */
function fitShard(shard) {
  let dropped = 0;
  const order = Object.keys(shard).sort((x, y) => (Boolean(shard[x].d) - Boolean(shard[y].d)) || (shard[x].m - shard[y].m) || (x < y ? -1 : 1));
  let size = wireBytes(shard);
  while (size > SHARD_BUDGET_BYTES && order.length) {
    const id = order.shift();
    if (!shard[id].d) dropped += 1;
    size -= wireBytes({ [id]: shard[id] }) - 1;
    delete shard[id];
  }
  return dropped;
}

/** Keep one device's namespace under the budget: the last tabs go. Returns how many. */
function fitTabs(ns) {
  let dropped = 0;
  while (ns.tabs.length && wireBytes(ns) > SHARD_BUDGET_BYTES) { ns.tabs.pop(); dropped += 1; }
  return dropped;
}

/**
 * The document as preference namespaces.
 * @returns {{namespaces: object, unsynced: number}} unsynced = items over the store's size.
 */
function encode(doc, { prefix = PREFIX } = {}) {
  const ns = {};
  let unsynced = 0;
  for (let i = 0; i < BOOKMARK_SHARDS; i += 1) ns[`${prefix}_bm${i}`] = {};
  for (let i = 0; i < HISTORY_SHARDS; i += 1) ns[`${prefix}_hi${i}`] = {};
  for (const [id, b] of Object.entries(doc.bookmarks || {})) {
    ns[`${prefix}_bm${shardOf(id, BOOKMARK_SHARDS)}`][id] = b.deleted ? { m: b.at || 0, d: 1 } : { u: b.url, t: b.title || "", m: b.at || 0 };
  }
  for (const [id, h] of Object.entries(doc.history || {})) {
    ns[`${prefix}_hi${shardOf(id, HISTORY_SHARDS)}`][id] = { u: h.url, t: h.title || "", m: h.at || 0, c: h.count || 1 };
  }
  for (const name of Object.keys(ns)) {
    const dropped = fitShard(ns[name]);
    if (name.includes("_bm")) unsynced += dropped;
  }
  for (const [id, d] of Object.entries(doc.openTabs || {})) {
    if (!/^[a-f0-9]{6,16}$/.test(id)) continue;
    ns[`${prefix}_dev_${id}`] = { n: d.name || "", m: d.at || 0, tabs: (d.tabs || []).slice(0, MAX_TABS).map((t) => ({ u: t.url, t: t.title || "" })) };
    fitTabs(ns[`${prefix}_dev_${id}`]); // captureLocal already counted what this device dropped
  }
  ns[`${prefix}_meta`] = { v: VERSION, ...(doc.historyClearedAt ? { hc: doc.historyClearedAt } : {}) };
  for (const name of Object.keys(ns)) if (!Object.keys(ns[name]).length) delete ns[name];
  return { namespaces: ns, unsynced };
}

/** Only this browser's namespaces out of the user's preferences. */
function ownNamespaces(preferences, { prefix = PREFIX } = {}) {
  const out = {};
  for (const [name, value] of Object.entries(preferences || {})) {
    if (name.startsWith(`${prefix}_`) && value && typeof value === "object" && !Array.isArray(value)) out[name] = value;
  }
  return out;
}

/** Preference namespaces back into a document. Anything malformed is left out. */
function decode(preferences, { prefix = PREFIX } = {}) {
  const doc = emptyDoc();
  const own = ownNamespaces(preferences, { prefix });
  for (const [name, value] of Object.entries(own)) {
    const kind = name.slice(prefix.length + 1);
    if (/^bm\d+$/.test(kind)) {
      for (const [id, b] of Object.entries(value)) {
        if (!b || typeof b !== "object" || !Number.isFinite(b.m)) continue;
        if (b.d) doc.bookmarks[id] = { at: b.m, deleted: true };
        else if (syncable(b.u) && itemId(b.u) === id) doc.bookmarks[id] = { url: b.u, title: cleanTitle(b.t), at: b.m };
      }
    } else if (/^hi\d+$/.test(kind)) {
      for (const [id, h] of Object.entries(value)) {
        if (!h || typeof h !== "object" || !Number.isFinite(h.m) || !syncable(h.u) || itemId(h.u) !== id) continue;
        doc.history[id] = { url: h.u, title: cleanTitle(h.t), at: h.m, count: Math.max(1, Number(h.c) || 1) };
      }
    } else if (kind.startsWith("dev_")) {
      const id = kind.slice(4);
      if (!/^[a-f0-9]{6,16}$/.test(id) || !Number.isFinite(value.m)) continue;
      const tabs = (Array.isArray(value.tabs) ? value.tabs : []).filter((t) => t && syncable(t.u)).slice(0, MAX_TABS)
        .map((t) => ({ url: t.u, title: cleanTitle(t.t) }));
      doc.openTabs[id] = { name: cleanTitle(value.n) || "Another device", tabs, at: value.m };
    } else if (kind === "meta") {
      doc.historyClearedAt = Number(value.hc) || 0;
    }
  }
  return doc;
}

/**
 * The merge-patch that turns what the store holds into what it should hold: changed
 * keys with their value, keys to remove as null. {} when they already agree.
 */
function diff(remote, want) {
  const patch = {};
  const set = (name, key, value) => { (patch[name] = patch[name] || {})[key] = value; };
  for (const [name, value] of Object.entries(want)) {
    const have = remote[name] || {};
    for (const [key, v] of Object.entries(value)) {
      if (stable(have[key]) === stable(v)) continue;
      // The store merges an object into the one it holds: name the fields that must go
      // (a tombstone replaces a bookmark, so its address and title are removed).
      const was = have[key];
      const plain = (x) => x && typeof x === "object" && !Array.isArray(x);
      set(name, key, plain(was) && plain(v) ? { ...Object.fromEntries(Object.keys(was).filter((k) => !(k in v)).map((k) => [k, null])), ...v } : v);
    }
    for (const key of Object.keys(have)) if (!(key in value)) set(name, key, null);
  }
  for (const [name, have] of Object.entries(remote)) {
    if (name in want) continue;
    for (const key of Object.keys(have)) set(name, key, null);
  }
  return patch;
}

/** A plain loopback http origin may carry the bearer; anything else must be https. */
function safeOrigin(raw) {
  try {
    const u = new URL(String(raw || ""));
    const h = u.hostname.toLowerCase().replace(/^\[|\]$/g, "");
    const loop = h === "127.0.0.1" || h === "localhost" || h === "::1";
    return u.protocol === "https:" || (u.protocol === "http:" && loop) ? u.origin : null;
  } catch {
    return null;
  }
}

/** The user a JWT bearer names (its subject), unverified: here it only tells two accounts apart. */
function jwtSubject(bearer) {
  const part = String(bearer || "").split(".")[1];
  if (!part) return "";
  try {
    const claims = JSON.parse(Buffer.from(part, "base64url").toString("utf8"));
    const sub = claims && (claims.sub || claims.user_id);
    return typeof sub === "string" || typeof sub === "number" ? String(sub) : "";
  } catch {
    return "";
  }
}

/** What the state file keeps of an account: a hash, never the name. */
function accountKey(subject) {
  const text = String(subject || "");
  return text ? nodeCrypto.createHash("sha256").update(`awbrowser-account:${text}`).digest("hex").slice(0, 16) : "";
}

/**
 * Who a bearer is, for a platform whose session bearer is opaque (it is; measured
 * 2026-11-13): the JWT's subject when it has one, else the username the identity
 * provider answers for it (`check`: desk-session checkToken, GET /auth/me), asked once
 * per bearer. "" = could not tell; false = the provider says it is not a session.
 * @param {{check: (bearer: string) => Promise<{state: string, username?: string}>}} opts
 */
function createAccountResolver({ check }) {
  let last = { key: "", name: "" };
  return async (bearer) => {
    const subject = jwtSubject(bearer);
    if (subject) return subject;
    const key = nodeCrypto.createHash("sha256").update(String(bearer)).digest("hex");
    if (last.key === key) return last.name;
    const verdict = await check(bearer);
    if (verdict && verdict.state === "invalid") return false;
    if (!verdict || verdict.state !== "valid" || !verdict.username) return "";
    last = { key, name: String(verdict.username) };
    return last.name;
  };
}

/**
 * The transport over the platform's preferences store. Never throws; the token is
 * read per call and never logged, returned or put in a reason.
 *
 * The account is worked out from the bearer BEFORE anything is sent (`account`: the
 * bearer's subject; default the JWT's; the app passes createAccountResolver). No account,
 * or not the one the caller expects (`expect`), and no request is made to the store:
 * one account's bookmarks never reach another's.
 * @param {{origin: () => string, token: () => Promise<string|null>|string|null, fetchImpl?: Function,
 *   account?: (bearer: string) => Promise<string|null>|string|null}} opts
 */
function createPrefsTransport({ origin, token, fetchImpl = globalThis.fetch, timeoutMs = FETCH_TIMEOUT_MS, account = jwtSubject }) {
  async function call(method, body, etag, expect) {
    const base = safeOrigin(typeof origin === "function" ? origin() : origin);
    if (!base) return { ok: false, status: 0, reason: "no safe sync origin" };
    let bearer;
    try { bearer = String((await token()) || "").trim(); } catch { bearer = ""; }
    if (!bearer) return { ok: false, status: 401, reason: "signed-out" };
    let who;
    try {
      const subject = await account(bearer);
      if (subject === false) return { ok: false, status: 401, reason: "signed-out" };
      who = accountKey(subject);
    } catch { who = ""; }
    if (!who) return { ok: false, status: 0, reason: "could not tell which account is signed in" };
    if (expect && expect !== who) return { ok: false, status: 0, reason: "account-changed", account: who };
    const headers = { authorization: `Bearer ${bearer}` };
    if (body) headers["content-type"] = "application/json";
    if (etag) headers["if-match"] = etag;
    try {
      const res = await fetchImpl(`${base}${PREFS_PATH}`, { method, headers, body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(timeoutMs) });
      let data = {};
      try { data = await res.json(); } catch { data = {}; }
      const reason = res.ok ? "" : (res.status === 401 ? "signed-out" : `the store answered ${res.status}${data && data.error ? ` (${String(data.error).slice(0, 80)})` : ""}`);
      return { ok: res.ok, status: res.status, preferences: (data && data.preferences) || {}, etag: res.headers.get("etag") || null, reason, account: who };
    } catch (error) {
      return { ok: false, status: 0, reason: error && error.name === "TimeoutError" ? "the store did not answer in time" : "the store is unreachable" };
    }
  }
  return {
    /** `expect`: the account key the caller's state belongs to; another account is refused unsent. */
    pull: (expect) => call("GET", null, null, expect),
    push: (patch, etag, expect) => call("PUT", { preferences: patch }, etag, expect),
  };
}

// ---------------------------------------------------------------- the engine

function readState(file, fsImpl) {
  try {
    const raw = JSON.parse(fsImpl.readFileSync(file, "utf8"));
    if (raw && raw.version === VERSION) return raw;
  } catch { /* first run */ }
  return null;
}

/**
 * One browser's sync: the switch, the cycle, the timers and the status the menu shows.
 * State (browser-sync.json): the switch, this device's id, the last agreed document, the
 * account it was agreed with and the library generation it mirrors.
 * @param {{file: string, library: object, tabs: () => Array, transport: object, now?: () => number,
 *   deviceName?: string, prefix?: string, onChange?: Function}} opts
 */
function createBrowserSync({ file, library, tabs = () => [], transport, now = () => Date.now(), deviceName = os.hostname(),
  prefix = PREFIX, fsImpl = fs, intervalMs = SYNC_INTERVAL_MS, debounceMs = SYNC_DEBOUNCE_MS, onChange = () => {} }) {
  if (!file || !library || !transport) throw new Error("createBrowserSync needs a file, a library and a transport");
  const loaded = readState(file, fsImpl) || {};
  const state = {
    version: VERSION,
    enabled: loaded.enabled === true,
    deviceId: /^[a-f0-9]{8}$/.test(String(loaded.deviceId || "")) ? loaded.deviceId : nodeCrypto.randomBytes(4).toString("hex"),
    lastSyncAt: Number(loaded.lastSyncAt) || 0,
    mirrored: Array.isArray(loaded.mirrored) ? loaded.mirrored : [],
    doc: loaded.doc && typeof loaded.doc === "object" ? loaded.doc : emptyDoc(),
    account: /^[a-f0-9]{16}$/.test(String(loaded.account || "")) ? loaded.account : "",
    libraryId: typeof loaded.libraryId === "string" ? loaded.libraryId : "",
    accountChanged: loaded.accountChanged === true,
  };
  let verdict = { state: state.lastSyncAt ? "ok" : "never", error: "", unsynced: 0 };
  const generation = () => (typeof library.generation === "function" ? String(library.generation() || "") : "");
  let running = null;
  let debounce = null;
  let interval = null;
  let again = false;

  function save() {
    try {
      fsImpl.mkdirSync(path.dirname(file), { recursive: true });
      const tmp = `${file}.${process.pid}.tmp`;
      fsImpl.writeFileSync(tmp, JSON.stringify(state));
      fsImpl.renameSync(tmp, file);
      return true;
    } catch {
      return false;
    }
  }
  function settle(next) {
    verdict = { ...verdict, ...next };
    try { onChange(status()); } catch { /* a listener never breaks a sync */ }
  }
  function status() {
    return { enabled: state.enabled, state: state.enabled ? verdict.state : (state.accountChanged ? "account-changed" : "off"), error: verdict.error, unsynced: verdict.unsynced,
      lastSyncAt: state.lastSyncAt, deviceId: state.deviceId, deviceName };
  }

  async function cycle() {
    let last = { ok: false, reason: "the store kept changing" };
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const pulled = await transport.pull(state.account);
      if (!pulled.ok) return { ok: false, signedOut: pulled.reason === "signed-out", accountChanged: pulled.reason === "account-changed", reason: pulled.reason };
      if (!state.enabled) return { ok: false, reason: "off" }; // turned off while the store answered
      const who = String(pulled.account || "");
      if (!who) return { ok: false, reason: "could not tell which account is signed in" };
      if (state.account && state.account !== who) return { ok: false, accountChanged: true, reason: "account-changed" };
      state.account = who;
      // A library file that was lost, truncated or rewritten by another build is a fresh
      // device, not the owner deleting every bookmark: nothing here is a delete.
      const gen = generation();
      if (gen !== state.libraryId) state.mirrored = [];
      const at = now();
      const remoteNs = ownNamespaces(pulled.preferences, { prefix });
      const local = captureLocal(state.doc, { bookmarks: library.bookmarks(), history: library.history(MAX_HISTORY * 4), tabs: tabs(),
        mirrored: state.mirrored, deviceId: state.deviceId, deviceName, now: at });
      // A device writes its own open tabs and only reads the others: what the store no
      // longer holds for another device (it turned sync off) is gone here too, never sent back.
      const mine = local.doc.openTabs[state.deviceId];
      local.doc.openTabs = mine ? { [state.deviceId]: mine } : {};
      const merged = merge(local.doc, decode(pulled.preferences, { prefix }), { now: at });
      // The store's side first: it is safe to take whatever happens to the push.
      const applied = library.applySync(planApply(merged, { bookmarks: library.bookmarks(), history: library.history(MAX_HISTORY * 4) }));
      state.doc = merged;
      state.mirrored = library.bookmarks().filter((b) => syncable(b.url)).map((b) => itemId(b.url));
      state.libraryId = gen;
      save();
      const want = encode(merged, { prefix });
      const patch = diff(remoteNs, want.namespaces);
      const keys = Object.values(patch).reduce((n, p) => n + Object.keys(p).length, 0);
      if (keys) {
        const pushed = await transport.push(patch, pulled.etag, who); // the account the pull answered for, or nothing is sent
        if (pushed.reason === "account-changed") return { ok: false, accountChanged: true, reason: "account-changed" };
        if (pushed.status === 409) { last = { ok: false, reason: "the store kept changing" }; continue; } // another device wrote first: take its write, try again
        if (!pushed.ok) return { ok: false, signedOut: pushed.reason === "signed-out", reason: pushed.reason };
      }
      state.lastSyncAt = at;
      save();
      return { ok: true, pushed: keys, applied, unsynced: want.unsynced + local.skipped };
    }
    return last;
  }

  /**
   * Another account is signed in. Nothing was sent to it and nothing of it was taken.
   * Sync turns off and forgets what it agreed with the old account; the library stays.
   * Ticking the switch again adds this computer's bookmarks to the account signed in then.
   */
  function pauseForAccount() {
    state.enabled = false;
    state.accountChanged = true;
    state.account = "";
    state.doc = emptyDoc(state.deviceId);
    state.mirrored = [];
    state.lastSyncAt = 0;
    stop();
    save();
  }

  /** One full sync now. Calls while one runs share it; a change during it runs one more. */
  function syncNow() {
    if (!state.enabled) return Promise.resolve({ ok: false, reason: "off" });
    if (running) { again = true; return running; }
    settle({ state: "syncing" });
    running = cycle().catch((error) => ({ ok: false, reason: String((error && error.message) || error).slice(0, 160) }))
      .then((r) => {
        running = null;
        if (r.ok) settle({ state: "ok", error: "", unsynced: r.unsynced });
        else if (r.accountChanged) { pauseForAccount(); settle({ state: "never", error: "", unsynced: 0 }); }
        else if (r.reason !== "off") settle({ state: r.signedOut ? "signed-out" : "error", error: r.signedOut ? "" : r.reason });
        if (again) { again = false; touch(); }
        return r;
      });
    return running;
  }

  /** Something changed here (a bookmark, a visit, a tab): sync soon. */
  function touch() {
    if (!state.enabled || debounce) return;
    debounce = setTimeout(() => { debounce = null; void syncNow(); }, debounceMs);
    if (typeof debounce.unref === "function") debounce.unref();
  }
  function start() {
    if (!state.enabled || interval) return;
    interval = setInterval(() => { void syncNow(); }, intervalMs);
    if (typeof interval.unref === "function") interval.unref();
    touch();
  }
  function stop() {
    if (interval) clearInterval(interval);
    if (debounce) clearTimeout(debounce);
    interval = null;
    debounce = null;
  }

  /** Take this device's open tabs out of the store (sync was turned off here). */
  async function forgetDevice() {
    const pulled = await transport.pull(state.account);
    if (!pulled.ok) return { ok: false, reason: pulled.reason };
    const name = `${prefix}_dev_${state.deviceId}`;
    const have = ownNamespaces(pulled.preferences, { prefix })[name];
    if (!have) return { ok: true, removed: false };
    const r = await transport.push({ [name]: Object.fromEntries(Object.keys(have).map((k) => [k, null])) }, null, state.account);
    return { ok: r.ok, removed: r.ok, reason: r.reason };
  }

  return {
    status, syncNow, touch, start, stop, forgetDevice,
    enabled: () => state.enabled,
    /** The switch. Off stops the timers and withdraws this device's tabs; the library is untouched. */
    setEnabled(on) {
      const want = Boolean(on);
      if (want === state.enabled) return Promise.resolve(status());
      state.enabled = want;
      if (want) state.accountChanged = false;
      save();
      if (want) {
        verdict = { state: state.lastSyncAt ? "ok" : "never", error: "", unsynced: 0 };
        start();
        return syncNow().then(() => status());
      }
      stop();
      delete (state.doc.openTabs || {})[state.deviceId];
      save();
      settle({});
      return forgetDevice().catch(() => null).then(() => status());
    },
    /** The owner cleared history here: every device drops what is older. */
    noteHistoryCleared() {
      state.doc = { ...state.doc, historyClearedAt: now(), history: {} };
      save();
      touch();
    },
    /** The other devices' open tabs, most recent device first. */
    otherDevices() {
      const at = now();
      return Object.entries((state.enabled && state.doc.openTabs) || {})
        .filter(([id, d]) => id !== state.deviceId && d && at - (d.at || 0) <= DEVICE_FRESH_MS)
        .sort(([, a], [, b]) => (b.at || 0) - (a.at || 0))
        .map(([id, d]) => ({ id, name: d.name, at: d.at, tabs: (d.tabs || []).slice() }));
    },
  };
}

// ---------------------------------------------------------------- the menu

function ago(at, now) {
  const mins = Math.max(0, Math.round((now - at) / 60000));
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} min ago`;
  if (mins < 48 * 60) return `${Math.round(mins / 60)} h ago`;
  return `${Math.round(mins / 1440)} days ago`;
}

/** The one line under the switch: what sync is doing, in the owner's words. */
function statusLine(status, now = Date.now()) {
  if (status && !status.enabled && status.state === "account-changed") return "Off: a different account signed in. Turn sync on to add this computer's bookmarks to it";
  if (!status || !status.enabled) return "Off: bookmarks, history and tabs stay on this computer";
  if (status.state === "signed-out") return "Sign in to AitherOS to sync";
  if (status.state === "error") return `Last sync failed: ${status.error || "unknown error"}`;
  if (status.state === "syncing" && !status.lastSyncAt) return "Syncing…";
  if (!status.lastSyncAt) return "Not synced yet";
  const extra = status.unsynced ? ` (${status.unsynced} not synced: private links or a full store)` : "";
  return `Last synced ${ago(status.lastSyncAt, now)}${extra}`;
}

/**
 * The more-menu rows as an Electron menu template (plain data plus click handlers).
 * @param {{toggle: (on: boolean) => void, syncNow: () => void, open: (url: string) => void}} handlers
 */
function menuItems(status, devices, handlers, { now = Date.now() } = {}) {
  const on = Boolean(status && status.enabled);
  const list = Array.isArray(devices) ? devices : [];
  return [
    { label: "Sync this browser", type: "checkbox", checked: on, click: (item) => handlers.toggle(Boolean(item && item.checked)) },
    { label: statusLine(status, now), enabled: false },
    { label: "Sync now", enabled: on, click: () => handlers.syncNow() },
    { label: "Passwords stay on this computer", enabled: false, visible: on },
    { label: "Tabs from other devices", submenu: list.length
      ? list.map((d) => ({ label: `${d.name} (${ago(d.at, now)})`, submenu: d.tabs.length
        ? d.tabs.map((t) => ({ label: (t.title || t.url).slice(0, 70), toolTip: t.url, click: () => handlers.open(t.url) }))
        : [{ label: "No open tabs", enabled: false }] }))
      : [{ label: on ? "No other device has synced yet" : "Turn on sync to see them", enabled: false }] },
  ];
}

module.exports = {
  BOOKMARK_SHARDS, DEVICE_FRESH_MS, HISTORY_SHARDS, MAX_HISTORY, MAX_TABS, PREFIX, PREFS_PATH, SHARD_BUDGET_BYTES, TOMBSTONE_TTL_MS,
  accountKey, captureLocal, compact, createAccountResolver, createBrowserSync, createPrefsTransport, decode, diff, emptyDoc, encode, itemId, jwtSubject, menuItems, merge,
  ownNamespaces, planApply, safeOrigin, statusLine, syncable, wireBytes,
};
