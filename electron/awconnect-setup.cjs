"use strict";

/**
 * "Set up Awconnect" -- the tray/palette action and the tray status line for the
 * Awconnect browser extension.
 *
 * Desk does not install anything itself: it runs `adk awconnect …` (awdk owns
 * staging into ~/.aither/awconnect/current, the verified release download,
 * browser detection and the read-only profile scan), so the tray, `aither
 * awconnect` and `adk awconnect` are one implementation.
 *
 * Electron-free: `execFile` is injected, so the whole decision is asserted under
 * `node --test`. main.cjs wires it (runCommand "awconnect.setup", the tray row).
 *
 * Why a status line at all: the extension "silently disappeared" from the
 * owner's Chrome (measured 2026-09-27: it was loaded in Edge from a build dir,
 * absent from every Chrome profile). A line that says where it is -- or that it
 * is nowhere -- turns that from a mystery into a click.
 */

const STATES = Object.freeze(["installed", "stale", "disabled", "not_installed", "unknown"]);

function pythonExecutable(env = process.env, platform = process.platform) {
  return env.AITHER_PYTHON || (platform === "win32" ? "python" : "python3");
}

/** The argv for one adk call. `install` never waits here -- desk re-probes instead. */
function adkArgv(action) {
  if (action === "status") return ["-m", "adk.cli", "awconnect", "status", "--json"];
  if (action === "install") return ["-m", "adk.cli", "awconnect", "install", "--json", "--wait", "0"];
  if (action === "update") return ["-m", "adk.cli", "awconnect", "install", "--update", "--json"];
  throw new Error(`unknown awconnect action ${action}`);
}

/** Parse adk's JSON; a missing/old awdk or garbage output is "unknown", never a throw. */
function parseJson(stdout) {
  const text = String(stdout || "").trim();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch (_) {
    // adk may print a line before the JSON (update notice); take the last object.
    const at = text.lastIndexOf("\n{");
    if (at >= 0) {
      try { return JSON.parse(text.slice(at + 1)); } catch (_) { /* fall through */ }
    }
    return null;
  }
}

function run(action, { execFile, env = process.env, platform = process.platform, timeoutMs } = {}) {
  return new Promise((resolve) => {
    execFile(pythonExecutable(env, platform), adkArgv(action), {
      env, windowsHide: true, timeout: timeoutMs || (action === "status" ? 20_000 : 180_000),
    }, (err, stdout, stderr) => {
      resolve({ err, json: parseJson(stdout), stderr: String(stderr || "") });
    });
  });
}

/** `{state, line, hits, latest}` -- the tray reads `state` and `line`. */
async function probeAwconnect(deps = {}) {
  const { json, stderr } = await run("status", deps);
  if (!json || !STATES.includes(json.state)) {
    const noAdk = /No module named|awconnect_setup|invalid choice/i.test(stderr);
    return {
      state: "unknown",
      line: noAdk ? "Awconnect: needs awdk (pip install -U awdk)" : "Awconnect: status unavailable",
      hits: [], latest: null,
    };
  }
  return { ...json, line: statusLine(json) };
}

/** Mirrors adk.awconnect_setup.status_line (the CLI's words), prefixed for the tray. */
function statusLine(st) {
  const hits = (st && st.hits) || [];
  const live = hits.find((h) => h.enabled) || hits[0] || null;
  const where = live ? `${live.browser_name} / ${live.profile}` : "";
  switch (st && st.state) {
    case "installed": return `Awconnect: installed${live && live.version ? ` ${live.version}` : ""} (${where})`;
    case "stale": return `Awconnect: stale ${live.version} (${where}) -- ${(st.latest && st.latest.version) || "update"} ready`;
    case "disabled": return `Awconnect: disabled (${where})`;
    case "not_installed": return "Awconnect: not installed";
    default: return "Awconnect: status unavailable";
  }
}

/** The command's label: what a click will DO given the last probe. */
function setupLabel(st) {
  switch (st && st.state) {
    case "installed": return "Awconnect: check again";
    case "stale": return "Update Awconnect…";
    case "disabled": return "Awconnect: open extensions to enable…";
    default: return "Set up Awconnect…";
  }
}

/** Zero or one disabled tray rows (like voice-tray-line.cjs). Nothing before a probe. */
function awconnectTrayItems(st) {
  if (!st) return [];
  return [{ label: st.line || statusLine(st), enabled: false }];
}

/**
 * Perform the action: install (stage + open extensions page + clipboard) or, when
 * already installed but stale, refresh the folder in place. Returns
 * `{ ok, message, steps, status }` for the palette / a dialog.
 */
async function runAwconnectSetup(deps = {}) {
  const before = deps.status || await probeAwconnect(deps);
  if (before.state === "installed") {
    return { ok: true, message: before.line || statusLine(before), steps: [], status: before };
  }
  // In-place refresh only helps a browser that loads OUR folder; a stale copy
  // loaded from anywhere else needs the full guided install.
  const loadsOurs = (before.hits || []).some((h) => h.enabled && h.uses_current);
  const action = before.state === "stale" && loadsOurs ? "update" : "install";
  const { json, stderr } = await run(action, deps);
  if (!json) {
    return {
      ok: false,
      message: /No module named/i.test(stderr)
        ? "awdk is not installed. Install it: pip install -U awdk (or the one-line installer at aitherium.com)"
        : `adk awconnect ${action} failed${stderr ? `: ${stderr.trim().split(/\r?\n/).pop()}` : ""}`,
      steps: [], status: before,
    };
  }
  if (!json.ok) return { ok: false, message: json.error || "install failed", steps: [], status: before };
  const steps = json.steps || [];
  const message = action === "update"
    ? `Awconnect ${json.staged && json.staged.version} staged. Click the reload arrow on its card in the extensions page.`
    : [`Awconnect ${json.staged && json.staged.version} is ready at ${json.staged && json.staged.path}.`,
      ...steps.map((s, i) => `${i + 1}. ${s}`)].join("\n");
  return { ok: true, message, steps, status: json.status || before, staged: json.staged || null };
}

module.exports = {
  STATES, adkArgv, parseJson, probeAwconnect, statusLine, setupLabel,
  awconnectTrayItems, runAwconnectSetup, pythonExecutable,
};
