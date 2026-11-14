"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const R = require("./browser-adblock-rules.cjs");

/** Does this one list line match the request? */
function hit(line, url, { type = "script", page = "site.test", third = true } = {}) {
  const rule = R.parseRule(line);
  assert.ok(rule, `rule did not parse: ${line}`);
  const set = R.createRuleSet();
  set.add(rule);
  set.freeze();
  return set.match(R.describeRequest(url, type, page, third));
}

test("lines that are not network rules, or use options this browser cannot honour, are skipped", () => {
  for (const line of ["", "! comment", "[Adblock Plus 2.0]", "##.ad", "site.test#@#.ad", "site.test#?#div:has-text(Ad)",
    "/banner\\d+/", "||x.test^$csp=script-src 'self'", "||x.test^$redirect=noop.js", "||x.test^$popup",
    "||x.test^$document", "||x.test^$generichide", "||x.test^$domain=google.*", "$script"]) {
    assert.equal(R.parseRule(line), null, line);
  }
});

test("||host^ is the plain host rule the host set keeps; anything more is a rule", () => {
  assert.equal(R.isPlainHostRule(R.parseRule("||ads.test^")), true);
  assert.equal(R.isPlainHostRule(R.parseRule("||ads.test^$third-party")), true);
  assert.equal(R.isPlainHostRule(R.parseRule("@@||ads.test^")), true);
  assert.equal(R.isPlainHostRule(R.parseRule("||ads.test^$script")), false);
  assert.equal(R.isPlainHostRule(R.parseRule("||ads.test/banner^")), false);
  assert.equal(R.isPlainHostRule(R.parseRule("||ads.test^$domain=a.test")), false);
  assert.equal(R.parseRule("@@||ok.test/x$script").exception, true);
});

test("||host/path^ matches the host and its subdomains at the path, on a first-party page too", () => {
  const line = "||news.test/ads/banner^";
  assert.equal(hit(line, "https://news.test/ads/banner", { third: false }), true);
  assert.equal(hit(line, "https://cdn.news.test/ads/banner?x=1", { third: false }), true);
  assert.equal(hit(line, "https://news.test/ads/banner/x.js"), true);
  assert.equal(hit(line, "https://news.test/ads/banners"), false, "^ needs a separator");
  assert.equal(hit(line, "https://notnews.test/ads/banner"), false, "|| starts at a label");
  assert.equal(hit(line, "https://other.test/?u=news.test/ads/banner"), false, "|| is the hostname, not the query");
});

test("separators, wildcards and the | anchors", () => {
  assert.equal(hit("/adframe.", "https://a.test/x/adframe.html"), true);
  assert.equal(hit("/ads/*/banner_", "https://a.test/ads/2026/11/banner_300.gif"), true);
  assert.equal(hit("/ads/*/banner_", "https://a.test/banner_/ads/"), false, "pieces are found in order");
  assert.equal(hit("|https://a.test/track", "https://a.test/track.gif"), true);
  assert.equal(hit("|https://a.test/track", "https://b.test/?r=https://a.test/track"), false);
  assert.equal(hit(".swf|", "https://a.test/movie.swf"), true);
  assert.equal(hit(".swf|", "https://a.test/movie.swf?x=1"), false);
  assert.equal(hit("^utm_ad=", "https://a.test/p?utm_ad=1"), true);
  assert.equal(hit("&ad_slot=^", "https://a.test/p?x=1&ad_slot="), true, "^ also matches the end");
  assert.equal(hit("/AdServer/x", "https://a.test/adserver/x"), true, "matching ignores case");
  assert.equal(R.parseRule("/adserver/"), null, "/.../ is a regular expression in a list, and is not run");
});

test("$script / $image / $~image limit the kind of request", () => {
  assert.equal(hit("/pixel.$image", "https://a.test/pixel.gif", { type: "image" }), true);
  assert.equal(hit("/pixel.$image", "https://a.test/pixel.js", { type: "script" }), false);
  assert.equal(hit("/widget.$~image", "https://a.test/widget.png", { type: "image" }), false);
  assert.equal(hit("/widget.$~image", "https://a.test/widget.js", { type: "script" }), true);
  assert.equal(hit("/frame/ad.$subdocument", "https://a.test/frame/ad.html", { type: "subFrame" }), true);
  assert.equal(hit("/beacon/v1$xmlhttprequest,ping", "https://a.test/beacon/v1", { type: "xhr" }), true);
});

test("$third-party and $~third-party", () => {
  assert.equal(hit("/promo/track.$third-party", "https://x.test/promo/track.js", { third: true }), true);
  assert.equal(hit("/promo/track.$third-party", "https://x.test/promo/track.js", { third: false }), false);
  assert.equal(hit("/promo/track.$~third-party", "https://x.test/promo/track.js", { third: false }), true);
  assert.equal(hit("/promo/track.$~third-party", "https://x.test/promo/track.js", { third: true }), false);
});

test("$domain= limits the pages a rule applies on, with ~ exclusions", () => {
  const line = "/sponsor/box.$script,domain=shop.test|~help.shop.test";
  assert.equal(hit(line, "https://cdn.test/sponsor/box.js", { page: "shop.test" }), true);
  assert.equal(hit(line, "https://cdn.test/sponsor/box.js", { page: "www.shop.test" }), true);
  assert.equal(hit(line, "https://cdn.test/sponsor/box.js", { page: "help.shop.test" }), false);
  assert.equal(hit(line, "https://cdn.test/sponsor/box.js", { page: "other.test" }), false);
  // A rule that is only options is indexed under its sites.
  assert.equal(hit("$websocket,domain=stream.test", "wss://feed.cdn.test/live", { type: "webSocket", page: "stream.test" }), true);
  assert.equal(hit("$websocket,domain=stream.test", "wss://feed.cdn.test/live", { type: "webSocket", page: "other.test" }), false);
});

test("the index tests only the rules that could match, and still finds every one", () => {
  const set = R.createRuleSet();
  const lines = ["||a.test/ads/", "/banner_ad.", "-sponsor-box-", "/static/ad.js$script", "&ad_type=", "||b.test/x^$image", "adserver"];
  for (const l of lines) set.add(R.parseRule(l));
  const stats = set.freeze();
  assert.equal(stats.rules, 6);
  assert.equal(stats.dropped, 1, "a bare word with no edge has nothing to be indexed under");
  assert.equal(stats.byHost, 2);
  const req = (url, type = "script") => R.describeRequest(url, type, "page.test", true);
  assert.equal(set.match(req("https://x.a.test/ads/1.js")), true);
  assert.equal(set.match(req("https://c.test/img/banner_ad.png", "image")), true);
  assert.equal(set.match(req("https://c.test/x-sponsor-box-2")), true);
  assert.equal(set.match(req("https://c.test/static/ad.js")), true);
  assert.equal(set.match(req("https://c.test/static/add.js")), false);
  assert.equal(set.match(req("https://c.test/p?x=1&ad_type=video")), true);
  assert.equal(set.match(req("https://b.test/x", "script")), false);
  assert.equal(set.match(req("https://b.test/x", "image")), true);
});

test("a hostile address cannot make a rule backtrack", () => {
  // Many near-misses of every piece: a regex of the same pattern would crawl.
  const line = "/a*a*a*a*a*a*a*a*b";
  const url = `https://x.test/${"a".repeat(1900)}`;
  const rule = R.parseRule(line);
  const req = R.describeRequest(url, "script", "p.test", true);
  const t0 = process.hrtime.bigint();
  for (let i = 0; i < 2000; i += 1) R.matchPattern(rule, req.url, req.hostStart, req.hostEnd);
  const perCallUs = Number(process.hrtime.bigint() - t0) / 1e3 / 2000;
  assert.equal(R.matchPattern(rule, req.url, req.hostStart, req.hostEnd), false);
  assert.ok(perCallUs < 200, `one match took ${perCallUs.toFixed(1)} microseconds`);
});

test("describeRequest finds the hostname behind a port and credentials", () => {
  const d = R.describeRequest("HTTPS://user:pw@Sub.Example.TEST:8443/Path?q=1#f", "xhr", "p.test", false);
  assert.equal(d.host, "sub.example.test");
  assert.equal(d.type, R.TYPE_BITS.xmlhttprequest);
  assert.ok(d.tokens.includes("path"));
  assert.equal(R.describeRequest("data:text/plain,hi", "image", "", true), null);
});

test("page-level exceptions are kept and say which kind; a blocking $document is not", () => {
  assert.equal(R.parseRule("@@||www.video.test^$generichide").page, R.PAGE_GENERICHIDE);
  assert.equal(R.parseRule("@@||bank.test^$elemhide").page, R.PAGE_ELEMHIDE);
  assert.equal(R.parseRule("@@||pay.test^$document").page, R.PAGE_DOCUMENT);
  assert.equal(R.parseRule("@@||a.test^$elemhide,generichide").page, R.PAGE_ELEMHIDE | R.PAGE_GENERICHIDE);
  assert.equal(R.parseRule("||ads.test^$script").page, 0);
  assert.equal(R.parseRule("||popad.test^$document"), null);
  assert.equal(R.parseRule("||x.test^$generichide"), null);
  assert.equal(R.isPlainHostRule(R.parseRule("@@||pay.test^$document")), false, "never mistaken for a host exception");
});
