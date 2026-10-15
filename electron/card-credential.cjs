"use strict";

/**
 * The desk's "Store in vault" press, end to end, minus Electron.
 *
 * main.cjs owns WHICH card (its own view of the open queue, never the
 * renderer's word); this module owns everything after: resolve the door
 * script, pipe the value into its stdin, and decide the verdict.
 *
 * The verdict is the CARD, not the exit code. Measured 2026-10-15: the desk
 * resolved a stale D:\AitherOS\scripts\secret_prompt.py, which wrote the vault,
 * could not close the card, printed "NOT closed" and exited 0; main.cjs read
 * exit 0 as success and the row showed a small grey note while the card sat
 * open. So exit 0 is necessary, never sufficient: the card is re-read and the
 * press is `ok` only when the card says `answered`.
 *
 * Every attempt appends ONE JSON line to ~/.aither/logs/awdesk-credential.jsonl
 * (card id, secret name, scope, script, exit code, card status, verdict). The
 * value is never in it, never in argv, never in the returned verdict.
 */

const nodeFs = require("node:fs");
const nodeOs = require("node:os");
const nodePath = require("node:path");

const TIMEOUT_MS = 180_000;
// The door closes the card before it exits, but a store that is a network
// mount (or the gateway) can lag a beat; a few short re-reads cost nothing.
const STATUS_TRIES = 4;
const STATUS_GAP_MS = 250;

function logPath(env = process.env, os = nodeOs, path = nodePath) {
  const override = String((env && env.AWDESK_CREDENTIAL_LOG) || "").trim();
  return override || path.join(os.homedir(), ".aither", "logs", "awdesk-credential.jsonl");
}

/** Remove any occurrence of the typed value from text the desk will show or log. */
function scrub(text, value) {
  let out = String(text || "");
  if (value && value.length >= 3) out = out.split(value).join("[redacted]");
  return out;
}

/** Append one attempt line. Never throws: a log failure must not fail the store. */
function appendAttempt(entry, { env = process.env, fs = nodeFs, path = nodePath } = {}) {
  try {
    const file = logPath(env, undefined, path);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, `${JSON.stringify({ ts: new Date().toISOString(), ...entry })}\n`);
    return file;
  } catch {
    return "";
  }
}

/** The card's status as the local store has it: "open" | "answered" | ... | "" unknown. */
function readLocalStatus(id, { env = process.env, fs = nodeFs, path = nodePath, os = nodeOs } = {}) {
  const dir = String((env && env.AITHER_DECISIONS_DIR) || "").trim()
    || path.join(os.homedir(), ".aither", "decisions");
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(dir, `${id}.json`), "utf8"));
    return raw && typeof raw.status === "string" ? raw.status : "";
  } catch {
    return "";
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function settledStatus(id, readStatus, tries = STATUS_TRIES, gapMs = STATUS_GAP_MS) {
  let status = "";
  for (let i = 0; i < tries; i += 1) {
    try { status = String((await readStatus(id)) || ""); } catch { status = ""; }
    if (status && status !== "open") return status;
    if (i + 1 < tries) await sleep(gapMs);
  }
  return status;
}

/**
 * Pipe `value` into the door for `card` and decide the verdict.
 *
 * @param card       the shaped open card main.cjs found by id (kind credential)
 * @param value      the typed secret; only ever written to the child's stdin
 * @param resolveScript () => { path, stale }   (secret-prompt-path.cjs)
 * @param python     interpreter path
 * @param spawnFn    child_process.spawn (injected in tests)
 * @param readStatus async (id) => card status after the child exits
 * @param log        (entry) => void   one line per attempt, never the value
 * @returns {Promise<{ok:boolean, code?:number|null, status?:string, receipt?:string, error?:string, detail?:string}>}
 */
async function storeCredential({
  card, value, resolveScript, python = "python", spawnFn, readStatus = (id) => readLocalStatus(id),
  log = (entry) => appendAttempt(entry), fs = nodeFs, timeoutMs = TIMEOUT_MS,
  statusTries = STATUS_TRIES, statusGapMs = STATUS_GAP_MS,
}) {
  const id = card && card.id;
  const base = {
    card: id,
    secret_name: (card && card.secretName) || "",
    scope: (card && card.credentialScope) || "platform",
  };
  const finish = (verdict, extra = {}) => {
    log({ ...base, ...extra, ok: verdict.ok, code: verdict.code ?? null,
      status: verdict.status || "", error: verdict.error || "" });
    return verdict;
  };

  let resolved;
  try { resolved = resolveScript(); } catch (error) {
    return finish({ ok: false, error: `could not find secret_prompt.py (${(error && error.message) || error})` });
  }
  const script = resolved.path;
  if (resolved.stale) {
    return finish({ ok: false, error: `secret_prompt.py at ${script} is too old for the desk door (no DESK_DOOR_PROTOCOL) — update that checkout or set AWDESK_SECRET_PROMPT_SCRIPT` }, { script });
  }
  try {
    if (!fs.existsSync(script)) {
      return finish({ ok: false, error: `secret_prompt.py not found at ${script} — set AWDESK_SECRET_PROMPT_SCRIPT` }, { script });
    }
  } catch {
    return finish({ ok: false, error: "secret_prompt.py is not readable from here" }, { script });
  }

  // The card names the secret and the store, so the write cannot land under a
  // name the card did not ask for.
  const args = [script, "--card", id, "--value-stdin"];
  if (card.secretName) args.push("--name", card.secretName);
  if (card.credentialScope) args.push("--scope", card.credentialScope);
  if (String(card.credentialFormat || "").toLowerCase() === "totp_seed") args.push("--totp");

  const run = await new Promise((resolve) => {
    let child;
    try {
      child = spawnFn(python, args, { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    } catch (error) {
      resolve({ spawnError: (error && error.message) || "spawn failed" });
      return;
    }
    let out = "";
    let err = "";
    let done = false;
    const once = (r) => { if (!done) { done = true; clearTimeout(timer); resolve(r); } };
    const timer = setTimeout(() => {
      try { child.kill(); } catch { /* already gone */ }
      once({ timedOut: true });
    }, timeoutMs);
    child.on("error", (error) => once({ spawnError: (error && error.message) || "spawn failed" }));
    child.stdout.on("data", (chunk) => { out += chunk; });
    child.stderr.on("data", (chunk) => { err += chunk; });
    child.stdin.on("error", () => { /* reported via close/error */ });
    child.on("close", (code) => once({ code, out, err }));
    try {
      child.stdin.write(value);
      child.stdin.end();
    } catch { /* the close/error handler reports the outcome */ }
  });

  const receipt = scrub(String(run.out || "").trim(), value).slice(-400);
  const detail = scrub(String(run.err || "").trim(), value).slice(-400) || undefined;
  value = ""; // drop this module's only reference to the secret, promptly

  if (run.timedOut) {
    return finish({ ok: false, error: "the vault write timed out — check the fleet, then retry" }, { script });
  }
  if (run.spawnError) {
    return finish({ ok: false, error: `could not start the vault write (${run.spawnError})` }, { script });
  }
  if (run.code !== 0) {
    return finish({ ok: false, code: run.code, receipt, detail,
      error: detail || receipt || `the vault write failed (exit ${run.code})` }, { script });
  }
  // Exit 0 is necessary, never sufficient: the card itself must say answered.
  const status = await settledStatus(id, readStatus, statusTries, statusGapMs);
  if (status === "answered") {
    return finish({ ok: true, code: 0, status, receipt }, { script });
  }
  const why = status
    ? `card ${id} is ${status}, not answered`
    : `card ${id} could not be re-read`;
  return finish({
    ok: false, code: 0, status, receipt, detail,
    error: `Not confirmed — the door exited 0 but ${why}. ${receipt || detail || ""}`.trim(),
  }, { script });
}

module.exports = { storeCredential, readLocalStatus, appendAttempt, logPath, scrub };
