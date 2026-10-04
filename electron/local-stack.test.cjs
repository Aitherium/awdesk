"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const EventEmitter = require("node:events");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { PassThrough } = require("node:stream");
const ls = require("./local-stack.cjs");

const CODE = "dc_0123456789abcdefghijklmnop";
const BEARER = "oidc-bearer-0123456789";

function tmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "ls-test-"));
}

function res(status, body) {
  return { status, json: async () => body, text: async () => (typeof body === "string" ? body : JSON.stringify(body)) };
}

/** A bash that prints what install.sh would, then exits `rc`. Records argv and env. */
function fakeSpawn(lines, rc = 0, seen = {}) {
  return (cmd, args, opts) => {
    Object.assign(seen, { cmd, args, env: opts.env, script: fs.readFileSync(args[0], "utf8") });
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    setImmediate(() => {
      for (const l of lines) child.stdout.write(`${l}\n`);
      child.stdout.end();
      child.stderr.end();
      setImmediate(() => child.emit("close", rc));
    });
    return child;
  };
}

test("parseProgress reads the install.sh progress line and nothing else", () => {
  assert.deepEqual(ls.parseProgress("@@aither-step awdk ok"), { step: "awdk", status: "ok", detail: "" });
  assert.deepEqual(ls.parseProgress("@@aither-step mesh fail adk pair did not complete"),
    { step: "mesh", status: "fail", detail: "adk pair did not complete" });
  assert.equal(ls.parseProgress("@@aither-step awdk bogus"), null);
  assert.equal(ls.parseProgress("  [OK] awdk installed"), null);
});

test("childEnv drops the AppImage/Electron leaks and puts ~/.local/bin first", () => {
  const env = ls.childEnv({ HOME: "/home/deck", PATH: "/usr/bin", LD_LIBRARY_PATH: "/tmp/.mount_x/usr/lib",
    APPIMAGE: "/x", ELECTRON_RUN_AS_NODE: "1" }, { AITHER_PROGRESS: "1" });
  assert.equal(env.LD_LIBRARY_PATH, undefined);
  assert.equal(env.APPIMAGE, undefined);
  assert.equal(env.ELECTRON_RUN_AS_NODE, undefined);
  assert.equal(env.PATH, "/home/deck/.local/bin:/usr/bin");
  assert.equal(env.AITHER_PROGRESS, "1");
});

test("mintSetupCode approves the code IT minted, with the bearer, and returns the device_code", async () => {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url, auth: (init.headers || {}).Authorization });
    if (url.endsWith("/auth/device/code")) return res(200, { device_code: CODE, user_code: "WXYZ-1234" });
    if (url.includes("/auth/device/authorize?user_code=WXYZ-1234")) return res(200, { status: "authorized" });
    return res(404, {});
  };
  const code = await ls.mintSetupCode({ idp: "https://idp.aitherium.com/identity", accessToken: BEARER,
    clientName: "Aither Desktop on deck", fetchImpl });
  assert.equal(code, CODE);
  assert.equal(calls[1].auth, `Bearer ${BEARER}`);
  await assert.rejects(ls.mintSetupCode({ accessToken: BEARER, fetchImpl: async (u) =>
    (u.endsWith("/code") ? res(200, { device_code: CODE, user_code: "A" }) : res(403, {})) }), /HTTP 403/);
  await assert.rejects(ls.mintSetupCode({ accessToken: "", fetchImpl }), /not signed in/);
});

test("fetchInstaller takes only aitherium.com https, and only a script", async () => {
  await assert.rejects(ls.fetchInstaller({ url: "https://evil.example/install.sh", fetchImpl: async () => res(200, "#!") }),
    /refusing/);
  await assert.rejects(ls.fetchInstaller({ fetchImpl: async () => res(200, "<!doctype html>") }), /not come back as a script/);
  assert.match(await ls.fetchInstaller({ fetchImpl: async () => res(200, "#!/usr/bin/env bash\necho hi\n") }), /^#!/);
});

function stackWith({ lines, rc = 0, seen = {}, dir = tmp(), env = { HOME: "/nonexistent", PATH: "/usr/bin" } } = {}) {
  return new ls.LocalStack({
    spawn: fakeSpawn(lines, rc, seen),
    openExternal: async () => {},
    fetchImpl: async () => res(200, "#!/usr/bin/env bash\n# install.sh\n"),
    stateFile: path.join(dir, "state.json"),
    tmpDir: dir,
    platform: "linux",
    env,
    signIn: async () => ({ accessToken: BEARER, claims: { email: "tester@test.invalid" } }),
    mint: async ({ accessToken }) => { assert.equal(accessToken, BEARER); return CODE; },
  });
}

test("run: code in the ENVIRONMENT, never argv; steps drawn; secrets redacted; remembered", async () => {
  const seen = {};
  const stack = stackWith({ seen, lines: [
    "@@aither-step python ok Python 3.13.1",
    "@@aither-step awdk running",
    `curl said something about ${CODE}`,
    "@@aither-step awdk ok",
    "@@aither-step mesh ok node-abc",
    "\u001b[32m[OK]\u001b[0m done",
  ] });
  const events = [];
  stack.on("progress", (e) => events.push(e));
  const snap = await stack.run();
  assert.equal(snap.state, "done");
  assert.equal(seen.cmd, "bash");
  assert.deepEqual(seen.args.slice(1), ["--non-interactive", "--skip-desk"]);
  assert.ok(!seen.args.join(" ").includes(CODE), "the setup code reached argv");
  assert.equal(seen.env.AITHER_SETUP_CODE, CODE);
  assert.equal(seen.env.AITHER_PROGRESS, "1");
  assert.equal(snap.steps.signin.status, "ok");
  assert.equal(snap.steps.signin.detail, "tester@test.invalid");
  assert.equal(snap.steps.awdk.status, "ok");
  assert.equal(snap.steps.mesh.detail, "node-abc");
  const text = JSON.stringify(events) + JSON.stringify(snap);
  assert.ok(!text.includes(CODE) && !text.includes(BEARER), "a secret reached the window");
  assert.ok(snap.log.includes("[OK] done"), "ANSI colours were not stripped");
  assert.equal(snap.remembered.done, true);
  assert.equal(stack.maybeAutoStart(), false, "auto-start must happen once, not on every launch");
});

test("run: a failed install is reported, not dressed up as done", async () => {
  const stack = stackWith({ rc: 1, lines: ["@@aither-step awdk fail exit 1"] });
  const snap = await stack.run();
  assert.equal(snap.state, "failed");
  assert.equal(snap.steps.awdk.status, "fail");
  assert.equal(snap.remembered.done, false);
});

test("run: a sign-in failure stops before anything is fetched or run", async () => {
  let spawned = false;
  const dir = tmp();
  const stack = new ls.LocalStack({
    spawn: () => { spawned = true; },
    openExternal: async () => {},
    fetchImpl: async () => { throw new Error("must not fetch"); },
    stateFile: path.join(dir, "s.json"), tmpDir: dir, platform: "linux", env: { PATH: "/usr/bin" },
    signIn: async () => { throw new Error("timed out waiting for approval"); },
  });
  const snap = await stack.run();
  assert.equal(snap.state, "failed");
  assert.equal(snap.steps.signin.status, "fail");
  assert.equal(spawned, false);
});

test("maybeAutoStart: never on Windows, never where adk is already installed", () => {
  const dir = tmp();
  const win = new ls.LocalStack({ platform: "win32", stateFile: path.join(dir, "w.json"), env: {} });
  assert.equal(win.maybeAutoStart(), false);
  const bin = path.join(dir, "bin");
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, "adk"), "#!/bin/sh\n", { mode: 0o755 });
  const setUp = new ls.LocalStack({ platform: "linux", stateFile: path.join(dir, "l.json"),
    env: { HOME: dir, PATH: bin } });
  if (process.platform !== "win32") assert.equal(setUp.maybeAutoStart(), false);
});

test("signInNoTyping reuses Desk's saved login when it is live, and signs in only without one", async () => {
  let browser = 0;
  const session = (savedState) => ({
    readAuthStoreToken: () => ({ token: "saved-session-token", username: "deck-owner" }),
    checkToken: async (t) => { assert.equal(t, "saved-session-token"); return { state: savedState, username: "owner" }; },
    signInWithBrowser: async () => { browser += 1; return { token: "fresh", username: "owner", via: "loopback" }; },
  });
  const reused = await ls.signInNoTyping({ openExternal: async () => {}, session: session("valid") });
  assert.equal(reused.via, "saved");
  assert.equal(reused.accessToken, "saved-session-token");
  assert.equal(browser, 0, "a live saved login must not open the browser");
  const fresh = await ls.signInNoTyping({ openExternal: async () => {}, session: session("invalid") });
  assert.equal(fresh.accessToken, "fresh");
  assert.equal(browser, 1);
});

// The installer lives in the monorepo, not in the public awdesk mirror: judged where it exists.
const INSTALL_SH = path.join(__dirname, "..", "..", "..", "AitherOS", "apps", "AitherVeil", "public", "install.sh");
test("install.sh emits the progress lines this window reads", { skip: !fs.existsSync(INSTALL_SH) && "monorepo only" }, () => {
  const sh = fs.readFileSync(INSTALL_SH, "utf8");
  assert.match(sh, /AITHER_PROGRESS/);
  assert.match(sh, /@@aither-step %s %s %s/);
  assert.match(sh, /report_setup\(\) \{\n {2}progress "\$1" "\$2"/);
});
