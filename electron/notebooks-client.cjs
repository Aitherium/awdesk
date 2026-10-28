"use strict";

/**
 * notebooks-client.cjs -- the data half of aither://notebooks: every agent notebook this
 * host recorded, readable with the platform DOWN, and a Live verdict when Genesis answers.
 *
 * Owner, 2026-10-27: "we output a lot of agent notebooks... how do I discover / find them,
 * view them, use them, replay them". The host index (~/.aither/briefs/index.json) is the
 * local source of truth -- every creation path writes it -- and it is the same file
 * `adk notebook list --local` and the awsh `notebooks_list` tool read. So rows render from
 * it first, instantly and offline; the platform is merged in when it answers.
 *
 * Genesis is reached through the control plane as the signed-in owner (the `adk login`
 * session). Measured 2026-10-28: the Genesis bridge cannot LIST (it drops the trailing
 * slash; Genesis's 307 arrives with no Location), so the list is the portal's AitherOne
 * route -- which reports a Genesis failure as an EMPTY list. Live is therefore claimed
 * only after Genesis itself answers (the notebooks router, through the bridge).
 */

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const CONTROL_PLANE = "https://api.aitherium.com";
const VIEW_URL = "https://aitherium.com/workspace/one?tab=notebooks&id=";
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,79}$/;

// The replay guard, the same rule as awdk adk/harnesses/mcp_stdio.py (_NB_READ_ONLY_TOOLS,
// _NB_NO_ACTION_CELLS): Genesis hands every tool_call cell to an AGENT with the recorded
// tool and input (NotebookEngine CELL_DISPATCH_MAP: tool_call -> agent_call), so a
// recorded Bash, Write or Edit can be performed AGAIN. Both test suites pin one fixture.
const READ_ONLY_TOOLS = new Set(["Read", "Grep", "Glob", "LS", "WebFetch", "WebSearch",
  "ToolSearch", "ListAgents", "TodoRead", "NotebookRead"]);
const NO_ACTION_CELLS = new Set(["context", "plan", "note", "result", "markdown", "prompt",
  "agent_delegate", "checkpoint"]);

function validId(id) {
  const value = String(id || "");
  return ID_RE.test(value) && !value.includes("..");
}

function viewUrl(id) {
  return VIEW_URL + encodeURIComponent(String(id || ""));
}

function aitherDir(env = process.env) {
  return path.join(env.AITHER_HOME_DIR || os.homedir(), ".aither");
}

function briefsDir(env = process.env) {
  return env.AITHER_BRIEFS_DIR || path.join(aitherDir(env), "briefs");
}

function controlPlane(env = process.env) {
  return String(env.AITHER_PORTAL_URL || env.AITHER_ELYSIUM_URL || CONTROL_PLANE).replace(/\/+$/, "");
}

/** {readable, path, error?, rows} from the host index. Never throws, never silent. */
function readIndex({ dir = briefsDir(), readFile = fs.readFileSync } = {}) {
  const file = path.join(dir, "index.json");
  let raw;
  try {
    raw = readFile(file, "utf8");
  } catch {
    return { readable: false, path: file, error: "no notebook index on this host yet", rows: [] };
  }
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    return { readable: false, path: file, error: "the notebook index is not valid JSON", rows: [] };
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    return { readable: false, path: file, error: "the notebook index is not an object", rows: [] };
  }
  const rows = [];
  for (const [session, entry] of Object.entries(data)) {
    if (!entry || typeof entry !== "object") continue;
    const surfaces = entry.surfaces || {};
    const notebook = surfaces.notebook || {};
    const id = String(notebook.id || "");
    if (!id) continue;  // creation failed: not a notebook row
    rows.push({
      session, created: String(entry.created || ""), notebook: id, at: String(notebook.at || ""),
      log_path: String(entry.log_path || ""), brief: String((surfaces.archive || {}).path || ""),
      view: viewUrl(id), source: "host",
    });
  }
  rows.sort((a, b) => (a.created < b.created ? 1 : a.created > b.created ? -1 : 0));
  return { readable: true, path: file, rows };
}

/** The signed-in owner's bearer: AITHER_API_KEY, else the active `adk login` profile. */
function ownerToken({ env = process.env, readFile = fs.readFileSync } = {}) {
  if (env.AITHER_API_KEY) return String(env.AITHER_API_KEY).trim();
  try {
    const auth = JSON.parse(readFile(path.join(aitherDir(env), "auth.json"), "utf8"));
    const profile = ((auth && auth.profiles) || {})[(auth && auth.active_profile) || ""] || {};
    return String(profile.access_token || "");
  } catch {
    return "";
  }
}

/** Host rows plus the platform's, by id: "host", "platform" or "both". */
function mergeRows(hostRows, remote) {
  const rows = hostRows.map((row) => ({ ...row }));
  const byId = new Map(rows.map((row) => [row.notebook, row]));
  for (const nb of Array.isArray(remote) ? remote : []) {
    if (!nb || typeof nb !== "object" || !nb.id) continue;
    const row = byId.get(nb.id);
    if (row) {
      Object.assign(row, { source: "both", name: nb.name || "", status: nb.status || "" });
    } else {
      rows.push({ session: "", created: String(nb.created_at || ""), notebook: String(nb.id),
        name: nb.name || "", status: nb.status || "", log_path: "", brief: "",
        view: viewUrl(nb.id), source: "platform" });
    }
  }
  return rows;
}

/** {census, acting}: every cell by type[:tool], and the cells a replay could act through. */
function replayCensus(notebook) {
  const census = {};
  const acting = {};
  const cells = (notebook && (notebook.cells || (notebook.spec || {}).cells)) || [];
  for (const cell of cells) {
    if (!cell || typeof cell !== "object") continue;
    const type = String(cell.type || "?");
    const config = cell.config || {};
    const tool = String(config.tool || config.tool_name || cell.tool || "");
    const key = tool ? `${type}:${tool}` : type;
    census[key] = (census[key] || 0) + 1;
    const readsOnly = type === "tool_call" && READ_ONLY_TOOLS.has(tool);
    if (!readsOnly && !NO_ACTION_CELLS.has(type)) acting[key] = (acting[key] || 0) + 1;
  }
  return { census, acting };
}

async function request(fetchImpl, url, token, { method = "GET", body, timeoutMs = 20000, raw = false } = {}) {
  const headers = { Accept: "application/json" };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) headers["Content-Type"] = "application/json";
  let res;
  try {
    res = await fetchImpl(url, {
      method, headers, body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    return { ok: false, status: 0, error: String((error && error.message) || error) };
  }
  let data = null;
  try {
    data = raw ? await res.text() : await res.json();
  } catch {
    data = null;
  }
  if (!res.ok) {
    const detail = data && typeof data === "object" ? (data.detail || data.error || "") : "";
    return { ok: false, status: res.status, error: `HTTP ${res.status}${detail ? `: ${detail}` : ""}` };
  }
  return { ok: true, status: res.status, data };
}

function createNotebooksClient({ fetchImpl = globalThis.fetch, env = process.env, dir = null,
  token = null, writeFile = fs.writeFileSync, mkdir = fs.mkdirSync } = {}) {
  const base = () => controlPlane(env);
  const bridge = () => `${base()}/api/bridge/genesis`;
  const bearer = () => (typeof token === "function" ? token() : token) || ownerToken({ env });
  const refuse = (id) => ({ ok: false, error: `not a notebook id: ${String(id).slice(0, 40)}` });

  return {
    /** Host rows first (offline), then the platform's list and a Live verdict. */
    async list({ localOnly = false } = {}) {
      const index = readIndex({ dir: dir || briefsDir(env) });
      const out = {
        ok: true,
        index: { readable: index.readable, path: index.path, error: index.error || null },
        notebooks: index.rows, live: { checked: false, live: false },
      };
      if (localOnly) return out;
      const t = bearer();
      const live = { checked: true, live: false, error: null };
      const listed = await request(fetchImpl, `${base()}/api/notebooks`, t);
      if (listed.ok) {
        const remote = listed.data && Array.isArray(listed.data.notebooks) ? listed.data.notebooks : [];
        out.notebooks = mergeRows(index.rows, remote);
        live.listed = remote.length;
      }
      // The portal list answers [] when Genesis fails behind it: Live needs Genesis itself.
      const probe = await request(fetchImpl, `${bridge()}/notebooks/sessions`, t);
      if (probe.ok) live.live = true;
      else live.error = !t ? "not signed in (adk login) -- showing this host's notebooks" : probe.error;
      if (!listed.ok && !live.error) live.error = listed.error;
      out.live = live;
      return out;
    },

    /** The notebook from Genesis plus its replay census. */
    async outline(id) {
      if (!validId(id)) return refuse(id);
      const got = await request(fetchImpl, `${bridge()}/notebooks/${encodeURIComponent(id)}`, bearer());
      if (!got.ok) return { ok: false, error: got.error };
      const nb = got.data || {};
      const { census, acting } = replayCensus(nb);
      return { ok: true, id, name: nb.name || "", status: nb.status || "", census, acting,
        cellCount: Object.values(census).reduce((a, b) => a + b, 0) };
    },

    /** Run it again. Refuses recorded side effects unless the owner confirmed them. */
    async replay(id, { allowSideEffects = false, variables = {} } = {}) {
      const outline = await this.outline(id);
      if (!outline.ok) return outline;
      if (Object.keys(outline.acting).length && !allowSideEffects) {
        return { ok: false, refused: true, acting: outline.acting,
          error: "this notebook re-runs recorded tool calls that can change things" };
      }
      const run = await request(fetchImpl, `${bridge()}/notebooks/${encodeURIComponent(id)}/execute`,
        bearer(), { method: "POST", body: { variables, mode: "sequential" }, timeoutMs: 600000 });
      if (!run.ok) return { ok: false, error: run.error };
      return { ok: true, runId: (run.data && run.data.run_id) || "", status: (run.data && run.data.status) || "" };
    },

    /** Save the .ipynb under ~/.aither/notebooks/ and return its path. */
    async exportTo(id) {
      if (!validId(id)) return refuse(id);
      const got = await request(fetchImpl, `${bridge()}/notebooks/${encodeURIComponent(id)}/export`,
        bearer(), { raw: true, timeoutMs: 60000 });
      if (!got.ok) return { ok: false, error: got.error };
      const folder = path.join(aitherDir(env), "notebooks");
      mkdir(folder, { recursive: true });
      const file = path.join(folder, `${id}.ipynb`);
      writeFile(file, String(got.data || ""), "utf8");
      return { ok: true, path: file, bytes: Buffer.byteLength(String(got.data || "")) };
    },
  };
}

module.exports = {
  createNotebooksClient, readIndex, mergeRows, replayCensus, ownerToken, validId, viewUrl,
  controlPlane, READ_ONLY_TOOLS, NO_ACTION_CELLS,
};
