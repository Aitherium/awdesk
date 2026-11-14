"use strict";

/**
 * browser-sync tests -- the merge, the wire shape, and two simulated devices syncing
 * through a local stand-in for the platform's preferences store (browser-sync-fake.cjs).
 *
 *   node --test electron/browser-sync.test.cjs
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const sync = require("./browser-sync.cjs");
const { createLibrary } = require("./browser-library.cjs");
const { startFakeStore, NAMESPACE_BYTES, jsonSize } = require("./browser-sync-fake.cjs");

const clock = { t: 1_800_000_000_000 };
const tick = (ms = 1000) => { clock.t += ms; return clock.t; };

/** One simulated computer: its own profile folder, library, tab list and sync. */
function device(store, name, { token = "test-token" } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `awdesk-sync-${name}-`));
  const d = { dir, name, tabs: [], token, calls: 0 };
  d.library = createLibrary({ file: path.join(dir, "browser-library.json"), now: () => clock.t });
  d.make = () => sync.createBrowserSync({
    file: path.join(dir, "browser-sync.json"), library: d.library, tabs: () => d.tabs, deviceName: name, now: () => clock.t,
    transport: sync.createPrefsTransport({ origin: () => store.origin, token: () => d.token,
      fetchImpl: (url, init) => { d.calls += 1; return fetch(url, init); } }),
  });
  d.sync = d.make();
  return d;
}
const urls = (list) => list.map((e) => e.url).sort();
const stored = (store, user = "owner") => JSON.stringify((store.users.get(user) || { prefs: {} }).prefs);

test("only plain web addresses may leave the computer", () => {
  assert.equal(sync.syncable("https://a.test/x?q=1"), true);
  for (const url of ["", "about:blank", "file:///C:/x", "aither://settings", "https://u:p@a.test/", "https://a.test/cb?code=abc",
    "https://a.test/#access_token=abc", "https://a.test/?api_key=1", "https://a.test/?next=ftp://u:p@h/", `https://a.test/${"x".repeat(700)}`]) {
    assert.equal(sync.syncable(url), false, url);
  }
});

test("merge is per item, last writer wins, and the order does not matter", () => {
  const id = sync.itemId("https://a.test/");
  const a = { ...sync.emptyDoc("aaaaaaaa"), bookmarks: { [id]: { url: "https://a.test/", title: "A", at: 10 } },
    history: { [id]: { url: "https://a.test/", title: "A", at: 10, count: 3 } } };
  const b = { ...sync.emptyDoc("bbbbbbbb"), bookmarks: { [id]: { at: 20, deleted: true } },
    history: { [id]: { url: "https://a.test/", title: "A2", at: 30, count: 1 } } };
  const ab = sync.merge(a, b);
  const ba = sync.merge(b, a);
  assert.deepEqual(ab.bookmarks, ba.bookmarks);
  assert.deepEqual(ab.history, ba.history);
  assert.equal(ab.bookmarks[id].deleted, true, "the later delete beats the older bookmark");
  assert.deepEqual(ab.history[id], { url: "https://a.test/", title: "A2", at: 30, count: 3 });
  assert.deepEqual(sync.merge(ab, b).bookmarks, ab.bookmarks, "merging again changes nothing");
  // A re-add after the delete wins; an equal time keeps the delete on both sides.
  const c = { ...sync.emptyDoc(), bookmarks: { [id]: { url: "https://a.test/", title: "A", at: 25 } } };
  assert.equal(sync.merge(ab, c).bookmarks[id].url, "https://a.test/");
  const tie = { ...sync.emptyDoc(), bookmarks: { [id]: { url: "https://a.test/", title: "A", at: 20 } } };
  assert.equal(sync.merge(tie, b).bookmarks[id].deleted, true);
  assert.equal(sync.merge(b, tie).bookmarks[id].deleted, true);
});

test("old tombstones, long-gone devices and history past the cap or a clear are dropped", () => {
  const now = 1000 * 24 * 3600 * 1000;
  const doc = sync.emptyDoc();
  doc.bookmarks.old = { at: now - sync.TOMBSTONE_TTL_MS - 1, deleted: true };
  doc.bookmarks.fresh = { at: now - 5, deleted: true };
  doc.openTabs.aaaaaaaa = { name: "gone", tabs: [], at: 1 };
  doc.openTabs.bbbbbbbb = { name: "here", tabs: [], at: now - 5 };
  for (let i = 0; i < sync.MAX_HISTORY + 20; i += 1) doc.history[`h${i}`] = { url: `https://a.test/${i}`, title: "", at: 100 + i, count: 1 };
  doc.historyClearedAt = 110;
  const out = sync.compact(doc, now);
  assert.deepEqual(Object.keys(out.bookmarks), ["fresh"]);
  assert.deepEqual(Object.keys(out.openTabs), ["bbbbbbbb"]);
  assert.equal(Object.keys(out.history).length, sync.MAX_HISTORY);
  assert.ok(Object.values(out.history).every((h) => h.at > 110));
});

test("the wire form round-trips, stays under the store's namespace size, and counts what did not fit", () => {
  const doc = sync.emptyDoc("aaaaaaaa");
  for (let i = 0; i < 700; i += 1) {
    const url = `https://example-${i}.test/some/quite/long/path/that/a/real/bookmark/has?page=${i}`;
    doc.bookmarks[sync.itemId(url)] = { url, title: `Bookmark number ${i} \u00e9\u00e8 \u65e5\u672c`, at: 1000 + i };
  }
  doc.bookmarks[sync.itemId("https://gone.test/")] = { at: 5000, deleted: true };
  doc.openTabs.aaaaaaaa = { name: "PC", at: 9, tabs: [{ url: "https://t.test/", title: "T" }] };
  doc.historyClearedAt = 7;
  const { namespaces, unsynced } = sync.encode(doc);
  for (const [name, value] of Object.entries(namespaces)) assert.ok(jsonSize(value) <= NAMESPACE_BYTES, `${name} is ${jsonSize(value)} bytes`);
  assert.ok(unsynced > 0, "700 long bookmarks do not all fit");
  const back = sync.decode(namespaces);
  assert.equal(Object.values(back.bookmarks).filter((b) => !b.deleted).length, 700 - unsynced);
  assert.deepEqual(back.openTabs, doc.openTabs);
  assert.equal(back.historyClearedAt, 7);
  // The newest bookmarks are the ones kept.
  assert.ok(back.bookmarks[sync.itemId("https://example-699.test/some/quite/long/path/that/a/real/bookmark/has?page=699")]);
  // A small document loses nothing and decodes to itself.
  const small = sync.emptyDoc();
  small.bookmarks[sync.itemId("https://a.test/")] = { url: "https://a.test/", title: "A", at: 3 };
  small.history[sync.itemId("https://h.test/")] = { url: "https://h.test/", title: "H", at: 4, count: 2 };
  const enc = sync.encode(small);
  assert.equal(enc.unsynced, 0);
  assert.deepEqual(sync.decode(enc.namespaces).bookmarks, small.bookmarks);
  assert.deepEqual(sync.decode(enc.namespaces).history, small.history);
});

test("decode ignores what another writer could have put there", () => {
  const good = sync.itemId("https://a.test/");
  const doc = sync.decode({
    awbrowser_bm0: { [good]: { u: "https://a.test/", t: "A", m: 1 }, wrongid: { u: "https://b.test/", t: "B", m: 1 },
      x1: { u: "javascript:alert(1)", m: 1 }, x2: "text", x3: { u: "https://c.test/" } },
    awbrowser_dev_zzzz: { n: "bad id", m: 1, tabs: [] },
    awbrowser_dev_abcdef12: { n: "Phone", m: 5, tabs: [{ u: "file:///etc/passwd", t: "x" }, { u: "https://ok.test/", t: "ok" }] },
    awdesk: { anything: 1 },
  });
  assert.deepEqual(Object.keys(doc.bookmarks), [good]);
  assert.deepEqual(doc.openTabs, { abcdef12: { name: "Phone", at: 5, tabs: [{ url: "https://ok.test/", title: "ok" }] } });
});

test("a patch carries only what changed, and null for what is gone", () => {
  const remote = { awbrowser_bm0: { a: { u: "1", m: 1 }, b: { u: "2", m: 1 } }, awbrowser_dev_aaaaaaaa: { n: "x", m: 1 } };
  const want = { awbrowser_bm0: { a: { u: "1", m: 1 }, c: { u: "3", m: 2 } } };
  assert.deepEqual(sync.diff(remote, want), { awbrowser_bm0: { b: null, c: { u: "3", m: 2 } }, awbrowser_dev_aaaaaaaa: { n: null, m: null } });
  assert.deepEqual(sync.diff(want, want), {});
  // The store merges objects: a tombstone must name the bookmark's fields to remove.
  assert.deepEqual(sync.diff({ awbrowser_bm0: { a: { u: "1", t: "x", m: 1 } } }, { awbrowser_bm0: { a: { m: 2, d: 1 } } }),
    { awbrowser_bm0: { a: { u: null, t: null, m: 2, d: 1 } } });
});

test("the bearer only goes to https or loopback", () => {
  assert.equal(sync.safeOrigin("https://app.aitherium.com/x"), "https://app.aitherium.com");
  assert.equal(sync.safeOrigin("http://127.0.0.1:8080/"), "http://127.0.0.1:8080");
  assert.equal(sync.safeOrigin("http://app.aitherium.com/"), null);
  assert.equal(sync.safeOrigin("nonsense"), null);
});

test("sync is off until the owner turns it on, and off sends nothing", async () => {
  const store = await startFakeStore();
  try {
    const a = device(store, "A");
    a.library.toggleBookmark("https://a.test/", "A");
    assert.equal(a.sync.enabled(), false);
    assert.deepEqual(await a.sync.syncNow(), { ok: false, reason: "off" });
    a.sync.touch();
    a.sync.start();
    assert.equal(a.calls, 0);
    assert.equal(store.stats.gets, 0);
    assert.equal(a.sync.status().state, "off");
    assert.deepEqual(a.sync.otherDevices(), []);
  } finally { await store.close(); }
});

test("signed out: no request is made and the status says so", async () => {
  const store = await startFakeStore();
  try {
    const a = device(store, "A", { token: null });
    const st = await a.sync.setEnabled(true);
    a.sync.stop();
    assert.equal(st.state, "signed-out");
    assert.equal(a.calls, 0);
    assert.equal(sync.statusLine(st), "Sign in to AitherOS to sync");
    // A bearer the platform refuses reads the same way.
    a.token = "expired";
    assert.equal((await a.sync.syncNow()).signedOut, true);
    assert.equal(a.sync.status().state, "signed-out");
  } finally { await store.close(); }
});

test("two devices: bookmarks, history and open tabs arrive; a delete stays deleted; private things never leave", async () => {
  const store = await startFakeStore();
  try {
    const a = device(store, "Desk PC");
    const b = device(store, "Laptop");
    a.library.toggleBookmark("https://keep.test/", "Keep");
    tick();
    a.library.toggleBookmark("https://drop.test/", "Drop");
    a.library.toggleBookmark("https://intranet.test/?token=SECRETVALUE", "Secret link");
    tick();
    a.library.visit("https://news.test/story", "Story", "you");
    a.library.visit("https://agent-only.test/", "Agent", "agent");
    a.library.visit("https://sso.test/cb?code=SECRETVALUE", "Callback", "you");
    a.tabs = [
      { by: "you", kind: "web", url: "https://news.test/story", title: "Story" },
      { by: "you", kind: "web", private: true, url: "https://private.test/", title: "Private" },
      { by: "agent", kind: "web", url: "https://agent-tab.test/", title: "Agent tab" },
      { by: "you", kind: "internal", url: "aither://settings", title: "Settings" },
    ];
    tick();
    await a.sync.setEnabled(true);
    a.sync.stop();
    assert.equal(a.sync.status().state, "ok");
    assert.equal(a.sync.status().unsynced, 2, "the two secret-looking links are counted, not sent");

    const text = stored(store);
    for (const never of ["private.test", "agent-tab.test", "agent-only.test", "SECRETVALUE", "aither://"]) {
      assert.ok(!text.includes(never), `${never} reached the store`);
    }

    tick();
    b.library.toggleBookmark("https://laptop.test/", "Laptop's own");
    b.tabs = [{ by: "you", kind: "web", url: "https://laptop-tab.test/", title: "On the laptop" }];
    await b.sync.setEnabled(true);
    b.sync.stop();
    assert.deepEqual(urls(b.library.bookmarks()), ["https://drop.test/", "https://keep.test/", "https://laptop.test/"]);
    assert.ok(b.library.history(50).some((h) => h.url === "https://news.test/story" && h.by === "you"));
    assert.ok(!b.library.history(50).some((h) => h.url.includes("agent-only")));
    const fromA = b.sync.otherDevices();
    assert.equal(fromA.length, 1);
    assert.equal(fromA[0].name, "Desk PC");
    assert.deepEqual(fromA[0].tabs, [{ url: "https://news.test/story", title: "Story" }]);

    // The laptop deletes a bookmark; the desk PC loses it and never sends it back.
    tick();
    b.library.toggleBookmark("https://drop.test/");
    assert.equal((await b.sync.syncNow()).ok, true);
    tick();
    assert.equal((await a.sync.syncNow()).ok, true);
    assert.deepEqual(urls(a.library.bookmarks()), ["https://intranet.test/?token=SECRETVALUE", "https://keep.test/", "https://laptop.test/"]);
    assert.deepEqual(a.sync.otherDevices()[0].tabs, [{ url: "https://laptop-tab.test/", title: "On the laptop" }]);
    tick();
    await a.sync.syncNow();
    await b.sync.syncNow();
    assert.ok(!urls(b.library.bookmarks()).includes("https://drop.test/"), "a deleted bookmark came back");
    assert.ok(!urls(a.library.bookmarks()).includes("https://drop.test/"));

    // A third sync with nothing new writes nothing.
    const puts = store.stats.puts;
    await a.sync.syncNow();
    await b.sync.syncNow();
    assert.equal(store.stats.puts, puts, "an unchanged browser still wrote to the store");

    // Added again later, on purpose: it is back everywhere.
    tick();
    a.library.toggleBookmark("https://drop.test/", "Drop, again");
    await a.sync.syncNow();
    tick();
    await b.sync.syncNow();
    assert.ok(urls(b.library.bookmarks()).includes("https://drop.test/"));

  } finally { await store.close(); }
});

test("another account's sync is its own document", async () => {
  const store = await startFakeStore({ tokens: { "test-token": "owner", "t2": "jason" } });
  try {
    const a = device(store, "A");
    const j = device(store, "J", { token: "t2" });
    a.library.toggleBookmark("https://mine.test/", "Mine");
    await a.sync.setEnabled(true);
    await j.sync.setEnabled(true);
    a.sync.stop();
    j.sync.stop();
    assert.deepEqual(j.library.bookmarks(), []);
    assert.deepEqual(j.sync.otherDevices(), []);
    assert.ok(!stored(store, "jason").includes("mine.test"));
  } finally { await store.close(); }
});

test("a write that lost the race is retried on the newer store, and both changes survive", async () => {
  const store = await startFakeStore();
  try {
    const a = device(store, "A");
    const b = device(store, "B");
    await a.sync.setEnabled(true);
    await b.sync.setEnabled(true);
    a.sync.stop();
    b.sync.stop();
    tick();
    b.library.toggleBookmark("https://from-b.test/", "B");
    a.library.toggleBookmark("https://from-a.test/", "A");
    // B writes between A's pull and A's push: A's first push must be refused.
    const realFetch = globalThis.fetch;
    let raced = false;
    const racing = sync.createBrowserSync({
      file: path.join(a.dir, "browser-sync.json"), library: a.library, tabs: () => [], deviceName: "A", now: () => clock.t,
      transport: sync.createPrefsTransport({ origin: () => store.origin, token: () => "test-token",
        fetchImpl: async (url, init) => {
          if (init.method === "PUT" && !raced) { raced = true; await b.sync.syncNow(); }
          return realFetch(url, init);
        } }),
    });
    const r = await racing.syncNow();
    assert.equal(r.ok, true);
    assert.equal(store.stats.conflicts, 1);
    assert.deepEqual(urls(a.library.bookmarks()), ["https://from-a.test/", "https://from-b.test/"]);
    tick();
    await b.sync.syncNow();
    assert.deepEqual(urls(b.library.bookmarks()), ["https://from-a.test/", "https://from-b.test/"]);
  } finally { await store.close(); }
});

test("a store outage is a shown error, the library is untouched, and the next sync recovers", async () => {
  const store = await startFakeStore();
  try {
    const a = device(store, "A");
    a.library.toggleBookmark("https://a.test/", "A");
    await a.sync.setEnabled(true);
    a.sync.stop();
    tick();
    a.library.toggleBookmark("https://b.test/", "B");
    store.failNext(502);
    const r = await a.sync.syncNow();
    assert.equal(r.ok, false);
    assert.equal(a.sync.status().state, "error");
    assert.match(sync.statusLine(a.sync.status(), clock.t), /Last sync failed: the store answered 502/);
    assert.equal(a.library.bookmarks().length, 2);
    assert.equal((await a.sync.syncNow()).ok, true);
    assert.ok(stored(store).includes("b.test"));
    // An unreachable store never throws.
    const dead = sync.createPrefsTransport({ origin: () => "http://127.0.0.1:9", token: () => "x", timeoutMs: 2000 });
    assert.equal((await dead.pull()).ok, false);
    assert.equal((await sync.createPrefsTransport({ origin: () => "http://evil.test", token: () => "x" }).pull()).reason, "no safe sync origin");
  } finally { await store.close(); }
});

test("turning sync off withdraws this device's tabs and leaves the library alone", async () => {
  const store = await startFakeStore();
  try {
    const a = device(store, "A");
    const b = device(store, "B");
    a.library.toggleBookmark("https://a.test/", "A");
    a.tabs = [{ by: "you", kind: "web", url: "https://tab-on-a.test/", title: "t" }];
    await a.sync.setEnabled(true);
    await b.sync.setEnabled(true);
    assert.equal(b.sync.otherDevices().length, 1);
    await a.sync.setEnabled(false);
    assert.ok(!stored(store).includes("tab-on-a.test"));
    assert.equal(a.library.bookmarks().length, 1);
    assert.equal(a.sync.status().state, "off");
    tick();
    await b.sync.syncNow();
    b.sync.stop();
    assert.deepEqual(b.sync.otherDevices(), []);
    assert.equal(b.library.bookmarks().length, 1, "turning sync off on A is not a delete");
    // The switch and the device id survive a restart.
    const again = b.make();
    assert.equal(again.enabled(), true);
    assert.equal(again.status().deviceId, b.sync.status().deviceId);
    assert.equal(a.make().enabled(), false);
  } finally { await store.close(); }
});

test("clearing history on one device clears it on the others", async () => {
  const store = await startFakeStore();
  try {
    const a = device(store, "A");
    const b = device(store, "B");
    a.library.visit("https://old.test/", "Old");
    await a.sync.setEnabled(true);
    await b.sync.setEnabled(true);
    a.sync.stop();
    b.sync.stop();
    assert.equal(b.library.history(10).length, 1);
    tick();
    a.library.clearHistory();
    a.sync.noteHistoryCleared();
    a.sync.stop();
    await a.sync.syncNow();
    tick();
    b.library.visit("https://new.test/", "New");
    await b.sync.syncNow();
    assert.deepEqual(urls(b.library.history(10)), ["https://new.test/"]);
    tick();
    await a.sync.syncNow();
    assert.deepEqual(urls(a.library.history(10)), ["https://new.test/"]);
  } finally { await store.close(); }
});

test("more bookmarks than the store holds: the newest sync, the rest stay here and are counted", async () => {
  const store = await startFakeStore();
  try {
    const a = device(store, "A");
    const entries = [];
    for (let i = 0; i < 480; i += 1) entries.push({ url: `https://site-${i}.test/a/long/enough/path/to/fill/the/store/quickly/${"p".repeat(60)}?n=${i}`, title: `Title ${i} ${"t".repeat(60)}`, at: clock.t + i });
    a.library.importEntries({ bookmarks: entries });
    tick(1000);
    const st = await a.sync.setEnabled(true);
    a.sync.stop();
    assert.equal(st.state, "ok", st.error);
    assert.ok(st.unsynced > 0);
    assert.equal(store.stats.refused, 0, "the store refused a write as too large");
    assert.equal(a.library.bookmarks().length, 480, "a bookmark that did not fit was dropped from this computer");
    assert.match(sync.statusLine(st, clock.t), /not synced/);
    const b = device(store, "B");
    await b.sync.setEnabled(true);
    b.sync.stop();
    assert.equal(b.library.bookmarks().length, 480 - st.unsynced);
    tick();
    await a.sync.syncNow();
    assert.equal(a.library.bookmarks().length, 480);
  } finally { await store.close(); }
});

test("the menu rows: the switch, the status, and the other devices' tabs", () => {
  const calls = [];
  const handlers = { toggle: (on) => calls.push(["toggle", on]), syncNow: () => calls.push(["now"]), open: (url) => calls.push(["open", url]) };
  const off = sync.menuItems({ enabled: false }, [], handlers);
  assert.equal(off[0].label, "Sync this browser");
  assert.equal(off[0].checked, false);
  assert.match(off[1].label, /^Off/);
  assert.equal(off[2].enabled, false);
  off[0].click({ checked: true });
  const now = 10 * 3600 * 1000;
  const on = sync.menuItems({ enabled: true, state: "ok", lastSyncAt: now - 5 * 60000, unsynced: 0 },
    [{ id: "abcdef12", name: "Pixel", at: now - 3600 * 1000, tabs: [{ url: "https://a.test/", title: "A page" }] }], handlers, { now });
  assert.equal(on[1].label, "Last synced 5 min ago");
  const devices = on.find((i) => i.label === "Tabs from other devices").submenu;
  assert.equal(devices[0].label, "Pixel (1 h ago)");
  devices[0].submenu[0].click();
  on[2].click();
  assert.deepEqual(calls, [["toggle", true], ["open", "https://a.test/"], ["now"]]);
  assert.ok(on.some((i) => /Passwords stay on this computer/.test(i.label)));
});
