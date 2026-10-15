"use strict";

/**
 * Darkmatter Link desk app: no network, no game, no Electron. The policy that matters:
 * training-data consent is OFF by default and moves only after the capture-pool tool
 * answered ok; the gateway key never rides argv; the registry row exists.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const dml = require("./darkmatter-link.cjs");
const { darkmatterLinkHandlers, _resetForTest } = require("./darkmatter-link-window.cjs");
const { COMMANDS, conformance } = require("./command-registry.cjs");

const KEY = ["aither", "sk", "live_TESTONLYabcdef123456"].join("_"); // fake, built so no scanner reads a key

function tmpHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "dml-test-"));
}

test("settings default: local model, voices on, harvest consent OFF", () => {
  const home = tmpHome();
  assert.deepEqual(dml.loadSettings({ home }), { model_mode: "local", harvest_pool_opt_in: false, voices: true });
  // Anything but a literal true is off; an unknown mode falls back to local.
  assert.equal(dml.normalizeSettings({ harvest_pool_opt_in: "yes" }).harvest_pool_opt_in, false);
  assert.equal(dml.normalizeSettings({ model_mode: "elsewhere" }).model_mode, "local");
});

test("status and games call the INSTALLED pack's dml_* tools (the desk is a launcher)", () => {
  const env = { AWDESK_DML_PACK: "C:/Packs/darkmatter-link" };
  const st = dml.buildCommand("status", env);
  assert.equal(st.args[0], "-c");
  assert.equal(st.args[1], dml.PACK_BRIDGE);
  assert.deepEqual(st.args.slice(2), ["dml_status", JSON.stringify({ game: "dd2" })]);
  assert.equal(st.cwd, "C:/Packs/darkmatter-link");
  assert.deepEqual(dml.buildCommand("games", env).args.slice(2), ["dml_games", JSON.stringify({ action: "list" })]);
  assert.equal(dml.buildCommand("games", {}, "C:/Home").cwd, path.join("C:/Home", ".aitheros", "packs", "darkmatter-link"));
  assert.match(dml.PACK_BRIDGE, /startswith\('dml_'\)/);
  assert.throws(() => dml.buildCommand("rm-rf", env));
});

test("unwrapTool returns the tool's data, or the whole verdict when it has none", () => {
  assert.deepEqual(dml.unwrapTool({ ok: true, rc: 0, data: { shim: 1 } }), { shim: 1 });
  const bad = { ok: false, rc: 1, error: "x" };
  assert.deepEqual(dml.unwrapTool(bad), bad);
  assert.deepEqual(dml.unwrapTool([1]), [1]);
});

test("local mode: supervisor gets only PYTHONPATH; voices off adds --no-voice", () => {
  const cmd = dml.supervisorCommand({ model_mode: "local", voices: false }, { env: { AITHEROS_ROOT: "R" } });
  assert.deepEqual(cmd.args, ["-m", "darklink.dd2_agents", "--no-voice"]);
  assert.deepEqual(Object.keys(cmd.extraEnv), ["PYTHONPATH"]);
  assert.ok(cmd.extraEnv.PYTHONPATH.startsWith(path.join("R", "AitherOS", "packages", "darklink")));
});

test("cloud mode: key rides env only, never argv or the logged launch line", () => {
  assert.throws(() => dml.supervisorCommand({ model_mode: "cloud" }), /gateway key/);
  const cmd = dml.supervisorCommand({ model_mode: "cloud" }, { key: KEY });
  assert.equal(cmd.extraEnv.DARKLINK_LLM_MODE, "cloud");
  assert.equal(cmd.extraEnv.DARKLINK_LLM_URL, dml.CLOUD_GATEWAY_URL);
  assert.equal(cmd.extraEnv.DARKLINK_LLM_KEY, KEY);
  assert.ok(!cmd.args.join(" ").includes(KEY));
  const line = dml.describeLaunch(cmd);
  assert.ok(!line.includes(KEY), line);
  assert.match(line, /DARKLINK_LLM_KEY/);
});

test("stop kills the whole tree", () => {
  assert.deepEqual(dml.stopCommand(42, "win32"), { file: "taskkill", args: ["/PID", "42", "/T", "/F"] });
  assert.deepEqual(dml.stopCommand(42, "linux").args, ["-TERM", "-42"]);
  assert.throws(() => dml.stopCommand(undefined));
});

test("consent moves only after the capture-pool tool succeeded", async () => {
  const home = tmpHome();
  const calls = [];
  // Refused: nothing written, setting stays off.
  const refused = await dml.setHarvestConsent(true, {
    home, callTool: async (n, a) => { calls.push([n, a]); return JSON.stringify({ error: "free plan", status: 403 }); },
  });
  assert.equal(refused.ok, false);
  assert.equal(dml.loadSettings({ home }).harvest_pool_opt_in, false);
  assert.ok(!fs.existsSync(dml.paths(home).consent));
  // Transport failure: same.
  const threw = await dml.setHarvestConsent(true, { home, callTool: async () => { throw new Error("gateway down"); } });
  assert.equal(threw.ok, false);
  assert.equal(dml.loadSettings({ home }).harvest_pool_opt_in, false);
  // Prose answer is an error, not a consent.
  const prose = await dml.setHarvestConsent(true, { home, callTool: async () => "Unknown tool" });
  assert.equal(prose.ok, false);
  // Accepted: both the setting and consent.json move.
  const ok = await dml.setHarvestConsent(true, { home, callTool: async (n, a) => { calls.push([n, a]); return JSON.stringify({ enabled: true }); } });
  assert.equal(ok.ok, true);
  assert.equal(dml.loadSettings({ home }).harvest_pool_opt_in, true);
  assert.equal(JSON.parse(fs.readFileSync(dml.paths(home).consent, "utf8")).harvest_pool, true);
  assert.deepEqual(calls.at(-1), ["capture_pool_optin", { consent: true }]);
  // Revoke goes through the same tool with consent:false.
  const off = await dml.setHarvestConsent(false, { home, callTool: async (n, a) => { calls.push([n, a]); return { enabled: false }; } });
  assert.equal(off.ok, true);
  assert.deepEqual(calls.at(-1), ["capture_pool_optin", { consent: false }]);
  assert.equal(JSON.parse(fs.readFileSync(dml.paths(home).consent, "utf8")).harvest_pool, false);
});

test("the settings verb cannot flip consent", async () => {
  const home = tmpHome();
  const h = darkmatterLinkHandlers({ home, callTool: async () => ({}) });
  const r = await h["desk:dml-settings"](null, { harvest_pool_opt_in: true, model_mode: "cloud" });
  assert.equal(r.settings.harvest_pool_opt_in, false);
  assert.equal(r.settings.model_mode, "cloud");
});

test("gateway key: encrypted at rest, renderer learns only hasKey", async () => {
  const home = tmpHome();
  const codec = { encrypt: (s) => Buffer.from(s.split("").reverse().join("")), decrypt: (b) => b.toString().split("").reverse().join("") };
  const h = darkmatterLinkHandlers({ home, codec });
  assert.equal((await h["desk:dml-key-set"](null, "not-a-key")).ok, false);
  assert.equal((await h["desk:dml-key-set"](null, KEY)).ok, true);
  assert.ok(!fs.readFileSync(dml.paths(home).key).toString().includes(KEY));
  const state = await h["desk:dml-state"]();
  assert.equal(state.hasKey, true);
  assert.ok(!JSON.stringify(state).includes(KEY));
  assert.equal(dml.loadGatewayKey({ home, decrypt: codec.decrypt }), KEY);
  // No secure storage -> refuse rather than write plaintext.
  assert.equal(dml.saveGatewayKey(KEY, { home }).ok, false);
});

test("start passes the cloud key in env to spawn; logs never carry it", async () => {
  _resetForTest();
  const home = tmpHome();
  const codec = { encrypt: (s) => Buffer.from(s), decrypt: (b) => b.toString() };
  const logged = [];
  let spawned = null;
  const h = darkmatterLinkHandlers({
    home, codec, log: (l) => logged.push(l),
    spawnImpl: (cmd) => { spawned = cmd; return { pid: 4242, on() {} }; },
    run: async () => ({ ok: true, code: 0, stdout: "", stderr: "" }),
  });
  await h["desk:dml-settings"](null, { model_mode: "cloud" });
  assert.equal((await h["desk:dml-start"]()).ok, false, "cloud without a key refuses");
  await h["desk:dml-key-set"](null, KEY);
  const r = await h["desk:dml-start"]();
  assert.equal(r.ok, true);
  assert.equal(r.supervisor.pid, 4242);
  assert.equal(spawned.extraEnv.DARKLINK_LLM_KEY, KEY);
  assert.ok(logged.every((l) => !l.includes(KEY)));
  assert.equal((await h["desk:dml-stop"]()).supervisor.running, false);
  _resetForTest();
});

test("personas are read-only rows from dd2-pawns.json", () => {
  const home = tmpHome();
  const file = dml.paths(home).pawns;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ v: 1, pawns: { rook: { name: "Rook", temperament: "dry", locked: true } } }));
  assert.deepEqual(dml.loadPersonas({ home }).map((p) => [p.name, p.persona, p.locked]), [["Rook", "dry", true]]);
});

test("python JSON output parse: last JSON line wins over warnings", () => {
  assert.deepEqual(dml.parseJsonOutput('{"warning":"x"}\n{"exit":0}'), { exit: 0 });
  assert.deepEqual(dml.parseJsonOutput('[{"id":"dd2"}]'), [{ id: "dd2" }]);
  assert.equal(dml.parseJsonOutput("Traceback"), null);
});

test("registry row: Darkmatter Link on the palette and the jump list", () => {
  const row = COMMANDS.find((c) => c.id === "darkmatter.open");
  assert.ok(row);
  assert.deepEqual([...row.surfaces], ["palette", "jumplist"]);
  assert.equal(row.group, "go");
  assert.deepEqual(conformance(), []);
  const main = fs.readFileSync(path.join(__dirname, "main.cjs"), "utf8");
  assert.match(main, /case "darkmatter\.open": return void createDarkmatterLinkWindow\(\);/);
  assert.match(main, /stopDarkmatterSupervisor\(\);/);
});

test("the page states no price and links only the existing shop", () => {
  const html = fs.readFileSync(path.join(__dirname, "darkmatter-link.html"), "utf8");
  assert.doesNotMatch(html, /\$\s?\d|free tier|per month|\/mo\b/i);
  assert.match(dml.SHOP_URL, /^https:\/\/aitherium\.com\/shop$/);
});
