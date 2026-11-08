"use strict";

// The keyless GIF path (2026-11-07): the desk's own web search + Giphy/Tenor pages,
// replayed from fixtures recorded that day (giphy.com/explore/cat, awfind rows).

const test = require("node:test");
const assert = require("node:assert/strict");
const gif = require("./gif-search.cjs");

// Recorded 2026-11-07: `awfind --json q -- "giphy cat gifs"` (urls only) and excerpts of
// https://giphy.com/explore/cat (its gif links and media urls, unchanged).
const AWFIND_ROWS = [
  { url: "https://giphy.com/explore/cat", title: "Cat GIFs - Find & Share on GIPHY" },
  { url: "https://tenor.com/search/giphy-cat-gifs", title: "Giphy Cat GIFs | Tenor" },
  { url: "https://giphy.com/gifs/cat-typing-JIX9t2j0ZTN9S", title: "Cat Typing GIF" },
  { url: "https://gifer.com/en/gifs/cat", title: "Cat GIFs" },
];
const EXPLORE_HTML = [
  "<a href=\"https://giphy.com/gifs/ai-cat-funny-meme-boxing-cbm0J4DEIqKHsKxYHA\">",
  "<a href=\"https://giphy.com/gifs/animal-kedi-elenceli-UuzwffmvtBNGjYyEUe\">",
  "<a href=\"https://giphy.com/gifs/sexy-cat-dance-Q1w2E3r4T5y6U7\">",
  "<img src=\"https://media0.giphy.com/media/v1.Y2lkPTc5MGI3NjExanAyZ25wN3NjMDBuMWVvNTlqdzlkYm5mand4c2dlMHl1ZHR4bm40eiZlcD12MV9naWZzX3NlYXJjaCZjdD1n/11IYKJ5sN73twk/200w.gif\">",
  "<img src=\"https://media.giphy.com/media/UuzwffmvtBNGjYyEUe/giphy.gif\">",
].join("\n");
const TENOR_HTML = "<meta property=\"og:image\" content=\"https://media.tenor.com/AbCdEfGhIjKAAAAC/cat-wave.gif\">";

test("a giphy.com/gifs page maps to its media with no key", () => {
  assert.deepEqual(gif.giphyFromPage("https://giphy.com/gifs/cat-typing-JIX9t2j0ZTN9S"), { id: "JIX9t2j0ZTN9S", slug: "cat-typing" });
  assert.deepEqual(gif.giphyFromPage("https://giphy.com/gifs/JIX9t2j0ZTN9S"), { id: "JIX9t2j0ZTN9S", slug: "" });
  assert.equal(gif.giphyFromPage("https://giphy.com.evil.example/gifs/cat-JIX9t2j0ZTN9S"), null);
  assert.equal(gif.giphyFromPage("http://giphy.com/gifs/cat-JIX9t2j0ZTN9S"), null);
  const r = gif.giphyResult("JIX9t2j0ZTN9S", "cat-typing");
  assert.equal(r.url, "https://media.giphy.com/media/JIX9t2j0ZTN9S/giphy.gif");
  assert.equal(r.preview, "https://media.giphy.com/media/JIX9t2j0ZTN9S/200w.gif");
  assert.equal(r.title, "Cat typing");
});

test("a Giphy list page yields its gifs (links first, then bare media ids), deduped", () => {
  const items = gif.parseGiphyHtml(EXPLORE_HTML);
  assert.deepEqual(items.map((i) => i.id.replace("web:giphy:", "")),
    ["cbm0J4DEIqKHsKxYHA", "UuzwffmvtBNGjYyEUe", "Q1w2E3r4T5y6U7", "11IYKJ5sN73twk"]);
});

test("a Tenor page's og:image is used only when it is a .gif on Tenor's media host", () => {
  const t = gif.tenorOgGif(TENOR_HTML, "https://tenor.com/view/cat-wave-gif-123456");
  assert.equal(t.url, "https://media.tenor.com/AbCdEfGhIjKAAAAC/cat-wave.gif");
  assert.equal(gif.tenorOgGif("<meta property=\"og:image\" content=\"https://media.tenor.com/x/cat.png\">"), null);
  assert.equal(gif.tenorOgGif("<meta property=\"og:image\" content=\"https://evil.example/x.gif\">"), null);
  assert.equal(gif.tenorOgGif(""), null);
});

function source({ strict = false, rows = AWFIND_ROWS, pages = {} } = {}) {
  const fetched = [];
  const queries = [];
  const src = gif.createWebGifSource({
    webSearch: async (q) => { queries.push(q); return q.startsWith("tenor") ? [{ url: "https://tenor.com/view/cat-wave-gif-123456" }] : rows; },
    fetchPage: async (u) => { fetched.push(u); return pages[u] || ""; },
    strict: () => strict,
  });
  return { src, fetched, queries };
}

test("keyless search: page links + list pages + tenor og, deduped, capped at 24", async () => {
  const { src, fetched, queries } = source({ pages: {
    "https://giphy.com/explore/cat": EXPLORE_HTML,
    "https://tenor.com/view/cat-wave-gif-123456": TENOR_HTML,
  } });
  const r = await src.search("cat");
  assert.equal(r.ok, true);
  assert.deepEqual(queries, ["giphy cat gifs", "tenor cat gif"]);
  assert.ok(fetched.every((u) => /^https:\/\/(giphy|tenor)\.com\//.test(u)), "only giphy/tenor pages are read");
  const ids = r.results.map((i) => i.id);
  assert.equal(new Set(ids).size, ids.length, "deduped");
  assert.equal(ids[0], "web:giphy:JIX9t2j0ZTN9S", "a direct gif page first");
  assert.ok(ids.includes("web:tenor:cat-wave-123456"), ids.join(","));
  const html = Array.from({ length: 60 }, (_, i) => `giphy.com/gifs/cat-${String(i).padStart(2, "0")}aaaaaaaa"`).join("\n");
  assert.equal(gif.parseGiphyHtml(html).length, 60);
  const capped = await source({ rows: [{ url: "https://giphy.com/explore/cat" }], pages: { "https://giphy.com/explore/cat": html } }).src.search("cat");
  assert.equal(capped.results.length, 24);
});

test("strict (adult gate closed): only slugged GIFs, and the word filter drops suggestive ones", async () => {
  const { src } = source({ strict: true, pages: { "https://giphy.com/explore/cat": EXPLORE_HTML } });
  const r = await src.search("cat");
  const ids = r.results.map((i) => i.id);
  assert.ok(!ids.includes("web:giphy:Q1w2E3r4T5y6U7"), "the suggestive slug is dropped");
  assert.ok(!ids.includes("web:giphy:11IYKJ5sN73twk"), "a bare media id (no slug to judge) is dropped");
  assert.ok(ids.includes("web:giphy:UuzwffmvtBNGjYyEUe"));
});

test("empty web results: Giphy's own search page is read; nothing anywhere = ok with 0 results", async () => {
  const { src, fetched } = source({ rows: [] });
  const r = await src.search("zzqqxx");
  assert.deepEqual(r, { ok: true, results: [], pages: 2 });
  assert.deepEqual(fetched.filter((u) => u.includes("giphy.com/search")), ["https://giphy.com/search/zzqqxx"]);
});

test("the web search failing reports offline, never throws", async () => {
  const src = gif.createWebGifSource({ webSearch: async () => { throw new Error("awfind is not installed"); }, fetchPage: async () => "" });
  const r = await src.search("cat");
  assert.equal(r.ok, false);
  assert.equal(r.offline, true);
});

test("createGifSearch with no key uses the web adapter and says a key is an upgrade, not a wall", async () => {
  const s = gif.createGifSearch({ getSecret: async () => null,
    web: { search: async () => ({ ok: true, results: [{ ...gif.giphyResult("JIX9t2j0ZTN9S", "cat-typing") }] }) } });
  const r = await s.search("cat");
  assert.equal(r.ok, true);
  assert.equal(r.provider, "web");
  assert.match(r.note, /Better results with a key/);
  assert.equal(r.results[0].slug, undefined, "internal fields stay internal");
  assert.equal(s.lookup("web:giphy:JIX9t2j0ZTN9S").url, "https://media.giphy.com/media/JIX9t2j0ZTN9S/giphy.gif");
  assert.equal(await s.keyStatus(), "web");
});
