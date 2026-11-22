"use strict";

// The Context tab: what is measured from a journal, what the platform answers, and
// what is said to be unavailable. Fixture journals use the record shapes Claude Code
// 2.1.325 wrote on 2026-11-13 (user / assistant turns, api-request, -shape, -blob).

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { NOT_AVAILABLE, createContextClient, localSessions, measureContent, requestDetail, sessionFacts, titleFromTail, usageOf } = require("./explore-context.cjs");

const SID = "11111111-2222-4333-8444-555555555555";
const OTHER = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const H1 = "a".repeat(64);
const H2 = "b".repeat(64);
const H3 = "c".repeat(64);
const SHAPE = "d".repeat(64);
const REQ = "95ddd35c-fd94-425e-b712-f5be7127d76e";

const usage = { input_tokens: 2, cache_creation_input_tokens: 3000, cache_read_input_tokens: 200000, output_tokens: 400 };
const RECORDS = [
  { parentUuid: null, isSidechain: false, promptId: "p1", type: "user", message: { role: "user", content: "Find the wiki pages about the agent loop." }, uuid: "u1", timestamp: "2026-11-13T10:00:00.000Z" },
  { type: "api-request-shape", sessionId: SID, shapeHash: SHAPE, shape: { system: [{ type: "text", text: "You are an agent." }, { type: "text", text: "S".repeat(5000) }],
    tools: [{ name: "Bash", description: "run a command", input_schema: {} }, { name: "Read", description: "read a file", input_schema: {} }] } },
  { type: "api-request-blob", sessionId: SID, hash: H1, message: { role: "user", content: [{ type: "text", text: "Find the wiki pages about the agent loop." }] } },
  { type: "api-request-blob", sessionId: SID, hash: H2, message: { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "rg loop" } }] } },
  { type: "api-request", sessionId: SID, id: REQ, timestamp: "2026-11-13T10:00:01.000Z", version: "2.1.325", querySource: "repl_main_thread", shapeHash: SHAPE,
    params: { model: "claude-fable-5-2", betas: ["a", "b"], max_tokens: 128000, thinking: { type: "adaptive" }, output_config: { effort: "medium" } },
    base: "00000000-0000-4000-8000-000000000000", keep: 5, tail: [H1, H2, H3] },
  // One API message journalled as two records (a thinking block, then a tool call) with the SAME usage.
  { parentUuid: "u1", isSidechain: false, message: { model: "claude-fable-5-2", id: "msg_1", type: "message", role: "assistant",
    content: [{ type: "thinking", thinking: "T".repeat(100) }], usage }, type: "assistant", uuid: "a1", timestamp: "2026-11-13T10:00:05.000Z" },
  { parentUuid: "a1", isSidechain: false, message: { model: "claude-fable-5-2", id: "msg_1", type: "message", role: "assistant",
    content: [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "rg loop" } }], usage }, type: "assistant", uuid: "a2", timestamp: "2026-11-13T10:00:05.100Z" },
  { parentUuid: "a2", isSidechain: false, promptId: "p1", type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "R".repeat(700) }] }, uuid: "u2", timestamp: "2026-11-13T10:00:06.000Z" },
  { parentUuid: "u2", isSidechain: false, message: { model: "claude-fable-5-2", id: "msg_2", type: "message", role: "assistant",
    content: [{ type: "text", text: "Two pages mention it." }], usage: { input_tokens: 5, cache_creation_input_tokens: 10, cache_read_input_tokens: 203000, output_tokens: 20 } },
  type: "assistant", uuid: "a3", timestamp: "2026-11-13T10:00:09.000Z" },
  { type: "attachment", attachment: { type: "x" } },
  { type: "custom-title", customTitle: "Agent loop wiki hunt", sessionId: SID },
  { type: "last-prompt", lastPrompt: "Find the wiki pages", sessionId: SID },
];

function fixture() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "explore-context-"));
  const dir = path.join(home, "projects", "C--proj");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${SID}.jsonl`);
  fs.writeFileSync(file, RECORDS.map((r) => JSON.stringify(r)).join("\n") + "\n");
  fs.writeFileSync(path.join(dir, `${OTHER}.jsonl`), JSON.stringify({ type: "ai-title", aiTitle: "Older thing", sessionId: OTHER }) + "\n");
  fs.writeFileSync(path.join(dir, "not-a-session.jsonl"), "{}\n");
  fs.utimesSync(path.join(dir, `${OTHER}.jsonl`), new Date(1000), new Date(1000));
  return { home, file, cleanup: () => fs.rmSync(home, { recursive: true, force: true }) };
}

test("measureContent: characters by kind; a tool call counts its name and its input", () => {
  const m = measureContent([{ type: "text", text: "abcd" }, { type: "thinking", thinking: "xy" }, { type: "tool_use", name: "Bash", input: { a: 1 } },
    { type: "tool_result", content: [{ type: "text", text: "out" }] }, { type: "image", source: {} }, null]);
  assert.deepEqual(m.kinds, { text: 4, thinking: 2, tool_use: 4 + 7, tool_result: JSON.stringify([{ type: "text", text: "out" }]).length, other: 0 });
  assert.deepEqual(m.tools, ["Bash"]);
  assert.equal(measureContent("plain").kinds.text, 5);
  assert.deepEqual(usageOf({ input_tokens: 1, cache_read_input_tokens: 10, cache_creation_input_tokens: 100, output_tokens: 7 }),
    { input: 1, cacheRead: 10, cacheWrite: 100, output: 7, prompt: 111 });
  assert.equal(usageOf(null), null);
});

test("sessionFacts: totals, tool share, the API's own token counts once per message, recorded requests", (t) => {
  const fx = fixture();
  t.after(fx.cleanup);
  const f = sessionFacts(fx.file);
  assert.equal(f.ok, true);
  assert.equal(f.window.truncated, false);
  assert.equal(f.totals.messages, 5);
  const toolUse = "Bash".length + JSON.stringify({ command: "rg loop" }).length;
  assert.deepEqual(f.totals.kinds, { text: 41 + 21, thinking: 100, tool_use: toolUse, tool_result: 700, other: 0 });
  assert.equal(f.totals.toolCalls, 1);
  assert.equal(f.totals.toolShare, (toolUse + 700) / f.totals.chars);
  assert.equal(f.totals.estTokens, Math.ceil(f.totals.chars / 4));
  // msg_1 was journalled twice: its usage is counted ONCE.
  assert.deepEqual(f.totals.usage, { input: 7, cacheRead: 403000, cacheWrite: 3010, output: 420, turns: 2 });
  assert.equal(f.lastCall.prompt, 5 + 10 + 203000);
  assert.equal(f.lastCall.model, "claude-fable-5-2");
  assert.deepEqual(f.tools, [{ name: "Bash", count: 1 }]);
  assert.equal(f.requestsTotal, 1);
  assert.deepEqual(f.requests[0], { id: REQ, at: Date.parse("2026-11-13T10:00:01.000Z"), model: "claude-fable-5-2", source: "repl_main_thread",
    effort: "medium", maxTokens: 128000, keep: 5, tail: 3, base: "00000000-0000-4000-8000-000000000000", version: "2.1.325",
    system: { systemBlocks: 2, systemChars: 17 + 5000, tools: 2, toolChars: JSON.stringify(RECORDS[1].shape.tools).length } });
  assert.equal(f.blobs, 2);
  assert.equal(f.rows[0].preview, "Find the wiki pages about the agent loop.");
});

test("sessionFacts: a window smaller than the journal counts only the end and says so", (t) => {
  const fx = fixture();
  t.after(fx.cleanup);
  const f = sessionFacts(fx.file, { maxBytes: 900 });
  assert.equal(f.window.truncated, true);
  assert.equal(f.window.bytes, 900);
  assert.ok(f.totals.messages < 5);
  assert.equal(sessionFacts(path.join(fx.home, "missing.jsonl")).ok, false);
});

test("requestDetail: the recorded system blocks, tools and new messages; an unrecorded hash is 'not read'", (t) => {
  const fx = fixture();
  t.after(fx.cleanup);
  const d = requestDetail(fx.file, REQ);
  assert.equal(d.ok, true);
  assert.equal(d.request.model, "claude-fable-5-2");
  assert.equal(d.request.betas, 2);
  assert.equal(d.request.thinking, "adaptive");
  assert.deepEqual(d.system.map((b) => b.chars), [17, 5000]);
  assert.equal(d.system[1].preview.length, 1200, "a long block is previewed, with its real size beside it");
  assert.deepEqual(d.tools, [{ name: "Bash", chars: 13 }, { name: "Read", chars: 11 }]);
  assert.equal(d.tailTotal, 3);
  assert.deepEqual(d.messages.map((m) => [m.read, m.role || "", m.hash]), [[true, "user", "a".repeat(10)], [true, "assistant", "b".repeat(10)], [false, "", "c".repeat(10)]]);
  assert.deepEqual(d.messages[1].tools, ["Bash"]);
  assert.equal(d.notRead, 1);
  assert.equal(requestDetail(fx.file, "ffffffff-0000-4000-8000-000000000000").ok, false);
  for (const bad of ["", "../x", "a b", "x".repeat(80)]) assert.equal(requestDetail(fx.file, bad).reason, "not a request id");
});

test("localSessions: newest first, titled from the journal's tail, only real session ids", (t) => {
  const fx = fixture();
  t.after(fx.cleanup);
  const r = localSessions({ home: fx.home });
  assert.equal(r.ok, true);
  assert.deepEqual(r.sessions.map((s) => [s.id, s.title, s.project]), [[SID, "Agent loop wiki hunt", "C--proj"], [OTHER, "Older thing", "C--proj"]]);
  assert.equal(titleFromTail('{"type":"last-prompt","lastPrompt":"only a prompt"}\n'), "only a prompt");
  const none = localSessions({ home: path.join(fx.home, "nope") });
  assert.equal(none.ok, false);
  assert.match(none.reason, /not readable/);
});

test("client: sessions merge the live directory, filter by words, and a page can only name an id", async (t) => {
  const fx = fixture();
  t.after(fx.cleanup);
  const daemonUp = async () => ({ ok: true, note: "2 session(s)", sessions: [
    { id: "d1", harness_session_id: SID, title: "Live title", status: "working", harness: "claude" },
    { id: "gem-1", title: "A gemini run", status: "idle", harness: "gemini", transcript_path: "C:/elsewhere/secret.txt" }] });
  const client = createContextClient({ home: fx.home, daemon: daemonUp, callTool: async () => "{}" });
  const all = await client.sessions();
  assert.equal(all.sources.daemon.ok, true);
  assert.deepEqual(all.sessions.map((s) => [s.id, s.status, s.hasJournal]), [[SID, "working", true], ["gem-1", "idle", false], [OTHER, "", true]]);
  assert.equal(JSON.stringify(all).includes("secret.txt"), false, "no path reaches the page");
  assert.equal(JSON.stringify(all).includes(fx.home), false);
  assert.deepEqual((await client.sessions({ query: "older c--proj" })).sessions.map((s) => s.id), [OTHER]);

  assert.equal((await client.facts(SID)).totals.messages, 5);
  assert.equal((await client.request(SID, REQ)).ok, true);
  for (const bad of ["gem-1", "../" + SID, fx.file, "", OTHER.toUpperCase() + "x"]) {
    assert.equal((await client.facts(bad)).ok, false, bad);
    assert.equal((await client.request(bad, REQ)).ok, false, bad);
  }

  // The daemon down: journals still list, and the state says live status is off.
  const offline = createContextClient({ home: fx.home, daemon: async () => ({ ok: false, sessions: [], note: "daemon unreachable (start it: adk harness serve)" }), callTool: async () => "{}" });
  const r = await offline.sessions();
  assert.equal(r.sessions.length, 2);
  assert.deepEqual(r.sources.daemon, { ok: false, note: "daemon unreachable (start it: adk harness serve)" });
  const thrown = createContextClient({ home: fx.home, daemon: async () => { throw new Error("boom"); }, callTool: async () => "{}" });
  assert.equal((await thrown.sessions()).sources.daemon.note, "boom");
});

test("traces: up, refused by the tier (measured live), down, slow, malformed", async () => {
  const mk = (callTool, extra = {}) => createContextClient({ callTool, daemon: async () => ({ ok: false, sessions: [] }), home: os.tmpdir(), ...extra });
  // Genesis's own row shape (measured 2026-11-13 from /llm-traces/traces).
  const row = { trace_id: "tr-gen-2c9add26c278", request_id: "req_gen_1", timestamp: 1794631889.119, source: "llm_client", agent_id: "aither",
    model_used: "bonsai2-27b", success: true, error: "", prompt_tokens: 0, completion_tokens: 0, total_time_ms: 20845.28, tool_count: 0 };
  const calls = [];
  const up = mk(async (name, args) => { calls.push([name, args]); return name === "llm_trace_list" ? JSON.stringify([row, { no: "id" }]) : JSON.stringify({ trace_id: args.trace_id, system_prompt: "You are…", messages: [] }); });
  const list = await up.traces();
  assert.deepEqual(list.traces, [{ id: "tr-gen-2c9add26c278", requestId: "req_gen_1", at: 1794631889119, source: "llm_client", agent: "aither",
    model: "bonsai2-27b", ok: true, error: "", promptTokens: 0, completionTokens: 0, totalMs: 20845, tools: 0 }]);
  const one = await up.trace("tr-gen-2c9add26c278");
  assert.match(one.text, /"system_prompt": "You are…"/);
  assert.deepEqual(calls[1], ["llm_trace_get", { trace_id: "tr-gen-2c9add26c278" }]);
  assert.equal((await up.trace("../x y")).reason, "not a trace id");

  const refused = await mk(async () => "Tool 'llm_trace_list' is not available on the platform tier. No plan includes this tool on the hosted platform.").traces();
  assert.equal(refused.ok, false);
  assert.equal(refused.refused, true);
  assert.match(refused.reason, /^Tool 'llm_trace_list' is not available on the platform tier/);

  const down = await mk(async () => { throw new Error("connect ECONNREFUSED 127.0.0.1:8182"); }).traces();
  assert.match(down.reason, /ECONNREFUSED/);
  const slow = await mk(() => new Promise(() => {}), { timeoutMs: 30 }).traces();
  assert.match(slow.reason, /took over/);
  const genesisDown = await mk(async () => JSON.stringify({ error: "Genesis not reachable" })).traces();
  assert.match(genesisDown.reason, /Genesis not reachable/);
  assert.deepEqual((await mk(async () => JSON.stringify({ traces: "nope" })).traces().catch((e) => ({ threw: String(e) }))).threw, undefined);
});

test("recall: memory rows, an empty answer, and a gateway that is down", async () => {
  const mk = (memory) => createContextClient({ memory, daemon: async () => ({ ok: false, sessions: [] }), callTool: async () => "{}", home: os.tmpdir(), timeoutMs: 50 });
  const up = await mk(async (q) => ({ ok: true, memories: [{ id: "m1", text: `about ${q}`, category: "general", score: 0.7 }] })).recall("  desk  ");
  assert.deepEqual(up, { ok: true, query: "desk", memories: [{ id: "m1", text: "about desk", category: "general", score: 0.7 }] });
  assert.deepEqual((await mk(async () => ({ ok: true, memories: [] })).recall("x")).memories, []);
  const down = await mk(async () => ({ ok: false, error: "connect ECONNREFUSED 127.0.0.1:8182" })).recall("x");
  assert.equal(down.ok, false);
  assert.match(down.reason, /ECONNREFUSED/);
  assert.match((await mk(() => new Promise(() => {})).recall("x")).reason, /took over/);
  assert.equal((await mk(async () => ({ ok: true })).recall("  ")).reason, "type what to recall");
});

test("what is not available is stated, and names the real reason", () => {
  assert.ok(NOT_AVAILABLE.length >= 3);
  assert.match(NOT_AVAILABLE[0], /assembled prompt of a fleet agent's past call/);
  assert.match(NOT_AVAILABLE[1], /internal key/);
});
