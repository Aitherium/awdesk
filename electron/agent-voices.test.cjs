"use strict";

/**
 * The SHIPPED canonical voice map — the artifact half of S6.
 *
 * `agent-voices.generated.json` is a copy of AitherOS/config/agent_voices.json
 * (the platform's one answer for which engine/voice each agent speaks with).
 * These tests prove the committed artifact is usable WITHOUT the AitherOS
 * checkout (CI has no C:\\AitherOS-Fresh, and plan critique #7 is exactly "a
 * check that exits 2 on a runner is not a check"):
 *
 *   1. it parses and names every roster agent,
 *   2. every voice is an engine id AitherVoice /voice/synthesize understands
 *      (kokoro:<id> | local:piper | custom:<name>) -- never a stock
 *      Microsoft *Neural name, which is the drift this slice ends,
 *   3. the pure validator can still DROP a bad value (a check that cannot
 *      fail is not a check),
 *   4. when the canonical source IS reachable, the copy is not stale.
 *
 *   node electron/agent-voices.test.cjs
 */

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");

const cast = require("./cast-config.cjs");
const sync = require("./sync-agent-voices.cjs");

const DEST = path.join(__dirname, "agent-voices.generated.json");

function readDoc() {
  return JSON.parse(fs.readFileSync(DEST, "utf8"));
}

test("agent-voices.generated.json: parses, is a generated mirror, and names every canonical agent", () => {
  const doc = readDoc();
  assert.equal(doc._generator, "electron/sync-agent-voices.cjs");
  assert.match(doc._generated_from, /AitherOS\/config\/agent_voices\.json$/);
  const agents = Object.keys(doc.agents || {});
  // The eight the canonical map names today (aither, atlas, demiurge, lyra,
  // iris, saga, vera, hera). Assert by NAME, so a regeneration that drops one
  // fails here instead of silently muting an agent in the desk.
  for (const agent of ["aither", "atlas", "demiurge", "lyra", "iris", "saga", "vera", "hera"]) {
    assert.ok(agents.includes(agent), `canonical map lost ${agent}`);
  }
});

test("agent-voices.generated.json: no agent resolves to a stock *Neural voice, and every id is engine-prefixed", () => {
  const doc = readDoc();
  for (const [agent, record] of Object.entries(doc.agents)) {
    assert.equal(typeof record.voice, "string", `${agent} has no voice`);
    assert.doesNotMatch(record.voice, /Neural$/i, `${agent} still carries a stock Edge voice: ${record.voice}`);
    assert.match(record.voice, /^(kokoro:[a-z0-9_]+|local:piper|custom:[a-z0-9_-]+)$/i,
      `${agent}'s voice is not an id AitherVoice understands: ${record.voice}`);
  }
});

test("agent-voices.generated.json: the map loads through cast.loadAgentVoices and keeps every agent", () => {
  const doc = readDoc();
  const loaded = cast.loadAgentVoices({ file: DEST });
  assert.deepEqual(Object.keys(loaded).sort(), Object.keys(doc.agents).sort());
  for (const [agent, record] of Object.entries(doc.agents)) {
    assert.equal(loaded[agent].voice, record.voice);
  }
});

test("validateAgentVoices: DROPS a stock *Neural value (the check that can fail)", () => {
  const dropped = cast.validateAgentVoices({
    agents: {
      atlas: { engine: "kokoro", voice: "kokoro:am_michael" },
      impostor: { engine: "edge", voice: "en-US-AriaNeural" },
      empty: { engine: "kokoro" },
    },
  });
  assert.deepEqual(Object.keys(dropped), ["atlas"]);
  assert.equal(dropped.atlas.voice, "kokoro:am_michael");
});

test("sync-agent-voices --check: in sync with the canonical AitherOS map when that checkout is reachable", (t) => {
  const source = sync.DEFAULT_SOURCE;
  if (!fs.existsSync(source)) {
    // CI has no AitherOS checkout: prove the artifact above instead of going red.
    t.skip(`canonical map not reachable here (${source}); the committed copy is tested standalone`);
    return;
  }
  assert.equal(sync.main(["--check"]), 0, "desk copy is STALE -- run node electron/sync-agent-voices.cjs");
});

test("sync-agent-voices --check: the SAME map from another checkout path is NOT drift (provenance is not content)", () => {
  // The header records the absolute path the copy came from. A machine whose
  // checkout lives elsewhere (AITHEROS_ROOT, --source, a release runner) used
  // to see exit 1 "DRIFT" for a copy that is byte-identical in every agent.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-voices-"));
  try {
    const committed = readDoc();
    const elsewhere = path.join(dir, "agent_voices.json");
    fs.writeFileSync(elsewhere, JSON.stringify({
      version: committed.version,
      default_agent: committed.default_agent,
      agents: committed.agents,
    }), "utf8");
    assert.notEqual(elsewhere.replace(/\\/g, "/"), committed._generated_from, "the fixture must be a different path");
    assert.equal(sync.main(["--check", "--source", elsewhere]), 0,
      "identical agents from another checkout path must report IN SYNC, not DRIFT");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
