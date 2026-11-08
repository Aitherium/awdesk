"use strict";

/**
 * private-reveal -- show search results that are hidden by default, briefly, after
 * the owner proves it is them.
 *
 * Owner, 2026-11-06: "should be like an ability to manual override and show
 * 'hidden' or 'private' stuff temporarily, maybe integration with Lockbox".
 *
 * search-exclusions.cjs hides game and adult titles by default, so the launcher
 * is safe to open while screen-sharing. This is the deliberate way back: type
 * `!private` (or pick "Show hidden results") and the desk asks for the SAME
 * proof the owner's Lockbox vault uses on this machine -- Windows Hello (face,
 * fingerprint or PIN) or Touch ID -- then shows everything for five minutes.
 *
 * Three rules:
 *  - The window is SHORT and self-closing (5 min), and it closes early when the
 *    session locks. A reveal that outlives the moment is just "exclusions off".
 *  - No proof available is a REFUSAL, never a silent reveal. A machine with no
 *    Hello/Touch ID set up says so instead of opening the list anyway.
 *  - Nothing is written to disk. The reveal lives in this process only, so a
 *    restart, a crash or a second user's session starts hidden again.
 */

const { execFile } = require("node:child_process");

const REVEAL_MS = 5 * 60 * 1000;
const VERIFY_TIMEOUT_MS = 60 * 1000;

// Windows.Security.Credentials.UI.UserConsentVerifier -- the real Windows Hello
// prompt (face / fingerprint / PIN). PowerShell 5.1 can await a WinRT call through
// AsTask; the result is one of Verified, DeviceNotPresent, NotConfiguredForUser,
// DisabledByPolicy, DeviceBusy, RetriesExhausted, Canceled.
const WINDOWS_HELLO_SCRIPT = `
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Add-Type -AssemblyName System.Runtime.WindowsRuntime
$asTask = [System.WindowsRuntimeSystemExtensions].GetMethods() |
  Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation\`1' } |
  Select-Object -First 1
function Await($op, [Type]$type) {
  $task = $asTask.MakeGenericMethod($type).Invoke($null, @($op))
  $task.Wait() | Out-Null
  $task.Result
}
$verifier = [Windows.Security.Credentials.UI.UserConsentVerifier, Windows.Security.Credentials.UI, ContentType = WindowsRuntime]
$available = Await ($verifier::CheckAvailabilityAsync()) ([Windows.Security.Credentials.UI.UserConsentVerifierAvailability])
if ($available -ne 'Available') { Write-Output "UNAVAILABLE:$available"; exit 0 }
$result = Await ($verifier::RequestVerificationAsync('Aither: show hidden search results for 5 minutes')) ([Windows.Security.Credentials.UI.UserConsentVerificationResult])
Write-Output "RESULT:$result"
`;

/** Parse the Hello helper's one line into {ok, reason}. Pure. */
function parseHello(stdout) {
  const line = String(stdout || "").trim().split(/\r?\n/).pop() || "";
  if (line === "RESULT:Verified") return { ok: true, reason: "verified with Windows Hello" };
  if (line.startsWith("UNAVAILABLE:")) {
    return { ok: false, reason: `Windows Hello is not set up here (${line.slice(12) || "unavailable"})` };
  }
  if (line.startsWith("RESULT:")) {
    const why = line.slice(7);
    return { ok: false, reason: why === "Canceled" ? "cancelled" : `not verified (${why})` };
  }
  return { ok: false, reason: "could not reach Windows Hello" };
}

function verifyWindows({ run = execFile, timeoutMs = VERIFY_TIMEOUT_MS } = {}) {
  return new Promise((resolve) => {
    run(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", WINDOWS_HELLO_SCRIPT],
      { timeout: timeoutMs, windowsHide: true },
      (error, stdout) => resolve(error && !stdout ? { ok: false, reason: "could not reach Windows Hello" } : parseHello(stdout)),
    );
  });
}

async function verifyMac(systemPreferences) {
  if (!systemPreferences || typeof systemPreferences.canPromptTouchID !== "function" || !systemPreferences.canPromptTouchID()) {
    return { ok: false, reason: "Touch ID is not available here" };
  }
  try {
    await systemPreferences.promptTouchID("show hidden search results for 5 minutes");
    return { ok: true, reason: "verified with Touch ID" };
  } catch {
    return { ok: false, reason: "cancelled" };
  }
}

/**
 * One reveal state per desk process.
 *
 * @param {{platform?: string, verify?: () => Promise<{ok:boolean, reason:string}>,
 *          now?: () => number, systemPreferences?: object}} [opts]
 */
/**
 * Re-auth with the Aitherium sign-in (the identity the owner's Lockbox sits
 * behind). `prompt=login` makes the IdP ask again even with a live session, so a
 * cookie left in the browser is not proof. The signed-in account must be the one
 * that owns this desk: someone else's login opens nothing.
 */
async function verifyIdp({ signIn, expectUser }) {
  if (typeof signIn !== "function") return { ok: false, reason: "Aitherium sign-in is not available" };
  try {
    const out = await signIn({ prompt: "login" });
    const claims = (out && out.claims) || {};
    const who = String(claims.preferred_username || claims.username || claims.sub || "").toLowerCase();
    const want = String(expectUser || "").toLowerCase();
    if (!who) return { ok: false, reason: "sign-in returned no account" };
    if (want && who !== want) return { ok: false, reason: `signed in as ${who}, not this desk's owner` };
    return { ok: true, reason: `verified by signing in as ${who}` };
  } catch (error) {
    return { ok: false, reason: `sign-in did not finish (${String((error && error.message) || error).slice(0, 80)})` };
  }
}

function createPrivateReveal({
  platform = process.platform, verify = null, now = Date.now, systemPreferences = null,
  // () => Promise<{claims}>: desk-oidc signInLoopback, used when the device check
  // cannot run (no Windows Hello set up -- measured on the owner's PC 2026-11-06:
  // DeviceNotPresent). The device check stays first: it is faster and never leaves
  // the machine.
  signIn = null, expectUser = "",
} = {}) {
  let until = 0;

  const device = platform === "win32" ? () => verifyWindows()
    : platform === "darwin" ? () => verifyMac(systemPreferences)
      : async () => ({ ok: false, reason: "no device check on this system" });

  const prove = verify || (async () => {
    const first = await device();
    if (first.ok) return first;
    // Only fall back when the device CAN'T check, never when the owner cancelled
    // or failed it -- a cancelled face scan is a "no", not "try another way".
    const unavailable = /not set up|not available|no device check|could not reach/.test(first.reason || "");
    if (!unavailable || !signIn) return first;
    return verifyIdp({ signIn, expectUser });
  });

  return {
    /** True while hidden results are being shown. */
    active: () => now() < until,
    /** ms left, 0 when hidden. */
    remainingMs: () => Math.max(0, until - now()),
    /** Ask for proof; open the window only when it is real. */
    async unlock() {
      if (now() < until) return { ok: true, reason: "already showing hidden results", remainingMs: until - now() };
      const verdict = await prove();
      if (!verdict || !verdict.ok) return { ok: false, reason: (verdict && verdict.reason) || "not verified" };
      until = now() + REVEAL_MS;
      return { ok: true, reason: verdict.reason, remainingMs: REVEAL_MS };
    },
    /** Hide again now (the session locked, or the owner chose to). */
    lock() { until = 0; return { ok: true }; },
  };
}

// One reveal per desk process: search and the launcher read the same window.
let shared = null;
function sharedReveal(opts) {
  if (!shared) shared = createPrivateReveal(opts);
  return shared;
}

module.exports = { REVEAL_MS, WINDOWS_HELLO_SCRIPT, parseHello, verifyIdp, createPrivateReveal, sharedReveal };
