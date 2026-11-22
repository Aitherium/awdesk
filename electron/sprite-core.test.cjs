"use strict";

/**
 * The fairy wears the owner's AitherSprite: API json -> bubble line + tint, the
 * silent fallback to the plain fairy, and what `sprite.teach` sends.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const sc = require("./sprite-core.cjs");

// GET /api/sprite/me as AitherSprite.to_public_dict writes it (trimmed).
const ME = {
  id: "spr_1", name: "Pip", stage: "child", form: "wisp",
  mood: { valence: 0.5, arousal: 0.2 }, mood_label: "joyful",
  dormant: false, knowledge_count: 3,
};

test("spriteView maps name, stage and mood_label to a line, a tooltip and a mood tint", () => {
  const v = sc.spriteView(ME);
  assert.equal(v.name, "Pip");
  assert.equal(v.stage, "child");
  assert.equal(v.mood, "joyful");
  assert.equal(v.line, "Pip · child · joyful");
  assert.deepEqual(v.tint, { name: "sprite-joyful", css: sc.MOOD_TINTS.joyful });
  assert.match(v.tooltip, /^Pip · child · joyful · knows 3 things — click to open/);
});

test("every mood_label the engine can emit has a tint; an unknown one gets none", () => {
  for (const label of ["joyful", "content", "curious", "sleepy", "grumpy", "sad", "dormant"]) {
    assert.match(sc.spriteView({ ...ME, mood_label: label }).tint.css, /^#[0-9a-f]{6}$/i, label);
  }
  const odd = sc.spriteView({ ...ME, mood_label: "ecstatic" });
  assert.equal(odd.tint, null, "no guessed colour: the fairy keeps its own");
  assert.equal(odd.line, "Pip · child · ecstatic");
});

test("a /me/status body that wraps the sprite is read the same way", () => {
  assert.equal(sc.spriteView({ sprite: ME, events: [] }).line, "Pip · child · joyful");
});

test("anything that is not a sprite is null (the plain fairy)", () => {
  assert.equal(sc.spriteView(null), null);
  assert.equal(sc.spriteView({ detail: "authenticated user required" }), null);
  assert.equal(sc.spriteView({ name: "Pip", stage: "dragon" }), null, "unknown stage");
  assert.equal(sc.spriteView({ name: "", stage: "egg" }), null, "no name");
});

test("statusLine says the sprite, or why it is out of reach", () => {
  assert.equal(sc.statusLine(sc.spriteView(ME)), "Pip is a child, feeling joyful · knows 3 things.");
  assert.match(sc.statusLine(null, { reason: "signed-out" }), /Sign in/);
  assert.match(sc.statusLine(null, { reason: "no-sprite" }), /hatch/);
  assert.match(sc.statusLine(null, { reason: "refused" }), /refused/);
  assert.match(sc.statusLine(null, { reason: "offline" }), /out of reach/);
});

test("teachPayload: typed text first, then the clipboard, then the last snip's caption", () => {
  assert.deepEqual(sc.teachPayload({ arg: "Jason likes tea", clipboard: "x" }),
    { kind: "fact", title: "Jason likes tea", content: "Jason likes tea", source: "arg" });
  assert.equal(sc.teachPayload({ arg: "", clipboard: "copied text" }).source, "clipboard");
  const snip = sc.teachPayload({ clipboard: "  ", lastCaption: "A diagram of the mesh." });
  assert.equal(snip.source, "snip");
  assert.equal(snip.content, "A diagram of the mesh.");
  assert.equal(sc.teachPayload({ clipboard: "", lastCaption: "" }), null, "nothing to teach");
});

test("teachPayload: a file path is a link named for the file; JSON args are honoured", () => {
  const p = sc.teachPayload({ arg: "C:\\Users\\me\\notes\\plan.md" });
  assert.deepEqual(p, { kind: "link", title: "plan.md", content: "C:\\Users\\me\\notes\\plan.md", source: "path" });
  const posix = sc.teachPayload({ arg: JSON.stringify({ path: "/home/me/todo.txt", title: "Todo" }) });
  assert.equal(posix.kind, "link");
  assert.equal(posix.title, "Todo");
  const cap = sc.teachPayload({ arg: JSON.stringify({ caption: "Two charts" }) });
  assert.equal(cap.source, "snip");
});

test("teachPayload respects the TeachBody limits (title 120, content 4000)", () => {
  const p = sc.teachPayload({ arg: `${"a".repeat(200)}\n${"b".repeat(5000)}` });
  assert.ok(p.title.length <= sc.TITLE_MAX);
  assert.ok(p.content.length <= sc.CONTENT_MAX);
});

test("looksSecret catches the common token shapes and not ordinary text", () => {
  assert.equal(sc.looksSecret(`key ${"ghp"}_${"A".repeat(30)}`), true);
  assert.equal(sc.looksSecret(`-----BEGIN ${"OPENSSH"} PRIVATE KEY-----`), true);
  assert.equal(sc.looksSecret("the fleet runs on awnix"), false);
});

function fakeFetch(status, body, calls = []) {
  return async (url, init) => {
    calls.push({ url, init });
    return { ok: status >= 200 && status < 300, status, json: async () => body };
  };
}

test("client: status reads /api/sprite/me with the desk's bearer", async () => {
  const calls = [];
  const c = sc.createSpriteClient({ fetchImpl: fakeFetch(200, ME, calls), token: async () => "desk-tok",
    env: { AITHER_PORTAL_URL: "https://portal.test/" } });
  const r = await c.status();
  assert.equal(r.ok, true);
  assert.equal(r.view.name, "Pip");
  assert.equal(calls[0].url, "https://portal.test/api/sprite/me");
  assert.equal(calls[0].init.headers.Authorization, "Bearer desk-tok");
});

test("client: signed out (no desk bearer, no adk profile) never calls the network", async () => {
  const calls = [];
  const c = sc.createSpriteClient({ fetchImpl: fakeFetch(200, ME, calls), token: async () => null, fallbackToken: () => "" });
  assert.deepEqual(await c.status(), { ok: false, reason: "signed-out", view: null });
  assert.equal(calls.length, 0);
});

test("client: offline / refused / no sprite all degrade without throwing", async () => {
  const down = sc.createSpriteClient({ fetchImpl: async () => { throw new Error("ENOTFOUND"); }, token: "t" });
  assert.equal((await down.status()).reason, "offline");
  const refused = sc.createSpriteClient({ fetchImpl: fakeFetch(401, { detail: "authenticated user required" }), token: "t" });
  assert.equal((await refused.status()).reason, "refused");
  const none = sc.createSpriteClient({ fetchImpl: fakeFetch(404, { detail: "no sprite" }), token: "t" });
  assert.equal((await none.status()).reason, "no-sprite");
  const junk = sc.createSpriteClient({ fetchImpl: fakeFetch(200, { hello: 1 }), token: "t" });
  assert.equal((await junk.status()).reason, "no-sprite");
});

test("client: a provider that throws falls back to the adk login bearer", async () => {
  const calls = [];
  const c = sc.createSpriteClient({ fetchImpl: fakeFetch(200, ME, calls),
    token: async () => { throw new Error("no session"); }, fallbackToken: () => "adk-tok" });
  assert.equal((await c.status()).ok, true);
  assert.equal(calls[0].init.headers.Authorization, "Bearer adk-tok");
});

test("client: teach POSTs {kind,title,content} to /me/teach", async () => {
  const calls = [];
  const c = sc.createSpriteClient({ fetchImpl: fakeFetch(200, { ok: true }, calls), token: "t",
    env: { AITHER_PORTAL_URL: "https://portal.test" } });
  const r = await c.teach({ kind: "fact", title: "T", content: "C", source: "arg" });
  assert.equal(r.ok, true);
  assert.equal(calls[0].url, "https://portal.test/api/sprite/me/teach");
  assert.equal(calls[0].init.method, "POST");
  assert.deepEqual(JSON.parse(calls[0].init.body), { kind: "fact", title: "T", content: "C" });
});
