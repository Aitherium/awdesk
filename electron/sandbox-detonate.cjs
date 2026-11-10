"use strict";

/**
 * sandbox-detonate -- "send this file to the Windows Sandbox and show me what it did".
 *
 * The awdk desktop tools already do the work (AitherOS PR #15870): the harness
 * daemon on loopback :8362 serves ``desktop_sandbox_doctor`` and
 * ``desktop_sandbox_detonate`` on ``/desk/tools/{name}``. ``detonate`` is a
 * write-class tool whose route answers 403 ``confirm_required`` unless the call
 * carries ``confirm: true``. This module is the desk's half of that contract:
 *
 *   1. The owner picks ONE file (or a ``desk://sandbox/detonate?path=`` link
 *      arrives). NOTHING is called on the daemon yet.
 *   2. A confirm card names the file, its size and SHA-256 and says the sandbox
 *      runs it with networking off. Only the owner's click on that card calls
 *      ``desktop_sandbox_detonate`` -- with ``network: "off"`` and
 *      ``confirm: true``, never anything else.
 *   3. The doctor runs first, on that click. Not ready -> its EXACT fix text is
 *      shown and nothing else is called (the fix needs an administrator and a
 *      reboot; the desk never elevates).
 *   4. The receipt becomes a verdict-free report card: counts, the run folder
 *      (only when it is under ``%LOCALAPPDATA%\sandbox-mcp\runs``), and the words
 *      "heuristics, not a safety verdict".
 *   5. One detonation at a time: a second request while one holds the slot gets a
 *      busy card, never a second call.
 *
 * Guest output is DATA. It is flattened to plain text and capped before it ever
 * reaches a surface, and this module contains no HTML sink -- the card carries
 * strings, and the desk's dialog renders them as text.
 *
 * Pure logic over injected dependencies (no Electron, no window): node --test.
 */

const nodeCrypto = require("node:crypto");
const nodeFs = require("node:fs");
const nodeOs = require("node:os");
const nodePath = require("node:path");

const { DAEMON, harnessToken } = require("./sessions-client.cjs");

const ROUTE = "/desk/tools";
const TOOL_DOCTOR = "desktop_sandbox_doctor";
const TOOL_DETONATE = "desktop_sandbox_detonate";

/** The one network mode the desk ever sends. Never "on", never "firewall". */
const NETWORK = "off";

/** A receipt larger than this, or a file bigger than this, is refused, not buffered. */
const MAX_GUEST_CHARS = 2000;
const MAX_HASH_BYTES = 8 * 1024 * 1024 * 1024; // 8 GiB: a fingerprint, not a scan of a disk
const HASH_CHUNK = 1024 * 1024;
const DOCTOR_TIMEOUT_MS = 3 * 60 * 1000;
const DETONATE_TIMEOUT_MS = 15 * 60 * 1000;
const FINDINGS_NOTE = "heuristics, not a safety verdict";

// ── paths ───────────────────────────────────────────────────────────────────

/** `%LOCALAPPDATA%\sandbox-mcp\runs` -- the ONLY folder the desk will open. */
function runsRoot({ env = process.env, os = nodeOs, path = nodePath } = {}) {
  const local = String(env.LOCALAPPDATA || "").trim();
  const base = local || path.join(os.homedir(), "AppData", "Local");
  return path.resolve(path.join(base, "sandbox-mcp", "runs"));
}

/** A path that may be handed to the sandbox: local, absolute, not a device/UNC, not a flag. */
function localAbsolute(value) {
  const raw = String(value == null ? "" : value).trim();
  if (!raw) return { ok: false, reason: "path_missing", error: "a file path is required" };
  if (/[\u0000-\u001f]/.test(raw)) {
    return { ok: false, reason: "bad_path", error: "the path contains a control character" };
  }
  if (raw.startsWith("-")) {
    return { ok: false, reason: "bad_path", error: "a target may not start with '-'" };
  }
  const unc = /^(?:\\\\|\/\/|\\\/|\/\\|\?\\)/.test(raw);
  if (unc) {
    return { ok: false, reason: "bad_path", error: "network, device and extended paths are refused" };
  }
  const win = /^[A-Za-z]:[\\/]/.test(raw);
  const posix = raw.startsWith("/") && !raw.startsWith("//");
  if (!win && !posix) {
    return { ok: false, reason: "bad_path", error: "the path must be absolute" };
  }
  return { ok: true, path: raw };
}

/** True when `child` resolves strictly inside `root` (case-insensitive on Windows). */
function isInside(child, root, path = nodePath) {
  const rel = path.relative(path.resolve(root), path.resolve(child));
  if (!rel) return false; // the root itself is not a run folder
  const up = rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel);
  return !up;
}

/** A desk link's target: absolute local path, or a refusal. */
function parseDetonateUrl(rawUrl) {
  let url;
  try {
    url = new URL(String(rawUrl || ""));
  } catch {
    return { ok: false, reason: "bad_url", error: "not a link" };
  }
  if (url.protocol !== "desk:") return { ok: false, reason: "bad_url", error: "not a desk:// link" };
  const action = `${url.hostname || ""}${url.pathname || ""}`.toLowerCase();
  if (action.replace(/\/+$/, "") !== "sandbox/detonate") {
    return { ok: false, reason: "bad_url", error: "not a sandbox detonate link" };
  }
  const target = url.searchParams.get("path");
  if (!target) return { ok: false, reason: "path_missing", error: "the link names no file" };
  return localAbsolute(target);
}

// ── target inspection ───────────────────────────────────────────────────────

/** SHA-256 of a file, read in chunks so a large file is never buffered whole. */
function sha256File(file, { fs = nodeFs, crypto = nodeCrypto } = {}) {
  const hash = crypto.createHash("sha256");
  const fd = fs.openSync(file, "r");
  try {
    const buf = Buffer.allocUnsafe(HASH_CHUNK);
    for (;;) {
      const n = fs.readSync(fd, buf, 0, buf.length, null);
      if (!n) break;
      hash.update(buf.subarray(0, n));
    }
  } finally {
    fs.closeSync(fd);
  }
  return hash.digest("hex");
}

/** Size + SHA-256 of ONE existing file, or a refusal. */
function inspectTarget(target, { fs = nodeFs, path = nodePath, hash = sha256File } = {}) {
  const check = localAbsolute(target);
  if (!check.ok) return check;
  const file = path.resolve(check.path);
  let stat;
  try {
    stat = fs.statSync(file);
  } catch {
    return { ok: false, reason: "path_missing", error: `${file} does not exist` };
  }
  if (!stat.isFile()) return { ok: false, reason: "not_a_file", error: `${file} is not a file` };
  if (stat.size > MAX_HASH_BYTES) {
    return { ok: false, reason: "too_large", error: `${file} is too large to fingerprint safely` };
  }
  let digest;
  try {
    digest = hash(file);
  } catch (error) {
    return { ok: false, reason: "unreadable", error: `could not read ${file}: ${error && error.message}` };
  }
  return { ok: true, path: file, name: path.basename(file), size: stat.size, sha256: String(digest).toLowerCase() };
}

/** "12,345,678 bytes (11.8 MiB)" -- exact bytes first, then a human scale. */
function sizeLabel(bytes) {
  const n = Number(bytes);
  if (!Number.isFinite(n) || n < 0) return "unknown size";
  const units = ["B", "KiB", "MiB", "GiB", "TiB"];
  let value = n;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const human = unit === 0 ? `${n}` : `${value.toFixed(1)} ${units[unit]}`;
  return `${n.toLocaleString("en-US")} bytes (${human})`;
}

// ── guest text: plain, capped, never markup ─────────────────────────────────

/** Collapse guest output to plain text and cap it. Nothing here can become markup. */
function plainText(value, max = MAX_GUEST_CHARS) {
  if (typeof value !== "string" && typeof value !== "number") return "";
  const text = String(value)
    .replace(/\r\n?/g, "\n")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  const limit = Math.max(0, Number(max) || 0);
  if (text.length <= limit) return text;
  return `${text.slice(0, Math.max(0, limit - 1)).trimEnd()}…`;
}

/** Write guest text into a DOM node as TEXT. Never touches innerHTML. */
function setText(element, value, max = MAX_GUEST_CHARS) {
  if (!element || typeof element !== "object") return "";
  const text = plainText(value, max);
  element.textContent = text;
  return text;
}

// ── cards ───────────────────────────────────────────────────────────────────

/** The ONE confirm card. Its `token` is what `confirm()` accepts. */
function confirmCard(info, token) {
  return {
    kind: "confirm",
    title: "Detonate a file in Windows Sandbox?",
    file: info.path,
    name: info.name,
    size: info.size,
    sizeLabel: sizeLabel(info.size),
    sha256: info.sha256,
    network: NETWORK,
    token,
    confirmLabel: "Detonate",
    cancelLabel: "Cancel",
    lines: [
      `File: ${info.path}`,
      `Size: ${sizeLabel(info.size)}`,
      `SHA-256: ${info.sha256}`,
      "A fresh, disposable Windows Sandbox runs this file with networking off.",
      "The sandbox is deleted after the run. Its findings are heuristics, not a safety verdict.",
    ],
  };
}

/** The doctor's not-ready card: the EXACT fix text, and no action at all. */
function doctorCard(result) {
  const data = (result && result.result) || result || {};
  const admin = typeof data.admin_command === "string" ? data.admin_command : "";
  const once = typeof data.owner_once === "string" ? data.owner_once : "";
  const error = plainText(data.error || (result && result.error) || "", 800);
  const fix = once || admin || error || "Windows Sandbox is not ready on this PC.";
  return {
    kind: "doctor",
    title: "Windows Sandbox is not ready",
    ready: false,
    adminCommand: admin,
    ownerOnce: once,
    fixText: fix,
    action: null, // nothing runs; the fix needs an administrator and a reboot
    lines: [
      fix,
      "The desk never elevates. Run the command above yourself, restart Windows, then try again.",
    ].filter(Boolean),
    findingsNote: FINDINGS_NOTE,
  };
}

function busyCard() {
  return {
    kind: "busy",
    title: "A detonation is already running",
    text: "Windows Sandbox allows one at a time. Wait for the running file to finish, then send this one.",
    action: null,
  };
}

function problemCard(message, reason = "problem") {
  return { kind: "problem", title: "Could not prepare the detonation", reason, text: plainText(message, 800), action: null };
}

const COUNT_KEYS = Object.freeze({
  processes: ["processes", "process_list", "processList", "processes_started", "processesStarted"],
  lookups: ["lookups", "dns_lookups", "dnsLookups", "name_lookups", "nameLookups", "dns"],
  connections: ["connections", "connection_attempts", "connectionAttempts", "network_connections", "networkConnections", "network"],
  persistence: ["autoruns", "scheduled_tasks", "scheduledTasks", "services", "files_created", "filesCreated", "files"],
});

function sourcesOf(result) {
  const out = [];
  for (const value of [result && result.report, result && result.data]) {
    if (value && typeof value === "object") out.push(value);
  }
  return out;
}

function countValue(sources, keys) {
  for (const source of sources) {
    for (const key of keys) {
      const value = source[key];
      if (Array.isArray(value)) return value.length;
      if (typeof value === "number" && Number.isFinite(value)) return value;
    }
  }
  return null;
}

/** Verdict-free counts from the receipt. `null` = not reported, never a fabricated zero. */
function reportCounts(result) {
  const sources = sourcesOf(result);
  const counts = {};
  for (const [label, keys] of Object.entries(COUNT_KEYS)) {
    if (label !== "persistence") {
      counts[label] = countValue(sources, keys);
      continue;
    }
    let total = null;
    for (const key of keys) {
      const n = countValue(sources, [key]);
      if (n !== null) total = (total || 0) + n;
    }
    counts.persistence = total;
  }
  return counts;
}

function countLine(counts) {
  const label = (name, value) => `${name}: ${value === null ? "not reported" : value}`;
  return [
    label("Processes", counts.processes),
    label("Name lookups", counts.lookups),
    label("Connection attempts", counts.connections),
    label("Persistence entries", counts.persistence),
  ].join(" · ");
}

/** The report card. The run folder is offered ONLY when it is under the runs root. */
function reportCard(result, { root = runsRoot(), path = nodePath } = {}) {
  const data = (result && result.result) || result || {};
  const runDirRaw = typeof data.run_dir === "string" ? data.run_dir : "";
  const runDir = runDirRaw && localAbsolute(runDirRaw).ok && isInside(runDirRaw, root, path)
    ? path.resolve(runDirRaw)
    : null;
  const counts = reportCounts(data);
  const guestSource = data.report && typeof data.report === "object"
    ? data.report.summary || data.report.headline || data.report.detail || ""
    : "";
  return {
    kind: "report",
    title: "Sandbox report",
    ok: Boolean(data.ok),
    exitCode: Number.isFinite(data.exit_code) ? data.exit_code : null,
    timedOut: Boolean(data.timed_out),
    counts,
    countLine: countLine(counts),
    runDir,
    openFolder: Boolean(runDir),
    guestText: plainText(guestSource, MAX_GUEST_CHARS),
    findingsNote: FINDINGS_NOTE,
    error: plainText(data.error || "", 800),
    lines: [
      `Exit ${Number.isFinite(data.exit_code) ? data.exit_code : "?"}${data.timed_out ? " (timed out)" : ""}`,
      countLine(counts),
      runDir ? `Run folder: ${runDir}` : "The receipt did not report a run folder the desk may open.",
      "These findings are " + FINDINGS_NOTE + ".",
    ],
  };
}

/** Open a run folder, refusing anything outside the runs root BEFORE calling openPath. */
async function openRunFolder(cardOrPath, { root = runsRoot(), openPath, path = nodePath } = {}) {
  const raw = typeof cardOrPath === "string" ? cardOrPath : cardOrPath && cardOrPath.runDir;
  if (!raw) return { ok: false, reason: "no_run_folder", error: "this run reported no folder to open" };
  const check = localAbsolute(raw);
  if (!check.ok) return { ok: false, reason: check.reason, error: check.error };
  if (!isInside(raw, root, path)) {
    return { ok: false, reason: "outside_runs_root", error: `${raw} is not under ${root}; refusing to open it` };
  }
  if (typeof openPath !== "function") return { ok: false, reason: "no_opener", error: "no file opener is wired" };
  const opened = path.resolve(raw);
  const why = await openPath(opened);
  if (why) return { ok: false, reason: "open_failed", error: String(why) };
  return { ok: true, opened };
}

// ── the daemon ──────────────────────────────────────────────────────────────

/** POST one read/write tool to /desk/tools/{name}. Never throws; failures are answers. */
async function callDeskTool(name, args = {}, {
  fetchImpl = globalThis.fetch,
  daemon = DAEMON,
  token = harnessToken(),
  confirm = false,
  timeoutMs = DOCTOR_TIMEOUT_MS,
} = {}) {
  if (!token) {
    return { ok: false, reason: "no_token", error: "no harness token (~/.aither/harness_token) -- start the daemon: adk harness serve" };
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(1000, Number(timeoutMs) || DOCTOR_TIMEOUT_MS));
  timer.unref?.();
  try {
    const res = await fetchImpl(`${daemon}${ROUTE}/${encodeURIComponent(name)}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ args, confirm: confirm === true }),
      signal: controller.signal,
    });
    let body = null;
    try { body = await res.json(); } catch { body = null; }
    if (!res.ok) {
      return {
        ok: false,
        status: res.status,
        reason: (body && body.reason) || `http_${res.status}`,
        error: (body && body.error) || `the daemon answered ${res.status}`,
      };
    }
    const result = body && Object.prototype.hasOwnProperty.call(body, "result") ? body.result : body;
    return { ok: Boolean(body && body.ok), status: res.status, result: result || {} };
  } catch (error) {
    const aborted = error && (error.name === "AbortError" || error.code === "ABORT_ERR");
    return {
      ok: false,
      reason: aborted ? "timeout" : "unreachable",
      error: aborted
        ? `${name} did not answer in time`
        : `daemon unreachable -- start it: adk harness serve (${(error && error.message) || error})`,
    };
  } finally {
    clearTimeout(timer);
  }
}

// ── the flow ────────────────────────────────────────────────────────────────

/** Doctor says ready? Anything other than an explicit ready answer is NOT ready. */
function doctorReady(result) {
  const data = (result && result.result) || result || {};
  return Boolean(result && result.ok) && data.ready !== false;
}

let nextToken = 0;

/**
 * The state machine. NO daemon call happens in `request()`; the doctor and the
 * detonate call both happen only after the owner clicks the confirm card.
 */
function createSandboxDetonator({
  callTool = callDeskTool,
  inspect = inspectTarget,
  root = runsRoot(),
  openPath = null,
  path = nodePath,
  log = () => {},
} = {}) {
  let busy = false;
  let pending = null; // { token, target }

  const release = () => {
    busy = false;
    pending = null;
  };

  /** Step 1-2: inspect the file and hand back the confirm card. Calls nothing. */
  async function request(target) {
    if (busy) return { card: busyCard(), accepted: false };
    busy = true; // the slot is claimed at the card, so two cards cannot stack either
    let info;
    try {
      info = await inspect(target);
    } catch (error) {
      release();
      return { card: problemCard((error && error.message) || String(error), "inspect_failed"), accepted: false };
    }
    if (!info || !info.ok) {
      release();
      return { card: problemCard((info && info.error) || "that file cannot be read", (info && info.reason) || "bad_target"), accepted: false };
    }
    nextToken += 1;
    const token = `sbx-${nextToken}`;
    pending = { token, target: info.path };
    return { card: confirmCard(info, token), accepted: true, token };
  }

  /** Step 3-4: the owner CLICKED. Doctor first, then one detonate call with confirm=true. */
  async function confirm(token) {
    if (!pending || pending.token !== token) {
      return { card: problemCard("nothing is waiting for confirmation", "no_pending"), ran: false };
    }
    const { target } = pending;
    pending = null; // a second click cannot run it twice
    try {
      const doctor = await callTool(TOOL_DOCTOR, {}, { confirm: false });
      if (!doctorReady(doctor)) {
        log("sandbox doctor: not ready");
        return { card: doctorCard(doctor), ran: false };
      }
      const result = await callTool(
        TOOL_DETONATE,
        { target, network: NETWORK },
        { confirm: true, timeoutMs: DETONATE_TIMEOUT_MS },
      );
      if (result && result.reason === "confirm_required") {
        return { card: problemCard(result.error || "the daemon demanded confirmation", result.reason), ran: false };
      }
      return { card: reportCard(result, { root, path }), ran: true, result };
    } finally {
      release();
    }
  }

  /** The owner dismissed the confirm card: free the slot, call nothing. */
  function cancel(token) {
    if (pending && pending.token === token) release();
    return { ok: true };
  }

  /** A desk:// link: the SAME confirm card, never an automatic detonation. */
  async function requestFromLink(rawUrl) {
    const parsed = parseDetonateUrl(rawUrl);
    if (!parsed.ok) return { card: problemCard(parsed.error, parsed.reason), accepted: false };
    return request(parsed.path);
  }

  return {
    request,
    requestFromLink,
    confirm,
    cancel,
    openFolder: (card) => openRunFolder(card, { root, openPath, path }),
    isBusy: () => busy,
  };
}

module.exports = {
  DAEMON,
  FINDINGS_NOTE,
  MAX_GUEST_CHARS,
  MAX_HASH_BYTES,
  NETWORK,
  ROUTE,
  TOOL_DETONATE,
  TOOL_DOCTOR,
  busyCard,
  callDeskTool,
  confirmCard,
  countLine,
  createSandboxDetonator,
  doctorCard,
  doctorReady,
  inspectTarget,
  isInside,
  localAbsolute,
  openRunFolder,
  parseDetonateUrl,
  plainText,
  problemCard,
  reportCard,
  reportCounts,
  runsRoot,
  setText,
  sha256File,
  sizeLabel,
};
