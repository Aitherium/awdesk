"use strict";

/**
 * browser-sync-fake.cjs -- a local stand-in for the platform's preferences store, for
 * tests only (browser-sync.test.cjs, browser-parity-smoke.cjs).
 *
 * It keeps the rules of the real one (Veil /api/settings/preferences in front of
 * AitherDirectory /directory/self/preferences) that shape the sync: the user comes from
 * the bearer, a PUT is an RFC 7386 merge-patch per namespace, a namespace that ends
 * empty is removed, a stale If-Match is 409, a namespace over 16 KiB or a user over
 * 256 KiB is 413 and nothing is written. Sizes are counted the way Directory counts
 * them (compact JSON, sorted keys, non-ASCII as \uXXXX).
 *
 * It is not the platform: it does not verify a token or strip credential-shaped keys.
 */

const http = require("node:http");

const NAMESPACE_BYTES = 16 * 1024;
const TOTAL_BYTES = 256 * 1024;

function sorted(value) {
  if (Array.isArray(value)) return value.map(sorted);
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map((k) => [k, sorted(value[k])]));
  return value;
}

function jsonSize(value) {
  return Buffer.byteLength(JSON.stringify(sorted(value)).replace(/[\u0080-\uffff]/g, "\\uXXXX"));
}

function deepMerge(base, patch) {
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) return patch;
  const out = base && typeof base === "object" && !Array.isArray(base) ? { ...base } : {};
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) delete out[key];
    else out[key] = deepMerge(out[key], value);
  }
  return out;
}

/**
 * @param {{tokens?: Record<string, string>}} opts bearer -> user; any other bearer is 401.
 * @returns {Promise<{origin: string, users: Map, stats: object, close: () => Promise<void>, failNext: (status: number) => void}>}
 */
function startFakeStore({ tokens = { "test-token": "owner" } } = {}) {
  const users = new Map(); // user -> { prefs, rev }
  const stats = { gets: 0, puts: 0, conflicts: 0, refused: 0 };
  let fail = 0;
  const entry = (user) => {
    if (!users.has(user)) users.set(user, { prefs: {}, rev: 1 });
    return users.get(user);
  };
  const send = (res, status, body, etag) => {
    res.writeHead(status, { "content-type": "application/json", ...(etag ? { etag } : {}) });
    res.end(JSON.stringify(body));
  };
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      if (new URL(req.url, "http://x").pathname !== "/api/settings/preferences") return send(res, 404, { error: "not found" });
      const bearer = String(req.headers.authorization || "").replace(/^Bearer\s+/i, "");
      const user = tokens[bearer];
      if (!user) return send(res, 401, { error: "Unauthorized" });
      if (fail) { const status = fail; fail = 0; return send(res, status, { error: "preferences store unavailable" }); }
      const e = entry(user);
      const etag = () => `"rev-${e.rev}"`;
      if (req.method === "GET") { stats.gets += 1; return send(res, 200, { preferences: e.prefs }, etag()); }
      if (req.method !== "PUT") return send(res, 405, { error: "method" });
      let body;
      try { body = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { return send(res, 422, { error: "invalid JSON" }); }
      const patch = body && body.preferences;
      if (!patch || typeof patch !== "object" || Array.isArray(patch) || !Object.keys(patch).length) return send(res, 422, { error: "preferences must be an object of namespaces" });
      for (const v of Object.values(patch)) if (!v || typeof v !== "object" || Array.isArray(v)) return send(res, 422, { error: "each namespace must be an object" });
      const ifMatch = String(req.headers["if-match"] || "").trim();
      if (ifMatch && ifMatch !== "*" && ifMatch !== etag()) { stats.conflicts += 1; return send(res, 409, { error: "precondition_failed" }, etag()); }
      const merged = { ...e.prefs };
      for (const [ns, p] of Object.entries(patch)) {
        merged[ns] = deepMerge(e.prefs[ns], p);
        if (!Object.keys(merged[ns]).length) delete merged[ns];
        else if (jsonSize(merged[ns]) > NAMESPACE_BYTES) { stats.refused += 1; return send(res, 413, { error: "namespace_too_large", namespace: ns }); }
      }
      if (jsonSize(merged) > TOTAL_BYTES) { stats.refused += 1; return send(res, 413, { error: "preferences_too_large" }); }
      e.prefs = merged;
      e.rev += 1;
      stats.puts += 1;
      return send(res, 200, { ok: true, preferences: e.prefs }, etag());
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve({
      origin: `http://127.0.0.1:${server.address().port}`,
      users,
      stats,
      /** The next authenticated request answers this status (a store outage). */
      failNext: (status) => { fail = status; },
      /** Another app wrote to the same user between a pull and a push. */
      bump: (user = "owner") => { entry(user).rev += 1; },
      close: () => new Promise((done) => { server.closeAllConnections(); server.close(() => done()); }),
    }));
  });
}

module.exports = { NAMESPACE_BYTES, TOTAL_BYTES, jsonSize, startFakeStore };
