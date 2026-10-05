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
} = {}) {
  const run = (cmd, args, timeout) => new Promise((resolve) => {
    execFile(cmd, args, { timeout, windowsHide: true, maxBuffer: 8 * 1024 * 1024 }, (error, stdout, stderr) => {
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

  return { search, images, startResearch, listResearch, readResearch, forgeUrl };
}

module.exports = { DEPTHS, MODES, cleanQuery, createSearchClient, parseJsonOut, reportView, resultRow };
