"use strict";

/**
 * fairy-cluster -- the ONE fairy cluster grows and shrinks with live state.
 *
 * Owner, 2026-11-16 (angry): "still getting these bullshit decision cards instead of
 * fairies" and "the cluster of fairies should grow with agents and decisions queued
 * and help self clean up." Until now the swarm was one companion per AGENT, off by
 * default, and a decision that was not on screen fell through to awask's Tk card
 * window. This module decides what the cluster holds:
 *
 *   one fairy per queued decision   (key "d:<card id>")   click = that card, inline
 *   one fairy per live agent session (key "s:<session>")  Claude Code tabs + awsh
 *   one fairy per working platform agent (key "a:<agent>") Atlas presence
 *
 * Self-clean (reconcile): every update is the WHOLE truth from each source. An entry
 * its source no longer lists leaves at once (answered, cancelled, expired, session
 * ended). A source that could NOT be read this time (daemon down, gateway 500) does
 * not empty the cluster: its entries stay until `staleMs` (30 s) after they were last
 * seen, then they are reaped as orphans. A fresh reaper (desk start) holds nothing.
 *
 * Clutter cap: past `cap` fairies the tail collapses into one counted bead
 * ({kind:"more", count}); the bead's click opens the waiting list.
 *
 * PURE: no electron. node --test electron/fairy-cluster.test.cjs.
 */

const agentFairy = require("./agent-fairy.cjs");
const toolSurface = require("./tool-surface.cjs");

/** A fairy whose source went unreadable is reaped this long after it was last seen. */
const STALE_MS = 30_000;
/** Fairies drawn before the tail becomes one counted bead. */
const CAP = 6;
/** Session states that mean the session is over (awsh daemon rows). */
const ENDED_RE = /^(ended|exited|done|completed|finished|stopped|killed|failed|dead|closed|cancelled)$/i;
const BUSY_RE = /^(busy|running|working|thinking|active|streaming)$/i;

function clip(s, n) {
  const t = String(s == null ? "" : s).replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
}

function looks(f) {
  return {
    color: f.color, core: f.core, glow: f.glow, wings: f.wings, ring: f.ring,
    sparkles: f.sparkles, crew: Boolean(f.crew),
  };
}

/** Seconds or ms epoch -> ms. */
function toMs(v) {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return n < 1e11 ? n * 1000 : n;
}

/**
 * Is this card still a queued decision at `nowMs`? Status open (or absent: the
 * watcher only hands open cards) and not past its own expiry.
 */
function cardLive(card, nowMs = Date.now()) {
  if (!card || typeof card.id !== "string" || !card.id) return false;
  const st = String(card.status || "open").toLowerCase();
  if (st !== "open") return false;
  const exp = toMs(card.deadline || card.expiresAt || card.expires_at);
  if (exp && exp <= nowMs) return false;
  return true;
}

/** One fairy per queued decision, newest first. */
function decisionEntries(cards, nowMs = Date.now()) {
  const list = (Array.isArray(cards) ? cards : []).filter((c) => cardLive(c, nowMs));
  list.sort((a, b) => toMs(b.createdAt || b.created_at) - toMs(a.createdAt || a.created_at));
  return list.map((card) => {
    const agent = agentFairy.cardAgent(card) || "aither";
    const f = agent.startsWith("session-") ? agentFairy.crewFairy(agent) : agentFairy.crewFairy(card.agent || agent);
    return {
      key: `d:${card.id}`, kind: "decision", source: "cards",
      agent: f.agent || agent, label: f.known || f.crew ? f.label : "Decision",
      ...looks(f),
      state: "waiting", cardId: card.id, sessionId: String(card.sessionId || ""),
      title: clip(String(card.title || "A decision").replace(/^Claude Code needs you:\s*/i, ""), 110),
      count: 1,
    };
  });
}

/**
 * Normalise every session source to {id, label, state, harness, detail}. Accepts
 * session-context.liveSessions() Maps (Claude Code tabs, pid-checked) and the awsh
 * daemon's /sessions/unified rows. Ended rows are dropped here.
 *
 * `detail` is the daemon's last_activity_summary. That is where a running tool call
 * is named ("running Bash", "running mcp__aitheros__web_search"), so the fairy can
 * fly to the surface doing the work (tool-surface.cjs -> fairy-flight.cjs).
 */
function sessionRows(sources) {
  const out = new Map();
  const add = (id, label, status, harness, detail = "") => {
    const sid = String(id || "").trim();
    if (!sid || ENDED_RE.test(String(status || "").trim())) return;
    const key = agentFairy.sessionKey(sid);
    if (!key) return;
    const prev = out.get(key);
    const state = BUSY_RE.test(String(status || "").trim()) ? "working" : "idle";
    if (prev) {
      if (state === "working") prev.state = "working";
      if (!prev.label && label) prev.label = label;
      // The daemon row outranks the tab's bare status: it is the one that names the tool.
      if (!prev.detail && detail) prev.detail = clip(detail, 120);
      return;
    }
    out.set(key, { key, id: sid, label: clip(label, 40), state, harness: String(harness || ""), detail: clip(detail, 120) });
  };
  for (const src of Array.isArray(sources) ? sources : [sources]) {
    if (!src) continue;
    if (src instanceof Map) {
      for (const [id, s] of src) {
        const cwd = String((s && s.cwd) || "").replace(/[\\/]+$/, "");
        add(id, (s && s.name) || cwd.split(/[\\/]/).pop() || "Claude session", s && s.status, "claude-code");
      }
      continue;
    }
    for (const row of Array.isArray(src) ? src : []) {
      if (!row || typeof row !== "object") continue;
      const id = row.session_id || row.sessionId || row.id;
      const label = row.name || row.title || row.label || row.harness || "";
      const status = row.status || row.state || "";
      if (row.alive === false || row.live === false) continue;
      add(id, label, status, row.harness || row.kind || "", row.last_activity_summary || row.detail || "");
    }
  }
  return [...out.values()];
}

function sessionEntries(rows) {
  return (Array.isArray(rows) ? rows : []).map((s) => {
    const f = agentFairy.crewFairy(s.key);
    const call = toolSurface.parseRunning(s.detail);
    return {
      key: `s:${s.key}`, kind: "session", source: "sessions",
      agent: s.key, label: s.label || "Agent session", ...looks(f),
      state: s.state, cardId: "", sessionId: s.id,
      // The live tool call, when the daemon names one (never from prose: see parseRunning).
      tool: call ? call.tool : "", surface: call ? call.surface : "",
      title: call
        ? `${s.label || "Session"} is using ${call.tool}`
        : s.state === "working" ? `${s.label || "Session"} is working` : `${s.label || "Session"} is idle`,
      count: 0,
    };
  });
}

/** Platform agents (Atlas presence) that are working or waiting: one fairy each. */
function agentEntries(presence) {
  const out = [];
  const seen = new Set();
  for (const raw of Array.isArray(presence) ? presence : []) {
    const row = agentFairy.normalizePresence(raw);
    if (!row || row.agent.startsWith("session-") || seen.has(row.agent)) continue;
    if (row.state !== "working" && row.state !== "waiting") continue;
    seen.add(row.agent);
    const f = agentFairy.crewFairy(row.agent);
    out.push({
      key: `a:${row.agent}`, kind: "agent", source: "presence",
      agent: f.agent || row.agent, label: row.label || f.label, ...looks(f),
      state: "working", cardId: "", sessionId: "",
      title: clip(row.work.length ? row.work[0].title : `${row.label || f.label} is working`, 110),
      count: 0, threadUrl: row.threadUrl, dmUrl: row.dmUrl, bot: row.bot,
    });
  }
  return out;
}

/** The ONE AitherTab companion (awtab.cjs builds it): mirrored browser tab groups. */
function aithertabEntries(entry) {
  if (!entry || !entry.key) return [];
  return [{ ...entry, ...looks(agentFairy.crewFairy(entry.agent || "aithertab")), count: Number(entry.count) || 0 }];
}

/** Every entry the live sources hold now, decisions first. */
function liveEntries({ cards = [], sessions = [], presence = [], aithertab = null, nowMs = Date.now() } = {}) {
  return [
    ...decisionEntries(cards, nowMs),
    ...sessionEntries(sessionRows(sessions)),
    ...agentEntries(presence),
    ...aithertabEntries(aithertab),
  ];
}

const KIND_RANK = { decision: 0, session: 1, agent: 2, aithertab: 3 };
const STATE_RANK = { waiting: 0, working: 1, idle: 2 };

function ordered(list) {
  return list.map((e, i) => ({ e, i })).sort((a, b) => ((KIND_RANK[a.e.kind] ?? 9) - (KIND_RANK[b.e.kind] ?? 9))
    || ((STATE_RANK[a.e.state] ?? 9) - (STATE_RANK[b.e.state] ?? 9)) || (a.i - b.i)).map((x) => x.e);
}

/**
 * The reaper: remembers when each fairy was last seen, so a source that could not be
 * read keeps its fairies for `staleMs` and no longer.
 *
 * reconcile(entries, {nowMs, ok}) -- `entries` is liveEntries(); `ok` says which
 * sources were READ this time ({cards, sessions, presence}: false = unreadable).
 * Returns {kept, left}: kept in cluster order, left = keys that just went.
 */
function createReaper({ staleMs = STALE_MS } = {}) {
  const held = new Map(); // key -> {entry, seenAt}
  function reconcile(entries, { nowMs = Date.now(), ok = {} } = {}) {
    const fresh = new Map((Array.isArray(entries) ? entries : []).filter((e) => e && e.key).map((e) => [e.key, e]));
    const left = [];
    for (const [key, h] of held) {
      if (fresh.has(key)) continue;
      const readable = ok[h.entry.source] !== false;
      if (readable || nowMs - h.seenAt >= staleMs) {
        held.delete(key);
        left.push(key);
      }
    }
    for (const [key, entry] of fresh) held.set(key, { entry, seenAt: nowMs });
    return { kept: ordered([...held.values()].map((h) => h.entry)), left };
  }
  return {
    reconcile,
    size: () => held.size,
    keys: () => [...held.keys()],
    /** Desk start / owner "clear": nothing carried over. */
    reset: () => { held.clear(); },
  };
}

/**
 * The fairies to draw: up to `cap`; past that, cap-1 fairies and one bead that
 * counts the rest. Returns {shown, total, hidden}.
 */
function collapse(list, cap = CAP) {
  const all = Array.isArray(list) ? list : [];
  const max = Math.max(1, Math.floor(Number(cap) || CAP));
  if (all.length <= max) return { shown: all.slice(), total: all.length, hidden: 0 };
  const keep = all.slice(0, max - 1);
  const rest = all.slice(max - 1);
  const waiting = rest.filter((e) => e.kind === "decision").length;
  const bead = {
    key: "more", kind: "more", source: "", agent: "more", label: `${rest.length} more`,
    color: "#e8d9a8", core: "#ffffff", glow: "#e8d9a8", wings: "none", ring: true, sparkles: false, crew: false,
    state: waiting ? "waiting" : "working", cardId: "", sessionId: "",
    title: waiting ? `${rest.length} more: ${waiting} waiting on you` : `${rest.length} more agents at work`,
    count: rest.length, waiting,
  };
  return { shown: [...keep, bead], total: all.length, hidden: rest.length };
}

/** What a cluster count reads: "3 waiting · 2 agents". */
function countLabel(list) {
  const all = Array.isArray(list) ? list : [];
  const d = all.filter((e) => e.kind === "decision").length;
  const a = all.length - d;
  const parts = [];
  if (d) parts.push(`${d} waiting`);
  if (a) parts.push(`${a} ${a === 1 ? "agent" : "agents"}`);
  return parts.join(" · ");
}

module.exports = {
  STALE_MS,
  CAP,
  cardLive,
  decisionEntries,
  sessionRows,
  sessionEntries,
  agentEntries,
  aithertabEntries,
  liveEntries,
  createReaper,
  collapse,
  countLabel,
};
