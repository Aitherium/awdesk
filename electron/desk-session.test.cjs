"use strict";

// node --test desk-session.test.cjs -- the AitherDesktop window's sign-in plane, with
// a FAKE Identity (fetch) and a fake filesystem. Nothing touches a real account.
//
// The owner's failure (2026-10-01): the AitherDesktop window showed signed-out while
// ~/.aither/auth.json held a valid login, and "Sign in" moved a different window.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const ds = require("./desk-session.cjs");
const oidc = require("./desk-oidc.cjs");

const NOW = Date.parse("2026-10-01T12:00:00Z");
const FUTURE = "2026-10-26T15:17:48.002028";
const PAST = "2026-09-01T00:00:00";

function store(profiles, active) {
  return JSON.stringify({ version: 1, active_profile: active, profiles });
}

/** A fake Identity /auth/me: `live` tokens answer 200, `dead` 401, anything else `status`. */
function fakeIdentity({ live = {}, dead = [], status = 503, seen = [] } = {}) {
  return async (url, init = {}) => {
    const auth = (init.headers && init.headers.Authorization) || "";
    const token = auth.replace(/^Bearer /, "");
    seen.push({ url, token });
    if (live[token]) return { status: 200, json: async () => ({ username: live[token] }) };
    if (dead.includes(token)) return { status: 401, json: async () => ({ detail: "Invalid or expired token" }) };
    return { status, json: async () => ({}) };
  };
}

test("auth.json: the adk `cloud` login is used when there is no portal profile", () => {
  const text = store({
    local: { endpoint: "local", access_token: "local-gateway-key-xx", expires_at: "" },
    cloud: { endpoint: "https://api.aitherium.com", access_token: "cloud-session-token-1", expires_at: FUTURE,
      user: { username: "david" } },
  }, "local");
  const got = ds.pickAuthStoreToken(text, { now: NOW });
  assert.equal(got.token, "cloud-session-token-1");
  assert.equal(got.profile, "cloud");
  assert.equal(got.username, "david");
});

test("auth.json: never the loopback `local` key, never an expired or foreign-endpoint token", () => {
  assert.equal(ds.pickAuthStoreToken(store({ local: { endpoint: "local", access_token: "k" } }, "local"), { now: NOW }), null);
  assert.equal(ds.pickAuthStoreToken(store({
    portal: { endpoint: "https://idp.aitherium.com/identity", access_token: "old-token", expires_at: PAST },
  }, "portal"), { now: NOW }), null);
  assert.equal(ds.pickAuthStoreToken(store({
    portal: { endpoint: "https://idp.evil.example", access_token: "foreign", expires_at: FUTURE },
  }, "portal"), { now: NOW }), null);
  assert.equal(ds.pickAuthStoreToken(store({
    portal: { endpoint: "http://idp.aitherium.com/identity", access_token: "plain-http", expires_at: FUTURE },
  }, "portal"), { now: NOW }), null);
  assert.equal(ds.pickAuthStoreToken("not json", { now: NOW }), null);
});

test("auth.json: the active profile wins over the fallback order", () => {
  const text = store({
    portal: { endpoint: "https://idp.aitherium.com/identity", access_token: "portal-tok", expires_at: FUTURE },
    cloud: { endpoint: "https://api.aitherium.com", access_token: "cloud-tok", expires_at: FUTURE },
  }, "cloud");
  assert.equal(ds.pickAuthStoreToken(text, { now: NOW }).token, "cloud-tok");
});

test("checkToken: 200 = valid with the username, 401 = invalid, offline = unknown (never signs out)", async () => {
  const fetchImpl = fakeIdentity({ live: { good: "david" }, dead: ["revoked"] });
  assert.deepEqual(await ds.checkToken("good", { fetchImpl }), { state: "valid", username: "david" });
  assert.equal((await ds.checkToken("revoked", { fetchImpl })).state, "invalid");
  assert.equal((await ds.checkToken("whatever", { fetchImpl })).state, "unknown");
  const offline = async () => { throw new Error("ENOTFOUND"); };
  assert.equal((await ds.checkToken("good", { fetchImpl: offline })).state, "unknown");
  assert.equal((await ds.checkToken("", { fetchImpl })).state, "invalid");
});

test("checkToken asks Identity's /auth/me over https with the token as a Bearer", async () => {
  const seen = [];
  await ds.checkToken("good", { fetchImpl: fakeIdentity({ live: { good: "david" }, seen }) });
  assert.equal(seen[0].url, `${oidc.DEFAULT_IDP}/auth/me`);
  assert.match(seen[0].url, /^https:\/\/idp\.aitherium\.com\//);
  assert.equal(seen[0].token, "good");
});

test("resolveSession: THE OWNER'S BUG -- no cookie, a valid auth.json login => set, no vault call", async () => {
  const check = (t) => ds.checkToken(t, { fetchImpl: fakeIdentity({ live: { "cloud-tok": "david" } }) });
  let vaultCalls = 0;
  const v = await ds.resolveSession({
    cookieToken: "",
    authStore: () => ({ token: "cloud-tok", profile: "cloud", username: "david", expiresAt: null }),
    vault: async () => { vaultCalls += 1; return "vault-tok"; },
    check,
  });
  assert.equal(v.action, "set");
  assert.equal(v.token, "cloud-tok");
  assert.equal(v.source, "auth.json:cloud");
  assert.equal(v.username, "david");
  assert.equal(vaultCalls, 0, "the vault is the LAST rung");
});

test("resolveSession: a REVOKED cookie no longer blocks the refresh (old code returned on presence)", async () => {
  const check = (t) => ds.checkToken(t, { fetchImpl: fakeIdentity({ live: { fresh: "david" }, dead: ["stale"] }) });
  const v = await ds.resolveSession({
    cookieToken: "stale",
    authStore: () => ({ token: "fresh", profile: "portal", username: "", expiresAt: null }),
    check,
  });
  assert.equal(v.action, "set");
  assert.equal(v.token, "fresh");
});

test("resolveSession: a valid cookie is kept; an unreachable IdP keeps it too", async () => {
  const keepValid = await ds.resolveSession({
    cookieToken: "cookie", check: (t) => ds.checkToken(t, { fetchImpl: fakeIdentity({ live: { cookie: "david" } }) }),
  });
  assert.equal(keepValid.action, "keep");
  assert.equal(keepValid.username, "david");
  const offline = await ds.resolveSession({
    cookieToken: "cookie", check: (t) => ds.checkToken(t, { fetchImpl: async () => { throw new Error("offline"); } }),
  });
  assert.equal(offline.action, "keep");
});

test("resolveSession: dead cookie, dead auth.json, vault good => vault; all dead => clear", async () => {
  const check = (t) => ds.checkToken(t, { fetchImpl: fakeIdentity({ live: { "vault-tok": "david" }, dead: ["c", "a"] }) });
  const v = await ds.resolveSession({
    cookieToken: "c", authStore: () => ({ token: "a", profile: "portal" }), vault: async () => "vault-tok", check,
  });
  assert.equal(v.action, "set");
  assert.equal(v.source, "vault");
  const allDead = (t) => ds.checkToken(t, { fetchImpl: fakeIdentity({ dead: ["c", "a", "v"] }) });
  const gone = await ds.resolveSession({
    cookieToken: "c", authStore: () => ({ token: "a", profile: "portal" }), vault: async () => "v", check: allDead,
  });
  assert.equal(gone.action, "clear", "a cookie Identity rejects must not stay and pretend");
  const nothing = await ds.resolveSession({ cookieToken: "", check: allDead });
  assert.equal(nothing.action, "none");
});

test("resolveSession: a throwing vault rung is just an empty rung", async () => {
  const v = await ds.resolveSession({
    cookieToken: "", vault: async () => { throw new Error("no python"); },
    check: async () => ({ state: "invalid", username: "" }),
  });
  assert.equal(v.action, "none");
});

test("cookieDetails: Veil's canonical cookie -- domain, Lax, Secure, NOT httpOnly, persistent", () => {
  const c = ds.cookieDetails("tok", { now: NOW });
  assert.equal(c.name, "aither_auth_token");
  assert.equal(c.domain, ".aitherium.com");
  assert.equal(c.path, "/");
  assert.equal(c.secure, true);
  assert.equal(c.httpOnly, false, "Veil lib/auth-cookie.ts: client code reads this cookie");
  assert.equal(c.sameSite, "lax");
  assert.equal(c.expirationDate, Math.floor(NOW / 1000) + ds.COOKIE_MAX_AGE_S, "a session cookie dies with the app");
  const soon = NOW + 3600_000;
  assert.equal(ds.cookieDetails("tok", { now: NOW, expiresAt: soon }).expirationDate, Math.floor(soon / 1000));
});

test("the Veil cookie contract still says what cookieDetails assumes", () => {
  const veil = path.join(__dirname, "..", "..", "..", "AitherOS", "apps", "AitherVeil", "src", "lib", "auth-cookie.ts");
  if (!fs.existsSync(veil)) return; // the public awdesk mirror carries no Veil
  const src = fs.readFileSync(veil, "utf8");
  assert.match(src, /AUTH_COOKIE_NAME = 'aither_auth_token'/);
  assert.match(src, /AUTH_COOKIE_MAX_AGE = 30 \* 24 \* 60 \* 60/);
  assert.match(src, /httpOnly is deliberately FALSE/);
});

test("signInWithBrowser: loopback PKCE -> desk@HOST machine session -> auth.json (portal profile)", async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "desk-session-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  fs.mkdirSync(path.join(home, ".aither"));
  fs.writeFileSync(path.join(home, ".aither", "auth.json"), store({
    cloud: { endpoint: "https://api.aitherium.com", access_token: "keep-me", expires_at: FUTURE },
  }, "cloud"));
  const calls = [];
  const orig = { loop: oidc.signInLoopback, mint: oidc.mintMachineSession };
  oidc.signInLoopback = async (args) => {
    calls.push(["loopback", typeof args.openExternal]);
    return { accessToken: "oidc-access", claims: { preferred_username: "david" }, via: "loopback" };
  };
  oidc.mintMachineSession = async (args) => {
    calls.push(["mint", args.clientName, args.accessToken]);
    return { access_token: "desk-session", token_type: "bearer", expires_at: FUTURE, user: { username: "david" } };
  };
  t.after(() => { oidc.signInLoopback = orig.loop; oidc.mintMachineSession = orig.mint; });

  const got = await ds.signInWithBrowser({ openExternal: async () => {}, hostname: "DESKTOP-1.lan", homeDir: home });
  assert.equal(got.token, "desk-session");
  assert.equal(got.username, "david");
  assert.equal(got.via, "loopback");
  assert.deepEqual(calls[1], ["mint", "desk@DESKTOP-1", "oidc-access"]);
  const saved = JSON.parse(fs.readFileSync(path.join(home, ".aither", "auth.json"), "utf8"));
  assert.equal(saved.profiles.portal.access_token, "desk-session");
  assert.equal(saved.profiles.cloud.access_token, "keep-me", "the adk login beside it survives");
  assert.equal(ds.pickAuthStoreToken(JSON.stringify(saved), { now: NOW }).token, "desk-session");
});

test("signInWithBrowser: busy ports fall back to the device flow; other errors propagate", async (t) => {
  const orig = { loop: oidc.signInLoopback, dev: oidc.signInDevice, mint: oidc.mintMachineSession };
  t.after(() => { oidc.signInLoopback = orig.loop; oidc.signInDevice = orig.dev; oidc.mintMachineSession = orig.mint; });
  oidc.signInLoopback = async () => { throw new oidc.SignInError("busy", "ports_busy"); };
  oidc.signInDevice = async () => ({ accessToken: "dev-access", claims: {}, via: "device" });
  oidc.mintMachineSession = async () => ({ access_token: "desk-2", user: { username: "d" } });
  const written = [];
  const got = await ds.signInWithBrowser({ openExternal: async () => {}, writeAuth: (b) => written.push(b.access_token) });
  assert.equal(got.via, "device");
  assert.deepEqual(written, ["desk-2"]);
  oidc.signInLoopback = async () => { throw new oidc.SignInError("denied", "access_denied"); };
  await assert.rejects(ds.signInWithBrowser({ openExternal: async () => {}, writeAuth: () => {} }), /denied/);
  await assert.rejects(ds.signInWithBrowser({}), /openExternal is required/);
});

test("accountLine: names the account, never a token", () => {
  assert.equal(ds.accountLine({ signedIn: true, username: "david", state: "valid" }), "Signed in as david");
  assert.equal(ds.accountLine({ signedIn: false, state: "signed-out" }), "Not signed in");
  assert.equal(ds.accountLine(null), "Not signed in");
});

// ── wiring: the windows use this plane, and the menu says who is signed in ──────────

const ldw = fs.readFileSync(path.join(__dirname, "living-desktop-window.cjs"), "utf8");
const main = fs.readFileSync(path.join(__dirname, "main.cjs"), "utf8");

test("living-desktop-window: the session comes from desk-session, auth.json before the vault", () => {
  assert.match(ldw, /require\("\.\/desk-session\.cjs"\)/);
  assert.match(ldw, /deskSession\.resolveSession\(/);
  assert.match(ldw, /authStore: \(\) => deskSession\.readAuthStoreToken\(\)/);
  assert.doesNotMatch(ldw, /if \(await hasSessionCookie\(\)\) return;/, "presence must never short-circuit validation");
});

test("living-desktop-window: Sign in reaches the AitherDesktop APP window, not only the overlay", () => {
  const body = ldw.slice(ldw.indexOf("function beginSignIn()"), ldw.indexOf("let signInPoll"));
  assert.match(body, /deskSession\.signInWithBrowser\(/);
  assert.match(body, /reloadSignedInWindows\(\)/);
  const reload = ldw.slice(ldw.indexOf("function reloadSignedInWindows()"), ldw.indexOf("let signInRunning"));
  assert.match(reload, /isAppOpen\(\)/);
  assert.match(reload, /appWin\.loadURL/);
  const fallback = ldw.slice(ldw.indexOf("function signInInWindow()"), ldw.indexOf("async function signOut()"));
  assert.match(fallback, /isAppOpen\(\) \? appWin/);
});

test("main: the menu context carries the account and the tray re-renders when it changes", () => {
  assert.match(main, /account: desktopAccount\(\)/);
  assert.match(main, /onDesktopAccountChange\(/);
  assert.match(main, /case "desktop\.signout": return void signOutDesktop\(\)/);
});

test("registry: the sign-in row says who is signed in; sign-out exists only when signed in", () => {
  const { COMMANDS } = require("./command-registry.cjs");
  const signin = COMMANDS.find((c) => c.id === "desktop.signin");
  const signout = COMMANDS.find((c) => c.id === "desktop.signout");
  assert.equal(signin.menuLabel({ account: { signedIn: true, username: "david" } }), "Signed in as david");
  assert.equal(signin.menuLabel({ account: { signedIn: false } }), "Sign in…");
  assert.equal(signin.menuLabel({}), "Sign in…");
  assert.equal(signout.when({ account: { signedIn: true } }), true);
  assert.equal(signout.when({}), false);
});
