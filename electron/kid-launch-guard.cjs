"use strict";

/**
 * kid-launch-guard -- in kid mode, refuse to run at all when the launch opened a debug door.
 *
 * The released Desk is built with Electron fuses off for RunAsNode, NODE_OPTIONS and the
 * Node --inspect switches (package.json build.electronFuses; asserted by
 * electron-fuses.test.cjs), so those doors are closed in the binary itself. This is the
 * second lock, and the only one on an unfused (dev or older) build: a child launching the
 * desk with
 *
 *   - a Node inspector switch (--inspect, --inspect-brk, --inspect-port, ...),
 *   - a Chromium debugging switch (--remote-debugging-port / -pipe / -address ...),
 *   - --js-flags (V8 flags, which reach the same inspector and allow-natives doors),
 *   - ELECTRON_RUN_AS_NODE or NODE_OPTIONS in the environment,
 *   - or an inspector that is already listening,
 *
 * could otherwise drive the main process (and through it, any window) anywhere. Chromium on
 * Windows accepts a switch spelled "--x", "-x" or "/x", so all three spellings count, in any
 * case. Outside kid mode nothing here applies: the owner's own diagnostics stay available.
 *
 * Pure: the caller passes argv, the environment and the inspector url (main.cjs passes
 * process.argv, process.env and require("node:inspector").url()). Kept apart from
 * kid-desk.cjs, which by contract reads no environment variable to decide kid mode.
 */

/** Switch names a kid launch may not carry (a prefix match covers -brk, -port, ...). */
const DOOR_SWITCH = /^(?:--?|\/)(inspect(?:-[a-z-]+)?|remote-debugging-[a-z-]+|js-flags)(?:[=:]|$)/i;
/** Environment variables a kid launch may not carry (non-empty). */
const DOOR_ENV = ["ELECTRON_RUN_AS_NODE", "NODE_OPTIONS"];

/**
 * The debug doors this launch opened, as short names ("--inspect-brk", "NODE_OPTIONS",
 * "inspector"). Empty outside kid mode, and empty for a clean kid launch.
 */
function openDoors(state, { argv = [], vars = {}, inspectorUrl = "" } = {}) {
  if (!(state && state.enabled)) return [];
  const doors = [];
  for (const arg of Array.isArray(argv) ? argv.slice(1) : []) {
    const m = DOOR_SWITCH.exec(String(arg || ""));
    if (m) doors.push("--" + m[1].toLowerCase());
  }
  const names = Object.keys(vars || {});
  for (const want of DOOR_ENV) {
    // Windows environment names are case-insensitive: "node_options" is the same variable.
    const hit = names.find((n) => n.toUpperCase() === want && String(vars[n] || "") !== "");
    if (hit) doors.push(want);
  }
  if (inspectorUrl) doors.push("inspector");
  return [...new Set(doors)];
}

/**
 * Kid mode with a door open: close the inspector, say why on stderr, exit 1 before any
 * window, bridge or MCP endpoint exists. Returns the doors (empty = carry on).
 * `deps` = { inspector, exit, log } so a test can pass fakes.
 */
function refuseOpenDoors(state, launch, deps = {}) {
  const doors = openDoors(state, launch);
  if (!doors.length) return doors;
  try { deps.inspector && deps.inspector.close(); } catch { /* not open */ }
  (deps.log || console.error)(`[desk] kid desk: refusing to start with ${doors.join(", ")} (a debug door)`);
  (deps.exit || ((code) => process.exit(code)))(1);
  return doors;
}

module.exports = { DOOR_ENV, DOOR_SWITCH, openDoors, refuseOpenDoors };
