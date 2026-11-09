// The restart cap means "cool down, then come back", never "stay down" (2026-11-09:
// Desk hit the cap at 13:51, quit, and stayed dark until a human noticed). The helper
// is the OS shell, never the Desk binary as Node (the packaged RunAsNode fuse is off).
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { delayedRelaunchSpec, relaunchAfterCooldown, COOLDOWN_RELAUNCH_MS } = require("./resource-watchdog.cjs");

test("the cooldown is minutes, not instant (no relaunch loop)", () => {
  assert.ok(COOLDOWN_RELAUNCH_MS >= 5 * 60_000);
});

test("the helper is the OS shell, never the Desk binary", () => {
  const win = delayedRelaunchSpec({ execPath: "C:/Desk/Aither's.exe", args: ["."], delayMs: 600_000,
    cwd: "C:/Desk", platform: "win32" });
  assert.equal(win.command, "powershell.exe");
  const cmd = win.args[win.args.length - 1];
  assert.ok(cmd.startsWith("Start-Sleep -Seconds 600; Start-Process -FilePath 'C:/Desk/Aither''s.exe'"), cmd);
  assert.ok(cmd.endsWith("-ArgumentList @('.') -WorkingDirectory 'C:/Desk'"), cmd);
  const nix = delayedRelaunchSpec({ execPath: "/opt/desk/aither", args: ["--x"], delayMs: 600_000,
    cwd: "/opt/desk", platform: "linux" });
  assert.equal(nix.command, "/bin/sh");
  assert.deepEqual(nix.args, ["-c", 'sleep 600; exec "$0" "$@"', "/opt/desk/aither", "--x"]);
});

test("the helper really starts the target after the delay, in the given cwd", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "desk-cooldown-"));
  const marker = path.join(dir, "started.json");
  const target = path.join(dir, "target.js");
  fs.writeFileSync(target, `require("fs").writeFileSync(${JSON.stringify(marker)}, JSON.stringify({ cwd: process.cwd() }));`);
  const spec = delayedRelaunchSpec({ execPath: process.execPath, args: [target], delayMs: 1000, cwd: dir });
  const started = Date.now();
  const helper = spawn(spec.command, spec.args, { cwd: spec.cwd, stdio: "ignore", windowsHide: true });
  const deadline = Date.now() + 30_000;
  while (!fs.existsSync(marker) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
  try { helper.kill(); } catch { /* already gone */ }
  assert.ok(fs.existsSync(marker), "the helper never started the target");
  assert.ok(Date.now() - started >= 900, "the target started before the delay");
  const seen = JSON.parse(fs.readFileSync(marker, "utf8"));
  assert.equal(fs.realpathSync(seen.cwd), fs.realpathSync(dir));
});

test("a failing spawn never throws out of the quit path", () => {
  const ok = relaunchAfterCooldown({ execPath: "x", args: [], spawn: () => { throw new Error("nope"); } });
  assert.equal(ok, false);
});
