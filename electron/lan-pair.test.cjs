"use strict";

// lan-pair.cjs + nearby-devices.cjs: the advert contract (same cases as awdk
// tests/test_lan_pair.py), the flood-proof book, the mDNS browse and the window's IPC.

const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");

const lp = require("./lan-pair.cjs");
const { createNearbySession, createNearbyDevices } = require("./nearby-devices.cjs");

const RID = "0f1e2d3c4b5a69788796a5b4c3d2e1f0";
const txt = (over = {}) => {
  const t = { v: "1", rid: RID, class: "watch", ...over };
  for (const k of Object.keys(t)) if (t[k] === null) delete t[k];
  return t;
};
const rid = (i) => i.toString(16).padStart(32, "0");
const clock = () => { const c = { t: 1_000_000 }; c.now = () => c.t; return c; };

test("parseTxt accepts the contract from an object or multicast-dns Buffers", () => {
  assert.deepEqual(lp.parseTxt(txt()), { v: "1", rid: RID, class: "watch" });
  assert.deepEqual(lp.parseTxt([Buffer.from("V=1"), Buffer.from(`RID=${RID}`), Buffer.from("Class=PHONE")]),
    { v: "1", rid: RID, class: "phone" });
  assert.deepEqual(lp.parseTxt(txt({ owner: "mallory", url: "http://evil" })), { v: "1", rid: RID, class: "watch" });
});

test("parseTxt drops an advert that carries any secret-shaped key, in any case", () => {
  for (const k of lp.FORBIDDEN_KEYS) {
    assert.equal(lp.parseTxt(txt({ [k]: "123456" })), null, k);
    assert.equal(lp.parseTxt([`v=1`, `rid=${RID}`, "class=watch", `${k.toUpperCase()}=1`]), null, k);
  }
});

test("parseTxt drops off-contract and oversized adverts", () => {
  for (const bad of [txt({ v: "2" }), txt({ v: null }), txt({ rid: "short" }), txt({ rid: "a".repeat(33) }), txt({ rid: RID.toUpperCase() }),
    txt({ rid: "Zx9_kq-3Lm0pQrStUvWxZx9_kq-3Lm0p" }), txt({ class: "spark" }), txt({ class: "tablet" }),
    txt({ rid: null }), txt({ class: "toaster" }), txt({ class: null }), txt({ junk: "x".repeat(65) }),
    { ...txt(), k0: "", k1: "", k2: "", k3: "", k4: "", k5: "" },
    txt(Object.fromEntries("abcde".split("").map((c) => [c.repeat(30), "x".repeat(64)]))),
    ["v=1", `rid=${RID}`, `RID=${rid(1)}`, "class=watch"], "v=1", null, 7]) {
    assert.equal(lp.parseTxt(bad), null, JSON.stringify(bad));
  }
});

test("cleanLabel strips controls and bidi overrides, one line, capped", () => {
  assert.equal(lp.cleanLabel("Kid‮enohp\n\x07's   Watch"), "Kidenohp's Watch");
  assert.equal(lp.cleanLabel("x".repeat(100)).length, lp.MAX_LABEL);
  assert.equal(lp.cleanLabel(Buffer.from("Den TV")), "Den TV");
});

test("approveUrl only for an on-contract rid, on the Phase-1 page", () => {
  assert.equal(lp.approveUrl(RID), `https://app.aitherium.com/?app=control&nearby=${RID}`);
  assert.equal(lp.approveUrl("../../evil"), null);
  assert.equal(lp.approveUrl(`${RID}&next=https://evil`), null);
});

test("book: add, refresh keeps the first label, list is unverified", () => {
  const c = clock();
  const b = new lp.CandidateBook({ now: c.now });
  assert.equal(b.offer(txt(), { label: "Pixel\u0000 Watch", source: "10.0.0.5" }), "added");
  c.t += 10_000;
  assert.equal(b.offer(txt(), { label: "renamed", source: "10.0.0.5" }), "refreshed");
  assert.deepEqual(b.list(), [{ rid: RID, class: "watch", label: "Pixel Watch", verified: false }]);
});

test("book: a refresh never extends the 5-minute window; an expired rid stays gone", () => {
  const c = clock();
  const b = new lp.CandidateBook({ now: c.now });
  b.offer(txt(), { source: "a" });
  for (let i = 0; i < 10; i++) { c.t += 31_000; b.offer(txt(), { source: "a" }); }
  assert.deepEqual(b.list(), []);
  assert.equal(b.offer(txt(), { source: "a" }), "banned");
});

test("book: one rid from two hosts is a replay: dropped and banned for a window", () => {
  const c = clock();
  const b = new lp.CandidateBook({ now: c.now });
  assert.equal(b.offer(txt(), { source: "10.0.0.5" }), "added");
  assert.equal(b.offer(txt(), { source: "10.0.0.66" }), "conflict");
  assert.deepEqual(b.list(), []);
  assert.equal(b.offer(txt(), { source: "10.0.0.5" }), "banned");
  assert.equal(new lp.CandidateBook({ now: c.now }).offer(txt(), { source: "a" }), "added");
  const f = new lp.CandidateBook({ now: c.now });
  f.offer(txt(), { source: "a" });
  assert.equal(f.offer(txt({ class: "laptop" }), { source: "a" }), "conflict");
  c.t += 301_000;
  assert.equal(b.offer(txt(), { source: "10.0.0.5" }), "added");
});

test("book: per-host cap, total cap, and the rate limit", () => {
  const c = clock();
  const b = new lp.CandidateBook({ now: c.now, maxPerSource: 2 });
  assert.deepEqual([0, 1, 2].map((i) => b.offer(txt({ rid: rid(i) }), { source: "evil" })),
    ["added", "added", "source-cap"]);
  assert.equal(b.offer(txt({ rid: rid(9) }), { source: "other" }), "added");
  const t = new lp.CandidateBook({ now: c.now, maxCandidates: 3, maxPerSource: 99 });
  assert.deepEqual([0, 1, 2, 3].map((i) => t.offer(txt({ rid: rid(i) }), { source: `s${i}` })),
    ["added", "added", "added", "full"]);
  const r = new lp.CandidateBook({ now: c.now, burst: 5, refillPerSec: 1, maxPerSource: 99, maxCandidates: 99 });
  const outs = [...Array(8).keys()].map((i) => r.offer(txt({ rid: rid(i) }), { source: `s${i}` }));
  assert.equal(outs.filter((o) => o === "flood").length, 3);
  assert.equal(r.dropped, 3);
  c.t += 2000;
  assert.equal(r.offer(txt({ rid: rid(50) }), { source: "s50" }), "added");
});

function fakeMdns() {
  const m = new EventEmitter();
  m.queries = [];
  m.query = (q) => m.queries.push(q);
  m.destroyed = false;
  m.destroy = () => { m.destroyed = true; };
  return m;
}
const timers = () => {
  const t = { intervals: [], timeouts: [] };
  t.setInterval = (fn, ms) => { t.intervals.push({ fn, ms }); return t.intervals.length; };
  t.clearInterval = (id) => { t.intervals[id - 1].cleared = true; };
  t.setTimeout = (fn, ms) => { t.timeouts.push({ fn, ms }); return t.timeouts.length; };
  t.clearTimeout = (id) => { t.timeouts[id - 1].cleared = true; };
  return t;
};
const NAME = `Kid Watch._aither-pair._tcp.local`;

test("browse: reads only TXT under _aither-pair._tcp, asks for a missing TXT, never A/AAAA", () => {
  const m = fakeMdns();
  const tm = timers();
  const b = new lp.CandidateBook();
  const seen = [];
  const stop = lp.browse(m, b, { onChange: (l) => seen.push(l), ...tm });
  assert.deepEqual(m.queries[0], { questions: [{ name: "_aither-pair._tcp.local", type: "PTR" }] });
  m.emit("response", { answers: [{ type: "PTR", name: "_aither-pair._tcp.local", data: NAME }] }, { address: "10.0.0.5" });
  assert.deepEqual(m.queries[1], { questions: [{ name: NAME, type: "TXT" }] });
  m.emit("response", { answers: [
    { type: "TXT", name: NAME, data: [Buffer.from("v=1"), Buffer.from(`rid=${RID}`), Buffer.from("class=watch")] },
    { type: "TXT", name: "Printer._ipp._tcp.local", data: [Buffer.from("v=1"), Buffer.from(`rid=${rid(2)}`), Buffer.from("class=phone")] },
  ] }, { address: "10.0.0.5" });
  assert.deepEqual(seen.at(-1), [{ rid: RID, class: "watch", label: "Kid Watch", verified: false }]);
  assert.ok(m.queries.every((q) => q.questions.every((x) => x.type === "PTR" || x.type === "TXT")));
  stop();
  assert.equal(m.listenerCount("response"), 0);
  assert.equal(tm.intervals[0].cleared, true);
});

test("browse: a packet with more than 64 records is ignored whole; TXT follow-ups are bounded", () => {
  const m = fakeMdns();
  const b = new lp.CandidateBook();
  lp.browse(m, b, timers());
  const flood = [...Array(65).keys()].map((i) => ({ type: "TXT", name: `d${i}._aither-pair._tcp.local`,
    data: [`v=1`, `rid=${rid(i)}`, "class=phone"] }));
  m.emit("response", { answers: flood }, { address: "10.0.0.9" });
  assert.deepEqual(b.list(), []);
  const ptrs = [...Array(40).keys()].map((i) => ({ type: "PTR", name: "_aither-pair._tcp.local",
    data: `d${i}._aither-pair._tcp.local` }));
  m.emit("response", { answers: ptrs }, { address: "10.0.0.9" });
  assert.equal(m.queries.length, 1 + 16);
});

test("session: listens at most 5 minutes, then stops and closes the socket", () => {
  const m = fakeMdns();
  const tm = timers();
  const c = clock();
  const s = createNearbySession({ mdnsFactory: () => m, now: c.now, windowMs: 60 * 60 * 1000,
    setTimeout: tm.setTimeout, clearTimeout: tm.clearTimeout,
    browse: (mdns, book, opts) => lp.browse(mdns, book, { ...opts, ...tm }) });
  const r = s.start();
  assert.equal(r.listening, true);
  assert.equal(r.until - c.t, lp.MAX_WINDOW_MS);
  assert.equal(tm.timeouts[0].ms, lp.MAX_WINDOW_MS);
  tm.timeouts[0].fn();
  assert.equal(m.destroyed, true);
  assert.equal(s.state().listening, false);
});

test("session: approval only for a rid listed right now", () => {
  const m = fakeMdns();
  const c = clock();
  const s = createNearbySession({ mdnsFactory: () => m, now: c.now, ...timers(),
    browse: (mdns, book, opts) => lp.browse(mdns, book, { ...opts, ...timers() }) });
  s.start();
  m.emit("response", { answers: [{ type: "TXT", name: NAME, data: [`v=1`, `rid=${RID}`, "class=watch"] }] },
    { address: "10.0.0.5" });
  assert.equal(s.approval(RID), lp.approveUrl(RID));
  assert.equal(s.approval(rid(7)), null);
  assert.equal(s.approval({ toString: () => RID }), null);
  c.t += lp.MAX_WINDOW_MS + 1;
  assert.equal(s.approval(RID), null);
});

test("session: no mDNS module means not listening, never a throw", () => {
  const s = createNearbySession({ mdnsFactory: () => { throw new Error("missing"); }, ...timers() });
  assert.deepEqual(s.start(), { listening: false, error: "mdns-unavailable" });
});

test("window IPC: only this window may ask; only a listed rid opens the browser", async () => {
  const handlers = {};
  const ipcMain = { handle: (ch, fn) => { handlers[ch] = fn; } };
  const opened = [];
  const shell = { openExternal: async (u) => { opened.push(u); } };
  class Win extends EventEmitter {
    constructor() { super(); this.webContents = { send() {} }; }
    isDestroyed() { return false; }
    loadFile() {}
    show() {}
    focus() {}
  }
  const session = { start: () => ({ listening: true }), state: () => ({}), stop() {},
    approval: (r) => (r === RID ? lp.approveUrl(r) : null) };
  const nd = createNearbyDevices({ BrowserWindow: Win, ipcMain, shell, sessionFactory: () => session });
  const win = nd.open();
  const me = { sender: win.webContents };
  const other = { sender: {} };
  assert.equal(await handlers["nearby:approve"](other, RID).ok, false);
  assert.equal(handlers["nearby:start"](other), null);
  assert.deepEqual(handlers["nearby:approve"](me, rid(3)), { ok: false, reason: "gone" });
  assert.deepEqual(handlers["nearby:approve"](me, RID), { ok: true });
  assert.deepEqual(opened, [lp.approveUrl(RID)]);
});
