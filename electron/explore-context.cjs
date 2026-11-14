"use strict";

/**
 * explore-context.cjs -- the Context tab of aither://explore: what an agent / LLM
 * actually had, from what is really recorded. Nothing here is estimated into existence.
 *
 * WHAT EXISTS, and where it is read from:
 *
 *   sessions      Claude Code journals on this computer (~/.claude/projects/<slug>/<id>.jsonl),
 *                 offline; merged with the harness daemon's live directory
 *                 (sessions-client.cjs) when it answers.
 *   facts         per message of one journal: characters by kind (text, thinking,
 *                 tool call, tool result), the tool-call share, and the API's OWN token
 *                 counts on each assistant turn (message.usage: input, cache read, cache
 *                 write, output). Character counts are measured; "~tokens" is chars/4 and
 *                 is labelled an estimate wherever it is shown.
 *   requests      Claude Code (measured on 2.1.325) journals each API request it sent:
 *                 `api-request` (model, params, the message list as content hashes:
 *                 `keep` carried over + `tail` new), `api-request-shape` (the system
 *                 blocks and tool definitions) and `api-request-blob` (one message per
 *                 hash). requestDetail() shows exactly those records. A hash whose blob
 *                 lies outside the bytes read is listed as "not read", never guessed.
 *   traces        the platform's LLM traces through the gateway tools llm_trace_list /
 *                 llm_trace_get. On this desk the gateway answers "not available on the
 *                 platform tier"; that sentence is shown as the state.
 *   recall        what long-term memory returns for a query (knowledge-client.cjs).
 *
 * WHAT DOES NOT: an assembled prompt for a FLEET agent's past call. Genesis records LLM
 * traces, but only the llm_trace_* tools reach them and the desk's gateway tier refuses
 * those; MicroScheduler's /llm/traces/recent needs internal auth the desk does not hold.
 *
 * Reads are bounded (journals reach 1 GB): a tail window, and the result says how much
 * of the file it covers. Nothing here writes. fs, the daemon and callTool are injected.
 */

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { bounded } = require("./explore-wiki.cjs");

const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LIMITS = Object.freeze({ maxSessions: 60, maxProjects: 400, titleBytes: 192 * 1024, windowBytes: 24 * 1024 * 1024,
  maxRows: 400, maxRequests: 200, maxTail: 200, preview: 1200 });
const KINDS = Object.freeze(["text", "thinking", "tool_use", "tool_result", "other"]);

function clip(text, n) {
  const t = String(text == null ? "" : text).replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
}

function claudeHome(env = process.env) {
  return String(env.CLAUDE_CONFIG_DIR || "").trim() || path.join(os.homedir(), ".claude");
}

function readWindow(file, { start, length }, fsImpl = fs) {
  let fd = null;
  try {
    fd = fsImpl.openSync(file, "r");
    const buf = Buffer.alloc(length);
    const n = fsImpl.readSync(fd, buf, 0, length, start);
    return buf.subarray(0, n).toString("utf8");
  } catch {
    return "";
  } finally {
    if (fd != null) { try { fsImpl.closeSync(fd); } catch { /* closed */ } }
  }
}

/** The tail window of a journal as whole lines: {lines, bytes, fileBytes, truncated}. */
function tailLines(file, maxBytes, fsImpl = fs) {
  let size;
  try { size = fsImpl.statSync(file).size; } catch { return null; }
  const length = Math.min(size, maxBytes);
  const start = size - length;
  const lines = readWindow(file, { start, length }, fsImpl).split("\n");
  if (start > 0) lines.shift(); // the window opened mid-line
  return { lines, bytes: length, fileBytes: size, truncated: start > 0 };
}

/** A session's name from the end of its journal (custom-title wins over ai-title over the last prompt). */
function titleFromTail(text) {
  let custom = "";
  let ai = "";
  let prompt = "";
  const re = /\{"type":"(custom-title|ai-title|last-prompt)"[^\n]{0,2000}/g;
  let m;
  while ((m = re.exec(text))) {
    let rec;
    try { rec = JSON.parse(m[0]); } catch { continue; }
    if (rec.type === "custom-title" && rec.customTitle) custom = String(rec.customTitle);
    else if (rec.type === "ai-title" && (rec.aiTitle || rec.title)) ai = String(rec.aiTitle || rec.title);
    else if (rec.type === "last-prompt" && rec.lastPrompt) prompt = String(rec.lastPrompt);
  }
  return clip(custom || ai || prompt, 140);
}

/**
 * The journals on this computer, newest first. Each row keeps its `file` for main;
 * publicSession() is what a page sees. Bounded: projects, files, a small tail per title.
 */
function localSessions({ home = claudeHome(), fsImpl = fs, limit = LIMITS.maxSessions } = {}) {
  const projects = path.join(home, "projects");
  let dirs;
  try { dirs = fsImpl.readdirSync(projects); } catch { return { ok: false, sessions: [], reason: `0 session journals — ${projects} is not readable` }; }
  const found = [];
  for (const dir of dirs.slice(0, LIMITS.maxProjects)) {
    let names;
    try { names = fsImpl.readdirSync(path.join(projects, dir)); } catch { continue; }
    for (const name of names) {
      if (!name.endsWith(".jsonl")) continue;
      const id = name.slice(0, -6);
      if (!SESSION_ID.test(id)) continue;
      const file = path.join(projects, dir, name);
      let stat;
      try { stat = fsImpl.statSync(file); } catch { continue; }
      if (!stat.isFile()) continue;
      found.push({ id, project: dir, file, bytes: stat.size, updated: Math.round(stat.mtimeMs) });
    }
  }
  found.sort((a, b) => b.updated - a.updated);
  const total = found.length;
  const sessions = found.slice(0, Math.max(1, Math.min(LIMITS.maxSessions, Number(limit) || LIMITS.maxSessions)));
  for (const s of sessions) {
    const length = Math.min(s.bytes, LIMITS.titleBytes);
    s.title = titleFromTail(readWindow(s.file, { start: s.bytes - length, length }, fsImpl));
  }
  return { ok: true, sessions, total };
}

function publicSession(s) {
  return { id: s.id, project: s.project || "", title: s.title || "", bytes: s.bytes || 0, updated: s.updated || 0,
    status: s.status || "", harness: s.harness || "", hasJournal: Boolean(s.file) };
}

function blockKind(block) {
  if (!block || typeof block !== "object") return "other";
  if (block.type === "text") return "text";
  if (block.type === "thinking" || block.type === "redacted_thinking") return "thinking";
  if (block.type === "tool_use" || block.type === "server_tool_use") return "tool_use";
  if (block.type === "tool_result" || /_tool_result$/.test(String(block.type))) return "tool_result";
  return "other";
}

function blockChars(block) {
  if (!block || typeof block !== "object") return 0;
  if (typeof block.text === "string") return block.text.length;
  if (typeof block.thinking === "string") return block.thinking.length;
  if (block.type === "tool_use" || block.type === "server_tool_use") {
    let n = String(block.name || "").length;
    try { n += JSON.stringify(block.input == null ? {} : block.input).length; } catch { /* unserialisable */ }
    return n;
  }
  if (block.content != null) {
    if (typeof block.content === "string") return block.content.length;
    try { return JSON.stringify(block.content).length; } catch { return 0; }
  }
  return 0;
}

/** {kinds: {text, thinking, tool_use, tool_result, other}, chars, tools, preview} of a message's content. */
function measureContent(content) {
  const kinds = { text: 0, thinking: 0, tool_use: 0, tool_result: 0, other: 0 };
  const tools = [];
  let preview = "";
  if (typeof content === "string") {
    kinds.text = content.length;
    preview = content;
  } else if (Array.isArray(content)) {
    for (const b of content) {
      const kind = blockKind(b);
      kinds[kind] += blockChars(b);
      if (kind === "tool_use" && b.name) tools.push(String(b.name).slice(0, 80));
      if (!preview && kind === "text" && typeof b.text === "string") preview = b.text;
      if (!preview && kind === "tool_result") preview = typeof b.content === "string" ? b.content : "";
    }
  }
  const chars = KINDS.reduce((n, k) => n + kinds[k], 0);
  return { kinds, chars, tools, preview };
}

function usageOf(u) {
  if (!u || typeof u !== "object") return null;
  const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
  const out = { input: num(u.input_tokens), cacheRead: num(u.cache_read_input_tokens),
    cacheWrite: num(u.cache_creation_input_tokens), output: num(u.output_tokens) };
  out.prompt = out.input + out.cacheRead + out.cacheWrite;
  return out;
}

const LEAD_TYPE = /^{"type":"([a-z-]+)"/;
const WANT = new Set(["user", "assistant", "api-request", "api-request-shape"]);

/** A blob line without parsing it: its hash, role and size. Blobs are most of a journal's bytes. */
function blobOf(line) {
  const hash = /"hash"\s*:\s*"([0-9a-f]{64})"/.exec(line.slice(0, 300));
  if (!hash) return null;
  const role = /"role"\s*:\s*"(user|assistant|system)"/.exec(line.slice(0, 600));
  return { hash: hash[1], role: role ? role[1] : "", bytes: line.length };
}

function requestRow(rec) {
  const p = rec.params && typeof rec.params === "object" ? rec.params : {};
  return { id: String(rec.id || ""), at: Date.parse(rec.timestamp) || 0, model: String(p.model || ""),
    source: clip(rec.querySource || "", 80), effort: String((p.output_config && p.output_config.effort) || ""),
    maxTokens: Number(p.max_tokens) || 0, keep: Number(rec.keep) || 0, tail: Array.isArray(rec.tail) ? rec.tail.length : 0,
    base: rec.base ? String(rec.base).slice(0, 80) : "", shape: String(rec.shapeHash || ""), version: String(rec.version || "") };
}

function shapeRow(rec) {
  const shape = rec.shape && typeof rec.shape === "object" ? rec.shape : {};
  const system = Array.isArray(shape.system) ? shape.system : (typeof shape.system === "string" ? [{ text: shape.system }] : []);
  const tools = Array.isArray(shape.tools) ? shape.tools : [];
  let toolChars = 0;
  try { toolChars = JSON.stringify(tools).length; } catch { /* unserialisable */ }
  return { systemBlocks: system.length, systemChars: system.reduce((n, b) => n + String((b && b.text) || "").length, 0),
    tools: tools.length, toolChars };
}

/**
 * The measurable context facts of one journal. Rows are the LAST `maxRows` messages;
 * the totals cover every message in the bytes read, and `window` says how much that is.
 */
function sessionFacts(file, { fsImpl = fs, maxBytes = LIMITS.windowBytes } = {}) {
  const win = tailLines(file, maxBytes, fsImpl);
  if (!win) return { ok: false, reason: "1 journal is not readable on this computer" };
  const rows = [];
  const totals = { messages: 0, chars: 0, kinds: { text: 0, thinking: 0, tool_use: 0, tool_result: 0, other: 0 },
    toolCalls: 0, usage: { input: 0, cacheRead: 0, cacheWrite: 0, output: 0, turns: 0 } };
  const tools = new Map();
  const requests = [];
  const shapes = new Map();
  const blobs = new Map();
  const seenUsage = new Set();
  let lastUsage = null;
  for (const line of win.lines) {
    if (line.length < 2 || line[0] !== "{") continue;
    // Records Claude Code writes itself lead with their type; a user / assistant turn leads
    // with parentUuid and carries its type further in.
    const head = LEAD_TYPE.exec(line);
    if (head) {
      if (head[1] === "api-request-blob") {
        const b = blobOf(line);
        if (b) blobs.set(b.hash, b);
        continue;
      }
      if (!WANT.has(head[1])) continue;
    } else if (!line.includes('"type":"user"') && !line.includes('"type":"assistant"')) {
      continue;
    }
    let rec;
    try { rec = JSON.parse(line); } catch { continue; }
    if (rec.type === "api-request") { requests.push(requestRow(rec)); continue; }
    if (rec.type === "api-request-shape") { if (rec.shapeHash) shapes.set(String(rec.shapeHash), shapeRow(rec)); continue; }
    if ((rec.type !== "user" && rec.type !== "assistant") || !rec.message || typeof rec.message !== "object") continue;
    const m = measureContent(rec.message.content);
    const row = { role: rec.type, at: Date.parse(rec.timestamp) || 0, kinds: m.kinds, chars: m.chars,
      estTokens: Math.ceil(m.chars / 4), tools: m.tools, preview: clip(m.preview, 200), sidechain: Boolean(rec.isSidechain) };
    // One API message is journalled as one record per content block, each carrying the
    // SAME usage: count it once per message id.
    const usage = rec.type === "assistant" ? usageOf(rec.message.usage) : null;
    const mid = String(rec.message.id || "");
    if (usage && (!mid || !seenUsage.has(mid))) {
      if (mid) seenUsage.add(mid);
      row.usage = usage;
      totals.usage.input += usage.input; totals.usage.cacheRead += usage.cacheRead;
      totals.usage.cacheWrite += usage.cacheWrite; totals.usage.output += usage.output; totals.usage.turns += 1;
      lastUsage = { ...usage, at: row.at, model: String(rec.message.model || "") };
    }
    totals.messages += 1;
    totals.chars += m.chars;
    for (const k of KINDS) totals.kinds[k] += m.kinds[k];
    for (const t of m.tools) { totals.toolCalls += 1; tools.set(t, (tools.get(t) || 0) + 1); }
    rows.push(row);
  }
  const toolChars = totals.kinds.tool_use + totals.kinds.tool_result;
  for (const r of requests) {
    const s = shapes.get(r.shape);
    r.system = s || null;
    delete r.shape;
  }
  return {
    ok: true,
    window: { bytes: win.bytes, fileBytes: win.fileBytes, truncated: win.truncated },
    totals: { ...totals, toolShare: totals.chars ? toolChars / totals.chars : 0, estTokens: Math.ceil(totals.chars / 4) },
    lastCall: lastUsage,
    tools: [...tools.entries()].sort((a, b) => b[1] - a[1]).slice(0, 30).map(([name, count]) => ({ name, count })),
    rows: rows.slice(-LIMITS.maxRows), rowsTotal: rows.length,
    requests: requests.slice(-LIMITS.maxRequests), requestsTotal: requests.length,
    blobs: blobs.size,
  };
}

/** One journalled API request, as recorded: params, system blocks, tools, and its new messages. */
function requestDetail(file, requestId, { fsImpl = fs, maxBytes = LIMITS.windowBytes } = {}) {
  const want = String(requestId || "");
  if (!/^[0-9a-f-]{8,64}$/i.test(want)) return { ok: false, reason: "not a request id" };
  const win = tailLines(file, maxBytes, fsImpl);
  if (!win) return { ok: false, reason: "1 journal is not readable on this computer" };
  let request = null;
  for (const line of win.lines) {
    if (!line.includes(`"id":"${want}"`) || !/"type"\s*:\s*"api-request"/.test(line.slice(0, 200))) continue;
    try { request = JSON.parse(line); } catch { request = null; }
    if (request) break;
  }
  if (!request) return { ok: false, reason: "1 request is not in the part of the journal that was read" };
  const tail = Array.isArray(request.tail) ? request.tail.map(String) : [];
  const shown = tail.slice(-LIMITS.maxTail);
  const wanted = new Set(shown);
  const blobs = new Map();
  let shape = null;
  for (const line of win.lines) {
    const lead = line.slice(0, 300);
    if (lead.includes('"api-request-blob"')) {
      const b = blobOf(line);
      if (!b || !wanted.has(b.hash) || blobs.has(b.hash)) continue;
      try { blobs.set(b.hash, JSON.parse(line).message || {}); } catch { /* a torn line */ }
    } else if (!shape && lead.includes('"api-request-shape"') && line.includes(String(request.shapeHash || "\u0000"))) {
      try { shape = JSON.parse(line).shape || null; } catch { shape = null; }
    }
  }
  const system = shape && Array.isArray(shape.system)
    ? shape.system.map((b) => ({ chars: String((b && b.text) || "").length, preview: String((b && b.text) || "").slice(0, LIMITS.preview) }))
    : null;
  const tools = shape && Array.isArray(shape.tools)
    ? shape.tools.map((t) => ({ name: String((t && t.name) || ""), chars: String((t && t.description) || "").length }))
    : null;
  const messages = shown.map((hash) => {
    const msg = blobs.get(hash);
    if (!msg) return { hash: hash.slice(0, 10), read: false };
    const m = measureContent(msg.content);
    return { hash: hash.slice(0, 10), read: true, role: String(msg.role || ""), kinds: m.kinds, chars: m.chars, tools: m.tools,
      preview: String(m.preview || "").slice(0, LIMITS.preview) };
  });
  const row = requestRow(request);
  delete row.shape;
  const p = request.params && typeof request.params === "object" ? request.params : {};
  return { ok: true, request: { ...row, betas: Array.isArray(p.betas) ? p.betas.length : 0,
    thinking: p.thinking && p.thinking.type ? String(p.thinking.type) : "" },
  system, tools, messages, tailTotal: tail.length, notRead: messages.filter((m) => !m.read).length,
  window: { bytes: win.bytes, fileBytes: win.fileBytes, truncated: win.truncated } };
}

/**
 * The Context tab's backend. `daemon` is sessions-client listSessions (live rows);
 * `memory` is knowledge-client searchMemory.
 */
function createContextClient({
  callTool = (...a) => require("./gateway-mcp.cjs").callTool(...a),
  daemon = () => require("./sessions-client.cjs").listSessions({ timeoutMs: 4000 }),
  memory = (q) => require("./knowledge-client.cjs").createKnowledgeClient({ callTool }).searchMemory(q),
  home = claudeHome(), fsImpl = fs, timeoutMs = 20_000,
} = {}) {
  let index = new Map(); // session id -> row with file (main only)

  async function sessions({ query = "" } = {}) {
    const local = localSessions({ home, fsImpl });
    let live;
    try { live = await daemon(); } catch (error) { live = { ok: false, sessions: [], note: String((error && error.message) || error) }; }
    const merged = new Map();
    for (const s of local.sessions) merged.set(s.id, { ...s });
    for (const d of (live && live.ok ? live.sessions : [])) {
      const id = String(d.harness_session_id || d.session_id || d.id || "");
      if (!id) continue;
      const prior = merged.get(id) || { id, project: "", bytes: 0, updated: 0 };
      const file = prior.file || (SESSION_ID.test(id) && typeof d.transcript_path === "string" && d.transcript_path.toLowerCase().endsWith(".jsonl")
        ? d.transcript_path : "");
      merged.set(id, { ...prior, file, title: clip(d.title || prior.title || "", 140), status: String(d.status || ""), harness: String(d.harness || "") });
    }
    index = merged;
    let rows = [...merged.values()].sort((a, b) => (b.status ? 1 : 0) - (a.status ? 1 : 0) || b.updated - a.updated);
    const words = String(query || "").toLowerCase().split(/\s+/).filter(Boolean);
    if (words.length) {
      rows = rows.filter((s) => {
        const hay = `${s.id} ${s.title || ""} ${s.project || ""} ${s.harness || ""}`.toLowerCase();
        return words.every((w) => hay.includes(w));
      });
    }
    return { ok: true, sessions: rows.map(publicSession), total: merged.size,
      sources: {
        journals: local.ok ? { ok: true, note: `${local.total} journals on this computer` } : { ok: false, note: local.reason },
        daemon: live && live.ok ? { ok: true, note: live.note || "" } : { ok: false, note: (live && live.note) || "the harness daemon did not answer" },
      } };
  }

  /** The journal main itself indexed for this id -- a page never names a path. */
  async function fileFor(id) {
    const sid = String(id || "");
    if (!SESSION_ID.test(sid)) return "";
    if (!index.has(sid)) await sessions();
    const row = index.get(sid);
    return row && row.file ? row.file : "";
  }

  async function facts(id) {
    const file = await fileFor(id);
    if (!file) return { ok: false, reason: "1 session has no journal on this computer" };
    return { id: String(id), ...sessionFacts(file, { fsImpl }) };
  }

  async function request(id, requestId) {
    const file = await fileFor(id);
    if (!file) return { ok: false, reason: "1 session has no journal on this computer" };
    return requestDetail(file, requestId, { fsImpl });
  }

  async function traceTool(name, args) {
    let raw;
    try { raw = await bounded(Promise.resolve().then(() => callTool(name, args)), timeoutMs, name); }
    catch (error) { return { ok: false, reason: clip((error && error.message) || error, 200), remedy: "start the local gateway (127.0.0.1:8182)" }; }
    let data = raw;
    if (typeof raw === "string") { try { data = JSON.parse(raw); } catch { data = null; } }
    if (data == null) {
      // Prose is the gateway's own verdict ("Tool ... is not available on the platform tier").
      return { ok: false, refused: /not available|not permitted|denied|forbidden/i.test(String(raw)), reason: clip(raw, 240),
        remedy: "the gateway does not offer the LLM trace tools to this desk" };
    }
    if (!Array.isArray(data) && data.error) return { ok: false, reason: `${name}: ${clip(typeof data.error === "string" ? data.error : JSON.stringify(data.error), 200)}`, remedy: "Genesis keeps the traces: check it is up" };
    return { ok: true, data };
  }

  async function traces({ limit = 20 } = {}) {
    const r = await traceTool("llm_trace_list", { limit: Math.max(1, Math.min(100, Number(limit) || 20)) });
    if (!r.ok) return r;
    const list = Array.isArray(r.data) ? r.data : (Array.isArray(r.data.traces) ? r.data.traces : null);
    if (!list) return { ok: false, reason: "llm_trace_list answered JSON without a trace list", remedy: "Genesis keeps the traces: check it is up" };
    return { ok: true, traces: list.slice(0, 100).filter((t) => t && typeof t === "object").map((t) => ({
      id: String(t.trace_id || ""), requestId: String(t.request_id || ""), at: Number(t.timestamp) ? Math.round(Number(t.timestamp) * 1000) : 0,
      source: String(t.source || ""), agent: String(t.agent_id || ""), model: String(t.model_used || t.model || ""),
      ok: t.success !== false, error: clip(t.error || "", 160), promptTokens: Number(t.prompt_tokens) || 0,
      completionTokens: Number(t.completion_tokens) || 0, totalMs: Math.round(Number(t.total_time_ms) || 0), tools: Number(t.tool_count) || 0,
    })).filter((t) => t.id) };
  }

  /** One platform trace, as the tool returned it (pretty JSON, clipped). */
  async function trace(traceId) {
    const id = String(traceId || "");
    if (!/^[A-Za-z0-9_.:-]{4,120}$/.test(id)) return { ok: false, reason: "not a trace id" };
    const r = await traceTool("llm_trace_get", { trace_id: id });
    if (!r.ok) return r;
    let text;
    try { text = JSON.stringify(r.data, null, 2); } catch { text = String(r.data); }
    return { ok: true, id, text: text.slice(0, 120_000), truncated: text.length > 120_000 };
  }

  async function recall(query) {
    const q = clip(query, 160);
    if (!q) return { ok: false, reason: "type what to recall" };
    let r;
    try { r = await bounded(Promise.resolve().then(() => memory(q)), timeoutMs, "recall"); }
    catch (error) { return { ok: false, reason: clip((error && error.message) || error, 200), remedy: "start the local gateway (127.0.0.1:8182)" }; }
    if (!r || !r.ok) return { ok: false, reason: clip((r && (r.error || r.reason)) || "memory did not answer", 200), remedy: "start the local gateway (127.0.0.1:8182)" };
    return { ok: true, query: q, memories: r.memories || [] };
  }

  return { sessions, facts, request, traces, trace, recall };
}

/** What the pane states it cannot show, and why. One list, so the page and the tests agree. */
const NOT_AVAILABLE = Object.freeze([
  "The assembled prompt of a fleet agent's past call: Genesis records LLM traces, but the gateway offers the llm_trace tools to this desk only when its tier allows; when it refuses, that refusal is shown here.",
  "MicroScheduler's stage timings (/llm/traces/recent): the route needs the fleet's internal key, which the desk does not hold.",
  "Messages older than the part of a journal that was read: each view says how many bytes it covers.",
]);

module.exports = { KINDS, LIMITS, NOT_AVAILABLE, SESSION_ID, blobOf, createContextClient, localSessions, measureContent,
  publicSession, requestDetail, sessionFacts, tailLines, titleFromTail, usageOf };
