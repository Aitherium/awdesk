"use strict";
// Invariants of the awnix (WSLg) deployment files in scripts/awnix/. Each one is a
// failure that was measured while bringing the desk up on the fleet host on
// 2026-09-27; this pins them without needing a Linux host or a display.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const DIR = path.join(__dirname, "awnix");
const read = (name) => fs.readFileSync(path.join(DIR, name), "utf8");

const SHELL_FILES = ["awdesk-awnix-launch.sh", "awdesk-awnix-open.sh", "install-awdesk-awnix.sh", "aitherdesktop-awnix.sh"];

test("no CR byte in anything the distro executes or systemd parses", () => {
  for (const name of [...SHELL_FILES, "aither-awdesk.service", "aither-awdesk-brain.service", "aither-awdesk.desktop"]) {
    assert.ok(!read(name).includes("\r"), `${name} has a CR byte (exec format error / misparsed directive)`);
  }
});

test("the unit runs the staged launcher, pins HOME, and does not crash-loop on no display", () => {
  const unit = read("aither-awdesk.service");
  assert.match(unit, /^ExecStart=\/bin\/sh \/opt\/aitheros\/awdesk\/scripts\/awnix\/awdesk-awnix-launch\.sh/m);
  // Without HOME the unit's userData differed from a hand launch, so the taskbar
  // click found no SingletonLock and started a second desk.
  assert.match(unit, /^Environment=HOME=\/root$/m);
  assert.match(unit, /^Environment=AWDESK_FLEET_LOCAL=1$/m);
  // exit 2 = no WSLg display / no install: restarting cannot fix it.
  assert.match(unit, /^RestartPreventExitStatus=2$/m);
  assert.match(unit, /^ConditionPathExists=\/mnt\/wslg$/m);
});

test("the awnix desk does not take 47931 while the Windows desk (the fallback) holds it", () => {
  const port = /^Environment=DESK_BRIDGE_PORT=(\d+)$/m.exec(read("aither-awdesk.service"));
  assert.ok(port, "unit must set DESK_BRIDGE_PORT explicitly");
  assert.notEqual(port[1], "47931");
  assert.notEqual(port[1], "48931", "48931 is the headless brain's");
  assert.match(read("awdesk-awnix-launch.sh"), /DESK_BRIDGE_PORT="\$\{DESK_BRIDGE_PORT:-47951\}"/);
});

test("nothing lives under a path the fleet-data attach bind-mounts over (/var/lib/aither, /etc/aither)", () => {
  for (const name of ["awdesk-awnix-launch.sh", "install-awdesk-awnix.sh", "aither-awdesk.service", "aither-awdesk-brain.service"]) {
    assert.doesNotMatch(read(name).replace(/^#.*$/gm, ""), /\/var\/lib\/aither\/|\/etc\/aither\//, name);
  }
});

test("the .desktop entry (mirrored into the Windows Start menu by WSLg) goes through the open script", () => {
  const entry = read("aither-awdesk.desktop");
  assert.match(entry, /^Exec=\/bin\/sh \/opt\/aitheros\/awdesk\/scripts\/awnix\/awdesk-awnix-open\.sh/m);
  assert.match(entry, /^StartupWMClass=desk$/m);
});

test("the installer does not enable the unit unless asked (the Windows desk stays primary)", () => {
  const inst = read("install-awdesk-awnix.sh");
  assert.match(inst, /^ENABLE=0$/m);
  assert.match(inst, /--enable\) ENABLE=1/);
});

test("the brain unit is headless: no display, no WSLg condition, in-host fleet, 48931", () => {
  const unit = read("aither-awdesk-brain.service");
  assert.match(unit, /^ExecStart=\/opt\/aitheros\/awdesk\/node_modules\/electron\/dist\/electron \/opt\/aitheros\/awdesk\/electron\/brain\.cjs$/m);
  assert.match(unit, /^Environment=ELECTRON_RUN_AS_NODE=1$/m);
  assert.match(unit, /^Environment=AWDESK_FLEET_LOCAL=1$/m);
  assert.match(unit, /^Environment=DESK_BRIDGE_PORT=48931$/m);
  assert.doesNotMatch(unit.replace(/^#.*$/gm, ""), /DISPLAY|wslg/i, "the brain must not depend on WSLg");
  assert.match(unit, /^WantedBy=multi-user.target$/m);
  assert.match(read("aither-awdesk.service"), /^Conflicts=aither-awdesk-brain.service$/m, "one fleet brain per host");
});

test("the brain port stays out of the game bridge's 47940-47949 scan range", () => {
  const port = Number(/^Environment=DESK_BRIDGE_PORT=(\d+)$/m.exec(read("aither-awdesk-brain.service"))[1]);
  assert.ok(port < 47940 || port > 47949, `brain port ${port} collides with game_bridge serve`);
  const { DEFAULT_BRAIN_URL } = require("../electron/fleet-control.cjs");
  assert.equal(new URL(DEFAULT_BRAIN_URL).port, String(port), "the Windows desk's default must point at the brain unit's port");
});
