"use strict";

/**
 * spirit-probe — the resident Windows window oracle behind attach.
 *
 * The spirit can be dropped on ANY window (Chrome, Notepad, a game), not only
 * the desk's own BrowserWindows, so "what is under this point" and "where is
 * that window now" have to come from the OS. A one-shot `Add-Type` per call
 * costs ~1 s, and attach follows a moving window at ~4 Hz, so this is ONE hidden
 * PowerShell that stays resident: a JSON request per line in, a JSON answer per
 * line out. `windowsHide: true` — a helper console never flashes on the owner's
 * desktop.
 *
 * The script is a constant and the coordinates cross no shell parser (they are
 * JSON on stdin). Fail-soft: a probe that cannot start, wedges or dies resolves
 * every call with {ok:false}, so the spirit still attaches to the desk's own
 * windows and simply cannot follow an external one.
 *
 * Everything is injectable (spawn, fs, the clock), so the framing is asserted
 * under `node --test` without Windows.
 */

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const PROBE_TIMEOUT_MS = 2500;
// The FIRST request pays PowerShell's Add-Type compile (~4 s measured on the
// owner's machine). A 2.5 s deadline killed the child before it could answer, so
// the first attach on a fresh desk always failed. Later requests are ~1 ms.
const PROBE_STARTUP_MS = 12000;
const PROBE_SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  // Node reads this child's stdout as UTF-8 (setEncoding below) and PowerShell writes
  // a pipe in the OEM code page unless told otherwise -- so a window title holding
  // an emoji or an accented name arrived as "?" (owner 2026-11-06: the spirit read
  // "attached to ? 0.tar.gz" for a Windows Terminal tab titled "◐ ..."). Set
  // BEFORE the first byte is written.
  "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8",
  "$OutputEncoding = [System.Text.Encoding]::UTF8",
  "Add-Type -TypeDefinition @'",
  "using System;",
  "using System.Runtime.InteropServices;",
  "using System.Text;",
  "public static class AitherWin {",
  "  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }",
  "  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X; public int Y; }",
  "  [DllImport(\"user32.dll\")] public static extern IntPtr WindowFromPoint(POINT p);",
  "  [DllImport(\"user32.dll\")] public static extern IntPtr GetAncestor(IntPtr hWnd, uint gaFlags);",
  "  [DllImport(\"user32.dll\")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT lpRect);",
  "  [DllImport(\"user32.dll\")] public static extern bool IsWindowVisible(IntPtr hWnd);",
  "  [DllImport(\"user32.dll\")] public static extern int GetWindowTextLength(IntPtr hWnd);",
  "  [DllImport(\"user32.dll\", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int count);",
  "  [DllImport(\"user32.dll\", CharSet=CharSet.Unicode)] public static extern int GetClassName(IntPtr hWnd, StringBuilder text, int count);",
  "  [DllImport(\"user32.dll\")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);",
  // The fairy's quiet check (fairy-attention): Windows' own "do not interrupt" answer
  // plus the foreground window's monitor, so a full-screen app or game holds a nudge.
  "  [StructLayout(LayoutKind.Sequential)] public struct MONITORINFO { public int cbSize; public RECT rcMonitor; public RECT rcWork; public uint dwFlags; }",
  "  [DllImport(\"shell32.dll\")] public static extern int SHQueryUserNotificationState(out int state);",
  "  [DllImport(\"user32.dll\")] public static extern IntPtr GetForegroundWindow();",
  "  [DllImport(\"user32.dll\")] public static extern IntPtr MonitorFromWindow(IntPtr hwnd, uint flags);",
  "  [DllImport(\"user32.dll\")] public static extern bool GetMonitorInfo(IntPtr hMonitor, ref MONITORINFO lpmi);",
  "  public static string Title(IntPtr h) { int n = GetWindowTextLength(h); var sb = new StringBuilder(n + 2); GetWindowText(h, sb, sb.Capacity); return sb.ToString(); }",
  "  public static string Class(IntPtr h) { var sb = new StringBuilder(256); GetClassName(h, sb, sb.Capacity); return sb.ToString(); }",
  "}",
  "'@",
  "function Emit($obj) { $obj | ConvertTo-Json -Compress -Depth 5 }",
  "function Describe([IntPtr]$h) {",
  "  if ($h -eq [IntPtr]::Zero) { return @{ ok = $false; error = 'no window' } }",
  "  $root = [AitherWin]::GetAncestor($h, 2)",
  "  if ($root -ne [IntPtr]::Zero) { $h = $root }",
  "  $r = New-Object AitherWin+RECT",
  "  if (-not [AitherWin]::GetWindowRect($h, [ref]$r)) { return @{ ok = $false; error = 'no rect' } }",
  "  $procId = 0",
  "  [void][AitherWin]::GetWindowThreadProcessId($h, [ref]$procId)",
  "  $proc = ''",
  "  try { $proc = (Get-Process -Id $procId -ErrorAction Stop).ProcessName } catch { }",
  "  return @{ ok = $true; hwnd = $h.ToInt64(); title = [AitherWin]::Title($h); className = [AitherWin]::Class($h); process = $proc; pid = $procId; visible = [AitherWin]::IsWindowVisible($h); rect = @{ x = $r.Left; y = $r.Top; width = ($r.Right - $r.Left); height = ($r.Bottom - $r.Top) } }",
  "}",
  "while ($true) {",
  "  $line = [Console]::In.ReadLine()",
  "  if ($null -eq $line) { break }",
  "  $line = $line.Trim()",
  "  if (-not $line) { continue }",
  "  $req = $null",
  "  try {",
  "    $req = $line | ConvertFrom-Json",
  "    if ($req.op -eq 'point') {",
  "      $pt = New-Object AitherWin+POINT",
  "      $pt.X = [int]$req.x; $pt.Y = [int]$req.y",
  "      $res = Describe ([AitherWin]::WindowFromPoint($pt))",
  "    } elseif ($req.op -eq 'rect') {",
  "      $res = Describe ([IntPtr][long]$req.hwnd)",
  "    } elseif ($req.op -eq 'quiet') {",
  "      $q = 0",
  "      [void][AitherWin]::SHQueryUserNotificationState([ref]$q)",
  "      $fg = [AitherWin]::GetForegroundWindow()",
  "      $res = Describe $fg",
  "      $res.quns = $q",
  "      $mi = New-Object AitherWin+MONITORINFO",
  "      $mi.cbSize = [System.Runtime.InteropServices.Marshal]::SizeOf($mi)",
  "      $mon = [AitherWin]::MonitorFromWindow($fg, 2)",
  "      if ($mon -ne [IntPtr]::Zero -and [AitherWin]::GetMonitorInfo($mon, [ref]$mi)) {",
  "        $res.monitor = @{ x = $mi.rcMonitor.Left; y = $mi.rcMonitor.Top; width = ($mi.rcMonitor.Right - $mi.rcMonitor.Left); height = ($mi.rcMonitor.Bottom - $mi.rcMonitor.Top) }",
  "      }",
  "    } elseif ($req.op -eq 'ping') {",
  "      $res = @{ ok = $true; pong = $true }",
  "    } else { $res = @{ ok = $false; error = \"unknown op $($req.op)\" } }",
  "    $res.id = $req.id",
  "    Emit $res",
  "  } catch {",
  "    $rid = if ($req) { $req.id } else { $null }",
  "    Emit @{ id = $rid; ok = $false; error = \"$($_.Exception.Message)\" }",
  "  }",
  "}",
].join("\r\n");

/** QUNS states that mean "do not interrupt" -- the same table as adk.decisions.quiet. */
const QUNS_QUIET = Object.freeze({ 2: "a full-screen app", 3: "a full-screen game", 4: "presentation mode", 6: "Focus Assist" });
const SHELL_CLASSES = new Set(["WorkerW", "Progman", "Shell_TrayWnd"]);
/** The desk's own windows cover a monitor by design (the overlay); never "full-screen". */
const DESK_PROCESSES = new Set(["electron", "desk", "awdesk"]);

/**
 * The quiet op's answer -> {quiet, reason}. Quiet when Windows says so (a full-screen
 * app, a game, presentation mode, Focus Assist), or when the foreground window covers
 * its whole monitor and is not the shell or the desk. Anything unreadable = not quiet.
 */
function quietFromAnswer(answer, { excludePid = null } = {}) {
  if (!answer || typeof answer !== "object") return { quiet: false, reason: "" };
  const label = QUNS_QUIET[Number(answer.quns)];
  if (label) return { quiet: true, reason: `Windows reports ${label}` };
  const r = answer.rect;
  const m = answer.monitor;
  if (answer.ok !== true || !r || !m) return { quiet: false, reason: "" };
  if (SHELL_CLASSES.has(String(answer.className || ""))) return { quiet: false, reason: "" };
  if (excludePid != null && Number(answer.pid) === Number(excludePid)) return { quiet: false, reason: "" };
  if (DESK_PROCESSES.has(String(answer.process || "").toLowerCase())) return { quiet: false, reason: "" };
  const covers = r.x <= m.x && r.y <= m.y && r.x + r.width >= m.x + m.width && r.y + r.height >= m.y + m.height;
  return covers
    ? { quiet: true, reason: `${answer.process || "an app"} is full-screen` }
    : { quiet: false, reason: "" };
}

/** The answer as the spirit's attach target, or null when it is not usable. */
function targetFromAnswer(answer, { excludePid = null } = {}) {
  if (!answer || answer.ok !== true) return null;
  if (!answer.rect) return null;
  const width = Number(answer.rect.width);
  const height = Number(answer.rect.height);
  if (!Number.isFinite(width) || !Number.isFinite(height) || width < 40 || height < 40) return null;
  if (excludePid != null && Number(answer.pid) === Number(excludePid)) return null;
  return {
    kind: "window",
    hwnd: Number(answer.hwnd) || null,
    title: String(answer.title || answer.process || answer.className || "a window").slice(0, 200),
    process: String(answer.process || ""),
    pid: Number(answer.pid) || null,
    className: String(answer.className || ""),
    bounds: {
      x: Math.round(Number(answer.rect.x) || 0),
      y: Math.round(Number(answer.rect.y) || 0),
      width: Math.round(width),
      height: Math.round(height),
    },
  };
}

/**
 * @param {object} opts
 * @param {Function} [opts.spawn]        child_process.spawn seam
 * @param {string}   [opts.powershell]   the executable
 * @param {Function} [opts.fsImpl]
 * @param {number}   [opts.timeoutMs]    per request
 * @param {number}   [opts.now]
 */
function createWindowProbe({
  spawn = require("node:child_process").spawn,
  powershell = process.platform === "win32" ? "powershell.exe" : "powershell",
  fsImpl = fs,
  timeoutMs = PROBE_TIMEOUT_MS,
  startupMs = PROBE_STARTUP_MS,
  now = () => Date.now(),
} = {}) {
  let child = null;
  let scriptFile = null;
  let buffer = "";
  let seq = 0;
  let brokenUntil = 0;
  const pending = new Map();

  function writeScript() {
    if (scriptFile) return scriptFile;
    scriptFile = path.join(os.tmpdir(), `aither-spirit-winprobe-${process.pid}.ps1`);
    fsImpl.writeFileSync(scriptFile, PROBE_SCRIPT, "utf8");
    return scriptFile;
  }

  function settle(why) {
    for (const [, p] of pending) p.resolve({ ok: false, error: why });
    pending.clear();
  }

  function drop(why) {
    const c = child;
    child = null;
    buffer = "";
    settle(why);
    if (c) { try { c.kill(); } catch { /* already gone */ } }
  }

  function start() {
    if (child) return true;
    if (now() < brokenUntil) return false;
    let c;
    try {
      writeScript();
      c = spawn(powershell, [
        "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", scriptFile,
      ], { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    } catch {
      brokenUntil = now() + 60_000;
      return false;
    }
    child = c;
    if (c.stdout) {
      c.stdout.setEncoding("utf8");
      c.stdout.on("data", (chunk) => {
        buffer += chunk;
        let nl;
        while ((nl = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, nl).trim();
          buffer = buffer.slice(nl + 1);
          if (!line) continue;
          let msg;
          try { msg = JSON.parse(line); } catch { continue; }
          const p = msg && pending.get(String(msg.id));
          if (!p) continue;
          pending.delete(String(msg.id));
          p.resolve(msg);
        }
      });
    }
    if (c.stderr) c.stderr.on("data", () => { /* warnings; answers come on stdout */ });
    const gone = (why) => {
      if (child !== c) return;
      brokenUntil = now() + 60_000;
      drop(why);
    };
    c.on("exit", (code) => gone(`the window probe exited (code ${code})`));
    c.on("error", (error) => gone(`the window probe failed to start: ${error && error.message ? error.message : error}`));
    if (c.stdin && typeof c.stdin.on === "function") c.stdin.on("error", () => gone("the window probe closed its input"));
    return true;
  }

  function request(payload) {
    return new Promise((resolve) => {
      const starting = !child; // this request pays the one-time Add-Type compile
      if (!start()) {
        resolve({ ok: false, error: "the window probe is not available" });
        return;
      }
      const id = `w${++seq}`;
      let timer = null;
      const done = (value) => {
        if (timer) clearTimeout(timer);
        pending.delete(id);
        resolve(value);
      };
      pending.set(id, { resolve: done });
      timer = setTimeout(() => {
        if (!pending.has(id)) return;
        brokenUntil = now() + 60_000;
        drop("the window probe missed its deadline");
        resolve({ ok: false, error: "the window probe did not answer" });
      }, Math.max(500, Number(starting ? startupMs : timeoutMs) || PROBE_TIMEOUT_MS));
      if (timer.unref) timer.unref();
      try {
        child.stdin.write(`${JSON.stringify({ id, ...payload })}\n`);
      } catch {
        done({ ok: false, error: "the window probe closed its input" });
      }
    });
  }

  /** The window under a screen point, or null. */
  async function pointAt(x, y, opts = {}) {
    const answer = await request({ op: "point", x: Math.round(Number(x) || 0), y: Math.round(Number(y) || 0) });
    return targetFromAnswer(answer, opts);
  }

  /** A known window's CURRENT rect (attach follows a moving window with this). */
  async function rectOf(hwnd, opts = {}) {
    const answer = await request({ op: "rect", hwnd: Number(hwnd) || 0 });
    return targetFromAnswer(answer, opts);
  }

  /** Is the owner in something that must not be interrupted? {quiet, reason}. */
  async function quietState(opts = {}) {
    const answer = await request({ op: "quiet" });
    return quietFromAnswer(answer, opts);
  }

  async function ping() {
    const answer = await request({ op: "ping" });
    return answer && answer.ok === true;
  }

  return {
    pointAt,
    rectOf,
    quietState,
    ping,
    start,
    stop: () => drop("stopped"),
    get running() { return Boolean(child); },
    get scriptFile() { return scriptFile; },
  };
}

module.exports = {
  PROBE_TIMEOUT_MS, PROBE_STARTUP_MS, PROBE_SCRIPT, createWindowProbe, targetFromAnswer, quietFromAnswer, QUNS_QUIET,
};
