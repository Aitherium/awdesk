"use strict";

/**
 * desk-session.cjs -- which Aitherium account the AitherDesktop window and the
 * overlay are signed in as, and how they get signed in. Electron-free: every I/O
 * edge is injected, so desk-session.test.cjs runs it under `node --test`.
 *
 * Owner, 2026-10-01: "AITHERDESKTOP DOESNT SHOW ME AS SIGNED IN ... THERE IS NOWHERE
 * TO EVEN SIGN IN". Measured cause, three parts:
 *
 *   1. The windows (partition persist:living-desktop) got a session from ONE place:
 *      the platform vault's AITHER_PORTAL_TOKEN, through a Python vault reader at a
 *      hard-coded C:\AitherOS-Fresh path that shells into a WSL distro. The user's own
 *      login -- %USERPROFILE%\.aither\auth.json, written by `adk login` and by
 *      "Set up Aither", the file adk, awsettings, AitherConnect and the PyQt
 *      AitherDesktop already read -- was never consulted. Measured 2026-10-01: that
 *      file's token answers 200 at idp /auth/me AND as the aither_auth_token cookie at
 *      api.aitherium.com/api/me/profile.
 *   2. ANY cookie counted as signed in. A revoked or expired one blocked every
 *      refresh forever (the old code returned early on presence), so the shell
 *      rendered signed-out with a cookie the desk thought was fine.
 *   3. "Sign in…" navigated the OVERLAY to aitherium.com/login. The AitherDesktop app
 *      window -- the one the owner was looking at -- never moved.
 *
 * So: a cookie is VALIDATED (Identity /auth/me) before it counts; a dead one is
 * replaced from auth.json, then from the vault (the owner box's last resort); and
 * Sign in runs the desk's own OIDC flow in the system browser (desk-oidc.cjs: the
 * browser already holds the idp.aitherium.com session, so nothing is typed), mints
 * this machine's desk session, writes it to auth.json (one login for every local
 * tool) and hands it to both windows.
 *
 * No token is ever logged or returned to a renderer; callers in the main process get
 * the token BODY only to set the partition cookie.
 */

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const oidc = require("./desk-oidc.cjs");

/** Profiles tried in order after the store's own active_profile. */
const PROFILE_ORDER = Object.freeze(["portal", "cloud"]);
/** A token this close to expiry is not handed to a window that keeps it for days. */
const EXPIRY_SKEW_MS = 5 * 60 * 1000;
const CHECK_TIMEOUT_MS = 8000;
/** The cookie contract (Veil lib/auth-cookie.ts): name, domain, 30-day life. */
const COOKIE_NAME = "aither_auth_token";
const COOKIE_DOMAIN = ".aitherium.com";
const COOKIE_MAX_AGE_S = 30 * 24 * 60 * 60;

/** An auth.json profile endpoint is Aitherium's only when it is https on aitherium.com. */
function isAitheriumEndpoint(raw) {
  try {
    const u = new URL(String(raw || ""));
    const h = u.hostname.toLowerCase();
    return u.protocol === "https:" && (h === "aitherium.com" || h.endsWith(".aitherium.com"));
  } catch {
    return false;
  }
}

/**
 * The best usable Aitherium token in an auth.json text, or null.
 * Skips: the `local` profile (a loopback gateway key, not an Identity session), any
 * profile whose endpoint is not Aitherium's, and any token at or near expiry.
 */
function pickAuthStoreToken(text, { now = Date.now() } = {}) {
  let store;
  try {
    store = JSON.parse(String(text || ""));
  } catch {
    return null;
  }
  const profiles = store && typeof store.profiles === "object" && store.profiles ? store.profiles : {};
  const order = [];
  for (const name of [store.active_profile, ...PROFILE_ORDER, ...Object.keys(profiles)]) {
    if (typeof name === "string" && name && !order.includes(name)) order.push(name);
  }
  for (const name of order) {
    const p = profiles[name];
    if (!p || typeof p !== "object") continue;
    const token = typeof p.access_token === "string" ? p.access_token.trim() : "";
    if (!token || !isAitheriumEndpoint(p.endpoint)) continue;
    const exp = Date.parse(p.expires_at || "");
    if (Number.isFinite(exp) && exp - now < EXPIRY_SKEW_MS) continue;
    const user = p.user && typeof p.user === "object" ? p.user : {};
    return {
      token,
      profile: name,
      username: String(user.username || ""),
      expiresAt: Number.isFinite(exp) ? exp : null,
    };
  }
  return null;
}

function authStorePath(homeDir = os.homedir()) {
  return path.join(homeDir, ".aither", "auth.json");
}

function readAuthStoreToken({ homeDir = os.homedir(), fsImpl = fs, now = Date.now() } = {}) {
  try {
    return pickAuthStoreToken(fsImpl.readFileSync(authStorePath(homeDir), "utf8"), { now });
  } catch {
    return null;
  }
}

/**
 * Ask Identity whether a token is a live session.
 * valid = 200 with a user · invalid = 401/403 (revoked, expired, unknown) ·
 * unknown = anything else, offline included -- an unreachable IdP must never sign
 * the owner OUT of a window that works.
 */
async function checkToken(token, { idp = oidc.DEFAULT_IDP, fetchImpl = globalThis.fetch, timeoutMs = CHECK_TIMEOUT_MS } = {}) {
  if (!token) return { state: "invalid", username: "" };
  let base;
  try {
    base = oidc.checkIdp(idp);
  } catch {
    return { state: "unknown", username: "" };
  }
  const ctl = typeof AbortController === "function" ? new AbortController() : null;
  const timer = ctl ? setTimeout(() => ctl.abort(), timeoutMs) : null;
  try {
    const res = await fetchImpl(`${base}/auth/me`, {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
      signal: ctl ? ctl.signal : undefined,
    });
    if (res.status === 401 || res.status === 403) return { state: "invalid", username: "" };
    if (res.status !== 200) return { state: "unknown", username: "" };
    let body = {};
    try {
      body = await res.json();
    } catch {
      body = {};
    }
    return { state: "valid", username: String((body && (body.username || body.preferred_username)) || "") };
  } catch {
    return { state: "unknown", username: "" };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Decide what the partition cookie should be.
 *
 *   cookieToken   the aither_auth_token value the partition holds now ("" if none)
 *   authStore()   => pickAuthStoreToken result | null
 *   vault()       => Promise<string>  the owner box's vault token ("" if none)
 *   check(token)  => Promise<{state, username}>
 *
 * Resolves { action: "keep"|"set"|"clear"|"none", token?, source, username, state }.
 * "set" carries the token the caller writes; "clear" means the cookie is dead and
 * nothing replaces it (the window must offer Sign in, not pretend).
 */
async function resolveSession({ cookieToken = "", authStore = () => null, vault = async () => "", check }) {
  let cookieDead = false;
  if (cookieToken) {
    const v = await check(cookieToken);
    if (v.state !== "invalid") {
      return { action: "keep", source: "cookie", username: v.username, state: v.state };
    }
    cookieDead = true;
  }
  const stored = authStore();
  if (stored && stored.token && stored.token !== cookieToken) {
    const v = await check(stored.token);
    if (v.state !== "invalid") {
      return {
        action: "set", token: stored.token, source: `auth.json:${stored.profile}`,
        username: v.username || stored.username, state: v.state, expiresAt: stored.expiresAt,
      };
    }
  }
  let vaultToken;
  try {
    vaultToken = String((await vault()) || "").trim();
  } catch {
    vaultToken = "";
  }
  if (vaultToken && vaultToken !== cookieToken) {
    const v = await check(vaultToken);
    if (v.state !== "invalid") {
      return { action: "set", token: vaultToken, source: "vault", username: v.username, state: v.state };
    }
  }
  return { action: cookieDead ? "clear" : "none", source: "", username: "", state: "signed-out" };
}

/** The Electron cookies.set() details for a token (canonical Veil contract). */
function cookieDetails(token, { now = Date.now(), expiresAt = null } = {}) {
  const cap = Math.floor(now / 1000) + COOKIE_MAX_AGE_S;
  const exp = Number.isFinite(expiresAt) && expiresAt ? Math.min(cap, Math.floor(expiresAt / 1000)) : cap;
  return {
    url: "https://aitherium.com",
    name: COOKIE_NAME,
    value: token,
    domain: COOKIE_DOMAIN,
    path: "/",
    secure: true,
    // Veil's contract is httpOnly FALSE: the shell's client code reads this cookie
    // (lib/auth-cookie.ts). An httpOnly copy is a second variant the shell cannot see.
    httpOnly: false,
    sameSite: "lax",
    // Without an expiry Electron keeps a SESSION cookie that dies with the app, and
    // the next launch starts signed-out again.
    expirationDate: exp,
  };
}

/**
 * "Sign in…": the system browser, the desk's own OIDC client, this machine's desk
 * session, auth.json. Resolves { token, username, expiresAt, via } -- the token for
 * the caller's cookie only.
 *
 * deps: openExternal(url) (required), fetchImpl, idp, hostname, homeDir, fsImpl,
 * plus the desk-oidc test seams (ports, createServer, sleep, now, loopbackTimeoutMs),
 * and `writeAuth(tokenBody)` to override the auth.json writer.
 */
async function signInWithBrowser(deps = {}) {
  const d = {
    idp: oidc.DEFAULT_IDP, fetchImpl: globalThis.fetch, hostname: os.hostname(),
    homeDir: os.homedir(), fsImpl: fs, ...deps,
  };
  if (typeof d.openExternal !== "function") throw new TypeError("openExternal is required");
  const common = { idp: d.idp, openExternal: d.openExternal, fetchImpl: d.fetchImpl };
  const host = String(d.hostname || "this-pc").split(".")[0].slice(0, 40);
  let got;
  try {
    got = await oidc.signInLoopback({
      ...common, ports: d.ports, timeoutMs: d.loopbackTimeoutMs, createServer: d.createServer,
    });
  } catch (e) {
    if (!(e instanceof oidc.SignInError) || !["ports_busy", "timeout"].includes(e.code)) throw e;
    got = await oidc.signInDevice({ ...common, hostname: host, sleep: d.sleep, now: d.now });
  }
  let body;
  try {
    body = await oidc.mintMachineSession({
      ...common, accessToken: got.accessToken, clientName: `desk@${host}`, sleep: d.sleep, now: d.now,
    });
  } finally {
    got.accessToken = null;
  }
  const write = d.writeAuth || ((tokenBody) => writeAuthStore(tokenBody, d));
  await write(body);
  const user = body.user || {};
  const exp = Date.parse(body.expires_at || "");
  return {
    token: body.access_token,
    username: String(user.username || (got.claims && got.claims.preferred_username) || ""),
    expiresAt: Number.isFinite(exp) ? exp : null,
    via: got.via,
  };
}

/** Atomic auth.json write in the SAME shape "Set up Aither" writes (setup-wizard.cjs). */
function writeAuthStore(tokenBody, { homeDir = os.homedir(), fsImpl = fs, idp = oidc.DEFAULT_IDP } = {}) {
  // Lazy: setup-wizard pulls in the awnix provisioner, which a desk that never signs
  // in has no reason to load.
  const { mergeAuthStore } = require("./setup-wizard.cjs");
  const file = authStorePath(homeDir);
  fsImpl.mkdirSync(path.dirname(file), { recursive: true });
  let existing = "";
  try {
    existing = fsImpl.readFileSync(file, "utf8");
  } catch {
    /* first login on this machine */
  }
  const tmp = `${file}.desk.tmp`;
  fsImpl.writeFileSync(tmp, mergeAuthStore(existing, tokenBody, idp), { encoding: "utf8", mode: 0o600 });
  fsImpl.renameSync(tmp, file);
  return file;
}

/** One line for a menu row: who the windows are signed in as. */
function accountLine(account) {
  if (!account || account.state === "signed-out" || !account.signedIn) return "Not signed in";
  return account.username ? `Signed in as ${account.username}` : "Signed in";
}

module.exports = {
  COOKIE_NAME, COOKIE_DOMAIN, COOKIE_MAX_AGE_S, EXPIRY_SKEW_MS, PROFILE_ORDER,
  isAitheriumEndpoint, pickAuthStoreToken, authStorePath, readAuthStoreToken, checkToken,
  resolveSession, cookieDetails, signInWithBrowser, writeAuthStore, accountLine,
};
