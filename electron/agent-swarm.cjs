"use strict";

/**
 * agent-swarm.cjs -- one live roster of every agent the owner runs, and the pure
 * rules for how each one shows: a fairy in the swarm, or grown into its own avatar.
 *
 * Owner, 2026-11-16: "I can see, talk to and interact with EVERY agent I run, on my
 * awdesk, as a fairy swarm and as full avatars." The roster is READ from what really
 * runs and never typed in here:
 *
 *   discord   the awdiscord bot containers (Aither, Atlas, Hera, ...): `podman ps`
 *   fleet     Genesis agents with live work (active_agents) + the capability roster
 *   session   awsh/awdk/Claude Code sessions (the harness daemon's /sessions/unified)
 *   subagent  a session that names a parent
 *   remote    remote endpoints (deploy_remote_list)
 *   asset     GargBot's goblin, a 2D body that ships with the repo
 *
 * Each row keeps its own identity: a label, a colour (agent-fairy.cjs, the ONE palette),
 * a VRM body (cast.json authors[<agent>].character, else the default aither-v2) and a
 * voice (cast.json authors[<agent>].voice; an agent with none is given a stable voice at
 * speak time by voice-resolve, exactly as every other speaker is).
 *
 * LIGHT MODE (the default): remote endpoints, Claude Code terminals and subagents stay
 * small fairies that orbit the full Aitherium avatar agents they belong to; "grow all"
 * grows the persona / fleet / goblin rows only. A single named agent can always be grown
 * on request -- light mode limits the swarm-wide verbs, never the owner's choice.
 *
 * PURE: no electron, no network. The IO lives in agent-roster-live.cjs and the windows in
 * agent-swarm-host.cjs. node --test.
 */

const agentFairy = require("./agent-fairy.cjs");

/** persona = a Discord-bot agent; fleet = a Genesis agent; goblin = GargBot's 2D body. */
const KINDS = Object.freeze(["persona", "fleet", "goblin", "subagent", "session", "remote"]);
/** The "full Aitherium avatar agents": what grow-all grows in light mode. */
const FULL_KINDS = Object.freeze(["persona", "fleet", "goblin"]);
const LIGHT_KINDS = Object.freeze(["subagent", "session", "remote"]);
const FORMS = Object.freeze(["fairy", "avatar"]);
const MODES = Object.freeze(["light", "full"]);
const KIND_RANK = Object.freeze({ persona: 0, fleet: 1, goblin: 2, subagent: 3, session: 4, remote: 5 });
const STATE_RANK = Object.freeze({ waiting: 0, speaking: 1, working: 2, idle: 3 });

/** The default bodies (owner 2026-11-15/16): aither-v2 female, aither-m male. */
const DEFAULT_BODY = "aither-v2";
const DEFAULT_BODY_MALE = "aither-m";

/** The owner's own operator persona; light fairies orbit it unless they name a parent. */
const HOME_AGENT = "aither";
const GOBLIN_ID = "gargbot";

function clip(value, n) {
  const s = String(value == null ? "" : value).replace(/\s+/g, " ").trim();
  return s.length > n ? s.slice(0, n) : s;
}

function strongerState(a, b) {
  const ra = STATE_RANK[a] ?? 3;
  const rb = STATE_RANK[b] ?? 3;
  return ra <= rb ? (a || "idle") : (b || "idle");
}

/** A roster id: the fairy palette's key, else a lowercase slug; "" = not an agent. */
function rosterId(name) {
  const raw = String(name == null ? "" : name).trim();
  if (/^session-[a-z0-9]{1,16}$/i.test(raw)) return raw.toLowerCase();
  return agentFairy.crewKey(raw);
}

// -- parsers: one per source, each tolerant and each returning plain rows ----------

/**
 * `podman ps -a --format "{{.Names}}|{{.Status}}"` lines -> persona rows, one per
 * `aitheros-awdiscord[-<name>]` container that is Up. The unsuffixed container is
 * Aither's own bot. The relay bridge is infrastructure, not an agent: it never matches.
 */
function parseDiscordContainers(text) {
  const rows = [];
  for (const line of String(text == null ? "" : text).split(/\r?\n/)) {
    const m = /^\s*(?:aitheros|aither)-awdiscord(?:-([a-z0-9][a-z0-9_-]*))?\s*\|\s*(.*)$/i.exec(line);
    if (!m) continue;
    const id = rosterId(m[1] || HOME_AGENT);
    if (!id) continue;
    const status = String(m[2] || "");
    if (!/^up\b/i.test(status) || /unhealthy/i.test(status)) continue;
    rows.push({ id, label: "", kind: "persona", state: "idle", bot: true, source: "discord", detail: clip(status, 60) });
  }
  return rows;
}

/** active_agents JSON -> fleet rows (agents with live work or waiting on the owner). */
function parseActiveAgents(value) {
  let data = value;
  if (typeof data === "string") {
    try { data = JSON.parse(data); } catch { return []; }
  }
  const list = data && Array.isArray(data.agents) ? data.agents : [];
  const rows = [];
  for (const a of list) {
    if (!a || typeof a !== "object") continue;
    const id = rosterId(a.agent_id || a.id || a.agent);
    if (!id || id === "system" || id === "chat") continue;
    const status = String(a.status || a.liveness || "").toLowerCase();
    const state = status === "waiting" || Number(a.needs_owner) > 0 ? "waiting" : status === "working" ? "working" : "idle";
    rows.push({ id, label: "", kind: "fleet", state, source: "genesis", needsOwner: Math.max(0, Number(a.needs_owner) || 0) });
  }
  return rows;
}

/** agent_roster text ("  atlas  -> producers ...") -> fleet rows for the agents with wired capabilities. */
function parseCapabilityRoster(text) {
  const rows = [];
  for (const line of String(text == null ? "" : text).split(/\r?\n/)) {
    const m = /^\s{1,6}([a-z][a-z0-9_-]{1,30})\s+->/i.exec(line);
    if (!m || m[1].startsWith("_")) continue;
    const id = rosterId(m[1]);
    if (id) rows.push({ id, label: "", kind: "fleet", state: "idle", source: "genesis" });
  }
  return rows;
}

/**
 * sessions-client listSessions() -> session / subagent rows. The id is the same
 * `session-<8>` key agent-fairy.cjs uses for a Claude Code session's companion, so the
 * swarm and the card fairies are ONE fairy per session. A row that names a parent is a
 * subagent of it; everything else belongs to the owner's operator persona.
 */
function parseSessions(result, { max = 30 } = {}) {
  if (!result || result.ok !== true || !Array.isArray(result.sessions)) return [];
  const rows = [];
  for (const s of result.sessions) {
    if (!s || typeof s !== "object") continue;
    const status = String(s.status || "idle");
    if (/^(exited|dead|ended)$/i.test(status)) continue;
    const id = agentFairy.sessionKey(s.id || s.session_id);
    if (!id) continue;
    const parentRaw = s.parent_session_id || s.parent_id || s.parent || "";
    const parent = parentRaw ? agentFairy.sessionKey(parentRaw) : "";
    const waiting = /^waiting|^blocked/i.test(status);
    const cwd = String(s.cwd || "").replace(/[\\/]+$/, "");
    rows.push({
      id,
      label: clip(s.name || s.title || cwd.split(/[\\/]/).pop() || "Session", 40),
      kind: parent ? "subagent" : "session",
      state: waiting ? "waiting" : /^working|^busy|^running/i.test(status) ? "working" : "idle",
      source: "sessions",
      harness: clip(s.harness_label || s.harness || "", 40),
      belongsTo: parent || HOME_AGENT,
      detail: clip(s.last_activity_summary || "", 80),
    });
    if (rows.length >= max) break;
  }
  return rows;
}

/** deploy_remote_list rows ({name|id|endpoint, state?}) -> remote rows. */
function parseRemote(value) {
  let data = value;
  if (typeof data === "string") {
    try { data = JSON.parse(data); } catch { return []; }
  }
  const list = Array.isArray(data) ? data : data && Array.isArray(data.endpoints) ? data.endpoints : [];
  const rows = [];
  for (const r of list) {
    if (!r || typeof r !== "object") continue;
    const name = clip(r.name || r.id || r.endpoint_id || r.endpoint || "", 40);
    if (!name) continue;
    const id = rosterId(`remote-${name}`);
    if (!id) continue;
    const status = String(r.status || r.state || "").toLowerCase();
    rows.push({
      id, label: name, kind: "remote", source: "remote", belongsTo: HOME_AGENT,
      state: /busy|working|running/.test(status) ? "working" : "idle",
    });
  }
  return rows;
}

/** The desk's own resident persona: Aither runs here whether or not the fleet answers. */
function residentRow() {
  return { id: HOME_AGENT, label: "Aither", kind: "persona", state: "idle", source: "desk" };
}

/** GargBot's goblin: a body that ships with the repo, always summonable. */
function goblinRow() {
  return { id: GOBLIN_ID, label: "GargBot", kind: "goblin", state: "idle", source: "asset", bodyKind: "sprite" };
}

// -- the merge and the identity ----------------------------------------------------

/**
 * Merge source rows into one roster: one row per id, the strongest state, every source
 * named, the lowest kind rank (a Discord bot outranks a fleet listing). Sorted: owner
 * persona first, then kind, then the ones that need him, then name.
 */
function mergeRoster(rows) {
  const byId = new Map();
  for (const row of Array.isArray(rows) ? rows : []) {
    if (!row || !row.id) continue;
    const prev = byId.get(row.id);
    if (!prev) {
      byId.set(row.id, { ...row, sources: [row.source].filter(Boolean) });
      continue;
    }
    if ((KIND_RANK[row.kind] ?? 9) < (KIND_RANK[prev.kind] ?? 9)) prev.kind = row.kind;
    prev.state = strongerState(prev.state, row.state);
    prev.bot = Boolean(prev.bot || row.bot);
    prev.label = prev.label || row.label;
    prev.belongsTo = prev.belongsTo || row.belongsTo;
    prev.needsOwner = Math.max(prev.needsOwner || 0, row.needsOwner || 0);
    prev.detail = prev.detail || row.detail;
    prev.harness = prev.harness || row.harness;
    prev.bodyKind = prev.bodyKind || row.bodyKind;
    if (row.source && !prev.sources.includes(row.source)) prev.sources.push(row.source);
  }
  return [...byId.values()].sort((a, b) =>
    (a.id === HOME_AGENT ? -1 : 0) - (b.id === HOME_AGENT ? -1 : 0)
    || (KIND_RANK[a.kind] ?? 9) - (KIND_RANK[b.kind] ?? 9)
    || (STATE_RANK[a.state] ?? 3) - (STATE_RANK[b.state] ?? 3)
    || String(a.label || a.id).localeCompare(String(b.label || b.id)));
}

/**
 * Give every row its own identity. `authors` is cast.json authors{} (character, voice);
 * `characters` is the set of installed roster names (null = do not check); `aitherBody`
 * is the female/male choice the fairy already grows into.
 *
 * Returns rows with: label, color, core, glow, character, voice (string|null), bodyKind
 * ("vrm"|"sprite"), belongsTo (who a light fairy orbits; "" for a full agent).
 */
function withIdentity(roster, { authors = {}, characters = null, aitherBody = "" } = {}) {
  const has = (name) => !characters || (characters.has ? characters.has(name) : characters.includes(name));
  const idSet = new Set((roster || []).map((r) => r.id));
  return (roster || []).map((row) => {
    const fairy = row.id.startsWith("session-") || row.kind === "remote"
      ? { ...agentFairy.crewFairy(row.id), label: row.label || row.id }
      : agentFairy.crewFairy(row.label || row.id);
    const authored = authors && typeof authors === "object" ? authors[row.id] : null;
    const authoredChar = authored && typeof authored === "object" && typeof authored.character === "string" ? authored.character : "";
    let character;
    if (row.bodyKind === "sprite") character = "goblin";
    // The resident persona wears the body the fairy grows into (aither-body.cjs: female or
    // male); every other agent wears its authored character.
    else if (row.id === HOME_AGENT && aitherBody && has(aitherBody)) character = aitherBody;
    else if (authoredChar && has(authoredChar)) character = authoredChar;
    else if (has(row.id)) character = row.id;
    else character = has(DEFAULT_BODY) ? DEFAULT_BODY : DEFAULT_BODY;
    const voice = authored && typeof authored === "object" && typeof authored.voice === "string" && authored.voice ? authored.voice : null;
    const light = LIGHT_KINDS.includes(row.kind);
    let belongsTo = "";
    if (light) {
      belongsTo = row.belongsTo && idSet.has(row.belongsTo) ? row.belongsTo : (idSet.has(HOME_AGENT) ? HOME_AGENT : "");
    }
    return {
      ...row,
      label: clip(row.label || fairy.label || row.id, 40),
      color: fairy.color,
      core: fairy.core,
      glow: fairy.glow,
      wings: fairy.wings,
      ring: fairy.ring,
      sparkles: fairy.sparkles,
      character,
      voice,
      bodyKind: row.bodyKind || "vrm",
      belongsTo,
      light,
    };
  });
}

// -- forms: who grows, who stays small --------------------------------------------

function isForm(value) {
  return FORMS.includes(value);
}

/** May the swarm-wide verb grow this row? Light mode keeps the light kinds small. */
function growsWithSwarm(row, mode = "light") {
  if (!row) return false;
  return mode === "full" ? true : FULL_KINDS.includes(row.kind);
}

/**
 * The ids a swarm-wide `form` verb applies to. "avatar" respects the mode; "fairy"
 * shrinks everyone that is currently grown, whatever the mode.
 */
function targetsFor(roster, forms, form, mode = "light") {
  const list = Array.isArray(roster) ? roster : [];
  if (form === "avatar") return list.filter((r) => growsWithSwarm(r, mode) && forms.get(r.id) !== "avatar").map((r) => r.id);
  return list.filter((r) => forms.get(r.id) === "avatar").map((r) => r.id);
}

/**
 * The presence rows the fairy swarm draws (the shape agent-fairy.normalizePresence reads,
 * plus the swarm's own fields). A grown agent is a body, not a fairy, so it leaves the
 * swarm until it shrinks back. The goblin never orbits: it is summoned, not a companion.
 */
function presenceFor(roster, forms) {
  const out = [];
  for (const row of Array.isArray(roster) ? roster : []) {
    if (forms.get(row.id) === "avatar") continue;
    if (row.kind === "goblin") continue;
    const state = row.state === "waiting" ? "waiting" : row.state === "working" ? "working" : "idle";
    out.push({
      agent: row.id,
      label: row.label,
      state,
      needs_owner: row.needsOwner || 0,
      work: [],
      discord: row.bot ? { bot: true } : null,
      kind: row.kind,
      belongsTo: row.belongsTo || "",
    });
  }
  return out;
}

// -- the animation -----------------------------------------------------------------

const FRAMES = 14;
const FRAME_MS = 18;
/** A body at the first frame of a grow is about a fairy's size (a fraction of a full body). */
const START_SCALE = 0.06;

function easeOutBack(t) {
  const c1 = 1.70158;
  const c3 = c1 + 1;
  return 1 + c3 * (t - 1) ** 3 + c1 * (t - 1) ** 2;
}

function easeInCubic(t) {
  return t * t * t;
}

/**
 * The frames of one body growing from a fairy into itself, or shrinking back:
 * [{scale, yaw}], the last grow frame exactly (`scale`, 0) and the last shrink frame the
 * fairy-sized start. The grow overshoots a little and turns to face the owner; the shrink
 * is the grow reversed in time with an ease-in, so the two read as one motion.
 */
function bodyFrames(direction, { scale = 1, frames = FRAMES } = {}) {
  const n = Math.max(2, Math.round(Number(frames) || FRAMES));
  const full = Math.max(START_SCALE * 2, Number(scale) || 1);
  const out = [];
  for (let i = 1; i <= n; i += 1) {
    const t = i / n;
    if (direction === "grow") {
      const k = i === n ? 1 : Math.min(1.12, easeOutBack(t));
      out.push({ scale: Number((START_SCALE * full + (full - START_SCALE * full) * k).toFixed(4)), yaw: i === n ? 0 : Number((0.9 * (1 - t)).toFixed(3)) });
    } else {
      const k = easeInCubic(t);
      out.push({ scale: Number((full - (full - START_SCALE * full) * k).toFixed(4)), yaw: i === n ? 0.9 : Number((0.9 * t).toFixed(3)) });
    }
  }
  return out;
}

/**
 * How wide the stage window has to be for `count` bodies in a row, so none is cropped:
 * the camera sees ~1.7 world units of height and bodies stand at x in [-2, 2]
 * (src/stage/arrangements.ts spread()). Clamped to the work area.
 */
function stageWidthFor(count, height, areaWidth) {
  const n = Math.max(1, Math.floor(Number(count) || 1));
  const h = Math.max(240, Number(height) || 640);
  const aw = Math.max(320, Number(areaWidth) || 1920);
  if (n === 1) return Math.min(aw, Math.max(320, Math.round(h * 0.66)));
  const step = Math.min(1.6, 4 / (n - 1));
  const maxX = (step * (n - 1)) / 2;
  const width = Math.round(h * ((2 * (maxX + 0.7)) / 1.69));
  return Math.min(aw, Math.max(Math.round(h * 0.66), width));
}

/** The stage's own constants, copied from src/stage + src/hooks (the renderer owns them). */
const STAGE_BOUND = 2;
const STAGE_STEP = 1.6;

/**
 * Where `ids` stand in a row: the renderer's arrangements.spread() (even, symmetric,
 * inside the stage) over arrangements.order() (the resident slot0 first, the rest by id).
 * Returns {slotId: x}. The swarm places bodies itself (place-avatar, x only) so a grow
 * never pops the neighbours to the arrangement's own scale.
 */
function rowPositions(ids) {
  const list = (Array.isArray(ids) ? ids : []).filter(Boolean);
  const rest = list.filter((id) => id !== "slot0").sort();
  const ordered = list.includes("slot0") ? ["slot0", ...rest] : rest;
  const n = ordered.length;
  const out = {};
  if (n === 0) return out;
  if (n === 1) { out[ordered[0]] = 0; return out; }
  const step = Math.min((2 * STAGE_BOUND) / (n - 1), STAGE_STEP);
  const start = -(step * (n - 1)) / 2;
  ordered.forEach((id, i) => { out[id] = Math.max(-STAGE_BOUND, Math.min(STAGE_BOUND, Number((start + i * step).toFixed(4)))); });
  return out;
}

/**
 * Where `n` bodies stand in a circle of `radius` world units around (cx, 0, 0), all turned to
 * face the centre. Returns [{x, z, yaw}] in the order given. One body stands at the centre.
 */
function circlePositions(n, cx = 0, radius = 1.1) {
  const count = Math.max(0, Math.floor(Number(n) || 0));
  if (count === 0) return [];
  if (count === 1) return [{ x: cx, z: 0, yaw: 0 }];
  const out = [];
  for (let i = 0; i < count; i += 1) {
    const a = (2 * Math.PI * i) / count - Math.PI / 2; // the first body stands at the front
    const x = Math.max(-STAGE_BOUND, Math.min(STAGE_BOUND, cx + Math.cos(a) * radius));
    // z grows toward the camera: the front body stands forward, the back ones step back.
    out.push({ x: Number(x.toFixed(4)), z: Number((-Math.sin(a) * radius * 0.6).toFixed(4)), yaw: Number((-Math.cos(a) * 0.5).toFixed(3)) });
  }
  return out;
}

/** The public shape of one roster row (what the API, MCP and the tray see). */
function publicRow(row, forms) {
  return {
    id: row.id,
    label: row.label,
    kind: row.kind,
    state: row.state,
    form: forms.get(row.id) === "avatar" ? "avatar" : "fairy",
    color: row.color,
    character: row.character,
    voice: row.voice,
    bodyKind: row.bodyKind,
    belongsTo: row.belongsTo || "",
    light: Boolean(row.light),
    bot: Boolean(row.bot),
    sources: row.sources || [],
    harness: row.harness || "",
    detail: row.detail || "",
  };
}

module.exports = {
  KINDS,
  FULL_KINDS,
  LIGHT_KINDS,
  FORMS,
  MODES,
  DEFAULT_BODY,
  DEFAULT_BODY_MALE,
  HOME_AGENT,
  GOBLIN_ID,
  FRAMES,
  FRAME_MS,
  START_SCALE,
  rosterId,
  parseDiscordContainers,
  parseActiveAgents,
  parseCapabilityRoster,
  parseSessions,
  parseRemote,
  goblinRow,
  residentRow,
  mergeRoster,
  withIdentity,
  isForm,
  growsWithSwarm,
  targetsFor,
  presenceFor,
  bodyFrames,
  stageWidthFor,
  rowPositions,
  circlePositions,
  STAGE_BOUND,
  STAGE_STEP,
  publicRow,
};
