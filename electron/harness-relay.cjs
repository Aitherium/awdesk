"use strict";

/**
 * harness-relay.cjs -- awsh's Shell tab, when AitherOS Online runs inside the desk.
 *
 * Veil's AitherShell (apps/aithershell.tsx) reaches a harness daemon through the
 * platform's /api/harness/<node>/... proxy. Inside the desk the daemon is on THIS machine
 * (127.0.0.1:8362), so the desk-hosted OS asks the desk instead: aither-host/1
 * os-daemon-call {target:"harness"} -> living-desktop preload -> this module -> :8362.
 *
 * Exactly the routes AitherShell calls, by method and shape; nothing else is relayed
 * (the daemon spawns agents with filesystem access). The harness token
 * (AITHER_HARNESS_TOKEN or ~/.aither/harness_token, as sessions-client.cjs reads it) is
 * added HERE, in main; it never reaches a renderer.
 */

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const DAEMON = process.env.AITHER_HARNESS_URL || "http://127.0.0.1:8362";
const ID = "[A-Za-z0-9_.:-]{1,128}";

/** [method, path regex (query string allowed only where AitherShell sends one)]. */
const ROUTES = Object.freeze([
  ["GET", /^\/sessions$/],
  ["GET", /^\/sessions\/unified$/],
  ["GET", /^\/harnesses$/],
  ["GET", /^\/profiles$/],
  ["GET", /^\/agents$/],
  ["GET", /^\/workforce$/],
  ["GET", /^\/fs\/list\?path=[^&#]*$/],
  ["GET", /^\/fs\/read\?path=[^&#]*$/],
  ["POST", /^\/fs\/write$/],
  ["GET", /^\/git\/status\?path=[^&#]*$/],
  ["GET", /^\/git\/diff\?path=[^&#]*(&staged=[01])?$/],
  ["GET", new RegExp(`^/sessions/${ID}/transcript(\\?[A-Za-z0-9_=&.%:-]*)?$`)],
  ["POST", /^\/sessions$/],
  ["POST", new RegExp(`^/sessions/${ID}/(input|message|resize|interrupt|focus)$`)],
  ["DELETE", new RegExp(`^/sessions/${ID}$`)],
]);

/** Is `method path` one AitherShell sends? Pure; rejects traversal and encoded slashes. */
function allowedRoute(method, p) {
  const m = String(method || "").toUpperCase();
  const route = String(p || "");
  if (!route.startsWith("/") || route.includes("..") || /%2f|%5c/i.test(route.split("?")[0])) return false;
  return ROUTES.some(([rm, rx]) => rm === m && rx.test(route));
}

function readHarnessToken(env = process.env, fsImpl = fs) {
  if (env.AITHER_HARNESS_TOKEN) return String(env.AITHER_HARNESS_TOKEN).trim();
  try {
    return fsImpl.readFileSync(path.join(os.homedir(), ".aither", "harness_token"), "utf8").trim();
  } catch {
    return "";
  }
}

/**
 * Relay one call. Never throws: {ok, status, data} like the overlay's daemon-call, or
 * {ok:false, error} when refused or unreachable.
 */
async function relayHarness(msg, { fetchImpl = globalThis.fetch, token = readHarnessToken, base = DAEMON } = {}) {
  const method = String((msg && msg.method) || "GET").toUpperCase();
  const p = String((msg && msg.path) || "");
  if (!allowedRoute(method, p)) return { ok: false, status: 403, error: `the desk does not relay ${method} ${p.split("?")[0]} to awsh` };
  const headers = { "Content-Type": "application/json" };
  const t = typeof token === "function" ? token() : "";
  if (t) headers.Authorization = `Bearer ${t}`;
  try {
    const res = await fetchImpl(`${base}${p}`, {
      method,
      headers,
      body: method === "GET" || method === "DELETE" ? undefined : JSON.stringify(msg && msg.body !== undefined ? msg.body : {}),
      signal: AbortSignal.timeout(method === "GET" ? 15_000 : 60_000),
    });
    const text = await res.text().catch(() => "");
    let data = null;
    try { data = text ? JSON.parse(text) : {}; } catch { data = { error: text.slice(0, 2000) }; }
    return { ok: res.ok, status: res.status, data, baseUrl: base };
  } catch (e) {
    return { ok: false, error: e && e.name === "TimeoutError" ? "awsh did not answer in time" : "no awsh harness daemon on this machine (adk harness serve)" };
  }
}

module.exports = { DAEMON, ROUTES, allowedRoute, readHarnessToken, relayHarness };
