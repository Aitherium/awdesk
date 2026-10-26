"use strict";

/**
 * file-ask -- "ask about this file" for the desk.
 *
 * An agent names a file under a folder the owner shared in the Files page and a
 * question. The text is read through files-access (same grant, same confinement,
 * same deny list as files_read) and posted to TokenGate (default
 * http://127.0.0.1:8172/ask), which keeps only the passages that matter and
 * returns them with character offsets -- so the answer can be shown next to the
 * exact lines it came from.
 *
 * 🚩 There is no fallback answer here. When TokenGate is down, not ready, or the
 * document is over its 32,768-token ceiling, the result is {ok:false} and says
 * exactly which of those it is. A file question must never receive a confident
 * answer from nowhere (the no-silent-degradation rule).
 *
 * 🚩 PDF/DOCX: the desk ships no text extractor, and files-access hands back raw
 * bytes. Those extensions are refused BY NAME rather than posted as mojibake --
 * a garbled document that produces a sane-looking answer is worse than a
 * refusal.
 */

const DEFAULT_ASK_URL = "http://127.0.0.1:8172";
const DEFAULT_TIMEOUT_MS = 180000;
// TokenGate's ceiling is 32,768 tokens (~120k chars of prose). 100k leaves
// headroom for denser code so a typical file asks successfully and a big one
// still gets a real 413 (surfaced, never truncated silently).
const READ_BYTES = 100000;
const MAX_QUESTION = 2000;

// Formats with no extractor in this desk: refuse by name, not after posting bytes.
const NO_TEXT_EXTRACTOR = Object.freeze(new Set([
  "pdf", "docx", "doc", "xlsx", "xls", "pptx", "ppt", "odt", "ods", "epub",
  "zip", "gz", "tar", "7z", "rar",
  "png", "jpg", "jpeg", "gif", "webp", "bmp", "tiff", "heic",
  "mp3", "wav", "ogg", "flac", "mp4", "mov", "mkv", "webm",
]));

function extOf(rel) {
  const name = String(rel || "").split(/[\\/]/).pop() || "";
  const dot = name.lastIndexOf(".");
  return dot <= 0 ? "" : name.slice(dot + 1).toLowerCase();
}

/** Turn a non-2xx answer into the sentence a caller can act on. */
function refusalFrom(status, body) {
  const detail = body && typeof body === "object" ? (body.detail ?? body) : {};
  const reason = detail && typeof detail === "object" ? detail.reason : undefined;
  if (status === 413) {
    const stateTokens = Number(detail?.state_tokens);
    const maxTokens = Number(detail?.max_state_tokens);
    const sizes = Number.isFinite(stateTokens) && Number.isFinite(maxTokens)
      ? ` (${stateTokens} tokens; the ceiling is ${maxTokens})`
      : "";
    return {
      ok: false,
      status,
      reason: reason || "document_too_large",
      error: `The file is over TokenGate's token ceiling${sizes}. Ask about a smaller file or a section of it.`,
      state_tokens: Number.isFinite(stateTokens) ? stateTokens : null,
      max_state_tokens: Number.isFinite(maxTokens) ? maxTokens : null,
    };
  }
  if (status === 503) {
    return {
      ok: false,
      status,
      reason: reason || "not_ready",
      error: "TokenGate is not ready -- it is still loading a model or has no checkpoint. Retry once GET /health reports ready.",
    };
  }
  const message = detail && typeof detail === "object" && typeof detail.error === "string"
    ? detail.error
    : detail && typeof detail === "object" && typeof detail.reason === "string"
      ? detail.reason
      : `TokenGate answered ${status}`;
  return { ok: false, status, reason: reason || "upstream_error", error: message };
}

/**
 * @param {object} opts
 * @param {{read: Function}} opts.files  files-access.cjs `agent` half.
 * @param {string} [opts.askUrl]         TokenGate base URL (no trailing /ask).
 * @param {Function} [opts.fetchImpl]    test seam.
 * @param {number} [opts.readBytes]
 * @param {number} [opts.timeoutMs]
 */
function createFileAsk({
  files,
  askUrl = process.env.TOKENGATE_URL || process.env.AITHER_TOKENGATE_URL || DEFAULT_ASK_URL,
  fetchImpl = globalThis.fetch,
  readBytes = READ_BYTES,
  timeoutMs = DEFAULT_TIMEOUT_MS,
} = {}) {
  const base = String(askUrl || "").replace(/\/+$/, "");

  async function ask({ root, path: rel, question, maxKeptTokens, evidence } = {}) {
    if (!files || typeof files.read !== "function") {
      return { ok: false, error: "file-ask has no files-access half wired" };
    }
    const text = String(question == null ? "" : question).trim();
    if (!text) return { ok: false, error: "empty question" };
    if (text.length > MAX_QUESTION) {
      return { ok: false, error: `the question is longer than ${MAX_QUESTION} characters` };
    }
    const name = String(rel == null ? "" : rel);
    if (!name.trim()) return { ok: false, error: "empty file path" };

    const ext = extOf(name);
    if (NO_TEXT_EXTRACTOR.has(ext)) {
      return {
        ok: false,
        reason: "no_text_extractor",
        error: `${name} is a .${ext} file -- Desk has no text extractor for that format. Ask about a text file (txt, md, code, csv, json) instead.`,
      };
    }

    let read;
    try {
      read = files.read(String(root == null ? "" : root), name, { maxBytes: readBytes });
    } catch (error) {
      // Not shared, withheld, missing, or outside the root: files-access's
      // sentence already says how to fix it.
      return { ok: false, error: String((error && error.message) || error) };
    }
    if (read.binary) {
      return {
        ok: false,
        reason: "binary_file",
        error: `${read.rel || name} is binary -- TokenGate reads text files only.`,
      };
    }
    const document = String(read.text == null ? "" : read.text);
    if (!document.trim()) return { ok: false, error: `${read.rel || name} is empty` };

    const payload = { document, question: text };
    const kept = Number(maxKeptTokens);
    if (Number.isFinite(kept) && kept > 0) payload.max_kept_tokens = Math.floor(kept);
    const ev = Number(evidence);
    if (Number.isFinite(ev) && ev > 0) payload.evidence = Math.floor(ev);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.max(1000, Number(timeoutMs) || DEFAULT_TIMEOUT_MS));
    let response;
    try {
      response = await fetchImpl(`${base}/ask`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
    } catch (error) {
      const aborted = error && (error.name === "AbortError" || /aborted/i.test(String(error.message)));
      return {
        ok: false,
        reason: aborted ? "timeout" : "unreachable",
        error: aborted
          ? `TokenGate did not answer within ${Math.round((Number(timeoutMs) || DEFAULT_TIMEOUT_MS) / 1000)}s at ${base}.`
          : `TokenGate is unreachable at ${base} -- is it running? (GET ${base}/health)`,
      };
    } finally {
      clearTimeout(timer);
    }

    let body = null;
    try {
      body = await response.json();
    } catch {
      // an empty/non-JSON body still carries its status; `body` stays null
    }

    if (!response.ok) return refusalFrom(response.status, body);
    if (!body || typeof body.answer !== "string") {
      return {
        ok: false,
        status: response.status,
        reason: "malformed_answer",
        error: "TokenGate answered without an `answer` field -- nothing was shown rather than inventing one.",
      };
    }

    const evidenceList = Array.isArray(body.evidence)
      ? body.evidence.map((e) => ({
        text: String(e && e.text != null ? e.text : ""),
        start: Number.isFinite(Number(e && e.start)) ? Number(e.start) : null,
        end: Number.isFinite(Number(e && e.end)) ? Number(e.end) : null,
        kept: Number.isFinite(Number(e && e.kept)) ? Number(e.kept) : null,
      }))
      : [];

    const reader = typeof body.reader === "string" && body.reader ? body.reader : "tokengate";
    const checkpoint = typeof body.checkpoint === "string" ? body.checkpoint : null;
    // The released gates are task-specific: measured 2026-10-26, 0/24 planted
    // engineering facts were found. Say so on every answer and never present the
    // evidence as an authoritative citation.
    const readerName = reader === "tokengate" ? "TokenGate" : reader;

    return {
      ok: true,
      reader,
      reader_label: `read by ${readerName}${checkpoint ? ` (${checkpoint})` : ""}, experimental`,
      experimental: true,
      answer: body.answer,
      evidence: evidenceList,
      kept_tokens: Number.isFinite(Number(body.kept_tokens)) ? Number(body.kept_tokens) : null,
      state_tokens: Number.isFinite(Number(body.state_tokens)) ? Number(body.state_tokens) : null,
      prefill_ms: Number.isFinite(Number(body.prefill_ms)) ? Number(body.prefill_ms) : null,
      request_ms: Number.isFinite(Number(body.request_ms)) ? Number(body.request_ms) : null,
      model: typeof body.model === "string" ? body.model : null,
      checkpoint,
      question: text,
      file: {
        root: read.root,
        rel: read.rel,
        path: read.path,
        size: read.size,
        truncated: read.truncated === true,
      },
      note: read.truncated === true
        ? `read the first ${readBytes} bytes of ${read.size}; the answer covers only that part`
        : undefined,
    };
  }

  return { ask, askUrl: base };
}

/**
 * One desk MCP files_ask call. Mirrors files-access's agentToolCall so the MCP
 * registration stays a two-liner and a refusal is testable without the SDK.
 */
async function askToolCall(fileAsk, args = {}) {
  const a = args && typeof args === "object" ? args : {};
  let result;
  try {
    result = await fileAsk.ask({
      root: a.root,
      path: a.path,
      question: a.question,
      maxKeptTokens: a.max_kept_tokens,
    });
  } catch (error) {
    result = { ok: false, error: String((error && error.message) || error) };
  }
  return {
    content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
    isError: result.ok !== true,
  };
}

module.exports = {
  createFileAsk,
  askToolCall,
  NO_TEXT_EXTRACTOR,
  DEFAULT_ASK_URL,
  DEFAULT_TIMEOUT_MS,
  MAX_QUESTION,
  READ_BYTES,
};
