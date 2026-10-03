"use strict";

/**
 * link-client — the desk's door onto `adk link` (awdk): is this machine linked
 * to aitherium.com, as whom, in which ROLE — and the one button that links it.
 *
 * Owner, 2026-09-23: "what about awsh + awdesk integration for onboarding?"
 * awdesk had no account link at all. The desk owns none of the logic: adk/link.py
 * runs the device grant, persists the sign-in where awsh and adk read it, and
 * fetches the role-aware bundle (platform owner vs everyone else). A second
 * implementation here would be a fifth sign-in path, which is the problem.
 *
 * Nothing reaches a shell: the device code is validated and adk is spawned with
 * an argv.
 */

const { execFile } = require("node:child_process");

const DEVICE_CODE = /^[A-Za-z0-9_-]{8,256}$/;

function adkBin() {
  if (process.env.AWDESK_ADK_BIN) return process.env.AWDESK_ADK_BIN;
  try {
    return require("./command-agent.cjs").resolveBin("adk", "AWDESK_ADK_BIN");
  } catch {
    return "adk";
  }
}

/** The interpreter for the `python -m adk.cli` fallback (same rule as awconnect-setup.cjs). */
function pythonBin() {
  return process.env.AITHER_PYTHON || (process.platform === "win32" ? "python" : "python3");
}

/** A spawn that never STARTED (vs. adk that ran and failed). Windows reports a
 *  launcher it refuses to execute as UNKNOWN (-4094) or EACCES. */
function spawnFailed(error) {
  return Boolean(error && ["UNKNOWN", "EACCES", "ENOENT", "EPERM"].includes(error.code));
}

/** The JSON object in adk's stdout (it may print an update notice first). */
function parseJson(stdout) {
  const text = String(stdout || "").trim();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    const at = text.indexOf("{");
    if (at < 0) return null;
    try { return JSON.parse(text.slice(at)); } catch { return null; }
  }
}

function runOnce(execFileImpl, file, argv, timeoutMs) {
  return new Promise((resolve) => {
    execFileImpl(file, argv, { timeout: timeoutMs, windowsHide: true, maxBuffer: 1024 * 1024 },
      (error, stdout, stderr) => resolve({ error, stdout, stderr }));
  });
}

/**
 * Run `adk link <args> --json`; resolves {ok, data} or {ok:false, error}.
 *
 * Owner, 2026-10-03: the Link button did nothing and Connections said "could not
 * check (spawn UNKNOWN)". An adk upgrade had rewritten the pip launcher adk.exe at
 * 11:54 and Windows refused to execute it ("Permission denied") while
 * `python -m adk.cli` ran fine. A launcher that will not START is now retried
 * through the interpreter -- the path awconnect-setup.cjs already uses.
 */
async function runLink(args, { execFileImpl = execFile, bin = adkBin(), timeoutMs = 30000 } = {}) {
  const argv = ["link", ...args, "--json"];
  let run = await runOnce(execFileImpl, bin, argv, timeoutMs);
  if (spawnFailed(run.error)) {
    run = await runOnce(execFileImpl, pythonBin(), ["-m", "adk.cli", ...argv], timeoutMs);
  }
  const { error, stdout, stderr } = run;
  const data = parseJson(stdout);
  if (data && typeof data === "object") {
    const ok = data.ok !== false;
    return ok ? { ok: true, data } : { ok: false, data, error: data.error || "failed" };
  }
  const why = error
    ? (error.code === "ENOENT" ? "adk is not installed or not on PATH" : String(error.message || error))
    : "adk link returned no JSON";
  return { ok: false, error: `${why}${stderr ? `: ${String(stderr).slice(-300)}` : ""}` };
}

const linkStatus = (opts) => runLink(["status"], opts);
const linkStart = (opts) => runLink(["start"], opts);

/** One poll. Refused WITHOUT a spawn if the device code is not code-shaped. */
function linkPoll(deviceCode, opts) {
  if (!DEVICE_CODE.test(String(deviceCode || ""))) {
    return Promise.resolve({ ok: false, error: "bad device code" });
  }
  return runLink(["poll", String(deviceCode)], opts);
}

module.exports = { runLink, linkStatus, linkStart, linkPoll, adkBin };
