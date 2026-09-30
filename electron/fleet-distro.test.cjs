"use strict";

// node --test fleet-distro.test.cjs -- the Node twin of the fleet-host transport.
// Cross-language parity (same fixtures as Python/PowerShell/shell) lives in
// AitherOS/dev/tests/test_fleet_distro_resolvers.py; this pins the Node API itself.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const fd = require("./fleet-distro.cjs");

function nodesFile(text) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-distro-"));
  const p = path.join(dir, "nodes.yaml");
  fs.writeFileSync(p, text, "utf8");
  return p;
}

const NODES = [
  "nodes:",
  "  local:",
  "    fleet_transport: machine:wrong",
  "  debian-fleet:",
  "    fleet_distro: awnix-x",
  "    fleet_transport: ssh:core@fleet   # c",
  "    host_roots:",
  "      fleet_transport: local",
  "",
].join("\n");

test("env transport beats nodes.yaml; nodes.yaml beats the platform", () => {
  const p = nodesFile(NODES);
  assert.equal(fd.resolveFleetHost({ AITHER_FLEET_TRANSPORT: "local" }, p, "win32").spec, "local");
  const h = fd.resolveFleetHost({}, p, "win32");
  assert.deepEqual([h.spec, h.source], ["ssh:core@fleet", "nodes.yaml"]);
});

test("bare wsl takes the distro rule; auto falls through to the platform", () => {
  const p = nodesFile(NODES);
  assert.equal(fd.resolveFleetHost({ AITHER_FLEET_TRANSPORT: "wsl" }, p, "win32").spec, "wsl:awnix-x");
  const auto = nodesFile("nodes:\n  debian-fleet:\n    fleet_transport: auto\n");
  const h = fd.resolveFleetHost({}, auto, "win32");
  assert.deepEqual([h.spec, h.source], ["wsl:awnix", "platform:win32"]);
  assert.equal(fd.resolveFleetHost({}, auto, "darwin").spec, "machine:podman-machine-default");
  assert.throws(() => fd.resolveFleetHost({}, auto, "aix"), fd.FleetHostUnresolved);
});

test("a nested fleet_transport is never read as the node's own key", () => {
  const p = nodesFile("nodes:\n  debian-fleet:\n    host_roots:\n      fleet_transport: local\n");
  assert.equal(fd.readNodesValue("fleet_transport", p), null);
  assert.equal(fd.readNodesValue("host_roots.fleet_transport", p), "local");
});

test("invalid values refuse instead of guessing", () => {
  for (const bad of ["wls", "ssh:", "ssh:-oProxyCommand=x", "local:x", "wsl:a b"]) {
    assert.throws(() => fd.resolveFleetHost({ AITHER_FLEET_TRANSPORT: bad }, "/nonexistent", "win32"),
      fd.FleetHostUnresolved, bad);
  }
});

test("argv shapes: wsl --exec keeps argv; ssh/machine get one quoted string", () => {
  const cmd = ["podman", "ps", "--format", "{{.Names}} it's"];
  const wsl = { kind: "wsl", target: "awnix" };
  assert.deepEqual(fd.fleetArgv(cmd, { host: wsl }),
    ["wsl.exe", "-d", "awnix", "-u", "root", "--exec", ...cmd]);
  assert.deepEqual(fd.fleetArgv(cmd, { host: { kind: "ssh", target: "core@h" } }),
    ["ssh", "-o", "BatchMode=yes", "core@h", "--",
      "sudo -n podman ps --format '{{.Names}} it'\"'\"'s'"]);
  assert.deepEqual(fd.fleetArgv(["true"], { host: { kind: "ssh", target: "root@h" } }).slice(-1), ["true"]);
  assert.deepEqual(fd.fleetScriptArgv(["a"], { host: { kind: "machine", target: "m1" } }),
    ["podman", "machine", "ssh", "m1", "--", "sudo -n bash -s -- a"]);
  assert.deepEqual(fd.fleetPodmanArgv(["info"], { host: wsl }).slice(-2), ["podman", "info"]);
});
