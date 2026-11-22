"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const toolSurface = require("./tool-surface.cjs");

test("file/library tools -> the File Explorer or Library window", () => {
  for (const tool of ["Read", "Write", "Edit", "MultiEdit", "Glob", "Grep", "mcp__aitheros__files_read", "mcp__aitheros__fs_list_dir"]) {
    assert.equal(toolSurface.classify(tool).surface, "files", tool);
  }
  for (const tool of ["rag_query", "query_memory", "awm_recall", "search_knowledge", "graph_kb_query", "notebooks_list"]) {
    assert.equal(toolSurface.classify(tool).surface, "library", tool);
  }
});

test("web research tools -> the browser", () => {
  for (const tool of ["WebSearch", "WebFetch", "mcp__aitheros__web_search", "browser_open", "chrome_read", "dr_web_search", "fetch_webpage", "mcp__aither-local__research"]) {
    assert.equal(toolSurface.classify(tool).surface, "browser", tool);
  }
});

test("terminal and session-reading tools -> the terminal window", () => {
  for (const tool of ["Bash", "BashOutput", "KillShell", "terminal_run", "list_sessions", "swarm_roster", "mcp__aitheros__system_processes", "mcp__aitheros__awsh_sessions"]) {
    assert.equal(toolSurface.classify(tool).surface, "terminal", tool);
  }
});

test("a tool no rule knows is UNKNOWN, with no invented destination", () => {
  for (const tool of ["Task", "TodoWrite", "ExitPlanMode", "tests", "", null, "mcp__aitheros__deploy_model"]) {
    const hit = toolSurface.classify(tool);
    assert.equal(hit.surface, "unknown", String(tool));
    assert.equal(hit.label, "", "unknown has no window label");
  }
});

test("mcp__<server>__<tool> is one tool, whatever the server", () => {
  assert.equal(toolSurface.classify("mcp__plugin_cloudflare_cloudflare__cf_dns_list").surface, "unknown");
  assert.equal(toolSurface.classify("mcp__aither-local__recall").surface, "library");
  assert.equal(toolSurface.bareToolName("mcp__aitheros__web_search"), "web_search");
});

test("parseRunning reads the daemon's 'running <tool>' and NOT ordinary prose", () => {
  assert.deepEqual(toolSurface.parseRunning("running Bash"), {
    tool: "Bash", name: "bash", surface: "terminal", label: "Terminal", text: "running Bash",
  });
  assert.equal(toolSurface.parseRunning("running mcp__aitheros__web_search").surface, "browser");
  assert.equal(toolSurface.parseRunning("running Read now").surface, "files");
  // "running tests now" is a sentence, not a tool: no fairy flies.
  assert.equal(toolSurface.parseRunning("running tests now"), null);
  assert.equal(toolSurface.parseRunning("running   tests\n now"), null);
  assert.equal(toolSurface.parseRunning("waiting: permission prompt"), null);
  assert.equal(toolSurface.parseRunning(""), null);
});
