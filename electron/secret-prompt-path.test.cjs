"use strict";

/**
 * secret-prompt-path.cjs -- the credential row must never hand a typed secret to
 * a secret_prompt.py that does not speak the desk-door contract.
 * 2026-10-07: a copy without `--value-stdin` made every "Store in vault" fail.
 * 2026-10-15: a copy WITH `--value-stdin` but no DESK_DOOR_PROTOCOL exited 0
 * with the card still open, and the desk called that success.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { resolveSecretPromptScript, doorProtocol, DESK_DOOR_PROTOCOL } = require("./secret-prompt-path.cjs");

const FRESH = "parser.add_argument('--value-stdin')\nDESK_DOOR_PROTOCOL = 2\n";

function tree() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "awdesk-sp-"));
  const app = path.join(root, "desk", "electron");
  fs.mkdirSync(app, { recursive: true });
  return { root, app };
}

function put(file, body) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, body);
}

test("skips a stale copy on the walk and takes the default that speaks the door", () => {
  const { root, app } = tree();
  put(path.join(root, "desk", "AitherOS", "scripts", "secret_prompt.py"), "parser.add_argument('--card')\n");
  const fresh = path.join(root, "fresh", "secret_prompt.py");
  put(fresh, FRESH);
  const got = resolveSecretPromptScript({ startDir: app, env: {}, fallback: fresh });
  assert.deepEqual(got, { path: fresh, stale: false });
});

test("a copy that speaks --value-stdin but carries no DESK_DOOR_PROTOCOL is skipped (2026-10-15)", () => {
  const { root, app } = tree();
  // The D:\AitherOS\scripts copy: has the flag, exits 0 with "NOT closed".
  const loose = path.join(root, "AitherOS", "scripts", "secret_prompt.py");
  put(loose, "ap.add_argument('--value-stdin')\nprint(f'vaulted, but card {card_id} NOT closed')\n");
  const fresh = path.join(root, "fresh", "secret_prompt.py");
  put(fresh, FRESH);
  const got = resolveSecretPromptScript({ startDir: app, env: {}, fallback: fresh });
  assert.deepEqual(got, { path: fresh, stale: false });
});

test("an older protocol number is stale too", () => {
  const { root, app } = tree();
  const near = path.join(root, "desk", "AitherOS", "scripts", "secret_prompt.py");
  put(near, "'--value-stdin'\nDESK_DOOR_PROTOCOL = 1\n");
  const got = resolveSecretPromptScript({ startDir: app, env: {}, fallback: path.join(root, "nope.py") });
  assert.deepEqual(got, { path: near, stale: true });
});

test("a fresh copy on the walk wins over the default", () => {
  const { root, app } = tree();
  const near = path.join(root, "desk", "AitherOS", "scripts", "secret_prompt.py");
  put(near, FRESH);
  const got = resolveSecretPromptScript({ startDir: app, env: {}, fallback: path.join(root, "nope.py") });
  assert.deepEqual(got, { path: near, stale: false });
});

test("every copy stale -> the first one comes back marked stale", () => {
  const { root, app } = tree();
  const near = path.join(root, "desk", "AitherOS", "scripts", "secret_prompt.py");
  put(near, "old\n");
  const far = path.join(root, "far.py");
  put(far, "also old\n");
  const got = resolveSecretPromptScript({ startDir: app, env: {}, fallback: far });
  assert.deepEqual(got, { path: near, stale: true });
});

test("the env override is taken as-is", () => {
  const got = resolveSecretPromptScript({ startDir: "/x", env: { AWDESK_SECRET_PROMPT_SCRIPT: " /o/sp.py " } });
  assert.deepEqual(got, { path: "/o/sp.py", stale: false });
});

test("the repo's own secret_prompt.py declares the protocol the desk requires", () => {
  const repo = path.join(__dirname, "..", "..", "..", "AitherOS", "scripts", "secret_prompt.py");
  if (!fs.existsSync(repo)) return; // a desk-only checkout has no AitherOS tree
  assert.ok(doorProtocol(repo) >= DESK_DOOR_PROTOCOL, `${repo} must declare DESK_DOOR_PROTOCOL >= ${DESK_DOOR_PROTOCOL}`);
});

test("main.cjs routes the press through card-credential.cjs, which refuses a stale script", () => {
  const main = fs.readFileSync(path.join(__dirname, "main.cjs"), "utf8");
  assert.match(main, /secret-prompt-path\.cjs/);
  assert.match(main, /card-credential\.cjs/);
  const door = fs.readFileSync(path.join(__dirname, "card-credential.cjs"), "utf8");
  assert.match(door, /if \(resolved\.stale\)/);
});
