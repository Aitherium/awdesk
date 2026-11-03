"use strict";

/**
 * files-wine -- the owner-consented, reversible "Win+E opens Aither Files" switch.
 *
 * Windows resolves Win+E (and "open new window" on This PC) through the shell
 * verb of the CLSID {52205fd8-5dfb-447d-801a-d0b52f2e83e1}. A per-user override
 * under HKCU wins over the machine's HKLM default and needs no admin:
 *
 *   HKCU\Software\Classes\CLSID\{52205fd8-...}\shell\opennewwindow\command
 *     (Default)        = "<awdesk exe>" [<app dir>] --files
 *     DelegateExecute  = ""      (an empty value makes the shell run the command)
 *
 * Restore deletes what Enable CREATED -- the topmost key that did not exist
 * before (recorded in ~/.aither/desk-wine.json), else the command key. The key
 * to delete is always one of the four known paths, never a value read from disk
 * unchecked, so a tampered state file cannot aim `reg delete` anywhere else.
 *
 * 🚩 Consent: enable() refuses without {consent:true}; the Files page asks the
 * owner first. A foreign override (another tool's command) is refused, never
 * clobbered -- by enable AND by restore, state file or not.
 *
 * 🚩 Routed: enable() also refuses until the desk ROUTES `--files` (first launch
 * and second-instance argv -> createFilesWindow). main.cjs says so by calling
 * files-window setFilesLaunchRouted(true) next to that routing; until then the
 * switch would point Win+E at a desk that never opens Files. status() reports
 * `routed` so the page hides the button. Restore is never gated.
 *
 * 🚩 Partial enable rolls back: the state file is written BEFORE the first
 * `reg add`, and a later `reg add` that fails runs restoreCommands(createdKey),
 * so Win+E is never left half-overridden with nothing that knows what changed.
 *
 * reg.exe runs via the injected execFile with windowsHide:true (never a visible
 * console), from %SystemRoot%\System32 by absolute path. Electron-free; the
 * command builders are pure so files-wine.test.cjs asserts the exact argv.
 * Fail-soft: {ok:true, ...} | {ok:false, reason}; never throws.
 */

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const CLSID = "{52205fd8-5dfb-447d-801a-d0b52f2e83e1}";
const BASE_KEY = `HKCU\\Software\\Classes\\CLSID\\${CLSID}`;
const SHELL_KEY = `${BASE_KEY}\\shell`;
const VERB_KEY = `${SHELL_KEY}\\opennewwindow`;
const COMMAND_KEY = `${VERB_KEY}\\command`;
/** Outermost first: the first one missing is the one Enable creates. */
const KEY_CHAIN = Object.freeze([BASE_KEY, SHELL_KEY, VERB_KEY, COMMAND_KEY]);
const FILES_FLAG = "--files";
const STATE_NAME = "desk-wine.json";
const REG_TIMEOUT_MS = 10_000;

function regExe(env = process.env) {
  const root = env.SystemRoot || env.SYSTEMROOT || "C:\\Windows";
  return path.join(root, "System32", "reg.exe");
}

/** `"C:\x\awdesk.exe" "C:\app"` -- every path quoted, no verb flag. */
function baseCommand({ exe, appArgs = [] }) {
  const exePath = String(exe || "").trim();
  if (!exePath || !path.isAbsolute(exePath)) throw new Error("the desk executable path must be absolute");
  if (/"/.test(exePath) || appArgs.some((a) => /"/.test(String(a)))) throw new Error("a quote inside a path is refused");
  return [exePath, ...appArgs.map(String)].map((p) => `"${p}"`).join(" ");
}

/** `"C:\x\awdesk.exe" "C:\app" --files` -- every path quoted, the flag bare. */
function launchCommand({ exe, appArgs = [] }) {
  return `${baseCommand({ exe, appArgs })} ${FILES_FLAG}`;
}

/** The two reg.exe argv lists Enable runs, in order. */
function enableCommands({ exe, appArgs = [] }) {
  const value = launchCommand({ exe, appArgs });
  return [
    ["add", COMMAND_KEY, "/ve", "/t", "REG_SZ", "/d", value, "/f"],
    ["add", COMMAND_KEY, "/v", "DelegateExecute", "/t", "REG_SZ", "/d", "", "/f"],
  ];
}

/** The one reg.exe argv Restore runs. `createdKey` must be one of KEY_CHAIN. */
function restoreCommands(createdKey = COMMAND_KEY) {
  const key = KEY_CHAIN.includes(createdKey) ? createdKey : COMMAND_KEY;
  return [["delete", key, "/f"]];
}

function queryCommand(key = COMMAND_KEY) {
  return ["query", key, "/ve"];
}

/** The (Default) REG_SZ value out of `reg query <key> /ve` output, or null. */
function parseDefault(stdout) {
  for (const line of String(stdout || "").split(/\r?\n/)) {
    const m = /^\s+\S.*?\s+REG_(?:EXPAND_)?SZ\s+(.*)$/.exec(line);
    if (m) return m[1].trim();
  }
  return null;
}

function defaultExecFile(file, args, opts) {
  return new Promise((resolve) => {
    require("node:child_process").execFile(file, args, { ...opts, windowsHide: true }, (error, stdout, stderr) => {
      const code = error ? (typeof error.code === "number" ? error.code : 1) : 0;
      resolve({ code, stdout: String(stdout || ""), stderr: String(stderr || "") });
    });
  });
}

/**
 * @param {object} [opts]
 * @param {Function} [opts.execFile]  (file, args, opts) => Promise<{code, stdout, stderr}>
 * @param {string} [opts.platform]
 * @param {string} [opts.exe]         the desk executable (process.execPath)
 * @param {string[]} [opts.appArgs]   [app dir] when unpackaged, else []
 * @param {string} [opts.stateFile]
 * @param {object} [opts.env]
 * @param {Function} [opts.routed]    () => true once main.cjs routes `--files` (fail-closed)
 */
function createWinE({
  execFile = defaultExecFile,
  platform = process.platform,
  exe = process.execPath,
  appArgs = [],
  stateFile = path.join(os.homedir(), ".aither", STATE_NAME),
  env = process.env,
  routed = () => false,
} = {}) {
  const reg = (args) => Promise.resolve(execFile(regExe(env), args, { windowsHide: true, timeout: REG_TIMEOUT_MS }))
    .catch((error) => ({ code: -1, stdout: "", stderr: String((error && error.message) || error) }));

  function readState() {
    try {
      const raw = JSON.parse(fs.readFileSync(stateFile, "utf8"));
      return raw && KEY_CHAIN.includes(raw.createdKey) ? raw : null;
    } catch {
      return null;
    }
  }

  function isRouted() {
    try { return routed() === true; } catch { return false; }
  }

  function writeState(createdKey) {
    fs.mkdirSync(path.dirname(stateFile), { recursive: true });
    fs.writeFileSync(stateFile, `${JSON.stringify({ version: 1, createdKey, enabledAt: new Date().toISOString() }, null, 2)}\n`);
  }

  function dropState() {
    try { fs.unlinkSync(stateFile); } catch { /* already gone */ }
  }

  function windowsOnly() {
    return platform === "win32" ? null : { ok: false, reason: "Win+E takeover is Windows-only" };
  }

  async function status() {
    const refused = windowsOnly();
    if (refused) return { ...refused, supported: false };
    const q = await reg(queryCommand());
    const routedNow = isRouted();
    if (q.code !== 0) return { ok: true, supported: true, routed: routedNow, enabled: false, ours: false, command: null };
    const command = parseDefault(q.stdout);
    let ours;
    try { ours = command === launchCommand({ exe, appArgs }); } catch { ours = false; }
    if (!ours && command) ours = command.includes(FILES_FLAG) && command.toLowerCase().includes(String(exe).toLowerCase());
    return { ok: true, supported: true, routed: routedNow, enabled: Boolean(command), ours, command };
  }

  async function enable({ consent = false } = {}) {
    const refused = windowsOnly();
    if (refused) return refused;
    if (consent !== true) return { ok: false, reason: "needs the owner's consent -- turn it on from the Files page" };
    if (!isRouted()) {
      return { ok: false, reason: "1 launch route missing -- this desk build does not open Files from Win+E yet; nothing changed" };
    }
    let cmds;
    try { cmds = enableCommands({ exe, appArgs }); } catch (error) { return { ok: false, reason: String(error.message) }; }
    const now = await status();
    if (now.enabled && !now.ours) {
      return { ok: false, reason: `1 other Win+E override is set (${String(now.command).slice(0, 120)}) -- remove it first` };
    }
    // Which key will we create? The first missing level. A re-enable keeps the first record.
    const prior = readState();
    let createdKey = prior ? prior.createdKey : null;
    if (!createdKey) {
      for (const key of KEY_CHAIN) {
        const probe = await reg(["query", key]);
        if (probe.code !== 0) { createdKey = key; break; }
      }
      createdKey = createdKey || COMMAND_KEY;
    }
    // Record what we are about to create FIRST, so a crash or a partial write is restorable.
    try { writeState(createdKey); } catch { /* Restore then deletes the command key, the safe default */ }
    for (let i = 0; i < cmds.length; i += 1) {
      const r = await reg(cmds[i]);
      if (r.code === 0) continue;
      const why = r.stderr.trim().slice(0, 160) || `exit ${r.code}`;
      if (i === 0) {
        if (!prior) dropState(); // a re-enable keeps the record of the first one
        return { ok: false, reason: `reg.exe refused (${why}) -- nothing changed` };
      }
      // Half-written: undo exactly what this enable created.
      const [undo] = restoreCommands(createdKey);
      const back = await reg(undo);
      const gone = back.code === 0 || /unable to find|cannot find|was unable/i.test(back.stderr);
      if (gone) {
        dropState();
        return { ok: false, rolledBack: true, reason: `reg.exe refused (${why}) -- rolled back, Win+E opens Windows Explorer` };
      }
      return { ok: false, rolledBack: false,
        reason: `1 Win+E key half-written (${why}) -- press "Restore Windows Explorer" to remove it` };
    }
    return { ok: true, enabled: true, createdKey, command: cmds[0][6] };
  }

  async function restore() {
    const refused = windowsOnly();
    if (refused) return refused;
    const now = await status();
    const state = readState();
    if (!now.enabled && !state) return { ok: true, enabled: false, already: true };
    if (now.enabled && !now.ours) {
      // Another tool rewrote the command after us (or never was us): never delete its keys.
      if (state) dropState();
      return { ok: false, reason: "1 Win+E override is not Aither's -- left as it is" };
    }
    const [args] = restoreCommands(state ? state.createdKey : COMMAND_KEY);
    const r = await reg(args);
    const gone = r.code === 0 || /unable to find|cannot find|was unable/i.test(r.stderr);
    if (!gone) return { ok: false, reason: `reg.exe refused (${r.stderr.trim().slice(0, 160) || `exit ${r.code}`}) -- Win+E still opens Aither` };
    dropState();
    return { ok: true, enabled: false, deleted: args[1] };
  }

  return { status, enable, restore };
}

module.exports = {
  createWinE, baseCommand, launchCommand, enableCommands, restoreCommands, queryCommand, parseDefault, regExe,
  CLSID, BASE_KEY, COMMAND_KEY, KEY_CHAIN, FILES_FLAG,
};
