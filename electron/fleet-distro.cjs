"use strict";

/**
 * fleet-distro.cjs -- which WSL distro hosts the podman fleet (Node twin).
 *
 * The rule is IDENTICAL to AitherOS/lib/core/fleet_distro.py (read its header);
 * AitherOS/dev/tests/test_fleet_distro_resolvers.py runs both on the same fixtures:
 *   1. env AITHER_FLEET_DISTRO, then AITHER_WSL_DISTRO, FLEET_DISTRO, AWDESK_FLEET_DISTRO
 *   2. nodes.<debian-fleet>.fleet_distro in AitherOS/config/nodes.yaml
 *      (path override: env AITHER_NODES_YAML; the repo is found relative to this
 *      file, then AITHEROS_ROOT, then C:\AitherOS-Fresh for a packaged desk)
 *   3. "awnix"
 *
 * CLI (used by the parity test):  node fleet-distro.cjs [--json]
 */

const fs = require("node:fs");
const path = require("node:path");

const DEFAULT_FLEET_DISTRO = "awnix";
const FLEET_NODE_ID = "debian-fleet";
const ENV_VARS = Object.freeze(["AITHER_FLEET_DISTRO", "AITHER_WSL_DISTRO", "FLEET_DISTRO", "AWDESK_FLEET_DISTRO"]);
const NAME_RE = /^[A-Za-z0-9._-]{1,64}$/;

function defaultNodesYaml() {
  const candidates = [
    path.resolve(__dirname, "..", "..", "..", "AitherOS", "config", "nodes.yaml"),
    process.env.AITHEROS_ROOT ? path.join(process.env.AITHEROS_ROOT, "AitherOS", "config", "nodes.yaml") : null,
    "C:\\AitherOS-Fresh\\AitherOS\\config\\nodes.yaml",
  ].filter(Boolean);
  return candidates.find((p) => { try { return fs.statSync(p).isFile(); } catch { return false; } }) || candidates[0];
}

function indentOf(line) {
  return line.length - line.replace(/^\s+/, "").length;
}

/** nodes.<debian-fleet>.fleet_distro, or null. Same line scan as the Python resolver. */
function readNodesFleetDistro(nodesPath) {
  let text;
  try {
    text = fs.readFileSync(nodesPath || defaultNodesYaml(), "utf8").replace(/^\uFEFF/, "");
  } catch {
    return null;
  }
  let indent = -1;
  for (const line of text.split(/\r?\n/)) {
    if (indent < 0) {
      const m = /^(\s*)debian-fleet:\s*(#.*)?$/.exec(line);
      if (m) indent = m[1].length;
      continue;
    }
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    if (indentOf(line) <= indent) return null;
    const k = /^\s*fleet_distro:\s*(.*)$/.exec(line);
    if (k) {
      let v = k[1].trim();
      if (v[0] === '"' || v[0] === "'") {
        const end = v.indexOf(v[0], 1);
        v = end > 0 ? v.slice(1, end) : v.slice(1);
      } else {
        v = v.split(" #")[0].split("\t#")[0].trim();
      }
      return NAME_RE.test(v) ? v : null;
    }
  }
  return null;
}

/** { name, source } -- source is env:<VAR> | nodes.yaml | default. */
function resolveFleetDistro(env = process.env, nodesPath = null) {
  for (const v of ENV_VARS) {
    const val = String(env[v] ?? "").trim();
    if (val) return { name: val, source: `env:${v}` };
  }
  const p = nodesPath || (String(env.AITHER_NODES_YAML ?? "").trim() || null);
  const n = readNodesFleetDistro(p);
  if (n) return { name: n, source: "nodes.yaml" };
  return { name: DEFAULT_FLEET_DISTRO, source: "default" };
}

function fleetDistro() {
  return resolveFleetDistro().name;
}

/* ─── fleet-host TRANSPORT (same rule as lib/core/fleet_distro.py resolve_fleet_host) ───
 *   1. env AITHER_FLEET_TRANSPORT = wsl[:<d>] | local | ssh:<user@host> | machine[:<m>]
 *      (auto / empty falls through)
 *   2. nodes.<debian-fleet>.fleet_transport (auto falls through)
 *   3. platform: win32 -> wsl:<fleet distro>; linux with /run/systemd/system and podman
 *      -> local; darwin -> machine:podman-machine-default; anything else throws.
 * An invalid value at 1 or 2 throws (FleetHostUnresolved) -- never a guess. */

const TRANSPORT_ENV = "AITHER_FLEET_TRANSPORT";
const DEFAULT_PODMAN_MACHINE = "podman-machine-default";
const SSH_TARGET_RE = /^(?:[A-Za-z0-9._-]{1,64}@)?[A-Za-z0-9][A-Za-z0-9._-]{0,252}$/;
const MACHINE_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

class FleetHostUnresolved extends Error {
  constructor(msg) { super(msg); this.name = "FleetHostUnresolved"; this.exitCode = 2; }
}

function escapeRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }

/** nodes.<debian-fleet>.<dotted>, or null: each segment at its block's CHILD indent. */
function readNodesValue(dotted, nodesPath) {
  let text;
  try {
    text = fs.readFileSync(nodesPath || defaultNodesYaml(), "utf8").replace(/^﻿/, "");
  } catch {
    return null;
  }
  const lines = text.split(/\r?\n/);
  const segs = [FLEET_NODE_ID, ...dotted.split(".")];
  let i = 0;
  let parent = -1;
  for (let depth = 0; depth < segs.length; depth++) {
    const re = new RegExp(`^(\\s*)${escapeRe(segs[depth])}:(?:\\s+(.*)|\\s*)$`);
    let child = -1;
    let found = false;
    while (i < lines.length) {
      const line = lines[i++];
      const t = line.trim();
      if (!t || t.startsWith("#")) continue;
      const ind = indentOf(line);
      if (depth > 0) {
        if (ind <= parent) return null;
        if (child < 0) child = ind;
        if (ind !== child) continue;
      }
      const m = re.exec(line);
      if (!m) continue;
      let val = (m[2] || "").trim();
      if (depth === segs.length - 1) {
        if (!val || val.startsWith("#")) return null;
        if (val[0] === '"' || val[0] === "'") {
          const end = val.indexOf(val[0], 1);
          val = end > 0 ? val.slice(1, end) : val.slice(1);
        } else {
          val = val.split(" #")[0].split("\t#")[0].trim();
        }
        return val || null;
      }
      if (val && !val.startsWith("#")) return null;
      parent = ind;
      found = true;
      break;
    }
    if (!found) return null;
  }
  return null;
}

/** [kind, target, distro] for one transport value; throws on anything invalid. */
function parseTransport(spec, distro) {
  const v = String(spec).trim();
  const idx = v.indexOf(":");
  const kind = (idx >= 0 ? v.slice(0, idx) : v).trim().toLowerCase();
  const target = idx >= 0 ? v.slice(idx + 1).trim() : "";
  if (kind === "wsl") {
    const d = target || distro;
    if (!NAME_RE.test(d)) throw new Error(`invalid wsl distro in '${spec}'`);
    return ["wsl", d, d];
  }
  if (kind === "local") {
    if (target) throw new Error(`'local' takes no target: '${spec}'`);
    return ["local", "", ""];
  }
  if (kind === "ssh") {
    if (!SSH_TARGET_RE.test(target)) throw new Error(`invalid ssh target in '${spec}'`);
    return ["ssh", target, ""];
  }
  if (kind === "machine") {
    const m = target || DEFAULT_PODMAN_MACHINE;
    if (!MACHINE_RE.test(m)) throw new Error(`invalid podman machine name in '${spec}'`);
    return ["machine", m, ""];
  }
  throw new Error(`unknown fleet transport '${spec}' (want wsl[:d]|local|ssh:u@h|machine[:m])`);
}

function linuxLocalOk() {
  try {
    if (!fs.statSync("/run/systemd/system").isDirectory()) return false;
  } catch {
    return false;
  }
  return String(process.env.PATH || "").split(path.delimiter)
    .some((d) => { try { return fs.statSync(path.join(d, "podman")).isFile(); } catch { return false; } });
}

function hostOf(kind, target, distro, source) {
  return { kind, target, distro, source, spec: target ? `${kind}:${target}` : kind };
}

/** { kind, target, distro, source, spec }; throws FleetHostUnresolved when it cannot judge. */
function resolveFleetHost(env = process.env, nodesPath = null, platform = process.platform) {
  const p = nodesPath || (String(env.AITHER_NODES_YAML ?? "").trim() || null);
  const distro = resolveFleetDistro(env, p).name;
  const cands = [
    [String(env[TRANSPORT_ENV] ?? "").trim(), `env:${TRANSPORT_ENV}`],
    [String(readNodesValue("fleet_transport", p) ?? "").trim(), "nodes.yaml"],
  ];
  for (const [value, source] of cands) {
    if (!value || value.toLowerCase() === "auto") continue;
    let parsed;
    try {
      parsed = parseTransport(value, distro);
    } catch (e) {
      throw new FleetHostUnresolved(`${source}: ${e.message}`);
    }
    return hostOf(parsed[0], parsed[1], parsed[2], source);
  }
  if (platform === "win32") return hostOf("wsl", distro, distro, "platform:win32");
  if (platform === "linux") {
    if (linuxLocalOk()) return hostOf("local", "", "", "platform:linux");
    throw new FleetHostUnresolved("linux without systemd+podman: set AITHER_FLEET_TRANSPORT=ssh:<user@host>");
  }
  if (platform === "darwin") return hostOf("machine", DEFAULT_PODMAN_MACHINE, "", "platform:darwin");
  throw new FleetHostUnresolved(`no fleet transport default for platform '${platform}'`);
}

/** shlex.quote twin. */
function shQuote(s) {
  const v = String(s);
  if (v && /^[A-Za-z0-9_@%+=:,./-]+$/.test(v)) return v;
  return `'${v.replace(/'/g, "'\"'\"'")}'`;
}

function become(user, login) {
  if (!user || user === login) return [];
  return user === "root" ? ["sudo", "-n"] : ["sudo", "-n", "-u", user];
}

/**
 * argv (exe first) that runs `cmd` as `user` on the fleet host. wsl uses --exec so the
 * argv arrives intact; ssh/machine join it into ONE shell-quoted remote string.
 */
function fleetArgv(cmd, { user = "root", host = null } = {}) {
  const h = host || resolveFleetHost();
  const c = [...cmd];
  if (h.kind === "wsl") return ["wsl.exe", "-d", h.target, ...(user ? ["-u", user] : []), "--exec", ...c];
  if (h.kind === "local") {
    const euid = typeof process.geteuid === "function" ? process.geteuid() : 0;
    return [...become(user, euid === 0 ? "root" : ""), ...c];
  }
  if (h.kind === "ssh") {
    const login = h.target.includes("@") ? h.target.split("@")[0] : "";
    return ["ssh", "-o", "BatchMode=yes", h.target, "--", [...become(user, login), ...c].map(shQuote).join(" ")];
  }
  if (h.kind === "machine") {
    return ["podman", "machine", "ssh", h.target, "--", [...become(user, ""), ...c].map(shQuote).join(" ")];
  }
  throw new FleetHostUnresolved(`unknown transport kind '${h.kind}'`);
}

/** argv for a bash script fed on STDIN (`bash -s -- args`). */
function fleetScriptArgv(args = [], opts = {}) {
  return fleetArgv(["bash", "-s", ...(args.length ? ["--", ...args] : [])], opts);
}

/** argv for root `podman <args>` on the fleet host. */
function fleetPodmanArgv(args, { host = null } = {}) {
  return fleetArgv(["podman", ...args], { user: "root", host });
}

module.exports = {
  DEFAULT_FLEET_DISTRO, FLEET_NODE_ID, ENV_VARS, readNodesFleetDistro, resolveFleetDistro, fleetDistro,
  TRANSPORT_ENV, DEFAULT_PODMAN_MACHINE, FleetHostUnresolved, readNodesValue, parseTransport,
  resolveFleetHost, fleetArgv, fleetScriptArgv, fleetPodmanArgv, shQuote,
};

// CLI (parity test):  node fleet-distro.cjs [--json] | --host [--json] | --argv -- <cmd...>
if (require.main === module) {
  const argv = process.argv.slice(2);
  if (argv.includes("--host") || argv.includes("--argv")) {
    let h;
    try {
      h = resolveFleetHost();
    } catch (e) {
      process.stdout.write(`UNRESOLVED ${e.message}\n`);
      process.exit(2);
    }
    if (argv.includes("--argv")) {
      const rest = argv.slice(argv.indexOf("--") + 1);
      process.stdout.write(`${JSON.stringify(fleetArgv(rest, { host: h }))}\n`);
    } else {
      process.stdout.write(argv.includes("--json") ? `${JSON.stringify(h)}\n` : `${h.spec}\n`);
    }
  } else {
    const r = resolveFleetDistro();
    process.stdout.write(argv.includes("--json") ? `${JSON.stringify(r)}\n` : `${r.name}\n`);
  }
}
