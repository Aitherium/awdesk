"use strict";

/**
 * neurons-model -- the pure half of "visual neurons" (owner, 2026-11-18): let the
 * owner SEE an agent think. While an agent is working or speaking, a small
 * neuron-like graph is drawn around its fairy: nodes are its recent steps
 * (thinking, a tool call, a result, a spoken line), edges are the sequence and the
 * fan-out of parallel tool calls. Nodes pulse when fresh and fade out over ~20 s.
 *
 * This file owns every DECISION and no pixels: event -> node/edge, pairing,
 * decay, caps and the deterministic layout. orb.html owns the canvas; orb-window.cjs
 * owns the windows and the IPC batching (<= 10 Hz, never per frame).
 *
 * Why the pairing rules live here:
 *   - a THINKING step opens a thought; tool calls that arrive within
 *     `fanoutMs` hang off that thought (two tools at once is a fan, not a queue);
 *   - a RESULT pairs with the tool it names, else the newest tool still in
 *     flight, so a result line is not just "the next node";
 *   - everything else follows its predecessor, so the spine is the sequence.
 *
 * PURE: no electron, no fs, no timers, no clock of its own (`now` is injected).
 * node --test.
 */

/** What a step is. Unknown kinds are dropped, never coerced. */
const KINDS = Object.freeze(["thinking", "tool", "result", "line"]);

/** Caps and pacing. A caller may override any positive value (tests do). */
const LIMITS = Object.freeze({
  /** Nodes kept per agent: the newest win, the oldest are dropped with their edges. */
  maxNodes: 12,
  /** Agents kept on screen at once: the least recently active leaves first. */
  maxAgents: 6,
  /** A node fades out over this and is then pruned (owner: "fade over ~20 s"). */
  ttlMs: 20_000,
  /** An edge never outlives its endpoints; this is its own backstop. */
  edgeTtlMs: 20_000,
  /** Tool calls this soon after a thought fan out from that thought. */
  fanoutMs: 1_500,
  /** A result this soon after a tool pairs with it. */
  resultMs: 15_000,
  /** How long a fresh node (or edge) reads as "just happened". */
  pulseMs: 1_200,
  /** A node's label is a tooltip-sized hint, never a transcript. */
  maxLabel: 48,
  /** Incoming text is clipped before it is stored. */
  maxText: 200,
});

/** The angle between successive nodes on the spiral (the sunflower packing). */
const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));
const ROUND_TO = 4;

function clipText(value, max) {
  return String(value == null ? "" : value).replace(/\s+/g, " ").trim().slice(0, max);
}

/** Only positive whole overrides survive; junk leaves the default in place. */
function cleanLimits(raw) {
  const out = {};
  if (!raw || typeof raw !== "object") return out;
  for (const key of Object.keys(LIMITS)) {
    const n = Number(raw[key]);
    if (Number.isFinite(n) && n > 0) out[key] = Math.floor(n);
  }
  return out;
}

/**
 * An event -> {agent, kind, at, tool, text}, or null when it is not a step.
 * `at` is null when the caller did not stamp it (the engine's clock is used).
 */
function normalizeEvent(raw) {
  const e = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : null;
  if (!e) return null;
  const kind = String(e.kind || "").toLowerCase();
  if (!KINDS.includes(kind)) return null;
  const agent = clipText(e.agent, 40).toLowerCase();
  if (!agent) return null;
  const at = Number(e.at);
  return {
    agent,
    kind,
    at: Number.isFinite(at) ? at : null,
    tool: clipText(e.tool, 40),
    text: clipText(e.text, LIMITS.maxText),
  };
}

/**
 * Where the node with generation `seq` sits around its fairy: a sunflower spiral in
 * a unit disc (x, y in [-1, 1], y squashed a little so it reads as a small cloud,
 * not a wheel). Deterministic: the same seq is the same point on every call, so a
 * node never jumps while it fades.
 */
function layoutFor(seq, maxNodes = LIMITS.maxNodes) {
  const slots = Math.max(1, Math.floor(Number(maxNodes) || LIMITS.maxNodes));
  const slot = ((Math.floor(Number(seq) || 0) % slots) + slots) % slots;
  const angle = slot * GOLDEN_ANGLE;
  const radius = 0.34 + (0.66 * (slot + 1)) / slots;
  const round = (v) => Math.round(v * 10 ** ROUND_TO) / 10 ** ROUND_TO;
  return { x: round(Math.cos(angle) * radius), y: round(Math.sin(angle) * radius * 0.86) };
}

/**
 * createNeurons({ now, limits })
 *
 *   ingest(event, at?)   -> the stored node, or null (off-kind, no agent, junk)
 *   snapshot(at?)        -> {agents: [{agent, nodes, edges}], ttlMs, pulseMs}
 *   prune(at?)           -> true when anything expired
 *   count()              -> {agents, nodes, edges}
 *   reset()
 *
 * The engine never runs a timer: `snapshot` prunes what has expired, so a page
 * that stops sending updates still sees the graph empty out by its own clock.
 */
function createNeurons({ now = Date.now, limits = {} } = {}) {
  const L = { ...LIMITS, ...cleanLimits(limits) };
  /** id -> node {id, seq, agent, kind, label, tool, at} */
  let nodes = new Map();
  /** id -> edge {id, from, to, at} */
  let edges = new Map();
  /** agent keys, least recently active first. */
  let order = [];
  let nodeSeq = 0;
  let edgeSeq = 0;

  const clock = () => Number(now()) || 0;

  function touch(agent) {
    const i = order.indexOf(agent);
    if (i >= 0) order.splice(i, 1);
    order.push(agent);
  }

  function agentNodes(agent) {
    return [...nodes.values()].filter((n) => n.agent === agent).sort((a, b) => a.seq - b.seq);
  }

  function dropNode(id) {
    if (!nodes.delete(id)) return false;
    for (const [eid, e] of edges) if (e.from === id || e.to === id) edges.delete(eid);
    return true;
  }

  function prune(at = clock()) {
    const t = Number(at) || 0;
    let changed = false;
    for (const [id, n] of nodes) {
      if (t - n.at >= L.ttlMs) { dropNode(id); changed = true; }
    }
    for (const [id, e] of edges) {
      if (t - e.at >= L.edgeTtlMs) { edges.delete(id); changed = true; }
    }
    for (const agent of [...order]) {
      if (![...nodes.values()].some((n) => n.agent === agent)) {
        order.splice(order.indexOf(agent), 1);
        changed = true;
      }
    }
    return changed;
  }

  /** Which node a new step hangs from: the fan-out and result rules, else the spine. */
  function parentFor(event, at, prior) {
    if (!prior.length) return null;
    const newest = prior[prior.length - 1];
    if (event.kind === "tool") {
      const thought = [...prior].reverse().find((n) => n.kind === "thinking" && at - n.at <= L.fanoutMs);
      return thought || newest;
    }
    if (event.kind === "result") {
      const tools = [...prior].reverse().filter((n) => n.kind === "tool" && at - n.at <= L.resultMs);
      return tools.find((n) => event.tool && n.tool === event.tool) || tools[0] || newest;
    }
    return newest;
  }

  function ingest(raw, at) {
    const event = normalizeEvent(raw);
    if (!event) return null;
    const when = event.at == null ? Number(at == null ? clock() : at) || 0 : event.at;
    prune(when);
    const prior = agentNodes(event.agent);
    const parent = parentFor(event, when, prior);
    nodeSeq += 1;
    const node = {
      id: `n${nodeSeq}`,
      seq: nodeSeq,
      agent: event.agent,
      kind: event.kind,
      label: event.text.slice(0, L.maxLabel),
      tool: event.tool,
      at: when,
    };
    nodes.set(node.id, node);
    touch(event.agent);
    if (parent && when - parent.at < L.edgeTtlMs) {
      edgeSeq += 1;
      edges.set(`e${edgeSeq}`, { id: `e${edgeSeq}`, from: parent.id, to: node.id, at: when });
    }
    // Caps: this agent's own history, then how many agents are drawn at all.
    const list = agentNodes(event.agent);
    for (let i = 0; i < list.length - L.maxNodes; i += 1) dropNode(list[i].id);
    while (order.length > L.maxAgents) {
      const oldest = order.shift();
      for (const n of agentNodes(oldest)) dropNode(n.id);
    }
    return node;
  }

  function snapshot(at) {
    const t = Number(at == null ? clock() : at) || 0;
    prune(t);
    const agents = [];
    for (const agent of [...order].reverse()) {
      const list = agentNodes(agent);
      if (!list.length) continue;
      const alive = new Set(list.map((n) => n.id));
      const points = new Map(list.map((n) => [n.id, layoutFor(n.seq, L.maxNodes)]));
      agents.push({
        agent,
        nodes: list.map((n) => ({
          id: n.id,
          kind: n.kind,
          label: n.label,
          tool: n.tool,
          at: n.at,
          alpha: Math.max(0, Math.min(1, 1 - (t - n.at) / L.ttlMs)),
          pulse: Math.max(0, Math.min(1, 1 - (t - n.at) / L.pulseMs)),
          x: points.get(n.id).x,
          y: points.get(n.id).y,
        })),
        edges: [...edges.values()]
          .filter((e) => alive.has(e.from) && alive.has(e.to))
          .map((e) => ({ from: e.from, to: e.to, at: e.at })),
      });
    }
    return { agents, ttlMs: L.ttlMs, pulseMs: L.pulseMs };
  }

  function count() {
    return { agents: order.length, nodes: nodes.size, edges: edges.size };
  }

  function reset() {
    nodes = new Map();
    edges = new Map();
    order = [];
    nodeSeq = 0;
    edgeSeq = 0;
  }

  return { ingest, snapshot, prune, count, reset, limits: L };
}

module.exports = { KINDS, LIMITS, createNeurons, layoutFor, normalizeEvent };
