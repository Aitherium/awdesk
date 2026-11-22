"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

// Regression pins for the 2026-08-27 blank-deck-window crash: browse() must
// return the DECLARED shape on every path — {ok, listings} ALWAYS present.
// The Deck panel reads market.listings.slice(...) unconditionally, and the
// two error paths used to return {ok:false, reason} with no listings key,
// which crashed the whole deck window to blank (decisions list, character
// gallery and settings all read as dead buttons).
function withCallTool(fake, fn) {
  const mcpPath = require.resolve("./gateway-mcp.cjs");
  const mcPath = require.resolve("./market-client.cjs");
  delete require.cache[mcpPath];
  delete require.cache[mcPath];
  const gatewayMcp = require(mcpPath);
  gatewayMcp.callTool = fake;
  return fn(require(mcPath));
}

test("browse: valid listings pass through with the shape intact", async () => {
  await withCallTool(
    async () => JSON.stringify({ listings: [{ id: "p1", name: "pack" }] }),
    async (client) => {
      const r = await client.browse();
      assert.equal(r.ok, true);
      assert.deepEqual(r.listings, [{ id: "p1", name: "pack" }]);
    },
  );
});

test("browse: JSON WITHOUT listings keeps the shape (the crash class)", async () => {
  await withCallTool(
    async () => JSON.stringify({ error: "validation failed" }),
    async (client) => {
      const r = await client.browse();
      assert.equal(r.ok, false);
      assert.ok(Array.isArray(r.listings), "listings must exist on failure");
      assert.equal(r.listings.length, 0);
      assert.match(r.reason, /validation failed/);
    },
  );
});

test("browse: transport failure keeps the shape", async () => {
  await withCallTool(
    async () => {
      throw new Error("gateway down");
    },
    async (client) => {
      const r = await client.browse();
      assert.equal(r.ok, false);
      assert.ok(Array.isArray(r.listings), "listings must exist on failure");
      assert.equal(r.listings.length, 0);
      assert.match(r.reason, /gateway down/);
    },
  );
});

test("browse: plain prose (non-JSON) still carries listings", async () => {
  await withCallTool(
    async () => "here is some prose, no json",
    async (client) => {
      const r = await client.browse();
      assert.equal(r.ok, true);
      assert.deepEqual(r.listings, []);
    },
  );
});

// ─── the avatar store (W4-04): library + VRoid search through the broker ─────

const client = require("./market-client.cjs");

/** A fake fetch that records every request and answers from `routes`. */
function fakeFetch(routes) {
  const seen = [];
  const impl = async (url, init) => {
    const u = new URL(url);
    seen.push({ method: init.method, path: u.pathname, query: Object.fromEntries(u.searchParams), auth: init.headers.Authorization });
    const hit = routes[`${init.method} ${u.pathname}`];
    if (!hit) return new Response(JSON.stringify({ detail: "not found" }), { status: 404 });
    return typeof hit === "function" ? hit(u) : hit;
  };
  return { seen, impl };
}
const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const STORE = { origin: "https://portal.example.test", token: "tok-abc" };

test("store: signed out is a sentence, never a request", async () => {
  const f = fakeFetch({});
  const r = await client.avatarLibrary({ ...STORE, token: "", fetchImpl: f.impl });
  assert.equal(r.ok, false);
  assert.deepEqual(r.avatars, []);
  assert.match(r.reason, /Sign in/);
  assert.equal(f.seen.length, 0);
});

test("store: the library is read through /api/avatars with the person's bearer only", async () => {
  const f = fakeFetch({ "GET /api/avatars": json(200, { avatars: [{ id: "mira-1a2b3c4d" }], active: "mira-1a2b3c4d" }) });
  const r = await client.avatarLibrary({ ...STORE, fetchImpl: f.impl });
  assert.equal(r.ok, true);
  assert.equal(r.avatars[0].id, "mira-1a2b3c4d");
  assert.equal(f.seen[0].auth, "Bearer tok-abc");
  assert.deepEqual(f.seen[0].query, {}, "no owner, tenant or workspace id is sent");
  assert.ok(!JSON.stringify(r).includes("tok-abc"), "the token never comes back to the caller");
});

test("store: VRoid search passes the keyword and keeps the shape", async () => {
  const f = fakeFetch({
    "GET /api/avatars/vroid/browse/search": json(200, { models: [{ id: "123", downloadable: true }], next: "c2" }),
  });
  const r = await client.vroidBrowse("search", "cat ears", "", { ...STORE, fetchImpl: f.impl });
  assert.equal(r.ok, true);
  assert.equal(r.models.length, 1);
  assert.equal(r.next, "c2");
  assert.equal(f.seen[0].query.keyword, "cat ears");
});

test("store: a 403 audience refusal renders the closed-store sentence", async () => {
  const f = fakeFetch({
    "GET /api/avatars/vroid/browse/search": json(403, { detail: { refused: "audience", reason: "owner only" } }),
  });
  const r = await client.vroidBrowse("search", "", "", { ...STORE, fetchImpl: f.impl });
  assert.equal(r.ok, false);
  assert.equal(r.closed, true);
  assert.equal(r.reason, client.STORE_CLOSED);
  assert.deepEqual(r.models, []);
});

test("store: an unlinked VRoid account says link first", async () => {
  const f = fakeFetch({
    "GET /api/avatars/vroid/browse/hearts": json(409, { detail: { refused: "not_linked", reason: "link your VRoid Hub account first" } }),
  });
  const r = await client.vroidBrowse("hearts", "", "", { ...STORE, fetchImpl: f.impl });
  assert.equal(r.linked, false);
  assert.match(r.reason, /link your VRoid Hub account/);
});

test("store: a VRoid model is fetched by ticket, then download", async () => {
  const bytes = Buffer.concat([Buffer.from("glTF"), Buffer.alloc(32)]);
  const f = fakeFetch({
    "POST /api/avatars/vroid/models/123/ticket": json(200, { ticket: "eyJzIjoiYSJ9.c2ln", expires_in: 120 }),
    "GET /api/avatars/vroid/download/eyJzIjoiYSJ9.c2ln": new Response(bytes, { status: 200 }),
  });
  const r = await client.vroidModel("123", { ...STORE, fetchImpl: f.impl });
  assert.equal(r.ok, true, r.reason);
  assert.deepEqual(Buffer.from(r.bytes), bytes);
  assert.deepEqual(f.seen.map((s) => `${s.method} ${s.path}`), [
    "POST /api/avatars/vroid/models/123/ticket",
    "GET /api/avatars/vroid/download/eyJzIjoiYSJ9.c2ln",
  ]);
});

test("store: a non-downloadable model yields no download request", async () => {
  const f = fakeFetch({
    "POST /api/avatars/vroid/models/9/ticket": json(403, { detail: { refused: "not_downloadable", reason: "VRoid Hub does not allow this account to download it" } }),
  });
  const r = await client.vroidModel("9", { ...STORE, fetchImpl: f.impl });
  assert.equal(r.ok, false);
  assert.equal(r.refused, "not_downloadable");
  assert.equal(f.seen.length, 1);
});

test("store: ids outside the grammar never reach the network", async () => {
  const f = fakeFetch({});
  assert.equal((await client.libraryModel("../etc", { ...STORE, fetchImpl: f.impl })).ok, false);
  assert.equal((await client.vroidModel("1/../2", { ...STORE, fetchImpl: f.impl })).ok, false);
  assert.equal(f.seen.length, 0);
});

// ─── the catalog every device reads (aither-avatars, 2026-10-16) ─────────────

test("catalog: one read, shapes always present, bad agent keys dropped", async () => {
  const f = fakeFetch({ "GET /api/avatars/catalog": json(200, {
    avatars: [{ id: "mira-1a2b3c4d" }], starters: [{ id: "starter-sora" }],
    agents: { aither: "mira-1a2b3c4d", "Bad Key": "x", lyra: 3 }, active: "mira-1a2b3c4d",
  }) });
  const r = await client.avatarCatalog({ ...STORE, fetchImpl: f.impl });
  assert.equal(r.ok, true);
  assert.deepEqual(r.agents, { aither: "mira-1a2b3c4d" });
  assert.equal(r.starters[0].id, "starter-sora");
  const down = await client.avatarCatalog({ ...STORE, fetchImpl: fakeFetch({}).impl });
  assert.equal(down.ok, false);
  assert.deepEqual([down.avatars, down.starters, down.agents], [[], [], {}]);
});

test("catalog: dressing an agent is a PUT carrying only the id", async () => {
  let body = null;
  const f = fakeFetch({ "PUT /api/avatars/agents/aither": () => json(200, { agent: "aither" }) });
  const impl = async (url, init) => {
    body = init.body;
    return f.impl(url, init);
  };
  const r = await client.putAgentAvatar("aither", "mira-1a2b3c4d", { ...STORE, fetchImpl: impl });
  assert.equal(r.ok, true);
  assert.deepEqual(JSON.parse(body), { id: "mira-1a2b3c4d" });
  assert.equal((await client.putAgentAvatar("../x", "mira", { ...STORE, fetchImpl: impl })).ok, false);
  assert.equal((await client.putAgentAvatar("aither", "../etc", { ...STORE, fetchImpl: impl })).ok, false);
});

test("catalog: an upload is multipart with the person's bearer and returns the record", async () => {
  const seen = [];
  const impl = async (url, init) => {
    seen.push({ path: new URL(url).pathname, method: init.method, form: init.body instanceof FormData });
    return json(200, { id: "mermaid-12345678", name: "Mermaid" });
  };
  const r = await client.uploadAvatar(Buffer.from("glTF0000"), "Mermaid", "general", { ...STORE, fetchImpl: impl });
  assert.equal(r.ok, true);
  assert.equal(r.record.id, "mermaid-12345678");
  assert.deepEqual(seen, [{ path: "/api/avatars", method: "POST", form: true }]);
  assert.equal((await client.uploadAvatar(Buffer.alloc(0), "x", "general", { ...STORE, fetchImpl: impl })).ok, false);
});

test("uploadAvatar refuses a local-only imported body before any request", async () => {
  let js = Buffer.from(JSON.stringify({ asset: { version: "2.0", extras: { dm_import: { local_only: true } } } }));
  if (js.length % 4) js = Buffer.concat([js, Buffer.alloc(4 - (js.length % 4), 0x20)]);
  const h = Buffer.alloc(20);
  h.writeUInt32LE(0x46546c67, 0); h.writeUInt32LE(2, 4); h.writeUInt32LE(20 + js.length, 8); h.writeUInt32LE(js.length, 12); h.writeUInt32LE(0x4e4f534a, 16);
  let called = 0;
  const impl = async () => { called += 1; return new Response("{}", { status: 200 }); };
  const r = await client.uploadAvatar(Buffer.concat([h, js]), "Mara", "general", { origin: "https://example.invalid", token: "t", fetchImpl: impl });
  assert.equal(r.ok, false);
  assert.equal(r.refused, "local-only");
  assert.equal(called, 0, "no request leaves the machine");
});
