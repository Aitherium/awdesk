"use strict";
/**
 * A `tui:` card answer for a Claude Code session: bring the session's Windows
 * Terminal tab to the front. NEVER claim the answer reached the session.
 *
 * Measured 2026-11-08: SendKeys after a confirmed SetForegroundWindow + tab select
 * returned typed:true and a probe tab received NOTHING (keyboard focus sits on the
 * XAML tab strip, not the TermControl), so cards were marked "typed 2 into the
 * terminal" while the session kept waiting. No keystroke is sent any more. A card
 * answer that must reach the session goes through awask's PreToolUse hold
 * (`ans:<n>` keys, answered by hook updatedInput), which is an ordinary answer here.
 *
 * Historic contract kept below for the `tui:<n>` cards still open: the tab is
 * focused, nothing is typed or recorded, and the surface says to answer there.
 *
 * awask's Notification hook raises an AskUserQuestion card whose options are keyed
 * `tui:<n>` -- the number the terminal shows beside each option -- plus `tui:type`
 * ("Type something": just bring the session forward). Recording the answer in the
 * card store alone would leave the terminal blocked, so the desk types it.
 *
 * Fail closed: when the tab is not found, or the foreground window is not that
 * terminal with that tab selected right before the keystroke, NOTHING is typed and
 * the caller says "Open the session to answer". Only the digit is sent, no Enter:
 * Claude Code's select acts on the digit itself, and an extra Enter would land on
 * the NEXT question of a multi-question ask and pick its highlighted option.
 */
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const TUI_KEY_RE = /^tui:([1-9]|type)$/;
const FLASH_OPEN_SESSION = "Open the session to answer";
const FLASH_IN_FRONT = "It's in front now: answer it there";

/** The terminal action a card answer asks for, or null when it is an ordinary answer. */
function tuiAction(card, key) {
  if (!card || typeof card !== "object") return null;
  const agent = String(card.agent || (card.source && card.source.agent) || "");
  if (agent !== "claude-code") return null;
  const m = TUI_KEY_RE.exec(String(key || ""));
  if (!m) return null;
  return m[1] === "type" ? { keys: "" } : { keys: m[1] };
}

/**
 * The Win32 half of raising a window from a process the owner did NOT just click.
 *
 * Measured 2026-11-17 (card d-yjmc, "Go live: openaw.org"): "Open the session" on the
 * fairy's whisper flashed "Open the session to answer" and nothing came forward. The
 * whisper is `focusable:false` (it never takes the keyboard), so the desk is not the
 * foreground process when it is clicked, and Windows refuses SetForegroundWindow from
 * its child: the check right after read "not in front". Attaching to the foreground
 * window's input thread is the documented way a background process may hand the
 * foreground over; SwitchToThisWindow is the fallback. Still no keystroke of any kind.
 */
const FOREGROUND_TYPE = "Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public static class AitherTui { [DllImport(\"user32.dll\")] public static extern bool SetForegroundWindow(IntPtr h); [DllImport(\"user32.dll\")] public static extern IntPtr GetForegroundWindow(); [DllImport(\"user32.dll\")] public static extern bool ShowWindow(IntPtr h, int c); [DllImport(\"user32.dll\")] public static extern bool IsIconic(IntPtr h); [DllImport(\"user32.dll\")] public static extern bool BringWindowToTop(IntPtr h); [DllImport(\"user32.dll\")] public static extern void SwitchToThisWindow(IntPtr h, bool alt); [DllImport(\"user32.dll\")] public static extern uint GetWindowThreadProcessId(IntPtr h, IntPtr pid); [DllImport(\"user32.dll\")] public static extern bool AttachThreadInput(uint a, uint b, bool attach); [DllImport(\"kernel32.dll\")] public static extern uint GetCurrentThreadId(); }'";

/** PowerShell lines defining `Raise $h` -> $true when $h is the foreground window after. */
function raiseLines() {
  return [
    FOREGROUND_TYPE,
    "function Raise([IntPtr]$h) {",
    "  if ([AitherTui]::IsIconic($h)) { [void][AitherTui]::ShowWindow($h, 9) }",
    "  for ($i = 0; $i -lt 3; $i++) {",
    "    $fg = [AitherTui]::GetForegroundWindow()",
    "    if ($fg -eq $h) { return $true }",
    "    $me = [AitherTui]::GetCurrentThreadId()",
    "    $other = [AitherTui]::GetWindowThreadProcessId($fg, [IntPtr]::Zero)",
    "    $att = $false",
    "    if ($other -ne 0 -and $other -ne $me) { $att = [AitherTui]::AttachThreadInput($me, $other, $true) }",
    "    [void][AitherTui]::BringWindowToTop($h)",
    "    [void][AitherTui]::SetForegroundWindow($h)",
    "    if ($att) { [void][AitherTui]::AttachThreadInput($me, $other, $false) }",
    "    if ($i -ge 1) { [AitherTui]::SwitchToThisWindow($h, $true) }",
    "    Start-Sleep -Milliseconds 200",
    "  }",
    "  return ([AitherTui]::GetForegroundWindow() -eq $h)",
    "}",
  ];
}

/**
 * PowerShell (UI Automation): select the WT tab whose name matches one of the names on
 * stdin line 1 (TAB-separated, in order of trust), raise its window, re-read the
 * foreground window and the tab's selection state, and report whether it is in front.
 * An EXACT name match on any tab wins over a prefix match (two sessions can share a
 * prefix). Stdin line 2 (a digit) is validated and IGNORED: no keystroke is ever sent.
 */
function typeScript() {
  return [
    "$ErrorActionPreference = 'Stop'",
    "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8",
    "Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes",
    ...raiseLines(),
    "$want = [Console]::In.ReadLine()",
    "$keys = [Console]::In.ReadLine()",
    "if ($null -eq $keys) { $keys = '' }",
    "if ($keys -notmatch '^[1-9]?$') { @{ ok = $false; typed = $false; error = 'refused: not an option number' } | ConvertTo-Json -Compress; exit 0 }",
    "function Norm([string]$s) { return ($s -replace '^[^\\p{L}\\p{N}]+', '' -replace '…$', '').Trim().ToLowerInvariant() }",
    "$wants = @(\"$want\" -split \"`t\" | ForEach-Object { Norm $_ } | Where-Object { $_.Length -ge 3 })",
    "$root = [System.Windows.Automation.AutomationElement]::RootElement",
    "$cls = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ClassNameProperty, 'CASCADIA_HOSTING_WINDOW_CLASS')",
    "$tabCond = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ControlTypeProperty, [System.Windows.Automation.ControlType]::TabItem)",
    "$all = @()",
    "foreach ($win in $root.FindAll([System.Windows.Automation.TreeScope]::Children, $cls)) {",
    "  foreach ($tab in $win.FindAll([System.Windows.Automation.TreeScope]::Descendants, $tabCond)) { $all += ,@($win, $tab, (Norm $tab.Current.Name)) }",
    "}",
    "$found = $null",
    "foreach ($w in $wants) { foreach ($t in $all) { if ($t[2] -eq $w) { $found = $t; break } }; if ($found) { break } }",
    "if (-not $found) { foreach ($w in $wants) { foreach ($t in $all) { $n = $t[2]; if ($n.Length -ge 3 -and ($n.StartsWith($w) -or $w.StartsWith($n))) { $found = $t; break } }; if ($found) { break } } }",
    "if (-not $found) { @{ ok = $false; typed = $false; error = ('no open terminal tab has that name (' + $all.Count + ' tabs open)') } | ConvertTo-Json -Compress; exit 0 }",
    "$sel = $found[1].GetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern)",
    "$sel.Select()",
    "$h = [IntPtr]$found[0].Current.NativeWindowHandle",
    "$front = Raise $h",
    "$fg = [AitherTui]::GetForegroundWindow()",
    "$selected = $found[1].GetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern).Current.IsSelected",
    "if ($fg -ne $h -or -not $selected) { @{ ok = $false; typed = $false; tab = $found[1].Current.Name; error = 'Windows would not bring the terminal to the front' } | ConvertTo-Json -Compress; exit 0 }",
    "@{ ok = $true; typed = $false; tab = $found[1].Current.Name } | ConvertTo-Json -Compress",
  ].join("\r\n");
}

/** The names a session's tab may carry, trusted first, de-duplicated, >= 3 chars. */
function sessionNames(value) {
  const list = Array.isArray(value) ? value : [value];
  const out = [];
  for (const v of list) {
    const n = String(v == null ? "" : v).replace(/[\t\r\n]+/g, " ").trim();
    if (n.length >= 3 && !out.includes(n)) out.push(n);
  }
  return out;
}

/**
 * What the owner reads when the tab could not be brought forward: WHY, in words, and
 * where to go instead. Never the bare "Open the session to answer" on the very button
 * that says "Open the session" (2026-11-17: that told him nothing).
 */
function flashFor(error, name) {
  const e = String(error || "");
  const who = name ? `“${name.length > 48 ? `${name.slice(0, 47)}…` : name}”` : "this session";
  if (/no name/.test(e)) return "Can't find this session's tab: it has no name. Answer it in its terminal.";
  if (/no open terminal tab/.test(e)) return `No open terminal tab is named ${who}. Answer it in its terminal.`;
  if (/would not bring|could not confirm/.test(e)) return `Found ${who}, but Windows kept it behind. Click its tab to answer.`;
  if (/needs Windows Terminal/.test(e)) return "Only a Windows Terminal tab can be brought forward. Answer it in its terminal.";
  if (/timed out|gave no answer/.test(e)) return `Looking for ${who} took too long. Answer it in its terminal.`;
  return `${FLASH_OPEN_SESSION}: ${e.slice(0, 80)}`;
}

/**
 * Focus the named session's tab. Never types: resolves typed:false always.
 * Resolves {ok, typed, tab?, error?}; never rejects.
 */
function typeIntoSession(sessionName, keys, { spawn = require("node:child_process").spawn, timeoutMs = 15000, platform = process.platform } = {}) {
  const names = sessionNames(sessionName);
  const name = names.join("\t");
  const k = String(keys || "");
  if (!names.length) return Promise.resolve({ ok: false, typed: false, error: "this session has no name to find its tab by" });
  if (!/^[1-9]?$/.test(k)) return Promise.resolve({ ok: false, typed: false, error: "refused: not an option number" });
  if (platform !== "win32") return Promise.resolve({ ok: false, typed: false, error: "typing into a session needs Windows Terminal" });
  return new Promise((resolve) => {
    let out = "";
    let done = false;
    const file = path.join(os.tmpdir(), `aither-tui-answer-${process.pid}-${Date.now()}.ps1`);
    const finish = (v) => {
      if (done) return;
      done = true;
      try { fs.rmSync(file, { force: true }); } catch { /* temp */ }
      resolve(v);
    };
    let child;
    try {
      fs.writeFileSync(file, typeScript(), "utf8");
      child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", file],
        { windowsHide: true, stdio: ["pipe", "pipe", "ignore"] });
    } catch (error) {
      finish({ ok: false, typed: false, error: String((error && error.message) || error) });
      return;
    }
    const timer = setTimeout(() => { try { child.kill(); } catch { /* gone */ } finish({ ok: false, typed: false, error: "the tab search timed out" }); }, timeoutMs);
    if (timer.unref) timer.unref();
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (d) => { out += d; });
    child.on("error", (e) => finish({ ok: false, typed: false, error: String((e && e.message) || e) }));
    child.on("close", () => {
      clearTimeout(timer);
      const line = out.trim().split(/\r?\n/).pop() || "";
      try {
        const v = JSON.parse(line);
        // typed is never true: no keystroke is sent (see the header).
        finish({ ok: v.ok === true, typed: false, tab: v.tab, error: v.error });
      } catch {
        finish({ ok: false, typed: false, error: "the tab search gave no answer" });
      }
    });
    try { child.stdin.end(`${name}\n${k}\n`); } catch { /* close reports */ }
  });
}

/**
 * The whole answer: type into the terminal, and only when that is confirmed record
 * the answer on the card. A failure records nothing (the session is still blocked,
 * so the card must stay) and carries the flash text for the surface.
 *
 * deps: { sessionName(card) -> string, type(name, keys), record(id, key, note) -> truthy }
 */
async function answerInTerminal(card, key, deps) {
  const action = tuiAction(card, key);
  if (!action) return { ok: false, handled: false };
  const names = await Promise.resolve()
    .then(() => deps.sessionName(card))
    .then((n) => sessionNames(n), () => []);
  const name = names.length > 1 ? names : (names[0] || "");
  let r;
  try { r = await deps.type(name, action.keys); } catch (e) { r = { ok: false, error: String((e && e.message) || e) }; }
  if (!r || r.ok !== true) {
    const error = (r && r.error) || "focus failed";
    return { ok: false, handled: true, flash: flashFor(error, names[0] || ""), error };
  }
  if (action.keys) {
    // A number button: the session is now in front, but nothing reached it. The
    // card stays open (it closes when the owner answers in the terminal).
    return { ok: false, handled: true, typed: false, flash: FLASH_IN_FRONT, tab: r.tab || name, error: "answer it in the session" };
  }
  const recorded = Boolean(deps.record(card.id, key, "opened the session to answer there"));
  return { ok: true, handled: true, typed: false, recorded, tab: r.tab || name };
}

module.exports = { TUI_KEY_RE, FLASH_OPEN_SESSION, FLASH_IN_FRONT, tuiAction, raiseLines, typeScript, sessionNames, flashFor, typeIntoSession, answerInTerminal };
