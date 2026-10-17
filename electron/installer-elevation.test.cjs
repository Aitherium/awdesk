"use strict";

// The per-machine installer must START without administrator rights (2026-10-16).
// Every Desk up to 0.1.18 runs its downloaded update with a plain CreateProcess
// (desk-update.cjs runInstaller, no ShellExecute), and Windows refuses a
// requireAdministrator exe that way: `spawn ... EACCES` (ERROR_ELEVATION_REQUIRED),
// measured against the published 0.1.19 installer. No customer Desk could update.
// The built exe's manifest is asserted in build-awdesk.yml; this pins the source.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const nsh = fs.readFileSync(path.join(__dirname, "..", "build", "installer.nsh"), "utf8");
const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "package.json"), "utf8"));

function macro(name) {
  const at = nsh.indexOf(`!macro ${name}`);
  assert.ok(at >= 0, `installer.nsh defines ${name}`);
  return nsh.slice(at, nsh.indexOf("!macroend", at));
}

test("the installer exe is asInvoker, so a plain CreateProcess (Desk <= 0.1.18's updater) starts it", () => {
  assert.equal(pkg.build.nsis.perMachine, true, "still installs for all users (#13135)");
  const header = macro("customHeader");
  assert.match(header, /!ifndef BUILD_UNINSTALLER\s+RequestExecutionLevel user\s+!endif/);
});

test(".onInit raises the UAC prompt itself and hands back the elevated copy's exit code", () => {
  const init = macro("customInit");
  assert.match(init, /\$\{IfNot\} \$\{UAC_IsAdmin\}/);
  assert.match(init, /!insertmacro UAC_RunElevated/);
  assert.match(init, /SetErrorLevel \$2\s+Quit/, "exit code of the elevated install is passed back");
  assert.match(init, /SetErrorLevel \$0\s+Quit/, "a No at the prompt (1223) quits, changing nothing");
  // An inner copy that is still not admin must not loop back into UAC_RunElevated.
  const inner = init.slice(init.indexOf("${If} ${UAC_IsInnerInstance}"), init.indexOf("!insertmacro UAC_RunElevated"));
  assert.match(inner, /SetErrorLevel 740\s+Quit/);
});
