"use strict";

/**
 * session-context — what a Claude Code session behind an Inbox card is doing,
 * whether it is still open, and the three ways to reach it.
 *
 * Owner, 2026-11-08, on an expanded "Claude Code needs you" card: "not enough info
 * and there's not an easy way to interact or dive deeper or engage with those
 * sessions". The card carried one clipped summary blob. The session itself has
 * everything: its journal (~/.claude/projects/<cwd-slug>/<id>.jsonl) holds the
 * title, what was asked and the full last answer, and each RUNNING Claude Code
 * process writes ~/.claude/sessions/<pid>.json ({pid, sessionId, name, status}),
 * which is ground truth for "is it open right now" (the same source
 * AitherResume's Get-LiveClaudeSessions trusts -- a stale file names a dead pid,
 * so liveness is only claimed when the pid is alive).
 *
 * Reach, honestly labelled:
 *   focus  -- bring its Windows Terminal tab forward (UI Automation, by tab name).
 *   resume -- an ENDED session reopens in a new tab (`claude --resume <id>`);
 *             refused while it is live (that would fork a second copy).
 *   reply  -- live: the card's steer mailbox (it reads it at its next prompt) and
 *             its tab comes forward; ended: resumed with the text as its first
 *             message.
 *
 * Reads are BOUNDED (journals reach 200 MB): a head window for the first ask and
 * a tail window for the rest. Nothing here writes to a journal.
 */

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const HEAD_BYTES = 384 * 1024;
/** Tail windows tried in order until enough real turns surface. Measured 2026-11-08:
 *  the last 2 MB of a 195 MB journal held 531 api-request-blob records and ONE turn. */
const TAIL_STEPS = Object.freeze([2, 8, 24].map((mb) => mb * 1024 * 1024));
const WANT_TURNS = 4;
const MAX_TURNS = 8;
const MAX_FILES = 10;

function claudeHome(env = process.env) {
  const explicit = String(env.CLAUDE_CONFIG_DIR || "").trim();
  return explicit || path.join(os.homedir(), ".claude");
}

const SESSION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Claude Code's project dir name for a cwd: every non-alphanumeric char becomes '-'. */
function projectSlug(cwd) {
  return String(cwd || "").replace(/[^A-Za-z0-9]/g, "-");
}

/** The journal for a session, or "" when it cannot be found. */
function transcriptPath(sessionId, cwd, { home = claudeHome(), fsImpl = fs } = {}) {
  if (!SESSION_ID_RE.test(String(sessionId || ""))) return "";
  const projects = path.join(home, "projects");
  if (cwd) {
    const direct = path.join(projects, projectSlug(cwd), `${sessionId}.jsonl`);
    try { if (fsImpl.statSync(direct).isFile()) return direct; } catch { /* fall through to the scan */ }
  }
  let dirs;
  try { dirs = fsImpl.readdirSync(projects); } catch { return ""; }
  for (const dir of dirs.slice(0, 400)) {
    const candidate = path.join(projects, dir, `${sessionId}.jsonl`);
    try { if (fsImpl.statSync(candidate).isFile()) return candidate; } catch { /* next */ }
  }
  return "";
}

function pidAlive(pid, killImpl = process.kill) {
  const n = Number(pid);
  if (!Number.isInteger(n) || n <= 0) return false;
  try {
    killImpl(n, 0);
    return true;
  } catch (error) {
    return Boolean(error && error.code === "EPERM"); // exists, not ours to signal
  }
}

/**
 * The sessions OPEN right now: sessionId -> {pid, name, status, since, cwd, kind}.
 * A state file whose pid is gone is a crashed/rebooted leftover and is skipped.
 */
function liveSessions({ home = claudeHome(), fsImpl = fs, alive = pidAlive } = {}) {
  const out = new Map();
  const dir = path.join(home, "sessions");
  let names;
  try { names = fsImpl.readdirSync(dir); } catch { return out; }
  for (const name of names) {
    if (!/^\d+\.json$/.test(name)) continue;
    let raw;
    try { raw = JSON.parse(fsImpl.readFileSync(path.join(dir, name), "utf8")); } catch { continue; }
    if (!raw || typeof raw.sessionId !== "string" || !raw.pid) continue;
    if (!alive(raw.pid)) continue;
    const prev = out.get(raw.sessionId);
    const since = Number(raw.statusUpdatedAt || raw.updatedAt || raw.startedAt) || 0;
    if (prev && prev.since >= since) continue;
    out.set(raw.sessionId, {
      pid: Number(raw.pid),
      name: typeof raw.name === "string" ? raw.name.slice(0, 160) : "",
      status: typeof raw.status === "string" ? raw.status.slice(0, 24) : "",
      since,
      cwd: typeof raw.cwd === "string" ? raw.cwd : "",
      kind: typeof raw.kind === "string" ? raw.kind : "",
    });
  }
  return out;
}

// ── journal text ────────────────────────────────────────────────────────────

/** A teammate message is JSON inside an XML wrapper; say who sent it and what it said. */
function teammateLine(text) {
  const m = String(text).match(/<teammate-message[^>]*teammate_id="([^"]+)"[^>]*>([\s\S]*?)(<\/teammate-message>|$)/);
  if (!m) return null;
  const who = m[1];
  const body = m[2].trim();
  let said = body;
  try {
    const obj = JSON.parse(body);
    said = String(obj.result || obj.summary || obj.message || obj.text || obj.idleReason || "").trim() || body;
  } catch {
    const r = body.match(/"result"\s*:\s*"((?:[^"\\]|\\.)*)/);
    const kind = body.match(/"type"\s*:\s*"([a-z_]+)"/);
    if (r) {
      try { said = JSON.parse(`"${r[1]}"`); } catch { said = r[1]; }
    } else if (kind) {
      said = `(${kind[1].replace(/_/g, " ")})`; // a clipped notification: say what it was, not its JSON
    }
  }
  return `Message from ${who}: ${said}`;
}

/** The owner's words, without the harness's wrappers. "" = nothing human in it. */
function cleanUserText(text) {
  let t = String(text == null ? "" : text);
  const mate = teammateLine(t);
  if (mate) return mate.slice(0, 4000);
  t = t.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, "");
  t = t.replace(/<local-command-(stdout|stderr|caveat)>[\s\S]*?<\/local-command-\1>/g, "");
  t = t.replace(/<command-message>[\s\S]*?<\/command-message>/g, "");
  t = t.replace(/<command-name>([\s\S]*?)<\/command-name>/g, "$1 ");
  t = t.replace(/<command-args>([\s\S]*?)<\/command-args>/g, "$1");
  t = t.replace(/<\/?[a-z][a-z0-9_-]*(\s[^>]*)?>/gi, "");
  t = t.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  return t;
}

function textOf(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((b) => b && b.type === "text" && typeof b.text === "string")
    .map((b) => b.text)
    .join("\n");
}

function isToolResult(content) {
  return Array.isArray(content) && content.some((b) => b && b.type === "tool_result");
}

const SKIP_TYPE_RE = /"type"\s*:\s*"(api-request|api-request-blob|attachment|queue-operation|atis-latch|permission-mode|mode|file-history-snapshot|progress)"/;

const KEEP_TYPE_RE = /"type"\s*:\s*"(user|assistant|custom-title|ai-title|last-prompt)"/;

function parseLines(raw, { dropFirst = false, dropLast = false } = {}) {
  const lines = String(raw).split("\n");
  if (dropFirst) lines.shift();
  if (dropLast) lines.pop();
  const out = [];
  for (const line of lines) {
    const s = line.trim();
    if (!s || s[0] !== "{") continue;
    // Skip the bulk BEFORE parsing: api-request blobs are most of a journal's bytes
    // and none of what the Inbox shows (parse cost dominated: 822 ms -> see test).
    const lead = s.slice(0, 400);
    if (SKIP_TYPE_RE.test(lead) && !KEEP_TYPE_RE.test(lead)) continue;
    try { out.push(JSON.parse(s)); } catch { /* a torn line at a window edge */ }
  }
  return out;
}

function readWindow(file, { start, length }, fsImpl = fs) {
  let fd = null;
  try {
    fd = fsImpl.openSync(file, "r");
    const buf = Buffer.alloc(length);
    const n = fsImpl.readSync(fd, buf, 0, length, start);
    return buf.subarray(0, n).toString("utf8");
  } catch {
    return "";
  } finally {
    if (fd != null) { try { fsImpl.closeSync(fd); } catch { /* closed */ } }
  }
}

function timeOf(rec) {
  const t = Date.parse(rec && rec.timestamp);
  return Number.isFinite(t) ? t : 0;
}

/** One journal record -> a turn, or null (tool results, meta, empty). */
function turnOf(rec) {
  if (!rec || (rec.type !== "user" && rec.type !== "assistant") || rec.isMeta) return null;
  const msg = rec.message || {};
  if (rec.type === "user") {
    if (isToolResult(msg.content)) return null;
    const text = cleanUserText(textOf(msg.content));
    return text ? { role: "user", text, at: timeOf(rec) } : null;
  }
  const text = textOf(msg.content).trim();
  return text ? { role: "assistant", text, at: timeOf(rec) } : null;
}

function filesOf(records) {
  const seen = [];
  for (let i = records.length - 1; i >= 0 && seen.length < MAX_FILES; i -= 1) {
    const content = records[i] && records[i].type === "assistant" && records[i].message && records[i].message.content;
    if (!Array.isArray(content)) continue;
    for (let j = content.length - 1; j >= 0; j -= 1) {
      const b = content[j];
      if (!b || b.type !== "tool_use" || !/^(Edit|Write|MultiEdit|NotebookEdit)$/.test(String(b.name))) continue;
      const p = b.input && (b.input.file_path || b.input.notebook_path);
      if (typeof p === "string" && p && !seen.includes(p)) seen.push(p);
      if (seen.length >= MAX_FILES) break;
    }
  }
  return seen;
}

const clip = (s, n) => (String(s).length > n ? `${String(s).slice(0, n - 1)}…` : String(s));

/** "Aitherium/AitherOS" from a git remote URL, or "". */
function repoFromRemote(url) {
  const m = String(url || "").trim().match(/github\.com[:/]([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(\.git)?$/);
  return m ? `${m[1]}/${m[2]}` : "";
}

const repoCache = new Map();
function repoFor(cwd, { run = null } = {}) {
  const key = String(cwd || "");
  if (!key) return "";
  if (repoCache.has(key)) return repoCache.get(key);
  let repo;
  try {
    const exec = run || ((args) => require("node:child_process").execFileSync("git", args, {
      encoding: "utf8", timeout: 3000, windowsHide: true, stdio: ["ignore", "pipe", "ignore"],
    }));
    repo = repoFromRemote(exec(["-C", key, "remote", "get-url", "origin"]));
  } catch { repo = ""; }
  repoCache.set(key, repo);
  return repo;
}

/**
 * Everything the Inbox shows about a session. Never throws; {ok:false, error}
 * when the journal cannot be found.
 */
function readContext(sessionId, cwd, { home = claudeHome(), fsImpl = fs, live = null, repo = undefined } = {}) {
  const file = transcriptPath(sessionId, cwd, { home, fsImpl });
  if (!file) return { ok: false, error: "This session's journal is not on this machine." };
  let size;
  let updatedAt;
  try {
    const st = fsImpl.statSync(file);
    size = st.size;
    updatedAt = st.mtimeMs;
  } catch {
    return { ok: false, error: "This session's journal could not be read." };
  }
  const head = parseLines(readWindow(file, { start: 0, length: Math.min(HEAD_BYTES, size) }, fsImpl),
    { dropLast: size > HEAD_BYTES });
  let tail = head;
  if (size > HEAD_BYTES) {
    for (const step of TAIL_STEPS) {
      const tailStart = Math.max(0, size - step);
      tail = parseLines(readWindow(file, { start: tailStart, length: size - tailStart }, fsImpl), { dropFirst: tailStart > 0 });
      if (tail.filter((rec) => turnOf(rec)).length >= WANT_TURNS || tailStart === 0) break;
    }
  }

  let firstAsk = "";
  for (const rec of head) {
    const t = turnOf(rec);
    if (t && t.role === "user") { firstAsk = t.text; break; }
  }
  let name = "";
  let lastPrompt = "";
  for (let i = tail.length - 1; i >= 0; i -= 1) {
    const rec = tail[i];
    if (!name && rec.type === "custom-title" && typeof rec.customTitle === "string") name = rec.customTitle;
    if (!name && rec.type === "ai-title" && typeof (rec.aiTitle || rec.title) === "string") name = rec.aiTitle || rec.title;
    if (!lastPrompt && rec.type === "last-prompt" && typeof rec.lastPrompt === "string") lastPrompt = rec.lastPrompt;
    if (name && lastPrompt) break;
  }
  const turns = [];
  for (const rec of tail) {
    const t = turnOf(rec);
    if (!t) continue;
    const prev = turns[turns.length - 1];
    // Consecutive assistant blocks are one answer streamed in parts.
    if (prev && prev.role === t.role && t.role === "assistant") prev.text = `${prev.text}\n\n${t.text}`;
    else turns.push(t);
  }
  const lastUser = [...turns].reverse().find((t) => t.role === "user");
  const lastAssistant = [...turns].reverse().find((t) => t.role === "assistant");
  const liveRow = live === null ? null : live;
  return {
    ok: true,
    sessionId,
    name: clip(name || (liveRow && liveRow.name) || "", 160),
    live: liveRow ? { status: liveRow.status || "", pid: liveRow.pid, since: liveRow.since || 0 } : null,
    updatedAt,
    firstAsk: clip(firstAsk, 1200),
    lastAsk: clip(lastUser ? lastUser.text : cleanUserText(lastPrompt), 1200),
    lastSaid: clip(lastAssistant ? lastAssistant.text : "", 6000),
    turns: turns.slice(-MAX_TURNS).map((t) => ({ role: t.role, text: clip(t.text, 1500), at: t.at })),
    files: filesOf(tail),
    repo: repo === undefined ? repoFor(cwd) : String(repo || ""),
    transcript: file,
  };
}

// ── reaching it ─────────────────────────────────────────────────────────────

/** A tab title as Windows Terminal shows it: Claude prefixes a spinner/status glyph. */
function tabMatches(tabName, sessionName) {
  const norm = (s) => String(s || "").replace(/^[^\p{L}\p{N}]+/u, "").replace(/…$/, "").trim().toLowerCase();
  const a = norm(tabName);
  const b = norm(sessionName);
  if (!a || !b || b.length < 3) return false;
  return a === b || a.startsWith(b) || b.startsWith(a);
}

/** PowerShell (UI Automation) that selects the WT tab whose name matches, then raises its window. */
function focusScript() {
  return [
    "$ErrorActionPreference = 'Stop'",
    "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8",
    "Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes",
    "Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public static class AitherFg { [DllImport(\"user32.dll\")] public static extern bool SetForegroundWindow(IntPtr h); [DllImport(\"user32.dll\")] public static extern bool ShowWindow(IntPtr h, int c); [DllImport(\"user32.dll\")] public static extern bool IsIconic(IntPtr h); }'",
    "$want = [Console]::In.ReadLine()",
    "function Norm([string]$s) { return ($s -replace '^[^\\p{L}\\p{N}]+', '' -replace '…$', '').Trim().ToLowerInvariant() }",
    "$w = Norm $want",
    "$root = [System.Windows.Automation.AutomationElement]::RootElement",
    "$cls = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ClassNameProperty, 'CASCADIA_HOSTING_WINDOW_CLASS')",
    "$tabCond = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ControlTypeProperty, [System.Windows.Automation.ControlType]::TabItem)",
    "$found = $null; $names = @()",
    "foreach ($win in $root.FindAll([System.Windows.Automation.TreeScope]::Children, $cls)) {",
    "  foreach ($tab in $win.FindAll([System.Windows.Automation.TreeScope]::Descendants, $tabCond)) {",
    "    $n = Norm $tab.Current.Name; $names += $tab.Current.Name",
    "    if ($w.Length -ge 3 -and ($n -eq $w -or $n.StartsWith($w) -or $w.StartsWith($n)) -and $n.Length -ge 3) { $found = @($win, $tab); break }",
    "  }",
    "  if ($found) { break }",
    "}",
    "if (-not $found) { @{ ok = $false; error = 'no open terminal tab has that name'; tabs = $names.Count } | ConvertTo-Json -Compress; exit 0 }",
    "$sel = $found[1].GetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern)",
    "$sel.Select()",
    "$h = [IntPtr]$found[0].Current.NativeWindowHandle",
    "if ([AitherFg]::IsIconic($h)) { [void][AitherFg]::ShowWindow($h, 9) }",
    "[void][AitherFg]::SetForegroundWindow($h)",
    "@{ ok = $true; tab = $found[1].Current.Name } | ConvertTo-Json -Compress",
  ].join("\r\n");
}

/** Bring the session's terminal tab forward. Resolves {ok, tab?, error?}. */
function focusSessionTab(sessionName, { spawn = require("node:child_process").spawn, timeoutMs = 15000 } = {}) {
  const name = String(sessionName || "").trim();
  if (name.length < 3) return Promise.resolve({ ok: false, error: "this session has no name to find its tab by" });
  if (process.platform !== "win32") return Promise.resolve({ ok: false, error: "tab focus needs Windows Terminal" });
  return new Promise((resolve) => {
    let out = "";
    let done = false;
    const file = path.join(os.tmpdir(), `aither-focus-tab-${process.pid}.ps1`);
    const finish = (v) => {
      if (done) return;
      done = true;
      try { fs.rmSync(file, { force: true }); } catch { /* temp */ }
      resolve(v);
    };
    let child;
    try {
      fs.writeFileSync(file, focusScript(), "utf8");
      child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", file],
        { windowsHide: true, stdio: ["pipe", "pipe", "ignore"] });
    } catch (error) {
      finish({ ok: false, error: String((error && error.message) || error) });
      return;
    }
    const timer = setTimeout(() => { try { child.kill(); } catch { /* gone */ } finish({ ok: false, error: "the tab search timed out" }); }, timeoutMs);
    if (timer.unref) timer.unref();
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (d) => { out += d; });
    child.on("error", (e) => finish({ ok: false, error: String((e && e.message) || e) }));
    child.on("close", () => {
      clearTimeout(timer);
      const line = out.trim().split(/\r?\n/).pop() || "";
      try { finish(JSON.parse(line)); } catch { finish({ ok: false, error: "the tab search gave no answer" }); }
    });
    try { child.stdin.end(`${name}\n`); } catch { /* close reports */ }
  });
}

/** A PowerShell single-quoted literal. */
function psQuote(s) {
  return `'${String(s).replace(/'/g, "''")}'`;
}

/**
 * The argv that reopens a session in a new Windows Terminal tab. The payload is
 * -EncodedCommand (wt splits a -Command string at ';' -- AitherResume's measured
 * trap) and scrubs an inherited NO_COLOR (it strips Claude's colours).
 */
function resumeArgv({ sessionId, cwd, title = "", prompt = "", launcher = "claude", pwsh = "pwsh.exe" }) {
  if (!SESSION_ID_RE.test(String(sessionId || ""))) throw new Error("not a session id");
  const parts = ["Remove-Item Env:NO_COLOR -ErrorAction SilentlyContinue"];
  if (cwd) parts.push(`Set-Location -LiteralPath ${psQuote(cwd)}`);
  parts.push(`& ${psQuote(launcher)} --resume ${sessionId}${prompt ? ` ${psQuote(String(prompt).slice(0, 4000))}` : ""}`);
  const encoded = Buffer.from(parts.join("; "), "utf16le").toString("base64");
  const argv = ["-w", "0", "new-tab"];
  if (title) argv.push("--title", String(title).slice(0, 80));
  if (cwd) argv.push("-d", cwd);
  argv.push(pwsh, "-NoExit", "-EncodedCommand", encoded);
  return argv;
}

function resumeSession({ sessionId, cwd, title, prompt }, { spawn = require("node:child_process").spawn } = {}) {
  try {
    const child = spawn("wt.exe", resumeArgv({ sessionId, cwd, title, prompt }), {
      detached: true, stdio: "ignore", windowsHide: false,
    });
    child.on("error", () => { /* reported by the caller's next liveness read */ });
    child.unref();
    return { ok: true };
  } catch (error) {
    return { ok: false, error: String((error && error.message) || error) };
  }
}

module.exports = {
  SESSION_ID_RE,
  projectSlug,
  transcriptPath,
  pidAlive,
  liveSessions,
  cleanUserText,
  teammateLine,
  readContext,
  repoFromRemote,
  tabMatches,
  focusScript,
  focusSessionTab,
  resumeArgv,
  resumeSession,
};
