"use strict";

// GUARD: the relay bearer never rides on an awrelay command line.
//
// Measured 2026-10-08: the desk spawned
//   awrelay.exe --url https://127.0.0.1:8205 --token <bearer> --json history #agents --limit 30
// every few seconds, so the session bearer sat in every process listing (WMI
// Win32_Process.CommandLine, Task Manager, `ps`) for any local process to read.
// The bearer now travels as AWRELAY_TOKEN in the child's environment, which the
// awrelay CLI reads when --token is absent.
//
// Two layers, so a regression is caught whichever way it comes back:
//   1. behaviour -- run the real spawn path with a fake spawn and a sentinel
//      bearer; argv must not carry --token or the bearer, env must carry it.
//   2. source    -- no shipped source file that spawns awrelay may contain a
//      "--token" argument literal.
// Assertion messages never include the bearer value (secret-safety).

const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const { _runAwrelayForTests, _setBearerSourceForTests } = require("./relay-feed.cjs");

const SENTINEL = "sentinel-bearer-not-a-real-token-7f3a";

function capturingSpawn(calls) {
  return (cmd, args, opts) => {
    calls.push({ cmd, args: [...args], env: (opts && opts.env) || null });
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    queueMicrotask(() => {
      child.stdout.emit("data", "[]");
      child.emit("close", 0);
    });
    return child;
  };
}

test("awrelay spawn carries the bearer in env, never in argv", async () => {
  _setBearerSourceForTests(() => SENTINEL);
  try {
    const calls = [];
    const r = await _runAwrelayForTests(["--json", "history", "#agents", "--limit", "30"], capturingSpawn(calls));
    assert.equal(r.code, 0);
    assert.equal(calls.length, 1);
    const { args, env } = calls[0];
    assert.ok(!args.includes("--token"), "awrelay argv must not contain --token");
    assert.ok(!args.some((a) => String(a).includes(SENTINEL)), "awrelay argv must not contain the bearer");
    assert.ok(env && env.AWRELAY_TOKEN === SENTINEL, "the bearer must reach awrelay as AWRELAY_TOKEN in the child env");
    // Global flags still precede the subcommand.
    assert.deepEqual(args.slice(0, 1), ["--url"]);
  } finally {
    _setBearerSourceForTests(null);
  }
});

test("with no bearer, AWRELAY_TOKEN is removed from the child env, not inherited", async () => {
  const prev = process.env.AWRELAY_TOKEN;
  process.env.AWRELAY_TOKEN = "inherited-value-should-not-pass";
  _setBearerSourceForTests(() => "");
  try {
    const calls = [];
    await _runAwrelayForTests(["channels"], capturingSpawn(calls));
    assert.ok(!("AWRELAY_TOKEN" in calls[0].env), "an empty bearer must not forward an inherited AWRELAY_TOKEN");
    assert.ok(!calls[0].args.includes("--token"), "awrelay argv must not contain --token");
  } finally {
    _setBearerSourceForTests(null);
    if (prev === undefined) delete process.env.AWRELAY_TOKEN;
    else process.env.AWRELAY_TOKEN = prev;
  }
});

// ---------------------------------------------------------------------------
// Source scan
// ---------------------------------------------------------------------------

const ROOT = path.resolve(__dirname, "..");
const SCAN_DIRS = ["electron", "scripts", "src"];
const EXT = /\.(cjs|mjs|js|ts|tsx)$/;
const SKIP_DIRS = new Set(["node_modules", "dist", "build", "vendor"]);

function walk(dir, out) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (!SKIP_DIRS.has(e.name)) walk(p, out);
    } else if (EXT.test(e.name) && !/\.test\.(cjs|mjs|js|ts|tsx)$/.test(e.name)) {
      out.push(p);
    }
  }
  return out;
}

/** Files that spawn awrelay AND carry a "--token" argument literal. */
function offenders(files) {
  const bad = [];
  for (const f of files) {
    const src = fs.readFileSync(f, "utf8");
    if (!/awrelay/i.test(src)) continue;
    if (!/\b(spawn|spawnSync|execFile|execFileSync|exec|execSync|fork)\s*\(/.test(src) && !/spawnImpl|execFn/.test(src)) continue;
    // A "--token" STRING LITERAL (quoted), i.e. an argv element -- not prose in a comment.
    if (/(["'`])--token\1/.test(src) || /(["'`])--token=/.test(src)) bad.push(path.relative(ROOT, f));
  }
  return bad;
}

test("no shipped source passes --token to an awrelay spawn", () => {
  const files = SCAN_DIRS.flatMap((d) => walk(path.join(ROOT, d), []));
  assert.ok(files.length > 0, "the source scan found no files -- it cannot judge (wrong ROOT?)");
  assert.ok(files.some((f) => /relay-feed\.cjs$/.test(f)), "the scan must cover electron/relay-feed.cjs");
  assert.deepEqual(offenders(files), [], "an awrelay spawn passes --token on argv; pass AWRELAY_TOKEN in env instead");
});

test("self-test: the source scan flags a --token argv literal", () => {
  const tmp = fs.mkdtempSync(path.join(require("node:os").tmpdir(), "awdesk-argv-"));
  try {
    const f = path.join(tmp, "bad.cjs");
    fs.writeFileSync(f, 'const { spawn } = require("child_process");\nspawn("awrelay", ["--token", t, "history"]);\n');
    const ok = path.join(tmp, "ok.cjs");
    fs.writeFileSync(ok, '// never pass --token on argv\nconst { spawn } = require("child_process");\nspawn("awrelay", ["history"], { env });\n');
    const found = offenders([f, ok]).map((p) => path.basename(p));
    assert.deepEqual(found, ["bad.cjs"]);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
