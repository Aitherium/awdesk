"use strict";

/**
 * sync-agent-voices — copy the ONE canonical agent-voice map into the desk.
 *
 * `AitherOS/config/agent_voices.json` is the platform's single answer to "which
 * engine and which voice does each agent speak with" (read by awvoice, the
 * orchestrator pack and awdk). The desk never saw it: it resolved voices from
 * `config/identities/*.yaml` -> `gen_desk_agent_roster.py` ->
 * `agent-roster.generated.json`, whose values are stock Microsoft
 * `en-US-*Neural` ids — so Atlas spoke in a female Edge voice while every other
 * surface spoke `kokoro:am_michael`.
 *
 * This script ships that map into the app as data:
 *
 *   node electron/sync-agent-voices.cjs              # write the copy
 *   node electron/sync-agent-voices.cjs --check      # exit 1 on drift, 2 if the source is unreadable
 *   node electron/sync-agent-voices.cjs --source <p> # another checkout
 *
 * The committed copy is what `cast-config.loadAgentVoices()` reads at runtime
 * (no cross-repo path in the shipping app). `--check` is the gate a release job
 * (or a human) runs when the platform map changes, so the mirror cannot drift
 * silently the way the roster mirror did. Deliberately no rewrite of the
 * values: whatever the canonical file says is what the desk says.
 */

const fs = require("node:fs");
const path = require("node:path");

const DEST = path.join(__dirname, "agent-voices.generated.json");

/** Where the canonical map lives. A machine here can have more than one
 *  checkout (`AITHEROS_ROOT` once pointed at a stale D: clone while the C:
 *  worktree was the live one), so try the explicit override, then
 *  `AITHEROS_ROOT`, then the live worktree, and take the first file that
 *  exists. `--source` always wins. */
function defaultSource() {
  const explicit = process.env.DESK_AGENT_VOICES_SOURCE;
  if (explicit && String(explicit).trim()) return path.resolve(String(explicit).trim());
  const roots = [process.env.AITHEROS_ROOT, "C:\\AitherOS-Fresh"].filter(Boolean);
  const candidates = roots.map((root) => path.join(root, "AitherOS", "config", "agent_voices.json"));
  const found = candidates.find((file) => fs.existsSync(file));
  return found || candidates[0];
}

const DEFAULT_SOURCE = defaultSource();

/** The canonical doc, reduced to what the desk consumes, plus provenance.
 *  Everything else (display, timbre, edge_fallback) is kept: the Cast pane can
 *  show it and the fallback is the one voice a lane failure may use. */
function project(doc, source) {
  const agents = {};
  const rawAgents = doc && typeof doc.agents === "object" && doc.agents ? doc.agents : {};
  for (const [agent, record] of Object.entries(rawAgents)) {
    const rec = record && typeof record === "object" ? record : {};
    for (const field of ["display", "engine", "voice", "custom_id", "timbre", "edge_fallback"]) {
      if (typeof rec[field] === "string" && rec[field].trim()) {
        agents[agent] = agents[agent] || {};
        agents[agent][field] = rec[field].trim();
      }
    }
  }
  return {
    version: Number.isInteger(doc && doc.version) ? doc.version : 1,
    _generated_from: String(source).replace(/\\/g, "/"),
    _generator: "electron/sync-agent-voices.cjs",
    _note: [
      "DO NOT EDIT. A copy of AitherOS/config/agent_voices.json (the canonical",
      "map) so awdesk resolves every agent's voice from the same answer as",
      "awvoice and awdk. Regenerate with: node electron/sync-agent-voices.cjs",
      "`voice` is the id handed to AitherVoice /voice/synthesize: kokoro:<id>,",
      "local:piper, or custom:<name>.",
    ],
    default_agent: typeof doc.default_agent === "string" ? doc.default_agent : null,
    agents,
  };
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

/** What `--check` compares: the projected map WITHOUT its provenance header.
 *  `_generated_from` is the absolute path of the checkout the copy was made
 *  from, so the same map regenerated from a second checkout (AITHEROS_ROOT,
 *  `--source`, a CI runner) is identical content at a different path. Comparing
 *  the header too made the gate report DRIFT on a perfectly in-sync copy. */
function contentKey(mirror) {
  const content = { ...mirror };
  delete content._generated_from;
  return JSON.stringify(content);
}

function main(argv = process.argv.slice(2)) {
  const check = argv.includes("--check");
  const sourceFlag = argv.indexOf("--source");
  const source = sourceFlag === -1 ? DEFAULT_SOURCE : path.resolve(argv[sourceFlag + 1] || "");
  if (sourceFlag !== -1 && !argv[sourceFlag + 1]) {
    console.error("sync-agent-voices: --source needs a path");
    return 2;
  }

  let doc;
  try {
    doc = readJson(source);
  } catch (error) {
    console.error(`sync-agent-voices: cannot read the canonical map at ${source}: ${error.message}`);
    return 2; // could-not-judge, never a green run on a missing source
  }
  const next = project(doc, source);
  if (!Object.keys(next.agents).length) {
    console.error(`sync-agent-voices: ${source} names no agents -- refusing to write an empty map`);
    return 2;
  }

  if (check) {
    let current;
    try {
      current = readJson(DEST);
    } catch (error) {
      console.error(`sync-agent-voices: the desk copy is missing or unreadable: ${error.message}`);
      return 1;
    }
    const same = contentKey(project(current, current._generated_from)) === contentKey(next);
    if (!same) {
      console.error("sync-agent-voices: DRIFT -- the desk copy disagrees with the canonical map. Run: node electron/sync-agent-voices.cjs");
      return 1;
    }
    console.log(`sync-agent-voices: in sync (${Object.keys(next.agents).length} agents)`);
    return 0;
  }

  fs.writeFileSync(DEST, `${JSON.stringify(next, null, 2)}\n`, "utf8");
  console.log(`sync-agent-voices: wrote ${DEST} (${Object.keys(next.agents).length} agents)`);
  return 0;
}

module.exports = { project, main, DEST, DEFAULT_SOURCE };

if (require.main === module) process.exit(main());
