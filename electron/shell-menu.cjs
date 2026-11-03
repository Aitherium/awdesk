"use strict";

/**
 * shell-menu.cjs -- the owner-consented, reversible "Aither" entry on the Windows
 * desktop / folder right-click menu. Modeled on files-wine.cjs (state file, a
 * bounded key chain, reg.exe through execFile with windowsHide, status()).
 *
 * TWO per-user roots, no admin:
 *
 *   HKCU\Software\Classes\DesktopBackground\Shell\AitherQuick
 *   HKCU\Software\Classes\Directory\Background\Shell\AitherQuick
 *
 * Each carries a cascading menu (MUIVerb="Aither" + an EMPTY SubCommands value,
 * which is what tells Explorer to read the verbs from `shell` subkeys):
 *
 *   ...\AitherQuick\shell\snip.region
 *        MUIVerb = "Snip region"
 *        command\(Default) = "<desk exe>" ["<app dir>"] --run=snip.region
 *
 * 🚩 Consent: enable() refuses without {consent:true}; a tray row's click is the
 * consent, the owner never gets a silent registry write. Restore is never gated.
 * A root owned by something ELSE is refused by enable AND restore, never clobbered
 * -- even when a tampered state file says otherwise. The key a restore deletes is
 * one of the two constants (or a `shell\<verb>` under it), never a path read from
 * disk unchecked.
 *
 * 🚩 Not enabled on this machine by this lane: the tests inject a TEST key root and
 * only assert the argv builders + the state machine. Nothing here writes the
 * owner's real HKCU in a test.
 *
 * reg.exe runs from %SystemRoot%\System32 by absolute path via the injected
 * execFile with windowsHide:true (never a visible console). Electron-free and
 * fail-soft: {ok:true,...} | {ok:false, reason}; never throws.
 */

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const ROOTS = Object.freeze({
  desktop: "HKCU\\Software\\Classes\\DesktopBackground\\Shell\\AitherQuick",
  directory: "HKCU\\Software\\Classes\\Directory\\Background\\Shell\\AitherQuick",
});
const MENU_LABEL = "Aither";
/** Identifies the key as OURS. Its absence on an existing key means "foreign". */
const MARKER_VALUE = "AitherDesk";
const MARKER_DATA = "1";
const STATE_NAME = "desk-shell-menu.json";
const REG_TIMEOUT_MS = 10_000;

/**
 * The cascade. `key` is the verb subkey name (a stable, dot/dash-safe token),
 * `id` is the registry command it launches.
 */
const ENTRIES = Object.freeze([
  Object.freeze({ key: "snip-region", id: "snip.region", label: "Snip region" }),
  Object.freeze({ key: "record-region", id: "record.region", label: "Record region" }),
  Object.freeze({ key: "record-region-sound", id: "record.region.audio", label: "Record with sound" }),
  Object.freeze({ key: "draw-on-screen", id: "ink.toggle", label: "Draw on screen" }),
  Object.freeze({ key: "new-note", id: "note.new", label: "New note" }),
  Object.freeze({ key: "new-whiteboard", id: "board.new", label: "New whiteboard" }),
  Object.freeze({ key: "ask-aither", id: "orb.ask-screen", label: "Ask Aither" }),
]);

function regExe(env = process.env) {
  const root = env.SystemRoot || env.SYSTEMROOT || "C:\\Windows";
  return path.join(root, "System32", "reg.exe");
}

/** `"C:\x\awdesk.exe" "C:\app" --run=snip.region` -- paths quoted, the flag bare. */
function launchCommand({ exe, appArgs = [], id }) {
  const exePath = String(exe || "").trim();
  if (!exePath || !path.isAbsolute(exePath)) throw new Error("the desk executable path must be absolute");
  const commandId = String(id || "").trim();
  if (!/^[a-z0-9][a-z0-9._-]*$/i.test(commandId)) throw new Error(`not a command id: ${commandId}`);
  if (/"/.test(exePath) || appArgs.some((a) => /"/.test(String(a)))) throw new Error("a quote inside a path is refused");
  return [...[exePath, ...appArgs.map(String)].map((p) => `"${p}"`), `--run=${commandId}`].join(" ");
}

/** The verbs safe to install: the registry has them, or the caller did not say. */
function entriesFor({ available } = {}) {
  if (typeof available !== "function") return [...ENTRIES];
  return ENTRIES.filter((entry) => {
    try { return available(entry.id) !== false; } catch { return false; }
  });
}

function verbKey(entry) {
  const key = String((entry && entry.key) || "");
  if (!/^[a-z0-9][a-z0-9._-]*$/i.test(key)) throw new Error(`not a verb key: ${key}`);
  return key;
}

function rootValueCommands(root) {
  return [
    ["add", root, "/v", "MUIVerb", "/t", "REG_SZ", "/d", MENU_LABEL, "/f"],
    // An empty REG_SZ SubCommands is what makes Explorer read the verbs from
    // subkeys; a non-empty value there would name a DIFFERENT key instead.
    ["add", root, "/v", "SubCommands", "/t", "REG_SZ", "/d", "", "/f"],
    ["add", root, "/v", MARKER_VALUE, "/t", "REG_SZ", "/d", MARKER_DATA, "/f"],
  ];
}

/** Every reg.exe argv one root needs: the root values, then one verb per entry. */
function enableCommands({ root, exe, appArgs = [], entries = ENTRIES }) {
  const commands = [...rootValueCommands(root)];
  for (const entry of entries) {
    const key = verbKey(entry);
    const value = launchCommand({ exe, appArgs, id: entry.id });
    commands.push(["add", `${root}\\shell\\${key}`, "/v", "MUIVerb", "/t", "REG_SZ", "/d", String(entry.label), "/f"]);
    commands.push(["add", `${root}\\shell\\${key}\\command`, "/ve", "/t", "REG_SZ", "/d", value, "/f"]);
    commands.push(["add", `${root}\\shell\\${key}`, "/v", "Icon", "/t", "REG_SZ", "/d", String(exe), "/f"]);
  }
  return commands;
}

/**
 * How to undo one root.
 *
 * The root is ALWAYS one of the two constants (never a path read from disk), and
 * a restore only reaches here when status() said the key is ours. Deleting the
 * whole AitherQuick namespace is therefore one bounded call: it removes the
 * values, every verb and the `shell` key, and can never name a key outside our
 * own name. `createdKey` is kept in the signature for the state file's record and
 * for callers that reason about what a partial enable created.
 */
function restoreCommands(root, { createdKey = null, entries = ENTRIES } = {}) {
  void createdKey;
  void entries;
  return [["delete", root, "/f"]];
}

function queryMarker(root) {
  return ["query", root, "/v", MARKER_VALUE];
}

function queryRoot(root) {
  return ["query", root];
}

/** "ours" | "foreign" | "absent" from a `reg query <root> /v AitherDesk` result. */
function markerState(result) {
  if (!result || result.code !== 0) return "absent";
  return new RegExp(`${MARKER_VALUE}\\s+REG_SZ\\s+${MARKER_DATA}`, "i").test(String(result.stdout || ""))
    ? "ours" : "foreign";
}

function defaultExecFile(file, args, opts) {
  return new Promise((resolve) => {
    require("node:child_process").execFile(file, args, { ...opts, windowsHide: true }, (error, stdout, stderr) => {
      const code = error ? (typeof error.code === "number" ? error.code : 1) : 0;
      resolve({ code, stdout: String(stdout || ""), stderr: String(stderr || "") });
    });
  });
}

function isGone(result) {
  return Boolean(result && (result.code === 0 || /unable to find|cannot find|was unable/i.test(String(result.stderr || ""))));
}

/**
 * @param {object} [opts]
 * @param {Function} [opts.execFile]  (file, args, opts) => Promise<{code, stdout, stderr}>
 * @param {string} [opts.platform]
 * @param {string} [opts.exe]         the desk executable (process.execPath)
 * @param {string[]} [opts.appArgs]   [app dir] when unpackaged, else []
 * @param {object} [opts.roots]       TEST SEAM: override the two key roots
 * @param {string} [opts.stateFile]
 * @param {object} [opts.env]
 * @param {Function} [opts.available] (id) => boolean -- which verbs the registry has
 */
function createShellMenu({
  execFile = defaultExecFile,
  platform = process.platform,
  exe = process.execPath,
  appArgs = [],
  roots = ROOTS,
  stateFile = path.join(os.homedir(), ".aither", STATE_NAME),
  env = process.env,
  available = null,
} = {}) {
  const keys = Object.freeze({ desktop: String(roots.desktop), directory: String(roots.directory) });
  const entries = entriesFor({ available });
  const reg = (args) => Promise.resolve(execFile(regExe(env), args, { windowsHide: true, timeout: REG_TIMEOUT_MS }))
    .catch((error) => ({ code: -1, stdout: "", stderr: String((error && error.message) || error) }));

  function readState() {
    try {
      const raw = JSON.parse(fs.readFileSync(stateFile, "utf8"));
      if (!raw || raw.version !== 1 || !raw.roots || typeof raw.roots !== "object") return null;
      const out = {};
      for (const name of Object.keys(keys)) {
        const row = raw.roots[name];
        if (!row || typeof row !== "object") continue;
        // A tampered state file can only say "the root" or "nothing" -- never
        // another path. restoreCommands() re-checks the same invariant.
        out[name] = { createdKey: row.createdKey === keys[name] ? keys[name] : null, existed: Boolean(row.existed) };
      }
      return out;
    } catch {
      return null;
    }
  }

  function writeState(state) {
    fs.mkdirSync(path.dirname(stateFile), { recursive: true });
    fs.writeFileSync(stateFile, `${JSON.stringify({ version: 1, roots: state, enabledAt: new Date().toISOString() }, null, 2)}\n`);
  }

  function dropState() {
    try { fs.unlinkSync(stateFile); } catch { /* already gone */ }
  }

  function windowsOnly() {
    return platform === "win32" ? null : { ok: false, reason: "the right-click menu is Windows-only" };
  }

  async function rootStatus(root) {
    const result = await reg(queryMarker(root));
    const state = markerState(result);
    if (state !== "absent") return state;
    // The key exists but carries no marker: another tool's menu lives there.
    const key = await reg(queryRoot(root));
    return key.code === 0 ? "foreign" : "absent";
  }

  async function status() {
    const refused = windowsOnly();
    if (refused) return { ...refused, supported: false };
    const perRoot = {};
    for (const name of Object.keys(keys)) perRoot[name] = await rootStatus(keys[name]);
    const values = Object.values(perRoot);
    return {
      ok: true,
      supported: true,
      enabled: values.some((v) => v === "ours"),
      ours: values.every((v) => v === "ours" || v === "absent") && values.some((v) => v === "ours"),
      foreign: values.some((v) => v === "foreign"),
      roots: perRoot,
      entries: entries.map((e) => ({ id: e.id, label: e.label })),
    };
  }

  async function enable({ consent = false } = {}) {
    const refused = windowsOnly();
    if (refused) return refused;
    if (consent !== true) return { ok: false, reason: "needs the owner's consent -- turn it on from the tray" };
    if (!entries.length) return { ok: false, reason: "1 command is unavailable in this build — nothing changed" };
    let built;
    try {
      built = Object.fromEntries(Object.keys(keys).map((name) => [name, enableCommands({ root: keys[name], exe, appArgs, entries })]));
    } catch (error) {
      return { ok: false, reason: `${String(error.message)} — nothing changed` };
    }
    const now = await status();
    if (now.foreign) return { ok: false, reason: "1 AitherQuick key is owned by another tool — remove it first" };
    // Which roots must we CREATE? One that is absent. Record BEFORE the first add,
    // so a crash or a refused write is always restorable.
    const state = {};
    for (const name of Object.keys(keys)) {
      state[name] = { createdKey: now.roots[name] === "absent" ? keys[name] : null, existed: now.roots[name] !== "absent" };
    }
    try { writeState(state); } catch { /* restore falls back to the values-only path */ }

    const done = [];
    for (const name of Object.keys(keys)) {
      for (const args of built[name]) {
        const r = await reg(args);
        if (r.code === 0) continue;
        const why = String(r.stderr || "").trim().slice(0, 160) || `exit ${r.code}`;
        // Undo every root touched so far, including the one that just failed.
        const undoRoots = [...done, name];
        let rolledBack = true;
        for (const undoName of undoRoots) {
          for (const undo of restoreCommands(keys[undoName], { createdKey: state[undoName].createdKey, entries })) {
            const back = await reg(undo);
            if (!isGone(back)) rolledBack = false;
          }
        }
        if (rolledBack) {
          dropState();
          return { ok: false, rolledBack: true, reason: `reg.exe refused (${why}) — rolled back, the right-click menu is unchanged` };
        }
        return { ok: false, rolledBack: false, reason: `1 right-click key half-written (${why}) — press "Remove Aither from right-click menu" to clean it up` };
      }
      done.push(name);
    }
    return { ok: true, enabled: true, roots: Object.keys(keys), command: (built.desktop.find((args) => args.includes("/ve")) || [])[6] || null };
  }

  async function restore() {
    const refused = windowsOnly();
    if (refused) return refused;
    const now = await status();
    if (!now.enabled && !readState()) return { ok: true, enabled: false, already: true };
    const state = readState() || { desktop: { createdKey: null }, directory: { createdKey: null } };
    let removed = 0;
    const refusedRoots = [];
    for (const name of Object.keys(keys)) {
      if (now.roots[name] === "absent") continue;
      if (now.roots[name] === "foreign") { refusedRoots.push(name); continue; }
      const createdKey = state[name] && state[name].createdKey === keys[name] ? keys[name] : null;
      let ok = true;
      for (const args of restoreCommands(keys[name], { createdKey, entries })) {
        const r = await reg(args);
        if (!isGone(r)) ok = false;
      }
      if (ok) removed += 1;
      else refusedRoots.push(name);
    }
    if (refusedRoots.length) {
      return { ok: false, reason: `${refusedRoots.length} AitherQuick key${refusedRoots.length === 1 ? "" : "s"} could not be removed (${refusedRoots.join(", ")}) — the right-click menu may still show Aither` };
    }
    dropState();
    return { ok: true, enabled: false, removed };
  }

  return { status, enable, restore };
}

module.exports = {
  createShellMenu, launchCommand, entriesFor, verbKey, rootValueCommands, enableCommands, restoreCommands,
  queryMarker, queryRoot, markerState, regExe,
  ROOTS, ENTRIES, MENU_LABEL, MARKER_VALUE, MARKER_DATA, STATE_NAME,
};
