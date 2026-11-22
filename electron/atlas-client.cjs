"use strict";

/**
 * atlas-client — the Atlas program-manager board for the desk's Atlas section.
 *
 * The board itself is Genesis `GET /atlas/issues/board` (platform-gated) and the
 * digest is `POST /atlas/issues/digest`. The desk NEVER speaks to Genesis
 * directly: both verbs ride the shared gateway-mcp transport as the
 * `atlas_board` / `atlas_digest` tools, exactly like every other desk data
 * plane (market, system, relay) rides it.
 *
 * Every answer is JSON on the wire, including failures: a tool that is not
 * deployed yet answers `{"error": "unknown tool ..."}`, which is a RENDERED
 * state for the section, never a thrown panel. `call` is the gateway-mcp
 * callTool (injectable so tests need no live gateway).
 */

const { callTool, parseMaybeJson } = require("./gateway-mcp.cjs");

/** The sentence a caller prints. A gateway verdict may be a string or an
 *  object; never "undefined". */
function errorText(error) {
  if (error == null) return "unknown error";
  if (typeof error === "string") return error.slice(0, 300);
  if (typeof error === "object") {
    const message = error.message || error.reason || error.error;
    if (typeof message === "string") return message.slice(0, 300);
    return JSON.stringify(error).slice(0, 300);
  }
  return String(error).slice(0, 300);
}

/**
 * One tool that must answer a JSON object. Returns `{ok:true, <key>: data}` or
 * `{ok:false, error}`; it never throws, so the IPC handler and the section have
 * one shape on every path.
 */
async function readTool(call, name, key, args = {}) {
  try {
    const text = await call(name, args);
    const data = parseMaybeJson(text);
    if (!data || typeof data !== "object" || Array.isArray(data)) {
      return { ok: false, error: `${name} did not answer a JSON object` };
    }
    // Errors come back AS JSON with an "error" key (the gateway's documented
    // shape), so an HTTP 200 carrying an outage still reads as an outage.
    if (data.error != null) return { ok: false, error: errorText(data.error) };
    return { ok: true, [key]: data };
  } catch (error) {
    // A tool the gateway does not know yet (atlas_board undeployed) rejects
    // here — that is the empty/error state, not a crash.
    return { ok: false, error: errorText(error) };
  }
}

/** The board snapshot: {counts, rows, metrics, text, message_id, updated_at}.
 *  `view:"full"` is the row-bearing view the section renders (the tool also
 *  answers "text" and "counts", which carry no rows). */
async function atlasBoard(call = callTool) {
  return readTool(call, "atlas_board", "board", { view: "full" });
}

/** Send the owner digest now. Returns whatever the tool answered. */
async function atlasDigest(call = callTool) {
  return readTool(call, "atlas_digest", "result");
}

/**
 * Who is active on the platform: GET /atlas/presence through the gateway's
 * `atlas_presence` tool -- one row per agent ({agent, state, work, discord,
 * thread_url}), built from Atlas' company board in Pulse + the Discord bot
 * roster. Not deployed yet = `{ok:false, error}`; the swarm keeps its cards.
 */
async function atlasPresence(call = callTool) {
  return readTool(call, "atlas_presence", "presence");
}

module.exports = { atlasBoard, atlasDigest, atlasPresence };

if (require.main === module) {
  // Self-test: one live board read. Exit 0 = answerable; 1 = unavailable
  // (gateway/bearer/tool not deployed); 2 = the module itself is broken.
  (async () => {
    try {
      const snap = await atlasBoard();
      if (!snap.ok) {
        console.error(`ATLAS UNAVAILABLE: ${snap.error}`);
        process.exit(1);
      }
      const rows = Array.isArray(snap.board.rows) ? snap.board.rows.length : 0;
      console.log(`ATLAS OK: ${rows} row(s), updated ${snap.board.updated_at ?? "?"}`);
      process.exit(0);
    } catch (error) {
      console.error(`MODULE BROKEN: ${error && error.stack ? error.stack : error}`);
      process.exit(2);
    }
  })();
}
