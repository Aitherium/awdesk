"use strict";

/**
 * knowledge-client.cjs -- your notes and memory beside what you browse (owner,
 * 2026-10-04: "AitherOne folded in naturally for knowledge base / notes connected to
 * your web browsing").
 *
 * All through the gateway's existing tools, nothing stored by the desk:
 *   notes      notes_add / notes_search / notes_list / notes_view  (your notes)
 *   memory     remember / recall                                    (long-term memory)
 *   wiki       wiki_search                                          (shown only when it answers)
 *
 * The side panel's Notes tab asks related(page) on every page change: notes and
 * memories that match what is on screen. "Save page" and "Remember" write the page's
 * title, address and your selection -- never page text you did not select.
 *
 * callTool is injected, so every verb is asserted under node --test.
 */

const MAX_QUERY = 160;
const MAX_TEXT = 4000;

function parse(raw) {
  if (raw && typeof raw === "object") return raw;
  try { return JSON.parse(String(raw || "")); } catch { return null; }
}

function clip(text, n) {
  const t = String(text == null ? "" : text).replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
}

/** Words worth searching for from a page title: drop the site suffix ("— Reddit"). */
function queryFromPage({ title = "", url = "" } = {}) {
  let q = String(title || "").split(/\s[|\-–—·]\s/)[0].trim();
  if (q.length < 3) {
    try { q = new URL(url).hostname.replace(/^www\./, ""); } catch { q = ""; }
  }
  return clip(q, MAX_QUERY);
}

function noteRow(n) {
  if (!n || typeof n !== "object") return null;
  const id = String(n.id || n.note_id || "");
  if (!id) return null;
  return { id, title: clip(n.title || "(untitled)", 140), snippet: clip(n.content || n.body || n.snippet || "", 220),
    type: String(n.note_type || n.type || "note"), updated: n.updated_at || n.updated || null };
}

function memoryRow(m) {
  if (!m || typeof m !== "object" || !m.content) return null;
  return { id: String(m.id || ""), text: clip(m.content, 300), category: String(m.category || ""),
    score: Number.isFinite(Number(m.score)) ? Number(m.score) : null };
}

function createKnowledgeClient({ callTool = (...a) => require("./gateway-mcp.cjs").callTool(...a) } = {}) {
  const call = async (name, args) => {
    try {
      return { ok: true, data: parse(await callTool(name, args)) };
    } catch (error) {
      return { ok: false, error: String((error && error.message) || error) };
    }
  };

  /** Notes and memories that match the page on screen. Each half fails alone. */
  async function related(page = {}) {
    const query = queryFromPage(page);
    if (!query) return { ok: true, query, notes: [], memories: [] };
    const [n, m] = await Promise.all([
      call("notes_search", { query, limit: 5 }),
      call("recall", { query, limit: 5 }),
    ]);
    const notes = n.ok && n.data ? (n.data.matches || n.data.notes || []).map(noteRow).filter(Boolean) : [];
    const memories = m.ok && m.data && m.data.success !== false ? (m.data.memories || []).map(memoryRow).filter(Boolean) : [];
    return { ok: true, query, notes, memories,
      errors: [n.ok ? null : `notes: ${n.error}`, m.ok ? null : `memory: ${m.error}`].filter(Boolean) };
  }

  /** A note for this page: its title, its address, and what you selected (if anything). */
  async function savePage({ title = "", url = "", selection = "", comment = "" } = {}) {
    if (!/^https?:\/\//i.test(String(url))) return { ok: false, error: "only a web page can be saved" };
    const body = [String(url), clip(comment, MAX_TEXT), selection ? `> ${clip(selection, MAX_TEXT)}` : ""]
      .filter(Boolean).join("\n\n");
    const r = await call("notes_add", { title: clip(title || url, 140), content: body, note_type: "note" });
    if (!r.ok) return r;
    if (r.data && r.data.error) return { ok: false, error: String(r.data.error) };
    return { ok: true, note: noteRow(r.data && (r.data.note || r.data)) };
  }

  /** Long-term memory: the text you chose, with where it came from. */
  async function rememberText({ text = "", title = "", url = "" } = {}) {
    const t = clip(text, MAX_TEXT);
    if (!t) return { ok: false, error: "select some text, or type what to remember" };
    const source = /^https?:\/\//i.test(String(url)) ? `\n\nSource: ${clip(title, 140)} ${url}` : "";
    const r = await call("remember", { content: t + source, category: "browsing", tags: ["browser"], memory_type: "semantic" });
    if (!r.ok) return r;
    if (r.data && r.data.success === false) return { ok: false, error: String(r.data.error || "memory refused it") };
    return { ok: true };
  }

  async function listNotes({ query = "", limit = 50 } = {}) {
    const q = clip(query, MAX_QUERY);
    const r = q ? await call("notes_search", { query: q, limit }) : await call("notes_list", { limit, include_done: true });
    if (!r.ok) return r;
    const rows = (r.data && (r.data.matches || r.data.notes)) || [];
    return { ok: true, notes: rows.map(noteRow).filter(Boolean), store: r.data && r.data.store };
  }

  async function viewNote(id) {
    if (!/^[A-Za-z0-9_-]{1,80}$/.test(String(id || ""))) return { ok: false, error: "bad note id" };
    const r = await call("notes_view", { note_id: String(id) });
    if (!r.ok) return r;
    const n = (r.data && (r.data.note || r.data)) || {};
    return { ok: true, note: { ...noteRow({ id, ...n }), content: String(n.content || ""), items: Array.isArray(n.items) ? n.items : [] } };
  }

  async function addNote({ title = "", content = "" } = {}) {
    const t = clip(title, 140);
    if (!t && !String(content).trim()) return { ok: false, error: "a note needs a title or some text" };
    const r = await call("notes_add", { title: t || clip(content, 60), content: String(content).slice(0, 20000), note_type: "note" });
    if (!r.ok) return r;
    return r.data && r.data.error ? { ok: false, error: String(r.data.error) } : { ok: true };
  }

  async function searchMemory(query) {
    const q = clip(query, MAX_QUERY);
    if (!q) return { ok: false, error: "type what to look for" };
    const r = await call("recall", { query: q, limit: 15 });
    if (!r.ok) return r;
    return { ok: true, memories: ((r.data && r.data.memories) || []).map(memoryRow).filter(Boolean) };
  }

  return { related, savePage, rememberText, listNotes, viewNote, addNote, searchMemory };
}

module.exports = { createKnowledgeClient, memoryRow, noteRow, queryFromPage };
