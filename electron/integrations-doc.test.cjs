"use strict";

// Contract between docs/INTEGRATIONS.md (+ README.md) and the code they describe.
// Two drifts this pins:
//   1. the MCP tool table listed 3 of the tools mcp-server.cjs registers;
//   2. the docs told users to set PERSONA_BRIDGE_PORT / PERSONA_TARGET_PROCESS_PATTERN,
//      which no code reads (the code reads DESK_*), so the override was silently ignored.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");

function registeredTools() {
  const src = read("electron/mcp-server.cjs");
  const names = [...src.matchAll(/registerTool\(\s*"([a-z_]+)"/g)].map((m) => m[1]);
  assert.ok(names.length > 0, "found no registerTool calls; the parser is broken");
  return names;
}

function documentedTools() {
  const doc = read("docs/INTEGRATIONS.md");
  return [...doc.matchAll(/^\|\s*`([a-z_]+)`\s*\|/gm)].map((m) => m[1]);
}

function codeEnvReads() {
  const dir = path.join(ROOT, "electron");
  const reads = new Set();
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith(".cjs") || f.endsWith(".test.cjs")) continue;
    const src = fs.readFileSync(path.join(dir, f), "utf8");
    for (const m of src.matchAll(/\b(?:env|environment)(?:\.|\[\s*["'])([A-Z][A-Z0-9_]+)/g)) {
      reads.add(m[1]);
    }
  }
  return reads;
}

test("every MCP tool the server registers is in the INTEGRATIONS.md table", () => {
  const documented = new Set(documentedTools());
  const missing = registeredTools().filter((n) => !documented.has(n));
  assert.deepEqual(missing, [], `undocumented MCP tools: ${missing.join(", ")}`);
});

test("the INTEGRATIONS.md tool table names no tool the server lacks", () => {
  const registered = new Set(registeredTools());
  // URL-protocol rows use desk:// links, not bare snake_case names, so they never match.
  const phantom = documentedTools().filter((n) => !registered.has(n));
  assert.deepEqual(phantom, [], `documented but not registered: ${phantom.join(", ")}`);
});

test("every desk env var the docs name is one the code reads", () => {
  const reads = codeEnvReads();
  assert.ok(reads.has("DESK_BRIDGE_PORT"), "env-read parser is broken (DESK_BRIDGE_PORT not seen)");
  const named = new Set();
  for (const rel of ["docs/INTEGRATIONS.md", "README.md"]) {
    for (const m of read(rel).matchAll(/\b((?:DESK|PERSONA|AWDESK)_[A-Z0-9_]+)\b/g)) named.add(m[1]);
  }
  const dead = [...named].filter((n) => !reads.has(n));
  assert.deepEqual(dead, [], `docs name env vars no code reads: ${dead.join(", ")}`);
});
