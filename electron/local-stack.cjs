"use strict";

/**
 * local-stack.cjs — "Install the full local stack": awdk, awnode, awsh, household, mesh and
 * settings on THIS computer, from Desk, with nothing typed.
 *
 * Owner, 2026-10-04, on a Steam Deck: he will not type or paste a shell command. The
 * published installer (aitherium.com/install.sh) already does the work per-user on an
 * immutable root (uv + a user-space Node under ~/.local, no sudo), so Desk runs THAT
 * script rather than a second copy of it:
 *
 *   1. sign-in   Desk's OWN saved login first (~/.aither/auth.json, the session the
 *                Aither Desktop window already uses, checked live at /auth/me): no
 *                browser, no second sign-in. Only without one, Desk's sign-in
 *                (desk-session.cjs): the system browser, already signed in to
 *                idp.aitherium.com, bounces back to a loopback listener, and the session
 *                it mints is saved for every later run. Nothing typed, no password.
 *   2. setup code with that bearer Desk starts a device grant and approves the user_code
 *                it minted a moment earlier (the anti-phishing binding of
 *                mintMachineSession). The device_code IS the "Set up this computer"
 *                setup code: install.sh redeems it as its own sign-in.
 *   3. install   install.sh from aitherium.com (https only, must start with a shebang)
 *                runs under bash with the code in the ENVIRONMENT (argv is world-
 *                readable) and AITHER_PROGRESS=1, so each checklist change arrives as one
 *                `@@aither-step <step> <status> <detail>` line and becomes a row here.
 *
 * Electron-free and dependency-injected: local-stack.test.cjs runs it against a fake IdP
 * and a fake bash. The renderer gets step rows and redacted log lines, never a token.
 */

const EventEmitter = require("node:events");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const oidc = require("./desk-oidc.cjs");
const deskSession = require("./desk-session.cjs");

const INSTALL_URL = "https://aitherium.com/install.sh";
/** Rows the window shows, in order. install.sh reports the server vocabulary plus three
 *  local-only prerequisites (python, installer, node). */
const STEPS = Object.freeze([
  "signin", "python", "installer", "node", "awdk", "awnode", "awsh",
  "household", "mesh", "settings", "mcp", "done",
]);
const STATUSES = new Set(["running", "ok", "skip", "fail"]);
const LOG_MAX = 400;
/** The AppImage runtime and Electron leak these into children; a system bash, curl or
 *  python must not inherit Desk's bundled libraries or run as Node. */
const ENV_DROP = [
  "LD_LIBRARY_PATH", "LD_PRELOAD", "APPDIR", "APPIMAGE", "ARGV0", "OWD", "PYTHONHOME",
  "PYTHONPATH", "NODE_OPTIONS", "ELECTRON_RUN_AS_NODE", "ELECTRON_NO_ATTACH_CONSOLE",
  "CHROME_DESKTOP", "GDK_BACKEND",
];

/** Is local-stack install possible on this platform? install.sh is POSIX. */
function supported(platform = process.platform) {
  return platform === "linux" || platform === "darwin";
}

/** `@@aither-step awdk ok detail words` -> {step, status, detail} or null. Pure. */
function parseProgress(line) {
  const m = /^@@aither-step\s+([a-z_]+)\s+([a-z]+)\s?(.*)$/.exec(String(line || "").trim());
  if (!m || !STATUSES.has(m[2])) return null;
  return { step: m[1], status: m[2], detail: m[3].slice(0, 200) };
}

/** The child's environment: Desk's, minus the AppImage/Electron leaks, plus ours. Pure. */
function childEnv(base, extra) {
  const env = { ...base };
  for (const k of ENV_DROP) delete env[k];
  const home = env.HOME || os.homedir();
  const localBin = path.posix.join(home, ".local", "bin"); // bash on Linux/macOS only
  const parts = String(env.PATH || "/usr/local/bin:/usr/bin:/bin").split(":");
  if (!parts.includes(localBin)) parts.unshift(localBin);
  env.PATH = parts.join(":");
  return { ...env, ...extra };
}

/** Is `name` an executable on the child's PATH (Desk's PATH plus ~/.local/bin)? */
function onPath(name, env) {
  for (const dir of childEnv(env, {}).PATH.split(":")) {
    if (!dir) continue;
    try {
      fs.accessSync(path.join(dir, name), fs.constants.X_OK);
      return true;
    } catch { /* next */ }
  }
  return false;
}

/** Strip ANSI colours install.sh prints for a terminal. Pure. */
function plain(line) {
  // eslint-disable-next-line no-control-regex
  return String(line).replace(/\x1b\[[0-9;]*m/g, "");
}

/**
 * Sign in with no typing. Desk's saved login when Identity says it is live; otherwise
 * Desk's own browser sign-in, which saves the session it mints (desk-session.cjs).
 * Resolves { accessToken, claims, via }.
 */
async function signInNoTyping({ idp, openExternal, fetchImpl, hostname, session = deskSession }) {
  const saved = session.readAuthStoreToken();
  if (saved && saved.token) {
    const v = await session.checkToken(saved.token, { idp, fetchImpl });
    if (v.state === "valid") {
      return { accessToken: saved.token, claims: { preferred_username: v.username || saved.username }, via: "saved" };
    }
  }
  const got = await session.signInWithBrowser({ idp, openExternal, fetchImpl, hostname });
  return { accessToken: got.token, claims: { preferred_username: got.username }, via: got.via };
}

/**
 * A pre-approved device grant for install.sh: start it, approve the user_code THIS call
 * minted with the signed-in bearer, and hand back the device_code (never polled here:
 * install.sh's redemption is the sign-in of the CLI on this computer).
 */
async function mintSetupCode({ idp = oidc.DEFAULT_IDP, accessToken, clientName, fetchImpl = fetch }) {
  if (!accessToken) throw new oidc.SignInError("not signed in", "no_bearer");
  const ch = await oidc.deviceStart({ idp, clientName, fetchImpl });
  const url = `${oidc.checkIdp(idp)}/auth/device/authorize?user_code=${encodeURIComponent(ch.user_code)}`;
  const res = await fetchImpl(url, { method: "POST", headers: { Authorization: `Bearer ${accessToken}` } });
  if (res.status !== 200) {
    throw new oidc.SignInError(`approving this computer failed: HTTP ${res.status}`, "approve_failed");
  }
  if (!/^[A-Za-z0-9_-]{20,}$/.test(String(ch.device_code))) {
    throw new oidc.SignInError("Identity returned a setup code install.sh cannot take", "bad_code");
  }
  return ch.device_code;
}

/** Fetch install.sh: https from the one host, and it must be a shell script, not a page. */
async function fetchInstaller({ url = INSTALL_URL, fetchImpl = fetch }) {
  if (!/^https:\/\/aitherium\.com\//.test(url)) throw new Error(`refusing installer URL ${url}`);
  const res = await fetchImpl(url, { headers: { "User-Agent": "aither-desk" } });
  if (res.status !== 200) throw new Error(`install.sh answered HTTP ${res.status}`);
  const text = await res.text();
  if (!text.startsWith("#!")) throw new Error("install.sh did not come back as a script");
  return text;
}

class LocalStack extends EventEmitter {
  /**
   * @param {object} deps
   *   spawn(cmd, args, opts)   child_process.spawn
   *   openExternal(url)        shell.openExternal
   *   fetchImpl                fetch
   *   stateFile                where "attempted / done" is remembered
   *   tmpDir                   where the script is written (mode 600)
   */
  constructor({ spawn, openExternal, fetchImpl = fetch, stateFile, tmpDir = os.tmpdir(), idp = oidc.DEFAULT_IDP,
    hostname = os.hostname(), env = process.env, platform = process.platform, installUrl = INSTALL_URL,
    signIn = signInNoTyping, mint = mintSetupCode, log = () => {} } = {}) {
    super();
    Object.assign(this, { spawn, openExternal, fetchImpl, stateFile, tmpDir, idp, hostname, env, platform,
      installUrl, signIn, mint, logFn: log });
    this.state = "idle";
    this.steps = Object.fromEntries(STEPS.map((s) => [s, { status: "", detail: "" }]));
    this.lines = [];
    this.secrets = [];
  }

  snapshot() {
    return { state: this.state, supported: supported(this.platform), steps: { ...this.steps },
      log: this.lines.slice(-60), remembered: this.remembered() };
  }

  remembered() {
    try { return JSON.parse(fs.readFileSync(this.stateFile, "utf8")); } catch { return null; }
  }

  remember(rec) {
    try {
      fs.mkdirSync(path.dirname(this.stateFile), { recursive: true });
      fs.writeFileSync(this.stateFile, JSON.stringify({ ...rec, at: new Date().toISOString() }));
    } catch { /* the window still shows it; next launch may offer it again */ }
  }

  setStep(step, status, detail = "") {
    if (!this.steps[step]) this.steps[step] = { status: "", detail: "" };
    this.steps[step] = { status, detail: oidc.redact(detail, this.secrets).slice(0, 200) };
    this.emit("progress", { kind: "step", step, status, detail: this.steps[step].detail });
  }

  addLine(raw) {
    const line = oidc.redact(plain(raw), this.secrets).trimEnd();
    if (!line) return;
    const p = parseProgress(line);
    if (p) return void this.setStep(p.step, p.status, p.detail);
    this.lines.push(line);
    if (this.lines.length > LOG_MAX) this.lines.splice(0, this.lines.length - LOG_MAX);
    this.emit("progress", { kind: "line", line });
  }

  /** Run once after "Connect this computer", and never again on its own: not when it was
   *  tried before, and not where adk is already installed (a set-up machine). */
  maybeAutoStart() {
    if (!supported(this.platform) || this.state === "running" || this.remembered()) return false;
    if (onPath("adk", this.env)) return false;
    void this.run({ auto: true });
    return true;
  }

  async run({ auto = false } = {}) {
    if (!supported(this.platform)) return this.snapshot();
    if (this.state === "running") return this.snapshot();
    this.state = "running";
    for (const s of STEPS) this.steps[s] = { status: "", detail: "" };
    this.lines = [];
    this.remember({ attempted: true, auto, done: false });
    this.emit("progress", { kind: "state", state: this.state });
    let file = "";
    try {
      this.setStep("signin", "running", "your Aither Desktop sign-in (nothing to type)");
      const who = await this.signIn({ idp: this.idp, openExternal: this.openExternal, fetchImpl: this.fetchImpl,
        hostname: this.hostname });
      this.secrets.push(...oidc.secretsOf(who));
      const code = await this.mint({ idp: this.idp, accessToken: who.accessToken, fetchImpl: this.fetchImpl,
        clientName: `Aither Desktop on ${this.hostname}`.slice(0, 80) });
      this.secrets.push(code);
      const claims = who.claims || {};
      this.setStep("signin", "ok", claims.email || claims.preferred_username || "signed in");

      const script = await fetchInstaller({ url: this.installUrl, fetchImpl: this.fetchImpl });
      file = path.join(fs.mkdtempSync(path.join(this.tmpDir, "aither-install-")), "install.sh");
      fs.writeFileSync(file, script, { mode: 0o600 });
      const rc = await this.exec(file, code);
      const ok = rc === 0 && this.steps.awdk.status === "ok";
      this.state = ok ? "done" : "failed";
      this.remember({ attempted: true, auto, done: ok, rc });
      if (!ok) this.addLine(`install.sh ended with exit ${rc}`);
    } catch (e) {
      this.state = "failed";
      const msg = oidc.redact(e && e.message ? e.message : String(e), this.secrets);
      if (this.steps.signin.status === "running") this.setStep("signin", "fail", msg);
      this.addLine(`stopped: ${msg}`);
      this.remember({ attempted: true, auto, done: false, error: msg });
    } finally {
      if (file) { try { fs.rmSync(path.dirname(file), { recursive: true, force: true }); } catch { /* tmp */ } }
      this.secrets = [];
      this.emit("progress", { kind: "state", state: this.state });
    }
    return this.snapshot();
  }

  /** bash install.sh, the code in the environment; resolves with the exit code. */
  exec(file, code) {
    return new Promise((resolve) => {
      const env = childEnv(this.env, { AITHER_SETUP_CODE: code, AITHER_PROGRESS: "1" });
      let child;
      try {
        child = this.spawn("bash", [file, "--non-interactive", "--skip-desk"],
          { env, stdio: ["ignore", "pipe", "pipe"], cwd: env.HOME || os.homedir() });
      } catch (e) {
        this.addLine(`could not start bash: ${e.message}`);
        return resolve(127);
      }
      const pump = (stream) => {
        let buf = "";
        stream.setEncoding("utf8");
        stream.on("data", (chunk) => {
          buf += chunk;
          let i;
          while ((i = buf.indexOf("\n")) >= 0) {
            this.addLine(buf.slice(0, i));
            buf = buf.slice(i + 1);
          }
        });
        stream.on("end", () => { if (buf) this.addLine(buf); });
      };
      pump(child.stdout);
      pump(child.stderr);
      child.on("error", (e) => { this.addLine(`bash: ${e.message}`); resolve(127); });
      child.on("close", (rc) => resolve(typeof rc === "number" ? rc : 1));
    });
  }
}

module.exports = {
  INSTALL_URL, STEPS, LocalStack, childEnv, fetchInstaller, mintSetupCode, onPath, parseProgress, plain,
  signInNoTyping, supported,
};
