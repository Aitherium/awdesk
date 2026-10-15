"use strict";

/**
 * local-node.cjs -- Desk owns this computer's local node: one click, no terminal.
 *
 * Customer report, 2026-10-14 (a Windows PC, Desk 0.1.15): the taskbar said "no node",
 * This Device listed the awdk daemon :9001 and llama.cpp :8080 as not running, and Setup
 * said "pip install awnode" + "aithernode start" (a command that does not exist) and
 * "adk onboard --quick" (which failed without Docker). The llama.cpp server the
 * one-click installer set up only starts at Windows sign-in, so once it stopped nothing
 * brought it back. Owner: "this all needs to be EASY".
 *
 * So the Desk does it, on the user's click in AitherOS Online ("Start on this PC"):
 *
 *   1. python   a Python >= 3.10 (`py -3` on Windows, else python3/python). None: say so
 *               plainly and point at the setup page; never a stack trace.
 *   2. awdk     `python -c "import adk.local_model_server"` (the newest module this file
 *               needs); missing -> `python -m pip install --user --upgrade awdk`. Probing
 *               bare `import adk` was not enough: `pip install awnode` already pulls an
 *               older awdk without that module, so the upgrade never ran. pip gets
 *               PIP_TIMEOUT_MS; a hung index ends in a plain error, not "installing" forever.
 *   3. daemon   the awdk daemon, `python -m adk.server --host 127.0.0.1 --port 9001`
 *               (loopback: its 0.0.0.0 default raises a Windows Firewall prompt and puts
 *               the agent daemon on the LAN), unless :9001 already answers /health (then
 *               it is someone else's and is left alone).
 *   4. awsh     the awsh harness daemon, `python -m adk harness serve --host 127.0.0.1
 *               --port 8362` (loopback only), unless :8362 already answers /health. The
 *               Shell window's desk lane (harness-relay.cjs) talks to it; without it a
 *               "running" node still leaves the Shell empty and asking for a terminal.
 *               The daemon mints ~/.aither/harness_token itself, the file the relay reads.
 *   5. model    the local model server THIS machine already has installed, exactly as its
 *               installer serves it: `python -m adk.local_model_server` prints the argv
 *               (awdk/adk/local_model_server.py), unless its port already answers.
 *               Only its own `{"found": false}` means "no model installed"; a failed
 *               run is reported as "could not check", never as a missing model.
 *
 * Every process the Desk starts is SUPERVISED: an exit it did not ask for is restarted
 * after a short delay, at most MAX_RESTARTS times in RESTART_WINDOW_MS, then reported as
 * an error instead of looping. On quit, stopOwned() stops only what the Desk started.
 *
 * Reached from the desk-hosted OS page over aither-host/1 os-daemon-call
 * {target:"supervisor"} (living-desktop-preload.cjs -> living-desktop-window.cjs ->
 * call() here): GET /status, POST /start, POST /stop. Every status carries
 * supervisor:"desk-node/1" -- that field is how the page tells this Desk from an older
 * one, which relays the same call to the local node and gets no such field back.
 *
 * Electron-free and dependency-injected (spawn, run, probe, timers): local-node.test.cjs
 * drives it with fakes.
 */

const SUPERVISOR = "desk-node/1";
const DAEMON_PORT = 9001;
const HARNESS_PORT = 8362;
const MAX_RESTARTS = 3;
const RESTART_WINDOW_MS = 5 * 60 * 1000;
const RESTART_DELAY_MS = 3000;
/** pip on a slow or broken index must end; 10 minutes covers a cold wheel download. */
const PIP_TIMEOUT_MS = 10 * 60 * 1000;
/** The newest awdk module this file needs; its absence means awdk is too old. */
const ADK_PROBE = "import adk.local_model_server";
const SETUP_URL = "https://aitherium.com/?spawn=setup";
/** Electron/AppImage leak these into children; a system python must not inherit them. */
const ENV_DROP = ["ELECTRON_RUN_AS_NODE", "ELECTRON_NO_ATTACH_CONSOLE", "NODE_OPTIONS",
  "PYTHONHOME", "PYTHONPATH", "LD_LIBRARY_PATH", "LD_PRELOAD", "APPDIR", "APPIMAGE"];

function childEnv(base) {
  const env = { ...(base || {}) };
  for (const k of ENV_DROP) delete env[k];
  env.PYTHONUNBUFFERED = "1";
  return env;
}

/** Python launchers to try, most specific first. Pure. */
function pythonCandidates(platform) {
  return platform === "win32"
    ? [["py", ["-3"]], ["python", []], ["python3", []]]
    : [["python3", []], ["python", []]];
}

/** Default probe: GET url, true on 200. Never throws. */
async function httpOk(url, timeoutMs = 1500) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    return res.status === 200;
  } catch {
    return false;
  }
}

/**
 * Default run: spawn, collect output, resolve {code, stdout, stderr, timedOut}. Never
 * rejects. `opts.timeoutMs` kills the child and resolves with timedOut:true.
 */
function defaultRun(spawn, timers = {}) {
  const setT = timers.setTimeout || setTimeout;
  const clearT = timers.clearTimeout || clearTimeout;
  return (cmd, args, opts = {}) => new Promise((resolve) => {
    const { timeoutMs, ...spawnOpts } = opts;
    let stdout = "";
    let stderr = "";
    let done = false;
    let timer = null;
    const finish = (r) => {
      if (done) return;
      done = true;
      if (timer) clearT(timer);
      resolve(r);
    };
    let child;
    try {
      child = spawn(cmd, args, { windowsHide: true, ...spawnOpts });
    } catch (error) {
      finish({ code: -1, stdout, stderr: String((error && error.message) || error) });
      return;
    }
    if (timeoutMs) {
      timer = setT(() => {
        try { child.kill(); } catch { /* already gone */ }
        finish({ code: -1, stdout, stderr: `${stderr}\ntimed out after ${Math.round(timeoutMs / 1000)} s`, timedOut: true });
      }, timeoutMs);
    }
    child.stdout?.on("data", (d) => { stdout += d; });
    child.stderr?.on("data", (d) => { stderr += d; });
    child.on("error", (error) => finish({ code: -1, stdout, stderr: String(error.message || error) }));
    child.on("close", (code) => finish({ code: code === null ? -1 : code, stdout, stderr }));
  });
}

function createLocalNode(deps = {}) {
  const spawn = deps.spawn || require("node:child_process").spawn;
  const run = deps.run || defaultRun(spawn, { setTimeout: deps.setTimeout, clearTimeout: deps.clearTimeout });
  const probe = deps.probe || httpOk;
  const platform = deps.platform || process.platform;
  const env = childEnv(deps.env || process.env);
  const log = deps.log || (() => {});
  const setT = deps.setTimeout || setTimeout;
  const clearT = deps.clearTimeout || clearTimeout;
  const now = deps.now || Date.now;
  const restartDelayMs = deps.restartDelayMs ?? RESTART_DELAY_MS;
  const healthWaitMs = deps.healthWaitMs ?? 180000;
  const pollMs = deps.pollMs ?? 1000;

  let state = "stopped"; // stopped | checking | installing | starting | running | no-python | error
  let message = "";
  let python = null; // [cmd, args]
  let starting = null; // the in-flight start() promise
  /** id -> {id, name, port, health, state, owned, child, argv, cwd, restarts:[], stopping, timer} */
  const services = new Map();

  function service(id, name, port) {
    if (!services.has(id)) {
      services.set(id, { id, name, port, health: `http://127.0.0.1:${port}/health`, state: "stopped",
        owned: false, child: null, argv: null, cwd: undefined, restarts: [], stopping: false, timer: null, note: "" });
    }
    return services.get(id);
  }

  // Known before the first click, so a page can tell from GET /status that THIS Desk
  // starts awsh (the Shell window offers "Start on this PC" only then).
  service("daemon", "awdk daemon", DAEMON_PORT);
  service("awsh", "awsh", HARNESS_PORT);

  function snapshot() {
    return {
      supervisor: SUPERVISOR,
      state,
      message,
      setupUrl: SETUP_URL,
      python: python ? [python[0], ...python[1]].join(" ") : null,
      services: [...services.values()].map((s) => ({
        id: s.id, name: s.name, port: s.port, state: s.state, owned: s.owned,
        restarts: s.restarts.length, note: s.note,
      })),
    };
  }

  function recompute() {
    if (["no-python", "installing", "checking"].includes(state)) return;
    const list = [...services.values()].filter((s) => s.state !== "not-installed" && s.state !== "unknown");
    if (list.length === 0) return;
    if (list.some((s) => s.state === "error")) {
      state = "error";
    } else if (list.every((s) => s.state === "running")) {
      state = "running";
      message = "";
    } else if (list.some((s) => s.state === "starting" || s.state === "restarting")) {
      state = "starting";
    }
  }

  async function findPython() {
    for (const [cmd, pre] of pythonCandidates(platform)) {
      const r = await run(cmd, [...pre, "-c", "import sys; print(sys.version_info >= (3, 10))"], { env });
      if (r.code === 0 && /True/.test(r.stdout)) return [cmd, pre];
    }
    return null;
  }

  async function waitHealthy(s) {
    const deadline = now() + healthWaitMs;
    while (now() < deadline) {
      if (s.state !== "starting" && s.state !== "restarting") return;
      if (await probe(s.health)) {
        s.state = "running";
        s.note = "";
        recompute();
        return;
      }
      await new Promise((r) => setT(r, pollMs));
    }
    if (s.state === "starting" || s.state === "restarting") {
      s.state = "error";
      s.note = `did not answer ${s.health}`;
      message = `${s.name} did not come up.`;
      recompute();
    }
  }

  function launch(s) {
    let child;
    try {
      child = spawn(s.argv[0], s.argv.slice(1), { cwd: s.cwd, env, windowsHide: true, stdio: "ignore" });
    } catch (error) {
      s.state = "error";
      s.note = String((error && error.message) || error);
      recompute();
      return;
    }
    s.child = child;
    s.owned = true;
    s.stopping = false;
    child.on("error", (error) => { s.note = String((error && error.message) || error); });
    child.on("exit", (code) => onExit(s, child, code));
    log(`local-node: started ${s.name} (pid ${child.pid})`);
    void waitHealthy(s);
  }

  function onExit(s, child, code) {
    if (s.child !== child) return;
    s.child = null;
    if (s.stopping) {
      s.state = "stopped";
      s.owned = false;
      return;
    }
    const t = now();
    s.restarts = s.restarts.filter((at) => t - at < RESTART_WINDOW_MS);
    if (s.restarts.length >= MAX_RESTARTS) {
      s.state = "error";
      s.note = `stopped after ${MAX_RESTARTS} crashes (last exit ${code})`;
      message = `${s.name} keeps stopping.`;
      recompute();
      log(`local-node: ${s.name} gave up after ${MAX_RESTARTS} restarts`);
      return;
    }
    s.restarts.push(t);
    s.state = "restarting";
    s.note = `exited (${code}); restarting`;
    recompute();
    log(`local-node: ${s.name} exited ${code}; restarting`);
    s.timer = setT(() => { s.timer = null; if (s.state === "restarting") launch(s); }, restartDelayMs);
  }

  /**
   * Bring one service up: already answering = adopt (not owned); else spawn it.
   * A child the Desk still holds in "error" (it did not answer /health in time, e.g. a
   * big model still loading) is killed before the respawn: replacing s.child without
   * that would orphan it, holding the port, invisible to stopOwned().
   */
  async function ensure(s, argv, cwd) {
    if (s.child && s.state !== "error") return;
    if (await probe(s.health)) {
      s.state = "running";
      s.note = s.child ? "" : "already running";
      if (!s.child) s.owned = false;
      return;
    }
    if (s.child) {
      const old = s.child;
      s.child = null; // onExit ignores a child that is no longer s.child
      try { old.kill(); } catch { /* already gone */ }
      log(`local-node: replaced unresponsive ${s.name} (pid ${old.pid})`);
    }
    if (s.timer) { clearT(s.timer); s.timer = null; }
    s.argv = argv;
    s.cwd = cwd;
    s.restarts = [];
    s.state = "starting";
    launch(s);
  }

  async function doStart() {
    state = "checking";
    message = "Looking at this computer…";
    const daemon = service("daemon", "awdk daemon", DAEMON_PORT);
    python = await findPython();
    if (!python) {
      state = "no-python";
      message = "This computer has no Python 3.10 or newer, which the local node runs on. "
        + "Install Python from python.org (tick \"Add to PATH\"), then click Start again, "
        + "or follow the setup page.";
      return snapshot();
    }
    const [py, pre] = python;
    const hasAdk = await run(py, [...pre, "-c", ADK_PROBE], { env });
    let adkCurrent = hasAdk.code === 0;
    if (!adkCurrent) {
      state = "installing";
      message = "Installing awdk (one time, about a minute)…";
      const pip = await run(py, [...pre, "-m", "pip", "install", "--user", "--upgrade", "awdk"],
        { env, timeoutMs: PIP_TIMEOUT_MS });
      if (pip.code !== 0) {
        state = "error";
        message = pip.timedOut
          ? "Installing awdk took too long (no answer from the Python package index). Check the internet connection and click Start again."
          : "Installing awdk failed. " + String(pip.stderr || pip.stdout).trim().split("\n").slice(-2).join(" ");
        return snapshot();
      }
      adkCurrent = (await run(py, [...pre, "-c", ADK_PROBE], { env })).code === 0;
      // pip succeeded but the newest awdk it could get still lacks the module: the
      // daemon still runs, the model row says awdk is too old (never "not installed").
      if (!adkCurrent && (await run(py, [...pre, "-c", "import adk"], { env })).code !== 0) {
        state = "error";
        message = "awdk installed but Python cannot load it. Open the setup page for the manual steps.";
        return snapshot();
      }
    }
    state = "starting";
    message = "Starting…";
    await ensure(daemon, [py, ...pre, "-m", "adk.server", "--host", "127.0.0.1", "--port", String(DAEMON_PORT)]);
    await ensure(service("awsh", "awsh", HARNESS_PORT),
      [py, ...pre, "-m", "adk", "harness", "serve", "--host", "127.0.0.1", "--port", String(HARNESS_PORT)]);
    let spec = null;
    let why = "";
    if (adkCurrent) {
      const found = await run(py, [...pre, "-m", "adk.local_model_server"], { env });
      try { spec = JSON.parse(String(found.stdout || "").trim().split("\n").pop()); } catch { spec = null; }
      if (!spec || typeof spec !== "object") {
        spec = null;
        const last = String(found.stderr || "").trim().split("\n").pop();
        why = `could not check for a local model (${last || `exit ${found.code}`})`;
      }
    } else {
      why = "could not check for a local model: the awdk on this computer is too old (update awdk)";
    }
    if (spec && spec.found && Array.isArray(spec.argv) && spec.argv.length && Number(spec.port)) {
      const model = service("model", "local model", Number(spec.port));
      model.health = typeof spec.health === "string" ? spec.health : model.health;
      await ensure(model, spec.argv.map(String), spec.cwd ? String(spec.cwd) : undefined);
    } else {
      const model = service("model", "local model", 8080);
      if (model.child) {
        // still supervising the one started earlier; leave it alone
      } else if (spec && spec.found === false) {
        model.state = "not-installed";
        model.note = "no local model is installed on this computer";
      } else if (await probe(model.health)) {
        // unknown is not absent: a server already answering :8080 still counts
        model.state = "running";
        model.owned = false;
        model.note = "already running";
      } else {
        model.state = "unknown";
        model.note = why;
      }
    }
    recompute();
    if (state === "starting") message = "Starting… a big model takes a minute to load.";
    return snapshot();
  }

  /** Start (idempotent): concurrent clicks share one run. Resolves with a snapshot. */
  function start() {
    if (!starting) {
      starting = doStart()
        .catch((error) => {
          state = "error";
          message = String((error && error.message) || error);
          return snapshot();
        })
        .finally(() => { starting = null; });
    }
    return starting;
  }

  /** Stop ONLY what this Desk started. Others' servers are never touched. */
  function stopOwned() {
    for (const s of services.values()) {
      if (s.timer) { clearT(s.timer); s.timer = null; }
      if (s.owned && s.child) {
        s.stopping = true;
        try { s.child.kill(); } catch { /* already gone */ }
      }
      if (s.state === "restarting") s.state = "stopped";
    }
    state = "stopped";
    message = "";
    return snapshot();
  }

  /** The aither-host/1 relay: {method, path} -> an os-daemon-result shape. */
  async function call(msg) {
    const m = msg && typeof msg === "object" ? msg : {};
    const method = String(m.method || "GET").toUpperCase();
    const route = String(m.path || "");
    if (method === "GET" && route === "/status") return { ok: true, status: 200, data: snapshot() };
    if (method === "POST" && route === "/start") {
      // Answer at once with the "checking" snapshot; the page polls /status for progress.
      void start();
      await Promise.resolve();
      return { ok: true, status: 202, data: snapshot() };
    }
    if (method === "POST" && route === "/stop") return { ok: true, status: 200, data: stopOwned() };
    return { ok: false, status: 404, error: `the desk node supervisor has no ${method} ${route}` };
  }

  return { start, stopOwned, status: snapshot, call, _services: services };
}

module.exports = {
  createLocalNode, defaultRun, pythonCandidates, childEnv,
  SUPERVISOR, DAEMON_PORT, HARNESS_PORT, MAX_RESTARTS, PIP_TIMEOUT_MS,
};
