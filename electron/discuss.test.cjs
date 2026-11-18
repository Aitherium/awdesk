"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const discuss = require("./discuss.cjs");

const tick = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));

function deferred() {
  let resolve;
  let reject;
  const p = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { p, resolve, reject };
}

async function waitUntil(condition, { timeoutMs = 3000, label = "condition" } = {}) {
  const end = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${label}`);
    await new Promise((resolve) => setImmediate(resolve));
  }
}

/** A fake streaming client: one scripted line per turn, split into chunks. */
function scripted(turns) {
  const calls = [];
  async function* stream({ agent, messages, signal }) {
    const index = calls.length;
    const text = turns[index] ?? `${agent} line ${index + 1}.`;
    calls.push({ agent, messages, signal });
    for (const sentence of text.match(/[^.!?]+[.!?]+/g) || [text]) {
      yield `${sentence.trim()} `;
      await Promise.resolve();
    }
  }
  return { stream, calls };
}

function engineWith(stream, speak, extra = {}) {
  return discuss.createDiscussEngine({ stream, speak, ...extra });
}

test("splitSentences returns complete sentences and leaves a remainder", () => {
  const a = discuss.splitSentences("Hello there. How are you? I am");
  assert.deepEqual(a.sentences, ["Hello there.", "How are you?"]);
  assert.equal(a.rest, "I am");
  const b = discuss.splitSentences("No punctuation yet");
  assert.deepEqual(b.sentences, []);
  assert.equal(b.rest, "No punctuation yet");
  const c = discuss.splitSentences('She said "go." Then left. ');
  assert.deepEqual(c.sentences, ['She said "go."', "Then left."]);
});

test("extractDelta reads streaming, non-streaming and legacy chunks", () => {
  assert.equal(discuss.extractDelta({ choices: [{ delta: { content: "hey" } }] }), "hey");
  assert.equal(discuss.extractDelta({ choices: [{ message: { content: "full" } }] }), "full");
  assert.equal(discuss.extractDelta({ choices: [{ text: "compat" }] }), "compat");
  assert.equal(discuss.extractDelta({ choices: [{ delta: { role: "assistant" } }] }), "");
  assert.equal(discuss.extractDelta(null), "");
});

test("sseLineText: data lines only, [DONE] is terminal", () => {
  assert.equal(discuss.sseLineText('data: {"choices":[{"delta":{"content":"one"}}]}'), "one");
  assert.equal(discuss.sseLineText(": keepalive"), "");
  assert.equal(discuss.sseLineText("event: ping"), "");
  assert.equal(discuss.sseLineText("data: [DONE]"), discuss.sseLineText("data: [DONE]"));
  assert.notEqual(discuss.sseLineText("data: [DONE]"), "one");
});

test("the persona prompt keeps the character and the spoken rules", () => {
  const p = discuss.personaFor("demiurge");
  assert.equal(p.label, "Demiurge");
  assert.match(p.system, /the builder/);
  assert.match(p.system, /SHORT spoken sentences/);
  assert.match(p.system, /Disagree plainly/);
  assert.match(p.system, /Never mention being a model/);
  const unknown = discuss.personaFor("civic-clerk");
  assert.equal(unknown.label, "Civic Clerk");
  assert.match(unknown.system, /one of the owner's agents/);
});

test("buildMessages carries the topic, the running transcript and the previous speaker", () => {
  const transcript = [
    { agent: "atlas", text: "We should ship the smaller slice." },
    { agent: "demiurge", text: "It is not tested yet." },
  ];
  const messages = discuss.buildMessages({
    agent: "aither",
    topic: "Ship it?",
    transcript,
    round: 0,
    rounds: 2,
    agents: ["atlas", "demiurge", "aither"],
  });
  assert.equal(messages[0].role, "system");
  assert.match(messages[0].content, /You are Aither/);
  assert.equal(messages[1].role, "user");
  assert.match(messages[1].content, /Topic: Ship it\?/);
  assert.match(messages[1].content, /Atlas: We should ship the smaller slice\./);
  assert.match(messages[1].content, /Demiurge: It is not tested yet\./);
  assert.match(messages[1].content, /Respond to Demiurge's point/);
  assert.match(messages[1].content, /round 1 of 2/);
});

test("the director ring speaks in order, defaults to Atlas/Demiurge/Aither/Lyra, and each turn reads the transcript", async () => {
  const turns = [
    "Atlas opens the point.",
    "Demiurge answers it.",
    "Aither closes the loop.",
    "Lyra adds the evidence.",
  ];
  const { stream, calls } = scripted(turns);
  const spoken = [];
  const engine = engineWith(stream, async (agent, text) => { spoken.push({ agent, text }); return { ok: true }; });

  const result = await engine.discuss({ topic: "Ship it?" });

  assert.deepEqual(calls.map((c) => c.agent), ["atlas", "demiurge", "aither", "lyra"]);
  assert.deepEqual(spoken.map((s) => s.agent), ["atlas", "demiurge", "aither", "lyra"]);
  assert.equal(result.ok, true);
  assert.equal(result.lines.length, 4);
  assert.equal(result.dropped, 0);
  // Turn 1 was told nothing yet; turn 2 read turn 1's line.
  assert.doesNotMatch(calls[0].messages[1].content, /Atlas opens the point\./);
  assert.match(calls[1].messages[1].content, /Atlas opens the point\./);
  assert.match(calls[3].messages[1].content, /Aither closes the loop\./);
});

test("rounds repeat the ring in order", async () => {
  const turns = ["one.", "two.", "three.", "four."];
  const { stream, calls } = scripted(turns);
  const engine = engineWith(stream, async () => ({ ok: true }));
  const result = await engine.discuss({ topic: "t", agents: ["atlas", "demiurge"], rounds: 2 });
  assert.deepEqual(calls.map((c) => c.agent), ["atlas", "demiurge", "atlas", "demiurge"]);
  assert.equal(result.lines.length, 4);
});

test("the next turn streams while the previous line is still being spoken", async () => {
  const gate = deferred();
  const order = [];
  async function* stream({ agent }) {
    order.push(`stream:${agent}`);
    yield `${agent} speaks. `;
  }
  const speak = async (agent) => {
    order.push(`speak:${agent}`);
    if (agent === "atlas") await gate.p;
    return { ok: true };
  };
  const engine = engineWith(stream, speak);

  const done = engine.discuss({ topic: "pipeline", agents: ["atlas", "demiurge"], rounds: 1 });
  await waitUntil(() => order.includes("stream:demiurge"), { label: "turn 2 to start streaming" });
  assert.ok(order.includes("speak:atlas"), "turn 1 is still being spoken");
  assert.ok(order.indexOf("stream:demiurge") > order.indexOf("speak:atlas"));
  gate.resolve();
  const result = await done;
  assert.equal(result.ok, true);
  assert.deepEqual(result.lines.map((l) => l.agent), ["atlas", "demiurge"]);
});

test("abort stops generation, aborts the request and drops every queued line", async () => {
  const gate = deferred();
  const spoken = [];
  const signals = [];
  async function* stream({ signal }) {
    signals.push(signal);
    for (let n = 1; n <= 4; n += 1) yield `line ${n}. `;
  }
  const speak = async (agent, text) => {
    spoken.push(text);
    await gate.p;
    return { ok: true };
  };
  const engine = engineWith(stream, speak);

  const done = engine.discuss({ topic: "stop me", agents: ["atlas"], rounds: 1 });
  await waitUntil(() => engine.state().speaking === true, { label: "the first line to be spoken" });
  await waitUntil(() => engine.state().rendered >= 3, { label: "lines to queue up" });

  const stopped = engine.abort("the owner said stop");
  assert.equal(stopped.ok, true);
  assert.ok(stopped.dropped >= 1, "queued lines are counted as dropped");

  const result = await done;
  assert.equal(result.ok, false);
  assert.equal(result.aborted, true);
  assert.equal(result.reason, "the owner said stop");
  assert.equal(engine.state().running, false);
  assert.equal(engine.state().queued, 0);
  assert.equal(signals[0].aborted, true, "the streaming request's signal is aborted");

  const before = spoken.length;
  gate.resolve();
  await tick(25);
  assert.equal(spoken.length, before, "no dropped line reaches speak after the abort");
});

test("pause holds new speech at a sentence boundary; resume continues", async () => {
  const first = deferred();
  const spoken = [];
  async function* stream({ agent }) {
    yield `${agent} one. `;
    yield `${agent} two. `;
  }
  const speak = async (agent, text) => {
    spoken.push({ agent, text });
    if (spoken.length === 1) await first.p;
    return { ok: true };
  };
  const engine = engineWith(stream, speak);

  const done = engine.discuss({ topic: "barge in", agents: ["atlas", "demiurge"], rounds: 1 });
  await waitUntil(() => spoken.length === 1, { label: "the first line" });
  const paused = engine.pause("the owner started talking");
  assert.equal(paused.ok, true);
  assert.equal(engine.state().paused, true);

  first.resolve();
  await tick(30);
  assert.equal(spoken.length, 1, "paused: nothing new is spoken");

  const resumed = engine.resume();
  assert.equal(resumed.ok, true);
  const result = await done;
  assert.equal(result.ok, true);
  assert.ok(spoken.length >= 2, "the discussion continues after resume");
});

test("a running discussion refuses a second start, and stop frees it", async () => {
  const gate = deferred();
  async function* stream() { yield "one. "; }
  const engine = engineWith(stream, async () => { await gate.p; return { ok: true }; });

  const done = engine.discuss({ topic: "one at a time", agents: ["atlas"], rounds: 1 });
  await waitUntil(() => engine.state().speaking === true, { label: "the first line" });
  const second = await engine.discuss({ topic: "again" });
  assert.equal(second.ok, false);
  assert.match(second.error, /already running/);

  engine.abort("done");
  gate.resolve();
  await done;

  const after = engine.start({ topic: "fresh", agents: ["atlas"], rounds: 1 });
  assert.equal(after.ok, true);
  engine.abort("cleanup");
});

test("input is normalised: unknown agents, duplicate ids, a topic and clamped rounds", async () => {
  const { stream, calls } = scripted(["a.", "b.", "c."]);
  const engine = engineWith(stream, async () => ({ ok: true }));
  const empty = await engine.discuss({ topic: "   " });
  assert.equal(empty.ok, false);
  assert.match(empty.error, /needs a topic/);

  const result = await engine.discuss({ topic: "x", agents: ["Atlas", "atlas", "Demiurge"], rounds: 99 });
  assert.deepEqual(calls.map((c) => c.agent), ["atlas", "demiurge", "atlas", "demiurge", "atlas", "demiurge", "atlas", "demiurge"]);
  assert.equal(result.ok, true);
  assert.equal(result.rounds, discuss.MAX_ROUNDS);
});

test("the scheduler client streams deltas from an injected SSE response and asks for stream+priority", async () => {
  const { Readable } = require("node:stream");
  let captured = null;
  const request = async (target, body) => {
    captured = { url: String(target), payload: JSON.parse(body.toString()) };
    const res = Readable.from([
      'data: {"choices":[{"delta":{"content":"Hello"}}]}\n\n',
      'data: {"choices":[{"delta":{"content":" there."}}]}\n\n',
      "data: [DONE]\n\n",
    ]);
    res.statusCode = 200;
    res.headers = { "content-type": "text/event-stream" };
    return res;
  };
  const stream = discuss.createSchedulerStream({ env: {}, request });
  const chunks = [];
  for await (const delta of stream({ messages: [{ role: "user", content: "hi" }], signal: new AbortController().signal })) {
    chunks.push(delta);
  }
  assert.equal(chunks.join(""), "Hello there.");
  assert.match(captured.url, /\/v1\/chat\/completions$/);
  assert.equal(captured.payload.stream, true);
  assert.equal(captured.payload.priority, "user");
  assert.equal(captured.payload.model, "aither-orchestrator");
  assert.deepEqual(captured.payload.messages, [{ role: "user", content: "hi" }]);
});

test("the scheduler client turns a refusal into a sentence the desk can log", async () => {
  const { Readable } = require("node:stream");
  const request = async () => {
    const res = Readable.from([JSON.stringify({ detail: "no model ready" })]);
    res.statusCode = 429;
    res.headers = { "content-type": "application/json" };
    return res;
  };
  const stream = discuss.createSchedulerStream({ env: {}, request });
  await assert.rejects(
    async () => {
      const drained = [];
      for await (const chunk of stream({ messages: [{ role: "user", content: "x" }], signal: new AbortController().signal })) drained.push(chunk);
      assert.deepEqual(drained, [], "a refusal yields no text");
    },
    /MicroScheduler is busy.*429.*no model ready/,
  );
});
