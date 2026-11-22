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
 * Genesis is reached through the control plane as the signed-in owner: the desk's Online
 * session first (the one identity awconnect also gets, browser-window onlineToken), then the
 * `adk login` profile. Measured 2026-10-28: the Genesis bridge cannot LIST (it drops the trailing
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

// The replay rule, the same one as awdk adk/notebook_tools.py (INERT_CELLS, AGENT_CELLS,
// replay_census), which every Python surface runs through; both test suites pin the same
// cases. Genesis executes every cell type except the structural ones (NotebookEngine
// CELL_DISPATCH_MAP): tool_call, prompt and agent_delegate each go to an AGENT with full
// tools and the cell's prompt/task as its task -- the recorded tool name limits nothing --
// and script/service/skill cells run code or calls. Unknown types count as acting.
const INERT_CELLS = new Set(["context", "plan", "note", "result", "markdown", "checkpoint"]);
const AGENT_CELLS = new Set(["tool_call", "prompt", "agent_delegate"]);

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

const SESSION_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;

/** The first line of the session's brief ("EXECUTIVE-BRIEF: <title>"), so a row says what
 *  the work was rather than only an id; "" when no brief was written. Same rule as awdk
 *  adk/commands/briefs.py _brief_title. */
function briefTitle(dir, session, archive, readFile = fs.readFileSync) {
  const candidates = [];
  if (SESSION_RE.test(session) && !session.includes("..")) candidates.push(path.join(dir, `${session}.md`));
  if (archive) candidates.push(archive);
  for (const file of candidates) {
    let first;
    try {
      first = String(readFile(file, "utf8")).split(/\r?\n/, 1)[0].slice(0, 400);
    } catch {
      continue;
    }
    first = first.trim().replace(/^#+/, "").trim();
    if (/^EXECUTIVE-BRIEF:/i.test(first)) first = first.slice(first.indexOf(":") + 1).trim();
    if (first) return first.slice(0, 160);
  }
  return "";
}

/** {readable, path, error?, rows} from the host index. Never throws, never silent. */
function readIndex({ dir = briefsDir(), readFile = fs.readFileSync, titles = true } = {}) {
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
    const brief = String((surfaces.archive || {}).path || "");
    rows.push({
      session, created: String(entry.created || ""), notebook: id, at: String(notebook.at || ""),
      log_path: String(entry.log_path || ""), brief, title: titles ? briefTitle(dir, session, brief, readFile) : "",
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

/** Host rows plus the platform's, by id: "host", "platform" or "both". The store's delete
 *  is a soft delete, so a platform-only row that is "archived" is a deleted one: hidden. */
function mergeRows(hostRows, remote) {
  const rows = hostRows.map((row) => ({ ...row }));
  const byId = new Map(rows.map((row) => [row.notebook, row]));
  for (const nb of Array.isArray(remote) ? remote : []) {
    if (!nb || typeof nb !== "object" || !nb.id) continue;
    const row = byId.get(nb.id);
    if (row) {
      Object.assign(row, { source: "both", name: nb.name || "", status: nb.status || "" });
    } else if (nb.status !== "archived") {
      rows.push({ session: "", created: String(nb.created_at || ""), notebook: String(nb.id),
        name: nb.name || "", title: "", status: nb.status || "", log_path: "", brief: "",
        view: viewUrl(nb.id), source: "platform" });
    }
  }
  return rows;
}

/** {census, acting, emptyTask}: every cell by type[:tool], the cells a run could act
 *  through, and the agent cells with no prompt/task -- a recorded session's tool calls
 *  carry only the tool and its input, so each would start an agent with an EMPTY task. */
function replayCensus(notebook) {
  const census = {};
  const acting = {};
  let emptyTask = 0;
  const cells = (notebook && (notebook.cells || (notebook.spec || {}).cells)) || [];
  for (const cell of cells) {
    if (!cell || typeof cell !== "object") continue;
    const type = String(cell.type || "?");
    const config = cell.config || {};
    const tool = String(config.tool || config.tool_name || cell.tool || "");
    const key = tool ? `${type}:${tool}` : type;
    census[key] = (census[key] || 0) + 1;
    if (INERT_CELLS.has(type)) continue;
    acting[key] = (acting[key] || 0) + 1;
    if (AGENT_CELLS.has(type) && !String(config.prompt || config.task || "").trim()) emptyTask += 1;
  }
  return { census, acting, emptyTask };
}

function seenFile(env = process.env) {
  return path.join(aitherDir(env), "notebooks", "seen.json");
}

/** The Notebooks rail badge: host notebooks created after the owner last opened the pane.
 *  The newest row's own `created` is the mark (the index's clock, so no timezone math). A
 *  computer with no mark records one and counts 0, so a fresh desk does not show 238. */
function unseenCount({ dir = briefsDir(), env = process.env, readFile = fs.readFileSync,
  writeFile = fs.writeFileSync, mkdir = fs.mkdirSync, markSeen = false } = {}) {
  const index = readIndex({ dir, readFile, titles: false });
  if (!index.readable) return { ok: false, count: 0, error: index.error };
  const newest = index.rows.length ? index.rows[0].created : "";
  let seenAt = null;
  try {
    seenAt = String(JSON.parse(readFile(seenFile(env), "utf8")).seen_at || "");
  } catch {
    seenAt = null;
  }
  if (markSeen || seenAt === null) {
    mkdir(path.dirname(seenFile(env)), { recursive: true });
    writeFile(seenFile(env), JSON.stringify({ seen_at: newest }), "utf8");
    return { ok: true, count: 0, seenAt: newest };
  }
  return { ok: true, count: index.rows.filter((row) => row.created > seenAt).length, seenAt };
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
  // The desk's own sign-in wins (one identity with awconnect); a signed-out desk (null) or a
  // provider that throws falls back to the `adk login` profile, never to an internal key.
  const bearer = async () => {
    let desk = null;
    try {
      desk = typeof token === "function" ? await token() : token;
    } catch {
      desk = null;
    }
    return (typeof desk === "string" && desk) || ownerToken({ env });
  };
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
      const t = await bearer();
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
      else live.error = !t ? "not signed in (desk Online or adk login) -- showing this host's notebooks" : probe.error;
      if (!listed.ok && !live.error) live.error = listed.error;
      out.live = live;
      return out;
    },

    /** The notebook from Genesis plus its replay census. */
    async outline(id) {
      if (!validId(id)) return refuse(id);
      const got = await request(fetchImpl, `${bridge()}/notebooks/${encodeURIComponent(id)}`, await bearer());
      if (!got.ok) return { ok: false, error: got.error };
      const nb = got.data || {};
      const { census, acting, emptyTask } = replayCensus(nb);
      return { ok: true, id, name: nb.name || "", status: nb.status || "", census, acting, emptyTask,
        cellCount: Object.values(census).reduce((a, b) => a + b, 0) };
    },

    /** Run it again. Refuses recorded side effects unless the owner confirmed them. */
    async replay(id, { allowSideEffects = false, variables = {} } = {}) {
      const outline = await this.outline(id);
      if (!outline.ok) return outline;
      if (Object.keys(outline.acting).length && !allowSideEffects) {
        return { ok: false, refused: true, acting: outline.acting, emptyTask: outline.emptyTask,
          error: "a run executes cells that can change things (agents with full tools, scripts, calls)" };
      }
      const run = await request(fetchImpl, `${bridge()}/notebooks/${encodeURIComponent(id)}/execute`,
        await bearer(), { method: "POST", body: { variables, mode: "sequential" }, timeoutMs: 600000 });
      if (!run.ok) return { ok: false, error: run.error };
      return { ok: true, runId: (run.data && run.data.run_id) || "", status: (run.data && run.data.status) || "" };
    },

    /** New notebooks since the pane was last opened; markSeen when it is opened now. */
    unseen({ markSeen = false } = {}) {
      return unseenCount({ dir: dir || briefsDir(env), env, writeFile, mkdir, markSeen });
    },

    /** Save the .ipynb under ~/.aither/notebooks/ and return its path. */
    async exportTo(id) {
      if (!validId(id)) return refuse(id);
      const got = await request(fetchImpl, `${bridge()}/notebooks/${encodeURIComponent(id)}/export`,
        await bearer(), { raw: true, timeoutMs: 60000 });
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
  controlPlane, briefTitle, unseenCount, seenFile, INERT_CELLS, AGENT_CELLS,
};
