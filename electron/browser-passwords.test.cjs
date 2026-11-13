"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  createVault, normalizeOrigin, shouldOffer, fillScript, CAPTURE_SCRIPT, PENDING_SCRIPT, detectLoginScript,
} = require("./browser-passwords.cjs");

function tmpFile() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), "awdesk-pw-")), "browser-passwords.json");
}

// Reversible stand-in for DPAPI: reversed bytes, so the plaintext never appears on disk.
function fakeSafeStorage(available = true) {
  return {
    isEncryptionAvailable: () => available,
    encryptString: (s) => Buffer.from(Buffer.from(`enc:${s}`, "utf8").reverse()),
    decryptString: (b) => {
      const s = Buffer.from(b).reverse().toString("utf8");
      if (!s.startsWith("enc:")) throw new Error("bad blob");
      return s.slice(4);
    },
  };
}

const SECRET = "hunter2-Sup3r\"secret'</script>";

test("add, update in place, forOrigin hides passwords, reveal and remove", () => {
  let t = 0;
  const vault = createVault({ file: tmpFile(), safeStorage: fakeSafeStorage(), now: () => ++t });
  const a = vault.add({ origin: "https://login.example.com/signin?x=1", username: "david", password: "one" });
  assert.deepEqual([a.ok, a.updated], [true, false]);
  const b = vault.add({ origin: "https://login.example.com:443/other", username: "david", password: "two" });
  assert.deepEqual([b.ok, b.updated, b.id], [true, true, a.id]);
  vault.add({ origin: "https://login.example.com", username: "ops", password: "three" });
  assert.equal(vault.count(), 2);

  const rows = vault.forOrigin("https://login.example.com/anything");
  assert.deepEqual(rows.map((r) => r.username), ["ops", "david"]);
  for (const r of rows) assert.deepEqual(Object.keys(r).sort(), ["id", "username"]);
  for (const r of vault.list()) assert.equal("password" in r || "enc" in r, false);
  assert.deepEqual(vault.forOrigin("https://other.example.com/"), []);
  assert.deepEqual(vault.forOrigin("https://login.example.com:8443/"), [], "a different port is a different origin");

  assert.equal(vault.reveal(a.id), "two");
  assert.equal(vault.reveal("nope"), null);
  assert.equal(vault.remove(a.id), true);
  assert.equal(vault.remove(a.id), false);
  assert.equal(vault.count(), 1);
});

test("the vault persists across instances and the file never holds the plaintext", () => {
  const file = tmpFile();
  const v1 = createVault({ file, safeStorage: fakeSafeStorage() });
  const { id } = v1.add({ origin: "https://a.test", username: "me@a.test", password: SECRET });
  const raw = fs.readFileSync(file, "utf8");
  assert.equal(raw.includes(SECRET), false);
  assert.equal(raw.includes("hunter2"), false);
  const v2 = createVault({ file, safeStorage: fakeSafeStorage() });
  assert.deepEqual(v2.list().map((e) => [e.id, e.origin, e.username]), [[id, "https://a.test", "me@a.test"]]);
  assert.equal(v2.reveal(id), SECRET);
  assert.ok(!fs.readdirSync(path.dirname(file)).some((f) => f.endsWith(".tmp")), "no temp file is left behind");
  fs.writeFileSync(file, "{not json");
  assert.equal(createVault({ file, safeStorage: fakeSafeStorage() }).count(), 0);
});

test("nothing is stored when OS encryption is unavailable", () => {
  const file = tmpFile();
  const vault = createVault({ file, safeStorage: fakeSafeStorage(false) });
  const r = vault.add({ origin: "https://a.test", username: "u", password: "p" });
  assert.equal(r.ok, false);
  assert.match(r.error, /encryption/);
  assert.equal(vault.count(), 0);
  assert.equal(fs.existsSync(file), false);
});

test("only https and localhost http origins are accepted", () => {
  const vault = createVault({ file: tmpFile(), safeStorage: fakeSafeStorage() });
  for (const origin of ["http://a.test", "http://10.0.0.5", "aither://browser", "chrome-extension://abc/x.html",
    "file:///C:/x", "data:text/html,x", "javascript:1", ""]) {
    assert.equal(vault.add({ origin, username: "u", password: "p" }).ok, false, origin);
  }
  assert.equal(vault.add({ origin: "https://a.test", username: "u", password: "" }).ok, false, "empty password");
  assert.equal(vault.add({ origin: "http://localhost:3000/login", username: "u", password: "p" }).ok, true);
  assert.equal(vault.add({ origin: "http://127.0.0.1:8080/", username: "u", password: "p" }).ok, true);
  assert.equal(normalizeOrigin("https://u:p@a.test:443/x?y#z"), "https://a.test");
});

test("shouldOffer: only the owner's tab on https or localhost", () => {
  const cases = [
    [{ tabBy: "you", url: "https://a.test/login" }, true],
    [{ tabBy: "you", url: "http://localhost:5173/" }, true],
    [{ tabBy: "you", url: "http://127.0.0.1/" }, true],
    [{ tabBy: "agent", url: "https://a.test/login" }, false],
    [{ tabBy: "agent", url: "http://localhost/" }, false],
    [{ tabBy: undefined, url: "https://a.test/" }, false],
    [{ tabBy: "you", url: "http://a.test/" }, false],
    [{ tabBy: "you", url: "aither://browser/settings" }, false],
    [{ tabBy: "you", url: "chrome-extension://abcdef/popup.html" }, false],
    [{ tabBy: "you", url: "about:blank" }, false],
    [{ tabBy: "you", url: "" }, false],
  ];
  for (const [input, want] of cases) assert.equal(shouldOffer(input), want, JSON.stringify(input));
  assert.equal(shouldOffer(), false);
});

test("the isolated-world scripts parse", () => {
  for (const code of [CAPTURE_SCRIPT, PENDING_SCRIPT, detectLoginScript, fillScript("u", "p")]) {
    assert.doesNotThrow(() => new Function(`return ${code}`), code.slice(0, 40));
  }
});

test("fillScript embeds hostile values as inert string literals", () => {
  const nasty = `a"b'c\\d</script><script>alert(1)</script>\u2028\`\${x}`;
  const code = fillScript(`user"</script>`, nasty);
  assert.doesNotThrow(() => new Function(`return ${code}`));
  assert.equal(code.includes("</script>"), false);
  assert.equal(code.includes("\u2028"), false);
  const literal = (name) => JSON.parse(code.match(new RegExp(`const ${name} = (".*");`))[1]);
  assert.equal(literal("PASSWORD"), nasty);
  assert.equal(literal("USERNAME"), `user"</script>`);
});

test("capture delivery: only main's key decodes a login; a forged or replayed message is refused", () => {
  const P = require("./browser-passwords.cjs");
  const key = P.newCaptureKey();
  const code = P.captureScriptFor(key);
  assert.doesNotThrow(() => new Function(code));
  assert.ok(!code.includes("aither.passwords.capture\")"), "a keyed guard per document");
  // Encode the way the page script does, from main's side, then decode.
  const enc = (k, obj) => {
    const bytes = Buffer.from(JSON.stringify(obj), "utf8");
    const out = Buffer.alloc(bytes.length);
    for (let i = 0; i < bytes.length; i += 1) out[i] = bytes[i] ^ k.pad[i];
    return P.CHANNEL + out.toString("base64");
  };
  const msg = enc(key, { t: key.token, origin: "https://a.test", username: "me", password: "p\"w" });
  assert.deepEqual(P.decodeCaptured(msg, key), { origin: "https://a.test", username: "me", password: "p\"w" });
  assert.equal(P.decodeCaptured(msg, P.newCaptureKey()), null, "another document's key");
  assert.equal(P.decodeCaptured(enc(key, { t: "forged", origin: "https://a.test", password: "x" }), key), null);
  assert.equal(P.decodeCaptured(`${P.CHANNEL}not base64 !!`, key), null);
  assert.equal(P.decodeCaptured("hello", key), null);
});
