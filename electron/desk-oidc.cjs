"use strict";

/**
 * desk-oidc.cjs — "Sign in with Aitherium" for the desk, with no typing.
 *
 * Owner, 2026-09-28, after being handed "run this python script in a terminal tab and
 * type a password": "WE NEED A BETTER WAY TO DO THIS." So:
 *
 *   1. LOOPBACK PKCE (RFC 8252). A one-shot listener binds the first free port of a
 *      FIXED set on 127.0.0.1 and the SYSTEM browser opens /oidc/authorize. The browser
 *      already holds the idp.aitherium.com session and first-party clients skip consent,
 *      so it bounces straight back: no code, no password. The ports are registered
 *      EXACTLY on the IdP (AitherIdentity.py _desk_oidc_redirect_uris), so no
 *      port-agnostic matcher widens the identity perimeter.
 *   2. FALLBACK (all five ports taken, or 120 s with no return): the device flow with
 *      verification_uri_complete opened in the same logged-in browser — one Approve
 *      click, still nothing typed.
 *   3. MACHINE SESSIONS. With the OIDC access token as the bearer, the desk starts a
 *      device code for each machine (Windows desk, awnix), approves THAT user_code
 *      itself (/auth/device/authorize resolves an OIDC bearer through get_current_user)
 *      and polls for the machine's own session. Auto-approval is bound to a code this
 *      function minted a moment earlier — never one from any other source.
 *
 * Nothing here logs or returns a token to a renderer; callers get token BODIES only
 * inside the main process. Electron-free: every I/O edge is injected, so
 * setup-wizard.test.cjs runs it against a fake IdP under `node --test`.
 */

const nodeCrypto = require("node:crypto");
const http = require("node:http");

const CLIENT_ID = "aitheros-desk";
const DEFAULT_IDP = "https://idp.aitherium.com/identity";
/** MUST equal AitherIdentity.py _DESK_LOOPBACK_PORTS (test_desk_oidc_client.py pins it). */
const LOOPBACK_PORTS = Object.freeze([48940, 48941, 48942, 48943, 48944]);
const LOOPBACK_TIMEOUT_MS = 120_000;
const SCOPE = "openid profile email";

class SignInError extends Error {
  constructor(message, code = "signin_failed") {
    super(message);
    this.name = "SignInError";
    this.code = code;
  }
}

function b64url(buf) {
  return Buffer.from(buf).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function randomToken(bytes = 32, randomBytes = nodeCrypto.randomBytes) {
  return b64url(randomBytes(bytes));
}

/** RFC 7636 S256 pair. */
function pkcePair(randomBytes = nodeCrypto.randomBytes) {
  const verifier = randomToken(48, randomBytes);
  const challenge = b64url(nodeCrypto.createHash("sha256").update(verifier).digest());
  return { verifier, challenge };
}

/** Only https, or http to a loopback literal (a test IdP). A bearer never rides plain http off-box. */
function checkIdp(base) {
  const u = new URL(String(base || DEFAULT_IDP));
  const loop = u.hostname === "127.0.0.1" || u.hostname === "[::1]" || u.hostname === "localhost";
  if (u.protocol !== "https:" && !(u.protocol === "http:" && loop)) {
    throw new SignInError(`refusing IdP ${u.origin}: tokens are only fetched over https`, "bad_idp");
  }
  return u.toString().replace(/\/+$/, "");
}

function redirectUri(port) {
  return `http://127.0.0.1:${port}/callback`;
}

function authorizeUrl({ idp, port, state, nonce, challenge, prompt = "" }) {
  const q = new URLSearchParams({
    response_type: "code", client_id: CLIENT_ID, redirect_uri: redirectUri(port), scope: SCOPE,
    state, nonce, code_challenge: challenge, code_challenge_method: "S256",
  });
  if (prompt) q.set("prompt", prompt);
  return `${checkIdp(idp)}/oidc/authorize?${q.toString()}`;
}

const DONE_PAGE = "<!doctype html><meta charset=utf-8><title>Signed in</title>"
  + "<body style=\"font:16px system-ui;background:#0f1218;color:#e8ecf2;display:grid;place-items:center;height:90vh\">"
  + "<div><h1 style=\"font-weight:600\">Signed in — return to AitherOS</h1>"
  + "<p>You can close this tab.</p></div>";
const FAIL_PAGE = "<!doctype html><meta charset=utf-8><title>Sign-in failed</title>"
  + "<body style=\"font:16px system-ui\"><h1>Sign-in did not complete</h1><p>Return to AitherOS and try again.</p>";

/**
 * Bind the first free port of `ports` on 127.0.0.1. Resolves { port, waitForCode, close }.
 * Rejects with code "ports_busy" when every port is taken.
 */
async function listenLoopback({ ports = LOOPBACK_PORTS, createServer = http.createServer } = {}) {
  let waiter = null;
  let expectedState = null;
  const server = createServer((req, res) => {
    let url;
    try {
      url = new URL(req.url, "http://127.0.0.1");
    } catch {
      res.writeHead(400).end();
      return;
    }
    // DNS rebinding: a page on another name that resolves to 127.0.0.1 carries its own Host.
    const host = String(req.headers.host || "");
    if (req.method !== "GET" || url.pathname !== "/callback" || host !== `127.0.0.1:${server.address()?.port}`) {
      res.writeHead(404, { "Content-Type": "text/plain" }).end("not found");
      return;
    }
    const state = url.searchParams.get("state") || "";
    if (!expectedState || state !== expectedState) {
      res.writeHead(400, { "Content-Type": "text/plain" }).end("state mismatch");
      return;
    }
    const code = url.searchParams.get("code") || "";
    const error = url.searchParams.get("error") || "";
    res.writeHead(code ? 200 : 400, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" })
      .end(code ? DONE_PAGE : FAIL_PAGE);
    const w = waiter;
    waiter = null;
    expectedState = null;
    if (w) {
      if (code) w.resolve(code);
      else w.reject(new SignInError(`the IdP returned ${error || "no code"}`, error || "no_code"));
    }
  });
  let bound = null;
  for (const port of ports) {
    try {
      await new Promise((resolve, reject) => {
        const onErr = (e) => { server.off("listening", onOk); reject(e); };
        const onOk = () => { server.off("error", onErr); resolve(); };
        server.once("error", onErr);
        server.once("listening", onOk);
        server.listen(port, "127.0.0.1");
      });
      bound = server.address().port;
      break;
    } catch (e) {
      if (e && e.code !== "EADDRINUSE" && e.code !== "EACCES") throw e;
    }
  }
  if (bound === null) throw new SignInError("every desk sign-in port is in use", "ports_busy");
  const close = () => new Promise((resolve) => server.close(() => resolve()));
  const waitForCode = ({ state, timeoutMs = LOOPBACK_TIMEOUT_MS }) => new Promise((resolve, reject) => {
    expectedState = state;
    const t = setTimeout(() => {
      waiter = null;
      expectedState = null;
      reject(new SignInError("no answer from the browser in time", "timeout"));
    }, timeoutMs);
    waiter = {
      resolve: (c) => { clearTimeout(t); resolve(c); },
      reject: (e) => { clearTimeout(t); reject(e); },
    };
  });
  return { port: bound, waitForCode, close };
}

async function readJson(res) {
  const text = await res.text();
  try {
    return text ? JSON.parse(text) : {};
  } catch {
    return {};
  }
}

async function exchangeCode({ idp, code, verifier, port, fetchImpl = fetch }) {
  const body = new URLSearchParams({
    grant_type: "authorization_code", code, client_id: CLIENT_ID,
    redirect_uri: redirectUri(port), code_verifier: verifier,
  });
  const res = await fetchImpl(`${checkIdp(idp)}/oidc/token`, {
    method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: body.toString(),
  });
  const doc = await readJson(res);
  if (res.status !== 200 || !doc.access_token) {
    throw new SignInError(`code exchange failed: HTTP ${res.status} ${doc.detail || ""}`.trim(), "exchange_failed");
  }
  return doc;
}

function jwtClaims(jwt) {
  const part = String(jwt || "").split(".")[1];
  if (!part) return null;
  try {
    return JSON.parse(Buffer.from(part.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8"));
  } catch {
    return null;
  }
}

/**
 * The id_token arrives straight from the token endpoint over TLS (OIDC Core 3.1.3.7:
 * TLS server validation stands in for the signature there), so the checks that matter
 * are the ones binding it to THIS request: nonce, audience, expiry.
 */
function checkIdToken(idToken, { nonce, now = Date.now() }) {
  const c = jwtClaims(idToken);
  if (!c) throw new SignInError("the IdP returned no id_token", "no_id_token");
  if (c.nonce !== nonce) throw new SignInError("id_token nonce mismatch", "nonce_mismatch");
  const aud = Array.isArray(c.aud) ? c.aud : [c.aud];
  if (!aud.includes(CLIENT_ID)) throw new SignInError("id_token audience mismatch", "aud_mismatch");
  if (typeof c.exp === "number" && c.exp * 1000 < now - 60_000) {
    throw new SignInError("id_token expired", "expired");
  }
  return c;
}

/** Loopback PKCE sign-in. Resolves { accessToken, claims }. */
async function signInLoopback({
  idp = DEFAULT_IDP, openExternal, fetchImpl = fetch, ports = LOOPBACK_PORTS,
  timeoutMs = LOOPBACK_TIMEOUT_MS, prompt = "", createServer, randomBytes = nodeCrypto.randomBytes,
} = {}) {
  if (typeof openExternal !== "function") throw new TypeError("openExternal is required");
  const lb = await listenLoopback({ ports, createServer });
  try {
    const { verifier, challenge } = pkcePair(randomBytes);
    const state = randomToken(24, randomBytes);
    const nonce = randomToken(24, randomBytes);
    const waiting = lb.waitForCode({ state, timeoutMs });
    waiting.catch(() => {}); // settled below; never an unhandled rejection meanwhile
    await openExternal(authorizeUrl({ idp, port: lb.port, state, nonce, challenge, prompt }));
    const code = await waiting;
    const tokens = await exchangeCode({ idp, code, verifier, port: lb.port, fetchImpl });
    const claims = checkIdToken(tokens.id_token, { nonce });
    return { accessToken: tokens.access_token, claims, via: "loopback" };
  } finally {
    await lb.close();
  }
}

async function postJson(fetchImpl, url, payload, headers = {}) {
  const res = await fetchImpl(url, {
    method: "POST", headers: { "Content-Type": "application/json", ...headers },
    body: payload === undefined ? undefined : JSON.stringify(payload),
  });
  return { status: res.status, body: await readJson(res) };
}

async function deviceStart({ idp = DEFAULT_IDP, clientName, fetchImpl = fetch }) {
  const { status, body } = await postJson(fetchImpl, `${checkIdp(idp)}/auth/device/code`,
    { client_name: String(clientName || "AitherOS desk").slice(0, 80) });
  if (status !== 200 || !body.device_code || !body.user_code) {
    throw new SignInError(`device-code start failed: HTTP ${status}`, "device_start_failed");
  }
  return body;
}

/** Identity's contract: pending = 200 {status:"authorization_pending"}; terminal = 400 {detail}. */
async function devicePoll({
  idp = DEFAULT_IDP, challenge, fetchImpl = fetch, sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  now = Date.now, maxWaitMs,
}) {
  let interval = Math.max(1, Number(challenge.interval || 5)) * 1000;
  const deadline = now() + (maxWaitMs ?? Math.max(30, Number(challenge.expires_in || 900)) * 1000);
  while (now() < deadline) {
    await sleep(interval);
    const { status, body } = await postJson(fetchImpl, `${checkIdp(idp)}/auth/device/token`,
      { device_code: challenge.device_code });
    if (status === 200 && body.access_token) return body;
    const st = body.error || body.status || body.detail || "";
    if (st === "authorization_pending") continue;
    if (st === "slow_down") {
      interval += 5000;
      continue;
    }
    throw new SignInError(`sign-in did not complete: HTTP ${status} ${st}`.trim(), st || "device_failed");
  }
  throw new SignInError("timed out waiting for approval", "timeout");
}

/** Fallback: the device flow approved with one click in the logged-in browser. */
async function signInDevice({ idp = DEFAULT_IDP, openExternal, fetchImpl = fetch, sleep, now, hostname = "" } = {}) {
  const ch = await deviceStart({ idp, fetchImpl, clientName: `AitherOS setup (${hostname || "this PC"})` });
  await openExternal(ch.verification_uri_complete || ch.verification_uri);
  const body = await devicePoll({ idp, challenge: ch, fetchImpl, sleep, now });
  const user = body.user || {};
  return {
    accessToken: body.access_token,
    claims: { preferred_username: user.username, email: user.email, sub: user.id },
    via: "device",
  };
}

/**
 * One machine's own session, approved with the wizard's bearer. The user_code approved
 * is the one THIS call just minted (the anti-phishing binding): the function never
 * accepts a code from its caller.
 */
async function mintMachineSession({ idp = DEFAULT_IDP, accessToken, clientName, fetchImpl = fetch, sleep, now }) {
  if (!accessToken) throw new SignInError("not signed in", "no_bearer");
  const ch = await deviceStart({ idp, clientName, fetchImpl });
  const url = `${checkIdp(idp)}/auth/device/authorize?user_code=${encodeURIComponent(ch.user_code)}`;
  const { status } = await postJson(fetchImpl, url, undefined, { Authorization: `Bearer ${accessToken}` });
  if (status !== 200) {
    throw new SignInError(`approving the ${clientName} session failed: HTTP ${status}`, "approve_failed");
  }
  return devicePoll({ idp, challenge: { ...ch, interval: 1 }, fetchImpl, sleep, now, maxWaitMs: 60_000 });
}

/** Every string a log line or progress event must never carry. */
function secretsOf(...bodies) {
  const out = [];
  for (const b of bodies) {
    if (!b) continue;
    if (typeof b === "string") out.push(b);
    else for (const k of ["access_token", "id_token", "refresh_token", "accessToken", "device_code"]) {
      if (typeof b[k] === "string" && b[k]) out.push(b[k]);
    }
  }
  return out.filter((s) => s.length >= 8);
}

function redact(text, secrets) {
  let s = String(text ?? "");
  for (const x of secrets || []) if (x) s = s.split(x).join("[redacted]");
  return s;
}

module.exports = {
  CLIENT_ID, DEFAULT_IDP, LOOPBACK_PORTS, LOOPBACK_TIMEOUT_MS, SignInError,
  pkcePair, checkIdp, redirectUri, authorizeUrl, listenLoopback, exchangeCode, jwtClaims,
  checkIdToken, signInLoopback, deviceStart, devicePoll, signInDevice, mintMachineSession,
  secretsOf, redact,
};
