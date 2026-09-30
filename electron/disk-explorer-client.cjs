"use strict";

/**
 * disk-explorer-client.cjs — the Disk Explorer's backend: the disk index
 * (files search / dupes / tree), the reclaim proposals, and the share lane.
 *
 * CONTRACT (the disk index contract, "Surfaces"): every surface calls ONLY
 * the Genesis storage endpoints, through the Veil `/api/storage/*` proxy. The
 * desk holds no credential of its own: requests ride the signed-in
 * aitherium.com session (the living-desktop partition cookie, same as the
 * inference widget), and Genesis derives WHICH nodes the caller may see from
 * that session. A `node` sent from here is a filter the server re-checks,
 * never an authorization claim.
 *
 *   GET  /api/storage/files/search?q=&node=&ext=&min_bytes=&newer_days=&limit=&cursor=
 *   GET  /api/storage/files/dupes?node=&min_bytes=&limit=     (min_bytes default 1 MiB)
 *   GET  /api/storage/files/tree?node=&path=&depth=
 *   GET  /api/storage/files/nodes                 the caller's nodes (+ tenant)
 *   GET  /api/storage/files/proposals?node=&limit= manage proposals, scope-filtered
 *   POST /api/storage/manage/proposals/{id}/card   RAISE the action's linked card
 *   POST /api/storage/share {node,path,seal?} -> a card-gated proposal (platform nodes)
 *   GET  /api/storage/shares
 *
 * The node id this machine speaks for is `awstorageWhoami()` -- AWSTORAGE_NODE,
 * then ~/.aither/node-id, then the hostname (the same order as `awstorage
 * whoami`) -- and the user can pick any node GET /files/nodes returns.
 *
 * There is deliberately NO approve / apply / delete verb here. Every destructive
 * outcome (dedup, archive, share of a platform disk) is a PROPOSAL; a human
 * answers its decision card in the Inbox or Veil.
 *
 * Failure is a rendered state: every verb resolves {ok:true, data} or
 * {ok:false, status, error[, signedOut]} and never rejects — "could not look"
 * must never read the same as "nothing indexed".
 */

const fs = require("node:fs");
const os = require("node:os");
const nodePath = require("node:path");
const { baseUrl } = require("./inference-widget.cjs");

const READ_TIMEOUT_MS = 15_000;
const WRITE_TIMEOUT_MS = 30_000;
// A node id as awstorage writes it (hostname or a config/nodes.yaml id).
const NODE_RE = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const MAX_PATH = 4096;
const MAX_QUERY = 512;
/** Default duplicate floor on every surface (contract A5): 1 MiB. */
const DEFAULT_MIN_BYTES = 1024 * 1024;
const NODE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;

/**
 * The node id this machine speaks for, in the order `awstorage whoami` uses:
 * env AWSTORAGE_NODE, then ~/.aither/node-id (written at enroll / host setup),
 * then the hostname. Returns {node, source}; never throws.
 */
function awstorageWhoami({ env = process.env, readFile = fs.readFileSync, homedir = os.homedir, hostname = os.hostname } = {}) {
  const fromEnv = String((env && env.AWSTORAGE_NODE) || "").trim();
  if (fromEnv) return { node: fromEnv, source: "env:AWSTORAGE_NODE" };
  const file = nodePath.join(homedir(), ".aither", "node-id");
  try {
    const text = String(readFile(file, "utf8")).trim();
    if (NODE_ID_RE.test(text)) return { node: text, source: `file:${file}` };
  } catch { /* no node-id file: fall through to the hostname */ }
  return { node: String(hostname()), source: "hostname" };
}

function qs(params) {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params || {})) {
    if (v === undefined || v === null || v === "") continue;
    q.set(k, String(v));
  }
  const s = q.toString();
  return s ? `?${s}` : "";
}

function validNode(node) {
  return typeof node === "string" && NODE_RE.test(node);
}

function validPath(p) {
  return typeof p === "string" && p.length > 0 && p.length <= MAX_PATH && !p.includes("\0");
}

/** Optional node filter: absent is fine, a malformed one is refused locally. */
function optNode(node) {
  if (node === undefined || node === null || node === "") return { ok: true, value: undefined };
  return validNode(node) ? { ok: true, value: node } : { ok: false, error: "bad node id" };
}

function posInt(v) {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : undefined;
}

function nonNegInt(v) {
  const n = Number(v);
  return Number.isInteger(n) && n >= 0 ? n : undefined;
}

class DiskExplorerClient {
  /**
   * @param {object} opts
   * @param {(url: string, init?: object) => Promise<Response>} opts.fetchImpl
   *   A fetch bound to the signed-in session (Electron `session.fetch`). Required:
   *   a bare global fetch carries no cookie and every call would read signed-out.
   * @param {string} [opts.base] origin override (tests); defaults to the
   *   inference widget's aitherium.com-family origin rule.
   */
  constructor({ fetchImpl, base } = {}) {
    if (typeof fetchImpl !== "function") throw new Error("DiskExplorerClient needs a session-bound fetchImpl");
    this.fetchImpl = fetchImpl;
    this.base = base || baseUrl();
  }

  async request(method, path, body, timeoutMs) {
    try {
      const init = {
        method,
        headers: { Accept: "application/json" },
        signal: AbortSignal.timeout(timeoutMs || READ_TIMEOUT_MS),
      };
      if (body !== undefined) {
        init.headers["Content-Type"] = "application/json";
        init.body = JSON.stringify(body);
      }
      const res = await this.fetchImpl(`${this.base}/api/storage${path}`, init);
      let data = null;
      try { data = await res.json(); } catch { data = null; }
      if (res.status === 401) return { ok: false, status: 401, signedOut: true, error: "not signed in to aitherium.com" };
      if (!res.ok) {
        const why = data && typeof data === "object" ? (data.error || data.detail) : null;
        return { ok: false, status: res.status, error: String(why || `HTTP ${res.status}`) };
      }
      return { ok: true, status: res.status, data: data ?? {} };
    } catch (error) {
      return { ok: false, status: 0, error: String((error && error.message) || error) };
    }
  }

  search(opts = {}) {
    const q = typeof opts.q === "string" ? opts.q.trim() : "";
    if (!q) return Promise.resolve({ ok: false, status: 0, error: "type something to search for" });
    if (q.length > MAX_QUERY) return Promise.resolve({ ok: false, status: 0, error: "query too long" });
    const node = optNode(opts.node);
    if (!node.ok) return Promise.resolve({ ok: false, status: 0, error: node.error });
    return this.request("GET", `/files/search${qs({
      q,
      node: node.value,
      ext: typeof opts.ext === "string" ? opts.ext.replace(/^\./, "").slice(0, 16) : undefined,
      min_bytes: nonNegInt(opts.minBytes ?? opts.minSize),
      newer_days: posInt(opts.newerDays),
      limit: posInt(opts.limit) || 100,
      cursor: typeof opts.cursor === "string" ? opts.cursor.slice(0, 256) : undefined,
    })}`);
  }

  dupes(opts = {}) {
    const node = optNode(opts.node);
    if (!node.ok) return Promise.resolve({ ok: false, status: 0, error: node.error });
    const minBytes = nonNegInt(opts.minBytes ?? opts.minSize);
    return this.request("GET", `/files/dupes${qs({
      node: node.value,
      min_bytes: minBytes === undefined ? DEFAULT_MIN_BYTES : minBytes,
      limit: posInt(opts.limit) || 50,
    })}`);
  }

  /** The caller's indexed nodes (A2): pick from these, never guess one. */
  nodes() {
    return this.request("GET", "/files/nodes");
  }

  tree(opts = {}) {
    const node = optNode(opts.node);
    if (!node.ok) return Promise.resolve({ ok: false, status: 0, error: node.error });
    if (opts.path !== undefined && opts.path !== "" && !validPath(opts.path)) {
      return Promise.resolve({ ok: false, status: 0, error: "bad path" });
    }
    return this.request("GET", `/files/tree${qs({
      node: node.value,
      path: opts.path || undefined,
      depth: posInt(opts.depth) || 1,
    })}`);
  }

  /** Manage proposals (hardlink / quarantine-copy / archive / share), scope-filtered
   *  by Genesis (A7). A tenant caller sees none until card recipients land. */
  proposals(opts = {}) {
    const node = optNode(opts.node);
    if (!node.ok) return Promise.resolve({ ok: false, status: 0, error: node.error });
    return this.request("GET", `/files/proposals${qs({ node: node.value, limit: posInt(opts.limit) || 100 })}`);
  }

  /** RAISE the action's own decision card for a manage proposal (linked, so only a
   *  human answer to it can approve). Never answers one. */
  raiseCard(proposalId) {
    const id = posInt(proposalId);
    if (!id) return Promise.resolve({ ok: false, status: 0, error: "bad proposal id" });
    return this.request("POST", `/manage/proposals/${id}/card`, {}, WRITE_TIMEOUT_MS);
  }

  /** Propose sharing a NODE path. Always a card-gated proposal (A7), never a
   *  published link; workspace files are shared through aitherium.com/share. */
  share({ node, path, seal } = {}) {
    if (!validNode(node)) return Promise.resolve({ ok: false, status: 0, error: "bad node id" });
    if (!validPath(path)) return Promise.resolve({ ok: false, status: 0, error: "bad path" });
    const body = { node, path };
    if (seal === true) body.seal = true;
    return this.request("POST", "/share", body, WRITE_TIMEOUT_MS);
  }

  shares() {
    return this.request("GET", "/shares");
  }
}

module.exports = {
  DiskExplorerClient,
  awstorageWhoami,
  DEFAULT_MIN_BYTES,
  NODE_RE,
  MAX_PATH,
  validNode,
  validPath,
  qs,
};
