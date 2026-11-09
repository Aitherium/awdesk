// The restart cap means "cool down, then come back", never "stay down" (2026-11-09:
// Desk hit the cap at 13:51, quit, and stayed dark until a human noticed).
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

test("the helper runs as Node; the relaunched app does not inherit ELECTRON_RUN_AS_NODE", () => {
  const spec = delayedRelaunchSpec({ execPath: "/x/electron", args: ["."], delayMs: 5, env: { A: "1" }, cwd: "/desk" });
  assert.equal(spec.command, "/x/electron");
  assert.equal(spec.env.ELECTRON_RUN_AS_NODE, "1");
  assert.equal(spec.args[0], "-e");
  assert.match(spec.args[1], /delete e\.ELECTRON_RUN_AS_NODE/);
  assert.match(spec.args[1], /"\/desk"/);
  assert.ok(spec.args[1].length < 2000, "the env is never inlined into the command line");
});

test("the helper really starts the target after the delay, detached from its parent", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "desk-cooldown-"));
  const marker = path.join(dir, "started.json");
  const target = path.join(dir, "target.js");
  fs.writeFileSync(target, `require("fs").writeFileSync(${JSON.stringify(marker)}, `
    + `JSON.stringify({ runAsNode: process.env.ELECTRON_RUN_AS_NODE || null, cwd: process.cwd() }));`);
  // execPath is Node here, so the "app" is Node running target.js.
  const spec = delayedRelaunchSpec({ execPath: process.execPath, args: [target], delayMs: 300, cwd: dir });
  const helper = spawn(spec.command, spec.args, { env: spec.env, stdio: "ignore" });
  assert.equal(fs.existsSync(marker), false, "nothing starts before the delay");
  const deadline = Date.now() + 10_000;
  while (!fs.existsSync(marker) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
  helper.kill();
  const seen = JSON.parse(fs.readFileSync(marker, "utf8"));
  assert.equal(seen.runAsNode, null);
  assert.equal(fs.realpathSync(seen.cwd), fs.realpathSync(dir));
});

test("a failing spawn never throws out of the quit path", () => {
  const ok = relaunchAfterCooldown({ execPath: "x", args: [], spawn: () => { throw new Error("nope"); } });
  assert.equal(ok, false);
});
