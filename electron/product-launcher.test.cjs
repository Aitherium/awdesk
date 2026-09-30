"use strict";

const assert = require("node:assert/strict");
const path = require("node:path");
const test = require("node:test");

const {
  PRODUCTS, findInstalled, findLaunch, planFor, registryRecords, runProductCommand, byProductId,
  consoleCommand,
} = require("./product-launcher.cjs");
const registry = require("./command-registry.cjs");

const env = { AITHER_APPS_DIR: path.join("/apps"), PATH: "" };

test("the four products, ids matching the shop slugs", () => {
  assert.deepEqual(PRODUCTS.map((p) => p.id), ["deep-research", "saga", "agent-home", "iris"]);
});

test("Aither Hearth keeps the agent-home id and the pre-rename names as fallbacks", () => {
  const hearth = byProductId("agent-home");
  assert.equal(hearth.name, "Aither Hearth");
  assert.equal(hearth.pack, "agent-home");
  assert.equal(hearth.console, true);
  assert.deepEqual(hearth.executables, ["aither-hearth", "agent-home", "aither-agent-home", "adk"]);
  const oldOnly = (n) => (n === "aither-agent-home" ? "/usr/bin/aither-agent-home" : null);
  assert.deepEqual(findLaunch(hearth, { env, platform: "linux", exists: () => false, which: oldOnly,
    probe: () => false }), { path: "/usr/bin/aither-agent-home", args: [] });
});

test("Aither Hearth is found by awdk's aither-hearth script and launches `serve --pair`", () => {
  const hearth = byProductId("agent-home");
  const probed = [];
  const both = (n) => ({ "aither-hearth": "/usr/bin/aither-hearth", adk: "/usr/bin/adk" })[n] || null;
  const opts = { env, platform: "linux", exists: () => false, which: both,
    probe: (f, a) => probed.push([f, ...a]) && true };
  assert.deepEqual(planFor(hearth, opts),
    { action: "launch", path: "/usr/bin/aither-hearth", args: ["serve", "--pair"] });
  assert.deepEqual(probed, [], "the console script needs no probe");
});

test("adk counts as Hearth only when `adk home --help` exits 0", () => {
  const hearth = byProductId("agent-home");
  const onlyAdk = (n) => (n === "adk" ? "/usr/bin/adk" : null);
  const probed = [];
  const base = { env, platform: "linux", exists: () => false, which: onlyAdk };
  assert.deepEqual(findLaunch(hearth, { ...base, probe: (f, a) => probed.push([f, ...a]) && true }),
    { path: "/usr/bin/adk", args: ["home", "serve", "--pair"] });
  assert.deepEqual(probed, [["/usr/bin/adk", "home", "--help"]]);
  assert.equal(findInstalled(hearth, { ...base, probe: () => false }), null, "old awdk: not Hearth");
  // Windows: the apps-dir .exe wins and keeps its launch args.
  const want = path.join("/apps", "agent-home", "aither-hearth.exe");
  assert.deepEqual(findLaunch(hearth, { env, platform: "win32", exists: (p) => p === want,
    which: () => null, probe: () => false }), { path: want, args: ["serve", "--pair"] });
});

test("Hearth opens in a console of its own on each platform", () => {
  const spawned = [];
  const shell = { openExternal: () => Promise.resolve() };
  const spawn = (cmd, args, opts) => { spawned.push({ cmd, args, opts }); return { unref() {}, on() {} }; };
  const file = "C:\\Users\\a b\\Scripts\\aither-hearth.exe";
  const win = runProductCommand({ product: "agent-home" }, { shell, spawn, env, platform: "win32",
    exists: () => false, which: (n) => (n === "aither-hearth" ? file : null) });
  assert.equal(win.ok, true);
  assert.deepEqual(spawned[0], {
    cmd: "cmd.exe",
    args: ["/d", "/s", "/c", `"start "" "${file}" "serve" "--pair""`],
    opts: { detached: true, stdio: "ignore", windowsVerbatimArguments: true },
  });

  const which = (n) => ({ "aither-hearth": "/usr/bin/aither-hearth", xterm: "/usr/bin/xterm" })[n] || null;
  runProductCommand({ product: "agent-home" }, { shell, spawn, env, platform: "linux", exists: () => false, which });
  assert.deepEqual(spawned[1].cmd, "/usr/bin/xterm");
  assert.deepEqual(spawned[1].args, ["-e", "/usr/bin/aither-hearth", "serve", "--pair"]);

  const mac = consoleCommand("/Users/a b/bin/aither-hearth", ["serve", "--pair"], { platform: "darwin" });
  assert.equal(mac.cmd, "osascript");
  assert.equal(mac.args[1],
    `tell application "Terminal" to do script "'/Users/a b/bin/aither-hearth' serve --pair"`);
});

test("Hearth with no terminal emulator says what to run instead of launching blind", () => {
  const spawned = [];
  const only = (n) => (n === "aither-hearth" ? "/usr/bin/aither-hearth" : null);
  const r = runProductCommand({ product: "agent-home" }, { shell: { openExternal() {} },
    spawn: (...a) => spawned.push(a), env, platform: "linux", exists: () => false, which: only });
  assert.equal(r.ok, false);
  assert.match(r.message, /aither-hearth serve --pair/);
  assert.deepEqual(spawned, []);
});

test("an exe under apps/<id>/ is installed; Windows looks for .exe first", () => {
  const saga = byProductId("saga");
  const want = path.join("/apps", "saga", "saga.exe");
  const exists = (p) => p === want;
  assert.equal(findInstalled(saga, { env, platform: "win32", exists, which: () => null }), want);
  assert.equal(findInstalled(saga, { env, platform: "linux", exists, which: () => null }), null);
  assert.equal(findInstalled(saga, { env, platform: "linux", exists, which: (n) => `/usr/bin/${n}` }), "/usr/bin/saga");
  assert.equal(findInstalled(byProductId("iris"), { env, exists: () => true }), null, "hosted is never installed");
});

test("plan: hosted opens, installed launches, missing opens the shop", () => {
  const none = { env, exists: () => false, which: () => null };
  assert.deepEqual(planFor(byProductId("iris"), none), { action: "open", url: "https://aitherium.com/iris" });
  assert.deepEqual(planFor(byProductId("saga"), none), { action: "shop", url: "https://aitherium.com/shop/saga" });
  assert.equal(planFor(byProductId("saga"), { ...none, which: () => "/bin/saga" }).action, "launch");
});

test("runProductCommand spawns an installed app detached, or opens a page", () => {
  const spawned = [];
  const opened = [];
  const shell = { openExternal: (u) => { opened.push(u); return Promise.resolve(); } };
  const spawn = (cmd, args, opts) => { spawned.push({ cmd, args, opts }); return { unref() {}, on() {} }; };
  const r1 = runProductCommand({ product: "saga" }, { shell, spawn, env, exists: () => false, which: () => "/bin/saga" });
  assert.equal(r1.ok, true);
  assert.deepEqual(spawned, [{ cmd: "/bin/saga", args: [], opts: { detached: true, stdio: "ignore" } }]);
  const r2 = runProductCommand({ product: "agent-home" }, { shell, spawn, env, exists: () => false, which: () => null });
  assert.equal(r2.action, "shop");
  assert.deepEqual(opened, ["https://aitherium.com/shop/agent-home"]);
  assert.equal(runProductCommand({ product: "nope" }, { shell, spawn }).ok, false);
});

test("registry records are conformant (ready for COMMANDS once main routes command.product)", () => {
  const records = registryRecords();
  assert.deepEqual(registry.conformance(records), []);
  assert.deepEqual(records.map((r) => r.product), PRODUCTS.map((p) => p.id));
  for (const r of records) assert.ok(r.surfaces.includes("palette") && r.surfaces.includes("tray"));
});
