"use strict";

/**
 * awconnect-setup.cjs -- the "Set up Awconnect" action and the tray status line.
 *
 * What must hold: desk only ever runs `python -m adk.cli awconnect …` (one
 * implementation); every adk state has a line a human can act on; a missing
 * awdk is a sentence, not a throw; a stale copy loaded from OUR folder is
 * refreshed in place while one loaded from elsewhere gets the guided install;
 * an already-installed extension runs nothing.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const aw = require("./awconnect-setup.cjs");

function fakeExec(answers) {
  const calls = [];
  const execFile = (cmd, argv, opts, cb) => {
    calls.push({ cmd, argv });
    const key = argv.slice(3).join(" ");
    const a = answers[key] || answers["*"] || { stdout: "", stderr: "" };
    setImmediate(() => cb(a.err || null, a.stdout || "", a.stderr || ""));
  };
  return { execFile, calls };
}

const hit = (over = {}) => ({
  browser: "chrome", browser_name: "Google Chrome", profile: "Default", version: "3.8.0",
  enabled: true, uses_current: true, stale: false, ...over,
});

test("argv is always adk.cli awconnect with --json", () => {
  assert.deepEqual(aw.adkArgv("status"), ["-m", "adk.cli", "awconnect", "status", "--json"]);
  assert.deepEqual(aw.adkArgv("install").slice(0, 5), ["-m", "adk.cli", "awconnect", "install", "--json"]);
  assert.ok(aw.adkArgv("update").includes("--update"));
  assert.throws(() => aw.adkArgv("rm -rf"));
});

test("status lines for every state", () => {
  assert.match(aw.statusLine({ state: "installed", hits: [hit()] }), /installed 3\.8\.0 \(Google Chrome \/ Default\)/);
  assert.match(aw.statusLine({ state: "stale", hits: [hit({ stale: true })], latest: { version: "3.9.0" } }), /stale 3\.8\.0.*3\.9\.0 ready/);
  assert.match(aw.statusLine({ state: "disabled", hits: [hit({ enabled: false })] }), /disabled/);
  assert.equal(aw.statusLine({ state: "not_installed", hits: [] }), "Awconnect: not installed");
  assert.equal(aw.setupLabel({ state: "not_installed" }), "Set up Awconnect…");
  assert.equal(aw.setupLabel(null), "Set up Awconnect…");
  assert.equal(aw.setupLabel({ state: "stale" }), "Update Awconnect…");
  assert.deepEqual(aw.awconnectTrayItems(null), []);
  assert.equal(aw.awconnectTrayItems({ state: "not_installed", hits: [] })[0].enabled, false);
});

test("probe: missing awdk is a sentence, not a throw", async () => {
  const { execFile } = fakeExec({ "*": { err: new Error("exit 1"), stderr: "No module named adk" } });
  const st = await aw.probeAwconnect({ execFile, env: {} });
  assert.equal(st.state, "unknown");
  assert.match(st.line, /needs awdk/);
});

test("probe: tolerates a notice line before the JSON", async () => {
  const body = JSON.stringify({ state: "installed", hits: [hit()], latest: { version: "3.8.0" } });
  const { execFile } = fakeExec({ "status --json": { stdout: `update available\n${body}` } });
  const st = await aw.probeAwconnect({ execFile, env: {} });
  assert.equal(st.state, "installed");
  assert.match(st.line, /installed/);
});

test("setup: not installed -> guided install, steps surfaced", async () => {
  const { execFile, calls } = fakeExec({
    "status --json": { stdout: JSON.stringify({ state: "not_installed", hits: [] }) },
    "install --json --wait 0": { stdout: JSON.stringify({
      ok: true, staged: { version: "3.8.0", path: "C:/u/.aither/awconnect/current" },
      steps: ["turn on Developer mode", "Load unpacked"],
    }) },
  });
  const r = await aw.runAwconnectSetup({ execFile, env: {} });
  assert.equal(r.ok, true);
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[1].argv, aw.adkArgv("install"));
  assert.match(r.message, /1\. turn on Developer mode\n2\. Load unpacked/);
});

test("setup: stale from OUR folder -> in-place update; from elsewhere -> install", async () => {
  const ours = fakeExec({ "*": { stdout: JSON.stringify({ ok: true, staged: { version: "3.9.0" } }) } });
  const r1 = await aw.runAwconnectSetup({ execFile: ours.execFile, env: {},
    status: { state: "stale", hits: [hit({ stale: true })] } });
  assert.ok(ours.calls[0].argv.includes("--update"));
  assert.match(r1.message, /reload arrow/);

  const elsewhere = fakeExec({ "*": { stdout: JSON.stringify({ ok: true, staged: { version: "3.9.0" }, steps: [] }) } });
  await aw.runAwconnectSetup({ execFile: elsewhere.execFile, env: {},
    status: { state: "stale", hits: [hit({ stale: true, uses_current: false })] } });
  assert.ok(!elsewhere.calls[0].argv.includes("--update"));
});

test("setup: already installed runs nothing", async () => {
  const { execFile, calls } = fakeExec({});
  const r = await aw.runAwconnectSetup({ execFile, env: {}, status: { state: "installed", hits: [hit()], line: "Awconnect: installed" } });
  assert.equal(r.ok, true);
  assert.equal(calls.length, 0);
});

test("setup: adk refusal (checksum) is reported, not swallowed", async () => {
  const { execFile } = fakeExec({ "*": { stdout: JSON.stringify({ ok: false, error: "checksum mismatch" }) } });
  const r = await aw.runAwconnectSetup({ execFile, env: {}, status: { state: "not_installed", hits: [] } });
  assert.equal(r.ok, false);
  assert.match(r.message, /checksum mismatch/);
});

test("main.cjs routes awconnect.setup and renders the status row", () => {
  const main = fs.readFileSync(path.join(__dirname, "main.cjs"), "utf8");
  assert.match(main, /case "awconnect\.setup":/);
  assert.match(main, /awconnectTrayItems\(/);
});
