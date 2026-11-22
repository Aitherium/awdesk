"use strict";

/**
 * assist-tools.cjs -- find the tools the owner installed (PowerToys, Sysinternals, ffmpeg,
 * pandoc, ImageMagick) and decide whether to RUN them.
 *
 * WHY. The desk runs these programs with the owner's rights. A bare PATH lookup runs
 * whatever a writable PATH directory (or the current directory) offers first, so a planted
 * `ffmpeg.exe` would run as the owner. Discovery here is therefore:
 *
 *   1. only from KNOWN install locations: Program Files, the per-user Programs dir, the
 *      user's WinGet Links and Pandoc dirs, the Sysinternals folders. PATH is never read.
 *   2. then, before it is run, an Authenticode check (Get-AuthenticodeSignature through
 *      the absolute System32 powershell.exe, the file path passed in the environment, not
 *      in the command text):
 *        powertoys / sysinternals  signature Valid AND signed by "Microsoft Corporation".
 *        converter (ffmpeg, pandoc, magick)  most builds are unsigned, so: a Valid
 *                  signature passes, NotSigned passes (the location is the trust), and
 *                  anything else (HashMismatch, NotTrusted, UnknownError ...) is refused.
 *
 * The verdict is cached per (path, size, mtime): a replaced file is judged again.
 * `locate` is synchronous and only says "installed"; `verify` is the gate that must come
 * before every exec/spawn.
 */

const fs = require("node:fs");
const path = require("node:path");

const FAMILIES = Object.freeze(["powertoys", "sysinternals", "converter"]);
const MS_SIGNER = "Microsoft Corporation";

const SIG_SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  "try {",
  "$s = Get-AuthenticodeSignature -LiteralPath $env:AWDESK_TOOL_FILE",
  "$subject = ''; if ($s.SignerCertificate) { $subject = [string]$s.SignerCertificate.Subject }",
  "[Console]::Out.Write((@{ status = [string]$s.Status; subject = $subject } | ConvertTo-Json -Compress))",
  "} catch { [Console]::Out.Write('{\"status\":\"UnknownError\",\"subject\":\"\"}') }",
].join("; ");

function programDirs(env) {
  return [env.ProgramFiles, env["ProgramFiles(x86)"], env.LOCALAPPDATA && path.win32.join(env.LOCALAPPDATA, "Programs")].filter(Boolean);
}

/** The absolute Windows PowerShell: never "powershell.exe" resolved through PATH. */
function powershellExe(env = process.env) {
  return path.win32.join(env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
}

/** Where PowerToys lives (per-machine, per-user, or the Programs dir). */
function powerToysDirs(env = process.env) {
  const dirs = programDirs(env).map((d) => path.win32.join(d, "PowerToys"));
  if (env.LOCALAPPDATA) dirs.push(path.win32.join(env.LOCALAPPDATA, "PowerToys"));
  return dirs.flatMap((d) => [d, path.win32.join(d, "WinUI3Apps")]);
}

/** Where Sysinternals lives: known folders and the WinGet links dir. NEVER PATH. */
function sysinternalsDirs(env = process.env) {
  const dirs = ["C:\\Sysinternals"];
  for (const d of programDirs(env)) dirs.push(path.win32.join(d, "Sysinternals"), path.win32.join(d, "SysinternalsSuite"));
  if (env.LOCALAPPDATA) dirs.push(path.win32.join(env.LOCALAPPDATA, "Microsoft", "WinGet", "Links"));
  return dirs;
}

/** Where ffmpeg / pandoc / ImageMagick usually live. Machine-wide dirs first, then the user's. */
function converterDirs(env = process.env, readdirSync = fs.readdirSync) {
  const dirs = [];
  for (const pf of [env.ProgramFiles, env["ProgramFiles(x86)"]].filter(Boolean)) {
    try {
      for (const name of readdirSync(pf)) if (/^ImageMagick-7[\w.-]*$/i.test(String(name))) dirs.push(path.win32.join(pf, String(name)));
    } catch { /* unreadable */ }
    dirs.push(path.win32.join(pf, "ffmpeg", "bin"), path.win32.join(pf, "Pandoc"));
  }
  if (env.LOCALAPPDATA) dirs.push(path.win32.join(env.LOCALAPPDATA, "Pandoc"), path.win32.join(env.LOCALAPPDATA, "Programs", "Pandoc"), path.win32.join(env.LOCALAPPDATA, "Microsoft", "WinGet", "Links"));
  return dirs;
}

function findTool(names, dirs, existsSync = fs.existsSync) {
  for (const name of names) {
    for (const dir of dirs) {
      const candidate = path.win32.join(dir, name);
      try { if (existsSync(candidate)) return candidate; } catch { /* unreadable dir */ }
    }
  }
  return null;
}

/** "CN=Microsoft Corporation, O=..." -> the CN value, quotes stripped; "" when absent. */
function commonName(subject) {
  const m = /(?:^|,\s*)CN=("(?:[^"]|"")*"|[^,]*)/.exec(String(subject || ""));
  return m ? m[1].replace(/^"|"$/g, "").replace(/""/g, "\"").trim() : "";
}

/** The policy, pure. `sig` = { status, subject }. -> { ok, signed, error? } */
function judge(family, sig) {
  const status = String((sig && sig.status) || "UnknownError");
  const signer = commonName(sig && sig.subject);
  if (family === "powertoys" || family === "sysinternals") {
    if (status !== "Valid") return { ok: false, signed: false, error: `its Authenticode signature is ${status}, not Valid` };
    if (signer !== MS_SIGNER) return { ok: false, signed: true, error: `it is signed by "${signer || "unknown"}", not ${MS_SIGNER}` };
    return { ok: true, signed: true, signer };
  }
  if (status === "Valid") return { ok: true, signed: true, signer };
  if (status === "NotSigned") return { ok: true, signed: false };
  return { ok: false, signed: false, error: `its Authenticode signature is ${status}` };
}

/** The real signature reader: an absolute powershell.exe, the file in the environment. */
function psSignatureReader({ execFile = require("node:child_process").execFile, env = process.env } = {}) {
  return (file) => new Promise((resolve) => {
    try {
      execFile(powershellExe(env), ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", SIG_SCRIPT],
        { timeout: 20000, windowsHide: true, shell: false, env: { ...process.env, ...env, AWDESK_TOOL_FILE: file } },
        (error, stdout) => {
          if (error) { resolve({ status: "UnknownError", subject: "" }); return; }
          try {
            const doc = JSON.parse(String(stdout || "").trim());
            resolve({ status: String(doc.status || "UnknownError"), subject: String(doc.subject || "") });
          } catch { resolve({ status: "UnknownError", subject: "" }); }
        });
    } catch { resolve({ status: "UnknownError", subject: "" }); }
  });
}

function createTools({
  env = process.env, platform = process.platform, existsSync = fs.existsSync, readdirSync = fs.readdirSync, statSync = fs.statSync,
  execFile = require("node:child_process").execFile, readSignature = null,
} = {}) {
  const read = readSignature || psSignatureReader({ execFile, env });
  const cache = new Map(); // "family|path|size|mtime" -> verdict (successes only)

  function dirs(family) {
    if (family === "powertoys") return powerToysDirs(env);
    if (family === "sysinternals") return sysinternalsDirs(env);
    if (family === "converter") return converterDirs(env, readdirSync);
    return [];
  }

  /** First installed copy of any of `names` in the family's known dirs, or null. Existence only. */
  function locate(names, family) {
    if (platform !== "win32" || !FAMILIES.includes(family)) return null;
    return findTool(names, dirs(family), existsSync);
  }

  /** The gate before any exec/spawn: { ok, path, signed } or { ok:false, error }. */
  async function verify(file, family) {
    if (platform !== "win32") return { ok: false, error: "Tools are Windows only." };
    if (!FAMILIES.includes(family)) return { ok: false, error: "Unknown tool family." };
    const target = String(file || "");
    if (!/^[A-Za-z]:\\/.test(target) || target.startsWith("\\\\")) return { ok: false, error: "Refusing a tool that is not a plain drive path." };
    let key;
    try { const st = statSync(target); key = `${family}|${target.toLowerCase()}|${st.size}|${Math.round(st.mtimeMs)}`; } catch { return { ok: false, error: `${path.win32.basename(target)} is not readable.` }; }
    if (cache.has(key)) return cache.get(key);
    const verdict = judge(family, await read(target));
    const answer = verdict.ok
      ? { ok: true, path: target, signed: verdict.signed, signer: verdict.signer || "" }
      : { ok: false, error: `Not run: ${path.win32.basename(target)} failed the signature check (${verdict.error}).` };
    if (answer.ok) cache.set(key, answer);
    return answer;
  }

  /**
   * locate + verify in one: null when the tool is not installed, { ok:false, error } when
   * it is installed but untrusted, { ok:true, path } when it may run.
   */
  async function resolve(names, family) {
    const found = locate(names, family);
    if (!found) return null;
    return verify(found, family);
  }

  return { locate, verify, resolve, dirs };
}

module.exports = {
  createTools, judge, commonName, findTool, powershellExe, psSignatureReader,
  powerToysDirs, sysinternalsDirs, converterDirs, SIG_SCRIPT, FAMILIES, MS_SIGNER,
};
