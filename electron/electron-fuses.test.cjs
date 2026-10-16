"use strict";

/**
 * The released Desk is a locked binary: a child (or anyone on the box) cannot turn it into
 * a Node shell or attach a debugger to the main process. electron-builder flips Electron's
 * fuses on the packaged executable from package.json build.electronFuses; the NSIS
 * installer is per-machine so a standard account cannot swap in its own unfused copy.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
const build = pkg.build || {};

const major = (range) => Number(String(range || "").replace(/^[^\d]*/, "").split(".")[0]);

test("the packaged Desk is built with the Node doors fused shut", () => {
  const fuses = build.electronFuses;
  assert.ok(fuses && typeof fuses === "object", "build.electronFuses is set");
  assert.equal(fuses.runAsNode, false, "ELECTRON_RUN_AS_NODE=1 Desk.exe must not be a node shell");
  assert.equal(fuses.enableNodeOptionsEnvironmentVariable, false, "NODE_OPTIONS (--require, --inspect) ignored");
  assert.equal(fuses.enableNodeCliInspectArguments, false, "Desk.exe --inspect=<port> ignored");
  assert.equal(fuses.enableEmbeddedAsarIntegrityValidation, true, "a tampered app.asar refuses to load");
  assert.equal(fuses.onlyLoadAppFromAsar, true, "no resources/app folder beside the asar is loaded");
  assert.equal(fuses.enableCookieEncryption, true, "cookies (the classroom sign-in) encrypted at rest");
  assert.equal(build.asar, true, "integrity validation needs the app in an asar");
});

test("the toolchain honours those fuses", () => {
  // electronFuses is an electron-builder >= 25 key; Windows asar integrity needs Electron >= 30.
  assert.ok(major(pkg.devDependencies["electron-builder"]) >= 25, pkg.devDependencies["electron-builder"]);
  assert.ok(major(pkg.devDependencies.electron) >= 30, pkg.devDependencies.electron);
});

test("Windows installs per machine, so a child account cannot replace Desk", () => {
  assert.equal(build.nsis && build.nsis.perMachine, true);
});

test("nothing in the packaged app relies on RunAsNode", () => {
  // The only ELECTRON_RUN_AS_NODE user is the awnix fleet brain, which runs the npm
  // electron binary from node_modules (never the fused, packaged Desk); local-node and
  // local-stack name it only to DROP it from a child's environment; kid-launch-guard
  // names it to refuse it.
  const allowed = new Set(["brain.cjs", "local-node.cjs", "local-stack.cjs", "kid-launch-guard.cjs"]);
  const dir = path.join(ROOT, "electron");
  const sources = fs.readdirSync(dir).filter((f) => f.endsWith(".cjs") && !f.endsWith(".test.cjs"));
  const users = sources.filter((f) => fs.readFileSync(path.join(dir, f), "utf8").includes("ELECTRON_RUN_AS_NODE"));
  assert.deepEqual(users.filter((f) => !allowed.has(f)), []);
  const unit = fs.readFileSync(path.join(ROOT, "scripts", "awnix", "aither-awdesk-brain.service"), "utf8");
  assert.match(unit, /^ExecStart=\/opt\/aitheros\/awdesk\/node_modules\/electron\/dist\/electron /m,
    "the brain runs the unfused npm electron, not a packaged Desk");
  // No module fork()s a script through the Desk executable as node.
  for (const f of sources) {
    const src = fs.readFileSync(path.join(dir, f), "utf8");
    assert.doesNotMatch(src, /\.fork\(/, `${f} forks a node child (use utilityProcess.fork)`);
  }
});
