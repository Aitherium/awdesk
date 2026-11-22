"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const ask = require("./ask-answered.cjs");

// The real case, 2026-11-17: session bf1f0eee asked "Go live: openaw.org ..." at
// 12:35:56Z; awask raised d-yjmc at 12:36:21Z; the owner answered in the terminal at
// 12:39:17Z; the card was still open at 12:39:43Z.
const SID = "bf1f0eee-f1de-444b-9a5e-05dfe7dabd03";
const D_YJMC = {
  id: "d-yjmc", agent: "claude-code", sessionId: SID, kind: "blocked",
  createdAt: 1794918981.9725223,
  cwd: "C:\\AitherOS-Fresh\\.claude\\worktrees\\launch\\openaw\\cloudflare\\openaw",
  options: [{ key: "tui:type", label: "Open the session" }, { key: "later", label: "Not now" }],
  defaultKey: "later",
};
const ASK_LINE = JSON.stringify({ type: "assistant", timestamp: "2026-11-17T12:35:56.155Z",
  message: { content: [{ type: "tool_use", id: "toolu_01Gr5DzhRPnWxkwvv6rwSh2q", name: "AskUserQuestion", input: { questions: [] } }] } });
const ANSWER_LINE = JSON.stringify({ type: "user", timestamp: "2026-11-17T12:39:17.274Z",
  message: { content: [{ type: "tool_result", tool_use_id: "toolu_01Gr5DzhRPnWxkwvv6rwSh2q", content: "Your questions have been answered: ..." }] } });
const OTHER_RESULT = JSON.stringify({ type: "user", timestamp: "2026-11-17T12:48:53.783Z",
  message: { content: [{ type: "tool_result", tool_use_id: "toolu_01HcGVJwthtJwMyuw4WgJjwF", content: "grep output" }] } });

function run(cards, journal) {
  const cancelled = [];
  const r = ask.sweep(cards, {
    transcript: () => "journal.jsonl",
    read: () => journal,
    cancel: (id, note) => { cancelled.push([id, note]); return true; },
  });
  return { r, cancelled };
}

test("d-yjmc: answered in the terminal after the card was raised -> the card closes", () => {
  const { r, cancelled } = run([D_YJMC], [ASK_LINE, ANSWER_LINE, OTHER_RESULT].join("\n"));
  assert.deepEqual(r.closed, ["d-yjmc"]);
  assert.match(cancelled[0][1], /answered in the session/);
});

test("d-yjmc: still waiting (no result yet) -> the card stays", () => {
  const { r, cancelled } = run([D_YJMC], [ASK_LINE, OTHER_RESULT].join("\n"));
  assert.deepEqual(r.closed, []);
  assert.equal(cancelled.length, 0);
});

test("an EARLIER question's answer never closes a newer card", () => {
  const newer = { ...D_YJMC, id: "d-newr", createdAt: Date.parse("2026-11-17T12:40:00Z") / 1000 };
  const { r } = run([newer], [ASK_LINE, ANSWER_LINE].join("\n"));
  assert.deepEqual(r.closed, []);
});

test("a result for a tool that is not AskUserQuestion closes nothing", () => {
  const { r } = run([D_YJMC], [OTHER_RESULT].join("\n"));
  assert.deepEqual(r.closed, []);
});

test("the hold card (ans: keys) closes the same way", () => {
  const hold = { ...D_YJMC, id: "d-qhc6", createdAt: 1794918956.546785,
    options: [{ key: "ans:1", label: "Go live now (Recommended)" }, { key: "ans:type" }, { key: "later" }] };
  const { r } = run([hold], [ASK_LINE, ANSWER_LINE].join("\n"));
  assert.deepEqual(r.closed, ["d-qhc6"]);
});

test("only awask question cards from claude-code are touched", () => {
  const plain = { ...D_YJMC, id: "d-plan", options: [{ key: "golive" }, { key: "hold" }] };
  const codex = { ...D_YJMC, id: "d-cdx", agent: "codex" };
  const noSession = { ...D_YJMC, id: "d-nos", sessionId: "" };
  const { r } = run([plain, codex, noSession], [ASK_LINE, ANSWER_LINE].join("\n"));
  assert.deepEqual(r.closed, []);
});

test("an unreadable journal or a failing cancel closes nothing and never throws", () => {
  const r1 = ask.sweep([D_YJMC], { transcript: () => { throw new Error("gone"); }, cancel: () => true });
  assert.deepEqual(r1, { closed: [], failed: [] });
  const r2 = ask.sweep([D_YJMC], { transcript: () => "x", read: () => [ASK_LINE, ANSWER_LINE].join("\n"), cancel: () => { throw new Error("awask down"); } });
  assert.deepEqual(r2, { closed: [], failed: ["d-yjmc"] });
});
