"use strict";

/**
 * sense-commands — Aeon's inner state on the desk.
 *
 * Owner, 2026-10-02: Aeon, Sense, Daydream and CNS "all need to be integrated" with
 * awdesk and the local daemons. The platform answers that question in ONE place --
 * the gateway's `sense_inner_state` MCP tool (apps/awnode/tools/mcp/mcp_timesense.py),
 * the same data Veil's Sense Command Center shows -- so the desk reads it through
 * gateway-mcp.cjs, the one transport every desk data client already uses, instead of
 * growing a second idea of how the agent feels.
 *
 * Electron-free on purpose: `callTool` is injected so the verb runs under
 * `node --test` with a fake; main.cjs supplies the real one.
 */

const { callTool: gatewayCallTool, parseMaybeJson } = require("./gateway-mcp.cjs");

function oneLine(text, max = 160) {
  const flat = String(text || "").replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/** Read Aeon's inner state and say it in one line. A gateway denial or a source
 *  error is REPORTED, never rendered as a calm empty state. */
async function readInnerState(callTool = gatewayCallTool) {
  let text;
  try {
    text = await callTool("sense_inner_state", { limit: 3 });
  } catch (err) {
    return { ok: false, message: `Aeon: ${oneLine(err && err.message ? err.message : err)}` };
  }
  const data = parseMaybeJson(text);
  if (!data || typeof data !== "object") {
    return { ok: false, message: `Aeon: ${oneLine(text) || "empty answer"}` };
  }
  const errors = data.errors && typeof data.errors === "object" ? Object.entries(data.errors) : [];
  if (!data.mood && errors.length) {
    return { ok: false, state: data, message: `Aeon: ${errors.map(([k, v]) => `${k}: ${v}`).join("; ")}` };
  }
  const thought = Array.isArray(data.thoughts) && data.thoughts[0] ? data.thoughts[0].content : "";
  const dream = Array.isArray(data.daydreams) && data.daydreams[0] ? data.daydreams[0].content : "";
  const bits = [
    `mood ${data.mood || "unknown"}`,
    data.current_concern ? `concern: ${oneLine(data.current_concern, 80)}` : "",
    thought ? `thinking: ${oneLine(thought, 80)}` : "",
    dream ? `daydream: ${oneLine(dream, 100)}` : "",
  ].filter(Boolean);
  return { ok: true, state: data, message: `Aeon — ${bits.join(" · ")}` };
}

module.exports = { readInnerState };
