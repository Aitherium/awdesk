"use strict";

/**
 * discuss.cjs -- a live, multi-agent discussion on the desk stage.
 *
 * Owner: "put Atlas, Demiurge, Aither and Lyra on the desktop and have them
 * discuss / argue in their own voices."
 *
 * Today the desk's only agent-answer path is `askAgentOverRelay`
 * (main.cjs): post `@agent` to Relay #agents, poll every 3.5 s, 75 s timeout.
 * Genesis /chat timed out at 300 s, and the shared gateway MCP session must
 * not be held. The measured fast path is MicroScheduler's OpenAI-compatible
 * `/v1/chat/completions` with `stream:true`, which bypasses the queue and
 * measured ~4.5 s per line.
 *
 * This module is the DIRECTOR only: it owns turn order, persona prompts,
 * the running transcript, sentence-level pipelining, pause and abort. It is
 * Electron-free and dependency-injected so `node --test` runs with no network
 * and no desktop:
 *
 *   stream({ agent, messages, signal })  -> async iterable of text deltas
 *   speak(agent, text)                   -> Promise<result> (the existing
 *                                           agent-swarm-host speak / speakAloud
 *                                           path, so captions come from the
 *                                           agent's own body)
 *   postLine(agent, text)                -> optional, fire-and-forget relay post
 *
 * What it guarantees:
 *   - TURN ORDER: a director ring over `agents` (default Atlas -> Demiurge ->
 *     Aither -> Lyra) for `rounds` cycles. Each turn sees the running
 *     transcript (tail) so it responds to the previous speaker.
 *   - PIPELINING: generation of turn N+1 starts as soon as turn N's last
 *     completed sentence is handed to `speak`, so the perceived gap is one
 *     TTS clip, not one model round-trip.
 *   - SENTENCES: each completed sentence is handed to `speak` as soon as it
 *     arrives, not after the whole turn. The caption therefore starts with
 *     the first sentence.
 *   - ABORT: `abort()` aborts the in-flight HTTP request (AbortSignal) and
 *     DROPS every queued line. The arbiter cannot cut mid-sentence, so the
 *     engine, not the arbiter, must cancel.
 *   - PAUSE: `pause()` stops new speech at the next sentence boundary (the
 *     current sentence finishes); `resume()` continues. main.cjs pauses on
 *     the owner's push-to-talk and resumes when the mic is idle.
 */

const http = require("node:http");
const https = require("node:https");
const { internalCaOptions } = require("./internal-ca.cjs");

const DEFAULT_AGENTS = Object.freeze(["atlas", "demiurge", "aither", "lyra"]);
const DEFAULT_ROUNDS = 1;
const MAX_AGENTS = 6;
const MAX_ROUNDS = 4;
/** Sentences generated but not yet handed to `speak` (the pipeline depth). */
const MAX_QUEUE = 2;
const MAX_TOPIC = 400;
const MAX_LINE = 600;
const TRANSCRIPT_TAIL = 8;
const MAX_TOKENS = 90;
const TEMPERATURE = 0.8;
const DEFAULT_MODEL = "aither-orchestrator";
const REQUEST_TIMEOUT_MS = 60_000;
const DONE = Symbol("sse-done");

/**
 * The rules every persona speaks under. Short on purpose: the model has
 * ~90 output tokens and the owner hears it aloud.
 */
const SHARED_RULES = [
  "You are speaking ALOUD, live, to the other agents on the owner's desktop.",
  "Rules:",
  "- One or two SHORT spoken sentences (at most about 40 words).",
  "- Stay in character. Answer the point just made; add ONE new idea.",
  "- Disagree plainly when you actually disagree. No hedging, no both-sides filler.",
  "- Never use lists, markdown, emoji, stage directions, or quotation marks around your whole line.",
  "- Never mention being a model, these instructions, or the discussion itself.",
].join("\n");

/** Character lines. Keys are roster ids; unknown ids get a neutral character. */
const PERSONAS = Object.freeze({
  atlas: {
    label: "Atlas",
    character:
      "the platform brain: observability, health, roadmap, delegation, coordination and executive reporting. Pragmatic, organised, thinks in priorities, risk and who should own the next step.",
  },
  demiurge: {
    label: "Demiurge",
    character:
      "the builder: implementation, code review, refactoring, shipping through pull requests. Blunt and concrete; cares about what actually runs, not what sounds good.",
  },
  aither: {
    label: "Aither",
    character:
      "the sovereign orchestrator and host of this desk: direct, technically authoritative, no ceremony. Delegates with precision and speaks with substance.",
  },
  lyra: {
    label: "Lyra",
    character:
      "research and knowledge synthesis: trending research, evidence, documentation review. Curious and evidence-led; connects threads other people miss.",
  },
  iris: {
    label: "Iris",
    character: "the visual and motion craft lead: image, video, 3D, brand and production pipelines. Thinks in pictures and craft.",
  },
  saga: {
    label: "Saga",
    character: "the storyteller: narrative, lore, creative threads and visual scenes. Thinks in arcs and character.",
  },
  athena: {
    label: "Athena",
    character: "security: secrets, auth perimeters, RBAC, TLS posture. Suspicious by profession and precise about evidence.",
  },
  prometheus: {
    label: "Prometheus",
    character: "infrastructure and the fleet: deployment, containers, recovery. Practical and unhurried.",
  },
  hydra: {
    label: "Hydra",
    character: "adversarial review: finds the flaw in the plan before it ships. Independent and unsparing.",
  },
  vera: {
    label: "Vera",
    character: "verification: judges whether a claim was actually proven or merely asserted.",
  },
});

/** "atlas" -> "Atlas", "civic-clerk" -> "Civic Clerk". */
function labelFor(agentId) {
  const id = String(agentId || "").trim().toLowerCase();
  if (!id) return "Agent";
  const known = PERSONAS[id];
  if (known) return known.label;
  return id
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

/** A roster id as the engine stores it (lowercase, safe, bounded). */
function normaliseId(raw) {
  return String(raw == null ? "" : raw)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
}

/** The system prompt for one speaker: its character + the shared spoken rules. */
function personaFor(agentId) {
  const id = normaliseId(agentId) || "aither";
  const p = PERSONAS[id];
  const label = p ? p.label : labelFor(id);
  const character = p ? p.character : "one of the owner's agents, speaking for itself.";
  return { id, label, system: `You are ${label}, ${character}\n\n${SHARED_RULES}` };
}

/** One line of the running transcript, as the next speaker reads it. */
function transcriptText(transcript, agents) {
  const labels = new Map();
  for (const id of agents || []) labels.set(id, personaFor(id).label);
  return (transcript || [])
    .slice(-TRANSCRIPT_TAIL)
    .map((line) => `${labels.get(line.agent) || labelFor(line.agent)}: ${line.text}`)
    .join("\n");
}

/**
 * The OpenAI messages for one turn. Pure, so the test can assert exactly what
 * the next speaker was told.
 */
function buildMessages({ agent, topic, transcript = [], round = 0, rounds = 1, agents = [] }) {
  const persona = personaFor(agent);
  const history = transcriptText(transcript, agents);
  const parts = [`Topic: ${String(topic || "").trim()}`];
  if (history) {
    const previous = transcript.length ? labelFor(transcript[transcript.length - 1].agent) : "";
    parts.push(`The discussion so far:\n${history}`);
    if (previous) parts.push(`Respond to ${previous}'s point. Do not restate it.`);
  } else {
    parts.push("You speak first. Open the discussion with your own angle.");
  }
  parts.push(`This is round ${round + 1} of ${rounds}. Say your next line as ${persona.label}.`);
  return [
    { role: "system", content: persona.system },
    { role: "user", content: parts.join("\n\n") },
  ];
}

/**
 * Split a streaming buffer into COMPLETE sentences and a remainder.
 * A sentence ends at . ! ? (optionally followed by a closing quote/bracket)
 * and whitespace. The final sentence of a turn arrives without trailing
 * whitespace, so the caller flushes the remainder when the stream ends.
 */
function splitSentences(buffer) {
  const text = String(buffer || "");
  const sentences = [];
  const re = /[.!?]+["')\]]?\s+/g;
  let start = 0;
  let m;
  while ((m = re.exec(text)) !== null) {
    const end = m.index + m[0].length;
    const sentence = text.slice(start, end).trim();
    if (sentence) sentences.push(sentence);
    start = end;
  }
  return { sentences, rest: text.slice(start) };
}

/** One speakable/captionable line from model output. */
function cleanLine(text) {
  return String(text == null ? "" : text)
    .replace(/\s+/g, " ")
    .replace(/^[-*>\s]+/, "")
    .replace(/^["'“”]+|["'“”]+$/g, "")
    .trim()
    .slice(0, MAX_LINE);
}

/** The text in one OpenAI streaming chunk (delta, message, or legacy `text`). */
function extractDelta(doc) {
  if (!doc || typeof doc !== "object") return "";
  const choice = Array.isArray(doc.choices) ? doc.choices[0] : null;
  if (!choice) return "";
  const delta = choice.delta || choice.message || null;
  if (delta && typeof delta.content === "string") return delta.content;
  if (typeof choice.text === "string") return choice.text;
  return "";
}

/** `data:` payload of one SSE line -> text, "" for noise/keepalives, DONE at [DONE]. */
function sseLineText(line) {
  const l = String(line == null ? "" : line);
  if (!l || l.startsWith(":")) return "";
  if (!l.startsWith("data:")) return "";
  const data = l.slice(5).trim();
  if (!data) return "";
  if (data === "[DONE]") return DONE;
  try {
    return extractDelta(JSON.parse(data));
  } catch {
    return "";
  }
}

function schedulerUrl(env = process.env) {
  return String(env.AITHER_MICROSCHEDULER_URL || "https://127.0.0.1:8150").replace(/\/+$/, "");
}

function discussModel(env = process.env) {
  return String(env.AWDESK_DISCUSS_MODEL || DEFAULT_MODEL);
}

function readAll(stream) {
  return new Promise((resolve, reject) => {
    let text = "";
    stream.setEncoding("utf8");
    stream.on("data", (chunk) => { text += chunk; });
    stream.on("end", () => resolve(text));
    stream.on("error", reject);
  });
}

/** A refusal from the scheduler as a sentence the caller can log. */
async function refusalText(res) {
  let body = "";
  try { body = await readAll(res); } catch { /* a body we cannot read is no detail */ }
  let detail = "";
  try {
    const doc = JSON.parse(body || "{}");
    const d = doc.detail ?? doc.error ?? doc;
    detail = typeof d === "string" ? d : (d && (d.message || d.error || d.reason)) || "";
  } catch { /* not JSON */ }
  const status = Number(res.statusCode || 0);
  if (status === 429 || status === 503) return `MicroScheduler is busy or has no model ready (${status})${detail ? `: ${detail}` : ""}`;
  return `MicroScheduler answered ${status}${detail ? `: ${detail}` : ""}`;
}

function openRequest(target, body, { secure, signal }) {
  const mod = secure ? https : http;
  const options = {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Content-Length": body.length,
      Accept: "text/event-stream",
    },
    ...(secure ? internalCaOptions() : {}),
  };
  return new Promise((resolve, reject) => {
    const req = mod.request(target, options, resolve);
    const timer = setTimeout(() => {
      req.destroy(new Error(`MicroScheduler did not answer within ${Math.round(REQUEST_TIMEOUT_MS / 1000)} s`));
    }, REQUEST_TIMEOUT_MS);
    if (timer && timer.unref) timer.unref();
    const onAbort = () => req.destroy(Object.assign(new Error("discussion aborted"), { name: "AbortError" }));
    if (signal) {
      if (signal.aborted) onAbort();
      else signal.addEventListener("abort", onAbort, { once: true });
    }
    const cleanup = () => {
      clearTimeout(timer);
      if (signal) signal.removeEventListener("abort", onAbort);
    };
    req.on("error", (error) => { cleanup(); reject(error); });
    req.on("close", cleanup);
    req.end(body);
  });
}

/**
 * The real client: MicroScheduler `/v1/chat/completions` with `stream:true`,
 * its own internal CA (the same resolver the desk's other model doors use),
 * and an AbortSignal that kills the request.
 *
 * Returns an async generator of text deltas. Honours a non-SSE JSON answer
 * (a scheduler that ignores `stream`) by yielding the whole message once.
 */
function createSchedulerStream({ env = process.env, request = openRequest } = {}) {
  return async function* streamChat({ messages, signal, model, maxTokens = MAX_TOKENS, temperature = TEMPERATURE } = {}) {
    if (!Array.isArray(messages) || messages.length === 0) throw new Error("a discussion turn needs messages");
    const target = new URL(`${schedulerUrl(env)}/v1/chat/completions`);
    const secure = target.protocol === "https:";
    const payload = {
      model: model || discussModel(env),
      messages,
      stream: true,
      max_tokens: maxTokens,
      temperature,
      priority: "user",
      source: "desk:discuss",
    };
    const body = Buffer.from(JSON.stringify(payload));
    const res = await request(target, body, { secure, signal });
    if (Number(res.statusCode || 0) !== 200) throw new Error(await refusalText(res));

    const type = String((res.headers && (res.headers["content-type"] || res.headers["Content-Type"])) || "");
    if (type.includes("application/json")) {
      const text = await readAll(res);
      let doc;
      try { doc = JSON.parse(text || "{}"); } catch { throw new Error("MicroScheduler answered with unreadable JSON"); }
      const delta = extractDelta(doc);
      if (delta) yield delta;
      return;
    }

    res.setEncoding("utf8");
    let buffer = "";
    for await (const chunk of res) {
      if (signal && signal.aborted) return;
      buffer += chunk;
      let cut;
      while ((cut = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, cut).replace(/\r$/, "");
        buffer = buffer.slice(cut + 1);
        const text = sseLineText(line);
        if (text === DONE) return;
        if (text) yield text;
      }
    }
    const tail = sseLineText(buffer.replace(/\r$/, ""));
    if (tail && tail !== DONE) yield tail;
  };
}

/** A one-shot promise the engine can fire (no timers, no polling). */
function latch() {
  let fire = () => {};
  const p = new Promise((resolve) => { fire = resolve; });
  return { p, fire };
}

/**
 * createDiscussEngine({ stream, speak, postLine?, now?, log?, maxQueue? })
 *
 *   discuss({topic, agents?, rounds?})  -> Promise<summary>  (resolves at the end)
 *   start({topic, agents?, rounds?})    -> {ok, started}      (returns at once)
 *   abort(reason?)                      -> {ok, dropped}
 *   pause(reason?), resume()            -> {ok, paused}
 *   state()                             -> {running, paused, queued, speaking, transcript}
 */
function createDiscussEngine({ stream, speak, postLine = null, now = Date.now, log = () => {}, maxQueue = MAX_QUEUE } = {}) {
  if (typeof stream !== "function") throw new Error("discuss needs stream({agent, messages, signal})");
  if (typeof speak !== "function") throw new Error("discuss needs speak(agent, text)");
  const depth = Math.max(1, Math.floor(Number(maxQueue) || MAX_QUEUE));

  let current = null;

  function state() {
    if (!current) {
      return { running: false, paused: false, aborted: false, rendered: 0, queued: 0, speaking: false, transcript: [] };
    }
    return {
      running: !current.settled,
      paused: current.paused,
      pausedReason: current.pauseReason,
      aborted: current.aborted,
      topic: current.topic,
      agents: current.agents.slice(),
      rounds: current.rounds,
      rendered: current.lines.length,
      spoken: current.spoken.length,
      queued: current.queue.length,
      speaking: current.speaking,
      dropped: current.dropped,
      errors: current.errors.slice(),
      transcript: current.transcript.slice(),
    };
  }

  function wake(run) {
    const l = run.wake;
    run.wake = latch();
    l.fire();
  }

  function releaseSpace(run) {
    const l = run.space;
    run.space = latch();
    l.fire();
  }

  function waitWhilePaused(run) {
    if (!run.paused || run.aborted) return Promise.resolve();
    return new Promise((resolve) => run.pauseWaiters.push(resolve));
  }

  function flushPause(run) {
    const waiters = run.pauseWaiters.splice(0);
    for (const resolve of waiters) {
      try { resolve(); } catch { /* a waiter must not break a resume */ }
    }
  }

  /** Hand one completed sentence to the speaker queue; hold while it is far behind. */
  async function deliver(run, agent, rawText) {
    await waitWhilePaused(run);
    if (run.aborted) { run.dropped += 1; return false; }
    const text = cleanLine(rawText);
    if (!text) return true;
    const last = run.transcript[run.transcript.length - 1];
    if (last && last.agent === agent && last.text === text) return true; // echo suppression
    const line = { agent, text, turn: run.turn, at: now() };
    run.lines.push(line);
    run.transcript.push({ agent, text });
    run.queue.push(line);
    wake(run);
    if (postLine) {
      try { void Promise.resolve(postLine(agent, text)).catch(() => {}); } catch { /* relay is optional */ }
    }
    while (run.queue.length > depth && !run.aborted) {
      const p = run.space.p;
      if (run.queue.length <= depth || run.aborted) break;
      await p;
    }
    return !run.aborted;
  }

  /** ONE speaker at a time: pull from the queue, await the desk's own speak path. */
  async function speakerLoop(run) {
    for (;;) {
      await waitWhilePaused(run);
      if (run.aborted) return;
      const line = run.queue.shift();
      if (!line) {
        if (run.generationDone) return;
        const p = run.wake.p;
        await p;
        continue;
      }
      if (run.queue.length < depth) releaseSpace(run);
      run.speaking = true;
      try {
        const result = await speak(line.agent, line.text);
        if (!run.aborted) run.spoken.push({ agent: line.agent, text: line.text, ok: result ? result.ok !== false : true });
      } catch (error) {
        run.errors.push(`${line.agent}: ${String((error && error.message) || error)}`);
        log("discuss speak failed", line.agent, error && error.message);
      } finally {
        run.speaking = false;
      }
      if (run.aborted) return;
    }
  }

  /** The director ring: each turn streams, each completed sentence is delivered at once. */
  async function generationLoop(run) {
    const total = run.agents.length * run.rounds;
    for (let turn = 0; turn < total; turn += 1) {
      if (run.aborted) break;
      await waitWhilePaused(run);
      if (run.aborted) break;
      const agent = run.agents[turn % run.agents.length];
      const round = Math.floor(turn / run.agents.length);
      run.turn = turn;
      const messages = buildMessages({ agent, topic: run.topic, transcript: run.transcript, round, rounds: run.rounds, agents: run.agents });
      run.streams += 1;
      let buffer = "";
      try {
        for await (const delta of stream({ agent, messages, signal: run.controller.signal })) {
          if (run.aborted) break;
          if (typeof delta !== "string" || !delta) continue;
          buffer += delta;
          const cut = splitSentences(buffer);
          buffer = cut.rest;
          let keepGoing = true;
          for (const sentence of cut.sentences) {
            keepGoing = await deliver(run, agent, sentence);
            if (!keepGoing) break;
          }
          if (!keepGoing || run.aborted) break;
        }
      } catch (error) {
        if (run.aborted || (error && error.name === "AbortError")) {
          run.aborted = true;
          run.abortReason = run.abortReason || "aborted";
          break;
        }
        run.errors.push(`${agent}: ${String((error && error.message) || error)}`);
        log("discuss stream failed", agent, error && error.message);
      }
      if (run.aborted) break;
      if (buffer.trim()) await deliver(run, agent, buffer.trim());
    }
    run.generationDone = true;
    wake(run);
    releaseSpace(run);
  }

  function summary(run) {
    return {
      ok: !run.aborted,
      aborted: run.aborted,
      reason: run.abortReason || "",
      topic: run.topic,
      agents: run.agents.slice(),
      rounds: run.rounds,
      lines: run.lines.map((l) => ({ agent: l.agent, text: l.text })),
      spoken: run.spoken.slice(),
      transcript: run.transcript.slice(),
      dropped: run.dropped,
      errors: run.errors.slice(),
    };
  }

  function normaliseAgents(raw) {
    const source = raw == null ? DEFAULT_AGENTS : Array.isArray(raw) ? raw : String(raw).split(/[,+\s]+/);
    const out = [];
    for (const item of source) {
      const id = normaliseId(item);
      if (id && !out.includes(id)) out.push(id);
      if (out.length >= MAX_AGENTS) break;
    }
    return out;
  }

  function normaliseRounds(raw) {
    const n = Math.floor(Number(raw));
    if (!Number.isFinite(n) || n < 1) return DEFAULT_ROUNDS;
    return Math.min(MAX_ROUNDS, n);
  }

  function begin(opts = {}) {
    if (current && !current.settled) return { ok: false, error: "a discussion is already running", state: state() };
    const topic = String(opts.topic == null ? "" : opts.topic).trim().slice(0, MAX_TOPIC);
    if (!topic) return { ok: false, error: "a discussion needs a topic" };
    const agents = normaliseAgents(opts.agents);
    if (!agents.length) return { ok: false, error: "a discussion needs at least one agent" };
    const rounds = normaliseRounds(opts.rounds);
    const run = {
      topic,
      agents,
      rounds,
      transcript: [],
      lines: [],
      spoken: [],
      queue: [],
      errors: [],
      dropped: 0,
      streams: 0,
      turn: 0,
      speaking: false,
      paused: false,
      pauseReason: "",
      pauseWaiters: [],
      aborted: false,
      abortReason: "",
      generationDone: false,
      settled: false,
      controller: new AbortController(),
      wake: latch(),
      space: latch(),
    };
    current = run;
    const speakers = speakerLoop(run).catch((error) => {
      run.errors.push(`speaker: ${String((error && error.message) || error)}`);
    });
    run.done = (async () => {
      try {
        await generationLoop(run);
        // An abort must not wait for an in-flight TTS clip: the arbiter finishes the
        // sentence it already has, while the director is already stopped. The speaker
        // loop still exits on its own at the next boundary.
        if (!run.aborted) await speakers;
      } finally {
        run.settled = true;
      }
      return summary(run);
    })();
    run.done.catch(() => {});
    return { ok: true, run, done: run.done };
  }

  function discuss(opts = {}) {
    const started = begin(opts);
    if (!started.ok) return Promise.resolve(started);
    return started.done;
  }

  function start(opts = {}) {
    const started = begin(opts);
    if (!started.ok) return started;
    return {
      ok: true,
      started: true,
      topic: started.run.topic,
      agents: started.run.agents.slice(),
      rounds: started.run.rounds,
    };
  }

  function abort(reason = "aborted") {
    const run = current;
    if (!run || run.settled) return { ok: false, error: "no discussion is running" };
    if (!run.aborted) {
      run.aborted = true;
      run.abortReason = String(reason || "aborted").slice(0, 160);
      run.dropped += run.queue.length;
      run.queue.length = 0;
      try { run.controller.abort(); } catch { /* already gone */ }
      flushPause(run);
      wake(run);
      releaseSpace(run);
    }
    return { ok: true, aborted: true, dropped: run.dropped, state: state() };
  }

  function pause(reason = "paused") {
    const run = current;
    if (!run || run.settled) return { ok: false, error: "no discussion is running" };
    run.paused = true;
    run.pauseReason = String(reason || "paused").slice(0, 160);
    return { ok: true, paused: true };
  }

  function resume() {
    const run = current;
    if (!run || run.settled) return { ok: false, error: "no discussion is running" };
    run.paused = false;
    run.pauseReason = "";
    flushPause(run);
    wake(run);
    releaseSpace(run);
    return { ok: true, paused: false };
  }

  return { discuss, start, abort, pause, resume, state };
}

module.exports = {
  DEFAULT_AGENTS,
  DEFAULT_ROUNDS,
  MAX_AGENTS,
  MAX_ROUNDS,
  MAX_QUEUE,
  PERSONAS,
  buildMessages,
  cleanLine,
  createDiscussEngine,
  createSchedulerStream,
  discussModel,
  extractDelta,
  labelFor,
  normaliseId,
  personaFor,
  schedulerUrl,
  splitSentences,
  sseLineText,
};
