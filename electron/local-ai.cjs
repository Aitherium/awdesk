"use strict";

/**
 * local-ai.cjs -- the Desk's "Local AI": a Bonsai model on THIS computer, so the
 * workspace assistant keeps answering when the platform cannot be reached.
 *
 * Customer ask, 2026-10-22: a workspace customer on Windows, no container engine, wants
 * to pick a model size and install it himself, and to keep chatting when his workspace
 * (or the model behind it) is down. The bar is "so easy an 8 year old can use it".
 *
 * Every model decision is awdk's (`adk bonsai-local`, awdk/adk/bonsai_native.py): this
 * file only runs it and reads its JSON.
 *
 *   status   `python -m adk bonsai-local --status --json` -> sizes, recommendation,
 *            what is installed, whether it answers
 *   install  `... --model <id> --json` (one at a time; stdout lines are the progress)
 *   remove   `... --remove --purge --json`
 *   chat     POST http://127.0.0.1:<port>/v1/chat/completions, model "bonsai-local"
 *
 * And the one decision the Desk makes itself, `decideChatTarget`: talk to the workspace
 * when it and its model answer; otherwise talk to the local model, and say plainly that
 * it does not have the company documents (it does not: nothing syncs them to this PC).
 *
 * The workspace is judged by `<api>/api/health`, which is public and reports
 * `brain_reachable` -- false when the workspace is up but its model is not (measured
 * live 2026-10-22: status "degraded", brain_reachable false). The API base comes from
 * the workspace page's own `/config.js` (`window.__AITHER_API_BASE__`).
 *
 * Electron-free and dependency-injected (run, spawn, fetch): local-ai.test.cjs drives it.
 */

const { pythonCandidates, childEnv, defaultRun } = require("./local-node.cjs");

/** The sizes awdk serves natively. Anything else from a page is refused, never passed on. */
const MODEL_IDS = Object.freeze(["bonsai-1.7b", "bonsai-4b", "bonsai-8b", "bonsai-27b", "bonsai2-27b"]);
const SERVED_NAME = "bonsai-local";
const DEFAULT_PORT = 8090;
/** The newest awdk module this file needs. */
const ADK_PROBE = "import adk.bonsai_native";
const CLOUD_TIMEOUT_MS = 6000;
const PIP_RETRY_MS = 10 * 60 * 1000;
/** Local chat on a CPU can be slow; give it long enough to finish a real answer. */
const CHAT_TIMEOUT_MS = 5 * 60 * 1000;

/** Plain words, shown on the screen. Kept here so a test can pin them. */
const COPY = Object.freeze({
  offlineLocal: "Your workspace can't be reached right now, so you're talking to the AI on "
    + "this computer. It can't see your company documents.",
  localOnly: "This is the AI on this computer. It can't see your company documents.",
  offlineNone: "Your workspace can't be reached right now, and this computer has no "
    + "local AI yet. Install one below.",
  offlineStopped: "Your workspace can't be reached right now. Start the AI on this "
    + "computer to keep chatting.",
});

/** `window.__AITHER_API_BASE__ = "https://..."` from a workspace config.js; null if absent. */
function parseApiBase(configJs) {
  const m = /__AITHER_API_BASE__\s*=\s*["'](https:\/\/[^"'\s]+)["']/.exec(String(configJs || ""));
  if (!m) return null;
  try {
    const u = new URL(m[1]);
    return u.protocol === "https:" ? u.origin : null;
  } catch {
    return null;
  }
}

/**
 * Can the workspace answer a chat right now?
 * @returns {Promise<{reachable: boolean, modelOk: boolean|null, detail: string, apiBase: string|null}>}
 *   modelOk null = the workspace answered but did not say (treated as OK).
 */
async function probeCloud(tenantHost, { fetchImpl = fetch, timeoutMs = CLOUD_TIMEOUT_MS } = {}) {
  const host = String(tenantHost || "").trim().toLowerCase();
  if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(host)) {
    return { reachable: false, modelOk: null, detail: "no workspace is set up on this Desk", apiBase: null };
  }
  const get = async (url) => fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs) });
  let apiBase = null;
  try {
    const res = await get(`https://${host}/config.js`);
    if (res.ok) apiBase = parseApiBase(await res.text());
  } catch (e) {
    return { reachable: false, modelOk: null, detail: `the workspace page did not answer (${errName(e)})`, apiBase: null };
  }
  apiBase = apiBase || `https://${host}`;
  try {
    const res = await get(`${apiBase}/api/health`);
    if (!res.ok) return { reachable: false, modelOk: null, detail: `the workspace answered HTTP ${res.status}`, apiBase };
    const body = await res.json().catch(() => null);
    if (!body || typeof body !== "object") {
      return { reachable: false, modelOk: null, detail: "the workspace sent no health report", apiBase };
    }
    const modelOk = body.brain_reachable === false ? false : body.brain_reachable === true ? true : null;
    return { reachable: true, modelOk, detail: modelOk === false ? "the workspace's AI model is not answering" : "ok", apiBase };
  } catch (e) {
    return { reachable: false, modelOk: null, detail: `the workspace did not answer (${errName(e)})`, apiBase };
  }
}

function errName(e) {
  return (e && (e.name === "TimeoutError" ? "timed out" : e.code || e.name)) || "error";
}

/**
 * Where a chat goes. Pure.
 * @param {{reachable: boolean, modelOk: boolean|null}} cloud
 * @param {{installed: boolean, running: boolean}} local
 * @returns {{target: "cloud"|"local"|"start-local"|"none", offline: boolean, banner: string}}
 */
function decideChatTarget(cloud, local) {
  const c = cloud || {};
  const l = local || {};
  const cloudOk = Boolean(c.reachable) && c.modelOk !== false;
  if (cloudOk) return { target: "cloud", offline: false, banner: "" };
  if (l.running) return { target: "local", offline: true, banner: COPY.offlineLocal };
  if (l.installed) return { target: "start-local", offline: true, banner: COPY.offlineStopped };
  return { target: "none", offline: true, banner: COPY.offlineNone };
}

/** Drop a reasoning model's <think>...</think> block from what the person reads. */
function visibleText(content) {
  return String(content || "").replace(/<think>[\s\S]*?<\/think>/g, "").replace(/^[\s\S]*<\/think>/, "").trim();
}

function createLocalAi(deps = {}) {
  const spawn = deps.spawn || require("node:child_process").spawn;
  const run = deps.run || defaultRun(spawn);
  const fetchImpl = deps.fetch || fetch;
  const platform = deps.platform || process.platform;
  const env = childEnv(deps.env || process.env);
  const log = deps.log || (() => {});

  const now = deps.now || Date.now;
  let python = null; // [cmd, prefixArgs]
  let adkOk = false;
  let pipTriedAt = 0;
  /** The one install/remove in flight: {verb, model, running, line, ok, error}. */
  let job = { verb: null, model: null, running: false, line: "", ok: null, error: "" };

  async function findPython() {
    if (python) return python;
    for (const [cmd, pre] of pythonCandidates(platform)) {
      const r = await run(cmd, [...pre, "-c", "import sys; print(sys.version_info >= (3, 10))"], { env });
      if (r.code === 0 && /True/.test(r.stdout)) {
        python = [cmd, pre];
        return python;
      }
    }
    return null;
  }

  /** Python + an awdk that has bonsai-local natively, or a plain-words reason why not. */
  async function ready() {
    const py = await findPython();
    if (!py) {
      return { ok: false, reason: "no-python",
        error: "This computer needs Python 3.10 or newer for Local AI. Install it from python.org (tick \"Add to PATH\"), then open Local AI again." };
    }
    const [cmd, pre] = py;
    const tooOld = { ok: false, reason: "awdk-too-old",
      error: "Local AI needs a newer awdk than this computer can get right now. Try again later." };
    if (adkOk) return { ok: true, py };
    if ((await run(cmd, [...pre, "-c", ADK_PROBE], { env })).code === 0) {
      adkOk = true;
      return { ok: true, py };
    }
    // The page polls status: one pip attempt per PIP_RETRY_MS, never one per poll.
    if (pipTriedAt && now() - pipTriedAt < PIP_RETRY_MS) return tooOld;
    pipTriedAt = now();
    const pip = await run(cmd, [...pre, "-m", "pip", "install", "--user", "--upgrade", "awdk"],
      { env, timeoutMs: 10 * 60 * 1000 });
    if (pip.code === 0 && (await run(cmd, [...pre, "-c", ADK_PROBE], { env })).code === 0) {
      adkOk = true;
      return { ok: true, py };
    }
    return tooOld;
  }

  async function adk(args, opts = {}) {
    const r = await ready();
    if (!r.ok) return { ok: false, reason: r.reason, error: r.error };
    const [cmd, pre] = r.py;
    return { ok: true, result: await run(cmd, [...pre, "-m", "adk", "bonsai-local", ...args], { env, ...opts }) };
  }

  function lastJson(stdout) {
    const lines = String(stdout || "").trim().split(/\r?\n/).reverse();
    for (const line of lines) {
      const t = line.trim();
      if (t.startsWith("{")) {
        try { return JSON.parse(t); } catch { /* keep looking */ }
      }
    }
    return null;
  }

  async function status() {
    const r = await adk(["--status", "--json"], { timeoutMs: 60_000 });
    if (!r.ok) return r;
    const data = lastJson(r.result.stdout);
    if (!data) return { ok: false, error: `could not read Local AI status (exit ${r.result.code})` };
    return { ok: true, ...data };
  }

  /** Start one install/switch or remove; resolves at once. Poll jobStatus(). */
  function startJob(verb, model) {
    if (job.running) return { ok: false, error: "Local AI is already busy; wait for it to finish." };
    if (verb === "install" && !MODEL_IDS.includes(model)) return { ok: false, error: "unknown model size" };
    job = { verb, model: model || null, running: true, line: verb === "install" ? "Getting ready…" : "Removing…", ok: null, error: "" };
    const args = verb === "install" ? ["--model", model, "--json"] : ["--remove", "--purge", "--json"];
    const mine = job;
    void (async () => {
      const r = await ready();
      if (!r.ok) {
        Object.assign(mine, { running: false, ok: false, error: r.error });
        return;
      }
      const [cmd, pre] = r.py;
      let child;
      try {
        child = spawn(cmd, [...pre, "-m", "adk", "bonsai-local", ...args],
          { env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
      } catch (e) {
        Object.assign(mine, { running: false, ok: false, error: String((e && e.message) || e) });
        return;
      }
      let out = "";
      const onData = (d) => {
        out += d;
        const lines = String(d).split(/[\r\n]+/).map((s) => s.trim()).filter((s) => s && !s.startsWith("{"));
        if (lines.length) mine.line = lines[lines.length - 1].replace(/^\[[+!*=]\]\s*/, "");
      };
      child.stdout?.on("data", onData);
      child.stderr?.on("data", onData);
      child.on("error", (e) => Object.assign(mine, { running: false, ok: false, error: String(e.message || e) }));
      child.on("close", (code) => {
        const res = lastJson(out);
        const ok = code === 0 && (!res || res.ok !== false);
        Object.assign(mine, { running: false, ok, error: ok ? "" : (res && res.error) || mine.line || `exit ${code}` });
        log(`local-ai: ${verb} ${model || ""} -> ${ok ? "ok" : mine.error}`);
      });
    })();
    return { ok: true, job: { ...job } };
  }

  /** One message to the local model. messages: [{role, content}] from the page. */
  async function chat(messages, port = DEFAULT_PORT) {
    const clean = (Array.isArray(messages) ? messages : [])
      .filter((m) => m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string")
      .slice(-20)
      .map((m) => ({ role: m.role, content: m.content.slice(0, 8000) }));
    if (!clean.length || clean[clean.length - 1].role !== "user") return { ok: false, error: "nothing to send" };
    const p = Number(port);
    if (!Number.isInteger(p) || p < 1 || p > 65535) return { ok: false, error: "bad port" };
    try {
      const res = await fetchImpl(`http://127.0.0.1:${p}/v1/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: SERVED_NAME, messages: clean, max_tokens: 1024 }),
        signal: AbortSignal.timeout(CHAT_TIMEOUT_MS),
      });
      const data = await res.json().catch(() => null);
      const msg = data && data.choices && data.choices[0] && data.choices[0].message;
      const text = visibleText(msg && msg.content);
      if (!res.ok || !text) return { ok: false, error: "The local AI gave no answer. Try again, or pick a bigger size." };
      return { ok: true, text };
    } catch (e) {
      return { ok: false, error: e && e.name === "TimeoutError" ? "The local AI took too long to answer."
        : "The local AI is not running. Open Local AI and press Start." };
    }
  }

  return {
    status,
    install: (model) => startJob("install", String(model || "")),
    remove: () => startJob("remove", null),
    jobStatus: () => ({ ...job }),
    chat,
  };
}

/** Is OUR local model answering? GET /v1/models lists "bonsai-local". Never throws. */
async function localRunning(port = DEFAULT_PORT, fetchImpl = fetch) {
  try {
    const res = await fetchImpl(`http://127.0.0.1:${Number(port)}/v1/models`, { signal: AbortSignal.timeout(2000) });
    const data = await res.json().catch(() => null);
    return Boolean(res.ok && data && Array.isArray(data.data) && data.data.some((m) => m && m.id === SERVED_NAME));
  } catch {
    return false;
  }
}

/**
 * Watch the workspace; when it drops while the local model answers, say so ONCE (a
 * toast whose click opens Local AI). Back online resets it. No local model = silence:
 * a toast that leads nowhere is noise.
 * deps: {tenantHost(): string, probe(host), local(): Promise<bool>, notify(title, body, onClick),
 *        open(), intervalMs, setInterval, clearInterval}
 */
function createOfflineWatch(deps) {
  const setI = deps.setInterval || setInterval;
  const clearI = deps.clearInterval || clearInterval;
  let wasOffline = false;
  let timer = null;

  async function tick() {
    const host = deps.tenantHost();
    if (!host) return { skipped: "no workspace" };
    const cloud = await deps.probe(host);
    const running = await deps.local();
    const route = decideChatTarget(cloud, { installed: running, running });
    if (!route.offline) {
      wasOffline = false;
      return { route };
    }
    if (!wasOffline && route.target === "local") {
      wasOffline = true;
      deps.notify("Your workspace is offline",
        "Keep chatting with the AI on this computer. It can't see your company documents.",
        () => deps.open());
      return { route, notified: true };
    }
    return { route };
  }

  return {
    tick,
    start() {
      if (!timer) timer = setI(() => { void tick().catch(() => {}); }, deps.intervalMs || 2 * 60 * 1000);
      return this;
    },
    stop() { if (timer) clearI(timer); timer = null; },
  };
}

module.exports = {
  createLocalAi, decideChatTarget, probeCloud, parseApiBase, visibleText, localRunning, createOfflineWatch,
  MODEL_IDS, SERVED_NAME, DEFAULT_PORT, COPY,
};
