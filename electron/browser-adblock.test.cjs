"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const ab = require("./browser-adblock.cjs");

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "awdesk-adblock-"));

test("hosts files: blocking lines only, no IPs, no localhost", () => {
  const set = ab.parseHosts([
    "# comment", "127.0.0.1 localhost", "0.0.0.0 0.0.0.0", "0.0.0.0 ads.example.com # trailing",
    "0.0.0.0 track.example.net another.example.org", "1.2.3.4 notblocked.example.com", "",
  ].join("\r\n"));
  assert.deepEqual([...set].sort(), ["ads.example.com", "another.example.org", "track.example.net"]);
});

test("ABP lists: plain host rules and exceptions; path and cosmetic rules skipped", () => {
  const { block, allow } = ab.parseAbp([
    "! title", "||ads.test^", "||tracker.test^$third-party", "||cdn.test/ads/*", "##.ad-box",
    "@@||good.ads.test^", "||x.test^$script", "/banner/*",
  ].join("\n"));
  assert.deepEqual([...block].sort(), ["ads.test", "tracker.test"]);
  assert.deepEqual([...allow], ["good.ads.test"]);
});

test("a listed parent domain matches its subdomains, never a bare TLD", () => {
  const set = new Set(["ads.test"]);
  assert.equal(ab.matches(set, "a.b.ads.test"), true);
  assert.equal(ab.matches(set, "ads.test"), true);
  assert.equal(ab.matches(set, "notads.test"), false);
  assert.equal(ab.matches(new Set(["test"]), "a.test"), false);
});

test("site grouping understands co.uk-style suffixes", () => {
  assert.equal(ab.siteOf("www.bbc.co.uk"), "bbc.co.uk");
  assert.equal(ab.siteOf("a.b.example.com"), "example.com");
  assert.equal(ab.siteOf("example.com"), "example.com");
});

test("the seed blocks third-party ads before any download, never the page itself", () => {
  const b = ab.createAdblock({ dir: tmp(), fetchImpl: null });
  b.loadCached();
  const page = "https://news.test/story";
  assert.equal(b.shouldBlock({ url: "https://securepubads.g.doubleclick.net/x.js", resourceType: "script", pageUrl: page }), true);
  assert.equal(b.shouldBlock({ url: "https://www.doubleclick.net/", resourceType: "mainFrame", pageUrl: "" }), false);
  assert.equal(b.shouldBlock({ url: "https://cdn.news.test/app.js", resourceType: "script", pageUrl: page }), false);
});

test("first-party requests are left alone even when the host is listed", () => {
  const b = ab.createAdblock({ dir: tmp(), fetchImpl: null });
  b.loadCached();
  assert.equal(b.shouldBlock({ url: "https://stats.doubleclick.net/x", resourceType: "xhr", pageUrl: "https://www.doubleclick.net/" }), false);
});

test("off for a site, or off entirely, persists across restarts", () => {
  const dir = tmp();
  const b = ab.createAdblock({ dir, fetchImpl: null });
  b.loadCached();
  const req = { url: "https://ads.criteo.com/x", resourceType: "image", pageUrl: "https://shop.example.co.uk/item" };
  assert.equal(b.shouldBlock(req), true);
  b.setSiteOff("https://www.example.co.uk/", true);
  const again = ab.createAdblock({ dir, fetchImpl: null });
  again.loadCached();
  assert.equal(again.shouldBlock(req), false);
  again.setSiteOff(req.pageUrl, false);
  assert.equal(again.shouldBlock(req), true);
  again.setEnabled(false);
  assert.equal(ab.createAdblock({ dir, fetchImpl: null }).shouldBlock(req), false);
});

test("refresh downloads the lists, keeps going when one fails, and exceptions win", async () => {
  const dir = tmp();
  const bodies = {
    stevenblack: `0.0.0.0 bad.example\n${"# pad\n".repeat(300)}`,
    easylist: `||ads.example^\n@@||ok.ads.example^\n${"! pad\n".repeat(300)}`,
  };
  const fetchImpl = async (url) => {
    const id = ab.LISTS.find((l) => l.url === url).id;
    if (!bodies[id]) return { ok: false, status: 503 };
    return { ok: true, status: 200, text: async () => bodies[id] };
  };
  const b = ab.createAdblock({ dir, fetchImpl });
  b.loadCached();
  const r = await b.refresh({ force: true });
  assert.equal(r.ok, true);
  assert.equal(r.errors.length, 1);
  const page = "https://site.test/";
  assert.equal(b.shouldBlock({ url: "https://x.bad.example/a", resourceType: "image", pageUrl: page }), true);
  assert.equal(b.shouldBlock({ url: "https://ads.example/a", resourceType: "image", pageUrl: page }), true);
  assert.equal(b.shouldBlock({ url: "https://ok.ads.example/a", resourceType: "image", pageUrl: page }), false);
  // The cache is reused without a network on the next start.
  const cold = ab.createAdblock({ dir, fetchImpl: null });
  cold.loadCached();
  assert.equal(cold.shouldBlock({ url: "https://bad.example/a", resourceType: "image", pageUrl: page }), true);
  assert.deepEqual(await cold.refresh(), { ok: true, fresh: true, hosts: cold.hostCount() });
});

test("attach cancels through the session hook and counts per page", () => {
  const b = ab.createAdblock({ dir: tmp(), fetchImpl: null });
  b.loadCached();
  let handler = null;
  const ses = { webRequest: { onBeforeRequest: (_f, fn) => { handler = fn; } } };
  assert.equal(b.attach(ses), true);
  const wc = { getURL: () => "https://news.test/" };
  let answer = null;
  handler({ url: "https://ad.doubleclick.net/x", resourceType: "script", webContents: wc, webContentsId: 7 }, (a) => { answer = a; });
  assert.deepEqual(answer, { cancel: true });
  handler({ url: "https://news.test/a.js", resourceType: "script", webContents: wc, webContentsId: 7 }, (a) => { answer = a; });
  assert.deepEqual(answer, { cancel: false });
  assert.equal(b.blockedOn(7), 1);
});
