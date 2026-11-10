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
 *   2. The file is COPIED into a private, per-request staging folder the desk
 *      owns and THE COPY is hashed. The confirm card names the file, that copy's
 *      size and SHA-256, and says the sandbox runs it with networking off.
 *   3. Only the owner's click on that card calls ``desktop_sandbox_detonate`` --
 *      with ``network: "off"`` and ``confirm: true``, never anything else. The
 *      staged copy is re-hashed first; if it changed, nothing runs. The staged
 *      copy, not the original path, is what the sandbox is asked to run.
 *   4. The doctor runs first, on that click. Not ready -> its EXACT fix text is
 *      shown and nothing else is called (the fix needs an administrator and a
 *      reboot; the desk never elevates).
 *   5. The receipt becomes a verdict-free report card: counts read from the real
 *      sandbox-mcp fields (or from awdk's capped ``counts`` summary), the digest
 *      the sandbox itself executed (compared with the card's), the run folder
 *      (only when it resolves inside ``%LOCALAPPDATA%\sandbox-mcp\runs``), and
 *      the words "heuristics, not a safety verdict". A run that never happened
 *      (daemon down, timeout, HTTP error, tool refusal) is a PROBLEM card --
 *      "The sandbox did not run" -- never a report with "Exit ?".
 *   6. One detonation at a time: a second request while one holds the slot gets a
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
const { Transform } = require("node:stream");
const { pipeline } = require("node:stream/promises");

const { DAEMON, harnessToken } = require("./sessions-client.cjs");

const ROUTE = "/desk/tools";
const TOOL_DOCTOR = "desktop_sandbox_doctor";
const TOOL_DETONATE = "desktop_sandbox_detonate";

/** The one network mode the desk ever sends. Never "on", never "firewall". */
const NETWORK = "off";

/** Guest text shown on a card is capped at this many characters. */
const MAX_GUEST_CHARS = 2000;

/**
 * The largest file the desk will stage and hash: 2 GiB. A fingerprint is work the
 * main process does for the owner, and the sandbox boots a whole Windows guest to
 * run the file -- a file this big is not a double-click detonation. Stated on the
 * confirm card and refused before anything is copied.
 */
const MAX_STAGED_BYTES = 2 * 1024 * 1024 * 1024;

/**
 * The extensions upstream sandbox-mcp v1.2.0 knows how to run, read from
 * ``src/detonate.js`` lines 25-31 (``detonateCommand``): scripts go to
 * wscript/mshta, installers and executables to ``installCommand``, and anything
 * else throws "Don't know how to run ...". Refused here BEFORE a byte is copied.
 */
const ACCEPTED_EXTENSIONS = Object.freeze([
  ".exe", ".msi", ".ps1", ".cmd", ".bat", ".js", ".jse", ".vbs", ".vbe", ".wsf", ".hta",
]);

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

/**
 * The desk's OWN app-data folder for staged copies. main.cjs passes
 * ``<userData>/sandbox-staging``; this default is for tests and headless use.
 */
function stagingRoot({ env = process.env, os = nodeOs, path = nodePath } = {}) {
  const roaming = String(env.APPDATA || "").trim();
  const base = roaming || path.join(os.homedir(), "AppData", "Roaming");
  return path.resolve(path.join(base, "awdesk", "sandbox-staging"));
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

// ── hashing and staging: async, streamed, capped ────────────────────────────

/** SHA-256 of a file, streamed so a large file never blocks the main thread or is buffered. */
async function sha256File(file, { fs = nodeFs, crypto = nodeCrypto } = {}) {
  const hash = crypto.createHash("sha256");
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}

/**
 * Stream `source` to `dest`, counting bytes, and abort past `limit` instead of
 * filling the disk. Returns the number of bytes copied. `wx` means the write can
 * never reuse or overwrite an existing file.
 */
async function copyStagedFile(source, dest, { fs = nodeFs, limit = MAX_STAGED_BYTES } = {}) {
  let bytes = 0;
  const meter = new Transform({
    transform(chunk, _encoding, done) {
      bytes += chunk.length;
      if (bytes > limit) {
        const error = new Error("too_large");
        error.code = "too_large";
        done(error);
        return;
      }
      done(null, chunk);
    },
  });
  await pipeline(fs.createReadStream(source), meter, fs.createWriteStream(dest, { flags: "wx" }));
  return bytes;
}

/**
 * Inspect ONE existing file WITHOUT reading it: local, a regular file, an
 * extension sandbox-mcp will run, and no bigger than the staging cap. Every
 * refusal happens before a byte is copied or hashed.
 */
async function inspectTarget(target, { fs = nodeFs, path = nodePath } = {}) {
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
  const ext = path.extname(file).toLowerCase();
  if (!ACCEPTED_EXTENSIONS.includes(ext)) {
    return {
      ok: false,
      reason: "unsupported_type",
      error: `the sandbox cannot run ${ext || "a file with no extension"}; it runs ${ACCEPTED_EXTENSIONS.join(", ")}`,
    };
  }
  if (stat.size > MAX_STAGED_BYTES) {
    return {
      ok: false,
      reason: "too_large",
      error: `${file} is larger than the ${sizeLabel(MAX_STAGED_BYTES)} the desk will stage`,
    };
  }
  return { ok: true, path: file, name: path.basename(file), size: stat.size };
}

/**
 * The name a staged copy is written under.
 *
 * awdk refuses a host path carrying ``& | < > ^ " % !`` (its own metacharacter
 * check on the tool argument), and that refusal lands AFTER the owner clicked
 * Detonate -- a real installer called ``Q&A Tools!.exe`` staged, hashed and
 * confirmed, then died at the call with ``bad_args``. The copy is therefore
 * written under a name that keeps the extension (the sandbox dispatches on it)
 * and replaces every character outside ``[A-Za-z0-9._ -]`` with ``_``. The
 * ORIGINAL name stays on the confirm card, as text.
 */
function stagedName(name, path = nodePath) {
  const original = String(name == null ? "" : name);
  const ext = path.extname(original);
  const base = ext ? original.slice(0, original.length - ext.length) : original;
  const scrub = (value) => value.replace(/[^A-Za-z0-9._ -]/g, "_");
  return `${scrub(base) || "sample"}${scrub(ext)}`;
}

/**
 * Copy one inspected file into a private per-request folder inside the desk's
 * own app-data directory, then hash THE COPY. The copy is a new file the desk
 * creates (``wx``) inside a new directory it creates, so it does not inherit the
 * source file's ACLs, alternate data streams or attributes -- what runs is what
 * this function wrote. One subfolder per request; the file is removed by exact
 * path after the run (never a recursive delete).
 */
async function stageTarget(info, {
  token = "request",
  root = stagingRoot(),
  fs = nodeFs,
  path = nodePath,
  maxBytes = MAX_STAGED_BYTES,
} = {}) {
  const safe = String(token).replace(/[^A-Za-z0-9._-]/g, "_");
  const unique = `${safe}-${nodeCrypto.randomBytes(4).toString("hex")}`;
  const dir = path.join(root, `request-${unique}`);
  const name = stagedName(info.name, path);
  const dest = path.join(dir, name);
  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  } catch (error) {
    return { ok: false, reason: "staging_failed", error: `could not create ${dir}: ${(error && error.message) || error}` };
  }
  try {
    const size = await copyStagedFile(info.path, dest, { fs, limit: maxBytes });
    const sha256 = await sha256File(dest, { fs });
    return { ok: true, path: dest, dir, name, size, sha256 };
  } catch (error) {
    // Only the one file this request created, by its exact path; then its folder
    // (non-recursive, so it is only removed when it is empty).
    try { fs.unlinkSync(dest); } catch { /* nothing was created */ }
    try { fs.rmdirSync(dir); } catch { /* left alone */ }
    if (error && error.code === "too_large") {
      return {
        ok: false,
        reason: "too_large",
        error: `the file grew past the ${sizeLabel(maxBytes)} the desk will stage`,
      };
    }
    return { ok: false, reason: "staging_failed", error: `could not copy ${info.path}: ${(error && error.message) || error}` };
  }
}

/** Remove ONLY the single staged file this request created, then its now-empty folder. Never recursive. */
function removeStaged(held, { fs = nodeFs } = {}) {
  if (!held) return;
  if (held.staged) {
    try { fs.unlinkSync(held.staged); } catch { /* already gone */ }
  }
  if (held.stagingDir) {
    try { fs.rmdirSync(held.stagingDir); } catch { /* not empty: left alone */ }
  }
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
  const shownName = info.stagedName || "";
  const renamed = shownName && shownName !== info.name;
  return {
    kind: "confirm",
    title: "Detonate a file in Windows Sandbox?",
    file: info.path,
    staged: info.staged,
    stagingPath: info.staged,
    // The owner's ORIGINAL name, as text. `stagedName` is the sanitised copy name.
    name: info.name,
    stagedName: shownName,
    size: info.size,
    sizeLabel: sizeLabel(info.size),
    sha256: info.sha256,
    maxBytes: MAX_STAGED_BYTES,
    maxBytesLabel: sizeLabel(MAX_STAGED_BYTES),
    network: NETWORK,
    token,
    confirmLabel: "Detonate",
    cancelLabel: "Cancel",
    lines: [
      `File: ${info.path}`,
      `Staged copy: ${info.staged}`,
      renamed
        ? `Staged as "${shownName}": the sandbox tool refuses some characters in a filename; the file you picked is still ${info.name}.`
        : "",
      `Size: ${sizeLabel(info.size)}`,
      `SHA-256 of the copy: ${info.sha256}`,
      "Only the staged copy runs, and the copy is re-hashed when you click; if it changed, nothing runs.",
      "A fresh, disposable Windows Sandbox runs this file with networking off.",
      `Files up to ${MAX_STAGED_BYTES.toLocaleString("en-US")} bytes (2.0 GiB) are accepted.`,
      "The sandbox is deleted after the run. Its findings are heuristics, not a safety verdict.",
    ].filter(Boolean),
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

// ── the receipt: the REAL shapes (awdk + upstream sandbox-mcp v1.2.0) ───────

/**
 * Upstream's autorun / persistence value names (``src/detonate.js`` line 63):
 * ``/\\(Run|RunOnce)\|\\Winlogon\|\\Image File Execution Options/i``.
 */
const AUTORUN_NAME = /\\(?:Run|RunOnce)\\|\\Winlogon\\|\\Image File Execution Options/i;
/** A scheduled-task file the file planted (detonate.js line 66, ``.../Tasks/``). */
const TASK_FILE = /^C:\\Windows\\System32\\Tasks[\\/]/i;

/** The sbx JSON the CLI printed, nested in awdk's receipt as ``data``. */
function receiptData(receipt) {
  const data = receipt && typeof receipt.data === "object" && receipt.data !== null ? receipt.data : {};
  return data;
}

/**
 * The receipt itself: ``callDeskTool`` answers ``{ok, status, result}``, and the
 * receipt is ``result``. Older/POST failure answers have no ``result`` and ARE
 * the receipt. Never throws.
 */
function receiptOf(result) {
  if (result && typeof result === "object" && result.result
    && typeof result.result === "object" && !Array.isArray(result.result)) {
    return result.result;
  }
  return result && typeof result === "object" ? result : {};
}

function arrayOf(value) {
  return Array.isArray(value) ? value : [];
}

/**
 * Persistence entries from the snapshot diff: added services, scheduled-task
 * files, and autorun values -- the three the upstream findings list treats as
 * persistence (detonate.js lines 63-67). ``null`` = no diff was reported, never
 * a fabricated zero.
 */
function persistenceCount(diff) {
  if (!diff || typeof diff !== "object") return null;
  let total = 0;
  for (const service of arrayOf(diff.services)) if (service && service.change === "added") total += 1;
  const files = diff.files && typeof diff.files === "object" ? diff.files : {};
  for (const file of arrayOf(files.added)) {
    if (file && typeof file.path === "string" && TASK_FILE.test(file.path)) total += 1;
  }
  for (const value of arrayOf(diff.values)) {
    if (value && value.change !== "removed" && typeof value.name === "string" && AUTORUN_NAME.test(value.name)) {
      total += 1;
    }
  }
  return total;
}

/**
 * Verdict-free counts from the REAL receipt. ``null`` = not reported, never a
 * fabricated zero. ``tree`` is the audited process tree INCLUDING the process the
 * sandbox agent launched (detonate.js line 189: ``r.tree = t.tree``).
 *
 * A CAPPED receipt (past awdk's ``_MAX_SANDBOX_CHARS``) carries no ``data``, so
 * awdk hands the desk a summarised ``counts`` object instead:
 * ``{processes, lookups, connections, services, persistence, scheduled_tasks,
 * findings}``. Those numbers are authoritative when present; otherwise every
 * count is derived from the same fields upstream's findings list uses.
 */
function reportCounts(result) {
  const receipt = receiptOf(result);
  const data = receiptData(receipt);
  const summary = receipt.counts && typeof receipt.counts === "object" ? receipt.counts : {};
  const list = (value) => (Array.isArray(value) ? value.length : null);
  const diff = data.diff && typeof data.diff === "object" ? data.diff : null;
  const files = diff && diff.files && typeof diff.files === "object" ? diff.files : {};
  const addedServices = diff
    ? arrayOf(diff.services).filter((service) => service && service.change === "added").length
    : null;
  const addedTasks = diff
    ? arrayOf(files.added).filter((file) => file && typeof file.path === "string" && TASK_FILE.test(file.path)).length
    : null;
  const pick = (key, fallback) => (Number.isFinite(summary[key]) ? summary[key] : fallback);
  return {
    processes: pick("processes", list(data.tree)),
    lookups: pick("lookups", list(data.lookups)),
    connections: pick("connections", list(data.connections)),
    services: pick("services", addedServices),
    persistence: pick("persistence", persistenceCount(diff)),
    scheduled_tasks: pick("scheduled_tasks", addedTasks),
    findings: pick("findings", list(data.findings)),
  };
}

function countLine(counts) {
  const label = (name, value) => `${name}: ${value === null ? "not reported" : value}`;
  return [
    label("Processes", counts.processes),
    label("Name lookups", counts.lookups),
    label("Connection attempts", counts.connections),
    label("Services added", counts.services),
    label("Persistence entries", counts.persistence),
    label("Scheduled tasks", counts.scheduled_tasks),
    label("Findings", counts.findings),
  ].join(" · ");
}

/** The upstream findings list, as plain lines (detonate.js line 58: [{level, text}]). */
function findingsText(data) {
  return arrayOf(data.findings)
    .map((finding) => (finding && typeof finding.text === "string" ? `${finding.level || "info"}: ${finding.text}` : ""))
    .filter(Boolean)
    .join("\n");
}

/** The report card. The run folder is offered ONLY when it is lexically under the runs root. */
function reportCard(result, { root = runsRoot(), path = nodePath, expectedSha256 = null } = {}) {
  const receipt = receiptOf(result);
  const data = receiptData(receipt);
  // awdk caps the receipt once it passes _MAX_SANDBOX_CHARS
  // (awdk/adk/desktop/tools.py:_sandbox_receipt). The CURRENT capped shape keeps
  // {ok, command, exit_code, timed_out, run_dir, sha256, findings_are, error,
  //  counts, truncated:true, preview}; the OLD one was
  // {ok, command, truncated:true, preview, findings_are} -- no run_dir, no
  // exit_code, no counts, no sha256 -- which is why it gets its own line.
  const capped = receipt.truncated === true;
  const runDirRaw = [receipt.run_dir, receipt.runDir, data.runDir, data.outDir]
    .find((value) => typeof value === "string" && value.trim());
  const runDir = runDirRaw && localAbsolute(runDirRaw).ok && isInside(runDirRaw, root, path)
    ? path.resolve(runDirRaw)
    : null;
  const counts = reportCounts(receipt);
  const report = receipt.report && typeof receipt.report === "object" ? receipt.report : {};
  const reportTruncated = report.truncated === true;
  // The digest the run actually executed: data.sha256 is upstream's own digest
  // of the host bytes it copied into the guest (detonate.js line 134); a capped
  // receipt keeps the same digest at the top level as receipt.sha256.
  const executedRaw = typeof data.sha256 === "string" && data.sha256.trim()
    ? data.sha256
    : typeof receipt.sha256 === "string" && receipt.sha256.trim()
      ? receipt.sha256
      : "";
  const executedSha256 = executedRaw.trim().toLowerCase();
  const expected = typeof expectedSha256 === "string" ? expectedSha256.trim().toLowerCase() : "";
  const digestMatch = expected && executedSha256 ? expected === executedSha256 : null;
  const guestSource = findingsText(data)
    || (typeof report.text === "string" && !reportTruncated ? report.text : "");
  const exit = Number.isFinite(receipt.exit_code) ? receipt.exit_code : null;
  const digestLine = digestMatch === true
    ? `SHA-256: the sandbox ran ${executedSha256}, matching the staged copy.`
    : digestMatch === false
      ? `DIGEST MISMATCH: the sandbox ran ${executedSha256}; the staged copy was ${expected}. Treat this run as invalid.`
      : expected
        ? `SHA-256: the receipt did not report the digest it ran; the staged copy was ${expected}.`
        : "";
  // One line about the cap, and never a second one that contradicts it.
  const cappedLine = capped
    ? runDir
      ? "Report too large to show here; open the run folder."
      : "Report too large; this awdk is older -- update it to see the run folder."
    : "";
  const folderLine = runDir
    ? `Run folder: ${runDir}`
    : capped
      ? ""
      : "The receipt did not report a run folder the desk may open.";
  return {
    kind: "report",
    title: "Sandbox report",
    ok: Boolean(receipt.ok),
    exitCode: exit,
    timedOut: Boolean(receipt.timed_out),
    capped,
    reportTruncated,
    counts,
    countLine: countLine(counts),
    runDir,
    openFolder: Boolean(runDir),
    digest: { expected: expected || null, executed: executedSha256 || null, match: digestMatch },
    digestMismatch: digestMatch === false,
    guestText: plainText(guestSource, MAX_GUEST_CHARS),
    findingsNote: FINDINGS_NOTE,
    error: plainText(receipt.error || "", 800),
    lines: [
      exit === null
        ? capped
          ? "Exit: not reported (this awdk capped the receipt)"
          : "Exit ?"
        : `Exit ${exit}${receipt.timed_out ? " (timed out)" : ""}`,
      countLine(counts),
      digestLine,
      cappedLine,
      reportTruncated ? "The sandbox's report.json was larger than the desk reads whole; the run folder has all of it." : "",
      folderLine,
      "These findings are " + FINDINGS_NOTE + ".",
    ].filter(Boolean),
  };
}

/**
 * Daemon answers that mean NO run happened: the tool was never called, or it
 * refused the argument. A receipt that merely says ``ok: false`` while carrying
 * run evidence (an exit code, a data block, a capped summary) is a REAL run and
 * belongs on a report card.
 */
function isRunReceipt(result) {
  const receipt = receiptOf(result);
  if (!receipt || typeof receipt !== "object") return false;
  if (Number.isFinite(receipt.exit_code) || typeof receipt.timed_out === "boolean") return true;
  if (receipt.truncated === true) return true;
  if (receipt.counts && typeof receipt.counts === "object") return true;
  if (receipt.data && typeof receipt.data === "object") return true;
  if (receipt.report && typeof receipt.report === "object") return true;
  if (typeof receipt.sha256 === "string" && receipt.sha256.trim()) return true;
  if (typeof receipt.run_dir === "string" && receipt.run_dir.trim()) return true;
  return false;
}

/** A transport-level failure of one daemon call: nothing about the file ran. */
const TRANSPORT_REASONS = new Set(["unreachable", "timeout", "no_token"]);

function isTransportFailure(result) {
  if (!result || typeof result !== "object") return true;
  if (TRANSPORT_REASONS.has(String(result.reason || ""))) return true;
  return Number.isFinite(result.status) && result.status >= 400;
}

const FAILURE_TEXT = Object.freeze({
  unreachable: "The harness daemon is not reachable, so nothing ran.",
  timeout: "The harness daemon did not answer in time, so nothing ran.",
  no_token: "No harness token is available, so the desk could not reach the daemon and nothing ran.",
  bad_args: "The sandbox tool refused the request, so nothing ran.",
  not_installed: "The sandbox tool is not installed in this harness, so nothing ran.",
});

/**
 * A failure that is NOT a run: never a "Sandbox report" with "Exit ?", which
 * reads as a detonation that produced an unknown exit code.
 */
function runFailureCard(result) {
  const receipt = receiptOf(result);
  const reason = String(
    (result && result.reason) || receipt.reason || "",
  );
  const status = Number.isFinite(result && result.status) ? result.status : null;
  const detail = plainText((result && result.error) || receipt.error || "", 800);
  const what = FAILURE_TEXT[reason]
    || (status ? `The harness daemon answered HTTP ${status}, so nothing ran.` : "The harness daemon did not run the file.");
  return {
    kind: "problem",
    title: "The sandbox did not run",
    reason: reason || "daemon_failed",
    text: [what, detail].filter(Boolean).join(" "),
    action: null,
  };
}

/**
 * Open a run folder. Authority is the REAL paths, not the strings: the runs root
 * and the target must both exist (``fs.realpathSync`` fails otherwise), the real
 * target must resolve strictly inside the real root, and no path component below
 * the root may be a reparse point -- a junction under the runs root would
 * otherwise carry ``shell.openPath`` out of it.
 */
async function openRunFolder(cardOrPath, { root = runsRoot(), openPath, path = nodePath, fs = nodeFs } = {}) {
  const raw = typeof cardOrPath === "string" ? cardOrPath : cardOrPath && cardOrPath.runDir;
  if (!raw) return { ok: false, reason: "no_run_folder", error: "this run reported no folder to open" };
  const check = localAbsolute(raw);
  if (!check.ok) return { ok: false, reason: check.reason, error: check.error };
  const lexicalRoot = path.resolve(root);
  const lexicalTarget = path.resolve(raw);
  let realRoot;
  try {
    realRoot = fs.realpathSync(lexicalRoot);
  } catch {
    return { ok: false, reason: "runs_root_missing", error: `${lexicalRoot} does not exist; refusing to open anything` };
  }
  let realTarget;
  try {
    realTarget = fs.realpathSync(lexicalTarget);
  } catch {
    return { ok: false, reason: "no_such_folder", error: `${lexicalTarget} does not exist` };
  }
  if (!isInside(realTarget, realRoot, path)) {
    return { ok: false, reason: "outside_runs_root", error: `${raw} is not under ${root}; refusing to open it` };
  }
  // A junction/symlink BELOW the root is refused even when it points back inside:
  // the run folder must be a real folder the sandbox wrote.
  const rel = path.relative(lexicalRoot, lexicalTarget);
  if (rel) {
    let current = lexicalRoot;
    for (const segment of rel.split(path.sep)) {
      current = path.join(current, segment);
      let stat;
      try {
        stat = fs.lstatSync(current);
      } catch {
        return { ok: false, reason: "no_such_folder", error: `${current} does not exist` };
      }
      if (stat.isSymbolicLink()) {
        return { ok: false, reason: "reparse_point", error: `${current} is a link or junction; refusing to open it` };
      }
    }
  }
  try {
    if (!fs.statSync(realTarget).isDirectory()) {
      return { ok: false, reason: "not_a_folder", error: `${realTarget} is not a folder` };
    }
  } catch {
    return { ok: false, reason: "no_such_folder", error: `${realTarget} does not exist` };
  }
  if (typeof openPath !== "function") return { ok: false, reason: "no_opener", error: "no file opener is wired" };
  const why = await openPath(realTarget);
  if (why) return { ok: false, reason: "open_failed", error: String(why) };
  return { ok: true, opened: realTarget };
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
  stage = stageTarget,
  staging = stagingRoot(),
  root = runsRoot(),
  openPath = null,
  path = nodePath,
  fs = nodeFs,
  log = () => {},
} = {}) {
  let busy = false;
  let pending = null; // { token, target, staged, stagingDir, sha256, size }

  const release = () => {
    busy = false;
    pending = null;
  };

  /** Step 1-2: inspect the file, stage a copy, hash the copy, hand back the confirm card. */
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
    let staged;
    try {
      staged = await stage(info, { token, root: staging, fs, path });
    } catch (error) {
      release();
      return { card: problemCard((error && error.message) || String(error), "staging_failed"), accepted: false };
    }
    if (!staged || !staged.ok) {
      release();
      return { card: problemCard((staged && staged.error) || "that file could not be staged", (staged && staged.reason) || "staging_failed"), accepted: false };
    }
    pending = {
      token,
      target: info.path,
      staged: staged.path,
      stagingDir: staged.dir,
      sha256: staged.sha256,
      size: staged.size,
    };
    return {
      card: confirmCard({ ...info, staged: staged.path, stagedName: staged.name, size: staged.size, sha256: staged.sha256 }, token),
      accepted: true,
      token,
    };
  }

  /** Step 3-5: the owner CLICKED. Re-hash the copy, doctor, then one detonate call with confirm=true. */
  async function confirm(token) {
    if (!pending || pending.token !== token) {
      return { card: problemCard("nothing is waiting for confirmation", "no_pending"), ran: false };
    }
    const held = pending;
    pending = null; // a second click cannot run it twice
    try {
      // The card's evidence must describe the bytes that run. The copy is ours,
      // but anything with the owner's rights can still rewrite it while the
      // dialog is open, so it is re-hashed here and a change refuses the run.
      let digest;
      try {
        digest = await sha256File(held.staged, { fs });
      } catch {
        return { card: problemCard(`the staged copy is gone: ${held.staged}`, "staged_missing"), ran: false };
      }
      if (String(digest).toLowerCase() !== held.sha256) {
        return {
          card: problemCard(
            `the staged copy changed after the card was shown (was ${held.sha256}, now ${digest}); nothing was run`,
            "staged_changed",
          ),
          ran: false,
        };
      }
      const doctor = await callTool(TOOL_DOCTOR, {}, { confirm: false });
      if (!doctorReady(doctor)) {
        // A daemon that never answered is not a Windows Sandbox that needs a
        // reboot: say the run did not happen instead of showing the fix card.
        if (isTransportFailure(doctor)) {
          log("sandbox doctor: the daemon did not answer");
          return { card: runFailureCard(doctor), ran: false };
        }
        log("sandbox doctor: not ready");
        return { card: doctorCard(doctor), ran: false };
      }
      const result = await callTool(
        TOOL_DETONATE,
        { target: held.staged, network: NETWORK },
        { confirm: true, timeoutMs: DETONATE_TIMEOUT_MS },
      );
      if (result && result.reason === "confirm_required") {
        return { card: problemCard(result.error || "the daemon demanded confirmation", result.reason), ran: false };
      }
      if (!isRunReceipt(result)) {
        // Unreachable, timed out, an HTTP error, or the tool refused the
        // argument: nothing ran, so the card must not read as a report.
        log("sandbox detonate: the run never started");
        return { card: runFailureCard(result), ran: false, result };
      }
      return { card: reportCard(result, { root, path, expectedSha256: held.sha256 }), ran: true, result };
    } finally {
      removeStaged(held, { fs });
      release();
    }
  }

  /** The owner dismissed the confirm card: free the slot, remove the copy, call nothing. */
  function cancel(token) {
    if (pending && pending.token === token) {
      const held = pending;
      release();
      removeStaged(held, { fs });
    }
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
    openFolder: (card) => openRunFolder(card, { root, openPath, path, fs }),
    isBusy: () => busy,
  };
}

module.exports = {
  ACCEPTED_EXTENSIONS,
  DAEMON,
  FINDINGS_NOTE,
  MAX_GUEST_CHARS,
  MAX_STAGED_BYTES,
  NETWORK,
  ROUTE,
  TOOL_DETONATE,
  TOOL_DOCTOR,
  busyCard,
  callDeskTool,
  confirmCard,
  copyStagedFile,
  countLine,
  createSandboxDetonator,
  doctorCard,
  doctorReady,
  findingsText,
  inspectTarget,
  isInside,
  isRunReceipt,
  isTransportFailure,
  localAbsolute,
  openRunFolder,
  parseDetonateUrl,
  persistenceCount,
  plainText,
  problemCard,
  receiptOf,
  removeStaged,
  reportCard,
  reportCounts,
  runFailureCard,
  runsRoot,
  setText,
  sha256File,
  sizeLabel,
  stageTarget,
  stagedName,
  stagingRoot,
};
