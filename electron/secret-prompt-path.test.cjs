"use strict";

/**
 * secret-prompt-path.cjs -- the credential row must never hand a typed secret to
 * a secret_prompt.py that cannot read it from stdin (2026-10-07: a stale copy in
 * the default checkout made every "Store in vault" press fail).
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { resolveSecretPromptScript } = require("./secret-prompt-path.cjs");

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

test("skips a stale copy on the walk and takes the default that speaks stdin", () => {
  const { root, app } = tree();
  put(path.join(root, "desk", "AitherOS", "scripts", "secret_prompt.py"), "parser.add_argument('--card')\n");
  const fresh = path.join(root, "fresh", "secret_prompt.py");
  put(fresh, "parser.add_argument('--value-stdin')\n");
  const got = resolveSecretPromptScript({ startDir: app, env: {}, fallback: fresh });
  assert.deepEqual(got, { path: fresh, stale: false });
});

test("a fresh copy on the walk wins over the default", () => {
  const { root, app } = tree();
  const near = path.join(root, "desk", "AitherOS", "scripts", "secret_prompt.py");
  put(near, "'--value-stdin'\n");
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

test("main.cjs refuses a stale script instead of spawning it", () => {
  const main = fs.readFileSync(path.join(__dirname, "main.cjs"), "utf8");
  assert.match(main, /secret-prompt-path\.cjs/);
  assert.match(main, /if \(resolved\.stale\)/);
});
