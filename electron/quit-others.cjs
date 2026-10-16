"use strict";

/**
 * quit-others -- `Desk.exe --quit` ends the Desk that is already running.
 *
 * Garg, 2026-10-16: Desk's main thread was stuck in a layout loop, so the tray's Quit
 * never ran and the customer ended Desk from Task Manager. `--quit` (the taskbar jump
 * list's "Quit Aither", a Start-menu shortcut, a support script) works either way:
 *
 *   1. the single-instance channel asks the running Desk to quit (main.cjs second-instance);
 *   2. this waits up to `timeoutMs` for every other process of this image, this user, to go;
 *   3. whatever is still there is ended (taskkill /F /T on Windows, SIGKILL elsewhere).
 *
 * Only this user's processes of this executable's image name, never this process.
 * The decisions are pure; the process listing and killing are injected.
 */

const childProcess = require("node:child_process");
const os = require("node:os");
const path = require("node:path");

/** `tasklist /FO CSV /NH` output -> pids, without this process. */
function parseTasklistCsv(text, { selfPid = process.pid } = {}) {
  const out = [];
  for (const line of String(text || "").split(/\r?\n/)) {
    const m = /^"[^"]*","(\d+)"/.exec(line.trim());
    if (!m) continue;
    const pid = Number(m[1]);
    if (pid && pid !== selfPid) out.push(pid);
  }
  return out;
}

function tasklistArgs(image, user) {
  const args = ["/FI", `IMAGENAME eq ${image}`];
  if (user) args.push("/FI", `USERNAME eq ${user}`);
  return args.concat(["/FO", "CSV", "/NH"]);
}

function taskkillArgs(pids) {
  const args = ["/F", "/T"];
  for (const pid of pids) args.push("/PID", String(pid));
  return args;
}

/** Wait for the others to leave; end the ones that do not. @returns {{asked, forced}} */
async function quitRunning({ list, kill, sleep, timeoutMs = 3000, stepMs = 250 }) {
  const first = await list();
  if (!first.length) return { asked: 0, forced: 0 };
  let left = first;
  for (let waited = 0; waited < timeoutMs; waited += stepMs) {
    await sleep(stepMs);
    left = await list();
    if (!left.length) return { asked: first.length, forced: 0 };
  }
  await kill(left);
  return { asked: first.length, forced: left.length };
}

/** The real thing, for main.cjs. */
function quitRunningDesk({ exePath = process.execPath, platform = process.platform, timeoutMs = 3000 } = {}) {
  const image = path.basename(exePath);
  const run = (cmd, args) => new Promise((resolve) => {
    childProcess.execFile(cmd, args, { windowsHide: true, timeout: 10_000 }, (_error, stdout) => resolve(String(stdout || "")));
  });
  let user = "";
  try { user = os.userInfo().username; } catch { /* no user: image filter only */ }
  const list = platform === "win32"
    ? async () => parseTasklistCsv(await run("tasklist", tasklistArgs(image, user)))
    : async () => (await run("pgrep", ["-u", String(process.getuid ? process.getuid() : ""), "-x", image.slice(0, 15)]))
      .split(/\s+/).map(Number).filter((pid) => pid && pid !== process.pid);
  const kill = platform === "win32"
    ? async (pids) => { await run("taskkill", taskkillArgs(pids)); }
    : async (pids) => { for (const pid of pids) { try { process.kill(pid, "SIGKILL"); } catch { /* gone */ } } };
  return quitRunning({ list, kill, sleep: (ms) => new Promise((r) => setTimeout(r, ms)), timeoutMs });
}

module.exports = { parseTasklistCsv, quitRunning, quitRunningDesk, taskkillArgs, tasklistArgs };
