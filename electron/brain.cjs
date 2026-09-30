"use strict";

/**
 * brain.cjs -- the HEADLESS awdesk: the fleet brain that runs ON the awnix host.
 *
 * Owner, 2026-09-27: switch the desk's fleet brain to awnix. The full desk under
 * WSLg was measured unfit (the WSLg RDP client restarted ~30x in 3 min once the
 * transparent always-on-top windows mapped; a second desk would also pop every
 * decision card twice). So this entry keeps ONLY the parts that belong on the
 * fleet host:
 *
 *   - the loopback bridge (GET /health, GET /fleet/status, POST /fleet/<verb>)
 *   - the MCP endpoint (/mcp) with get_status, fleet_status, fleet_control
 *   - FleetControl in in-host mode (AWDESK_FLEET_LOCAL=1: `sh -c`, no wsl.exe)
 *
 * and NOTHING else: no Electron window, no display, no decision-card polling,
 * no avatar, no voice, no room stage. It runs under plain Node (or Electron with
 * ELECTRON_RUN_AS_NODE=1, which is what aither-awdesk-brain.service does, so the
 * Node version is the desk's own).
 *
 * The Windows desk (D:\desk) keeps the overlay and the cards and sends its fleet
 * verbs here first (fleet-control.cjs `brainUrl`), falling back to its own wsl.exe
 * hop when this process is down.
 *
 *   ELECTRON_RUN_AS_NODE=1 electron electron/brain.cjs        # port DESK_BRIDGE_PORT or 48931
 */

const fs = require("node:fs");
const { createBridgeServer, readBridgeToken } = require("./bridge-server.cjs");
const { createDeskMcpHandler } = require("./mcp-server.cjs");
const { FleetControl, ACTIONS, summarize } = require("./fleet-control.cjs");

const BRAIN_DEFAULT_PORT = 48931;
const NO_WINDOW = "the awnix fleet brain is headless: no windows, no avatar (use the Windows desk)";

/** The bridge bearer. Same order as the desk (AITHER_HARNESS_TOKEN, then
 *  ~/.aither/harness_token), plus AWDESK_BRIDGE_TOKEN_FILE: the brain runs as
 *  root inside awnix, and the Windows desk that calls it holds the token in the
 *  WINDOWS profile, so the unit points this at /mnt/c/Users/<you>/.aither/harness_token.
 *  No token = mutating fleet verbs answer 503 (fail closed) and the Windows
 *  desk falls back to its local path. */
function resolveBrainToken({ env = process.env, readFile = fs.readFileSync, home = undefined } = {}) {
  const direct = readBridgeToken(home === undefined ? { env } : { env, home });
  if (direct) return direct;
  const file = String(env.AWDESK_BRIDGE_TOKEN_FILE || "").trim();
  if (!file) return null;
  try {
    return readFile(file, "utf8").trim() || null;
  } catch {
    return null;
  }
}

/** The fleet door, identical in shape to main.cjs's fleetAction minus windows. */
function createBrainFleetAction(control) {
  return async function fleetAction(action, { fresh = false } = {}) {
    if (action === "open_panel" || action === "open") {
      return { ok: false, error: NO_WINDOW };
    }
    if (action === "status") {
      const verdict = await control.status(fresh ? { maxAgeMs: 0 } : {});
      return { ...verdict, summary: summarize(verdict) };
    }
    if (!Object.prototype.hasOwnProperty.call(ACTIONS, action)) {
      return { ok: false, unknown: true, error: `unknown fleet action "${action}"` };
    }
    return control.run(action);
  };
}

/** The MCP controller: fleet tools real, window/avatar tools answer a plain refusal. */
function createBrainController({ control, fleetAction, startedAt = Date.now(), port }) {
  return {
    onAnimation: async () => false,
    onWindowAction: async () => {
      throw new Error(NO_WINDOW);
    },
    getStatus: async () => ({
      headless: true,
      role: "awnix-fleet-brain",
      pid: process.pid,
      port,
      uptime_s: Math.round((Date.now() - startedAt) / 1000),
      fleet_busy: control.busy,
      last_status_at: control.lastStatusAt || null,
    }),
    onFleet: fleetAction,
  };
}

function startBrain({ env = process.env, port } = {}) {
  const listenPort = Number(port ?? (env.DESK_BRIDGE_PORT || BRAIN_DEFAULT_PORT));
  // Host VRAM holders are Windows counters (powershell.exe); from inside awnix
  // that probe can only fail, so it is off here -- the Windows desk enriches
  // the status it receives with its own.
  const control = new FleetControl({ gpuHolders: () => [], brainUrl: null });
  const fleetAction = createBrainFleetAction(control);
  const controller = createBrainController({ control, fleetAction, port: listenPort });
  const bridge = createBridgeServer({
    port: listenPort,
    onEvent: () => {},
    mcpHandler: createDeskMcpHandler(controller),
    fleetHandler: (verb, { fresh = false } = {}) => fleetAction(verb, { fresh }),
    bridgeToken: resolveBrainToken({ env }),
  });
  control.on("progress", (p) => {
    if (p.phase !== "run") console.log(`[brain] ${p.line}`);
  });
  return { bridge, control, port: listenPort };
}

if (require.main === module) {
  if (process.env.AWDESK_FLEET_LOCAL !== "1") {
    console.error("[brain] AWDESK_FLEET_LOCAL is not 1: refusing to start a brain that would hop through wsl.exe");
    process.exit(2);
  }
  const { bridge, port } = startBrain();
  bridge.listen()
    .then(() => console.log(`[brain] awnix fleet brain listening on 127.0.0.1:${port} (headless)`))
    .catch((error) => {
      console.error(`[brain] could not listen on ${port}: ${error?.message || error}`);
      process.exit(1);
    });
  const stop = () => {
    bridge.close().catch(() => {}).finally(() => process.exit(0));
  };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
}

module.exports = {
  BRAIN_DEFAULT_PORT,
  createBrainController,
  createBrainFleetAction,
  resolveBrainToken,
  startBrain,
};
