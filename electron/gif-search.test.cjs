"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const gif = require("./gif-search.cjs");

// Fixtures in each provider's documented response shape (Tenor v2 /search,
// Giphy v1 /gifs/search), trimmed to the fields the parser reads.
const TENOR = {
  results: [
    { id: "123", content_description: "cat typing", media_formats: {
      gif: { url: "https://media.tenor.com/abc/cat.gif", dims: [498, 280] },
      tinygif: { url: "https://media.tenor.com/abc/cat-tiny.gif", dims: [220, 124] } } },
    { id: "bad", content_description: "http only", media_formats: { gif: { url: "http://media.tenor.com/x.gif", dims: [1, 1] } } },
    { id: "evil", content_description: "other host", media_formats: { gif: { url: "https://evil.example/x.gif", dims: [1, 1] } } },
  ],
  next: "n1",
};
const GIPHY = {
  data: [
    { id: "g1", title: "dog wave", images: {
      original: { url: "https://media1.giphy.com/media/g1/giphy.gif", width: "480", height: "270" },
      fixed_width_small: { url: "https://media1.giphy.com/media/g1/100w.gif" } } },
  ],
};

const SECRET = "KEYVALUE-should-never-surface-0123456789";

function fetchStub(body, { status = 200, seen = [] } = {}) {
  return async (url, opts) => {
    seen.push({ url, opts });
    return { ok: status >= 200 && status < 300, status, json: async () => body };
  };
}

test("tenor first when it has a key; G filter while the adult gate is closed", async () => {
  const seen = [];
  const s = gif.createGifSearch({
    getSecret: async (name) => (name === "TENOR_API_KEY" ? SECRET : null),
    fetchImpl: fetchStub(TENOR, { seen }), strict: () => true,
  });
  const r = await s.search("cat");
  assert.equal(r.ok, true);
  assert.equal(r.provider, "tenor");
  assert.equal(r.rating, "high");
  assert.equal(r.results.length, 1, "http and foreign-host media are dropped");
  assert.deepEqual(r.results[0], { id: "tenor:123", provider: "tenor", title: "cat typing",
    url: "https://media.tenor.com/abc/cat.gif", preview: "https://media.tenor.com/abc/cat-tiny.gif", width: 498, height: 280 });
  const u = new URL(seen[0].url);
  assert.equal(u.hostname, "tenor.googleapis.com");
  assert.equal(u.searchParams.get("contentfilter"), "high");
  assert.equal(u.searchParams.get("q"), "cat");
  assert.equal(s.lookup("tenor:123").url, "https://media.tenor.com/abc/cat.gif", "main resolves ids, not URLs");
});

test("giphy answers when only it has a key; PG-13 when the gate is open -- never unfiltered", async () => {
  const seen = [];
  const s = gif.createGifSearch({
    getSecret: async (name) => (name === "GIPHY_API_KEY" ? SECRET : null),
    fetchImpl: fetchStub(GIPHY, { seen }), strict: () => false,
  });
  const r = await s.search("dog");
  assert.equal(r.provider, "giphy");
  assert.equal(r.results[0].id, "giphy:g1");
  assert.equal(r.results[0].width, 480);
  assert.equal(new URL(seen[0].url).searchParams.get("rating"), "pg-13");
  for (const strict of [true, false]) {
    for (const p of gif.PROVIDERS) assert.ok(!["off", "r", ""].includes(gif.ratingFor(p, strict)));
  }
});

test("no key and no web adapter = the needsKey state, and no request is made", async () => {
  const seen = [];
  const s = gif.createGifSearch({ getSecret: async () => null, fetchImpl: fetchStub(TENOR, { seen }), web: null });
  const r = await s.search("cat");
  assert.equal(r.ok, false);
  assert.equal(r.needsKey, true);
  assert.match(r.reason, /add a GIF key/);
  assert.equal(seen.length, 0);
  assert.equal(await s.keyStatus(), "needs-key");
});

test("a refused key, a timeout and a network error never put the key (or the URL) in the reason", async () => {
  const refused = gif.createGifSearch({ getSecret: async () => SECRET, fetchImpl: fetchStub({}, { status: 401 }) });
  const r1 = await refused.search("x");
  assert.equal(r1.ok, false);
  assert.match(r1.reason, /HTTP 401/);
  const broken = gif.createGifSearch({ getSecret: async () => SECRET,
    fetchImpl: async (url) => { throw new Error(`connect failed ${url}`); } });
  const r2 = await broken.search("x");
  const slow = gif.createGifSearch({ getSecret: async () => SECRET, timeoutMs: 20,
    fetchImpl: (url, { signal }) => new Promise((_, reject) => signal.addEventListener("abort", () => {
      const e = new Error("aborted"); e.name = "AbortError"; reject(e);
    })) });
  const r3 = await slow.search("x");
  assert.match(r3.reason, /took over/);
  for (const r of [r1, r2, r3]) {
    assert.ok(!JSON.stringify(r).includes(SECRET), `the key leaked: ${JSON.stringify(r)}`);
    assert.ok(!JSON.stringify(r).includes("googleapis"), "the request URL leaked");
  }
});

test("the key is read once and cached; a missing key is retried after its short TTL", async () => {
  let reads = 0;
  let t = 0;
  const s = gif.createGifSearch({ getSecret: async () => { reads += 1; return null; }, now: () => t, fetchImpl: fetchStub(TENOR),
    web: { search: async () => ({ ok: true, results: [] }) } });
  await s.search("a");
  const first = reads;
  await s.search("b");
  assert.equal(reads, first, "cached");
  t += 61_000;
  await s.search("c");
  assert.ok(reads > first, "re-read after the no-key TTL");
});

test("secretValue reads the vault's shapes and never throws with the value", () => {
  assert.equal(gif.secretValue(JSON.stringify({ name: "X", value: "abcdefgh1234" })), "abcdefgh1234");
  assert.equal(gif.secretValue({ secret: { value: "abcdefgh1234" } }), "abcdefgh1234");
  assert.equal(gif.secretValue("abcdefgh1234"), "abcdefgh1234");
  assert.equal(gif.secretValue(JSON.stringify({ error: "not found" })), null);
  assert.equal(gif.secretValue("not found: no such secret"), null, "prose is not a key");
  assert.equal(gif.secretValue(null), null);
});

test("an empty query asks for a word; control characters are dropped", async () => {
  const s = gif.createGifSearch({ getSecret: async () => SECRET, fetchImpl: fetchStub(TENOR) });
  assert.equal((await s.search("   ")).ok, false);
  assert.equal(gif.cleanQuery("a\u0000b\nc"), "a b c");
});
