"use strict";

/**
 * setup-wizard.cjs — "Set up Aither": first-time setup of an AitherOS/awnix machine as
 * ONE window. No terminal, no copied device code, no Linux password prompt by default.
 *
 *   preflight  aither-setup --status/--probe --json (read-only; the distro is not booted
 *              for this unless it is already running or the person clicked)
 *   signIn     the system browser, already logged in to idp.aitherium.com, bounces back
 *              to a loopback listener (desk-oidc.cjs); then two machine sessions are
 *              minted and approved with that bearer — desk@HOST (Windows adk) and
 *              awnix@HOST — and the OIDC token is dropped
 *   apply      maintenance lock + aw_ops claim; password hashed INSIDE awnix; seed and
 *              token over stdin; aither-setup --seed --json-progress; Windows auth.json
 *              (owner-only ACL); wsl --manage --set-default-user
 *   restart    fleet_host.py cycle (safe moment, data disk re-attached BEFORE tiers)
 *   verify     read-only rows: logged in as, default user, daemon, packs, backend
 *
 * Electron-free and dependency-injected; setup-wizard.test.cjs runs it end to end with a
 * fake IdP and a fake wsl.exe. The renderer never holds a token: this object lives in
 * the main process and only returns non-secret summaries.
 */

const EventEmitter = require("node:events");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const oidc = require("./desk-oidc.cjs");
const { Provisioner, ProvisionError, USER_RE } = require("./awnix-provision.cjs");

const MAINT_LOCK = path.join(os.homedir(), ".aither", "wsl-maintenance.lock");
const RENEW_BEFORE_MS = 7 * 24 * 3600 * 1000;

class WizardError extends Error {
  constructor(message, code = "wizard") {
    super(message);
    this.name = "WizardError";
    this.code = code;
  }
}

/** adk's AuthStore shape (awdk/adk/auth.py): version 1, profiles.portal, active_profile. */
function mergeAuthStore(existingText, tokenBody, endpoint) {
  let store;
  try { store = JSON.parse(existingText || ""); } catch { store = null; }
  if (!store || typeof store !== "object" || store.version !== 1) store = { version: 1, profiles: {} };
  store.profiles = store.profiles && typeof store.profiles === "object" ? store.profiles : {};
  const user = tokenBody.user || {};
  store.profiles.portal = {
    endpoint, genesis_url: user.genesis_url || "", token_type: tokenBody.token_type || "bearer",
    access_token: tokenBody.access_token, expires_at: tokenBody.expires_at || "", user,
  };
  store.active_profile = "portal";
  return `${JSON.stringify(store, null, 2)}\n`;
}

/**
 * Build the seed aither-setup reads (plan_from_seed). Pure: validates the answers and
 * never carries a plaintext password (the hash is passed in).
 */
function buildSeed(answers, { passwordHash = null, hostname = "" } = {}) {
  const a = answers || {};
  const name = String(a.name || "").trim();
  if (!USER_RE.test(name)) throw new WizardError("choose a user name: lowercase letters, digits, - and _", "bad_name");
  const sudo = a.sudo === "nopasswd" ? "nopasswd" : "password";
  let loginPassword;
  if (a.locked) {
    if (sudo !== "nopasswd") throw new WizardError("no Linux password is only possible with passwordless sudo", "locked_needs_nopasswd");
    loginPassword = "locked";
  } else if (passwordHash) {
    loginPassword = "hash";
  } else if (a.accountExists || a.reconfigure) {
    loginPassword = "keep";
  } else if (sudo === "password") {
    throw new WizardError("set a password: sudo will ask for it", "password_required");
  } else {
    loginPassword = "keep";
  }
  const user = { name, sudo, login_password: loginPassword };
  if (passwordHash) user.password_hash = passwordHash;
  if (a.mode === "adopt" && a.adoptHome) {
    user.adopt_home = a.adoptHome;
    if (Number.isInteger(a.uid)) user.uid = a.uid;
    if (Number.isInteger(a.gid)) user.adopt_gid = a.gid;
  }
  const inference = { backend: ["local", "mesh", "cloud"].includes(a.inference?.backend) ? a.inference.backend : "local" };
  if (inference.backend === "mesh" && a.inference.url) {
    if (!/^https?:\/\/[^\s'"]+$/.test(a.inference.url)) throw new WizardError("the mesh URL must be http(s)", "bad_url");
    inference.url = a.inference.url;
  }
  const seed = {
    user, login: { mode: "skip" }, restore: a.restore !== false,
    daemon: { enable: a.daemon !== false, identity: "aither" },
    capability_packs: Array.isArray(a.packs) && a.packs.length ? a.packs.map(String) : ["customer-core"],
    agent_packs: Array.isArray(a.agentPacks) ? a.agentPacks.map(String) : [],
    inference, awsh_login: a.awsh !== false, hostname,
  };
  if (a.reconfigure) seed.reconfigure = true;
  return seed;
}

class SetupWizard extends EventEmitter {
  /**
   * deps: runner (WslRunner|LocalRunner), openExternal(url), fetchImpl, idp, hostname,
   * platform, homeDir, fsImpl, execFile(exe,args) for icacls, cycle(mode) for the
   * restart, lock {acquire(), release()}, engineSource() => {script, catalogue}|null.
   */
  constructor(deps = {}) {
    super();
    this.d = {
      idp: oidc.DEFAULT_IDP, hostname: os.hostname(), platform: process.platform,
      homeDir: os.homedir(), fsImpl: fs, fetchImpl: globalThis.fetch, ...deps,
    };
    this.prov = deps.provisioner || new Provisioner({ runner: deps.runner, log: (m) => this.emit("log", m) });
    this.identity = null;          // non-secret claims only
    this.sessions = null;          // {desk, awnix} device-token bodies (main process only)
    this.lastApply = null;
  }

  host() {
    return String(this.d.hostname || "this-pc").split(".")[0].slice(0, 40);
  }

  async preflight() {
    await this.prov.resolveEngine();
    let status = await this.prov.status();
    if (!status.ok || status.missingCaps.length) {
      return { ready: false, status, canInstallEngine: Boolean(this.d.engineSource && this.d.engineSource()),
        message: status.installed ? "This awnix image's setup engine is too old for the wizard."
          : "This awnix image has no setup engine (aither-setup)." };
    }
    const probe = await this.prov.probe();
    // Tell a waiting WSL [oobe] terminal (aither-setup-wait) that this window is doing
    // the setup, so it asks nothing. Removed when the window closes (setup-window.cjs).
    if (!status.configured) await this.prov.markDeskPresent(true).catch(() => {});
    return { ready: true, status, probe };
  }

  async installEngine() {
    const src = this.d.engineSource && this.d.engineSource();
    if (!src) throw new WizardError("this desk carries no setup engine to install", "no_engine");
    await this.prov.installEngine(src);
    return this.preflight();
  }

  /** Browser sign-in + both machine sessions. Returns the non-secret identity. */
  async signIn({ prompt = "" } = {}) {
    const common = { idp: this.d.idp, openExternal: this.d.openExternal, fetchImpl: this.d.fetchImpl };
    let got;
    try {
      got = await oidc.signInLoopback({ ...common, prompt, ports: this.d.ports, timeoutMs: this.d.loopbackTimeoutMs,
        createServer: this.d.createServer });
    } catch (e) {
      if (!(e instanceof oidc.SignInError) || !["ports_busy", "timeout"].includes(e.code)) throw e;
      if (prompt === "none") throw new WizardError("your Aitherium browser session has ended: sign in again", "reauth");
      this.emit("signin-fallback", { reason: e.code });
      got = await oidc.signInDevice({ ...common, hostname: this.host(), sleep: this.d.sleep, now: this.d.now });
    }
    let bearer = got.accessToken;
    try {
      const mint = (clientName) => oidc.mintMachineSession({ ...common, accessToken: bearer, clientName,
        sleep: this.d.sleep, now: this.d.now });
      const desk = await mint(`desk@${this.host()}`);
      const awnix = await mint(`awnix@${this.host()}`);
      this.sessions = { desk, awnix };
      this.prov.addSecrets(oidc.secretsOf(desk, awnix, bearer));
    } finally {
      bearer = null;
      got.accessToken = null;
    }
    const c = got.claims || {};
    const u = this.sessions.awnix.user || {};
    this.identity = {
      username: u.username || c.preferred_username || "", email: u.email || c.email || "",
      suggestedName: String(u.username || c.preferred_username || "").toLowerCase().replace(/[^a-z0-9_-]/g, "").slice(0, 32),
      via: got.via, expiresAt: this.sessions.awnix.expires_at || "",
    };
    return this.identity;
  }

  /** %USERPROFILE%\.aither\auth.json for adk/awsettings/AitherConnect on Windows. */
  async writeWindowsAuth(tokenBody) {
    const f = this.d.fsImpl;
    const dir = path.join(this.d.homeDir, ".aither");
    const file = path.join(dir, "auth.json");
    f.mkdirSync(dir, { recursive: true });
    let existing = "";
    try { existing = f.readFileSync(file, "utf8"); } catch { /* first login */ }
    const tmp = `${file}.setup.tmp`;
    f.writeFileSync(tmp, mergeAuthStore(existing, tokenBody, this.d.idp), { encoding: "utf8", mode: 0o600 });
    f.renameSync(tmp, file);
    if (this.d.platform === "win32" && this.d.execFile) {
      const who = process.env.USERNAME || os.userInfo().username;
      const r = await this.d.execFile("icacls", [file, "/inheritance:r", "/grant:r", `${who}:F`]);
      if (r && r.code !== 0) this.emit("log", `icacls on auth.json exited ${r.code}`);
    } else {
      try { f.chmodSync(file, 0o600); } catch { /* best effort */ }
    }
    return file;
  }

  /** WSL default user without a restart: wsl --manage, then the HKCU Lxss fallback. */
  async setDefaultUser(name, uid = 1000) {
    const runner = this.prov.runner;
    if (runner.kind !== "wsl") return { ok: true, via: "n/a" };
    const r = await runner.host(["--manage", runner.distro, "--set-default-user", name], { timeoutMs: 60_000 });
    if (r.code === 0) return { ok: true, via: "wsl --manage" };
    if (this.d.setDefaultUidFallback) {
      const ok = await this.d.setDefaultUidFallback(runner.distro, uid);
      if (ok) return { ok: true, via: "HKCU Lxss DefaultUid" };
    }
    return { ok: false, via: "wsl.conf (after restart)" };
  }

  /**
   * Apply. `answers.password` is used once to hash inside awnix and then dropped from
   * the answers object; the renderer must not keep it either.
   */
  async apply(answers, onEvent = () => {}) {
    if (!this.sessions) throw new WizardError("sign in first", "not_signed_in");
    const lock = this.d.lock;
    const held = lock ? await lock.acquire() : true;
    if (!held) throw new WizardError("another setup or fleet maintenance is running; try again when it finishes", "locked");
    try {
      let passwordHash = null;
      if (answers.password) {
        onEvent({ event: "phase", phase: "password" });
        passwordHash = await this.prov.hashPassword(answers.password);
      }
      answers.password = "";
      const seed = buildSeed(answers, { passwordHash, hostname: "" });
      onEvent({ event: "phase", phase: "engine" });
      const done = await this.prov.apply(seed, this.sessions.awnix, onEvent);
      onEvent({ event: "phase", phase: "windows" });
      const authFile = await this.writeWindowsAuth(this.sessions.desk);
      onEvent({ event: "step", step: "windows sign-in", ok: true, note: `${authFile} (owner-only)` });
      const du = await this.setDefaultUser(seed.user.name, seed.user.uid || 1000);
      onEvent({ event: "step", step: "default login", ok: du.ok, note: `${seed.user.name} via ${du.via}` });
      this.lastApply = { user: seed.user.name, sudoMode: seed.user.sudo, adoptHome: seed.user.adopt_home || "",
        uid: seed.user.uid || 1000, needsRestart: Boolean(done.needs_restart) || !du.ok,
        restartReasons: [...(done.restart_reasons || []), ...(du.ok ? [] : ["default user needs a restart"])] };
      return { ...this.lastApply };
    } finally {
      // Seed + token go now. desk-present stays until the window closes: a failed apply
      // shows "try again" here, and the [oobe] terminal must not start its own setup.
      await this.prov.clearStaging().catch(() => {});
      if (lock) await lock.release();
    }
  }

  async restart(mode = "idle") {
    if (!this.d.cycle) throw new WizardError("no restart runner in this desk", "no_cycle");
    return this.d.cycle(mode);
  }

  async verify() {
    const la = this.lastApply;
    if (!la) throw new WizardError("nothing applied yet", "not_applied");
    const rows = await this.prov.verify(la);
    const auth = path.join(this.d.homeDir, ".aither", "auth.json");
    let ok;
    try { ok = Boolean(JSON.parse(this.d.fsImpl.readFileSync(auth, "utf8")).profiles?.portal?.access_token); } catch { ok = false; }
    rows.push({ id: "windows-auth", label: "signed in on Windows (adk, awsettings, AitherConnect)", ok, detail: ok ? auth : "missing" });
    return rows;
  }

  /** Silent re-mint (prompt=none) when a machine session is within 7 days of expiry. */
  static needsRenewal(expiresAt, now = Date.now()) {
    const t = Date.parse(expiresAt || "");
    return Number.isFinite(t) && t - now < RENEW_BEFORE_MS;
  }

  async renew() {
    await this.signIn({ prompt: "none" });
    await this.prov.renewToken(this.sessions.awnix);
    await this.writeWindowsAuth(this.sessions.desk);
    return { renewed: true, expiresAt: this.identity.expiresAt };
  }
}

/** The fleet maintenance lock fleet_host.py and Fleet Control honour (fresh = < 6 h). */
function maintenanceLock({ file = MAINT_LOCK, fsImpl = fs, now = Date.now } = {}) {
  let mine = false;
  return {
    async acquire() {
      try {
        const st = fsImpl.statSync(file);
        if (now() - st.mtimeMs < 6 * 3600 * 1000) return false;
      } catch { /* absent */ }
      fsImpl.mkdirSync(path.dirname(file), { recursive: true });
      fsImpl.writeFileSync(file, JSON.stringify({ owner: "awdesk-setup", pid: process.pid, at: new Date(now()).toISOString() }));
      mine = true;
      return true;
    },
    async release() {
      if (!mine) return;
      mine = false;
      try { fsImpl.unlinkSync(file); } catch { /* gone */ }
    },
  };
}

module.exports = { SetupWizard, WizardError, ProvisionError, buildSeed, mergeAuthStore, maintenanceLock, MAINT_LOCK };
