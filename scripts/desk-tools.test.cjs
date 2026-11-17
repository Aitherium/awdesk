"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { parseArgs, toolCall } = require("./desk-tools.cjs");

test("desk-tools maps list / run / plan onto the desk MCP server's three bar tools", () => {
  assert.deepEqual(toolCall(parseArgs(["list", "white", "board"])), { tool: "desk_tools", args: { query: "white board", limit: 25 } });
  assert.deepEqual(toolCall(parseArgs(["list"])), { tool: "desk_tools", args: { limit: 300 } });
  assert.deepEqual(toolCall(parseArgs(["run", "timer.start", "10m", "tea"])), { tool: "desk_tool_run", args: { id: "timer.start", args: { text: "10m tea" } } });
  // --yes is the ONLY way a write / send / spend runs from the CLI.
  assert.deepEqual(toolCall(parseArgs(["run", "fleet.gaming", "--yes"])), { tool: "desk_tool_run", args: { id: "fleet.gaming", confirm: true } });
  assert.deepEqual(toolCall(parseArgs(["plan", "open", "a", "whiteboard"])), { tool: "desk_intent", args: { text: "open a whiteboard" } });
  assert.deepEqual(toolCall(parseArgs(["plan", "notes", "--run"])), { tool: "desk_intent", args: { text: "notes", run: true } });
  assert.match(parseArgs([]).error, /usage/);
  assert.match(parseArgs(["run"]).error, /tool id/);
  assert.match(parseArgs(["plan"]).error, /sentence/);
});
