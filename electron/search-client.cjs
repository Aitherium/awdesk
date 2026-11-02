"use strict";

/**
 * search-client.cjs -- search, deep research and Media Forge for the Aither Browser
 * (owner, 2026-10-04: "and maybe integrating awfind/awsearch/aithersearch and deep
 * research + media-forge!").
 *
 * Each capability goes through the tool that already owns it on this machine; the
 * desk adds no second search stack:
 *
 *   search      `awfind --json q|deep|answer` -- AitherSearch (the service at
 *               ~/.aither/awfind.json's url, 127.0.0.1:8114 here): ranked web +
 *               platform results; `answer` reads pages and cites them.
 *   images      gateway MCP `search_images` (keyless image search).
 *   research    `awresearch --output json` -- a cited report: claims, each pinned to
 *               numbered sources. Minutes long, so a JOB: started, listed, read back.
 *   Media Forge its own UI (mediaforge_status -> base) opens as a browser tab.
 *   discover    `adk discover query --json` -- the agents, tools, skills, packs and
 *               lanes this machine already indexed (adk/discovery). The universal
 *               search box (universal-search.cjs, Alt+Space) reads its fourth group
 *               here, so the desk keeps ONE caller of each tool.
 *
 * Runners are injected (execFile, spawn, callTool), so every verb is asserted under
 * node --test without Python or a gateway.
 */

const fs = require("node:fs");
const path = require("node:path");
const { randomBytes } = require("node:crypto");

const MODES = Object.freeze(["q", "deep", "answer"]);
const MAX_QUERY = 500;
const SEARCH_TIMEOUT_MS = Object.freeze({ q: 45_000, deep: 120_000, answer: 120_000 });
const RESEARCH_TIMEOUT_MS = 30 * 60_000;
const DEPTHS = Object.freeze(["standard", "deep"]);
const DISCOVER_TIMEOUT_MS = 10_000;
const DISCOVER_DOMAINS = Object.freeze(["agents", "tools", "skills", "packs", "lanes"]);

// ── the resident discovery worker ───────────────────────────────────────────
//
// Measured 2026-11-01 on the owner's box: `adk discover query` costs 5.9 s per call
// (Python start + adk import + index load), so the Alt+Space agents group always
// arrived last. Warm, the SAME ranking (adk.discovery.rank.query, live=False) answers
// in ~47 ms after a one-time 0.56 s import. So one hidden `python -u` stays resident,
// reads one JSON request per line and answers one JSON line; it is adk's own code,
// nothing is re-implemented here. Any failure (no python, adk not importable, a
// wedged or dead worker, a reply past DISCOVER_WORKER_MS) falls back to the CLI.
const DISCOVER_WORKER_MS = 4_000;
const DISCOVER_WORKER_IDLE_MS = 10 * 60_000;
const DISCOVER_WORKER_SCRIPT = [
  "import json, sys",
  "try:",
  "    from adk.discovery import rank",
  "    print(json.dumps({'ready': True}), flush=True)",
  "except Exception as e:",
  "    print(json.dumps({'ready': False, 'error': str(e)[:300]}), flush=True)",
  "    sys.exit(3)",
  "for line in sys.stdin:",
  "    rid = None",
  "    try:",
  "        req = json.loads(line)",
  "        rid = req.get('id')",
  "        res = rank.query(str(req.get('q', '')), k=int(req.get('k', 10)), live=False)",
  "        print(json.dumps({'id': rid, 'ok': True, 'cards': res.get('cards', [])}, default=str), flush=True)",
  "    except Exception as e:",
  "        print(json.dumps({'id': rid, 'ok': False, 'error': str(e)[:300]}), flush=True)",
].join("\n");

/**
 * One resident discovery process. query(q, k) resolves {ok, cards} | {ok:false, error};
 * never rejects. A worker that dies, refuses to import adk or misses the deadline is
 * dropped, and `broken` stays true for a minute so the caller uses the CLI meanwhile.
 */
function createDiscoveryWorker({
  spawn = require("node:child_process").spawn,
  python = process.env.AWDESK_DISCOVER_PYTHON || (process.platform === "win32" ? "python" : "python3"),
  timeoutMs = DISCOVER_WORKER_MS,
  idleMs = DISCOVER_WORKER_IDLE_MS,
  now = () => Date.now(),
} = {}) {
  let child = null;
  let ready = null;
  let buffer = "";
  let seq = 0;
  let brokenUntil = 0;
  let idleTimer = null;
  const pending = new Map();

  function drop(why) {
    const c = child;
    child = null;
    ready = null;
    buffer = "";
    for (const [, w] of pending) w({ ok: false, error: why });
    pending.clear();
    if (c) { try { c.kill(); } catch { /* already gone */ } }
  }

  function start() {
    if (child) return ready;
    let c;
    try {
      c = spawn(python, ["-u", "-c", DISCOVER_WORKER_SCRIPT], {
        windowsHide: true, stdio: ["pipe", "pipe", "pipe"],
        env: { ...process.env, PYTHONIOENCODING: "utf-8" },
      });
    } catch (error) {
      brokenUntil = now() + 60_000;
      return Promise.resolve({ ok: false, error: String((error && error.message) || error) });
    }
    child = c;
    let resolveReady;
    ready = new Promise((r) => { resolveReady = r; });
    c.stdout.setEncoding("utf8");
    c.stdout.on("data", (chunk) => {
      buffer += chunk;
      let nl;
      while ((nl = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        let msg;
        try { msg = JSON.parse(line); } catch { continue; }
        if (msg && "ready" in msg) {
          if (!msg.ready) brokenUntil = now() + 60_000;
          resolveReady(msg.ready ? { ok: true } : { ok: false, error: `adk not importable: ${msg.error || "?"}` });
          continue;
        }
        const w = msg && pending.get(String(msg.id));
        if (!w) continue;
        pending.delete(String(msg.id));
        w(msg.ok ? { ok: true, cards: Array.isArray(msg.cards) ? msg.cards : [] } : { ok: false, error: String(msg.error || "worker error") });
      }
    });
    if (c.stderr) c.stderr.on("data", () => { /* warnings; verdicts come on stdout */ });
    const gone = (why) => {
      if (child !== c) return;
      brokenUntil = now() + 60_000;
      resolveReady({ ok: false, error: why });
      drop(why);
    };
    c.on("exit", (code) => gone(`discovery worker exited (code ${code})`));
    c.on("error", (error) => gone(`discovery worker failed to start: ${error.message}`));
    if (c.stdin && typeof c.stdin.on === "function") c.stdin.on("error", () => gone("discovery worker closed its input"));
    return ready;
  }

  function touch() {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => drop("idle"), idleMs);
    if (idleTimer.unref) idleTimer.unref();
  }

  async function query(q, k = 10) {
    if (now() < brokenUntil) return { ok: false, error: "discovery worker unavailable" };
    let timer;
    const deadline = new Promise((r) => { timer = setTimeout(() => r({ ok: false, error: "deadline", late: true }), timeoutMs); if (timer.unref) timer.unref(); });
    const answer = (async () => {
      const r = await start();
      if (!r || !r.ok) return { ok: false, error: (r && r.error) || "discovery worker unavailable" };
      const id = `d${++seq}`;
      const got = new Promise((resolve) => pending.set(id, resolve));
      touch();
      try { child.stdin.write(`${JSON.stringify({ id, q, k })}\n`); } catch (error) {
        pending.delete(id);
        return { ok: false, error: String((error && error.message) || error) };
      }
      return got;
    })();
    const out = await Promise.race([answer, deadline]);
    clearTimeout(timer);
    if (out && out.late) { brokenUntil = now() + 60_000; drop("missed its deadline"); }
    return out;
  }

  return { query, start, stop: () => drop("stopped"), get running() { return Boolean(child); } };
}

function cleanQuery(text) {
  // eslint-disable-next-line no-control-regex
  const q = String(text == null ? "" : text).replace(/[\u0000-\u001f\u007f]/g, " ").trim();
  return q.slice(0, MAX_QUERY);
}

/** One awfind/search result, as the page renders it. Only http(s) links survive. */
function resultRow(r) {
  const url = String((r && r.url) || "");
  if (!/^https?:\/\//i.test(url)) return null;
  return {
    title: String((r && r.title) || url).slice(0, 300),
    url,
    snippet: String((r && (r.snippet || r.text)) || "").slice(0, 600),
    source: String((r && r.source) || ""),
    score: Number.isFinite(Number(r && r.score)) ? Number(r.score) : null,
  };
}

/** One `adk discover` card, as the universal search renders it. Unknown domains are dropped. */
function discoverCard(c) {
  const domain = String((c && c.domain) || "");
  const name = String((c && c.name) || "").slice(0, 200);
  if (!DISCOVER_DOMAINS.includes(domain) || !name) return null;
  const score = Number(c && c.score);
  return {
    domain, name,
    oneLine: String((c && (c.one_line || c.summary)) || "").slice(0, 300),
    hosting: String((c && c.hosting) || ""),
    howToInvoke: String((c && c.how_to_invoke) || "").slice(0, 200),
    score: Number.isFinite(score) ? Math.max(0, Math.min(1, score)) : 0,
  };
}

/** Parse the first JSON value on stdout (a CLI may print a banner line first). */
function parseJsonOut(stdout) {
  const text = String(stdout || "");
  const start = text.search(/[[{]/);
  if (start < 0) throw new Error("no JSON in the output");
  return JSON.parse(text.slice(start));
}

/** The research report, validated to the shape the page renders. */
function reportView(raw) {
  const r = raw && typeof raw === "object" ? raw : {};
  const sources = (Array.isArray(r.sources) ? r.sources : []).map((s) => ({
    url: /^https?:\/\//i.test(String((s && s.url) || "")) ? String(s.url) : "",
    title: String((s && (s.title || s.url)) || "source").slice(0, 300),
    domain: String((s && s.domain) || ""),
    trust: Number.isFinite(Number(s && s.trust)) ? Number(s.trust) : null,
  }));
  const claims = (Array.isArray(r.claims) ? r.claims : []).map((c) => ({
    text: String((c && c.text) || ""),
    sources: (Array.isArray(c && c.sources) ? c.sources : [])
      .map(Number).filter((n) => Number.isInteger(n) && n >= 1 && n <= sources.length),
    unsourcedReason: c && c.unsourced_reason ? String(c.unsourced_reason) : null,
  })).filter((c) => c.text);
  return { question: String(r.question || ""), depth: String(r.research_depth || ""), claims, sources };
}

function createSearchClient({
  execFile = require("node:child_process").execFile,
  spawn = require("node:child_process").spawn,
  callTool = (...args) => require("./gateway-mcp.cjs").callTool(...args),
  dataDir = null,
  now = () => Date.now(),
  discoveryWorker = null,
} = {}) {
  // The resident worker only where a real spawn exists; tests inject one or get none.
  const worker = discoveryWorker || null;
  // `signal` (optional) goes to execFile: an abort kills the child (a superseded `adk discover`).
  const run = (cmd, args, timeout, signal = null) => new Promise((resolve) => {
    const opts = { timeout, windowsHide: true, maxBuffer: 8 * 1024 * 1024 };
    if (signal) opts.signal = signal;
    execFile(cmd, args, opts, (error, stdout, stderr) => {
      resolve({ error, stdout: String(stdout || ""), stderr: String(stderr || "") });
    });
  });

  async function search(mode, text, { limit = 12 } = {}) {
    if (!MODES.includes(mode)) return { ok: false, error: `unknown search mode ${mode}` };
    const q = cleanQuery(text);
    if (!q) return { ok: false, error: "type something to search for" };
    const args = ["--json", mode];
    if (mode === "answer") args.push("--sources", "4");
    else args.push("--limit", String(Math.max(1, Math.min(30, Number(limit) || 12))));
    args.push("--", q);
    const out = await run("awfind", args, SEARCH_TIMEOUT_MS[mode]);
    if (out.error && !out.stdout) {
      const why = out.error.code === "ENOENT" ? "awfind is not installed (pip install -e the awfind package)"
        : out.error.killed ? "the search took too long" : (out.stderr.trim().split("\n").pop() || String(out.error.message));
      return { ok: false, error: why };
    }
    let data;
    try { data = parseJsonOut(out.stdout); } catch (e) { return { ok: false, error: `awfind answered something unreadable: ${e.message}` }; }
    return {
      ok: true, mode, query: q,
      answer: data && data.answer ? String(data.answer) : null,
      results: (Array.isArray(data && data.results) ? data.results : []).map(resultRow).filter(Boolean),
    };
  }

  async function images(text) {
    const q = cleanQuery(text);
    if (!q) return { ok: false, error: "type something to search for" };
    try {
      const raw = await callTool("search_images", { query: q, limit: 24 });
      const data = typeof raw === "string" ? JSON.parse(raw) : raw;
      const rows = (Array.isArray(data && data.images) ? data.images : [])
        .filter((i) => /^https:\/\//i.test(String(i.thumbnail_url || "")) && /^https?:\/\//i.test(String(i.source_url || i.url || "")))
        .map((i) => ({ title: String(i.title || ""), thumb: String(i.thumbnail_url), url: String(i.source_url || i.url) }));
      return { ok: true, query: q, images: rows };
    } catch (error) {
      return { ok: false, error: String((error && error.message) || error) };
    }
  }

  /**
   * Agents, tools, skills, packs and lanes for a task, from the local discovery
   * index (`adk discover query <task> --json --no-live`). `--no-live` keeps it
   * fast enough to run as the owner types; the index already holds the gateway's
   * tool list from its last build.
   *
   * @param {string} text   the task, as typed
   * @param {{k?: number, signal?: AbortSignal}} [opts]  an aborted `signal` kills the child
   * @returns {Promise<{ok: true, query: string, cards: object[]} | {ok: false, error: string}>}
   */
  async function discover(text, { k = 10, signal = null } = {}) {
    const q = cleanQuery(text);
    if (!q) return { ok: false, error: "type something to search for" };
    if (signal && signal.aborted) return { ok: false, error: "superseded by a newer search" };
    const n = String(Math.max(1, Math.min(30, Number(k) || 10)));
    if (worker) {
      const fast = await worker.query(q, Number(n));
      if (signal && signal.aborted) return { ok: false, error: "superseded by a newer search" };
      if (fast && fast.ok) return { ok: true, query: q, cards: fast.cards.map(discoverCard).filter(Boolean), via: "worker" };
      // fall through to the CLI: same index, same ranking, only slower
    }
    const out = await run("adk", ["discover", "query", "--json", "--no-live", "--k", n, "--", q], DISCOVER_TIMEOUT_MS, signal);
    if (out.error && (out.error.name === "AbortError" || out.error.code === "ABORT_ERR")) {
      return { ok: false, error: "superseded by a newer search" };
    }
    if (out.error && !out.stdout) {
      const why = out.error.code === "ENOENT" ? "adk is not installed (pip install -e awdk)"
        : out.error.killed ? "adk discover took too long (run `adk discover build`)"
          : (out.stderr.trim().split("\n").pop() || String(out.error.message));
      return { ok: false, error: why };
    }
    let data;
    try { data = parseJsonOut(out.stdout); } catch (e) { return { ok: false, error: `adk discover answered something unreadable: ${e.message}` }; }
    return { ok: true, query: q, cards: (Array.isArray(data && data.cards) ? data.cards : []).map(discoverCard).filter(Boolean) };
  }

  // ── research jobs ────────────────────────────────────────────────────────
  const jobs = new Map();
  const dir = () => {
    const d = dataDir || path.join(require("node:os").homedir(), ".aither", "desk-research");
    fs.mkdirSync(d, { recursive: true });
    return d;
  };
  const publicJob = (j) => ({ id: j.id, question: j.question, depth: j.depth, state: j.state,
    startedAt: j.startedAt, endedAt: j.endedAt || null, error: j.error || null });

  function startResearch(question, depth = "standard") {
    const q = cleanQuery(question);
    if (!q) return { ok: false, error: "ask a research question" };
    const d = DEPTHS.includes(depth) ? depth : "standard";
    const id = randomBytes(6).toString("hex");
    const file = path.join(dir(), `${id}.json`);
    const job = { id, question: q, depth: d, state: "running", startedAt: now(), file };
    jobs.set(id, job);
    let child;
    try {
      child = spawn("awresearch", ["--question", q, "--depth", d, "--output", "json", "--out-file", file],
        { windowsHide: true, stdio: ["ignore", "ignore", "pipe"] });
    } catch (error) {
      job.state = "failed";
      job.error = String((error && error.message) || error);
      return { ok: false, error: job.error };
    }
    let stderr = "";
    if (child.stderr) child.stderr.on("data", (b) => { stderr = (stderr + b).slice(-4000); });
    const timer = setTimeout(() => { try { child.kill(); } catch { /* gone */ } }, RESEARCH_TIMEOUT_MS);
    if (timer.unref) timer.unref();
    child.on("error", (error) => {
      job.state = "failed";
      job.error = error.code === "ENOENT" ? "awresearch is not installed" : String(error.message);
      job.endedAt = now();
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      if (job.state !== "running") return;
      job.endedAt = now();
      if (code === 0 && fs.existsSync(file)) job.state = "done";
      else {
        job.state = "failed";
        job.error = stderr.trim().split("\n").pop() || `awresearch exited ${code}`;
      }
    });
    return { ok: true, job: publicJob(job) };
  }

  function listResearch() {
    return { ok: true, jobs: [...jobs.values()].sort((a, b) => b.startedAt - a.startedAt).map(publicJob) };
  }

  function readResearch(id) {
    const job = jobs.get(String(id || ""));
    if (!job) return { ok: false, error: "no such research job" };
    if (job.state !== "done") return { ok: true, job: publicJob(job), report: null };
    try {
      return { ok: true, job: publicJob(job), report: reportView(JSON.parse(fs.readFileSync(job.file, "utf8"))) };
    } catch (error) {
      return { ok: false, error: `the report could not be read: ${error.message}` };
    }
  }

  // ── Media Forge ─────────────────────────────────────────────────────────
  async function forgeUrl() {
    if (process.env.DESK_MEDIA_FORGE_URL) return { ok: true, url: String(process.env.DESK_MEDIA_FORGE_URL) };
    try {
      const raw = await callTool("mediaforge_status", {});
      const data = typeof raw === "string" ? JSON.parse(raw) : raw;
      const base = String((data && data.base) || "");
      if (!data || !data.reachable || !/^https?:\/\//i.test(base)) {
        return { ok: false, error: "Media Forge is not reachable right now" };
      }
      return { ok: true, url: new URL("/", base).href, busy: Boolean(data.gpu_busy) };
    } catch (error) {
      return { ok: false, error: String((error && error.message) || error) };
    }
  }

  return { search, images, discover, startResearch, listResearch, readResearch, forgeUrl };
}

module.exports = {
  DEPTHS, DISCOVER_DOMAINS, MODES, cleanQuery, createDiscoveryWorker, createSearchClient, discoverCard, parseJsonOut,
  reportView, resultRow, DISCOVER_WORKER_SCRIPT,
};
