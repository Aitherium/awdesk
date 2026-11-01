"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const cs = require("./clipboard-sync.cjs");

// Built at runtime so this file itself carries no literal key shapes.
const fake = (prefix, body) => `${prefix}${body}`;

test("secret filter: credential shapes are refused", () => {
  const positives = [
    fake("sk-ant-", "api03-AbCdEfGhIjKlMnOpQrStUv"),
    fake("sk-", "proj-AbCdEfGhIjKlMnOpQrSt1234"),
    fake("ghp_", "A1b2C3d4E5f6G7h8I9j0K1l2M3n4"),
    fake("ghs_", "A1b2C3d4E5f6G7h8I9j0K1l2M3n4"),
    fake("AKIA", "IOSFODNN7EXAMPLE"),
    fake("pk_live_", "51Habcdefghij0123"),
    fake("sk_live_", "51Habcdefghij0123"),
    fake("xoxb-", "1234567890-abcdefghij"),
    fake("xoxp-", "1234567890-abcdefghij"),
    `${"-----BEGIN"} OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAA\n-----END OPENSSH PRIVATE KEY-----`,
    `export TOKEN=${fake("ghp_", "A1b2C3d4E5f6G7h8I9j0K1l2M3n4")}`,
    "password = hunter2hunter2",
    "Zx9Qm2Lp7Vt4Rb8Nc1Hd6Kf3Wg5Ys0Ja", // a bare high-entropy mixed-case token
  ];
  for (const text of positives) assert.equal(cs.looksSecret(text), true, `missed: ${text.slice(0, 12)}…`);
});

test("secret filter: ordinary clips sync", () => {
  const negatives = [
    "hello world",
    "https://aitherium.com/docs/getting-started?tab=desk",
    "C:\\Users\\wzns\\Pictures\\Aither Screenshots\\Screenshot 2026-11-01 120000.png",
    "300a3b942d9f0c1e2b3a4d5e6f708192a3b4c5d6", // a git sha: hex, single case
    "123e4567-e89b-12d3-a456-426614174000", // a uuid
    "the desk-top sk- prefix in prose is fine",
    "internationalization",
    "const x = await fetch(url, { method: 'POST' });\nconsole.log(x.status);",
  ];
  for (const text of negatives) assert.equal(cs.looksSecret(text), false, `false positive: ${text}`);
});

test("text is capped at 64 KB on a UTF-8 boundary and says so", () => {
  const long = "é".repeat(40 * 1024); // 80 KB of 2-byte chars
  const capped = cs.capText(long);
  assert.equal(capped.truncated, true);
  assert.ok(Buffer.byteLength(capped.text, "utf8") <= cs.MAX_TEXT_BYTES);
  assert.ok(!capped.text.includes("\ufffd"), "a character was split");
  const p = cs.textPayload(long, { now: new Date(2026, 10, 1, 8, 9, 10), host: "box" });
  const body = JSON.parse(p.bytes.toString("utf8"));
  assert.equal(body.truncated, true);
  assert.equal(body.source_host, "box");
  assert.match(p.name, /^clip-20261101-080910-[0-9a-f]{8}\.json$/);
});

function harness({ on = true } = {}) {
  const state = { text: "", image: null, on };
  const pushed = [];
  const sync = cs.createClipboardSync({
    read: () => ({ text: state.text, image: state.image }),
    enqueue: (item) => { pushed.push(item); return { ok: true }; },
    enabled: () => state.on,
    now: () => new Date(2026, 10, 1, 12, 0, 0),
    host: "box",
    every: () => 1, stopEvery: () => {},
  });
  return { state, pushed, sync };
}

test("dedupe: the same copy is pushed once; a new copy is pushed again", () => {
  const { state, pushed, sync } = harness();
  state.text = "first";
  assert.equal(sync.tick().action, "text");
  assert.equal(sync.tick().action, "none");
  assert.equal(sync.tick().action, "none");
  state.text = "second";
  assert.equal(sync.tick().action, "text");
  assert.equal(pushed.length, 2);
  assert.equal(JSON.parse(pushed[1].bytes).text, "second");
  assert.equal(pushed[1].folder, "clipboard");
  assert.equal(pushed[1].contentType, "application/json");
});

test("images are pushed as PNG once per fingerprint", () => {
  const { state, pushed, sync } = harness();
  const png = Buffer.from("png-bytes");
  state.image = { fingerprint: "10x10:aa", png: () => png };
  assert.equal(sync.tick().action, "image");
  assert.equal(sync.tick().action, "none");
  assert.equal(pushed[0].contentType, "image/png");
  assert.match(pushed[0].name, /\.png$/);
  assert.deepEqual(pushed[0].bytes, png);
});

test("a secret is skipped, counted, and not retried every second", () => {
  const { state, pushed, sync } = harness();
  state.text = fake("ghp_", "A1b2C3d4E5f6G7h8I9j0K1l2M3n4");
  assert.equal(sync.tick().action, "skipped-secret");
  assert.equal(sync.tick().action, "none");
  assert.equal(pushed.length, 0);
  assert.equal(sync.stats().skippedSecret, 1);
});

test("off by default: nothing is read or pushed while the switch is off", () => {
  const { state, pushed, sync } = harness({ on: false });
  state.text = "x";
  assert.equal(sync.tick().action, "off");
  assert.equal(pushed.length, 0);
  // start() adopts what is already there, so turning on does not backfill it.
  state.on = true;
  sync.start();
  assert.equal(sync.tick().action, "none");
  state.text = "new";
  assert.equal(sync.tick().action, "text");
});

test("adoptCurrent: a snip's own clipboard write is not mirrored", () => {
  const { state, pushed, sync } = harness();
  state.image = { fingerprint: "snip", png: () => Buffer.from("p") };
  sync.adoptCurrent();
  assert.equal(sync.tick().action, "none");
  assert.equal(pushed.length, 0);
});

test("the switch persists in cast.json and defaults off", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "clip-cast-"));
  const file = path.join(dir, "cast.json");
  fs.writeFileSync(file, JSON.stringify({ version: 1 }));
  const desk = require("./desk-settings.cjs");
  assert.equal(desk.current({ file, env: {} }).clipboard.sync, false);
  assert.equal(cs.setSyncEnabled(true, { file }), true);
  assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).clipboard.sync, true);
  assert.equal(desk.current({ file, env: {} }).clipboard.sync, true);
  cs.setSyncEnabled(false, { file });
  assert.equal(desk.current({ file, env: {} }).clipboard.sync, false);
});
