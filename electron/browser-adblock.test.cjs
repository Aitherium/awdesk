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

test("ABP lists: plain host rules and their exceptions go to the host sets", () => {
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

// ---------------------------------------------------------------- path rules, hiding, tracking

/** A blocker over lists written to disk the way a download leaves them. */
function withLists({ easylist = "", easyprivacy = "", stevenblack = "" }) {
  const dir = tmp();
  if (easylist) fs.writeFileSync(path.join(dir, "adblock-easylist.txt"), easylist);
  if (easyprivacy) fs.writeFileSync(path.join(dir, "adblock-easyprivacy.txt"), easyprivacy);
  if (stevenblack) fs.writeFileSync(path.join(dir, "adblock-stevenblack.txt"), stevenblack);
  const b = ab.createAdblock({ dir, fetchImpl: null });
  b.loadCached();
  return b;
}

test("ABP lists sort into hosts, path rules and hiding rules; the rest is counted", () => {
  const p = ab.parseAbp(["||ads.test^", "||cdn.test/ads/*", "/banner/*$image", "@@||cdn.test/ads/ok.js$script", "##.ad_banner",
    "shop.test##.promo", "shop.test#?#div:has-text(Ad)", "||x.test^$csp=default-src 'none'", "/regex[0-9]+/"].join("\n"));
  assert.deepEqual([...p.block], ["ads.test"]);
  assert.equal(p.rules.length, 3);
  assert.equal(p.rules.filter((r) => r.exception).length, 1);
  assert.equal(p.cosmetic.length, 2);
  assert.equal(p.skipped, 3);
});

test("a path rule blocks an ad on the page's own host; the page's other files load", () => {
  const b = withLists({ easylist: "/ads/banners/*$image\n||news.test/sponsor/\n/track/pixel.$third-party\n" });
  const page = "https://news.test/story";
  assert.equal(b.shouldBlock({ url: "https://news.test/ads/banners/top.gif", resourceType: "image", pageUrl: page }), true);
  assert.equal(b.shouldBlock({ url: "https://news.test/ads/banners/top.js", resourceType: "script", pageUrl: page }), false, "$image only");
  assert.equal(b.shouldBlock({ url: "https://news.test/sponsor/box.js", resourceType: "script", pageUrl: page }), true);
  assert.equal(b.shouldBlock({ url: "https://news.test/app.js", resourceType: "script", pageUrl: page }), false);
  assert.equal(b.shouldBlock({ url: "https://news.test/track/pixel.gif", resourceType: "image", pageUrl: page }), false, "first party");
  assert.equal(b.shouldBlock({ url: "https://stats.test/track/pixel.gif", resourceType: "image", pageUrl: page }), true);
  assert.equal(b.shouldBlock({ url: "https://news.test/ads/banners/", resourceType: "mainFrame", pageUrl: "" }), false, "never the page");
  assert.equal(b.stats().rules, 3);
});

test("an exception always wins: over a path rule, and over a listed host", () => {
  const b = withLists({
    easylist: ["/adframe.", "@@||shop.test/adframe.html$subdocument", "||adhost.test^",
      "@@||adhost.test/player/ima3.js$script,domain=video.test", "@@||cdnok.test^"].join("\n"),
    stevenblack: "0.0.0.0 cdnok.test\n",
  });
  const req = (url, resourceType, pageUrl) => b.shouldBlock({ url, resourceType, pageUrl });
  assert.equal(req("https://x.test/adframe.html", "subFrame", "https://news.test/"), true);
  assert.equal(req("https://shop.test/adframe.html", "subFrame", "https://shop.test/"), false);
  assert.equal(req("https://adhost.test/player/ima3.js", "script", "https://news.test/"), true);
  assert.equal(req("https://adhost.test/player/ima3.js", "script", "https://www.video.test/watch"), false, "$domain= exception");
  assert.equal(req("https://adhost.test/player/other.js", "script", "https://www.video.test/watch"), true);
  assert.equal(req("https://cdnok.test/lib.js", "script", "https://news.test/"), false, "@@||host^ beats the hosts file");
});

test("pausing a site lets everything through there, path rules included", () => {
  const b = withLists({ easylist: "/ads/banners/*$image\n##.ad_banner\n" });
  const r = { url: "https://news.test/ads/banners/a.gif", resourceType: "image", pageUrl: "https://news.test/" };
  assert.equal(b.shouldBlock(r), true);
  assert.match(b.cssFor("https://news.test/"), /\.ad_banner/);
  b.setSiteOff("https://news.test/", true);
  assert.equal(b.shouldBlock(r), false);
  assert.equal(b.cssFor("https://news.test/"), "");
  assert.equal(b.shouldBlock({ ...r, url: "https://other.test/ads/banners/a.gif", pageUrl: "https://other.test/" }), true);
  b.setSiteOff("https://news.test/", false);
  assert.equal(b.shouldBlock(r), true);
});

test("a pause from an InPrivate tab is kept in memory: never on disk, never in ordinary tabs, gone with the last InPrivate tab", () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, "adblock-easylist.txt"), "[Adblock Plus 2.0]\n/ads/banners/*$image\n##.ad_banner\n");
  const b = ab.createAdblock({ dir, fetchImpl: null });
  b.loadCached();
  b.setEnabled(true); // the settings file exists, as it does on a used profile
  const file = path.join(dir, "adblock.json");
  const before = fs.readFileSync(file, "utf8");
  const page = "https://secret.test/";
  const r = { url: "https://secret.test/ads/banners/a.gif", resourceType: "image", pageUrl: page };

  assert.equal(b.setSiteOff(page, true, { private: true }), true);
  assert.equal(fs.readFileSync(file, "utf8"), before, "nothing is written");
  assert.equal(fs.readdirSync(dir).some((n) => fs.readFileSync(path.join(dir, n), "utf8").includes("secret.test")), false);
  assert.equal(b.siteOff(page, { private: true }), true);
  assert.equal(b.shouldBlock({ ...r, private: true }), false, "paused in InPrivate");
  assert.equal(b.cssFor(page, { private: true }), "");
  assert.equal(b.siteOff(page), false, "ordinary tabs do not learn of it");
  assert.equal(b.shouldBlock(r), true);
  assert.match(b.cssFor(page), /\.ad_banner/);
  assert.equal(ab.createAdblock({ dir, fetchImpl: null }).siteOff(page), false, "a restart knows nothing");

  b.clearPrivate();
  assert.equal(b.siteOff(page, { private: true }), false, "gone with the last InPrivate tab");
  assert.equal(b.shouldBlock({ ...r, private: true }), true);

  // A site the owner paused for good: InPrivate follows it, and can switch blocking
  // back on for itself without changing the saved choice.
  b.setSiteOff(page, true);
  const saved = fs.readFileSync(file, "utf8");
  assert.equal(b.siteOff(page, { private: true }), true);
  b.setSiteOff(page, false, { private: true });
  assert.equal(b.siteOff(page, { private: true }), false);
  assert.equal(b.shouldBlock({ ...r, private: true }), true);
  assert.equal(b.siteOff(page), true);
  assert.equal(fs.readFileSync(file, "utf8"), saved);
});

test("the hiding sheet: generic plus the site's own, none when blocking is off or the page is not web", () => {
  const b = withLists({ easylist: "##.ad_banner\nshop.test##.promo\nshop.test#@#.ad_banner\n" });
  assert.equal(b.cssFor("https://news.test/a"), ".ad_banner{display:none!important}\n");
  assert.equal(b.cssFor("https://www.shop.test/"), ".promo{display:none!important}\n");
  assert.equal(b.cssFor("aither://settings"), "");
  assert.equal(b.cssFor("file:///c:/x.html"), "");
  assert.equal(b.stats().cosmetic, 2);
  b.setEnabled(false);
  assert.equal(b.cssFor("https://news.test/a"), "");
});

test("a page address loses its tracking parameters; off with the setting or on a paused site", () => {
  const dir = tmp();
  const b = ab.createAdblock({ dir, fetchImpl: null });
  assert.equal(b.cleanNavigation("https://shop.test/item?id=7&utm_source=mail&fbclid=x"), "https://shop.test/item?id=7");
  assert.equal(b.cleanNavigation("https://shop.test/item?id=7"), null);
  assert.equal(b.cleanNavigation("https://shop.test/item?gclid=1", "POST"), null, "a form post is not re-sent elsewhere");
  b.setSiteOff("https://shop.test/", true);
  assert.equal(b.cleanNavigation("https://shop.test/item?gclid=1"), null);
  b.setSiteOff("https://shop.test/", false);
  b.setStripParams(false);
  assert.equal(b.cleanNavigation("https://shop.test/item?gclid=1"), null);
  assert.equal(ab.createAdblock({ dir, fetchImpl: null }).stripParams(), false, "the setting persists");
});

test("the session hooks: a page navigation is redirected clean, and requests carry Sec-GPC", () => {
  const b = ab.createAdblock({ dir: tmp(), fetchImpl: null });
  b.loadCached();
  const hooks = { before: null, headers: undefined };
  const ses = { webRequest: {
    onBeforeRequest: (_f, fn) => { hooks.before = fn; },
    onBeforeSendHeaders: (...args) => { hooks.headers = args.length === 1 ? args[0] : args[1]; },
  } };
  b.attach(ses);
  let answer = null;
  hooks.before({ url: "https://shop.test/?utm_campaign=x&p=1", resourceType: "mainFrame", method: "GET" }, (a) => { answer = a; });
  assert.deepEqual(answer, { redirectURL: "https://shop.test/?p=1" });
  assert.equal(b.strippedCount(), 1);
  hooks.before({ url: "https://shop.test/?p=1", resourceType: "mainFrame", method: "GET" }, (a) => { answer = a; });
  assert.deepEqual(answer, { cancel: false });
  // A sub-resource is never rewritten, only judged.
  hooks.before({ url: "https://cdn.shop.test/a.js?utm_source=x", resourceType: "script", webContents: { getURL: () => "https://shop.test/" }, webContentsId: 3 }, (a) => { answer = a; });
  assert.deepEqual(answer, { cancel: false });

  assert.equal(typeof hooks.headers, "function");
  let sent = null;
  hooks.headers({ requestHeaders: { Accept: "text/html" } }, (a) => { sent = a; });
  assert.deepEqual(sent, { requestHeaders: { Accept: "text/html", "Sec-GPC": "1", DNT: "1" } });
  b.setGpc(false);
  assert.equal(hooks.headers, null, "the listener is removed, not left adding nothing");
  b.setGpc(true);
  assert.equal(typeof hooks.headers, "function");
});

test("the shield menu says what happened and offers the two pauses", () => {
  const on = ab.shieldMenuSpec({ enabled: true, siteOff: false, blocked: 1234, host: "news.test", web: true });
  assert.equal(on[0].label, "1,234 ad and tracker requests blocked on this page");
  assert.equal(on[0].enabled, false);
  assert.deepEqual(on.slice(2).map((i) => [i.id, i.label, i.checked, i.enabled]),
    [["pause-site", "Pause on news.test", false, true], ["pause-all", "Pause everywhere", false, undefined]]);
  assert.equal(ab.shieldMenuSpec({ enabled: true, blocked: 1, host: "a.test", web: true })[0].label, "1 ad and tracker request blocked on this page");
  assert.equal(ab.shieldMenuSpec({ enabled: true, blocked: 0, host: "a.test", web: true })[0].label, "Nothing blocked on this page yet");
  const site = ab.shieldMenuSpec({ enabled: true, siteOff: true, blocked: 0, host: "news.test", web: true });
  assert.equal(site[0].label, "Blocking is paused on news.test");
  assert.equal(site[2].checked, true);
  const all = ab.shieldMenuSpec({ enabled: false, siteOff: false, blocked: 0, host: "news.test", web: true });
  assert.equal(all[0].label, "Blocking is paused everywhere");
  assert.equal(all[2].enabled, false, "the site pause means nothing while everything is paused");
  assert.equal(all[3].checked, true);
});

// ---------------------------------------------------------------- the hot path

/** Lists the size of the real ones (2026-11: ~168k hosts, ~12k path rules, ~24k hiding rules). */
function fullSizeLists() {
  const word = (i) => `w${i.toString(36)}`;
  const hosts = [];
  for (let i = 0; i < 85000; i += 1) hosts.push(`0.0.0.0 ${word(i)}.ads${i % 977}.example`);
  const easy = [];
  for (let i = 0; i < 40000; i += 1) easy.push(`||${word(i)}.trk${i % 613}.example^`);
  for (let i = 0; i < 6000; i += 1) easy.push(`||${word(i)}.cdn${i % 211}.example/${word(i * 7)}/ad-${i}^$third-party`);
  for (let i = 0; i < 5000; i += 1) easy.push(`/${word(i * 3)}-banner-${i}.$script,image`);
  for (let i = 0; i < 1500; i += 1) easy.push(`/static/ads/${word(i)}/*$domain=site${i % 50}.example|~www.site${i % 50}.example`);
  for (let i = 0; i < 1400; i += 1) easy.push(`@@||${word(i)}.cdn${i % 211}.example/${word(i * 7)}/ok^$script`);
  for (let i = 0; i < 14000; i += 1) easy.push(`##.ad-box-${i}`);
  for (let i = 0; i < 10000; i += 1) easy.push(`site${i % 3000}.example##.promo-${i}`);
  return { stevenblack: hosts.join("\n"), easylist: easy.join("\n") };
}

const TRAFFIC = [
  ["https://www.news-site.example/static/js/app.9f3a.js", "script"],
  ["https://www.news-site.example/images/hero/2026/11/photo-large.jpg", "image"],
  ["https://cdn.jsdelivr.net/npm/react@18.3.1/umd/react.production.min.js", "script"],
  ["https://fonts.gstatic.com/s/inter/v13/UcC73FwrK3iLTeHuS_fvQtMwCp50KnMa1ZL7.woff2", "font"],
  ["https://securepubads.g.doubleclick.net/tag/js/gpt.js", "script"],
  ["https://www.news-site.example/ads/banner_728x90.js?slot=top&ord=12345", "script"],
  ["https://api.news-site.example/v2/articles/123/comments?page=1&sort=new&include=author,replies", "xhr"],
  ["https://www.googletagmanager.com/gtm.js?id=GTM-ABC123", "script"],
  ["https://www.news-site.example/wp-content/plugins/social/share.min.css?ver=6.4.2", "stylesheet"],
  ["wss://live.news-site.example/socket?token=abcdef0123456789", "webSocket"],
  ["https://images.unsplash.com/photo-1500530855697-b586d89ba3ee?auto=format&fit=crop&w=1200&q=80", "image"],
  ["https://video.news-site.example/hls/segment_000123.ts?sig=e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855&exp=1794619890", "media"],
];

function averageMicros(b, rounds = 60000) {
  const page = "https://www.news-site.example/world/story-123";
  for (let i = 0; i < 5000; i += 1) b.shouldBlock({ url: TRAFFIC[i % TRAFFIC.length][0], resourceType: TRAFFIC[i % TRAFFIC.length][1], pageUrl: page });
  const t0 = process.hrtime.bigint();
  for (let i = 0; i < rounds; i += 1) b.shouldBlock({ url: TRAFFIC[i % TRAFFIC.length][0], resourceType: TRAFFIC[i % TRAFFIC.length][1], pageUrl: page });
  return Number(process.hrtime.bigint() - t0) / 1e3 / rounds;
}

test("shouldBlock stays under 50 microseconds a request with full-size lists loaded", (t) => {
  const b = withLists(fullSizeLists());
  const stats = b.stats();
  assert.ok(stats.hosts > 120000 && stats.rules > 12000 && stats.cosmetic > 20000, JSON.stringify(stats));
  const avg = averageMicros(b);
  t.diagnostic(`shouldBlock: ${avg.toFixed(2)} microseconds average over ${stats.hosts} hosts, ${stats.rules} rules (lists parsed in ${stats.parseMs} ms)`);
  assert.ok(avg < 50, `${avg.toFixed(1)} microseconds a request`);
  assert.equal(b.shouldBlock({ url: "https://securepubads.g.doubleclick.net/tag/js/gpt.js", resourceType: "script", pageUrl: "https://www.news-site.example/" }), true);
});

// The real lists, when a directory of downloaded ones is given (the files a refresh
// writes: adblock-easylist.txt, adblock-easyprivacy.txt, adblock-stevenblack.txt).
test("shouldBlock stays under 50 microseconds with the real lists (AWDESK_ADBLOCK_LISTS)", { skip: !process.env.AWDESK_ADBLOCK_LISTS }, (t) => {
  const dir = tmp();
  for (const f of fs.readdirSync(process.env.AWDESK_ADBLOCK_LISTS)) {
    if (/^adblock-.*\.txt$/.test(f)) fs.copyFileSync(path.join(process.env.AWDESK_ADBLOCK_LISTS, f), path.join(dir, f));
  }
  const b = ab.createAdblock({ dir, fetchImpl: null });
  b.loadCached();
  const stats = b.stats();
  assert.ok(stats.rules > 5000 && stats.cosmetic > 10000, JSON.stringify(stats));
  const avg = averageMicros(b, 120000);
  t.diagnostic(`real lists: ${avg.toFixed(2)} microseconds average; ${JSON.stringify(stats)}`);
  assert.ok(avg < 50, `${avg.toFixed(1)} microseconds a request`);
  const page = "https://www.news-site.example/story";
  assert.equal(b.shouldBlock({ url: "https://www.news-site.example/ads/banners/top.gif", resourceType: "image", pageUrl: page }), true);
  assert.equal(b.shouldBlock({ url: "https://www.news-site.example/static/js/app.js", resourceType: "script", pageUrl: page }), false);
  assert.match(b.cssFor(page), /\.ad_banner[,{]/);
});

test("the lists' page-level exceptions: $generichide, $elemhide and $document", () => {
  const b = withLists({ easylist: ["##.ad_banner", "www.video.test##.masthead-ad", "bank.test##.promo", "/ads/banners/*$image",
    "@@||www.video.test^$generichide", "@@||bank.test^$elemhide", "@@||pay.test^$document"].join("\n") });
  assert.equal(b.cssFor("https://www.video.test/watch?v=1"), ".masthead-ad{display:none!important}\n", "only what is written for the site");
  assert.equal(b.cssFor("https://bank.test/login"), "", "$elemhide: nothing is hidden");
  assert.equal(b.cssFor("https://pay.test/checkout"), "");
  assert.match(b.cssFor("https://news.test/"), /\.ad_banner/);
  const ad = (pageUrl) => b.shouldBlock({ url: "https://cdn.test/ads/banners/x.gif", resourceType: "image", pageUrl });
  assert.equal(ad("https://pay.test/checkout"), false, "$document: nothing is blocked on that page");
  assert.equal(ad("https://www.video.test/watch"), true, "$generichide hides less; it does not unblock");
  assert.equal(ad("https://bank.test/login"), true);
});
