"use strict";

/**
 * node-browser-client.cjs -- the Strata page's node browser: which machines have a
 * file index, and the folder sizes under a path on one of them.
 *
 * CONTRACT: the ONLY transport is gateway-mcp.cjs (the session bearer, 127.0.0.1:8182,
 * the cloud door when loopback refuses). Two read-only gateway tools, nothing else:
 *   storage_files_nodes             every node: Genesis's index + nodes that exist only
 *                                   in the signed inventory repo (Aitherium/inventory)
 *   storage_files_tree(node, path)  folder sizes under a path, depth 1
 * Both answer `source: "genesis" | "inventory"`; an inventory answer carries the
 * release, its published_at and when this platform verified its awseal signature. The
 * gateway refuses an unverified artifact -- this client never sees one, and it never
 * turns a failed read into an empty folder.
 *
 * callTool is injected, so every verb is asserted under node --test.
 */

/** Node ids are the shape awstorage accepts (identity._NODE_RE); anything else is refused here. */
const NODE_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const MAX_PATH = 4096;
const TREE_LIMIT = 200;

function parse(raw) {
  if (raw && typeof raw === "object") return raw;
  try { return JSON.parse(String(raw || "")); } catch { return null; }
}

function toolError(tool, data) {
  if (!data || typeof data !== "object") return `${tool}: unparseable answer`;
  if (data.status === 403) return `${tool}: platform operator only`;
  const parts = [data.error, data.inventory_error ? `inventory: ${data.inventory_error}` : null]
    .filter((p) => typeof p === "string" && p);
  return `${tool}: ${parts.join(" -- ") || "failed"}`;
}

/** The newest ISO time among the given values, or null. */
function newestIso(values) {
  let best = null;
  for (const v of values) {
    if (typeof v !== "string" || !v) continue;
    if (best === null || Date.parse(v) > Date.parse(best)) best = v;
  }
  return best;
}

/** One storage_files_nodes row as the picker shows it. */
function nodeRow(r) {
  if (!r || typeof r !== "object" || typeof r.node !== "string" || !r.node) return null;
  const roots = Array.isArray(r.roots) ? r.roots : [];
  const inv = r.source === "inventory" ? r : (r.inventory && typeof r.inventory === "object" ? r.inventory : null);
  const bytes = roots.reduce((n, x) => n + (Number(x && x.bytes) || 0), 0);
  return {
    node: r.node,
    source: r.source === "inventory" ? "inventory" : "genesis",
    bytes: roots.length ? bytes : null,
    roots: roots.length,
    indexedAt: newestIso([r.last_push_at, ...roots.map((x) => x && x.scanned_at)]),
    stale: r.stale === true,
    inventory: inv ? { release: inv.release || null, publishedAt: inv.published_at || null,
      verified: inv.verified === true, verifiedAt: inv.verified_at || null } : null,
  };
}

function createNodeBrowserClient({ callTool = (...a) => require("./gateway-mcp.cjs").callTool(...a) } = {}) {
  async function nodes() {
    const data = parse(await callTool("storage_files_nodes", {}));
    if (!data || typeof data !== "object" || !Array.isArray(data.nodes)) {
      throw new Error(toolError("storage_files_nodes", data));
    }
    if (data.error && !data.nodes.length) throw new Error(toolError("storage_files_nodes", data));
    return {
      nodes: data.nodes.map(nodeRow).filter(Boolean),
      genesisError: typeof data.genesis_error === "string" ? data.genesis_error : null,
      inventoryError: typeof data.inventory_error === "string" ? data.inventory_error : null,
    };
  }

  async function tree(node, path = "") {
    const id = String(node || "");
    if (!NODE_RE.test(id)) throw new Error(`not a node id: ${id || "(none)"}`);
    const p = String(path || "");
    if (p.length > MAX_PATH) throw new Error("path too long");
    const data = parse(await callTool("storage_files_tree", { node: id, path: p, depth: 1, limit: TREE_LIMIT }));
    if (!data || typeof data !== "object" || data.error || !Array.isArray(data.children)) {
      throw new Error(toolError("storage_files_tree", data));
    }
    return data;
  }

  return { nodes, tree };
}

module.exports = { createNodeBrowserClient, nodeRow, NODE_RE, TREE_LIMIT };
