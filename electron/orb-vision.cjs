"use strict";

/**
 * orb-vision — how the ask orb gets an answer about what is on screen.
 *
 * TWO DOORS, ONE ANSWER. The desk already has a vision surface
 * (`vision-client.cjs`: gateway tools `ask_about_image` / `analyze_image_content`).
 * The orb uses it FIRST because that is the ruler — every gateway call feeds
 * Strata and the training harvest. It falls back to the perception service
 * DIRECTLY (`https://127.0.0.1:8084/analyze/upload`) because the gateway is
 * only one config line away from being wrong, and a desktop companion that
 * says "vision is down" when the model is healthy four hops away is a broken
 * companion.
 *
 * MEASURED 2026-11-02 on the owner's box — the reason the direct door exists:
 *   aitheros-mcpgateway carries AITHER_PERCEPTIONMEDIA_URL=http://aitheros-perception-media:8084
 *   while the service serves TLS, so the gateway's ask_about_image answers
 *   "Error: Vision upload-analyze: Server disconnected without sending a response."
 *   A direct https POST with the AitherNet CA answered correctly in 5.7 s
 *   ("The color of the circle in this image is red."). Same day, later:
 *   /status reported vllm.available:false, gemini/openai unconfigured, and the
 *   direct call hung past 120 s. So the direct door ALSO has a hard timeout and
 *   both failures are reported, never swallowed.
 *
 * The gateway and the container share no filesystem; the canonical Library bind
 * is the bridge (host C:\AitherOS-Data\Library = gateway
 * /app/AitherOS/Library), so a host path is staged there and the CONTAINER path
 * is what the gateway is asked about (same rule as drop-router.cjs).
 *
 * Fail-soft contract: every function RESOLVES with a verdict, never throws.
 */

const fs = require("node:fs");
const path = require("node:path");
const https = require("node:https");
const http = require("node:http");

const orbCore = require("./orb-core.cjs");
const visionClient = require("./vision-client.cjs");
const { internalCaOptions } = require("./internal-ca.cjs");

const DEFAULT_BASE = "https://127.0.0.1:8084";
const DIRECT_TIMEOUT_MS = 90000;

function baseUrl() {
  return String(process.env.AWDESK_ORB_VISION_URL || DEFAULT_BASE).replace(/\/+$/, "");
}

function gatewayUsable() {
  return process.env.AWDESK_ORB_SKIP_GATEWAY !== "1";
}

/** Best effort: stage the capture into the shared Library bind, hand the
 *  gateway the container path. null when staging is unavailable (the file
 *  may already live under Library). */
function stageForGateway(filePath) {
  try {
    const drop = require("./drop-router.cjs");
    if (!drop || typeof drop.stagePath !== "function") return null;
    const staged = drop.stagePath(filePath);
    if (!staged || !staged.container) return null;
    return staged;
  } catch {
    return null;
  }
}

function cleanupStaged(staged) {
  if (!staged || !staged.host) return;
  try {
    const drop = require("./drop-router.cjs");
    if (drop && typeof drop.cleanupStage === "function") drop.cleanupStage(staged.host);
    else fs.unlinkSync(staged.host);
  } catch {
    /* the stage dir is tmp; a leftover file costs nothing */
  }
}

/**
 * Door 1 — the MCP gateway. `ask` is injectable for tests; by default it is
 * vision-client's ask_about_image. gateway-mcp caps a call at 15 s (its
 * AWDESK_GATEWAY_TIMEOUT_MS is read at module load), so this door answers when
 * the model is warm; a COLD model load (~28-60 s) exceeds it and falls to the
 * direct door, which carries the long timeout.
 */
async function askViaGateway(imagePath, question, opts = {}) {
  const staged = opts.stage === false ? null : stageForGateway(imagePath);
  const imageRef = staged ? staged.container : imagePath;
  const ask = opts.ask || visionClient.askImage;
  let out;
  try {
    out = await ask(imageRef, question);
  } catch (err) {
    out = { error: err && err.message ? err.message : String(err) };
  } finally {
    if (staged) cleanupStaged(staged);
  }
  const parsed = orbCore.interpretGatewayAnswer(out);
  if (!parsed.ok) return { ok: false, via: "gateway", error: parsed.error };
  return { ok: true, via: "gateway", text: parsed.text, provider: (out && out.provider) || null };
}

function mimeFor(filePath) {
  const ext = path.extname(String(filePath || "")).toLowerCase();
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  if (ext === ".webp") return "image/webp";
  if (ext === ".gif") return "image/gif";
  return "image/png";
}

function multipartBody(fields, file) {
  const boundary = `----orb${Date.now().toString(16)}${Math.random().toString(16).slice(2, 8)}`;
  const parts = [];
  for (const [key, value] of Object.entries(fields || {})) {
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${key}"\r\n\r\n${value}\r\n`));
  }
  const safeName = String(file.name || "capture.png").replace(/["\r\n]/g, "_");
  parts.push(Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${safeName}"\r\nContent-Type: ${file.type}\r\n\r\n`,
  ));
  parts.push(file.data);
  parts.push(Buffer.from(`\r\n--${boundary}--\r\n`));
  return { body: Buffer.concat(parts), contentType: `multipart/form-data; boundary=${boundary}` };
}

/** POST a prepared body to an absolute https/http URL. Resolves
 *  {status, body} or throws with a message the classifier understands. */
function postMultipart(url, { body, contentType }, timeoutMs = DIRECT_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    let target;
    try {
      target = new URL(url);
    } catch {
      reject(new Error(`bad vision URL: ${url}`));
      return;
    }
    const secure = target.protocol === "https:";
    const lib = secure ? https : http;
    const req = lib.request(target, {
      method: "POST",
      timeout: timeoutMs,
      ...(secure ? internalCaOptions() : {}),
      headers: { "Content-Type": contentType, "Content-Length": body.length },
    }, (res) => {
      const chunks = [];
      res.on("data", (d) => chunks.push(d));
      res.on("end", () => resolve({ status: res.statusCode || 0, body: Buffer.concat(chunks).toString("utf8") }));
      res.on("error", (err) => reject(new Error(err.message || String(err))));
    });
    req.on("error", (err) => reject(new Error(err.message || String(err))));
    req.on("timeout", () => {
      req.destroy();
      reject(new Error(`vision request timed out after ${Math.round(timeoutMs / 1000)} s`));
    });
    req.write(body);
    req.end();
  });
}

function parseAnswer(text) {
  const raw = String(text || "").trim();
  if (!raw) return { ok: false, error: "the vision service returned an empty response" };
  try {
    const json = JSON.parse(raw);
    if (json && typeof json.analysis === "string" && json.analysis.trim()) {
      return {
        ok: true,
        text: json.analysis.trim(),
        provider: json.provider || null,
        model: json.model || null,
        durationMs: Number.isFinite(Number(json.duration_ms)) ? Number(json.duration_ms) : null,
      };
    }
    if (json && json.detail) return { ok: false, error: String(json.detail) };
    if (json && typeof json.error === "string") return { ok: false, error: json.error };
    return { ok: false, error: "the vision service returned no analysis" };
  } catch {
    return { ok: false, error: `the vision service answered non-JSON: ${raw.slice(0, 200)}` };
  }
}

/**
 * Door 2 — PerceptionMedia directly. `post` is injectable for tests.
 * QUESTION + custom_prompt is the endpoint's direct-instruction mode
 * (AitherVision._get_analysis_prompt returns custom_prompt verbatim), so the
 * orb's prompt reaches the model word for word.
 */
async function askDirect(imagePath, question, opts = {}) {
  const timeoutMs = Number(opts.timeoutMs) > 0 ? Number(opts.timeoutMs) : DIRECT_TIMEOUT_MS;
  const post = opts.post || postMultipart;
  let data;
  try {
    data = fs.readFileSync(imagePath);
  } catch (err) {
    return { ok: false, via: "direct", error: `cannot read the capture: ${err.message}` };
  }
  if (!data.length) return { ok: false, via: "direct", error: "the capture is empty" };
  const { body, contentType } = multipartBody(
    { analysis_type: "question", custom_prompt: String(question || "") },
    { name: path.basename(imagePath), type: mimeFor(imagePath), data },
  );
  let res;
  try {
    res = await post(`${baseUrl()}/analyze/upload`, { body, contentType }, timeoutMs);
  } catch (err) {
    return { ok: false, via: "direct", error: err && err.message ? err.message : String(err) };
  }
  if (res.status && res.status >= 400) {
    const parsed = parseAnswer(res.body);
    return { ok: false, via: "direct", status: res.status, error: parsed.ok ? `HTTP ${res.status}` : parsed.error };
  }
  const parsed = parseAnswer(res.body);
  if (!parsed.ok) return { ok: false, via: "direct", error: parsed.error };
  return { ok: true, via: "direct", ...parsed };
}

/**
 * The ladder. Resolves with
 *   {ok:true, text, via, provider, model, durationMs, attempts}
 *   {ok:false, error, code, title, text, remedy, via, attempts}
 * `attempts` is the honest record of both doors, for the debug line.
 *
 * opts.ask / opts.post inject the transports for tests; opts.timeoutMs sets
 * the DIRECT timeout; opts.skipGateway forces the direct door.
 */
/**
 * Door 0 — MicroScheduler, Bonsai, USER priority (owner 2026-11-02: "Bonsai is
 * literally a vision model"). Measured the same day: the perception service had no
 * model (vllm down, gemini/openai unconfigured) so doors 1-2 could not answer, and a
 * normal-priority Bonsai call waited 100 s+ behind a flood of orchestrator calls on
 * the local lane; with "priority":"user" the same image answered in 6.1 s. The
 * screenshot is downscaled to ~1024 px JPEG (a 4K PNG is ~10x the tokens).
 */
const SCHEDULER_TIMEOUT_MS = 90000;
function schedulerUrl() {
  return String(process.env.AITHER_MICROSCHEDULER_URL || "https://127.0.0.1:8150").replace(/\/+$/, "");
}
function visionModel() {
  return visionModels()[0];
}
/** Bonsai lanes raced in parallel (first good answer wins). Measured 2026-11-02:
 *  the 5090 lane queued a user ask 94 s behind a worker's 9.6k-token jobs while the
 *  DGX lane answered the same 4K screenshot in ~4 s. AWDESK_VISION_MODEL=a,b overrides. */
function visionModels() {
  const raw = String(process.env.AWDESK_VISION_MODEL || "bonsai-27b-dgx,bonsai2-27b-5090");
  const list = raw.split(",").map((m) => m.trim()).filter(Boolean);
  return list.length ? list : ["bonsai-27b-dgx"];
}
function imageDataUrl(imagePath, maxWidth = 1024) {
  try {
    const { nativeImage } = require("electron");
    if (nativeImage && typeof nativeImage.createFromPath === "function") {
      let img = nativeImage.createFromPath(imagePath);
      if (img && !img.isEmpty()) {
        const size = img.getSize();
        if (size.width > maxWidth) img = img.resize({ width: maxWidth, quality: "good" });
        return `data:image/jpeg;base64,${img.toJPEG(82).toString("base64")}`;
      }
    }
  } catch { /* plain node (tests): send the file as it is */ }
  return `data:${mimeFor(imagePath)};base64,${fs.readFileSync(imagePath).toString("base64")}`;
}
function postJson(url, payload, timeoutMs) {
  const body = Buffer.from(JSON.stringify(payload));
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const secure = target.protocol === "https:";
    const req = (secure ? https : http).request(target, {
      method: "POST", timeout: timeoutMs,
      ...(secure ? internalCaOptions() : {}),
      headers: { "Content-Type": "application/json", "Content-Length": body.length },
    }, (res) => {
      const chunks = [];
      res.on("data", (d) => chunks.push(d));
      res.on("end", () => resolve({ status: res.statusCode || 0, body: Buffer.concat(chunks).toString("utf8") }));
      res.on("error", (err) => reject(new Error(err.message || String(err))));
    });
    req.on("error", (err) => reject(new Error(err.message || String(err))));
    req.on("timeout", () => { req.destroy(); reject(new Error(`vision timed out after ${Math.round(timeoutMs / 1000)} s`)); });
    req.write(body);
    req.end();
  });
}
async function askViaScheduler(imagePath, question, opts = {}) {
  if (!opts.model) {
    const models = visionModels();
    if (models.length > 1) {
      // Race: resolve with the first ok answer; if all fail, report every error.
      const runs = models.map((model) => askViaScheduler(imagePath, question, { ...opts, model }));
      return new Promise((resolve) => {
        let left = runs.length;
        const errors = [];
        for (const run of runs) {
          run.then((r) => {
            if (r.ok) { resolve(r); return; }
            errors.push(r.error);
            left -= 1;
            if (left === 0) resolve({ ok: false, via: "scheduler", error: errors.join("; ") });
          });
        }
      });
    }
  }
  const post = opts.postJson || postJson;
  try {
    const payload = {
      model: opts.model || visionModel(),
      max_tokens: 400,
      priority: "user",
      source: "chat:desk-spirit",
      messages: [{ role: "user", content: [
        { type: "text", text: String(question || "What is on this screen?") },
        { type: "image_url", image_url: { url: imageDataUrl(imagePath) } },
      ] }],
    };
    const res = await post(`${schedulerUrl()}/v1/chat/completions`, payload, opts.schedulerTimeoutMs || SCHEDULER_TIMEOUT_MS);
    if (res.status !== 200) return { ok: false, via: "scheduler", error: `MicroScheduler answered ${res.status}` };
    const doc = JSON.parse(res.body || "{}");
    const text = String(((doc.choices || [])[0] || {}).message?.content || "").trim();
    if (!text) return { ok: false, via: "scheduler", error: "MicroScheduler answered with no text" };
    return { ok: true, via: "scheduler", text, provider: doc.model || payload.model };
  } catch (error) {
    return { ok: false, via: "scheduler", error: String((error && error.message) || error) };
  }
}

async function askVision(imagePath, question, opts = {}) {
  const attempts = [];
  if (!opts.skipScheduler) {
    const m = await askViaScheduler(imagePath, question, opts);
    attempts.push({ via: "scheduler", ok: m.ok, error: m.ok ? null : m.error });
    if (m.ok) return { ...m, attempts };
    // Every Bonsai lane TIMED OUT: the model lanes are queued, not broken. The other
    // two doors go through the perception service, which had no model at all when
    // this was measured (2026-11-02) and only adds 105 s of waiting -- say so now.
    if (/timed out/.test(String(m.error || "")) && !opts.tryAllDoors) {
      const text = "Bonsai is busy right now — every vision lane is queued behind other work "
        + "(agents, Discord, Darkmatter). Ask again in a minute.";
      return { ok: false, via: "scheduler", error: m.error, text, code: "busy",
        title: "Vision is busy", remedy: "Ask again in a minute", attempts };
    }
  }
  if (!opts.skipGateway && gatewayUsable()) {
    const g = await askViaGateway(imagePath, question, opts);
    attempts.push({ via: "gateway", ok: g.ok, error: g.ok ? null : g.error });
    if (g.ok) return { ...g, attempts };
  }
  const d = await askDirect(imagePath, question, opts);
  attempts.push({ via: "direct", ok: d.ok, error: d.ok ? null : d.error });
  if (d.ok) return { ...d, attempts };
  // Both doors failed: report the DIRECT error as the headline (it is the one
  // that names the service the owner can poke), the gateway's as evidence.
  const reason = d.error || (attempts.find((a) => a.error) || {}).error || "vision failed for no stated reason";
  const card = orbCore.failureCard(reason, { gateway: { active: "127.0.0.1:8182" } });
  return { ok: false, via: "direct", error: reason, ...card, attempts };
}

module.exports = {
  DEFAULT_BASE, DIRECT_TIMEOUT_MS,
  SCHEDULER_TIMEOUT_MS, schedulerUrl, visionModel, visionModels, askViaScheduler,
  baseUrl, stageForGateway, cleanupStaged, askViaGateway, askDirect, askVision,
  multipartBody, parseAnswer, postMultipart, mimeFor,
};
