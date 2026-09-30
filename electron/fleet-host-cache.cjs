"use strict";

/**
 * fleet-host-cache.cjs -- the fleet HOST summary for read-only surfaces.
 *
 * AitherOS/dev/tools/fleet_host.py writes ~/.aither/fleet-host-status.json on
 * every `status` (the Fleet window's "Host status", `adk fleet-host status`,
 * awnode's fleet_host_status). The Living Desktop overlay's desk-state snapshot
 * carries it from here, so the overlay shows the host without ever spawning
 * wsl.exe (every extra wsl.exe client is one more thing that can relaunch a
 * distro a migration just stopped). Older than MAX_AGE_S = not reported: a stale
 * verdict must not read as the current one.
 */

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const MAX_AGE_S = 900;
const FIELDS = Object.freeze(["distro", "distro_source", "verdict", "state", "systemd",
  "containers_running", "problems", "warnings", "checked_at"]);

function cachePath(env = process.env) {
  const home = env.AITHER_HOME || path.join(os.homedir(), ".aither");
  return path.join(home, "fleet-host-status.json");
}

/** The cached summary (with its age), or null when absent, unreadable or stale. */
function readFleetHostSummary({ env = process.env, nowMs = Date.now() } = {}) {
  let doc;
  try {
    doc = JSON.parse(fs.readFileSync(cachePath(env), "utf8"));
  } catch {
    return null;
  }
  if (!doc || typeof doc !== "object") return null;
  const ageS = nowMs / 1000 - Number(doc.checked_epoch || 0);
  if (!(ageS >= 0 && ageS <= MAX_AGE_S)) return null;
  const out = { age_s: Math.round(ageS) };
  for (const k of FIELDS) out[k] = doc[k] ?? null;
  return out;
}

/** One line for a tooltip / overlay chip. */
function fleetHostLine(summary) {
  if (!summary) return "Fleet host: not checked recently";
  const bits = [`${summary.distro || "?"}`, summary.verdict || "?"];
  if (summary.containers_running != null) bits.push(`${summary.containers_running} containers`);
  return `Fleet host: ${bits.join(" · ")} (${summary.age_s}s ago)`;
}

module.exports = { MAX_AGE_S, cachePath, readFleetHostSummary, fleetHostLine };
