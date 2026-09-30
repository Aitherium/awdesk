"use strict";

/**
 * fleet-control.cjs — the Fleet window's backend: ONE implementation of
 * "shut AitherOS down / bring it back", shared with `game down|up` and the Desk
 * MCP `fleet_control` tool.
 *
 * Born 2026-09-07 (owner: "shut aitheros down ... i need a better way to do
 * this ... something tied to awdesk, a real program I can launch and interact
 * with to control this"). Until then the only way to take the fleet down and
 * keep it down was a Claude Code session hand-writing `systemctl mask` loops
 * across the WSL hop, and the only way back was `systemctl unmask --runtime`
 * by hand — 207 units, nothing recorded, nothing the owner could click.
 *
 * Everything here delegates to the IN-DISTRO script
 * `.DEPLOYMENT/scripts/llm-quiesce-distro.py` (root in the fleet WSL distro, fleet-distro.cjs),
 * which is the only thing that actually HOLDS on the podman-quadlet fleet:
 * HOLD sentinel + `systemctl stop` + runtime masks, sockets before services,
 * verified from `podman ps`, not from exit codes. This file only crosses the
 * WSL hop — one command string through `sh -c`, never re-parsed — and turns
 * the JSON verdict into what the window renders.
 *
 * Every action serialises: a second click while one runs is refused with
 * `busy`, because two concurrent mask/unmask passes on the same 207 units is
 * how a fleet ends up half-up with no record of which half.
 */

const { spawn } = require("node:child_process");
const { EventEmitter } = require("node:events");
const { readGpuHolders, summarizeHolders } = require("./gpu-holders.cjs");
const { probeSurfaces, summarizeSurfaces } = require("./surfaces.cjs");
const { fleetDistro } = require("./fleet-distro.cjs");
const { readBridgeToken } = require("./bridge-server.cjs");

const DEFAULT_SCRIPT = "C:\\AitherOS-Fresh\\.DEPLOYMENT\\scripts\\llm-quiesce-distro.py";
// ARC command and control -- the same script awsh and the terminal run, so a
// verb means one thing everywhere (owner, 2026-09-19: "i need controls in awdesk
// and awsh"). It runs in-distro here; from a Windows shell it hops itself.
const DEFAULT_ARC_SCRIPT = "C:\\AitherOS-Fresh\\.DEPLOYMENT\\scripts\\arc-control.py";
// The per-service half (owner, 2026-09-21: "a real way to see and manage running services
// ... like an iDRAC"). The fleet script speaks only whole-fleet verbs; this one speaks
// list/show/restart/stop/start/boot for ONE service, and refuses to touch a container no
// quadlet owns rather than bouncing it into a state nothing supervises.
const DEFAULT_SERVICES_SCRIPT = "C:\\AitherOS-Fresh\\.DEPLOYMENT\\scripts\\fleet-inventory-distro.py";
// The distro is RESOLVED, never a literal: env AITHER_FLEET_DISTRO (or the legacy
// AWDESK_FLEET_DISTRO) > nodes.yaml debian-fleet.fleet_distro > "awnix".
// Until 2026-09-27 this was the literal "Debian", which the awnix migration retired.

/** The owner's verb set (2026-09-27: "all the app surfaces ... need to be updated to work
 *  with awnix, like GPU sleep and fleet sleep"). HOST-side through
 *  AitherOS/dev/tools/fleet_verbs.py -- the ONE implementation awsh, adk, awnode and
 *  AitherZero run too -- which sequences the in-distro engine, awmodels postures, the
 *  MicroScheduler gaming lanes and the gaming lock. A click is the consent: --execute. */
const VERB_ACTIONS = Object.freeze({
  "verbs-status": ["status", "--json"],
  "gpu-sleep": ["gpu", "sleep", "--execute", "--json"],
  "gpu-wake": ["gpu", "wake", "--execute", "--json"],
  "fleet-sleep": ["fleet", "sleep", "--execute", "--json"],
  "fleet-wake": ["fleet", "wake", "--execute", "--json"],
  "fleet-critical": ["fleet", "critical", "--execute", "--json"],
});
/** The pre-2026-09-27 names, kept so a palette row, an awsh `game on` or an MCP caller that
 *  still says `gaming` lands on the SAME verb (not the old `quiesce --deep`). */
const ALIASES = Object.freeze({
  gaming: "gpu-sleep",
  resume: "gpu-wake",
  down: "fleet-sleep",
  up: "fleet-wake",
  critical: "fleet-critical",
});
function canonicalAction(action) {
  return ALIASES[action] || action;
}

/** action -> argv. The distro-script verbs speak quiesce/resume/adopt; the owner's verbs
 *  (and their old names) go through fleet_verbs.py on the host. */
const ACTIONS = Object.freeze({
  status: ["status"],
  quiesce: ["quiesce"],
  adopt: ["adopt"],
  ...VERB_ACTIONS,
  ...Object.fromEntries(Object.entries(ALIASES).map(([a, v]) => [a, VERB_ACTIONS[v]])),
  // ARC: is it solving and learning; start it (hold off, mask off, both units);
  // run it NOW for four hours despite quiet hours (attributed, self-expiring);
  // stop the solver (the world model stays up).
  // Per-service, all read-only except the explicit bounce. --json so the window renders
  // rows rather than scraping a table.
  services: ["list"],
  "services-sick": ["list", "--unhealthy"],
  "services-boot": ["boot"],
  "arc-status": ["status"],
  "arc-start": ["start"],
  "arc-now": ["start", "--now", "4"],
  "arc-stop": ["stop"],
  // Model postures (owner, 2026-09-27: "painless swapping my active models").
  // HOST-side, not through the distro: awmodels drives BOTH machines itself
  // (ssh to the Spark, wsl to the fleet) from config/model-postures.yaml.
  "models-status": ["status", "--json"],
  "models-full-mesh": ["use", "full-mesh", "--yes", "--no-wait"],
  "models-pool-fast": ["use", "pool-fast", "--yes", "--no-wait"],
  "models-pool-lean": ["use", "pool-lean", "--yes", "--no-wait"],
  // The fleet HOST (the WSL distro itself: registered, systemd, podman, data attach,
  // tier targets). HOST-side through AitherOS/dev/tools/fleet_host.py -- the engine
  // `adk fleet-host`, awnode's fleet_host_* MCP tools and the setup-awnix-fleet-host
  // playbook share. A click is the consent, so the window's verbs pass --execute;
  // host-migrate-dryrun is the playbook's read-only preflight.
  "host-status": ["status", "--json"],
  "host-start": ["start", "--execute", "--json"],
  "host-stop": ["stop", "--execute", "--json"],
  "host-restart": ["restart", "--execute", "--json"],
  "host-reattach": ["reattach", "--execute", "--json"],
  "host-migrate-dryrun": ["migrate", "--mode", "preflight", "--json"],
});
/** Which script an action belongs to. Everything not named here is the fleet script. */
const ARC_ACTIONS = new Set(["arc-status", "arc-start", "arc-now", "arc-stop"]);
const SERVICE_ACTIONS = new Set(["services", "services-sick", "services-boot"]);
/** Host-side verbs: they run awmodels on Windows, never inside the distro. */
const MODEL_ACTIONS = new Set(["models-status", "models-full-mesh", "models-pool-fast", "models-pool-lean"]);
// Doubled backslashes: with single ones "\A" is just "A" and "\t" is a TAB, so the
// old literal resolved to "C:AitherOS-FreshAitherOSdev<TAB>oolsawmodels.py".
const DEFAULT_MODELS_SCRIPT = "C:\\AitherOS-Fresh\\AitherOS\\dev\\tools\\awmodels.py";
/** Host-side verbs on the fleet host itself (fleet_host.py). */
const HOST_ACTIONS = new Set(["host-status", "host-start", "host-stop", "host-restart", "host-reattach",
  "host-migrate-dryrun"]);
const DEFAULT_FLEET_HOST_SCRIPT = "C:\\AitherOS-Fresh\\AitherOS\\dev\\tools\\fleet_host.py";
const DEFAULT_FLEET_VERBS_SCRIPT = "C:\\AitherOS-Fresh\\AitherOS\\dev\\tools\\fleet_verbs.py";
/** Every action that runs fleet_verbs.py (the verbs and their aliases). */
const VERB_ACTION_NAMES = new Set([...Object.keys(VERB_ACTIONS), ...Object.keys(ALIASES)]);
// ComfyUI runs WINDOWS-NATIVE (D:\ComfyUI on the host driver, 2026-09-27): the distro
// script cannot see it. `stop` writes ~/.aither/gaming.lock first (the AitherOS-ComfyUI
// supervisor task honours it); `start` clears it and adopts a running instance.
// The owner's verbs (gpu/fleet sleep|wake|critical, and gaming/down/resume/up, their
// aliases) now run the ComfyUI step INSIDE fleet_verbs.py, so every surface gets it; this
// table is what the desk still runs itself, for an action that does NOT go through the core.
const DEFAULT_COMFYUI_SCRIPT = "C:\\AitherOS-Fresh\\AitherOS\\dev\\tools\\comfyui_host.py";
/** fleet action -> the Windows-side ComfyUI verb it implies. */
const HOST_STEPS = Object.freeze({ gaming: "stop", down: "stop", resume: "start", up: "start" });
const HOST_STEP_TIMEOUT_MS = Object.freeze({ stop: 120_000, start: 240_000 });
const ACTION_NAMES = Object.freeze(Object.keys(ACTIONS));

/** Actions that take the fleet (or part of it) DOWN — the window double-confirms these. */
const DESTRUCTIVE = new Set(["down", "gaming", "quiesce", "arc-stop",
  // the owner's verbs: sleeping takes models / the fleet down; critical takes most of it
  "gpu-sleep", "fleet-sleep", "fleet-critical", "critical",
  // a posture switch relaunches the DeepSeek pool and can park gemma4
  "models-full-mesh", "models-pool-fast", "models-pool-lean",
  // the fleet HOST: stop/restart take every container down; start/reattach change
  // what the distro mounts and runs -- all confirm-first
  "host-start", "host-stop", "host-restart", "host-reattach"]);

/** How long an action may run before the child is killed. `up` after `down`
 *  reloads a 26 GB model through gpu-boot (measured 2026-09-07: 590 s was not
 *  enough for vllm-fp16 alone), so the ceiling is generous on purpose. */
const TIMEOUT_MS = Object.freeze({
  status: 120_000,
  adopt: 120_000,
  quiesce: 600_000,
  // fleet_verbs: awmodels (--no-wait) + quiesce; wake = gpu-boot one at a time (3900 s
  // budget in the engine) + the orchestrator chat check; fleet wake adds the health gate
  "verbs-status": 240_000,
  "gpu-sleep": 1_800_000,
  gaming: 1_800_000,
  "gpu-wake": 4_800_000,
  resume: 4_800_000,
  "fleet-sleep": 1_200_000,
  down: 1_200_000,
  "fleet-wake": 5_400_000,
  up: 5_400_000,
  "fleet-critical": 2_400_000,
  critical: 2_400_000,
  services: 240_000,
  "services-sick": 240_000,
  "services-boot": 180_000,
  "arc-status": 300_000,
  "arc-start": 400_000,
  "arc-now": 400_000,
  "arc-stop": 200_000,
  "models-status": 180_000,
  // --no-wait: returns once the relaunch is requested; gemma4 start can take ~10 min
  "models-full-mesh": 1_200_000,
  "models-pool-fast": 1_200_000,
  "models-pool-lean": 1_200_000,
  "host-status": 240_000,
  "host-start": 1_200_000,
  "host-stop": 1_200_000,
  "host-restart": 1_800_000,
  "host-reattach": 600_000,
  "host-migrate-dryrun": 900_000,
});

/** `C:\a\b.py` -> `/mnt/c/a/b.py` (the distro's view of a Windows file). */
function toDistroPath(windowsPath) {
  const m = /^([A-Za-z]):[\\/](.*)$/.exec(String(windowsPath ?? ""));
  if (!m) return String(windowsPath ?? "").replace(/\\/g, "/");
  return `/mnt/${m[1].toLowerCase()}/${m[2].replace(/\\/g, "/")}`;
}

function scriptPath() {
  return process.env.AWDESK_FLEET_SCRIPT || DEFAULT_SCRIPT;
}

function distroName() {
  return fleetDistro(); // env AITHER_FLEET_DISTRO / AWDESK_FLEET_DISTRO > nodes.yaml > "awnix"
}

/** The exact process to spawn for an action. The whole distro invocation is
 *  ONE string through `sh -c` (the WSL-hop rule: argv is never re-parsed, and
 *  a `$var` or backtick that survives the hop is a different command). */
/** The awnix fleet BRAIN: a headless desk (electron/brain.cjs, aither-awdesk-brain.service)
 *  that runs every fleet verb ON the fleet host. The Windows desk sends its fleet
 *  verbs there first and falls back to its own wsl.exe hop only when the brain
 *  cannot be reached. Default ON for a Windows desk (the brain answers on WSL
 *  localhost forwarding); AWDESK_FLEET_BRAIN_URL overrides, "off" disables. The
 *  brain itself never has one (AWDESK_FLEET_LOCAL=1), so it cannot recurse. */
// 48931, not 4794x: the game bridge (lib/integrations/game_bridge, `serve`) scans
// 47940-47949 for a free port and took 47941 on the Windows side -- where WSL's
// localhost relay then could not forward the brain, and the desk read the game
// bridge's 404 (measured 2026-09-27 22:15).
const DEFAULT_BRAIN_URL = "http://127.0.0.1:48931";

function brainUrlFromEnv({ env = process.env, platform = process.platform } = {}) {
  const raw = env.AWDESK_FLEET_BRAIN_URL;
  if (raw !== undefined) {
    const v = String(raw).trim();
    if (!v || /^(off|none|0|false)$/i.test(v)) return null;
    return v.replace(/\/+$/, "");
  }
  if (env.AWDESK_FLEET_LOCAL === "1") return null;
  return platform === "win32" ? DEFAULT_BRAIN_URL : null;
}

function arcScriptPath() {
  return process.env.AWDESK_ARC_SCRIPT || DEFAULT_ARC_SCRIPT;
}

function servicesScriptPath() {
  return process.env.AWDESK_SERVICES_SCRIPT || DEFAULT_SERVICES_SCRIPT;
}

/** True when this desk runs INSIDE the fleet host (awnix, under WSLg) rather than on
 *  Windows. Explicit, never sniffed from the platform: the node tests run on Linux CI
 *  and must keep exercising the wsl.exe hop. `aither-awdesk.service` sets it. */
function inFleetHost() {
  return process.env.AWDESK_FLEET_LOCAL === "1";
}

function buildCommand(action, { script = scriptPath(), arcScript = arcScriptPath(), servicesScript = servicesScriptPath(), distro = distroName(), local = inFleetHost() } = {}) {
  const argv = ACTIONS[action];
  if (!argv) throw new Error(`unknown fleet action "${action}" (one of ${ACTION_NAMES.join(", ")})`);
  if (VERB_ACTION_NAMES.has(action)) {
    // In-host (AWDESK_FLEET_LOCAL=1, the desk inside awnix): the same core, reached at its
    // /mnt/c path; fleet_verbs.py picks the `local` transport itself off Windows.
    const verbs = process.env.AWDESK_FLEET_VERBS_SCRIPT || DEFAULT_FLEET_VERBS_SCRIPT;
    return {
      file: process.env.AWDESK_PYTHON || (local ? "python3" : "python"),
      args: [local ? toDistroPath(verbs) : verbs, ...argv],
    };
  }
  if (HOST_ACTIONS.has(action)) {
    return {
      file: process.env.AWDESK_PYTHON || "python",
      args: [process.env.AWDESK_FLEET_HOST_SCRIPT || DEFAULT_FLEET_HOST_SCRIPT, ...argv],
    };
  }
  if (MODEL_ACTIONS.has(action)) {
    const models = process.env.AWDESK_MODELS_SCRIPT || DEFAULT_MODELS_SCRIPT;
    return {
      file: process.env.AWDESK_PYTHON || (local ? "python3" : "python"),
      args: [local ? toDistroPath(models) : models, ...argv],
    };
  }
  // Three scripts, one seam. A verb belongs to exactly one of them.
  const which = ARC_ACTIONS.has(action) ? arcScript
    : SERVICE_ACTIONS.has(action) ? servicesScript
    : script;
  const inner = `python3 '${toDistroPath(which)}' ${argv.join(" ")} --json`;
  // Already on the fleet host: the same ONE string, no hop. Same argv shape past the
  // hop (`sh -c <inner>`), so args.at(-1) is the command either way.
  if (local) return { file: "sh", args: ["-c", inner] };
  return { file: "wsl.exe", args: ["-d", distro, "-u", "root", "sh", "-c", inner] };
}

/** The host-side ComfyUI step an action implies, or null. */
function hostStepCommand(action) {
  // The core (fleet_verbs.py) already runs the ComfyUI step for its verbs and aliases --
  // running it here too would stop/start ComfyUI twice.
  if (VERB_ACTION_NAMES.has(action)) return null;
  const verb = HOST_STEPS[action];
  if (!verb) return null;
  return {
    verb,
    file: process.env.AWDESK_PYTHON || "python",
    args: [process.env.AWDESK_COMFYUI_SCRIPT || DEFAULT_COMFYUI_SCRIPT, verb, "--json"],
  };
}

/** Fold a host step's result into the fleet verdict. A ComfyUI that is still holding
 *  the GPU after GPU quiet makes the whole action NOT ok -- the owner's game gets the
 *  VRAM or the window says why not. A slow start only warns: the fleet did come back. */
function mergeHostStep(verdict, step) {
  if (!step) return verdict;
  verdict.host_steps = [...(verdict.host_steps || []), step];
  if (step.verb === "stop" && !step.ok) {
    verdict.ok = false;
    verdict.error = [verdict.error, `ComfyUI (Windows) not stopped: ${step.error || step.state}`]
      .filter(Boolean).join("; ");
  } else if (step.verb === "start" && !step.ok) {
    verdict.warnings = [...(verdict.warnings || []), `ComfyUI (Windows): ${step.error || step.state}`];
  }
  return verdict;
}

/** The distro script prints ONE JSON document on stdout (progress goes to
 *  stderr). rc 2 = CANNOT_JUDGE (no distro / no podman / no python3) and must
 *  never read as a healthy fleet — a window that says "UP" because the probe
 *  could not run is the exact silence this surface exists to end. */
function parseVerdict(stdout, code, stderrTail = "") {
  const text = String(stdout ?? "");
  // A LIST verb answers with a top-level JSON ARRAY of service rows, not an object.
  // Seeking "{" alone found the first row's brace INSIDE the array, and parsing from
  // there threw on the trailing "]" -- so every row was discarded in silence and the
  // caller got {ok:false,error:"exit 1"}. The desk pane looked right because my proof
  // ran the script directly; the bridge, awsh and MCP all come through here.
  const brace = text.indexOf("{");
  const bracket = text.indexOf("[");
  const start = bracket >= 0 && (brace < 0 || bracket < brace) ? bracket : brace;
  if (start >= 0) {
    try {
      const doc = JSON.parse(text.slice(start));
      // rc 1 on a list means "found some" (unhealthy services) -- that is the ANSWER,
      // not a failure -- so an array is ok whatever the rc, with the rc carried along.
      if (Array.isArray(doc)) return { ok: true, rows: doc, count: doc.length, rc: code };
      if (doc && typeof doc === "object") {
        if (doc.verdict === "CANNOT_JUDGE") return { ok: false, cannotJudge: true, ...doc };
        // fleet_verbs refusals (maintenance lock, GPU access blocked, a game running)
        // carry `refused`; every renderer reads `error`.
        if (doc.refused && !doc.error) doc.error = doc.refused;
        if (typeof doc.ok !== "boolean") doc.ok = code === 0;
        return doc;
      }
    } catch {
      /* fall through to the rc-based verdict */
    }
  }
  if (code === 2 || code === 127) {
    return {
      ok: false,
      cannotJudge: true,
      error: stderrTail.trim() || `the ${distroName()} distro, python3 or podman did not answer`,
    };
  }
  // wsl.exe itself failed: it exits -1 (4294967295 unsigned) and prints
  // `Wsl/Service/CreateInstance/0x800705b4` (timeout) or `E_UNEXPECTED` when the
  // distro is wedged or stopped. The script never ran, so this is CANNOT JUDGE
  // in plain words -- not "exit 4294967295", which is what the owner read on
  // 2026-09-21 while the fleet had been dead for 20 minutes.
  const wslErr = /Wsl\/Service|0x8007[0-9a-f]{4}|Catastrophic failure/i.test(stderrTail);
  if (code === 4294967295 || code === -1 || wslErr) {
    return {
      ok: false,
      cannotJudge: true,
      wslDown: true,
      error: `the ${distroName()} WSL distro did not answer (wsl.exe failed`
        + (wslErr ? `: ${stderrTail.trim().split(/\r?\n/).filter(Boolean).slice(-1)[0].slice(0, 120)}` : "")
        + ") -- the fleet is down or wedged; the WSL watchdog recovers it on its own, or open the Fleet pane",
    };
  }
  return {
    ok: code === 0,
    error: code === 0 ? null : (stderrTail.trim() || `exit ${code}`),
  };
}

/** One-line human summary of a `status` verdict, for the tray tooltip / MCP. */
function summarize(status) {
  if (!status || status.cannotJudge) {
    return `Fleet: CANNOT JUDGE — ${status?.error || "no verdict"}`;
  }
  const fl = status.fleet || {};
  const v = status.vram;
  const gpu = v ? `GPU ${(v.used_mib / 1024).toFixed(1)}/${(v.total_mib / 1024).toFixed(0)} GiB` : "GPU ?";
  const running = fl.running == null ? "?" : fl.running;
  const masked = fl.masked == null ? "?" : `${fl.masked}/${fl.units ?? "?"}`;
  // "GPU 10.2/32 GiB (ComfyUI 7.1, dwm 4.5)": the number AND who holds it —
  // with 0 containers running the number alone was a riddle (2026-09-08).
  const holders = summarizeHolders(status.gpu_holders);
  const surfaces = summarizeSurfaces(status.surfaces);
  const access = status.gpu_access && status.gpu_access !== "ok" ? `, GPU access ${status.gpu_access}` : "";
  const hold = status.held ? (holdIsStale(status) ? "stale (gpu wake releases it)" : "yes") : "no";
  return `Fleet: ${running} container(s) running, ${masked} units masked, ${gpu}${holders ? ` (${holders})` : ""}, HOLD ${hold}${access}` +
    (fl.scope ? `, scope=${fl.scope}` : "") + (surfaces ? `, ${surfaces}` : "");
}

/** The single word the window's big pill shows. Derived from reality (the
 *  running count + masks), never from the last button pressed. */
/** A HOLD left by a `quiesce --all` that a reboot undid: the record still says scope=all
 *  but the fleet runs and almost nothing is masked. Measured 2026-09-28 after the awnix
 *  maintenance restart: HOLD on disk, 141 containers, 3/216 masked, 31.9/32.6 GiB VRAM in
 *  use by the orchestrator -- and the pill said "GPU QUIET". Same rule as fleet_verbs.py. */
function holdIsStale(status) {
  const fl = (status && status.fleet) || {};
  return Boolean(status && status.held && fl.scope === "all" && (fl.running ?? 0) > 0
    && (fl.masked ?? 0) < (fl.units ?? 0) / 2);
}

function classify(status) {
  if (!status || status.cannotJudge) return "UNKNOWN";
  const fl = status.fleet || {};
  if (fl.running === 0 && (fl.masked ?? 0) > 0) return "DOWN";
  if (status.held && !holdIsStale(status)) return "GPU QUIET";
  if ((fl.masked ?? 0) > 0) return "MIXED";
  if ((fl.running ?? 0) > 0) return "UP";
  return "UNKNOWN";
}

class FleetControl extends EventEmitter {
  constructor({ spawnImpl = spawn, script, arcScript, distro, gpuHolders = null, surfaces = null,
    statusRetries = 1, retryDelayMs = 8000, brainUrl, fetchImpl = globalThis.fetch,
    brainToken = undefined, hostSteps = null } = {}) {
    super();
    // undefined = production default (env / platform) -- but ONLY for the real
    // spawn: a test that injects a fake spawn gets no brain unless it asks.
    this.brainUrl = brainUrl !== undefined ? brainUrl : (spawnImpl === spawn ? brainUrlFromEnv() : null);
    this.fetchImpl = fetchImpl;
    this.brainToken = brainToken !== undefined ? () => brainToken : () => readBridgeToken();
    this.lastBrainError = null;
    this.spawnImpl = spawnImpl;
    this.script = script;
    this.arcScript = arcScript;
    this.distro = distro;
    // Patience for the STATUS probe only (actions are long and deliberate by
    // design; retrying those would be retrying the owner's click). The probe is
    // load-sensitive -- podman ps has a 60 s timeout INSIDE the distro script,
    // and on 2026-09-12 a load-54 window held the Fleet pane at "?" while the
    // fleet was up with 91 containers. A spike usually passes within seconds.
    this.statusRetries = Math.max(0, Number(statusRetries) || 0);
    this.retryDelayMs = Math.max(0, Number(retryDelayMs) || 0);
    // Host-side enrichment of a `status` verdict: who holds the VRAM (Windows
    // counters — invisible from inside the distro) and whether the control-plane
    // doors answer. Injectable; a fake spawn gets no host probes unless asked.
    this.gpuHolders = gpuHolders !== null ? gpuHolders : (spawnImpl === spawn ? () => readGpuHolders() : null);
    this.surfaces = surfaces !== null ? surfaces : (spawnImpl === spawn ? () => probeSurfaces() : null);
    // The Windows-side ComfyUI step (HOST_STEPS). On for the real spawn; a fake spawn
    // opts in explicitly, so no test can reach the owner's running ComfyUI by accident.
    // Windows only: an awdesk running under WSLg (#9806) cannot see the Windows process,
    // and a "could not stop" there would be a false GPU-quiet failure.
    this.hostSteps = hostSteps !== null ? Boolean(hostSteps)
      : spawnImpl === spawn && process.platform === "win32";
    this.current = null; // { action, startedAt }
    this.inflight = null; // the promise of the running action (a second status() joins it)
    this.lastStatus = null;
    this.lastStatusAt = 0;
  }

  get busy() {
    return this.current?.action ?? null;
  }

  /** Run one action; resolves with the verdict object (never rejects on a
   *  fleet refusal — `ok:false` carries it — only on a programming error). */
  run(action) {
    if (!ACTIONS[action]) {
      return Promise.resolve({ ok: false, error: `unknown action "${action}"` });
    }
    if (this.current) {
      // Two status probes at once (the window's refresh + a bridge/MCP read)
      // share ONE child: refusing the second as busy left the panel stuck on
      // "RUNNING: STATUS" (measured 2026-09-07, first screenshot).
      if (action === "status" && this.current.action === "status" && this.inflight) {
        return this.inflight;
      }
      return Promise.resolve({
        ok: false,
        busy: this.current.action,
        error: `busy: "${this.current.action}" has been running ${Math.round((Date.now() - this.current.startedAt) / 1000)} s`,
      });
    }
    const cmd = buildCommand(action, { script: this.script, arcScript: this.arcScript, servicesScript: this.servicesScript, distro: this.distro });
    this.current = { action, startedAt: Date.now() };
    this.emit("progress", { action, line: `> ${action}`, phase: "start" });
    this.inflight = new Promise((resolve) => {
      // Set when the brain was unreachable and the verb ran locally instead, so
      // every consumer sees WHICH path answered and why.
      let fallbackTag = null;
      const hostCmd = this.hostSteps ? hostStepCommand(action) : null;
      let stopStep = null;
      let startRan = false;
      const finish = (verdict) => {
        // resume/up: start ComfyUI AFTER the fleet verb answered (brain or local path);
        // the brain runs in awnix and cannot see a Windows process, so this is host-side
        if (hostCmd?.verb === "start" && !startRan) {
          startRan = true;
          this._runHostStep(action, hostCmd).then((step) => finish(mergeHostStep(verdict, step)));
          return;
        }
        // the GPU-quiet ComfyUI stop rides EVERY exit path (a wedged wsl.exe included)
        if (stopStep && !(verdict.host_steps || []).includes(stopStep)) mergeHostStep(verdict, stopStep);
        if (fallbackTag) Object.assign(verdict, fallbackTag);
        this.current = null;
        this.inflight = null;
        if (action === "status" && !verdict.cannotJudge) {
          this.lastStatus = verdict;
          this.lastStatusAt = Date.now();
        }
        if (action === "status" && verdict.cannotJudge && this.lastStatus) {
          // NEVER a number without its age. The counts ride along from the last
          // GOOD probe, labeled with how old they are and why the fresh one
          // failed; `cannotJudge` STAYS TRUE so every consumer (tray, MCP, awsh)
          // still reads "could not judge" loudly. "Could not look" must not
          // read as "healthy" -- that rule is why this class exists.
          verdict.stale = {
            age_ms: Date.now() - this.lastStatusAt,
            at: this.lastStatusAt,
            reason: verdict.error || null,
            verdict: this.lastStatus,
          };
        }
        this.emit("progress", {
          action,
          line: verdict.ok ? `< ${action}: ok` : `< ${action}: ${verdict.error || "refused"}`,
          phase: "end",
          verdict,
        });
        resolve(verdict);
      };
      const attempt = (retriesLeft) => {
        let child;
        try {
          child = this.spawnImpl(cmd.file, cmd.args, { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
        } catch (error) {
          finish({ ok: false, cannotJudge: true, error: error?.message || String(error) });
          return;
        }
        let stdout = "";
        let stderrTail = "";
        let stderrBuf = "";
        const timer = setTimeout(() => {
          try { child.kill(); } catch { /* already gone */ }
          stderrTail += `\n[timeout after ${TIMEOUT_MS[action] / 1000} s]`;
        }, TIMEOUT_MS[action] ?? 600_000);
        timer.unref?.();
        child.stdout?.on("data", (chunk) => { stdout += chunk.toString("utf8"); });
        child.stderr?.on("data", (chunk) => {
          stderrBuf += chunk.toString("utf8");
          const lines = stderrBuf.split(/\r?\n/);
          stderrBuf = lines.pop() ?? "";
          for (const line of lines) {
            if (!line.trim()) continue;
            stderrTail = (stderrTail + "\n" + line).slice(-2000);
            this.emit("progress", { action, line, phase: "run" });
          }
        });
        child.on("error", (error) => {
          clearTimeout(timer);
          finish({ ok: false, cannotJudge: true, error: error?.message || String(error) });
        });
        child.on("close", (code) => {
          clearTimeout(timer);
          if (stderrBuf.trim()) {
            stderrTail = (stderrTail + "\n" + stderrBuf).slice(-2000);
            this.emit("progress", { action, line: stderrBuf.trim(), phase: "run" });
          }
          const verdict = parseVerdict(stdout, code ?? 1, stderrTail);
          if (action === "status" && verdict.cannotJudge && retriesLeft > 0) {
            this.emit("progress", {
              action,
              line: `status: cannot judge (${verdict.error || "no verdict"}) — retrying in ${Math.round(this.retryDelayMs / 1000)} s`,
              phase: "run",
            });
            setTimeout(() => attempt(retriesLeft - 1), this.retryDelayMs).unref?.();
            return;
          }
          if (action !== "status") {
            finish(verdict);
            return;
          }
          // Enrich a status verdict from the HOST before it lands anywhere: the
          // window, the bridge, awsh, adk and the MCP tool all read this one
          // object, so the holders and the doors show up everywhere at once.
          this._enrichStatus(verdict).then(finish, () => finish(verdict));
        });
      };
      const local = () => attempt(action === "status" ? this.statusRetries : 0);
      const dispatch = () => {
        // Host-side verbs never go to the in-distro brain: awmodels, fleet_host.py and the
        // owner's verbs (fleet_verbs.py: gaming lock, postures, ComfyUI) live on Windows.
        if (!this.brainUrl || MODEL_ACTIONS.has(action) || VERB_ACTION_NAMES.has(action)
          || HOST_ACTIONS.has(action)) {
          local();
          return;
        }
        this._viaBrain(action).then((verdict) => {
          if (!verdict) {
            // Unreachable brain: the local wsl.exe hop, and the verdict says so.
            this.emit("progress", { action, line: `fleet brain unreachable (${this.lastBrainError}) -- running locally`, phase: "run" });
            fallbackTag = { via: "local", brain_error: this.lastBrainError };
            local();
            return;
          }
          if (action === "status" && !verdict.cannotJudge) {
            // The brain cannot see Windows-side VRAM holders; enrich HERE, on the host.
            this._enrichStatus(verdict).then(finish, () => finish(verdict));
            return;
          }
          finish(verdict);
        }, (error) => {
          this.lastBrainError = error?.message || String(error);
          fallbackTag = { via: "local", brain_error: this.lastBrainError };
          local();
        });
      };
      // GPU quiet frees ComfyUI's VRAM FIRST (and even when the distro is wedged --
      // ComfyUI is a Windows process); resume starts it AFTER the fleet is back (finish).
      if (hostCmd?.verb === "stop") {
        this._runHostStep(action, hostCmd).then((step) => {
          stopStep = step;
          dispatch();
        });
      } else {
        dispatch();
      }
    });
    return this.inflight;
  }

  /** Run one Windows-side ComfyUI verb; resolves {unit, verb, ok, state, error}, never rejects. */
  _runHostStep(action, cmd) {
    return new Promise((resolve) => {
      const done = (r) => {
        this.emit("progress", { action, line: `comfyui ${cmd.verb}: ${r.ok ? r.state : r.error || r.state}`, phase: "run" });
        resolve({ unit: "comfyui", verb: cmd.verb, ...r });
      };
      let child;
      try {
        child = this.spawnImpl(cmd.file, cmd.args, { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
      } catch (error) {
        done({ ok: false, state: "unknown", error: error?.message || String(error) });
        return;
      }
      let out = "";
      let err = "";
      const timer = setTimeout(() => { try { child.kill(); } catch { /* gone */ } }, HOST_STEP_TIMEOUT_MS[cmd.verb] ?? 120_000);
      timer.unref?.();
      child.stdout?.on("data", (c) => { out += c.toString("utf8"); });
      child.stderr?.on("data", (c) => { err = (err + c.toString("utf8")).slice(-1000); });
      child.on("error", (e) => { clearTimeout(timer); done({ ok: false, state: "unknown", error: e?.message || String(e) }); });
      child.on("close", (code) => {
        clearTimeout(timer);
        let doc = null;
        try { doc = JSON.parse(out.slice(out.indexOf("{"))); } catch { /* no JSON */ }
        const state = doc?.state || "unknown";
        const ok = cmd.verb === "stop" ? state === "inactive" : state === "active" || state === "activating";
        done({ ok, state, pid: doc?.comfyui_pid ?? null, error: ok ? null : (doc?.error || err.trim() || `exit ${code}`) });
      });
    });
  }

  /** One fleet verb through the awnix brain's bridge. Resolves the brain's
   *  verdict (tagged via:"brain"), or null when the brain could not be REACHED
   *  or refused on configuration grounds (the caller then runs locally). A
   *  mutating verb that reached the brain and then timed out is NOT retried
   *  locally: it may still be running there, and a second copy would race it. */
  async _viaBrain(action) {
    const isStatus = action === "status";
    const url = `${this.brainUrl}/fleet/${isStatus ? "status?fresh=1" : action}`;
    const headers = { accept: "application/json" };
    if (!isStatus) {
      const token = this.brainToken();
      if (token) headers.authorization = `Bearer ${token}`;
    }
    const budget = (TIMEOUT_MS[action] ?? 600_000) + 30_000;
    let response;
    try {
      response = await this.fetchImpl(url, {
        method: isStatus ? "GET" : "POST",
        headers,
        signal: AbortSignal.timeout(budget),
      });
    } catch (error) {
      const code = error?.cause?.code || error?.code || error?.name || "error";
      if (error?.name === "TimeoutError" && !isStatus) {
        return {
          ok: false,
          via: "brain",
          error: `the fleet brain did not finish "${action}" within ${Math.round(budget / 1000)} s; not retried locally (it may still be running on awnix)`,
        };
      }
      this.lastBrainError = `${code} ${url}`;
      return null;
    }
    const body = await Promise.resolve().then(() => response.json()).catch(() => null);
    if (!body || typeof body !== "object") {
      this.lastBrainError = `HTTP ${response.status} with no JSON verdict`;
      return null;
    }
    // A verdict the brain REACHED (ok, refused, busy, cannot-judge) is the answer.
    // Auth/route refusals (no token on the brain, wrong bearer, no fleet route)
    // are configuration, not a fleet verdict: fall back.
    const configRefusal = [401, 403, 404, 405].includes(response.status)
      || (response.status === 503 && !body.cannotJudge);
    if (configRefusal && !body.unknown) {
      this.lastBrainError = `HTTP ${response.status}: ${String(body.error || "refused").slice(0, 160)}`;
      return null;
    }
    body.via = "brain";
    this.lastBrainError = null;
    return body;
  }

  /** Attach `gpu_holders` and `surfaces`; each probe fails to [] with a reason, never throws. */
  async _enrichStatus(verdict) {
    const [holders, surfaces] = await Promise.all([
      this.gpuHolders ? Promise.resolve().then(this.gpuHolders).catch((e) => ({ holders: [], error: e?.message || String(e) })) : null,
      this.surfaces ? Promise.resolve().then(this.surfaces).catch(() => []) : null,
    ]);
    if (holders) {
      verdict.gpu_holders = Array.isArray(holders) ? holders : holders.holders || [];
      if (holders.error) verdict.gpu_holders_error = holders.error;
    }
    if (surfaces) verdict.surfaces = Array.isArray(surfaces) ? surfaces : [];
    return verdict;
  }

  /** Cached status if fresh enough, else a live probe. */
  async status({ maxAgeMs = 15_000 } = {}) {
    if (this.current?.action === "status" && this.inflight) return this.inflight;
    if (this.lastStatus && Date.now() - this.lastStatusAt < maxAgeMs) return this.lastStatus;
    if (this.current && this.current.action !== "status" && this.lastStatus) {
      return { ...this.lastStatus, busy: this.current.action };
    }
    return this.run("status");
  }
}

module.exports = {
  ALIASES,
  VERB_ACTIONS,
  VERB_ACTION_NAMES,
  canonicalAction,
  HOST_STEPS,
  hostStepCommand,
  mergeHostStep,
  MODEL_ACTIONS,
  HOST_ACTIONS,
  distroName,
  ACTIONS,
  ACTION_NAMES,
  ARC_ACTIONS,
  SERVICE_ACTIONS,
  DESTRUCTIVE,
  TIMEOUT_MS,
  DEFAULT_BRAIN_URL,
  brainUrlFromEnv,
  FleetControl,
  buildCommand,
  inFleetHost,
  classify,
  holdIsStale,
  parseVerdict,
  summarize,
  toDistroPath,
};
