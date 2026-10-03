"use strict";

/**
 * kv-swarm — the phones lending memory to the owner's model, as Desk shows them.
 *
 * `adk kvholder workspace serve` (awdk) is the always-on relay that phones dial from
 * anywhere through the workspace KV relay host, each signed in as a workspace device. Every few
 * seconds it writes a snapshot to ~/.aither/kvholder/workspace.json: holders by device id,
 * the owner's grants, devices waiting for a yes, and whether identity answered. The file
 * carries no token by construction, so Desk reads it directly; `adk kvholder workspace
 * status --json` prints the same thing for awsh.
 *
 * Fails to `{running: false, reason}`, never throws.
 */

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const STALE_MS = 15_000; // the relay writes every 5 s

function statusPath(env = process.env) {
  return env.AITHER_KVHOLDER_WORKSPACE_STATUS || path.join(os.homedir(), ".aither", "kvholder", "workspace.json");
}

function readKvSwarm({ file = statusPath(), now = Date.now(), readImpl = fs.readFileSync } = {}) {
  let st;
  try {
    st = JSON.parse(readImpl(file, "utf8"));
  } catch (e) {
    return { running: false, reason: e.code === "ENOENT" ? "relay never ran" : `unreadable: ${e.message}` };
  }
  const updated = Number(st.updated || 0) * 1000;
  const swarm = st.swarm || {};
  const holders = (swarm.holders || []).map((h) => ({
    device: h.device_id || h.device || "?",
    held: h.held || 0,
    usedBytes: h.used_bytes || 0,
    lentBytes: h.max_bytes || 0,
    lastMs: h.last_ms || 0,
    seenS: h.seen_s,
  }));
  return {
    running: now - updated < STALE_MS,
    reason: now - updated < STALE_MS ? "" : "relay stopped (status not updating)",
    relay: st.relay || "",
    identityOk: !!(st.identity && st.identity.ok),
    holders,
    pending: Array.isArray(st.pending) ? st.pending : [],
    lentBytes: swarm.lent_bytes || 0,
    usedBytes: swarm.used_bytes || 0,
    broken: swarm.broken || null,
  };
}

/** One clause for the Fleet line: "KV 2 phones 6.0 GB lent" / "KV relay off". */
function summarizeKvSwarm(s) {
  if (!s || !s.running) return s && s.reason === "relay never ran" ? "" : "KV relay off";
  const gb = (s.lentBytes / 1024 ** 3).toFixed(1);
  const n = s.holders.length;
  const wait = s.pending.length ? `, ${s.pending.length} waiting for you` : "";
  return `KV ${n} phone${n === 1 ? "" : "s"} ${gb} GB lent${s.broken ? " BROKEN" : ""}${wait}`;
}

module.exports = { STALE_MS, readKvSwarm, statusPath, summarizeKvSwarm };
