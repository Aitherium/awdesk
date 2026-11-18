"use strict";

// neurons-model.cjs: the pure decisions behind the "visual neurons" overlay.
// Event -> node/edge, the fan-out and result pairing, decay over ~20 s, the caps,
// and a deterministic layout. No pixels and no timers live here (orb.html draws).

const test = require("node:test");
const assert = require("node:assert/strict");

const model = require("./neurons-model.cjs");
const { createNeurons, layoutFor, LIMITS } = model;

/** A clock the test drives by hand. */
function bench(opts) {
  let t = 1_000_000;
  const neurons = createNeurons({ now: () => t, ...opts });
  return {
    neurons,
    at: () => t,
    /** Advance the clock by `ms`, then note a step (stamped with the new time). */
    step(agent, kind, extra = {}, ms = 100) {
      t += ms;
      return neurons.ingest({ agent, kind, ...extra }, t);
    },
    advance(ms) { t += ms; },
    snap() { return neurons.snapshot(t); },
  };
}

test("junk is dropped: no kind, no agent, not an object, a kind nobody defined", () => {
  const b = bench();
  for (const junk of [null, undefined, 42, "thinking", [], {}, { kind: "thinking" },
    { agent: "atlas" }, { agent: "atlas", kind: "telepathy" }, { agent: "   ", kind: "line" }]) {
    assert.equal(b.neurons.ingest(junk), null, JSON.stringify(junk));
  }
  assert.deepEqual(b.neurons.count(), { agents: 0, nodes: 0, edges: 0 });
  assert.deepEqual(b.snap().agents, []);
});

test("a step becomes a node; the next step hangs from it (the spine is the sequence)", () => {
  const b = bench();
  const a = b.step("atlas", "thinking", { text: "  reading the   board " });
  const c = b.step("atlas", "line", { text: "On it." });
  assert.equal(a.kind, "thinking");
  assert.equal(a.label, "reading the board", "whitespace collapses");
  const [agent] = b.snap().agents;
  assert.equal(agent.agent, "atlas");
  assert.equal(agent.nodes.length, 2);
  assert.equal(agent.nodes[1].label, "On it.");
  assert.deepEqual(agent.edges.map((e) => [e.from, e.to]), [[a.id, c.id]]);
});

test("parallel tool calls fan out from the thought, not from each other", () => {
  const b = bench();
  const thought = b.step("demiurge", "thinking", { text: "planning the edit" });
  const t1 = b.step("demiurge", "tool", { tool: "fs_read", text: "fs_read" }, 300);
  const t2 = b.step("demiurge", "tool", { tool: "fs_grep", text: "fs_grep" }, 300);
  const [agent] = b.snap().agents;
  const from = agent.edges.map((e) => [e.from, e.to]);
  assert.deepEqual(from, [[thought.id, t1.id], [thought.id, t2.id]], "both tools fan from the thought");
  assert.equal(agent.edges.filter((e) => e.from === t1.id).length, 0);
});

test("a tool call after the fan-out window follows the previous node instead", () => {
  const b = bench();
  const thought = b.step("atlas", "thinking");
  const later = b.step("atlas", "tool", { tool: "board_read" }, LIMITS.fanoutMs + 1);
  const [agent] = b.snap().agents;
  assert.deepEqual(agent.edges.map((e) => [e.from, e.to]), [[thought.id, later.id]]);
});

test("a result pairs with the tool it names, else the newest tool still in flight", () => {
  const b = bench();
  const thought = b.step("lyra", "thinking");
  const read = b.step("lyra", "tool", { tool: "fs_read" }, 200);
  const grep = b.step("lyra", "tool", { tool: "fs_grep" }, 200);
  const named = b.step("lyra", "result", { tool: "fs_read", text: "done" }, 200);
  const [agent] = b.snap().agents;
  const namedEdge = agent.edges.find((e) => e.to === named.id);
  assert.equal(namedEdge.from, read.id, "the result of fs_read hangs from fs_read, not the newest tool");

  const unnamed = b.step("lyra", "result", { text: "done" }, 200);
  const [after] = b.snap().agents;
  const unnamedEdge = after.edges.find((e) => e.to === unnamed.id);
  assert.ok([read.id, grep.id, thought.id].includes(unnamedEdge.from), "an unnamed result still attaches to a live step");
});

test("a result older than resultMs falls back to the previous node", () => {
  const b = bench();
  const tool = b.step("atlas", "tool", { tool: "slow" });
  const line = b.step("atlas", "line", { text: "waiting" }, 100);
  const result = b.step("atlas", "result", { tool: "slow" }, LIMITS.resultMs + 1);
  const [agent] = b.snap().agents;
  const edge = agent.edges.find((e) => e.to === result.id);
  assert.equal(edge.from, line.id, "the tool expired out of the pairing window");
  assert.ok(tool.id);
});

test("alpha falls with age and the node is pruned after the ttl; nodes and edges both go", () => {
  const b = bench();
  b.step("atlas", "thinking");
  const second = b.step("atlas", "line", { text: "hi" }, 100);
  const fresh = b.snap().agents[0].nodes[1];
  assert.ok(fresh.alpha > 0.99, `fresh alpha ${fresh.alpha}`);
  assert.equal(fresh.pulse, 1);

  b.advance(LIMITS.ttlMs / 2);
  const half = b.snap().agents[0].nodes[1];
  assert.ok(half.alpha > 0.4 && half.alpha < 0.6, `half alpha ${half.alpha}`);
  assert.equal(half.pulse, 0, "the pulse is over long before the fade");

  b.advance(LIMITS.ttlMs);
  assert.deepEqual(b.snap().agents, [], "everything expired");
  assert.deepEqual(b.neurons.count(), { agents: 0, nodes: 0, edges: 0 });
  assert.ok(second.id);
});

test("the per-agent cap drops the OLDEST node and every edge that touched it", () => {
  const b = bench({ limits: { maxNodes: 3 } });
  const first = b.step("atlas", "thinking");
  b.step("atlas", "tool", { tool: "a" });
  b.step("atlas", "tool", { tool: "b" });
  b.step("atlas", "tool", { tool: "c" });
  const [agent] = b.snap().agents;
  assert.equal(agent.nodes.length, 3);
  assert.ok(!agent.nodes.some((n) => n.id === first.id), "the oldest node left");
  for (const e of agent.edges) assert.notEqual(e.from, first.id, "no edge points at a dropped node");
});

test("only maxAgents are drawn; the least recently active agent leaves first", () => {
  const b = bench({ limits: { maxAgents: 2 } });
  b.step("atlas", "thinking");
  b.step("hera", "thinking");
  b.step("atlas", "line", { text: "still here" }); // atlas is now the most recent
  b.step("lyra", "thinking");
  const agents = b.snap().agents.map((a) => a.agent);
  assert.deepEqual(agents, ["lyra", "atlas"], "hera was the least recently active");
  assert.deepEqual(b.neurons.count(), { agents: 2, nodes: 3, edges: 1 });
});

test("the layout is deterministic, bounded and different per step", () => {
  const one = layoutFor(1, 12);
  assert.deepEqual(layoutFor(1, 12), one, "same seq, same point");
  for (let seq = 0; seq < 40; seq += 1) {
    const p = layoutFor(seq, 12);
    assert.ok(Number.isFinite(p.x) && Number.isFinite(p.y), `seq ${seq} is finite`);
    assert.ok(Math.abs(p.x) <= 1 && Math.abs(p.y) <= 1, `seq ${seq} inside the unit disc`);
  }
  assert.notDeepEqual(layoutFor(1, 12), layoutFor(2, 12));
});

test("snapshot is stable for the same clock and orders agents most recently active first", () => {
  const b = bench();
  b.step("atlas", "thinking");
  b.step("lyra", "thinking");
  const one = b.snap();
  const two = b.snap();
  assert.deepEqual(one, two, "no hidden state moves between reads");
  assert.deepEqual(one.agents.map((a) => a.agent), ["lyra", "atlas"]);
  assert.equal(one.ttlMs, LIMITS.ttlMs);
});

test("each node carries its label, tool and pulse; edges carry a time", () => {
  const b = bench();
  b.step("atlas", "thinking", { text: `${"x".repeat(80)}` });
  b.step("atlas", "tool", { tool: "fs_read", text: "reading" });
  const [agent] = b.snap().agents;
  assert.equal(agent.nodes[0].label.length, LIMITS.maxLabel, "the label is clipped");
  assert.equal(agent.nodes[1].tool, "fs_read");
  assert.ok(Number.isFinite(agent.edges[0].at));
});

test("reset empties everything and the next node starts a new sequence", () => {
  const b = bench();
  b.step("atlas", "thinking");
  b.neurons.reset();
  assert.deepEqual(b.neurons.count(), { agents: 0, nodes: 0, edges: 0 });
  const after = b.step("atlas", "line");
  assert.equal(after.id, "n1");
});
