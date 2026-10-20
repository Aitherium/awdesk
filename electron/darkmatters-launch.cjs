"use strict";

/**
 * darkmatters-launch.cjs -- "Play Dark Matters": one click from the desk to the game.
 *
 * Owner, 2026-10-18: "WE NEED A BETTER WAY TO START/LAUNCH DARKMATTER -- WE HAVE AWDESK +
 * AITHERIUM.COM RIGHT THERE". Until then the game started from a hand-typed shell command
 * or a .cmd whose console had to stay open.
 *
 * The desk does NOT own the engine's start logic. It runs the game repo's own idempotent
 * launcher (D:\dark-matters\tools\launch-darkmatter.ps1): if the engine answers /health on
 * :8799 it only opens the browser, otherwise it starts the engine hidden (logs in
 * %TEMP%\dm-server.log), waits for /health and opens http://localhost:8799. The Start-menu
 * and desktop shortcuts run that same script, so every door behaves the same.
 *
 * Spawned hidden (windowsHide, detached, no stdio): the owner forbids console / Windows
 * Terminal tab spam. With no launcher on disk (another machine, the repo moved) the
 * command still does the useful half -- it opens the game URL -- and says why in the log.
 *
 * Electron-free: `spawn`, `exists` and `openExternal` are injected so `node --test`
 * covers the policy without a window.
 */

const path = require("node:path");

const DEFAULT_LAUNCHER = "D:\\dark-matters\\tools\\launch-darkmatter.ps1";
const DEFAULT_PORT = 8799;

/** The launcher script; AWDESK_DM_LAUNCHER overrides it. */
function launcherPath(env = process.env) {
  return String(env.AWDESK_DM_LAUNCHER || DEFAULT_LAUNCHER);
}

/** The engine's port; AWDESK_DM_PORT overrides it. */
function port(env = process.env) {
  const n = Number.parseInt(env.AWDESK_DM_PORT || "", 10);
  return Number.isInteger(n) && n > 0 && n < 65536 ? n : DEFAULT_PORT;
}

function gameUrl(env = process.env) {
  return `http://localhost:${port(env)}`;
}

/**
 * The Dark Matters app in the Living OS (app.aitherium.com, registry id `darkmatters`). Its
 * window is local-first: it frames http://localhost:8799 when the engine answers, else the
 * owner-only fleet gate (api.aitherium.com/dark-matters, which refuses top-level navigation,
 * so it cannot be opened directly). With no launcher on this machine that is the one door
 * that still reaches a game; AWDESK_DM_OS_URL overrides it.
 */
const DEFAULT_OS_APP_URL = "https://app.aitherium.com/?app=darkmatters";
function osAppUrl(env = process.env) {
  return String(env.AWDESK_DM_OS_URL || DEFAULT_OS_APP_URL);
}

/** argv for powershell.exe. `restart` replaces ONLY the process listening on the port. */
function launcherArgs({ script, port: p, restart = false }) {
  const args = ["-NoProfile", "-ExecutionPolicy", "Bypass", "-WindowStyle", "Hidden",
    "-File", script, "-Port", String(p)];
  if (restart) args.push("-Restart");
  return args;
}

/**
 * Start (if needed) and open the game. Returns what it did, for the log and the tests.
 * @param {{ restart?: boolean, env?: object, spawn: Function, exists: Function,
 *           openExternal: Function, log?: Function }} deps
 */
function launch({ restart = false, env = process.env, spawn, exists, openExternal,
  log = (line) => console.log(`[darkmatters] ${line}`) }) {
  const script = launcherPath(env);
  const url = gameUrl(env);
  if (!exists(script)) {
    // Not http://localhost:<port>: with no launcher nothing will be listening there, and the
    // page would be a dead "refused to connect". The OS window frames the local engine if
    // one is up anyway, and the fleet engine otherwise.
    const os = osAppUrl(env);
    log(`launcher missing at ${script}; opening the Living OS window ${os}`);
    openExternal(os);
    return { ok: false, mode: "open-only", url: os, reason: "launcher-missing" };
  }
  const args = launcherArgs({ script, port: port(env), restart });
  const child = spawn("powershell.exe", args, {
    cwd: path.dirname(script),
    detached: true,
    windowsHide: true,
    stdio: "ignore",
  });
  if (child && typeof child.unref === "function") child.unref();
  if (child && typeof child.on === "function") {
    child.on("error", (error) => {
      log(`launcher failed to spawn (${error?.message || error}); opening ${url}`);
      openExternal(url);
    });
  }
  log(`${restart ? "restart" : "launch"} via ${script} -> ${url}`);
  return { ok: true, mode: restart ? "restart" : "launch", url, script };
}

module.exports = { DEFAULT_LAUNCHER, DEFAULT_PORT, DEFAULT_OS_APP_URL, launcherPath, port, gameUrl, osAppUrl, launcherArgs, launch };
