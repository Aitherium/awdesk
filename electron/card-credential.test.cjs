"use strict";

/**
 * card-credential.cjs -- "Store in vault" is a success ONLY when the card says
 * answered. 2026-10-15: a stale door wrote the vault, printed "NOT closed",
 * exited 0, and the desk showed success while the card stayed open.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { EventEmitter } = require("node:events");
const { PassThrough } = require("node:stream");
const { storeCredential, readLocalStatus } = require("./card-credential.cjs");

const SECRET = "hunter2-probe-value";
const CARD = { id: "d-abcd", kind: "credential", secretName: "OWNER_ASK_PROBE", credentialScope: "platform" };

/** A fake child that reads stdin, then prints `out`/`err` and exits `code`. */
function fakeSpawn({ code = 0, out = "", err = "" } = {}) {
  const calls = [];
  const spawnFn = (bin, args, opts) => {
    const child = new EventEmitter();
    child.stdin = new PassThrough();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = () => {};
    const call = { bin, args, opts, stdin: "" };
    calls.push(call);
    child.stdin.on("data", (c) => { call.stdin += c; });
    child.stdin.on("end", () => {
      setImmediate(() => {
        child.stdout.end(out);
        child.stderr.end(err);
        setImmediate(() => child.emit("close", code));
      });
    });
    return child;
  };
  return { spawnFn, calls };
}

function scriptFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "awdesk-cc-"));
  const file = path.join(dir, "secret_prompt.py");
  fs.writeFileSync(file, "DESK_DOOR_PROTOCOL = 2\n");
  return file;
}

function run(overrides) {
  const lines = [];
  const script = scriptFile();
  return storeCredential({
    card: CARD,
    value: SECRET,
    resolveScript: () => ({ path: script, stale: false }),
    python: "python",
    statusTries: 2,
    statusGapMs: 1,
    log: (entry) => lines.push(JSON.stringify(entry)),
    ...overrides,
  }).then((verdict) => ({ verdict, lines }));
}

test("exit 0 + 'NOT closed' + card still open -> ok:false with a reason (the 2026-10-15 bug)", async () => {
  const { spawnFn } = fakeSpawn({ code: 0, out: "vaulted, but card d-abcd NOT closed — awask needs a receipt" });
  const { verdict, lines } = await run({ spawnFn, readStatus: async () => "open" });
  assert.equal(verdict.ok, false);
  assert.equal(verdict.status, "open");
  assert.match(verdict.error, /Not confirmed/);
  assert.match(verdict.error, /d-abcd is open, not answered/);
  assert.equal(lines.length, 1);
  assert.equal(JSON.parse(lines[0]).ok, false);
});

test("exit 0 + card answered -> ok:true with the receipt", async () => {
  const { spawnFn, calls } = fakeSpawn({ code: 0, out: "stored, 19 chars (OWNER_ASK_PROBE) — card d-abcd closed" });
  const { verdict, lines } = await run({ spawnFn, readStatus: async () => "answered" });
  assert.equal(verdict.ok, true);
  assert.match(verdict.receipt, /stored, 19 chars/);
  // The value went on stdin and nowhere else.
  assert.equal(calls[0].stdin, SECRET);
  assert.ok(!calls[0].args.some((a) => String(a).includes(SECRET)));
  assert.deepEqual(calls[0].args.slice(1), ["--card", "d-abcd", "--value-stdin", "--name", "OWNER_ASK_PROBE", "--scope", "platform"]);
  assert.equal(lines.length, 1);
  const entry = JSON.parse(lines[0]);
  assert.equal(entry.ok, true);
  assert.equal(entry.status, "answered");
  assert.equal(entry.card, "d-abcd");
  assert.ok(!lines[0].includes(SECRET), "the log line must never hold the value");
});

test("a card that cannot be re-read is not a success", async () => {
  const { spawnFn } = fakeSpawn({ code: 0, out: "stored" });
  const { verdict } = await run({ spawnFn, readStatus: async () => "" });
  assert.equal(verdict.ok, false);
  assert.match(verdict.error, /could not be re-read/);
});

test("a non-zero exit is a failure carrying the child's reason", async () => {
  const { spawnFn } = fakeSpawn({ code: 1, err: "NOT stored — cannot reach the vault" });
  const { verdict, lines } = await run({ spawnFn, readStatus: async () => "answered" });
  assert.equal(verdict.ok, false);
  assert.equal(verdict.code, 1);
  assert.match(verdict.error, /cannot reach the vault/);
  assert.equal(JSON.parse(lines[0]).code, 1);
});

test("the value is scrubbed from anything the child echoes back", async () => {
  const { spawnFn } = fakeSpawn({ code: 1, err: `bad value ${SECRET}` });
  const { verdict, lines } = await run({ spawnFn, readStatus: async () => "open" });
  assert.ok(!JSON.stringify(verdict).includes(SECRET));
  assert.ok(!lines.join("\n").includes(SECRET));
});

test("a stale script is refused before anything is spawned, and logged", async () => {
  const { spawnFn, calls } = fakeSpawn();
  const { verdict, lines } = await run({ spawnFn, resolveScript: () => ({ path: "/old/secret_prompt.py", stale: true }) });
  assert.equal(verdict.ok, false);
  assert.match(verdict.error, /too old/);
  assert.equal(calls.length, 0);
  assert.equal(lines.length, 1);
});

test("the default log is one JSONL line per attempt under AWDESK_CREDENTIAL_LOG", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "awdesk-cclog-"));
  const logFile = path.join(dir, "logs", "awdesk-credential.jsonl");
  const prev = process.env.AWDESK_CREDENTIAL_LOG;
  process.env.AWDESK_CREDENTIAL_LOG = logFile;
  try {
    const { spawnFn } = fakeSpawn({ code: 0, out: "stored" });
    const script = scriptFile();
    await storeCredential({ card: CARD, value: SECRET, resolveScript: () => ({ path: script, stale: false }),
      spawnFn, readStatus: async () => "answered", statusTries: 1 });
    await storeCredential({ card: CARD, value: SECRET, resolveScript: () => ({ path: script, stale: false }),
      spawnFn, readStatus: async () => "open", statusTries: 1 });
  } finally {
    if (prev === undefined) delete process.env.AWDESK_CREDENTIAL_LOG; else process.env.AWDESK_CREDENTIAL_LOG = prev;
  }
  const text = fs.readFileSync(logFile, "utf8");
  const rows = text.trim().split("\n").map((l) => JSON.parse(l));
  assert.deepEqual(rows.map((r) => r.ok), [true, false]);
  assert.ok(rows.every((r) => r.ts && r.card === "d-abcd" && r.secret_name === "OWNER_ASK_PROBE"));
  assert.ok(!text.includes(SECRET));
});

test("readLocalStatus reads the store the door wrote", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "awdesk-ccstore-"));
  fs.writeFileSync(path.join(dir, "d-abcd.json"), JSON.stringify({ id: "d-abcd", status: "answered" }));
  assert.equal(readLocalStatus("d-abcd", { env: { AITHER_DECISIONS_DIR: dir } }), "answered");
  assert.equal(readLocalStatus("d-none", { env: { AITHER_DECISIONS_DIR: dir } }), "");
});

