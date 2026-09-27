"use strict";

/**
 * ops-client — the desk's door to the platform-ops control plane.
 *
 * CONTRACT: the ONLY transport is gateway-mcp.cjs (the local MCP gateway). This
 * module adds no HTTP of its own; it names the ops_* tools
 * (AitherOS/apps/awnode/tools/mcp/mcp_platform_ops.py), parses the JSON string
 * each one answers, and turns every failure into a THROWN error.
 *
 * 🚩 A failure must never read as an empty result. The tools answer
 * `{"error": "..."}` (a JSON STRING, not an MCP error) when Genesis is down or
 * refuses, and a parser that returned that object as "the state" would render
 * a Backups tab with no sets and no complaint -- identical to "nothing to back
 * up". So an `error` key, an unparseable body and a gateway exception all
 * throw, and the IPC layer turns the throw into {ok:false, error}.
 *
 * Every run carries via:"awdesk" so the run's actor says which surface fired it.
 * Approval of a guarded op (backups.run) is NOT done here: the run parks in
 * `awaiting_approval` and a human approves the card in Veil/ActionHub.
 */

const { callTool } = require("./gateway-mcp.cjs");

const VIA = "awdesk";
const TERMINAL_STATES = Object.freeze(["succeeded", "failed", "blocked", "cancelled"]);

function isTerminal(state) {
  return TERMINAL_STATES.includes(String(state || ""));
}

/** Parse one tool answer; throw on anything that is not a usable JSON object. */
function parseResult(tool, text) {
  let value;
  try {
    value = JSON.parse(String(text == null ? "" : text));
  } catch {
    const head = String(text || "").trim().slice(0, 160);
    throw new Error(`${tool}: unparseable answer${head ? `: ${head}` : " (empty)"}`);
  }
  if (value == null || typeof value !== "object") {
    throw new Error(`${tool}: expected a JSON object, got ${value === null ? "null" : typeof value}`);
  }
  if (!Array.isArray(value) && value.error) {
    const why = typeof value.error === "string" ? value.error : JSON.stringify(value.error);
    throw new Error(`${tool}: ${why}`);
  }
  // FastAPI's HTTPException body, if a tool ever relays it verbatim.
  if (!Array.isArray(value) && value.detail && Object.keys(value).length === 1) {
    const why = typeof value.detail === "string" ? value.detail : JSON.stringify(value.detail);
    throw new Error(`${tool}: ${why}`);
  }
  return value;
}

function paramsString(params) {
  if (params == null || params === "") return "";
  if (typeof params === "string") return params;
  return JSON.stringify(params);
}

/**
 * Build a client over an injectable `call(name, args) -> Promise<string>`
 * (gateway-mcp's callTool by default) so tests need no live gateway.
 */
function createOpsClient({ call = callTool, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
  async function tool(name, args) {
    const text = await call(name, args || {});
    return parseResult(name, text);
  }

  const client = {
    catalog: () => tool("ops_catalog", {}),

    state: (noun = "backups") => tool("ops_state", { noun: String(noun || "backups") }),

    plan: (op, params = "", { delegateTo = "" } = {}) => tool("ops_plan", {
      op: String(op || ""),
      params: paramsString(params),
      delegate_to: String(delegateTo || ""),
    }),

    run: (op, params = "", { delegateTo = "", delegationToken = "" } = {}) => tool("ops_run", {
      op: String(op || ""),
      params: paramsString(params),
      delegate_to: String(delegateTo || ""),
      delegation_token: String(delegationToken || ""),
      via: VIA,
    }),

    /** status("run-id") -> {run};  status({noun, limit}) -> {runs, count}. */
    status: (query) => {
      if (typeof query === "string" && query) return tool("ops_status", { run_id: query });
      const q = query && typeof query === "object" ? query : {};
      const args = { run_id: "", noun: String(q.noun || ""), limit: Number(q.limit) > 0 ? Number(q.limit) : 20 };
      return tool("ops_status", args);
    },

    cancel: (runId) => {
      if (!runId) return Promise.reject(new Error("ops_cancel: run id required"));
      return tool("ops_cancel", { run_id: String(runId) });
    },

    /**
     * Poll ops_status until the run reaches a terminal state (or the timeout).
     * onUpdate(run) fires on every poll whose state/updated_at moved. Resolves
     * {run, done:true} on a terminal state, {run, done:false, timedOut:true} on
     * timeout; a failing poll is reported through onUpdate(null, error) and
     * tolerated up to `maxErrors` in a row, then thrown -- a watch that died
     * silently would leave "running…" on screen forever.
     */
    watch: async (runId, onUpdate = () => {}, { intervalMs = 2000, timeoutMs = 10 * 60 * 1000, maxErrors = 3 } = {}) => {
      if (!runId) throw new Error("watch: run id required");
      const until = Date.now() + Math.max(0, Number(timeoutMs) || 0);
      let last = null;
      let lastKey = "";
      let errors = 0;
      for (;;) {
        try {
          const answer = await client.status(String(runId));
          const run = answer && answer.run;
          if (!run || typeof run !== "object") throw new Error("ops_status: answer carried no run");
          errors = 0;
          last = run;
          const key = `${run.state}|${run.updated_at || ""}`;
          if (key !== lastKey) {
            lastKey = key;
            try { onUpdate(run, null); } catch { /* a listener must not kill the watch */ }
          }
          if (isTerminal(run.state)) return { run, done: true };
        } catch (error) {
          errors += 1;
          try { onUpdate(null, error); } catch { /* ignore */ }
          if (errors >= maxErrors) throw error;
        }
        if (Date.now() >= until) return { run: last, done: false, timedOut: true };
        await sleep(Math.max(1, Number(intervalMs) || 2000));
      }
    },
  };
  return client;
}

const defaultClient = createOpsClient();

module.exports = {
  ...defaultClient,
  createOpsClient,
  parseResult,
  isTerminal,
  TERMINAL_STATES,
  VIA,
};
