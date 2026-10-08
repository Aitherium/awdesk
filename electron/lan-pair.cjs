"use strict";

/**
 * lan-pair -- the "Nearby devices" contract: what an unpaired device in pairing mode
 * advertises on the LAN, and how a member's Desk reads it without believing it.
 *
 * Phase 2 of device join (AitherOS/docs/devices/LAN_PAIR_DISCOVERY.md). An unpaired
 * device that the person has put in pairing mode (`adk pair-mode`, at most 5 minutes)
 * advertises `_aither-pair._tcp` with TXT {v=1, rid, class}. Members keep `_aither._tcp`.
 *
 * Everything heard here is UNTRUSTED. Nothing beyond those three TXT keys is believed; an
 * advert carrying a secret-shaped key (sas, code, token, ...) is dropped whole; the advertised
 * host and port are never contacted. Joining still needs the 6-digit SAS shown on the
 * device and a server-side approval (Phase 1, Identity /v1/nodes/join): "Approve" here only opens the signed-in
 * approval page for that rid.
 *
 * Kept in step with awdk adk/lan_pair.py and the Android NearbyBook.java (same tests).
 */

const SERVICE_TYPE = "_aither-pair._tcp";
const MEMBER_SERVICE_TYPE = "_aither._tcp";
const ADVERT_VERSION = "1";
const DEVICE_CLASSES = Object.freeze(new Set([
  "phone", "watch", "laptop", "desktop", "deck",
]));
/** Identity's request id (identity_device_join.py _RID_RE: secrets.token_hex(16)). */
const RID_RE = /^[0-9a-f]{32}$/;
const FORBIDDEN_KEYS = Object.freeze(new Set([
  "sas", "code", "pin", "otp", "token", "poll", "poll_token", "secret", "key",
  "password", "pass", "pw", "auth", "bearer", "nonce", "claim", "claim_secret",
  "join", "join_code", "sig", "signature",
]));
const MAX_WINDOW_MS = 5 * 60 * 1000;
const MAX_TXT_KEYS = 8;
const MAX_TXT_VALUE = 64;
const MAX_TXT_BYTES = 400;
const MAX_LABEL = 40;

/**
 * Phase-1 seam: Aither Control's Devices tab, signed in, where "Devices waiting to join"
 * lists the request (same account) or the member types the code and number the device
 * shows (a device with no account yet). Change HERE.
 */
const APPROVE_PAGE = "https://app.aitherium.com/?app=control";

function str(v) {
  if (v == null) return "";
  if (Buffer.isBuffer(v) || v instanceof Uint8Array) return Buffer.from(v).toString("utf8");
  return String(v);
}

/**
 * TXT (an object, or the array of "k=v" Buffers/strings multicast-dns hands over) ->
 * {v, rid, class} or null.
 */
function parseTxt(txt) {
  let pairs;
  if (Array.isArray(txt)) {
    pairs = txt.map((item) => {
      const s = str(item);
      const i = s.indexOf("=");
      return i < 0 ? [s, ""] : [s.slice(0, i), s.slice(i + 1)];
    });
  } else if (txt && typeof txt === "object") {
    pairs = Object.entries(txt);
  } else {
    return null;
  }
  if (pairs.length > MAX_TXT_KEYS) return null;
  const seen = new Map();
  let total = 0;
  for (const [k, v] of pairs) {
    const key = str(k).trim().toLowerCase();
    const val = str(v).trim();
    total += key.length + val.length + 2;
    if (!key || seen.has(key) || val.length > MAX_TXT_VALUE || total > MAX_TXT_BYTES) return null;
    if (FORBIDDEN_KEYS.has(key)) return null;
    seen.set(key, val);
  }
  if (seen.get("v") !== ADVERT_VERSION) return null;
  const rid = seen.get("rid") || "";
  const cls = (seen.get("class") || "").toLowerCase();
  if (!RID_RE.test(rid) || !DEVICE_CLASSES.has(cls)) return null;
  return { v: ADVERT_VERSION, rid, class: cls };
}

/** An instance name for display: printable, one line, short. Never verified. */
function cleanLabel(name) {
  // \p{C}: control, format (bidi overrides), surrogates, unassigned; \p{Zl}\p{Zp}: line breaks
  const s = str(name).replace(/[\p{C}\p{Zl}\p{Zp}]/gu, "").split(/\s+/).filter(Boolean).join(" ");
  return Array.from(s).slice(0, MAX_LABEL).join("");
}

/** The approval page for one rid, or null when the rid is off-contract. */
function approveUrl(rid, base = APPROVE_PAGE) {
  if (!RID_RE.test(String(rid || ""))) return null;
  const u = new URL(base);
  u.searchParams.set("nearby", rid);
  return u.toString();
}

/**
 * What "Nearby devices" lists. offer() answers one word so a caller can count drops
 * without logging advert content: added refreshed rejected flood full source-cap conflict
 * banned.
 */
class CandidateBook {
  constructor({ now = Date.now, ttlMs = MAX_WINDOW_MS, maxCandidates = 16, maxPerSource = 2,
    burst = 40, refillPerSec = 4 } = {}) {
    Object.assign(this, { now, ttlMs, maxCandidates, maxPerSource, burst, refillPerSec });
    this.cands = new Map();
    this.banned = new Map();
    this.tokens = burst;
    this.lastRefill = null;
    this.dropped = 0;
  }

  takeToken(t) {
    if (this.lastRefill === null) this.lastRefill = t;
    this.tokens = Math.min(this.burst, this.tokens + ((t - this.lastRefill) / 1000) * this.refillPerSec);
    this.lastRefill = t;
    if (this.tokens < 1) return false;
    this.tokens -= 1;
    return true;
  }

  expire(t) {
    for (const [rid, c] of this.cands) {
      if (t - c.firstSeen > this.ttlMs) {
        // a rid lives one window: re-announcing it after that never brings it back
        this.cands.delete(rid);
        this.banned.set(rid, t + this.ttlMs);
      }
    }
    for (const [rid, until] of this.banned) if (t > until) this.banned.delete(rid);
  }

  offer(txt, { label = "", source = "" } = {}) {
    const t = this.now();
    if (!this.takeToken(t)) { this.dropped += 1; return "flood"; }
    this.expire(t);
    const adv = parseTxt(txt);
    if (!adv) { this.dropped += 1; return "rejected"; }
    const src = str(source).trim().slice(0, 64);
    if (this.banned.has(adv.rid)) return "banned";
    const have = this.cands.get(adv.rid);
    if (have) {
      if (have.source !== src || have.class !== adv.class) {
        // one rid, two hosts (or a class flip): someone is replaying it. Drop it.
        this.cands.delete(adv.rid);
        this.banned.set(adv.rid, t + this.ttlMs);
        return "conflict";
      }
      have.lastSeen = t; // firstSeen kept: a refresh never extends the window
      return "refreshed";
    }
    let fromSource = 0;
    for (const c of this.cands.values()) if (c.source === src) fromSource += 1;
    if (fromSource >= this.maxPerSource) { this.dropped += 1; return "source-cap"; }
    if (this.cands.size >= this.maxCandidates) { this.dropped += 1; return "full"; }
    this.cands.set(adv.rid, { rid: adv.rid, class: adv.class, label: cleanLabel(label), source: src,
      firstSeen: t, lastSeen: t });
    return "added";
  }

  remove(rid) { this.cands.delete(rid); }

  has(rid) { this.expire(this.now()); return this.cands.has(rid); }

  list() {
    this.expire(this.now());
    return [...this.cands.values()].sort((a, b) => a.firstSeen - b.firstSeen)
      .map((c) => ({ rid: c.rid, class: c.class, label: c.label, verified: false }));
  }
}

/**
 * Browse `_aither-pair._tcp` with a multicast-dns instance (MIT, mafintosh/multicast-dns).
 * Only PTR -> SRV/TXT names under the service type are read; A/AAAA are never needed
 * because nothing is ever fetched from a candidate. `rinfo.address` is the source used for
 * the per-host cap and the replay check. Returns stop().
 */
function browse(mdns, book, { onChange = () => {}, queryEveryMs = 5000, setInterval: si = setInterval,
  clearInterval: ci = clearInterval } = {}) {
  const suffix = `.${SERVICE_TYPE}.local`;
  const under = (name) => typeof name === "string" && name.toLowerCase().endsWith(suffix.toLowerCase());
  let asked = new Set(); // instance names whose TXT was asked for this interval (bounded)
  const onResponse = (packet, rinfo) => {
    const records = [...(packet && packet.answers || []), ...(packet && packet.additionals || [])];
    if (records.length > 64) return; // a flood in one packet: ignore it whole
    let changed = false;
    const hasTxt = new Set(records.filter((r) => r && r.type === "TXT").map((r) => String(r.name)));
    for (const r of records) {
      // a responder that sent only the PTR: ask for that instance's TXT, a bounded few
      if (r && r.type === "PTR" && under(r.data) && !hasTxt.has(r.data) && !asked.has(r.data)
        && asked.size < 16) {
        asked.add(r.data);
        try { mdns.query({ questions: [{ name: r.data, type: "TXT" }] }); } catch { /* next tick */ }
      }
    }
    for (const r of records) {
      if (!r || r.type !== "TXT" || !under(r.name)) continue;
      const label = r.name.slice(0, r.name.length - suffix.length);
      const out = book.offer(r.data, { label, source: rinfo && rinfo.address });
      if (out === "added" || out === "conflict") changed = true;
    }
    if (changed) onChange(book.list());
  };
  const query = () => {
    asked = new Set();
    try { mdns.query({ questions: [{ name: `${SERVICE_TYPE}.local`, type: "PTR" }] }); } catch { /* next tick */ }
  };
  mdns.on("response", onResponse);
  query();
  const timer = si(query, queryEveryMs);
  return function stop() {
    ci(timer);
    try { mdns.removeListener("response", onResponse); } catch { /* gone */ }
  };
}

module.exports = {
  ADVERT_VERSION, APPROVE_PAGE, CandidateBook, DEVICE_CLASSES, FORBIDDEN_KEYS, MAX_LABEL,
  MAX_WINDOW_MS, MEMBER_SERVICE_TYPE, RID_RE, SERVICE_TYPE, approveUrl, browse, cleanLabel, parseTxt,
};
