"use strict";

// node --test setup-wizard.test.cjs -- "Set up Aither" end to end against a FAKE IdP
// (a real loopback HTTP server speaking AitherIdentity's OIDC + device contract) and a
// FAKE wsl.exe runner. Nothing touches a real distro, browser or account.

const test = require("node:test");
const assert = require("node:assert/strict");
const nodeCrypto = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");

const oidc = require("./desk-oidc.cjs");
const { Provisioner, WslRunner, TOKEN_PATH, SEED_PATH, DESK_PRESENT } = require("./awnix-provision.cjs");
const { SetupWizard, buildSeed, mergeAuthStore, maintenanceLock } = require("./setup-wizard.cjs");

const OIDC_TOKEN = "oidc-ACCESS-secret-3c1f9e";
const DESK_TOKEN = "desk-SESSION-secret-81aa20";
const AWNIX_TOKEN = "awnix-SESSION-secret-5d77b1";

function b64url(s) {
  return Buffer.from(s).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** A fake AitherIdentity. `mode`: ok | deny | badnonce. */
async function fakeIdp({ mode = "ok" } = {}) {
  const codes = new Map();
  const devices = new Map();
  const seen = { authorizeBearers: [], approved: [], deviceNames: [] };
  // get_current_user accepts an OIDC access token AND a device session token
  const issued = new Set([OIDC_TOKEN]);
  let nextToken = [DESK_TOKEN, AWNIX_TOKEN, "spare-token-xxxxxxxx"];
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://x");
    const send = (code, body, headers = {}) => {
      res.writeHead(code, { "Content-Type": "application/json", ...headers });
      res.end(typeof body === "string" ? body : JSON.stringify(body));
    };
    let raw = "";
    for await (const c of req) raw += c;
    const p = url.pathname.replace(/^\/identity/, "");
    if (p === "/oidc/authorize") {
      const q = url.searchParams;
      if (q.get("client_id") !== "aitheros-desk" || q.get("code_challenge_method") !== "S256") return send(400, { detail: "bad" });
      if (mode === "deny") return send(302, "", { Location: `${q.get("redirect_uri")}?error=access_denied&state=${q.get("state")}` });
      const code = nodeCrypto.randomBytes(8).toString("hex");
      codes.set(code, { challenge: q.get("code_challenge"), redirect: q.get("redirect_uri"),
        nonce: mode === "badnonce" ? "other" : q.get("nonce") });
      return send(302, "", { Location: `${q.get("redirect_uri")}?code=${code}&state=${q.get("state")}` });
    }
    if (p === "/oidc/token") {
      const f = new URLSearchParams(raw);
      const c = codes.get(f.get("code"));
      codes.delete(f.get("code"));
      const ok = c && f.get("redirect_uri") === c.redirect
        && b64url(nodeCrypto.createHash("sha256").update(f.get("code_verifier") || "").digest()) === c.challenge;
      if (!ok) return send(400, { detail: "Invalid or expired authorization code" });
      const idt = `${b64url("{}")}.${b64url(JSON.stringify({ aud: "aitheros-desk", nonce: c.nonce,
        preferred_username: "david", email: "d@example.com", exp: Math.floor(Date.now() / 1000) + 600 }))}.sig`;
      return send(200, { access_token: OIDC_TOKEN, id_token: idt, token_type: "Bearer" });
    }
    if (p === "/auth/device/code") {
      const body = JSON.parse(raw || "{}");
      seen.deviceNames.push(body.client_name);
      const dc = nodeCrypto.randomBytes(8).toString("hex");
      const uc = `U${devices.size}-CODE`;
      devices.set(dc, { uc, status: "pending" });
      return send(200, { device_code: dc, user_code: uc, verification_uri: "https://idp/link",
        verification_uri_complete: `https://idp/link?user_code=${uc}`, expires_in: 900, interval: 1 });
    }
    if (p === "/auth/device/authorize") {
      seen.authorizeBearers.push(req.headers.authorization || "");
      if (!issued.has(String(req.headers.authorization || "").replace(/^Bearer /, ""))) return send(401, { detail: "no" });
      const uc = url.searchParams.get("user_code");
      for (const d of devices.values()) if (d.uc === uc) { d.status = "authorized"; seen.approved.push(uc); return send(200, { status: "authorized" }); }
      return send(404, { detail: "Invalid or expired code" });
    }
    if (p === "/auth/device/token") {
      const d = devices.get(JSON.parse(raw).device_code);
      if (!d) return send(400, { detail: "invalid_device_code" });
      if (d.status === "pending") return send(200, { status: "authorization_pending", interval: 1 });
      d.status = "consumed";
      const tok = nextToken.shift();
      issued.add(tok);
      return send(200, { status: "complete", access_token: tok, token_type: "bearer",
        expires_at: "2026-10-28T00:00:00", user: { username: "david", email: "d@example.com" } });
    }
    return send(404, { detail: "nope" });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return { base: `http://127.0.0.1:${server.address().port}/identity`, seen, close: () => new Promise((r) => server.close(r)) };
}

/** The "browser": fetch the authorize URL, follow the 302 to the loopback like Chrome would. */
function fakeBrowser() {
  const opened = [];
  const open = async (url) => {
    opened.push(url);
    if (!url.includes("/oidc/authorize")) return;
    const r = await fetch(url, { redirect: "manual" });
    const loc = r.headers.get("location");
    if (loc) await fetch(loc);
  };
  return { open, opened };
}

/** A fake wsl.exe: records argv + stdin, answers the few commands the desk runs. */
function fakeRunner({ engineOk = true, caps = ["seed", "progress_json", "probe", "sudo_mode", "login_password"], failApply = null } = {}) {
  const calls = [];
  const runner = {
    kind: "wsl", distro: "awnix",
    async host(args) {
      calls.push({ host: true, cmd: args });
      return { code: 0, stdout: "", stderr: "" };
    },
    async run(cmd, opts = {}) {
      calls.push({ cmd, input: opts.input, user: opts.user });
      const [c0, ...rest] = cmd;
      if (c0 === "test") return { code: 1, stdout: "", stderr: "" };
      if (c0 === "aither-setup" && rest[0] === "--status") {
        if (!engineOk) return { code: 127, stdout: "", stderr: "aither-setup: not found" };
        return { code: 0, stdout: `${JSON.stringify({ configured: false, caps })}\n`, stderr: "" };
      }
      if (c0 === "aither-setup" && rest[0] === "--probe") {
        return { code: 0, stdout: `${JSON.stringify({ caps, configured: false, data_mount: "/var/mnt/fleet-src",
          suggestion: { mode: "adopt", name: "david", adopt_home: "/var/mnt/fleet-src/home/david", uid: 1000, gid: 1000 } })}\n`, stderr: "" };
      }
      if (c0 === "openssl") return { code: 0, stdout: "$6$abc$HASHEDVALUE\n", stderr: "" };
      if (c0 === "install" || c0 === "rm") return { code: 0, stdout: "", stderr: "" };
      if (c0 === "aither-setup" && rest.includes("--seed")) {
        const lines = [
          { event: "phase", phase: "account" },
          { event: "step", step: "user", ok: true, note: "created user david" },
          // a buggy engine line that echoes the token: the desk must redact it
          { event: "step", step: "sign in", ok: true, note: `stored ${AWNIX_TOKEN}` },
        ];
        if (failApply) lines.push({ event: "error", message: failApply });
        else lines.push({ event: "done", user: "david", uid: 1000, sudo_mode: "password", needs_restart: true, restart_reasons: ["wsl.conf"] });
        for (const l of lines) opts.onStdoutLine?.(JSON.stringify(l));
        return { code: failApply ? 1 : 0, stdout: "", stderr: "" };
      }
      if (c0 === "whoami") return { code: 0, stdout: "david\n", stderr: "" };
      if (c0 === "id") return { code: 0, stdout: "1000\n", stderr: "" };
      if (c0 === "runuser" && cmd.includes("sudo")) return { code: 1, stdout: "", stderr: "a password is required" };
      if (c0 === "systemctl") return { code: 0, stdout: "active\n", stderr: "" };
      if (c0 === "runuser" && cmd.includes("adk")) return { code: 0, stdout: "Logged in as david\n", stderr: "" };
      if (c0 === "runuser") return { code: 0, stdout: "/usr/local/bin/awsh\n", stderr: "" };
      if (c0 === "cat" && String(rest[0]).endsWith("packs.json")) {
        return { code: 0, stdout: JSON.stringify({ capability_profiles: ["customer-core"], packs: ["aither-core"] }), stderr: "" };
      }
      if (c0 === "cat") return { code: 0, stdout: "AITHER_LLM_BACKEND=auto\n", stderr: "" };
      if (c0 === "findmnt") return { code: 0, stdout: "/dev/sdd[/home/david]\n", stderr: "" };
      return { code: 0, stdout: "", stderr: "" };
    },
  };
  return { runner, calls };
}

function tmpHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "setup-wizard-"));
}

async function wizardWith(opts = {}) {
  const idp = await fakeIdp(opts.idp);
  const browser = fakeBrowser();
  const { runner, calls } = fakeRunner(opts.runner);
  const logs = [];
  const home = tmpHome();
  const prov = new Provisioner({ runner, log: (m) => logs.push(m) });
  const wiz = new SetupWizard({
    provisioner: prov, runner, idp: idp.base, openExternal: browser.open, hostname: "WORKSTATION",
    homeDir: home, platform: "linux", sleep: () => Promise.resolve(), ports: opts.ports,
    loopbackTimeoutMs: opts.loopbackTimeoutMs ?? 5000, lock: maintenanceLock({ file: path.join(home, "maint.lock") }),
  });
  wiz.on("log", (m) => logs.push(m));
  return { idp, browser, runner, calls, logs, home, wiz, prov };
}

test("one click: loopback sign-in, two machine sessions, apply, verify -- and no token leaks", async () => {
  const w = await wizardWith();
  try {
    const pre = await w.wiz.preflight();
    assert.equal(pre.ready, true);
    assert.equal(pre.probe.suggestion.mode, "adopt");

    const who = await w.wiz.signIn();
    assert.equal(who.username, "david");
    assert.equal(who.via, "loopback");
    assert.equal(JSON.stringify(who).includes("SECRET"), false);
    assert.equal(JSON.stringify(who).includes("secret"), false);
    // the browser opened ONCE, on the IdP, with PKCE S256 and a fixed loopback port
    assert.equal(w.browser.opened.length, 1);
    const au = new URL(w.browser.opened[0]);
    assert.equal(au.searchParams.get("code_challenge_method"), "S256");
    assert.match(au.searchParams.get("redirect_uri"), /^http:\/\/127\.0\.0\.1:4894[0-4]\/callback$/);
    // both machines named, both approved with the OIDC bearer, nothing else approved
    assert.deepEqual(w.idp.seen.deviceNames, ["desk@WORKSTATION", "awnix@WORKSTATION"]);
    assert.deepEqual(w.idp.seen.approved, ["U0-CODE", "U1-CODE"]);

    const events = [];
    const answers = { mode: "adopt", name: "david", adoptHome: "/var/mnt/fleet-src/home/david", uid: 1000, gid: 1000,
      password: "correct horse battery", sudo: "password", packs: ["customer-core"], inference: { backend: "local" } };
    const res = await w.wiz.apply(answers, (e) => events.push(e));
    assert.equal(answers.password, "", "the plaintext must be dropped after hashing");
    assert.equal(res.user, "david");
    assert.equal(res.needsRestart, true);

    // the password crossed ONLY as stdin of openssl; the seed carries the hash
    const ossl = w.calls.find((c) => c.cmd[0] === "openssl");
    assert.deepEqual(ossl.cmd, ["openssl", "passwd", "-6", "-stdin"]);
    assert.equal(ossl.input, "correct horse battery\n");
    const seedCall = w.calls.find((c) => c.cmd[0] === "install" && c.cmd.at(-1) === SEED_PATH);
    const seed = JSON.parse(seedCall.input);
    assert.equal(seed.user.password_hash, "$6$abc$HASHEDVALUE");
    assert.equal(seed.user.password, undefined);
    assert.equal(seed.user.sudo, "password");
    assert.equal(seed.login.mode, "token_file");
    assert.equal(seed.user.adopt_home, "/var/mnt/fleet-src/home/david");
    const tokCall = w.calls.find((c) => c.cmd[0] === "install" && c.cmd.at(-1) === TOKEN_PATH);
    assert.deepEqual(tokCall.cmd.slice(0, 8), ["install", "-D", "-m", "600", "-o", "root", "-g", "root"]);
    assert.equal(JSON.parse(tokCall.input).access_token, AWNIX_TOKEN);
    assert.ok(w.calls.some((c) => c.cmd[0] === "install" && c.cmd.at(-1) === DESK_PRESENT));
    assert.ok(w.calls.some((c) => c.host && c.cmd.join(" ") === "--manage awnix --set-default-user david"));

    // Windows side: adk's AuthStore with the DESK session (not the awnix one)
    const auth = JSON.parse(fs.readFileSync(path.join(w.home, ".aither", "auth.json"), "utf8"));
    assert.equal(auth.version, 1);
    assert.equal(auth.profiles.portal.access_token, DESK_TOKEN);

    // THE invariant: no token in any argv, event, or log line -- ever
    const everyArgv = JSON.stringify(w.calls.map((c) => c.cmd));
    for (const t of [OIDC_TOKEN, DESK_TOKEN, AWNIX_TOKEN]) {
      assert.equal(everyArgv.includes(t), false, `token in argv: ${t}`);
      assert.equal(JSON.stringify(events).includes(t), false, `token in a progress event: ${t}`);
      assert.equal(w.logs.join("\n").includes(t), false, `token in a log line: ${t}`);
    }
    assert.ok(events.some((e) => e.event === "step" && e.note === "stored [redacted]"));
    // the OIDC bearer never went into awnix at all
    assert.equal(JSON.stringify(w.calls).includes(OIDC_TOKEN), false);
    // the maintenance lock is released after apply
    assert.equal(fs.existsSync(path.join(w.home, "maint.lock")), false);

    const rows = await w.wiz.verify();
    const byId = Object.fromEntries(rows.map((r) => [r.id, r]));
    assert.equal(byId["default-user"].ok, true);
    assert.equal(byId.uid.ok, true);
    assert.equal(byId.sudo.ok, true, "password sudo: sudo -n must FAIL");
    assert.equal(byId.daemon.ok, true);
    assert.equal(byId["signed-in"].ok, true);
    assert.equal(byId.packs.ok, true);
    assert.equal(byId["windows-auth"].ok, true);
    assert.equal(byId.backend.ok, null, "local backend is could-not-judge, never green");
  } finally {
    await w.idp.close();
  }
});

test("all loopback ports busy -> device flow opened in the browser, still no typing", async () => {
  const blocker = http.createServer(() => {});
  await new Promise((r) => blocker.listen(0, "127.0.0.1", r));
  const busy = blocker.address().port;
  const w = await wizardWith({ ports: [busy] });
  try {
    // The fake browser "approves" the device link by having the IdP mark it authorized.
    w.wiz.d.openExternal = async (url) => {
      w.browser.opened.push(url);
      const uc = new URL(url).searchParams.get("user_code");
      await fetch(`${w.idp.base}/auth/device/authorize?user_code=${uc}`, { method: "POST", headers: { Authorization: `Bearer ${OIDC_TOKEN}` } });
    };
    const fallbacks = [];
    w.wiz.on("signin-fallback", (e) => fallbacks.push(e.reason));
    const who = await w.wiz.signIn();
    assert.deepEqual(fallbacks, ["ports_busy"]);
    assert.equal(who.via, "device");
    assert.match(w.browser.opened[0], /\/link\?user_code=/);
  } finally {
    await w.idp.close();
    await new Promise((r) => blocker.close(r));
  }
});

test("a denied or forged sign-in is refused", async () => {
  for (const mode of ["deny", "badnonce"]) {
    const w = await wizardWith({ idp: { mode } });
    try {
      await assert.rejects(w.wiz.signIn(), (e) => e instanceof oidc.SignInError);
      assert.equal(w.wiz.sessions, null);
      assert.deepEqual(w.idp.seen.approved, [], "no machine session may be approved");
    } finally {
      await w.idp.close();
    }
  }
});

test("the loopback listener answers only /callback with the right state and Host", async () => {
  const lb = await oidc.listenLoopback({ ports: [0] });
  try {
    const p = lb.waitForCode({ state: "S1", timeoutMs: 3000 });
    const base = `http://127.0.0.1:${lb.port}`;
    assert.equal((await fetch(`${base}/other?code=x&state=S1`)).status, 404);
    assert.equal((await fetch(`${base}/callback?code=x&state=WRONG`)).status, 400);
    const r = await new Promise((resolve) => {
      http.get({ host: "127.0.0.1", port: lb.port, path: "/callback?code=x&state=S1", headers: { Host: "evil.example:80" } },
        (res) => { res.resume(); resolve(res.statusCode); });
    });
    assert.equal(r, 404, "a rebinding Host header is refused");
    const ok = await fetch(`${base}/callback?code=THECODE&state=S1`);
    assert.equal(ok.status, 200);
    assert.match(await ok.text(), /return to AitherOS/);
    assert.equal(await p, "THECODE");
  } finally {
    await lb.close();
  }
});

test("an engine error surfaces as a failed apply and the lock is released", async () => {
  const w = await wizardWith({ runner: { failApply: "/var/mnt/fleet-src is not mounted" } });
  try {
    await w.wiz.signIn();
    await assert.rejects(w.wiz.apply({ mode: "create", name: "david", password: "longenough1", sudo: "password" }),
      /not mounted/);
    assert.equal(fs.existsSync(path.join(w.home, "maint.lock")), false);
    assert.ok(w.calls.some((c) => c.cmd[0] === "rm" && c.cmd.includes(TOKEN_PATH)), "tmpfs token removed on failure");
  } finally {
    await w.idp.close();
  }
});

test("an old image is detected before anything runs", async () => {
  const w = await wizardWith({ runner: { caps: ["seed"] } });
  try {
    const pre = await w.wiz.preflight();
    assert.equal(pre.ready, false);
    assert.ok(pre.status.missingCaps.includes("progress_json"));
    assert.equal(w.calls.some((c) => c.cmd.includes("--seed")), false);
  } finally {
    await w.idp.close();
  }
});

test("buildSeed: password sudo needs a password; NOPASSWD and locked are explicit opt-ins", () => {
  assert.throws(() => buildSeed({ mode: "create", name: "alice" }), /set a password/);
  assert.throws(() => buildSeed({ mode: "create", name: "alice", locked: true }), /passwordless/);
  assert.throws(() => buildSeed({ mode: "create", name: "Bad Name", sudo: "nopasswd" }), /user name/);
  assert.throws(() => buildSeed({ mode: "adopt", name: "david", adoptHome: "/x/home/david" }), /set a password/,
    "adopting a home whose ACCOUNT does not exist yet has no password to keep");
  const keep = buildSeed({ mode: "adopt", name: "david", adoptHome: "/var/mnt/fleet-src/home/david", uid: 1000, gid: 1000,
    accountExists: true });
  assert.equal(keep.user.login_password, "keep");
  assert.equal(keep.user.sudo, "password");
  assert.equal(keep.user.adopt_gid, 1000);
  const locked = buildSeed({ mode: "create", name: "alice", sudo: "nopasswd", locked: true });
  assert.equal(locked.user.login_password, "locked");
  const hashed = buildSeed({ mode: "create", name: "alice" }, { passwordHash: "$6$x$y" });
  assert.equal(hashed.user.password_hash, "$6$x$y");
  assert.equal(hashed.capability_packs[0], "customer-core");
  assert.throws(() => buildSeed({ name: "a", sudo: "nopasswd", inference: { backend: "mesh", url: "javascript:x" } }), /http/);
});

test("mergeAuthStore keeps other profiles and writes adk's shape", () => {
  const prev = JSON.stringify({ version: 1, active_profile: "other", profiles: { other: { access_token: "o" } } });
  const out = JSON.parse(mergeAuthStore(prev, { access_token: "t", user: { username: "d" } }, "https://idp/identity"));
  assert.equal(out.active_profile, "portal");
  assert.equal(out.profiles.other.access_token, "o");
  assert.equal(out.profiles.portal.access_token, "t");
});

test("WslRunner builds argv with --exec and never a shell string", () => {
  const r = new WslRunner({ distro: "awnix" });
  assert.deepEqual(r.argv(["aither-setup", "--probe", "--json"]), ["-d", "awnix", "-u", "root", "--exec", "aither-setup", "--probe", "--json"]);
  assert.deepEqual(r.argv(["whoami"], { user: null }), ["-d", "awnix", "--exec", "whoami"]);
});

test("renewal is due 7 days before expiry", () => {
  const now = Date.parse("2026-10-01T00:00:00Z");
  assert.equal(SetupWizard.needsRenewal("2026-10-05T00:00:00Z", now), true);
  assert.equal(SetupWizard.needsRenewal("2026-10-20T00:00:00Z", now), false);
  assert.equal(SetupWizard.needsRenewal("", now), false);
});

test("maintenance lock refuses while fresh and only removes its own", async () => {
  const home = tmpHome();
  const file = path.join(home, "l");
  fs.writeFileSync(file, "{}");
  const a = maintenanceLock({ file });
  assert.equal(await a.acquire(), false);
  await a.release();
  assert.ok(fs.existsSync(file), "a lock we did not take is never removed");
  fs.unlinkSync(file);
  assert.equal(await a.acquire(), true);
  await a.release();
  assert.equal(fs.existsSync(file), false);
});

test("the door is everywhere: Start menu, tray, palette, jump list, --setup", () => {
  const reg = require("./command-registry.cjs");
  const cmd = reg.byId("setup.open");
  assert.ok(cmd, "no setup.open command");
  for (const s of ["tray", "palette", "jumplist"]) assert.ok(cmd.surfaces.includes(s), s);
  const main = fs.readFileSync(path.join(__dirname, "main.cjs"), "utf8");
  assert.match(main, /case "setup\.open":/);
  assert.match(main, /argv\.includes\("--setup"\)/);
  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "package.json"), "utf8"));
  assert.equal(pkg.build.nsis.include, "build/installer.nsh");
  const nsh = fs.readFileSync(path.join(__dirname, "..", "build", "installer.nsh"), "utf8");
  assert.ok(nsh.includes('"$SMPROGRAMS\\Set up Aither.lnk" "$INSTDIR\\${APP_EXECUTABLE_FILENAME}" "--setup"'),
    "the Start-menu shortcut must launch the desk with --setup");
  assert.ok(pkg.build.win.extraResources.some((r) => r.to === "aither-setup/aither-setup.py"));
});

test("the setup page is sandboxed, names no colour and never asks for a token", () => {
  const html = fs.readFileSync(path.join(__dirname, "setup-window.html"), "utf8");
  const style = (html.match(/<style>[\s\S]*?<\/style>/) || [""])[0];
  assert.deepEqual(style.match(/#[0-9a-fA-F]{3,8}\b/g) || [], []);
  assert.match(html, /Content-Security-Policy" content="default-src 'none'/);
  assert.doesNotMatch(html, /innerHTML/);
  assert.doesNotMatch(html, /access_token|device_code/);
  const win = fs.readFileSync(path.join(__dirname, "setup-window.cjs"), "utf8");
  assert.match(win, /contextIsolation: true, nodeIntegration: false, sandbox: true/);
  assert.match(win, /setWindowOpenHandler\(\(\) => \(\{ action: "deny" \}\)\)/);
});

// ---- review fixes (2026-09-28) -------------------------------------------------------
const { fallbackCycle, MOUNT_ASSERT, ATTACH_TASK } = require("./awnix-provision.cjs");

function scriptedRunner(results) {
  const calls = [];
  const next = (key) => {
    const r = results[key];
    return typeof r === "function" ? r() : (r || { code: 0, stdout: "", stderr: "" });
  };
  return {
    calls, kind: "wsl", distro: "awnix",
    run: async (cmd) => { calls.push({ in: true, cmd }); return next(cmd[0] === "sh" ? "assert" : cmd[0]); },
    host: async (args) => { calls.push({ host: true, cmd: args }); return next("host"); },
  };
}
function scriptedExec(results) {
  const calls = [];
  return { calls, fn: async (exe, args) => { calls.push([exe, ...args]); return results[args[0]] || { code: 0, stdout: "", stderr: "" }; } };
}

test("fallback restart with the data-disk task: end -> terminate -> run task -> assert mounts", async () => {
  const runner = scriptedRunner({});
  const ex = scriptedExec({});
  const order = [];
  const origRun = runner.run; const origHost = runner.host; const origExec = ex.fn;
  runner.run = async (c) => { order.push(c[0] === "sh" ? "assert" : c[0]); return origRun(c); };
  runner.host = async (a) => { order.push(a[0]); return origHost(a); };
  const exec = async (e, a) => { order.push(a[0]); return origExec(e, a); };
  const r = await fallbackCycle({ runner, execFile: exec });
  assert.equal(r.ok, true);
  assert.equal(r.dataDisk, true);
  assert.deepEqual(order, ["/query", "/end", "--terminate", "/run", "assert"]);
  assert.ok(MOUNT_ASSERT.includes("mountpoint -q $d") && MOUNT_ASSERT.includes("/var/lib/containers"));
  assert.ok(ex.calls.every((c) => c.includes(ATTACH_TASK)));
});

test("fallback restart: data disk missing after boot is a FAILED restart, never ok", async () => {
  const runner = scriptedRunner({ assert: { code: 42, stdout: "", stderr: "" } });
  const ex = scriptedExec({});
  const r = await fallbackCycle({ runner, execFile: ex.fn });
  assert.equal(r.ok, false);
  assert.equal(r.dataDisk, false);
  assert.match(r.error, /data disk is not mounted/);
});

test("fallback restart: the attach task will not start -> refuse before booting awnix", async () => {
  const runner = scriptedRunner({});
  const ex = scriptedExec({ "/run": { code: 1, stdout: "", stderr: "denied" } });
  const r = await fallbackCycle({ runner, execFile: ex.fn });
  assert.equal(r.ok, false);
  assert.equal(runner.calls.some((c) => c.in), false, "awnix must not be booted without its data disk");
});

test("fallback restart without the task (a customer): terminate + boot, no attach step", async () => {
  const runner = scriptedRunner({ systemctl: { code: 0, stdout: "running\n", stderr: "" } });
  const ex = scriptedExec({ "/query": { code: 1, stdout: "", stderr: "not found" } });
  const r = await fallbackCycle({ runner, execFile: ex.fn });
  assert.equal(r.ok, true);
  assert.equal(ex.calls.some((c) => c.includes("/run") || c.includes("/end")), false);
  assert.equal(runner.calls.some((c) => c.cmd[0] === "sh"), false);
});

test("a failed apply keeps desk-present (the [oobe] terminal must not start its own setup)", async () => {
  const calls = [];
  const runner = {
    kind: "wsl", distro: "awnix",
    run: async (cmd) => {
      calls.push(cmd);
      if (cmd[0] === "openssl") return { code: 0, stdout: "$6$abc$HASHEDVALUE\n", stderr: "" };
      if (cmd.includes("--seed")) return { code: 1, stdout: JSON.stringify({ event: "error", message: "boom" }) + "\n", stderr: "" };
      return { code: 0, stdout: "", stderr: "" };
    },
    host: async () => ({ code: 0, stdout: "", stderr: "" }),
  };
  const prov = new Provisioner({ runner });
  const wiz = new SetupWizard({ runner, provisioner: prov });
  wiz.sessions = { desk: { access_token: "d-token-12345678" }, awnix: { access_token: "a-token-12345678" } };
  await assert.rejects(wiz.apply({ name: "david", password: "correct horse", sudo: "password" }));
  const rms = calls.filter((c) => c[0] === "rm");
  assert.ok(rms.length > 0, "staging must be cleared");
  assert.equal(rms.some((c) => c.includes(DESK_PRESENT)), false, "desk-present removed by a failed apply");
  assert.ok(rms.some((c) => c.includes(TOKEN_PATH)), "the one-shot token must be removed");
});
