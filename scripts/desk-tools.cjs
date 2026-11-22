#!/usr/bin/env node
"use strict";

/**
 * desk-tools -- the Alt+Space bar's commands from a terminal: the SAME tools, schemas
 * and confirm rule the owner and the agents get (intent-bar.cjs through the desk MCP
 * server's desk_tools / desk_tool_run / desk_intent on the running desk's bridge).
 *
 *   node scripts/desk-tools.cjs list [words]          rank the tools (works with the desk closed)
 *   node scripts/desk-tools.cjs run <id> [text] [--yes]  run one; write/send/spend need --yes
 *   node scripts/desk-tools.cjs plan "<sentence>" [--run]  plan it; --run runs the read/ui steps
 *
 * The bridge is http://127.0.0.1:${DESK_BRIDGE_PORT || 47931}/mcp (loopback only).
 * Exit 0 ok · 1 refused/failed · 2 could not reach the desk.
 */

const DEFAULT_PORT = 47931;

/** argv -> {verb, words, yes, run, json} or {error}. */
function parseArgs(argv) {
  const args = Array.isArray(argv) ? argv.slice() : [];
  const flags = new Set(args.filter((a) => /^--/.test(a)));
  const words = args.filter((a) => !/^--/.test(a));
  const verb = String(words.shift() || "").toLowerCase();
  if (!["list", "run", "plan"].includes(verb)) return { error: "usage: desk-tools list [words] | run <id> [text] [--yes] | plan \"<sentence>\" [--run]" };
  if (verb === "run" && !words.length) return { error: "run needs a tool id — `desk-tools list` shows them" };
  if (verb === "plan" && !words.length) return { error: "plan needs a sentence" };
  return { verb, words, yes: flags.has("--yes"), run: flags.has("--run"), json: flags.has("--json") };
}

/** The MCP call a parsed command makes: {tool, args}. */
function toolCall(parsed) {
  if (parsed.verb === "list") return { tool: "desk_tools", args: parsed.words.length ? { query: parsed.words.join(" "), limit: 25 } : { limit: 300 } };
  if (parsed.verb === "run") {
    const [id, ...rest] = parsed.words;
    return { tool: "desk_tool_run", args: { id, ...(rest.length ? { args: { text: rest.join(" ") } } : {}), ...(parsed.yes ? { confirm: true } : {}) } };
  }
  return { tool: "desk_intent", args: { text: parsed.words.join(" "), ...(parsed.run ? { run: true } : {}) } };
}

function printTools(tools) {
  for (const t of tools) {
    const args = t.schema && t.schema.properties && Object.keys(t.schema.properties).length ? ` <${Object.keys(t.schema.properties).join(" ")}>` : "";
    process.stdout.write(`${t.pinned ? "★ " : "  "}${t.id.padEnd(30)} ${String(t.effect).padEnd(6)} ${t.label}${args}\n`);
  }
}

async function callDesk(call, { port }) {
  const { Client } = require("@modelcontextprotocol/sdk/client/index.js");
  const { StreamableHTTPClientTransport } = require("@modelcontextprotocol/sdk/client/streamableHttp.js");
  const client = new Client({ name: "desk-tools", version: "1" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`)));
  try {
    const result = await client.callTool({ name: call.tool, arguments: call.args });
    const text = ((result && result.content) || []).map((c) => c.text || "").join("");
    return JSON.parse(text || "{}");
  } finally {
    await client.close().catch(() => {});
  }
}

async function main(argv = process.argv.slice(2), env = process.env) {
  const parsed = parseArgs(argv);
  if (parsed.error) { process.stderr.write(`${parsed.error}\n`); return 1; }
  const port = Number(env.DESK_BRIDGE_PORT || DEFAULT_PORT);
  const call = toolCall(parsed);
  let answer;
  try {
    answer = await callDesk(call, { port });
  } catch (error) {
    if (parsed.verb === "list") {
      // The catalog is data: with the desk closed, list it from the registry itself.
      const ib = require("../electron/intent-bar.cjs");
      const ranked = ib.rankTools(parsed.words.join(" "), ib.toolCatalog(), { limit: parsed.words.length ? 25 : 300 });
      process.stderr.write("(the desk is not answering — listed from the registry; running needs the desk)\n");
      printTools(ranked.map((r) => ({ ...r.tool, pinned: false })));
      return 0;
    }
    process.stderr.write(`1 desk not answering on 127.0.0.1:${port} — ${String((error && error.message) || error)}. Start the desk, or set DESK_BRIDGE_PORT.\n`);
    return 2;
  }
  if (parsed.json) { process.stdout.write(`${JSON.stringify(answer, null, 2)}\n`); return answer.ok === false ? 1 : 0; }
  if (parsed.verb === "list") { printTools(answer.tools || []); return 0; }
  if (answer.ok === false) {
    process.stderr.write(`${answer.error || "refused"}${answer.needsConfirm ? " (add --yes)" : ""}\n`);
    return 1;
  }
  if (parsed.verb === "run") { process.stdout.write(`${(answer.result && answer.result.text) || "done"}\n`); return 0; }
  if (answer.say) process.stdout.write(`${answer.say}\n`);
  const plan = answer.plan || null;
  if (plan) {
    for (const s of plan.auto || []) process.stdout.write(`  run now : ${s}\n`);
    for (const s of plan.confirm || []) process.stdout.write(`  confirm : ${s}\n`);
  }
  for (const r of answer.ran || []) process.stdout.write(`  ${r.ok ? "ran" : "FAILED"}: ${r.line} — ${r.text}\n`);
  if (answer.pending) for (const s of answer.pending.steps || []) process.stdout.write(`  waiting : ${s} (run it with desk-tools run … --yes)\n`);
  for (const why of answer.rejected || []) process.stdout.write(`  dropped : ${why}\n`);
  process.stdout.write(`  planned by ${answer.via}${answer.model ? ` · ${answer.model}` : ""}\n`);
  return 0;
}

if (require.main === module) {
  main().then((code) => process.exit(code), (error) => { process.stderr.write(`${String((error && error.stack) || error)}\n`); process.exit(2); });
}

module.exports = { DEFAULT_PORT, main, parseArgs, toolCall };
