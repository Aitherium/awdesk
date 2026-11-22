"use strict";

/**
 * host-context — what the HOST OPERATING SYSTEM says the user is doing.
 *
 * The desk can already see exactly one window: its own embedded browser. Everything
 * else on the machine is invisible to it, so an agent asked "help me with what I
 * have open" can only guess, or make the owner describe their own screen. This is
 * the missing half — one call, `sampleHostContext()`, returning the foreground
 * application, its window title and pid: the plain facts an agent needs to stop
 * guessing.
 *
 * Three rules, each learned the hard way elsewhere in this tree:
 *
 *  1. SILENCE IS NOT A PASS. If the sampler cannot read the host it returns
 *     `{ok: false, reason}` — never a plausible-looking empty window. A blank
 *     answer that reads as "nothing is open" is the cleanest possible false
 *     clean, and it is worse than no answer at all.
 *  2. PARSERS ARE PURE. Each platform's output is parsed by a pure function so a
 *     test can feed it a fixture and FAIL. The IO wrapper is the only thing that
 *     touches a subprocess.
 *  3. NO NATIVE BUILD FOR THE FIRST SLICE. Windows goes through one PowerShell
 *     Add-Type block (user32), macOS through osascript, Linux through xprop with
 *     a Wayland fallback. A native addon makes every machine need a toolchain;
 *     it is not worth it until the shape is proven.
 *
 * Windows trap this already accounts for: `$pid` is a PowerShell AUTOMATIC
 * variable. Assigning it either throws or silently clobbers the host's own
 * process id, so the block uses `$processId` and never `$pid`.
 *
 * Linux honesty: X11 answers properly; Wayland compositors do not, so we return
 * `ok:false` with the compositor named rather than pretending the session is empty.
 *
 * Why this shape: `awdk/adk/context_assembly.py` already knows how to CONSUME
 * context (assemble/context_budget/ambient); the desk bridge and the :8182
 * gateway already TRANSPORT it. What was missing is a provider on the sending
 * end. This module is that provider's first slice.
 */

const { execFile } = require("node:child_process");

const MAX_TITLE = 300;

// One PowerShell process per sample would be ~200 ms of startup each time. A
// single Add-Type block per call is the cheap version; the cache comes later,
// when this is wired to a sampler loop rather than a question.
const WINDOWS_SCRIPT = `
$ErrorActionPreference = 'Stop'
# PowerShell writes to a pipe in the OEM code page unless told otherwise, so a
# window title containing an emoji or an accented name arrives as "?" — and a
# title is exactly the field an agent reads. Set the output encoding before the
# first byte is written, not after.
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Add-Type @"
using System;
using System.Runtime.InteropServices;
using System.Text;
public class AitherWin {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern int GetWindowThreadProcessId(IntPtr hWnd, out int processId);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowTextW(IntPtr hWnd, StringBuilder text, int max);
}
"@
$h = [AitherWin]::GetForegroundWindow()
if ($h -eq [IntPtr]::Zero) { Write-Output '{"pid":0}'; exit 0 }
$processId = 0
[void][AitherWin]::GetWindowThreadProcessId($h, [ref]$processId)
$sb = New-Object System.Text.StringBuilder 1024
[void][AitherWin]::GetWindowTextW($h, $sb, 1024)
$proc = Get-Process -Id $processId -ErrorAction SilentlyContinue
$app = $null
$exe = $null
if ($proc) { $app = $proc.ProcessName; $exe = $proc.Path }
[pscustomobject]@{
  pid = $processId
  title = $sb.ToString()
  app = $app
  exe = $exe
} | ConvertTo-Json -Compress
`;

const MAC_SCRIPT =
  'tell application "System Events" to get {name, unix id} of first application process whose frontmost is true';

// --------------------------------------------------------------------------- //
// Pure parsers — each one can be fed a fixture and can fail
// --------------------------------------------------------------------------- //

function cleanTitle(title) {
  if (typeof title !== "string") return "";
  const oneLine = title.replace(/[\r\n\t]+/g, " ").trim();
  return oneLine.length > MAX_TITLE ? oneLine.slice(0, MAX_TITLE) + "…" : oneLine;
}

function cleanName(name) {
  if (typeof name !== "string") return "";
  return name.trim();
}

/**
 * Parse the JSON the Windows block prints.
 * `{"pid":0}` means the OS answered and there is genuinely no foreground window
 * (lock screen, a UAC prompt), which is a real answer, not a failure.
 * Unparseable output is a failure, and returns null.
 */
function parseWindowsForeground(stdout) {
  const text = String(stdout || "").trim();
  if (!text) return null;
  let row;
  try {
    row = JSON.parse(text);
  } catch {
    return null;
  }
  if (!row || typeof row !== "object") return null;
  const pid = Number(row.pid);
  if (!Number.isFinite(pid) || pid <= 0) return null;
  return {
    pid,
    app: cleanName(row.app),
    title: cleanTitle(row.title),
    exe: typeof row.exe === "string" ? row.exe : "",
  };
}

/**
 * Parse osascript's `Name, 4242`. A comma can appear inside an application name
 * ("Acme, Inc. Editor"), so split on the LAST comma and require a numeric tail.
 */
function parseMacForeground(stdout) {
  const text = String(stdout || "").trim();
  if (!text) return null;
  const cut = text.lastIndexOf(",");
  if (cut <= 0) return null;
  const app = cleanName(text.slice(0, cut));
  const pid = Number(text.slice(cut + 1).trim());
  if (!app || !Number.isFinite(pid) || pid <= 0) return null;
  return { pid, app, title: "", exe: "" };
}

/**
 * Parse an X11 pair: `xprop -root _NET_ACTIVE_WINDOW` then
 * `xprop -id <id> _NET_WM_NAME WM_CLASS _NET_WM_PID`.
 * Returns null on 0x0 (no active window) and on anything unparseable.
 */
function parseLinuxXprop(activeOut, detailOut) {
  const active = String(activeOut || "");
  const match = active.match(/_NET_ACTIVE_WINDOW[^:]*:\s*(?:window id #\s*)?(0x[0-9a-fA-F]+)/);
  if (!match) return null;
  const windowId = match[1].toLowerCase();
  if (windowId === "0x0") return null;

  const detail = String(detailOut || "");
  const titleMatch = detail.match(/_NET_WM_NAME[^=]*=\s*"((?:[^"\\]|\\.)*)"/);
  const pidMatch = detail.match(/_NET_WM_PID[^=]*=\s*(\d+)/);
  const classMatch = detail.match(/WM_CLASS[^=]*=\s*(?:"([^"]*)",\s*)?"([^"]*)"/);

  const pid = pidMatch ? Number(pidMatch[1]) : 0;
  const app = classMatch ? cleanName(classMatch[2] || classMatch[1]) : "";
  if (!pid && !app && !titleMatch) return null;
  return {
    pid: Number.isFinite(pid) ? pid : 0,
    app,
    title: titleMatch ? cleanTitle(titleMatch[1].replace(/\\"/g, '"')) : "",
    exe: "",
    windowId,
  };
}

/** One line an agent can act on without reading a structure. */
function brief(context, max = 160) {
  if (!context || !context.ok) {
    return `host-context unavailable: ${(context && context.reason) || "unknown"}`;
  }
  const app = context.app || context.exe || "unknown app";
  const title = context.title ? ` — ${context.title}` : "";
  const line = `${app}${title} (pid ${context.pid})`;
  return line.length > max ? line.slice(0, max - 1) + "…" : line;
}

// --------------------------------------------------------------------------- //
// IO
// --------------------------------------------------------------------------- //

const DEFAULT_RUN = (file, args, timeoutMs) =>
  new Promise((resolve, reject) => {
    execFile(
      file,
      args,
      { timeout: timeoutMs, windowsHide: true, maxBuffer: 1024 * 1024 },
      (error, stdout) => (error ? reject(error) : resolve(String(stdout || ""))),
    );
  });

const PLATFORM_TIMEOUT_MS = 4000;

/**
 * Sample the host. Never throws; every failure is an `ok:false` with a reason.
 *
 * @param {{platform?: string, run?: Function, timeoutMs?: number, now?: Function}} options
 * @returns {Promise<object>} {ok:true, platform, app, title, pid, exe, sampledAt}
 *                            or {ok:false, platform, reason, sampledAt}
 */
async function sampleHostContext(options = {}) {
  const platform = options.platform || process.platform;
  const run = options.run || DEFAULT_RUN;
  const timeoutMs = options.timeoutMs || PLATFORM_TIMEOUT_MS;
  const now = options.now || Date.now;
  const sampledAt = now();

  const fail = (reason) => ({ ok: false, platform, reason, sampledAt });

  try {
    if (platform === "win32") {
      const stdout = await run(
        "powershell.exe",
        ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", WINDOWS_SCRIPT],
        timeoutMs,
      );
      const parsed = parseWindowsForeground(stdout);
      if (!parsed) return fail("Could not parse the foreground-window probe's output");
      return { ok: true, platform, ...parsed, sampledAt };
    }

    if (platform === "darwin") {
      const stdout = await run("osascript", ["-e", MAC_SCRIPT], timeoutMs);
      const parsed = parseMacForeground(stdout);
      if (!parsed) return fail("Could not parse the frontmost-application probe's output");
      return { ok: true, platform, ...parsed, sampledAt };
    }

    if (platform === "linux") {
      const activeOut = await run("xprop", ["-root", "_NET_ACTIVE_WINDOW"], timeoutMs);
      const match = String(activeOut).match(
        /_NET_ACTIVE_WINDOW[^:]*:\s*(?:window id #\s*)?(0x[0-9a-fA-F]+)/,
      );
      if (!match) {
        return fail("xprop answered but reported no _NET_ACTIVE_WINDOW (a Wayland session?)");
      }
      if (match[1].toLowerCase() === "0x0") {
        // MEASURED 2026-11-06 on the fleet distro: xprop answers `0x0` and exits 0
        // under a Wayland/WSLg session while the user plainly has windows open.
        // Reporting that as an empty-but-successful window makes an agent assert
        // "nothing is open" — a confident lie. It is a CANNOT-JUDGE, so say so.
        return fail(
          "X11 reports no _NET_ACTIVE_WINDOW (0x0) — a Wayland/WSLg session or no focused window; the foreground app cannot be inferred",
        );
      }
      const detailOut = await run(
        "xprop",
        ["-id", match[1], "_NET_WM_NAME", "WM_CLASS", "_NET_WM_PID"],
        timeoutMs,
      );
      const parsed = parseLinuxXprop(activeOut, detailOut);
      if (!parsed) return fail("Could not parse the active window's properties");
      return { ok: true, platform, ...parsed, sampledAt };
    }

    return fail(`No host-context probe for platform "${platform}"`);
  } catch (error) {
    const message = (error && error.message) || String(error);
    return fail(`Host-context probe failed: ${message.split("\n")[0]}`);
  }
}

module.exports = {
  MAX_TITLE,
  MAC_SCRIPT,
  WINDOWS_SCRIPT,
  brief,
  cleanTitle,
  parseLinuxXprop,
  parseMacForeground,
  parseWindowsForeground,
  sampleHostContext,
};
