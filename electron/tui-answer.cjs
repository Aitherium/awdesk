"use strict";
/**
 * Answer a Claude Code terminal ask from a card: focus the session's Windows
 * Terminal tab, CONFIRM it is the foreground window with that tab selected, then
 * type the option's number.
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
 * PowerShell (UI Automation): select the WT tab whose name matches stdin line 1,
 * raise its window, re-read the foreground window and the tab's selection state,
 * and only then SendKeys stdin line 2 (empty = focus only). One script, so the
 * check and the keystroke are milliseconds apart.
 */
function typeScript() {
  return [
    "$ErrorActionPreference = 'Stop'",
    "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8",
    "Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes, System.Windows.Forms",
    "Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public static class AitherTui { [DllImport(\"user32.dll\")] public static extern bool SetForegroundWindow(IntPtr h); [DllImport(\"user32.dll\")] public static extern IntPtr GetForegroundWindow(); [DllImport(\"user32.dll\")] public static extern bool ShowWindow(IntPtr h, int c); [DllImport(\"user32.dll\")] public static extern bool IsIconic(IntPtr h); }'",
    "$want = [Console]::In.ReadLine()",
    "$keys = [Console]::In.ReadLine()",
    "if ($null -eq $keys) { $keys = '' }",
    "if ($keys -notmatch '^[1-9]?$') { @{ ok = $false; typed = $false; error = 'refused: not an option number' } | ConvertTo-Json -Compress; exit 0 }",
    "function Norm([string]$s) { return ($s -replace '^[^\\p{L}\\p{N}]+', '' -replace '…$', '').Trim().ToLowerInvariant() }",
    "$w = Norm $want",
    "$root = [System.Windows.Automation.AutomationElement]::RootElement",
    "$cls = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ClassNameProperty, 'CASCADIA_HOSTING_WINDOW_CLASS')",
    "$tabCond = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ControlTypeProperty, [System.Windows.Automation.ControlType]::TabItem)",
    "$found = $null",
    "foreach ($win in $root.FindAll([System.Windows.Automation.TreeScope]::Children, $cls)) {",
    "  foreach ($tab in $win.FindAll([System.Windows.Automation.TreeScope]::Descendants, $tabCond)) {",
    "    $n = Norm $tab.Current.Name",
    "    if ($w.Length -ge 3 -and $n.Length -ge 3 -and ($n -eq $w -or $n.StartsWith($w) -or $w.StartsWith($n))) { $found = @($win, $tab); break }",
    "  }",
    "  if ($found) { break }",
    "}",
    "if (-not $found) { @{ ok = $false; typed = $false; error = 'no open terminal tab has that name' } | ConvertTo-Json -Compress; exit 0 }",
    "$sel = $found[1].GetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern)",
    "$sel.Select()",
    "$h = [IntPtr]$found[0].Current.NativeWindowHandle",
    "if ([AitherTui]::IsIconic($h)) { [void][AitherTui]::ShowWindow($h, 9) }",
    "[void][AitherTui]::SetForegroundWindow($h)",
    "Start-Sleep -Milliseconds 250",
    "$fg = [AitherTui]::GetForegroundWindow()",
    "$selected = $found[1].GetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern).Current.IsSelected",
    "if ($fg -ne $h -or -not $selected) { @{ ok = $false; typed = $false; error = 'could not confirm the session is in front' } | ConvertTo-Json -Compress; exit 0 }",
    "if ($keys) { [System.Windows.Forms.SendKeys]::SendWait($keys) }",
    "@{ ok = $true; typed = [bool]$keys; tab = $found[1].Current.Name } | ConvertTo-Json -Compress",
  ].join("\r\n");
}

/**
 * Focus the named session's tab and (when `keys` is a digit) type it.
 * Resolves {ok, typed, tab?, error?}; never rejects.
 */
function typeIntoSession(sessionName, keys, { spawn = require("node:child_process").spawn, timeoutMs = 15000, platform = process.platform } = {}) {
  const name = String(sessionName || "").trim();
  const k = String(keys || "");
  if (name.length < 3) return Promise.resolve({ ok: false, typed: false, error: "this session has no name to find its tab by" });
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
        finish({ ok: v.ok === true, typed: v.typed === true, tab: v.tab, error: v.error });
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
  const name = await Promise.resolve()
    .then(() => deps.sessionName(card))
    .then((n) => String(n || ""), () => "");
  let r;
  try { r = await deps.type(name, action.keys); } catch (e) { r = { ok: false, error: String((e && e.message) || e) }; }
  if (!r || r.ok !== true) {
    return { ok: false, handled: true, flash: FLASH_OPEN_SESSION, error: (r && r.error) || "focus failed" };
  }
  const note = action.keys ? `typed ${action.keys} into the terminal` : "opened the session to type an answer";
  const recorded = Boolean(deps.record(card.id, key, note));
  return { ok: true, handled: true, typed: Boolean(r.typed), recorded, tab: r.tab || name };
}

module.exports = { TUI_KEY_RE, FLASH_OPEN_SESSION, tuiAction, typeScript, typeIntoSession, answerInTerminal };
