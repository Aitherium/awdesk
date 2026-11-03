"use strict";

/**
 * spirit-ops — the spirit's transports, with every runner injected.
 *
 * Nothing here is re-implemented: the spirit is a THIN caller of what the desk
 * already owns.
 *   findFiles    universal-search.cjs (`search-window.universal().run`, the
 *                Alt+Space search: Windows Search index, then a bounded walk)
 *   webSearch    search-client.cjs (`awfind --json q|answer`, AitherSearch)
 *   readFile     file-ask.cjs (TokenGate reads the document and returns an
 *                answer with offsets; a PDF is refused by name, never garbled)
 *   listFolder   fs, names only — a listing is not a read
 *
 * The one rule this file adds is the CREDENTIAL REFUSAL: a path that looks like
 * a key, an env file or a session bearer never reaches a transport. The check is
 * spirit-core.secretPathReason (pure, tested there) and it runs BEFORE the read.
 *
 * Fail-soft contract as everywhere on the desk: every function resolves a
 * verdict ({ok:false, reason, line}), never throws.
 */

const fs = require("node:fs");
const path = require("node:path");

const spiritCore = require("./spirit-core.cjs");

const DEFAULT_READ_QUESTION = "Summarize this file in 3-4 short sentences: say what it is, what it is for, and the parts that matter. Quote any names or numbers you rely on.";
const MAX_FOLDER_ROWS = 12;

function reasonOf(error) {
  return String((error && error.message) || error || "no reason was given");
}

/**
 * The `files` half file-ask expects, over ONE absolute path the owner (or a
 * search result) named. It is the same shape files-access returns; the
 * confinement that page has does not apply here because the owner dropped or
 * asked for THIS file, and the credential check above it is what protects.
 */
function createDirectFiles({ fsImpl = fs } = {}) {
  function read(root, rel, { maxBytes = 100000 } = {}) {
    const name = String(rel == null ? "" : rel);
    const full = path.isAbsolute(name) ? name : path.join(String(root || ""), name);
    const secret = spiritCore.secretPathReason(full);
    if (secret) throw new Error(secret.line);
    let stat;
    try {
      stat = fsImpl.statSync(full);
    } catch {
      throw new Error(`${full} could not be read (missing, or not yours to read)`);
    }
    if (!stat.isFile()) throw new Error(`${full} is not a file`);
    const limit = Math.max(1, Number(maxBytes) || 100000);
    let buffer;
    try {
      const fd = fsImpl.openSync(full, "r");
      try {
        const size = Math.min(stat.size, limit);
        buffer = Buffer.alloc(size);
        fsImpl.readSync(fd, buffer, 0, size, 0);
      } finally {
        try { fsImpl.closeSync(fd); } catch { /* already closed */ }
      }
    } catch (error) {
      throw new Error(`${full} could not be read: ${reasonOf(error)}`, { cause: error });
    }
    const binary = buffer.includes(0);
    return {
      root: path.dirname(full),
      rel: path.basename(full),
      path: full,
      size: stat.size,
      truncated: stat.size > limit,
      binary,
      text: binary ? "" : buffer.toString("utf8"),
    };
  }
  return { read };
}

function createSpiritOps({
  universal = null,
  searchClient = null,
  fileAsk = null,
  files = null,
  fsImpl = fs,
} = {}) {
  const directFiles = files || createDirectFiles({ fsImpl });

  function getFileAsk() {
    if (fileAsk) return fileAsk;
    try {
      return require("./file-ask.cjs").createFileAsk({ files: directFiles });
    } catch (error) {
      return { ask: async () => ({ ok: false, error: `file-ask is unavailable: ${reasonOf(error)}` }) };
    }
  }

  /** The desk's own file finder. Resolves the pick list (top five + N more). */
  async function findFiles(query) {
    const q = String(query == null ? "" : query).trim();
    if (!q) return { ok: false, reason: "type something to find", rows: [], more: 0, total: 0 };
    if (!universal) return { ok: false, reason: "the desk's universal search is not wired", rows: [], more: 0, total: 0 };
    let run;
    try {
      const u = typeof universal === "function" ? universal() : universal;
      run = await u.run(q, { phase: "all" });
    } catch (error) {
      return { ok: false, reason: reasonOf(error), rows: [], more: 0, total: 0 };
    }
    return spiritCore.fileRows(run);
  }

  /** A web search (AitherSearch through awfind). `answer` reads pages and cites them. */
  async function webSearch(query, { answer = false, limit = 12 } = {}) {
    const q = String(query == null ? "" : query).trim();
    if (!q) return { ok: false, reason: "type something to search for", line: "1 search refused — type something to search for", rows: [], more: 0, total: 0 };
    // A provider may be the client itself or a lazy factory (main wires the
    // factory so awfind is discovered only when the owner first searches).
    const client = typeof searchClient === "function" ? searchClient() : searchClient;
    if (!client) return { ok: false, reason: "web search is not wired", rows: [], more: 0, total: 0 };
    let result;
    try {
      result = await client.search(answer ? "answer" : "q", q, { limit });
    } catch (error) {
      result = { ok: false, error: reasonOf(error) };
    }
    if (!result || result.ok === false) {
      const reason = String((result && (result.error || result.reason)) || "the web search did not answer");
      return { ok: false, reason, line: `1 search refused — ${reason}`, rows: [], more: 0, total: 0 };
    }
    return spiritCore.webRows(result, { limit: Math.max(1, Math.min(5, Number(limit) || 5)) });
  }

  /** Read a held web page through the same answer path a web query uses. */
  async function readWeb(url, question = null) {
    const target = String(url == null ? "" : url).trim();
    if (!/^https?:\/\//i.test(target)) return { ok: false, reason: "that is not a web address" };
    const asked = question ? `${target}\n\n${String(question).slice(0, 800)}` : target;
    const r = await webSearch(asked, { answer: true, limit: 5 });
    if (!r.ok) return { ok: false, reason: r.reason, line: r.line };
    if (!r.answer) {
      return {
        ok: false,
        reason: "awfind read no answer for that page",
        line: "1 page refused — awfind returned no answer for it",
        rows: r.rows,
      };
    }
    return { ok: true, answer: r.answer, rows: r.rows };
  }

  /**
   * Read a file with file-ask (TokenGate). A credential is refused before the
   * bytes are opened; a PDF and a binary get file-ask's own sentence.
   */
  async function readFile(filePath, question = null) {
    const full = String(filePath == null ? "" : filePath);
    const secret = spiritCore.secretPathReason(full);
    if (secret) return { ok: false, refused: true, reason: secret.reason, line: secret.line };
    if (!full) return { ok: false, reason: "no file was named" };
    let stat;
    try {
      stat = fsImpl.statSync(full);
    } catch {
      return { ok: false, reason: `${full} is not there any more` };
    }
    if (!stat.isFile()) return { ok: false, reason: `${full} is not a file` };
    const answer = await getFileAsk().ask({
      root: path.dirname(full),
      path: path.basename(full),
      question: String(question || DEFAULT_READ_QUESTION),
    });
    if (!answer || answer.ok !== true) {
      return {
        ok: false,
        reason: String((answer && (answer.error || answer.reason)) || "the file could not be read"),
        line: String((answer && answer.error) || "the file could not be read"),
      };
    }
    return {
      ok: true,
      answer: answer.answer,
      evidence: answer.evidence || [],
      reader: answer.reader,
      note: answer.note || null,
      file: answer.file || { path: full, size: stat.size },
    };
  }

  /** A folder's names, never its files' contents. */
  async function listFolder(dirPath) {
    const full = String(dirPath == null ? "" : dirPath);
    const secret = spiritCore.secretPathReason(full);
    if (secret) return { ok: false, refused: true, reason: secret.reason, line: secret.line };
    let entries;
    try {
      entries = fsImpl.readdirSync(full, { withFileTypes: true });
    } catch (error) {
      return { ok: false, reason: `${full} could not be listed: ${reasonOf(error)}` };
    }
    const rows = entries.slice(0, MAX_FOLDER_ROWS).map((e) => ({
      kind: e.isDirectory() ? "folder" : "file",
      title: e.name,
      subtitle: e.isDirectory() ? "folder" : "",
      target: path.join(full, e.name),
    }));
    return { ok: true, path: full, rows, total: entries.length, more: Math.max(0, entries.length - rows.length) };
  }

  return { findFiles, webSearch, readWeb, readFile, listFolder, directFiles, getFileAsk };
}

module.exports = {
  DEFAULT_READ_QUESTION, MAX_FOLDER_ROWS, createDirectFiles, createSpiritOps,
};
