"use strict";

/** local-node.cjs: Desk starts, supervises and stops this computer's local node. */

const test = require("node:test");
const assert = require("node:assert/strict");
const EventEmitter = require("node:events");
const { createLocalNode, defaultRun, pythonCandidates, childEnv, SUPERVISOR, HARNESS_PORT, MAX_RESTARTS, PIP_TIMEOUT_MS } = require("./local-node.cjs");

const DAEMON_ARGV = ["py", "-3", "-m", "adk.server", "--host", "127.0.0.1", "--port", "9001"];

const AWSH_ARGV = ["py", "-3", "-m", "adk", "harness", "serve", "--host", "127.0.0.1", "--port", "8362"];

const MODEL_SPEC = {
  found: true, kind: "bonsai-selfhost", port: 8080, health: "http://127.0.0.1:8080/health",
  argv: ["C:\\bonsai\\bin\\llama-server.exe", "--model", "m.gguf", "--port", "8080"], cwd: "C:\\bonsai\\bin",
};

/**
 * A fake world: which python answers, which awdk is installed ("current" has
 * adk.local_model_server; "old" is PyPI 3.8.68, as `pip install awnode` leaves it; false =
 * none), what pip upgrades to, which ports answer.
 */
function world({ pythons = ["py"], adk = "current", pipOk = true, pipGives = "current", pipTimedOut = false,
  spec = MODEL_SPEC, specRun = null, up = new Set(), healthyAfterSpawn = true, healthWaitMs = 10 } = {}) {
  const spawned = [];
  const runs = [];
  const timers = [];
  const children = [];
  const run = async (cmd, args) => {
    runs.push([cmd, ...args]);
    const code = args.join(" ");
    if (code.includes("sys.version_info")) return pythons.includes(cmd) ? { code: 0, stdout: "True\n" } : { code: 9009, stdout: "" };
    if (code.endsWith("-c import adk.local_model_server")) return { code: adk === "current" ? 0 : 1, stdout: "" };
    if (code.endsWith("-c import adk")) return { code: adk ? 0 : 1, stdout: "" };
    if (code.includes("pip install")) {
      if (pipTimedOut) return { code: -1, stdout: "", stderr: "timed out", timedOut: true };
      if (pipOk) adk = pipGives;
      return { code: pipOk ? 0 : 1, stdout: "", stderr: pipOk ? "" : "ERROR: no network" };
    }
    if (code.includes("-m adk.local_model_server")) {
      if (adk !== "current") return { code: 1, stdout: "", stderr: "No module named adk.local_model_server" };
      if (specRun) return specRun;
      return { code: spec ? 0 : 3, stdout: JSON.stringify(spec || { found: false }) };
    }
    return { code: 1, stdout: "" };
  };
  const spawn = (cmd, args, opts) => {
    const child = new EventEmitter();
    child.pid = 1000 + spawned.length;
    child.killed = false;
    child.kill = () => { child.killed = true; child.emit("exit", null); };
    spawned.push({ cmd, args, opts, child });
    children.push(child);
    if (healthyAfterSpawn) {
      const port = cmd.includes("llama") ? 8080 : args.includes("harness") ? 8362 : 9001;
      up.add(`http://127.0.0.1:${port}/health`);
    }
    return child;
  };
  const probe = async (url) => up.has(url);
  const node = createLocalNode({
    spawn, run, probe, platform: "win32", env: { PATH: "x", ELECTRON_RUN_AS_NODE: "1" },
    setTimeout: (fn, ms) => { timers.push({ fn, ms }); return timers.length; }, clearTimeout: () => {},
    restartDelayMs: 5, healthWaitMs, pollMs: 1,
  });
  return { node, spawned, runs, timers, up, children };
}

async function settle() { for (let i = 0; i < 20; i += 1) await new Promise((r) => setImmediate(r)); }

test("start: finds python, starts the awdk daemon, awsh and the installed model server, reports running", async () => {
  const w = world();
  const snap = await w.node.start();
  await settle();
  assert.equal(snap.supervisor, SUPERVISOR);
  assert.deepEqual(w.spawned.map((s) => [s.cmd, ...s.args]), [
    DAEMON_ARGV,
    AWSH_ARGV,
    MODEL_SPEC.argv,
  ]);
  assert.equal(w.spawned[2].opts.cwd, MODEL_SPEC.cwd);
  assert.equal(w.spawned[0].opts.windowsHide, true);
  assert.equal(w.spawned[0].opts.env.ELECTRON_RUN_AS_NODE, undefined, "Electron's env never leaks into python");
  const st = w.node.status();
  assert.equal(st.state, "running");
  assert.deepEqual(st.services.map((s) => [s.id, s.state, s.owned]),
    [["daemon", "running", true], ["awsh", "running", true], ["model", "running", true]]);
});

test("already running: adopted, nothing spawned, and quit stops nothing it did not start", async () => {
  const w = world({ up: new Set(["http://127.0.0.1:9001/health", "http://127.0.0.1:8362/health", "http://127.0.0.1:8080/health"]) });
  await w.node.start();
  assert.equal(w.spawned.length, 0);
  const st = w.node.status();
  assert.equal(st.state, "running");
  assert.ok(st.services.every((s) => s.owned === false));
  w.node.stopOwned();
  assert.equal(w.spawned.length, 0);
});

test("crash -> restart after a delay; after MAX_RESTARTS crashes it stops and says so", async () => {
  const w = world();
  await w.node.start();
  await settle();
  const first = w.spawned[0].child;
  first.emit("exit", 1);
  assert.equal(w.node.status().services[0].state, "restarting");
  assert.equal(w.timers.length, 1);
  w.timers.shift().fn();
  await settle();
  assert.equal(w.spawned.length, 4, "the daemon was spawned again");
  assert.deepEqual([w.spawned[3].cmd, ...w.spawned[3].args], DAEMON_ARGV);
  for (let i = 1; i < MAX_RESTARTS; i += 1) {
    w.spawned[w.spawned.length - 1].child.emit("exit", 1);
    w.timers.shift().fn();
    await settle();
  }
  w.spawned[w.spawned.length - 1].child.emit("exit", 1);
  const st = w.node.status();
  assert.equal(st.services[0].state, "error");
  assert.equal(st.state, "error");
  assert.match(st.services[0].note, /crashes/);
  assert.equal(w.timers.length, 0, "no restart loop");
});

test("daemon binds loopback only: no Windows Firewall prompt, not on the LAN", async () => {
  const w = world();
  await w.node.start();
  const args = w.spawned.find((s) => s.args.includes("adk.server")).args;
  assert.equal(args[args.indexOf("--host") + 1], "127.0.0.1");
});

test("awdk too old (pip install awnode left PyPI awdk without adk.local_model_server): upgraded, model started", async () => {
  const w = world({ adk: "old" });
  await w.node.start();
  await settle();
  assert.ok(w.runs.some((r) => r.join(" ") === "py -3 -m pip install --user --upgrade awdk"),
    "a passing bare `import adk` must not skip the upgrade");
  assert.equal(w.spawned[w.spawned.length - 1].cmd, MODEL_SPEC.argv[0]);
  assert.equal(w.node.status().services.find((s) => s.id === "model").state, "running");
});

test("upgrade still leaves an old awdk: daemon runs, model row says too old, NOT 'no model installed'", async () => {
  const w = world({ adk: "old", pipGives: "old" });
  await w.node.start();
  await settle();
  const st = w.node.status();
  const model = st.services.find((s) => s.id === "model");
  assert.equal(model.state, "unknown");
  assert.match(model.note, /too old/);
  assert.doesNotMatch(model.note, /no local model is installed/);
  assert.ok(!w.runs.some((r) => r.join(" ").includes("-m adk.local_model_server")), "never runs a module that is not there");
  assert.equal(st.state, "running", "daemon and awsh are up");
});

test("the model finder itself fails: 'could not check', never 'not installed'", async () => {
  const w = world({ specRun: { code: 1, stdout: "", stderr: "Traceback\nPermissionError: denied" } });
  await w.node.start();
  await settle();
  const model = w.node.status().services.find((s) => s.id === "model");
  assert.equal(model.state, "unknown");
  assert.match(model.note, /could not check.*PermissionError/);
});

test("the model finder fails but :8080 already answers: running (not ours), not unknown", async () => {
  const w = world({ specRun: { code: 1, stdout: "", stderr: "boom" }, up: new Set(["http://127.0.0.1:8080/health"]) });
  await w.node.start();
  await settle();
  const model = w.node.status().services.find((s) => s.id === "model");
  assert.deepEqual([model.state, model.owned], ["running", false]);
});

test("health timeout then Try again: the old child is killed, not orphaned; quit stops the new one", async () => {
  const w = world({ healthyAfterSpawn: false, spec: null, healthWaitMs: 0 });
  await w.node.start();
  await settle();
  const row = () => w.node.status().services.find((s) => s.id === "daemon");
  assert.equal(row().state, "error", "never answered /health in time");
  const first = w.spawned.find((s) => s.args.includes("adk.server")).child;
  assert.equal(first.killed, false, "still alive (still loading)");
  await w.node.start();
  await settle();
  assert.equal(first.killed, true, "killed before the respawn");
  assert.equal(w.timers.length, 0, "its exit is not counted as a crash");
  const daemons = w.spawned.filter((s) => s.args.includes("adk.server"));
  assert.equal(daemons.length, 2);
  w.node.stopOwned();
  assert.equal(daemons[1].child.killed, true, "quit stops the replacement");
});

test("health timeout, then it answers: Try again keeps its own child, nothing spawned, still stopped on quit", async () => {
  const w = world({ healthyAfterSpawn: false, spec: null, healthWaitMs: 0 });
  await w.node.start();
  await settle();
  const daemons = () => w.spawned.filter((s) => s.args.includes("adk.server")).length;
  assert.equal(daemons(), 1);
  w.up.add("http://127.0.0.1:9001/health");
  await w.node.start();
  const row = w.node.status().services.find((s) => s.id === "daemon");
  assert.deepEqual([row.state, row.owned], ["running", true]);
  assert.equal(daemons(), 1, "no second daemon");
  w.node.stopOwned();
  assert.equal(w.spawned.find((s) => s.args.includes("adk.server")).child.killed, true);
});

test("a hung pip ends in a plain error, and the next click runs again", async () => {
  const w = world({ adk: false, pipTimedOut: true });
  const snap = await w.node.start();
  assert.equal(snap.state, "error");
  assert.match(snap.message, /took too long/);
  await w.node.start();
  assert.equal(w.runs.filter((r) => r.join(" ").includes("pip install")).length, 2, "not a no-op on a stuck promise");
});

test("defaultRun: pip gets PIP_TIMEOUT_MS; a hung child is killed and resolves timedOut", async () => {
  const seen = [];
  const timers = [];
  const hung = new EventEmitter();
  hung.kill = () => { hung.killed = true; };
  const run = defaultRun((cmd, args, opts) => { seen.push(opts); return hung; },
    { setTimeout: (fn, ms) => { timers.push({ fn, ms }); return 1; }, clearTimeout: () => {} });
  const pending = run("py", ["-m", "pip"], { timeoutMs: PIP_TIMEOUT_MS });
  assert.equal(seen[0].timeoutMs, undefined, "timeoutMs is not passed to spawn");
  assert.equal(timers[0].ms, PIP_TIMEOUT_MS);
  timers[0].fn();
  const r = await pending;
  assert.equal(r.timedOut, true);
  assert.equal(hung.killed, true);
  // and the supervisor asks for it on pip
  const calls = [];
  const node = createLocalNode({
    platform: "win32", env: {}, spawn: () => new EventEmitter(), probe: async () => false,
    run: async (cmd, args, opts) => { calls.push([args.join(" "), opts]); return args.includes("pip") ? { code: 1, stderr: "x" } : args.join(" ").includes("version_info") ? { code: 0, stdout: "True" } : { code: 1 }; },
  });
  await node.start();
  const pip = calls.find(([a]) => a.includes("pip install"));
  assert.equal(pip[1].timeoutMs, PIP_TIMEOUT_MS);
});

test("no python: a plain answer and the setup page, nothing spawned", async () => {
  const w = world({ pythons: [] });
  const snap = await w.node.start();
  assert.equal(snap.state, "no-python");
  assert.match(snap.message, /Python 3\.10/);
  assert.match(snap.setupUrl, /^https:\/\/aitherium\.com/);
  assert.equal(w.spawned.length, 0);
  assert.deepEqual(w.runs.map((r) => r[0]), ["py", "python", "python3"]);
});

test("awdk missing: installed with pip --user first, then started", async () => {
  const w = world({ adk: false });
  await w.node.start();
  assert.ok(w.runs.some((r) => r.join(" ") === "py -3 -m pip install --user --upgrade awdk"));
  assert.equal(w.spawned.length, 3);
  const failing = world({ adk: false, pipOk: false });
  const snap = await failing.node.start();
  assert.equal(snap.state, "error");
  assert.match(snap.message, /awdk failed/);
  assert.equal(failing.spawned.length, 0);
});

test("no local model installed: the daemon still runs; the model row says why", async () => {
  const w = world({ spec: null });
  await w.node.start();
  await settle();
  const st = w.node.status();
  assert.equal(st.state, "running");
  const model = st.services.find((s) => s.id === "model");
  assert.equal(model.state, "not-installed");
  assert.equal(w.spawned.length, 2, "the daemon and awsh");
});

test("quit stops only what the Desk started, and a stop is not a crash", async () => {
  const w = world({ up: new Set(["http://127.0.0.1:8080/health"]) }); // the model was already up
  await w.node.start();
  await settle();
  assert.equal(w.spawned.length, 2);
  w.node.stopOwned();
  assert.equal(w.spawned[0].child.killed, true);
  assert.equal(w.spawned[1].child.killed, true, "awsh too: the Desk started it");
  assert.equal(w.timers.length, 0, "no restart after an asked-for stop");
  assert.equal(w.node.status().services.find((s) => s.id === "daemon").state, "stopped");
});

test("the relay: GET /status and POST /start answer with the supervisor marker; others 404", async () => {
  const w = world();
  const st = await w.node.call({ method: "GET", path: "/status" });
  assert.equal(st.ok, true);
  assert.equal(st.data.supervisor, SUPERVISOR);
  const started = await w.node.call({ method: "POST", path: "/start" });
  assert.equal(started.status, 202);
  await settle();
  assert.equal(w.node.status().state, "running");
  const bad = await w.node.call({ method: "POST", path: "/shell" });
  assert.equal(bad.ok, false);
  assert.equal(bad.status, 404);
});

test("concurrent clicks share one start", async () => {
  const w = world();
  await Promise.all([w.node.start(), w.node.start()]);
  assert.equal(w.spawned.length, 3);
});

test("awsh: listed before any click, started on loopback :8362, and supervised like the daemon", async () => {
  // The Shell window offers "Start on this PC" only when GET /status lists awsh, so an
  // older supervisor that cannot start it never shows a button that leaves awsh down.
  const w = world();
  const before = await w.node.call({ method: "GET", path: "/status" });
  assert.deepEqual(before.data.services.map((s) => [s.id, s.port, s.state]),
    [["daemon", 9001, "stopped"], ["awsh", HARNESS_PORT, "stopped"]]);
  await w.node.start();
  await settle();
  const awsh = w.spawned.find((s) => s.args.includes("harness"));
  assert.deepEqual([awsh.cmd, ...awsh.args], AWSH_ARGV, "loopback only: never the daemon's 0.0.0.0 default");
  assert.equal(awsh.opts.env.ELECTRON_RUN_AS_NODE, undefined);
  awsh.child.emit("exit", 1);
  assert.equal(w.node.status().services.find((s) => s.id === "awsh").state, "restarting");
  w.timers.shift().fn();
  await settle();
  assert.deepEqual(w.spawned.slice(-1).map((s) => [s.cmd, ...s.args]), [AWSH_ARGV]);
  assert.equal(w.node.status().state, "running");
});

test("awsh down while the daemon answers: the node is NOT running", async () => {
  const w = world({ up: new Set(["http://127.0.0.1:9001/health"]), healthyAfterSpawn: false, spec: null });
  await w.node.start();
  await settle();
  const st = w.node.status();
  assert.equal(st.services.find((s) => s.id === "daemon").state, "running");
  assert.equal(st.services.find((s) => s.id === "awsh").state, "starting");
  assert.notEqual(st.state, "running", "the page must not read this as awsh ready");
});

test("python candidates and child env", () => {
  assert.deepEqual(pythonCandidates("win32")[0], ["py", ["-3"]]);
  assert.deepEqual(pythonCandidates("linux")[0], ["python3", []]);
  const env = childEnv({ PATH: "p", NODE_OPTIONS: "--x", PYTHONPATH: "y" });
  assert.equal(env.PATH, "p");
  assert.equal(env.NODE_OPTIONS, undefined);
  assert.equal(env.PYTHONPATH, undefined);
});

/* ── the bridge: living-desktop-preload.cjs relays target "supervisor" ── */

const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

function loadPreload({ active = false, invoke = async () => null } = {}) {
  const listeners = [];
  const posted = [];
  const win = {
    addEventListener: (type, fn) => { if (type === "message") listeners.push(fn); },
    postMessage: (data) => posted.push(JSON.parse(JSON.stringify(data))),
    location: { origin: "https://aitherium.com" },
  };
  const ctx = vm.createContext({
    window: win,
    document: { documentElement: { setAttribute() {} } },
    navigator: { userActivation: { isActive: active } },
    sessionStorage: { getItem: () => null, setItem() {} },
    process: { argv: [] },
    require: () => ({ ipcRenderer: { on() {}, send() {}, invoke } }),
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, "living-desktop-preload.cjs"), "utf8"), ctx);
  const send = async (data) => { for (const fn of listeners) await fn({ source: win, origin: "https://aitherium.com", data }); };
  return { send, posted };
}

test("preload: GET /status reaches the supervisor; POST /start needs a real click", async () => {
  const seen = [];
  const invoke = async (ch, msg) => { seen.push([ch, JSON.parse(JSON.stringify(msg))]); return { ok: true, status: 200, data: { supervisor: SUPERVISOR } }; };
  const idle = loadPreload({ invoke });
  await idle.send({ __aither: "os-daemon-call", reqId: "a", target: "supervisor", method: "GET", path: "/status" });
  assert.deepEqual(seen, [["living-desktop:daemon-call", { target: "supervisor", method: "GET", path: "/status" }]]);
  assert.equal(idle.posted[0].data.supervisor, SUPERVISOR);
  await idle.send({ __aither: "os-daemon-call", reqId: "b", target: "supervisor", method: "POST", path: "/start" });
  assert.equal(seen.length, 1, "no click: main is never asked to start processes");
  assert.equal(idle.posted[1].ok, false);
  assert.equal(idle.posted[1].reqId, "b");
  const clicked = loadPreload({ active: true, invoke });
  await clicked.send({ __aither: "os-daemon-call", reqId: "c", target: "supervisor", method: "POST", path: "/start" });
  assert.deepEqual(seen[1], ["living-desktop:daemon-call", { target: "supervisor", method: "POST", path: "/start" }]);
});

test("main routes target supervisor to the desk's node supervisor, fenced like every plane", () => {
  const win = fs.readFileSync(path.join(__dirname, "living-desktop-window.cjs"), "utf8");
  const handler = win.slice(win.indexOf('ipcMain.handle("living-desktop:daemon-call"'));
  assert.ok(handler.indexOf("fromOverlay(event)") < handler.indexOf('m.target === "supervisor"'));
  assert.match(handler, /overlayHost\.supervisor\(\{ method: m\.method, path: m\.path \}\)/);
  const main = fs.readFileSync(path.join(__dirname, "main.cjs"), "utf8");
  assert.match(main, /supervisor: \(msg\) => localNode\.call\(msg\)/);
  assert.match(main, /app\.on\("before-quit"[\s\S]*localNode\.stopOwned\(\)/);
});
