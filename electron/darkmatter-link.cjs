"use strict";

/**
 * darkmatter-link.cjs -- the Darkmatter Link app inside the desk (one installable app
 * per platform: Darkmatter Link is an app in the desk, never its own installer).
 *
 * Electron-free and side-effect-free until a function is called: every effect (spawn,
 * fs, the gateway tool call, safeStorage) is injected, so `node --test` asserts the
 * whole contract without a window, a game or a network.
 *
 * What it does:
 *   - game health and the games list: the INSTALLED awdk pack's dml_status / dml_games
 *     tools (~/.aitheros/packs/darkmatter-link, `adk pack install`) -- the desk is a thin
 *     launcher over the pack, never a second implementation;
 *   - the DD2 pawn supervisor: `python -m darklink.dd2_agents` (the pip-installed runtime, or
 *     the checkout's AitherOS/packages/darklink via PYTHONPATH) started and stopped
 *     by the desk (stop kills the whole child tree);
 *   - pawn personas: ~/.aither/darklink/dd2-pawns.json, READ-ONLY here (the file is the
 *     owner's to edit; `locked` cards are never rewritten by anything);
 *   - model access: "local" (the local GPU through MicroScheduler, the supervisor's own
 *     default) or "cloud" (the Aitherium gateway with a gateway key the user pastes);
 *   - training-data consent: OFF by default. Turning it on or off calls the existing
 *     capture-pool opt-in tool; the local setting moves only after the tool succeeded.
 *
 * The gateway key is a live credential: it is held ONLY encrypted (Electron
 * safeStorage, injected as encrypt/decrypt) in gateway-key.bin, rides to the
 * supervisor in its ENVIRONMENT (never argv, which process listings and logs show),
 * and is never returned to the renderer -- the page learns only whether one is set.
 */

const os = require("node:os");
const path = require("node:path");

const DEFAULT_ROOT = "C:\\AitherOS-Fresh";
const CLOUD_GATEWAY_URL = "https://mcp.aitherium.com";
// The existing shop (product-launcher.cjs SHOP_BASE). A link only -- this app states no
// price and no tier; the shop is the one place that does.
const SHOP_URL = String(process.env.AITHER_SHOP_URL || "https://aitherium.com/shop").replace(/\/+$/, "");
const MODEL_MODES = Object.freeze(["local", "cloud"]);
const DEFAULT_SETTINGS = Object.freeze({ model_mode: "local", harvest_pool_opt_in: false, voices: true });
const KEY_SHAPE = /^aither_sk_[A-Za-z0-9_-]{8,}$/;

function repoRoot(env = process.env) {
  return String(env.AITHEROS_ROOT || DEFAULT_ROOT);
}

/** cwd for the runtime children (<repo>/AitherOS; an installed runtime does not care). */
function workDir(env = process.env) {
  return path.join(repoRoot(env), "AitherOS");
}

function pythonFile(env = process.env) {
  return env.AWDESK_PYTHON || "python";
}

function darklinkDir(home = os.homedir()) {
  return path.join(home, ".aither", "darklink");
}

function paths(home = os.homedir()) {
  const dir = darklinkDir(home);
  return {
    dir,
    settings: path.join(dir, "desk.json"),
    consent: path.join(dir, "consent.json"),
    pawns: process.env.DARKLINK_DD2_PAWNS || path.join(dir, "dd2-pawns.json"),
    key: path.join(dir, "gateway-key.bin"),
  };
}

/** The installed awdk pack (`adk pack install darkmatter-link-<v>.tar.gz`). */
function packDir(env = process.env, home = os.homedir()) {
  return String(env.AWDESK_DML_PACK || path.join(home, ".aitheros", "packs", "darkmatter-link"));
}

// Loads the pack's tools.py by path and calls ONE dml_* tool with JSON kwargs. The desk is
// a launcher over the pack: health and listings are the pack's tools, not a second copy.
const PACK_BRIDGE = [
  "import importlib.util, json, sys",
  "spec = importlib.util.spec_from_file_location('dml_tools', 'tools.py')",
  "m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)",
  "name = sys.argv[1]",
  "assert name.startswith('dml_'), name",
  "print(json.dumps(getattr(m, name)(**json.loads(sys.argv[2]))))",
].join("\n");

/** A health/listing command over the pack's tools: { file, args, cwd }. */
function buildCommand(verb, env = process.env, home = os.homedir()) {
  const call = {
    status: ["dml_status", { game: "dd2" }],
    games: ["dml_games", { action: "list" }],
  }[verb];
  if (!call) throw new Error(`unknown Darkmatter Link verb "${verb}"`);
  return { file: pythonFile(env), args: ["-c", PACK_BRIDGE, call[0], JSON.stringify(call[1])], cwd: packDir(env, home) };
}

/** A pack tool answers {ok, rc, data|output, error}; the page wants the tool's data. */
function unwrapTool(result) {
  if (result && typeof result === "object" && !Array.isArray(result) && "rc" in result) {
    return result.data !== undefined ? result.data : result;
  }
  return result;
}

/**
 * The supervisor's launch: argv carries NO credential; the cloud key rides in `env`.
 * `key` is the decrypted gateway key (cloud mode only).
 */
function supervisorCommand(settings, { key = "", env = process.env } = {}) {
  const s = normalizeSettings(settings);
  const args = ["-m", "darklink.dd2_agents"];
  if (!s.voices) args.push("--no-voice");
  // A pip-installed runtime needs nothing; a checkout's runtime is reached on PYTHONPATH
  // (the package source, then AitherOS/ for the monorepo's own lib.* modules).
  const sep = process.platform === "win32" ? ";" : ":";
  const extraEnv = {
    PYTHONPATH: [path.join(workDir(env), "packages", "darklink"), workDir(env), env.PYTHONPATH]
      .filter(Boolean).join(sep),
  };
  if (s.model_mode === "cloud") {
    if (!key) throw new Error("cloud mode needs a gateway key -- paste one under Model access");
    extraEnv.DARKLINK_LLM_MODE = "cloud";
    extraEnv.DARKLINK_LLM_URL = CLOUD_GATEWAY_URL;
    extraEnv.DARKLINK_LLM_KEY = key;
  }
  return { file: pythonFile(env), args, cwd: workDir(env), extraEnv };
}

/** What may be logged about a launch: file + argv + the NAMES of extra env vars. */
function describeLaunch(cmd) {
  return `${cmd.file} ${cmd.args.join(" ")} (env: ${Object.keys(cmd.extraEnv || {}).sort().join(", ") || "none"})`;
}

/** Kill a child and every process it started. */
function stopCommand(pid, platform = process.platform) {
  const n = Number(pid);
  if (!Number.isInteger(n) || n <= 0) throw new Error(`no supervisor pid to stop (${pid})`);
  if (platform === "win32") return { file: "taskkill", args: ["/PID", String(n), "/T", "/F"] };
  return { file: "kill", args: ["-TERM", `-${n}`] };
}

function normalizeSettings(raw) {
  const r = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  return {
    model_mode: MODEL_MODES.includes(r.model_mode) ? r.model_mode : DEFAULT_SETTINGS.model_mode,
    // Strictly opt-in: anything but a literal true is OFF.
    harvest_pool_opt_in: r.harvest_pool_opt_in === true,
    voices: r.voices !== false,
  };
}

function readJson(fsImpl, file) {
  try {
    return JSON.parse(fsImpl.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function writeJson(fsImpl, file, obj) {
  fsImpl.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fsImpl.writeFileSync(tmp, JSON.stringify(obj, null, 1), "utf8");
  fsImpl.renameSync(tmp, file);
}

function loadSettings({ fsImpl = require("node:fs"), home } = {}) {
  return normalizeSettings(readJson(fsImpl, paths(home).settings));
}

function saveSettings(patch, { fsImpl = require("node:fs"), home } = {}) {
  const next = normalizeSettings({ ...loadSettings({ fsImpl, home }), ...(patch || {}) });
  writeJson(fsImpl, paths(home).settings, next);
  return next;
}

/** Read-only persona rows for display. */
function loadPersonas({ fsImpl = require("node:fs"), home } = {}) {
  const doc = readJson(fsImpl, paths(home).pawns);
  const pawns = doc && typeof doc.pawns === "object" && doc.pawns ? doc.pawns : {};
  return Object.entries(pawns)
    .filter(([, card]) => card && typeof card === "object")
    .map(([key, card]) => ({
      key,
      name: String(card.name || key),
      persona: String(card.persona || card.temperament || ""),
      style: String(card.speech_style || card.style || ""),
      voice: card.voice ? String(typeof card.voice === "object" ? card.voice.name || card.voice.id || "" : card.voice) : "",
      locked: card.locked === true,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Turn the training-data consent on or off. The capture-pool tool goes FIRST; the
 * local setting and consent.json move only when it answered ok, so the page never
 * shows a consent the platform does not hold.
 */
async function setHarvestConsent(wanted, { callTool, fsImpl = require("node:fs"), home, now = () => new Date() } = {}) {
  const consent = wanted === true;
  if (typeof callTool !== "function") return { ok: false, error: "no gateway tool transport" };
  let result;
  try {
    result = await callTool("capture_pool_optin", { consent });
  } catch (err) {
    return { ok: false, error: String((err && err.message) || err) };
  }
  // gateway-mcp answers the tool's TEXT; a tool result is JSON, prose is an error.
  if (typeof result === "string") {
    const parsed = parseJsonOutput(result);
    result = parsed && typeof parsed === "object" ? parsed : { error: result.slice(0, 300) || "empty answer" };
  }
  const failed = !result || result.ok === false || result.error || result.isError
    || (Number(result.status) >= 400);
  if (failed) {
    const why = (result && (result.error || result.detail || result.status)) || "no answer";
    return { ok: false, error: `capture pool refused: ${typeof why === "string" ? why : JSON.stringify(why)}` };
  }
  const settings = saveSettings({ harvest_pool_opt_in: consent }, { fsImpl, home });
  writeJson(fsImpl, paths(home).consent, { harvest_pool: consent, updated: now().toISOString() });
  return { ok: true, settings };
}

/** Store the gateway key encrypted. `encrypt(string) -> Buffer` (safeStorage). */
function saveGatewayKey(key, { encrypt, fsImpl = require("node:fs"), home } = {}) {
  const k = String(key || "").trim();
  if (!KEY_SHAPE.test(k)) return { ok: false, error: "that is not an Aitherium gateway key (aither_sk_...)" };
  if (typeof encrypt !== "function") return { ok: false, error: "secure storage is not available on this machine" };
  const file = paths(home).key;
  fsImpl.mkdirSync(path.dirname(file), { recursive: true });
  fsImpl.writeFileSync(file, encrypt(k), { mode: 0o600 });
  return { ok: true, hasKey: true };
}

function loadGatewayKey({ decrypt, fsImpl = require("node:fs"), home } = {}) {
  if (typeof decrypt !== "function") return "";
  try {
    return String(decrypt(fsImpl.readFileSync(paths(home).key)) || "");
  } catch {
    return "";
  }
}

function hasGatewayKey({ fsImpl = require("node:fs"), home } = {}) {
  try {
    return fsImpl.statSync(paths(home).key).size > 0;
  } catch {
    return false;
  }
}

function clearGatewayKey({ fsImpl = require("node:fs"), home } = {}) {
  try {
    fsImpl.unlinkSync(paths(home).key);
  } catch {
    /* already gone */
  }
  return { ok: true, hasKey: false };
}

/** Parse a python JSON stdout; the last JSON line wins (warnings may precede it). */
function parseJsonOutput(stdout) {
  const text = String(stdout || "").trim();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    /* fall through to line scan */
  }
  const lines = text.split(/\r?\n/).reverse();
  for (const line of lines) {
    try {
      return JSON.parse(line);
    } catch {
      /* next */
    }
  }
  return null;
}

module.exports = {
  CLOUD_GATEWAY_URL, SHOP_URL, MODEL_MODES, DEFAULT_SETTINGS,
  repoRoot, workDir, paths, packDir, buildCommand, unwrapTool, PACK_BRIDGE, supervisorCommand, describeLaunch, stopCommand,
  normalizeSettings, loadSettings, saveSettings, loadPersonas, setHarvestConsent,
  saveGatewayKey, loadGatewayKey, hasGatewayKey, clearGatewayKey, parseJsonOutput,
};
