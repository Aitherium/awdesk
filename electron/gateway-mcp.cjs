"use strict";

/**
 * gateway-mcp — the ONE MCP transport for the desk's platform data.
 *
 * Extracted from market-client.cjs (2026-08-25) when the system-awareness
 * client needed the same plumbing: Streamable-HTTP MCP to the LOCAL gateway
 * (127.0.0.1:8182), the session-bearer credential, node:http transport. One
 * transport, one identity story — every desk data client (market, system,
 * voice/vision when they land) speaks through this module.
 *
 * Measured traps this module exists to remember:
 * - `localhost` never: ::1:8182 refuses after ~2s while 127.0.0.1 answers in
 *   ms (monorepo CLAUDE.md doctrine).
 * - Both Accept headers are REQUIRED (text/event-stream alone 404s/stalls).
 * - An EMPTY Mcp-Session-Id on initialize makes the gateway look up session
 *   "" and answer "Session not found" — attach the header only once a
 *   session exists.
 * - node:http, NOT global fetch: the gateway is plain HTTP and undici's
 *   keep-alive handles die in libuv teardown (UV_HANDLE_CLOSING, exit 127),
 *   which poisoned the standalone self-test. (node:https for the cloud door.)
 *
 * OFF THE FLEET PC (2026-10-14). A second laptop has no 127.0.0.1:8182, and
 * every desk plane that rides this module (decisions, relay, market) showed
 * empty. The SAME gateway is published at https://mcp.aitherium.com/mcp and
 * accepts the same ~/.aither/session-bearer, so when the loopback door refuses
 * the socket (a transport failure -- never an HTTP verdict, which is the
 * gateway's own answer) the call is retried there and the desk stays on the
 * cloud door until LOOPBACK_RECHECK_MS passes, then tries loopback again.
 * A tools/call is replayed ONLY when it provably never reached loopback (the
 * socket never connected). A timeout or reset after connect may mean the tool
 * already ran -- ops_run, decisions_answer, relay_send are not idempotent and
 * the cloud door tunnels to the same fleet -- so that error is reported, never
 * replayed. A failure inside initialize (no tools/call sent yet) may fail over.
 * AWDESK_CLOUD_GATEWAY_URL overrides the cloud door ("off" disables it); an
 * explicit AWDESK_GATEWAY_URL (tests, a box with a non-default gateway) turns
 * the fallback off unless AWDESK_CLOUD_GATEWAY_URL is set too.
 */

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

// AWDESK_GATEWAY_URL exists for the test harness (a fake gateway on an
// ephemeral port) and for a box whose gateway is not on :8182. It is never
// `localhost` by default -- see the trap above.
const LOOPBACK_GATEWAY_URL = "http://127.0.0.1:8182";
const EXPLICIT_GATEWAY_URL = String(process.env.AWDESK_GATEWAY_URL || "").trim();
const GATEWAY_URL = String(EXPLICIT_GATEWAY_URL || LOOPBACK_GATEWAY_URL).replace(/\/+$/, "");
const DEFAULT_CLOUD_GATEWAY_URL = "https://mcp.aitherium.com";

/** The cloud door, or "" when there is none (see the header for the rules). */
function resolveCloudGatewayUrl(env = process.env, explicitPrimary = EXPLICIT_GATEWAY_URL) {
  const raw = env.AWDESK_CLOUD_GATEWAY_URL;
  if (raw !== undefined) {
    const v = String(raw).trim();
    if (!v || /^(off|none|0|false)$/i.test(v)) return "";
    return /^https?:\/\//i.test(v) ? v.replace(/\/+$/, "") : "";
  }
  return explicitPrimary ? "" : DEFAULT_CLOUD_GATEWAY_URL;
}
const CLOUD_GATEWAY_URL = resolveCloudGatewayUrl();
// How long the desk stays on the cloud door before trying loopback again. A
// refused loopback socket costs milliseconds, so the re-check is cheap.
const LOOPBACK_RECHECK_MS = 60 * 1000;
// Socket idle timeout per request. AWDESK_GATEWAY_TIMEOUT_MS exists for the
// test harness (a gateway that accepts and never answers).
const REQUEST_TIMEOUT_MS = Number(process.env.AWDESK_GATEWAY_TIMEOUT_MS) > 0
  ? Number(process.env.AWDESK_GATEWAY_TIMEOUT_MS)
  : 15000;
const MCP_ACCEPT = "application/json, text/event-stream";
const SESSION_TTL_MS = 10 * 60 * 1000;
const BEARER_FILE = process.env.AWDESK_SESSION_BEARER_FILE
  || path.join(os.homedir(), ".aither", "session-bearer");

function bearer() {
  try {
    return fs.readFileSync(BEARER_FILE, "utf8").trim();
  } catch {
    return "";
  }
}

let _session = null; // {id} — the MCP session, reused across calls
let _sessionAt = 0;
// Which door the session lives on. A session id is per gateway, so switching
// doors always forgets it.
let _active = GATEWAY_URL;
let _activeSince = 0;

/** Forget the MCP session (tests; a gateway that restarted answers 404 on the
 *  old id, and the next ensureSession re-initializes). Also returns to the
 *  primary door, so a test starts from a known place. */
function resetSession() {
  _session = null;
  _sessionAt = 0;
  _active = GATEWAY_URL;
  _activeSince = 0;
  _probe = null;
}

function useGateway(url) {
  if (_active === url) return;
  _active = url;
  _activeSince = Date.now();
  _session = null;
  _sessionAt = 0;
}

/** Where calls go right now: {active, primary, cloud, remote}. `remote` is
 *  true while the desk is on the cloud door because loopback refused. */
function gatewayStatus() {
  return {
    active: _active,
    primary: GATEWAY_URL,
    cloud: CLOUD_GATEWAY_URL,
    remote: Boolean(CLOUD_GATEWAY_URL) && _active === CLOUD_GATEWAY_URL && _active !== GATEWAY_URL,
  };
}

/** The request provably never reached the door: the socket never connected
 *  (refused, unreachable, DNS). Safe to replay ANY call elsewhere. A timeout or
 *  reset after connect is NOT this -- the gateway may have run the tool. An HTTP
 *  status is the gateway's own verdict and is reported, never routed around. */
function isTransportError(error) {
  if (!error) return false;
  if (error.delivered === true) return false;
  if (error.transport === true) return true;
  return /ECONNREFUSED|EHOSTUNREACH|ENETUNREACH|ENOTFOUND|EAI_AGAIN/i
    .test(`${error.code || ""} ${error.message || ""}`);
}

/** Any socket-level failure (incl. timeout/reset after connect). Only safe to
 *  fail over on when no tools/call was in flight (see callToolNow). */
function isSocketError(error) {
  return Boolean(error) && (error.transport === true || error.delivered === true);
}

/**
 * Does the primary (loopback) door answer at all? Any HTTP status counts; only
 * a refused/timed-out socket is "no". Cached for LOOPBACK_RECHECK_MS so a poll
 * loop does not probe on every tick. Never rejects.
 */
let _probe = null; // {at, ok}
function primaryReachable({ timeoutMs = 2000, now = Date.now } = {}) {
  if (_probe && now() - _probe.at < LOOPBACK_RECHECK_MS) return Promise.resolve(_probe.ok);
  return new Promise((resolve) => {
    const settle = (ok) => {
      _probe = { at: now(), ok };
      resolve(ok);
    };
    let req;
    try {
      const client = /^https:/i.test(GATEWAY_URL) ? require("node:https") : require("node:http");
      req = client.request(`${GATEWAY_URL}/health`, { method: "GET", timeout: timeoutMs, headers: { Connection: "close" } }, (res) => {
        res.resume();
        settle(true);
      });
    } catch {
      settle(false);
      return;
    }
    req.on("timeout", () => req.destroy(new Error("probe timeout")));
    req.on("error", () => settle(false));
    req.end();
  });
}

async function mcpCall(method, params) {
  const headers = {
    "Content-Type": "application/json",
    Accept: MCP_ACCEPT,
    Authorization: `Bearer ${bearer()}`,
    Connection: "close",
  };
  if (_session) headers["Mcp-Session-Id"] = _session.id;
  const body = JSON.stringify({ jsonrpc: "2.0", id: String(Date.now()), method, params });
  const base = _active;
  return await new Promise((resolve, reject) => {
    const client = /^https:/i.test(base) ? require("node:https") : require("node:http");
    const req = client.request(
      `${base}/mcp`,
      { method: "POST", headers, timeout: REQUEST_TIMEOUT_MS },
      (res) => {
        let text = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => { text += chunk; });
        res.on("end", () => {
          const sid = res.headers["mcp-session-id"];
          if (sid) {
            _session = { id: sid };
            _sessionAt = Date.now();
          }
          // A non-2xx is the gateway's OWN verdict (503 billing_unavailable
          // {"error":"identity_unreachable",...} when Identity is down, 401/403
          // on a bad bearer), not a JSON-RPC envelope: its `error` is a STRING,
          // so reading `.error.message` off it printed "initialize failed:
          // undefined" to the palette (measured 2026-09-19). Reject with the
          // status and the sentence the gateway gave, so an outage reads as
          // UNREACHABLE (exit 1), never as MODULE BROKEN (exit 2).
          if (res.statusCode < 200 || res.statusCode >= 300) {
            const j = parseMaybeJson(text) || {};
            // j.error is an OBJECT on a JSON-RPC envelope: printed raw it read
            // "HTTP 404: [object Object]" in the Ops pane (owner, 2026-10-04).
            const why = j.message || j.reason || (j.error != null ? errorText(j.error) : "") || text.slice(0, 120) || res.statusMessage;
            const retry = res.headers["retry-after"] ? ` (retry-after ${res.headers["retry-after"]})` : "";
            const err = new Error(`HTTP ${res.statusCode}: ${why}${retry}`);
            err.status = res.statusCode;
            return reject(err);
          }
          try {
            if (text.trim().startsWith("event:")) {
              const dataLine = text.split("\n").find((l) => l.startsWith("data:"));
              if (!dataLine) return reject(new Error("MCP SSE without data line"));
              resolve(JSON.parse(dataLine.slice(5).trim()));
            } else {
              resolve(JSON.parse(text));
            }
          } catch (error) {
            reject(error);
          }
        });
      },
    );
    // Did the socket connect? After that the body may have reached the gateway
    // and the tool may be running, so the error must not be replayed elsewhere.
    let connected = false;
    req.on("socket", (sock) => {
      if (!sock.connecting) connected = true;
      else sock.once("connect", () => { connected = true; });
    });
    req.on("timeout", () => req.destroy(new Error("gateway timeout")));
    req.on("error", (error) => {
      if (error && typeof error === "object") {
        if (connected) error.delivered = true;
        else error.transport = true;
      }
      reject(error);
    });
    req.write(body);
    req.end();
  });
}

/** A JSON-RPC error is `{code,message}`; a gateway verdict is a plain string
 *  or `{error,reason,message}`. One reader for both, never "undefined". */
function errorText(e) {
  if (e == null) return "unknown error";
  if (typeof e === "string") return e;
  return e.message || e.reason || e.error || JSON.stringify(e);
}

async function ensureSession() {
  if (!bearer()) throw new Error("no session bearer");
  if (_session && Date.now() - _sessionAt < SESSION_TTL_MS) return;
  const init = await mcpCall("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "desk", version: "1" },
  });
  if (init.error) throw new Error(`initialize failed: ${errorText(init.error)}`);
  await mcpCall("notifications/initialized", {}).catch(() => {});
}

/**
 * Call one gateway tool by name; resolves the joined text content. Throws on
 * any failure — callers wrap and turn it into their {ok:false, reason} shape.
 */
// One tool call at a time on the shared MCP session. Measured 2026-10-10: the secrets
// page fired list_secrets, workspace_secrets_list and lockbox_user_list together; each
// answers in < 1 s alone, but in parallel on one session the second sat until the 15 s
// socket timeout ("platform vault: gateway timeout"). Queued, the three take < 1 s.
let _queue = Promise.resolve();
function callTool(name, args = {}) {
  const run = _queue.then(() => callToolNow(name, args));
  _queue = run.catch(() => {});
  return run;
}

async function callToolNow(name, args = {}) {
  // On the cloud door long enough: give loopback another chance (the PC woke,
  // the fleet came back). A refusal falls straight back below.
  if (_active !== GATEWAY_URL && Date.now() - _activeSince >= LOOPBACK_RECHECK_MS) {
    useGateway(GATEWAY_URL);
  }
  try {
    return await callOnActive(name, args);
  } catch (error) {
    if (!CLOUD_GATEWAY_URL || _active === CLOUD_GATEWAY_URL || !canFailOver(error)) throw error;
    useGateway(CLOUD_GATEWAY_URL);
    return await callOnActive(name, args);
  }
}

/** Replay on the cloud door only if the tool provably did not run on loopback:
 *  the tools/call never connected, or the failure was in initialize. */
function canFailOver(error) {
  if (isTransportError(error)) return true;
  return Boolean(error) && error.beforeToolCall === true && isSocketError(error);
}

async function sessionOrTag() {
  try {
    await ensureSession();
  } catch (error) {
    if (error && typeof error === "object") error.beforeToolCall = true;
    throw error;
  }
}

async function callOnActive(name, args) {
  await sessionOrTag();
  let res;
  try {
    res = await mcpCall("tools/call", { name, arguments: args });
  } catch (error) {
    // A 404 on a held session id means the gateway restarted and forgot it:
    // re-initialize once instead of failing every call until the TTL lapses.
    if (!error || error.status !== 404 || !_session) throw error;
    _session = null;
    _sessionAt = 0;
    await sessionOrTag();
    res = await mcpCall("tools/call", { name, arguments: args });
  }
  if (res?.error) throw new Error(`${name}: ${errorText(res.error)}`);
  const content = res?.result?.content;
  if (!content) throw new Error(`${name}: no content`);
  return content.map((c) => c.text ?? "").join("\n");
}

/** Some tools answer prose, some JSON — try JSON, else hand back the prose. */
function parseMaybeJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

module.exports = {
  bearer,
  callTool,
  errorText,
  canFailOver,
  gatewayStatus,
  isTransportError,
  parseMaybeJson,
  primaryReachable,
  resetSession,
  resolveCloudGatewayUrl,
  CLOUD_GATEWAY_URL,
  GATEWAY_URL,
  LOOPBACK_RECHECK_MS,
};

if (require.main === module) {
  // Self-test: one live round-trip through a cheap, side-effect-free tool.
  // Exit 0 = gateway reachable and the transport works; exit 1 = unreachable
  // (gateway/bearer); exit 2 = the module itself is broken.
  (async () => {
    try {
      const now = await callTool("time_now", {});
      console.log(`GATEWAY MCP OK via ${gatewayStatus().active}: ${String(now).slice(0, 80)}`);
      process.exit(0);
    } catch (error) {
      const msg = String(error?.message || error);
      if (/bearer|ECONNREFUSED|timeout|ETIMEDOUT|HTTP 5\d\d|HTTP 40[13]|unreachable/i.test(msg)) {
        console.error(`GATEWAY UNREACHABLE: ${msg.slice(0, 200)}`);
        process.exit(1);
      }
      console.error(`MODULE BROKEN: ${error && error.stack ? error.stack : error}`);
      process.exit(2);
    }
  })();
}
