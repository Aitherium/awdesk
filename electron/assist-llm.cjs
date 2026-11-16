"use strict";

/**
 * assist-llm.cjs -- every model call the assist pop-up makes.
 *
 * ONE door: MicroScheduler (:8150, /v1/chat/completions) with priority "user" -- the same
 * door orb-vision uses. MicroScheduler is where the owner's own models and keys live:
 * a model named `byok:<provider>` is served by the caller's OWN key lane (lib/byok/lane.py)
 * and a recognised BYOK request NEVER falls back to a platform lane, so a missing key is a
 * loud error here, not a silent switch to someone else's GPU. This module adds no key
 * handling of its own and never sees a key.
 *
 * 🚩 No fallback answer. A scheduler that is down, busy or refusing returns {ok:false,
 * error}; the pop-up prints it. The pop-up never invents text.
 *
 * Agent routes ("Ask an agent", "Send to an agent / workflow", "Save to memory") go
 * through the desk's gateway MCP client (gateway-mcp.cjs) -- the user's own agents. They
 * are separate calls because they are separate, named user actions, each logged.
 *
 * Transports are injected so `node --test` runs with no network.
 */

const http = require("node:http");
const https = require("node:https");

const DEFAULT_TIMEOUT_MS = 90000;
const MAX_TOKENS = 700;

function schedulerUrl(env = process.env) {
  return String(env.AITHER_MICROSCHEDULER_URL || "https://127.0.0.1:8150").replace(/\/+$/, "");
}

function defaultPost(url, payload, timeoutMs) {
  const body = Buffer.from(JSON.stringify(payload));
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const secure = target.protocol === "https:";
    let ca = {};
    if (secure) {
      try { ca = require("./internal-ca.cjs").internalCaOptions(); } catch { ca = {}; }
    }
    const req = (secure ? https : http).request(target, {
      method: "POST", timeout: timeoutMs, ...ca,
      headers: { "Content-Type": "application/json", "Content-Length": body.length },
    }, (res) => {
      const chunks = [];
      res.on("data", (d) => chunks.push(d));
      res.on("end", () => resolve({ status: res.statusCode || 0, body: Buffer.concat(chunks).toString("utf8") }));
      res.on("error", (e) => reject(new Error(e.message || String(e))));
    });
    req.on("error", (e) => reject(new Error(e.message || String(e))));
    req.on("timeout", () => { req.destroy(); reject(new Error(`timed out after ${Math.round(timeoutMs / 1000)} s`)); });
    req.write(body);
    req.end();
  });
}

function defaultGet(url, timeoutMs) {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const secure = target.protocol === "https:";
    let ca = {};
    if (secure) {
      try { ca = require("./internal-ca.cjs").internalCaOptions(); } catch { ca = {}; }
    }
    const req = (secure ? https : http).request(target, { method: "GET", timeout: timeoutMs, ...ca }, (res) => {
      const chunks = [];
      res.on("data", (d) => chunks.push(d));
      res.on("end", () => resolve({ status: res.statusCode || 0, body: Buffer.concat(chunks).toString("utf8") }));
      res.on("error", (e) => reject(new Error(e.message || String(e))));
    });
    req.on("error", (e) => reject(new Error(e.message || String(e))));
    req.on("timeout", () => { req.destroy(); reject(new Error("timed out")); });
    req.end();
  });
}

/**
 * Which model answers when the owner named none. MicroScheduler's own default can sit
 * behind a long queue (measured 2026-11-16: an unnamed model hung past 60 s while a
 * named Bonsai lane answered in 2 s), so with no model set we ask GET /v1/models which
 * lanes are AVAILABLE right now and take the best Bonsai (Bonsai 2 first), else any
 * available lane. A scheduler that cannot list models leaves the model unset -- its own
 * routing then applies; this never invents a model name.
 */
function pickModel(listBody) {
  let ids = [];
  try {
    const doc = JSON.parse(listBody || "{}");
    ids = (doc.data || []).filter((m) => m && m.id && !/^byok[:/]/i.test(String(m.id)) && !(m.aither && m.aither.available === false)).map((m) => String(m.id));
  } catch { return ""; }
  const rank = (id) => (/^bonsai2/i.test(id) ? 0 : /bonsai/i.test(id) ? 1 : /embed|vision|image|whisper|tts/i.test(id) ? 9 : 2);
  const sorted = ids.slice().sort((a, b) => rank(a) - rank(b));
  return sorted.length && rank(sorted[0]) < 9 ? sorted[0] : "";
}

/** Turn a scheduler refusal into a sentence. A BYOK refusal keeps the scheduler's own words. */
function refusalText(status, bodyText, model) {
  let detail = "";
  try {
    const doc = JSON.parse(bodyText || "{}");
    const d = doc.detail ?? doc.error ?? doc;
    detail = typeof d === "string" ? d : (d && (d.message || d.error || d.reason)) || "";
  } catch { /* not JSON */ }
  if (/^byok[:/]/i.test(String(model || ""))) {
    return `Your own key lane refused (${status})${detail ? `: ${detail}` : ""}. Nothing was sent to another provider.`;
  }
  if (status === 429 || status === 503) return `MicroScheduler is busy or has no model ready (${status})${detail ? `: ${detail}` : ""}. Try again in a moment.`;
  return `MicroScheduler answered ${status}${detail ? `: ${detail}` : ""}`;
}

/**
 * @param {object} [opts]
 * @param {Function} [opts.post]     (url, payload, timeoutMs) => {status, body}
 * @param {Function} [opts.getSettings]  () => assist settings (model)
 * @param {{callTool: Function}} [opts.gateway]  gateway-mcp.cjs
 */
function createAssistLlm({ post = defaultPost, get = defaultGet, getSettings = () => ({}), gateway = null, env = process.env, now = Date.now } = {}) {
  let picked = { at: 0, id: "" };
  async function resolveModel() {
    if (env.AWDESK_ASSIST_MODEL) return String(env.AWDESK_ASSIST_MODEL);
    if (now() - picked.at < 60000) return picked.id;
    let id = "";
    try {
      const res = await get(`${schedulerUrl(env)}/v1/models`, 6000);
      if (res.status === 200) id = pickModel(res.body);
    } catch { id = ""; }
    picked = { at: now(), id };
    return id;
  }
  async function chat({ messages, maxTokens = MAX_TOKENS, source = "assist:desk", model, temperature, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
    if (!Array.isArray(messages) || !messages.length) return { ok: false, error: "nothing to send" };
    const settings = getSettings() || {};
    const named = typeof model === "string" ? model : String(settings.model || "");
    const chosen = named || await resolveModel();
    const payload = {
      messages, max_tokens: maxTokens, priority: "user", source,
      ...(chosen ? { model: chosen } : {}),
      ...(typeof temperature === "number" ? { temperature } : {}),
    };
    try {
      const res = await post(`${schedulerUrl(env)}/v1/chat/completions`, payload, timeoutMs);
      if (res.status !== 200) return { ok: false, via: "microscheduler", error: refusalText(res.status, res.body, chosen) };
      const doc = JSON.parse(res.body || "{}");
      const text = String(((doc.choices || [])[0] || {}).message?.content || "").trim();
      if (!text) return { ok: false, via: "microscheduler", error: "The model answered with no text." };
      return { ok: true, via: "microscheduler", text, model: doc.model || chosen || "default", usage: doc.usage || undefined };
    } catch (error) {
      return { ok: false, via: "microscheduler", error: `Could not reach MicroScheduler: ${String((error && error.message) || error)}` };
    }
  }

  function toolText(result) {
    const parts = result && Array.isArray(result.content) ? result.content : [];
    return parts.map((p) => (p && typeof p.text === "string" ? p.text : "")).join("\n").trim();
  }

  async function viaGateway(tool, args) {
    if (!gateway || typeof gateway.callTool !== "function") return { ok: false, error: "The AitherOS gateway is not connected on this PC." };
    try {
      const result = await gateway.callTool(tool, args);
      const text = toolText(result);
      if (result && result.isError) return { ok: false, error: text || `${tool} failed` };
      return { ok: true, text };
    } catch (error) {
      return { ok: false, error: `The AitherOS gateway refused ${tool}: ${String((error && error.message) || error)}` };
    }
  }

  return {
    chat,
    /** "Ask an agent": a named agent answers (its own tools, memory and models). */
    askAgent: ({ agent, question }) => viaGateway("ask_agent", { agent: String(agent || "aither"), question: String(question || "").slice(0, 16000) }),
    /** "Send to an agent": a task for an agent, not an answer now. */
    delegate: ({ agent, description }) => viaGateway("delegate_to_agent", { to_agent: String(agent || "aither"), task_type: "user-selection", description: String(description || "").slice(0, 16000) }),
    /** "Send to a workflow": a named swarm run. */
    workflow: ({ name, text }) => viaGateway("dispatch_swarm", { swarm: String(name || ""), task: String(text || "").slice(0, 16000) }),
    /** "Save to memory". */
    remember: ({ text, tags }) => viaGateway("remember", { content: String(text || "").slice(0, 16000), category: "assist-selection", tags: String(tags || "assist") }),
  };
}

module.exports = { createAssistLlm, pickModel, schedulerUrl, refusalText, DEFAULT_TIMEOUT_MS, MAX_TOKENS };
