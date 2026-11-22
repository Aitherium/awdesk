#!/usr/bin/env node
"use strict";

/**
 * mem-soak -- watch a RUNNING Aither desk's memory for N minutes and FAIL if it grows
 * past a threshold, restarts, or shows a runaway.
 *
 * Why this exists: 2026-11-20, "the app keeps losing itself at 400 MB". The desk's own
 * resource watchdog (resource-watchdog.cjs) restarts it when the main process grows
 * 400 MB inside a minute, and after two restarts an hour it quits for a cooldown. The
 * trigger was the avatar-library seed reading 2 GB of roster models on the main thread.
 * This script is the gate that would have caught it: it samples the desk's OWN
 * `/health` (`memory` = app.getAppMetrics) and fails on growth, a restart, or a gap.
 *
 *   npm run soak:memory -- --minutes 5            # a desk already running
 *   node scripts/mem-soak.cjs --minutes 30 --max-growth-mb 120
 *
 * Exit codes: 0 = held; 1 = grew/restarted; 2 = could not reach a desk (or bad args).
 *
 * The verdict is pure and unit-tested (scripts/mem-soak.test.cjs).
 */

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const DEFAULTS = Object.freeze({
  minutes: 5,
  intervalSec: 5,
  settleSec: 60,        // ignore the first minute (start-up churn), then measure
  maxGrowthMb: 150,     // main process growth after settling
  maxTotalGrowthMb: 400,
  runawayMb: 400,       // any 60 s growth this big is the watchdog's own restart rule
  gapSec: 90,           // no sample for this long = the desk was down (restart/crash)
});

/** "12:34:56" for a trace line. */
function clock(at) {
  return new Date(at).toISOString().slice(11, 19);
}

/**
 * Pure verdict over samples [{at, mainMb, totalMb}].
 * @returns {{ok: boolean, reasons: string[], baseline: object|null, peak: object}}
 */
function verdict(samples, opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  const list = (Array.isArray(samples) ? samples : []).filter((s) =>
    s && Number.isFinite(s.mainMb) && Number.isFinite(s.at)).sort((a, b) => a.at - b.at);
  const reasons = [];
  if (!list.length) return { ok: false, reasons: ["no samples"], baseline: null, peak: { mainMb: 0, totalMb: 0 } };
  const start = list[0].at;
  const base = list.find((s) => s.at - start >= o.settleSec * 1000) || list[list.length - 1];
  const peak = list.reduce((p, s) => ({
    mainMb: Math.max(p.mainMb, s.mainMb),
    totalMb: Math.max(p.totalMb, Number.isFinite(s.totalMb) ? s.totalMb : 0),
  }), { mainMb: 0, totalMb: 0 });
  if (peak.mainMb - base.mainMb > o.maxGrowthMb) {
    reasons.push(`main grew ${peak.mainMb - base.mainMb} MB after settling (bound ${o.maxGrowthMb})`);
  }
  if (peak.totalMb - (Number.isFinite(base.totalMb) ? base.totalMb : 0) > o.maxTotalGrowthMb) {
    reasons.push(`total grew ${peak.totalMb - base.totalMb} MB after settling (bound ${o.maxTotalGrowthMb})`);
  }
  // A 60 s window with RUNAWAY growth is exactly what the desk's watchdog acts on.
  for (let i = 1; i < list.length; i += 1) {
    const from = list[i - 1];
    const to = list[i];
    if (to.at - from.at <= 61_000 && to.mainMb - from.mainMb >= o.runawayMb) {
      reasons.push(`runaway: main +${to.mainMb - from.mainMb} MB between ${clock(from.at)} and ${clock(to.at)}`);
      break;
    }
  }
  for (let i = 1; i < list.length; i += 1) {
    if (list[i].at - list[i - 1].at > o.gapSec * 1000) {
      reasons.push(`the desk stopped answering for ${Math.round((list[i].at - list[i - 1].at) / 1000)} s at ${clock(list[i].at)} (a restart)`);
      break;
    }
  }
  return { ok: reasons.length === 0, reasons, baseline: base, peak };
}

/** Where the desk writes its loopback bridge port. */
function defaultPortFile() {
  const appData = process.env.APPDATA;
  const candidates = [
    appData && path.join(appData, "Desk", "bridge-port.txt"),
    process.env.XDG_CONFIG_HOME && path.join(process.env.XDG_CONFIG_HOME, "Desk", "bridge-port.txt"),
    path.join(os.homedir(), ".config", "Desk", "bridge-port.txt"),
    path.join(os.homedir(), "Library", "Application Support", "Desk", "bridge-port.txt"),
  ].filter(Boolean);
  return candidates.find((p) => fs.existsSync(p)) || null;
}

function parseArgs(argv = process.argv.slice(2)) {
  const out = { ...DEFAULTS };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === "--minutes") out.minutes = Number(next());
    else if (a === "--interval") out.intervalSec = Number(next());
    else if (a === "--settle") out.settleSec = Number(next());
    else if (a === "--max-growth-mb") out.maxGrowthMb = Number(next());
    else if (a === "--max-total-growth-mb") out.maxTotalGrowthMb = Number(next());
    else if (a === "--port") out.port = Number(next());
    else if (a === "--port-file") out.portFile = next();
    else if (a === "--help" || a === "-h") out.help = true;
    else if (a.startsWith("--")) throw new Error(`unknown option ${a}`);
  }
  return out;
}

async function health(port) {
  const res = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(4000) });
  if (!res.ok) throw new Error(`health HTTP ${res.status}`);
  return await res.json();
}

async function main() {
  let args;
  try {
    args = parseArgs();
  } catch (error) {
    console.error(`mem-soak: ${error.message}`);
    process.exit(2);
  }
  if (args.help) {
    console.log(`mem-soak -- soak a running Aither desk

  --minutes N               how long to watch (default ${DEFAULTS.minutes})
  --interval SEC            sample every SEC seconds (default ${DEFAULTS.intervalSec})
  --settle SEC              ignore the first SEC seconds when choosing the baseline (default ${DEFAULTS.settleSec})
  --max-growth-mb N         fail if MAIN grows more than N MB after settling (default ${DEFAULTS.maxGrowthMb})
  --max-total-growth-mb N   fail if the whole desk grows more than N MB (default ${DEFAULTS.maxTotalGrowthMb})
  --port N                  the desk bridge port (default: <userData>/bridge-port.txt)
  --port-file PATH          read the bridge port from PATH

Exit 0 = held, 1 = grew/restarted, 2 = no desk reachable.`);
    return 0;
  }
  const portFile = args.portFile || defaultPortFile();
  let port = args.port;
  if (!port && portFile) {
    try { port = Number(String(fs.readFileSync(portFile, "utf8")).trim()); } catch { /* no file */ }
  }
  if (!Number.isInteger(port) || port <= 0) {
    console.error("mem-soak: no desk bridge port (pass --port or --port-file)");
    return 2;
  }
  const end = Date.now() + args.minutes * 60_000;
  const samples = [];
  console.log(`mem-soak: ${args.minutes} min against 127.0.0.1:${port} (bounds: main +${args.maxGrowthMb} MB, total +${args.maxTotalGrowthMb} MB, runaway ${DEFAULTS.runawayMb} MB/min)`);
  console.log("  time      main MB   total MB   procs");
  while (Date.now() < end) {
    try {
      const body = await health(port);
      const m = body && body.memory;
      if (m && Number.isFinite(m.mainMb)) {
        samples.push({ at: Date.now(), mainMb: m.mainMb, totalMb: Number(m.totalMb) || 0 });
        console.log(`  ${clock(Date.now())}   ${String(m.mainMb).padStart(7)}   ${String(m.totalMb).padStart(8)}   ${String(m.processes || 0).padStart(5)}`);
      }
    } catch (error) {
      // A failed sample is a real signal (the desk is restarting or gone), but a single
      // blip is tolerated: a gap longer than `gapSec` fails the verdict.
      console.log(`  ${clock(Date.now())}   (no answer: ${error.message})`);
    }
    await new Promise((r) => setTimeout(r, args.intervalSec * 1000));
  }
  const result = verdict(samples, args);
  if (!result.ok) {
    console.error(`\nFAIL: ${result.reasons.join("; ")}`);
    return 1;
  }
  console.log(`\nPASS: main ${result.baseline.mainMb} MB -> peak ${result.peak.mainMb} MB, total peak ${result.peak.totalMb} MB over ${samples.length} samples`);
  return 0;
}

if (require.main === module) {
  main().then((code) => process.exit(code), (error) => {
    console.error(`mem-soak: ${error && error.stack ? error.stack : error}`);
    process.exit(2);
  });
}

module.exports = { verdict, parseArgs, defaultPortFile, DEFAULTS };
