"use strict";

/**
 * awnix-provision.cjs — the desk's hands inside awnix for "Set up Aither".
 *
 * The ONE provisioning engine is aither-setup (.DEPLOYMENT/standalone/bootc/
 * aither-setup.py) driven by a seed; this module only moves data to it safely:
 *
 *   - every root action is an ARGV (`wsl.exe -d <distro> -u root --exec <argv>`, or
 *     `pkexec <argv>` on a Linux desktop). No shell string is ever built from input.
 *   - secrets travel on STDIN only: the password to `openssl passwd -6 -stdin` (only
 *     the crypt hash comes back), the machine token to `install -m600 /dev/stdin` on
 *     tmpfs (/run/aither-setup), which aither-setup shreds after storing it 0600.
 *   - `--json-progress` NDJSON is parsed line by line and every event is REDACTED
 *     against the token strings before it reaches a listener or a log.
 *
 * Electron-free; the runner is injected so awnix-provision.test.cjs drives it with a
 * fake wsl.exe.
 */

const { spawn } = require("node:child_process");
const { redact } = require("./desk-oidc.cjs");

const RUN_DIR = "/run/aither-setup";
const SEED_PATH = `${RUN_DIR}/seed.json`;
const TOKEN_PATH = `${RUN_DIR}/token`;
const DESK_PRESENT = `${RUN_DIR}/desk-present`;
/** Where the desk installs its own copy of the engine when the image's is too old. */
const DESK_ENGINE_DIR = "/usr/local/lib/aither-setup";
const DESK_ENGINE = `${DESK_ENGINE_DIR}/aither-setup`;
/** What the wizard needs from `aither-setup --status --json`.caps. */
const REQUIRED_CAPS = Object.freeze(["seed", "progress_json", "probe", "sudo_mode", "login_password"]);

class ProvisionError extends Error {
  constructor(message, detail = {}) {
    super(message);
    this.name = "ProvisionError";
    Object.assign(this, detail);
  }
}

/** Spawn helper: argv in, {code, stdout, stderr} out; stdin written then closed. */
function spawnRun(exe, args, { input, timeoutMs = 120_000, onStdoutLine, spawnImpl = spawn, env } = {}) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawnImpl(exe, args, { windowsHide: true, env: env || process.env, stdio: ["pipe", "pipe", "pipe"] });
    } catch (e) {
      resolve({ code: 127, stdout: "", stderr: String(e?.message || e) });
      return;
    }
    let stdout = "";
    let stderr = "";
    let partial = "";
    const t = setTimeout(() => {
      try { child.kill(); } catch { /* gone */ }
    }, timeoutMs);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (d) => {
      stdout += d;
      if (onStdoutLine) {
        partial += d;
        let i;
        while ((i = partial.indexOf("\n")) >= 0) {
          const line = partial.slice(0, i).replace(/\r$/, "");
          partial = partial.slice(i + 1);
          if (line.trim()) onStdoutLine(line);
        }
      }
    });
    child.stderr.on("data", (d) => { stderr += d; });
    child.on("error", (e) => { clearTimeout(t); resolve({ code: 127, stdout, stderr: stderr + String(e?.message || e) }); });
    child.on("close", (code) => {
      clearTimeout(t);
      if (onStdoutLine && partial.trim()) onStdoutLine(partial.replace(/\r$/, ""));
      resolve({ code: code ?? 1, stdout, stderr });
    });
    if (input !== undefined) child.stdin.end(input);
    else child.stdin.end();
  });
}

/** Windows: root inside the WSL distro. The Windows user who registered it already is root there. */
class WslRunner {
  constructor({ distro = "awnix", exe = "wsl.exe", spawnImpl = spawn } = {}) {
    this.distro = distro;
    this.exe = exe;
    this.spawnImpl = spawnImpl;
    this.kind = "wsl";
  }

  argv(cmd, { user = "root" } = {}) {
    return ["-d", this.distro, ...(user ? ["-u", user] : []), "--exec", ...cmd.map(String)];
  }

  run(cmd, opts = {}) {
    return spawnRun(this.exe, this.argv(cmd, opts), { ...opts, spawnImpl: this.spawnImpl });
  }

  /** Windows-side wsl.exe verbs (not inside the distro). */
  host(args, opts = {}) {
    return spawnRun(this.exe, args.map(String), { ...opts, spawnImpl: this.spawnImpl });
  }
}

/** Linux desktop: one native polkit prompt (pkexec) is the OS's own admin consent. */
class LocalRunner {
  constructor({ spawnImpl = spawn, elevate = "pkexec" } = {}) {
    this.spawnImpl = spawnImpl;
    this.elevate = elevate;
    this.kind = "local";
  }

  run(cmd, opts = {}) {
    const { user = "root" } = opts;
    const c = cmd.map(String);
    if (user === "root") return spawnRun(this.elevate, c, { ...opts, spawnImpl: this.spawnImpl });
    return spawnRun(c[0], c.slice(1), { ...opts, spawnImpl: this.spawnImpl });
  }

  host() {
    return Promise.resolve({ code: 0, stdout: "", stderr: "" });
  }
}

function parseJsonOut(text) {
  const lines = String(text || "").split(/\r?\n/).filter((l) => l.trim());
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    try {
      return JSON.parse(lines[i]);
    } catch { /* not JSON */ }
  }
  return null;
}

const HASH_RE = /^\$(6|5|y|7)\$[^\s:]+$/;
const USER_RE = /^[a-z_][a-z0-9_-]{0,31}$/;

class Provisioner {
  constructor({ runner, engine = "aither-setup", log = () => {} } = {}) {
    if (!runner) throw new TypeError("runner is required");
    this.runner = runner;
    this.engine = engine;
    this.log = log;
    this.secrets = [];
  }

  /** Every later log line / event is redacted against these. */
  addSecrets(list) {
    for (const s of list || []) if (s && !this.secrets.includes(s)) this.secrets.push(s);
  }

  _log(msg) {
    this.log(redact(msg, this.secrets));
  }

  /** Prefer an engine the desk installed (newer than the image's) when present. */
  async resolveEngine() {
    const r = await this.runner.run(["test", "-x", DESK_ENGINE]);
    this.engine = r.code === 0 ? DESK_ENGINE : "aither-setup";
    return this.engine;
  }

  async status() {
    const r = await this.runner.run([this.engine, "--status", "--json"], { timeoutMs: 60_000 });
    const doc = r.code === 0 ? parseJsonOut(r.stdout) : null;
    if (!doc) {
      return { ok: false, installed: r.code !== 127 && !/not found|No such file/i.test(r.stderr + r.stdout),
        caps: [], missingCaps: [...REQUIRED_CAPS], error: redact((r.stderr || r.stdout).trim().slice(-300), this.secrets) };
    }
    const caps = Array.isArray(doc.caps) ? doc.caps : [];
    return { ok: true, installed: true, configured: Boolean(doc.configured), caps,
      missingCaps: REQUIRED_CAPS.filter((c) => !caps.includes(c)), state: doc.state || null };
  }

  async probe() {
    const r = await this.runner.run([this.engine, "--probe", "--json"], { timeoutMs: 60_000 });
    const doc = parseJsonOut(r.stdout);
    if (!doc || doc.error) throw new ProvisionError(`probe failed: ${doc?.error || r.stderr.trim().slice(-200) || `exit ${r.code}`}`);
    return doc;
  }

  /** Install the desk's bundled engine (script + catalogue) when the image lacks it. */
  async installEngine({ script, catalogue }) {
    if (!script || !catalogue) throw new ProvisionError("this desk carries no aither-setup to install");
    for (const [text, path, mode] of [[script, DESK_ENGINE, "755"], [catalogue, `${DESK_ENGINE_DIR}/aither-setup.json`, "644"]]) {
      const r = await this.runner.run(["install", "-D", "-m", mode, "-o", "root", "-g", "root", "/dev/stdin", path],
        { input: String(text).replace(/\r\n/g, "\n") });
      if (r.code !== 0) throw new ProvisionError(`installing ${path} failed: ${r.stderr.trim().slice(-200)}`);
    }
    this.engine = DESK_ENGINE;
    return this.engine;
  }

  /** The plaintext goes in on stdin and never comes back; only the crypt hash does. */
  async hashPassword(password) {
    const pw = String(password ?? "");
    if (pw.length < 8) throw new ProvisionError("the password needs at least 8 characters");
    if (/[\r\n]/.test(pw)) throw new ProvisionError("the password cannot contain a line break");
    const r = await this.runner.run(["openssl", "passwd", "-6", "-stdin"], { input: `${pw}\n`, timeoutMs: 30_000 });
    const hash = r.stdout.trim().split(/\r?\n/).pop() || "";
    if (r.code !== 0 || !HASH_RE.test(hash)) throw new ProvisionError("hashing the password inside awnix failed");
    return hash;
  }

  /** Root-only 0600 file from stdin (tmpfs under /run). */
  async writeRootFile(path, text) {
    const r = await this.runner.run(["install", "-D", "-m", "600", "-o", "root", "-g", "root", "/dev/stdin", path],
      { input: text, timeoutMs: 30_000 });
    if (r.code !== 0) throw new ProvisionError(`writing ${path} failed: ${redact(r.stderr.trim().slice(-200), this.secrets)}`);
  }

  async markDeskPresent(on = true) {
    if (on) await this.writeRootFile(DESK_PRESENT, "awdesk\n");
    else await this.runner.run(["rm", "-f", DESK_PRESENT, SEED_PATH, TOKEN_PATH]);
  }

  /** After an apply: the staged seed + token go; desk-present stays while the window is open. */
  async clearStaging() {
    await this.runner.run(["rm", "-f", SEED_PATH, TOKEN_PATH]);
  }

  /**
   * Stage the seed + one-shot token, run the engine, stream redacted NDJSON events.
   * Resolves the `done` event; rejects with the engine's `error` event message.
   */
  async apply(seed, tokenBody, onEvent = () => {}) {
    if (!seed || !USER_RE.test(String(seed.user?.name || ""))) throw new ProvisionError("seed: invalid user name");
    if (seed.user.password) throw new ProvisionError("seed: plaintext password refused");
    if (tokenBody?.access_token) this.addSecrets([tokenBody.access_token]);
    await this.markDeskPresent(true);
    if (tokenBody?.access_token) {
      await this.writeRootFile(TOKEN_PATH, JSON.stringify(tokenBody));
      seed = { ...seed, login: { mode: "token_file", token_file: TOKEN_PATH } };
    }
    await this.writeRootFile(SEED_PATH, JSON.stringify(seed));
    const argv = [this.engine, "--seed", SEED_PATH, "--json-progress", ...(seed.reconfigure ? ["--reconfigure"] : [])];
    let done = null;
    let error = null;
    const r = await this.runner.run(argv, {
      timeoutMs: 1_800_000,
      onStdoutLine: (line) => {
        let ev;
        try {
          ev = JSON.parse(redact(line, this.secrets));
        } catch {
          this._log(`[setup] ${line}`);
          return;
        }
        if (ev.event === "done") done = ev;
        if (ev.event === "error") error = ev;
        onEvent(ev);
      },
    });
    // Whatever happened, no token stays on tmpfs (aither-setup shreds it on success).
    await this.runner.run(["rm", "-f", TOKEN_PATH]);
    if (error) throw new ProvisionError(error.message || "setup failed", { event: error });
    if (r.code !== 0 || !done) {
      throw new ProvisionError(`setup exited ${r.code}: ${redact(r.stderr.trim().slice(-400), this.secrets)}`);
    }
    return done;
  }

  async renewToken(tokenBody) {
    if (!tokenBody?.access_token) throw new ProvisionError("no token to renew with");
    this.addSecrets([tokenBody.access_token]);
    const r = await this.runner.run([this.engine, "--renew-token", "/dev/stdin", "--json"],
      { input: JSON.stringify(tokenBody), timeoutMs: 60_000 });
    const doc = parseJsonOut(r.stdout);
    if (r.code !== 0 || !doc?.renewed) throw new ProvisionError(`renew failed: ${redact(r.stderr.trim().slice(-200), this.secrets)}`);
    return doc;
  }

  /**
   * The Verify screen: each row is {id, label, ok: true|false|null, detail}. null = could
   * not judge (said so, never shown green). Reads only; no row changes anything.
   */
  async verify({ user, sudoMode, adoptHome = "", uid = 1000 }) {
    const rows = [];
    const add = (id, label, ok, detail = "") => rows.push({ id, label, ok, detail: redact(detail, this.secrets) });
    const run = (cmd, opts) => this.runner.run(cmd, { timeoutMs: 60_000, ...opts });
    if (this.runner.kind === "wsl") {
      const w = await run(["whoami"], { user: null });
      add("default-user", `awnix logs you in as ${user}`, w.code === 0 ? w.stdout.trim() === user : null, w.stdout.trim() || w.stderr.trim());
    }
    const id = await run(["id", "-u", user]);
    add("uid", `${user} is uid ${uid}`, id.code === 0 ? Number(id.stdout.trim()) === Number(uid) : false, id.stdout.trim());
    if (adoptHome) {
      const f = await run(["findmnt", "-no", "SOURCE", "--target", `/home/${user}`]);
      add("home", "your home is the migrated one on the data disk",
        f.code === 0 ? /fleet-src|\[\/home\//.test(f.stdout) || f.stdout.includes(adoptHome) : null, f.stdout.trim());
    }
    const s = await run(["runuser", "-u", user, "--", "sudo", "-n", "true"]);
    const passwordless = s.code === 0;
    add("sudo", sudoMode === "nopasswd" ? "sudo without a password (you chose this)" : "sudo asks for your password",
      sudoMode === "nopasswd" ? passwordless : !passwordless);
    const d = await run(["systemctl", "--user", `--machine=${user}@`, "is-active", "aither-agent.service"]);
    add("daemon", "your agent runs in the background", d.stdout.trim() === "active", d.stdout.trim());
    const a = await run(["runuser", "-u", user, "--", "env", `HOME=/home/${user}`, "adk", "whoami"]);
    add("signed-in", "signed in to Aitherium inside awnix", a.code === 0 ? !/not (logged|signed) in/i.test(a.stdout) : (a.code === 127 ? null : false),
      a.stdout.trim().split(/\r?\n/)[0] || "");
    const p = await run(["cat", `/home/${user}/.aither/packs.json`]);
    let packs = null;
    try { packs = JSON.parse(p.stdout); } catch { /* none */ }
    add("packs", "capability packs recorded", packs ? Array.isArray(packs.packs) && packs.packs.length > 0 : false,
      packs ? `${(packs.capability_profiles || []).join(", ")} (${(packs.packs || []).length} packs)` : "");
    const sh = await run(["runuser", "-l", user, "-c", "command -v awsh"]);
    add("awsh", "awsh on your login PATH", sh.code === 0 ? true : null, sh.stdout.trim() || "awsh not installed yet");
    const env = await run(["cat", `/home/${user}/.config/aither/agent.env`]);
    const backend = (env.stdout.match(/^AITHER_LLM_BACKEND=(.*)$/m) || [])[1] || "";
    const base = (env.stdout.match(/^AITHER_LLM_BASE_URL=(.*)$/m) || [])[1] || "";
    if (base) {
      const c = await run(["curl", "-sk", "-o", "/dev/null", "-w", "%{http_code}", "-m", "8", `${base.replace(/\/+$/, "")}/models`]);
      const code = Number(c.stdout.trim());
      add("backend", `inference backend answers (${base})`, c.code === 0 ? code > 0 && code < 500 : null, `HTTP ${c.stdout.trim()}`);
    } else {
      add("backend", `inference backend: ${backend || "unknown"}`, backend ? null : false,
        backend ? "local/auto: judged by the agent at first use" : "agent.env missing");
    }
    return rows;
  }
}

/** fleet_host.py DEFAULT_ATTACH_TASK / DEFAULT_BIND_DIRS (the machine's data disk). */
const ATTACH_TASK = "AitherOS-AttachFleetData";
const DATA_DIRS = Object.freeze(["/var/lib/containers", "/etc/containers/systemd", "/etc/containers/networks",
  "/etc/aither", "/var/lib/aither"]);
const MOUNT_ASSERT_RC = 42;
/** Constant script (no input interpolated): all data dirs mounted, re-running the attach unit once if not. */
const MOUNT_ASSERT = `ok() { for d in ${DATA_DIRS.join(" ")}; do mountpoint -q $d || return 1; done; }; `
  + "systemctl is-system-running --wait >/dev/null 2>&1; ok && exit 0; "
  + "systemctl restart aither-attach-fleet-data.service 2>/dev/null; "
  + `for i in $(seq 60); do ok && exit 0; sleep 2; done; exit ${MOUNT_ASSERT_RC}`;

/**
 * The restart when this machine has no fleet_host.py (an installed desk away from the
 * repo). Same ordering as fleet_host.py cycle: when the data-disk task exists it is
 * ENDED, the distro terminated, the task RUN (it re-attaches the vhdx), and the data
 * mounts ASSERTED before this reports success. Without the task (a customer) it is a
 * plain terminate + boot. execFile(exe, args) -> {code, stdout, stderr}.
 */
async function fallbackCycle({ runner, execFile, attachTask = ATTACH_TASK }) {
  if (runner.kind !== "wsl") return { ok: true, note: "nothing to restart on this platform" };
  const q = await execFile("schtasks", ["/query", "/tn", attachTask]);
  const hasTask = q.code === 0;
  if (hasTask) await execFile("schtasks", ["/end", "/tn", attachTask]);   // best effort
  const t = await runner.host(["--terminate", runner.distro], { timeoutMs: 120_000 });
  if (t.code !== 0) return { ok: false, error: `wsl --terminate exited ${t.code}` };
  if (hasTask) {
    const r = await execFile("schtasks", ["/run", "/tn", attachTask]);
    if (r.code !== 0) return { ok: false, error: `could not start ${attachTask} (exit ${r.code}); awnix was not booted` };
    const m = await runner.run(["sh", "-c", MOUNT_ASSERT], { timeoutMs: 600_000 });
    if (m.code !== 0) {
      return { ok: false, dataDisk: false,
        error: "awnix restarted but the fleet data disk is not mounted; nothing was started on it" };
    }
    return { ok: true, dataDisk: true, note: "data disk re-attached and mounted" };
  }
  const b = await runner.run(["systemctl", "is-system-running", "--wait"], { timeoutMs: 300_000 });
  return { ok: ["running", "degraded"].includes(b.stdout.trim()), note: b.stdout.trim() };
}

module.exports = {
  ATTACH_TASK, DATA_DIRS, MOUNT_ASSERT, fallbackCycle,
  RUN_DIR, SEED_PATH, TOKEN_PATH, DESK_PRESENT, DESK_ENGINE, DESK_ENGINE_DIR, REQUIRED_CAPS,
  ProvisionError, spawnRun, WslRunner, LocalRunner, Provisioner, parseJsonOut, HASH_RE, USER_RE,
};
