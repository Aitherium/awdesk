"use strict";

/** Kid mode refuses a launch that opened a debug door (defence in depth over the fuses). */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const g = require("./kid-launch-guard.cjs");

const ON = { enabled: true };
const OFF = { enabled: false };
const EXE = "C:\\Program Files\\Aither\\Desk.exe";

test("a clean kid launch carries on", () => {
  assert.deepEqual(g.openDoors(ON, { argv: [EXE, "desk://open", "--updated"], vars: { PATH: "x" } }), []);
  assert.deepEqual(g.openDoors(ON, { argv: [EXE, "--inspector-panel"], vars: { NODE_OPTIONS: "" } }), [],
    "a lookalike name and an EMPTY NODE_OPTIONS are not doors");
});

test("every Node / Chromium debug switch spelling is a door in kid mode", () => {
  const cases = [
    ["--inspect", "--inspect"], ["--inspect=9229", "--inspect"], ["--inspect-brk=0.0.0.0:1", "--inspect-brk"],
    ["--inspect-port=9229", "--inspect-port"], ["--INSPECT", "--inspect"],
    ["--remote-debugging-port=9222", "--remote-debugging-port"], ["-remote-debugging-pipe", "--remote-debugging-pipe"],
    ["/remote-debugging-port=1", "--remote-debugging-port"], ["--js-flags=--allow-natives-syntax", "--js-flags"],
  ];
  for (const [arg, door] of cases) {
    assert.deepEqual(g.openDoors(ON, { argv: [EXE, arg] }), [door], arg);
  }
});

test("ELECTRON_RUN_AS_NODE, NODE_OPTIONS (any case) and a live inspector are doors", () => {
  assert.deepEqual(g.openDoors(ON, { argv: [EXE], vars: { ELECTRON_RUN_AS_NODE: "1" } }), ["ELECTRON_RUN_AS_NODE"]);
  assert.deepEqual(g.openDoors(ON, { argv: [EXE], vars: { node_options: "--require x.js" } }), ["NODE_OPTIONS"]);
  assert.deepEqual(g.openDoors(ON, { argv: [EXE], inspectorUrl: "ws://127.0.0.1:9229/x" }), ["inspector"]);
});

test("outside kid mode the owner's diagnostics are untouched", () => {
  assert.deepEqual(g.openDoors(OFF, { argv: [EXE, "--inspect"], vars: { NODE_OPTIONS: "--inspect" },
    inspectorUrl: "ws://x" }), []);
  assert.deepEqual(g.openDoors(null, { argv: [EXE, "--inspect"] }), []);
});

test("refuseOpenDoors closes the inspector and exits 1; a clean launch does nothing", () => {
  const seen = [];
  const deps = { inspector: { close: () => seen.push("close") }, exit: (c) => seen.push(`exit ${c}`),
    log: (m) => seen.push(m) };
  assert.deepEqual(g.refuseOpenDoors(ON, { argv: [EXE, "--inspect-brk"] }, deps), ["--inspect-brk"]);
  assert.equal(seen[0], "close");
  assert.match(seen[1], /refusing to start with --inspect-brk/);
  assert.equal(seen[2], "exit 1");
  seen.length = 0;
  assert.deepEqual(g.refuseOpenDoors(ON, { argv: [EXE] }, deps), []);
  assert.deepEqual(g.refuseOpenDoors(OFF, { argv: [EXE, "--inspect"] }, deps), []);
  assert.deepEqual(seen, []);
});

test("main.cjs refuses the doors right after kid mode resolves, before any CDP door or window", () => {
  const src = fs.readFileSync(path.join(__dirname, "main.cjs"), "utf8");
  const resolved = src.indexOf("function kidDeskMode()");
  const guard = src.indexOf('require("./kid-launch-guard.cjs").refuseOpenDoors(kidDeskMode(), {');
  const scrub = src.indexOf("kidDesk.scrubDebugSwitches(kidDeskMode(), app.commandLine);");
  const ready = src.indexOf("app.whenReady(");
  assert.ok(resolved > 0 && guard > resolved && scrub > guard, "guard sits between resolve and the CDP scrub");
  assert.ok(ready < 0 || guard < ready, "guard runs before the app is ready");
  assert.match(src.slice(guard, guard + 300),
    /argv: process\.argv,\s*vars: process\.env,\s*inspectorUrl: require\("node:inspector"\)\.url\(\)/);
});
