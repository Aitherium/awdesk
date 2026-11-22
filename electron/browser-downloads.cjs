"use strict";

/**
 * browser-downloads.cjs -- the Aither Browser's downloads shelf, electron-free.
 *
 * Downloads used to be invisible: the owner's went wherever Electron's save
 * dialog put them, and one an agent triggered was cancelled with no trace (the
 * right call -- an agent must not land files on the owner's disk unseen -- but a
 * silent cancel reads as "the download button is broken"). Every download is now
 * a row: in progress, done (with where it went), failed, or "blocked: an agent
 * started it", which the owner can redo themselves by taking over.
 *
 * aither://downloads is the same shelf as a page: a row can be removed from the list
 * (the file stays on disk), and a download that did not finish can be asked for again.
 */

const MAX_ROWS = 50;
const STATES = Object.freeze(["progressing", "completed", "cancelled", "interrupted", "blocked"]);

function createDownloads({ now = () => Date.now() } = {}) {
  let rows = [];
  let nextId = 1;

  function start({ filename = "", url = "", total = 0, blocked = false } = {}) {
    const row = {
      id: nextId++,
      filename: String(filename || "download").slice(0, 200),
      url: String(url || "").slice(0, 500),
      state: blocked ? "blocked" : "progressing",
      received: 0,
      total: Math.max(0, Number(total) || 0),
      path: "",
      at: now(),
    };
    rows.unshift(row);
    if (rows.length > MAX_ROWS) rows.length = MAX_ROWS;
    return row.id;
  }

  function update(id, patch = {}) {
    const row = rows.find((r) => r.id === id);
    if (!row || row.state === "blocked") return false;
    if (patch.state != null && STATES.includes(patch.state)) row.state = patch.state;
    if (patch.received != null) row.received = Math.max(0, Number(patch.received) || 0);
    if (patch.total != null) row.total = Math.max(0, Number(patch.total) || 0);
    if (patch.path != null) row.path = String(patch.path).slice(0, 1000);
    return true;
  }

  function list() {
    return rows.map((r) => ({ ...r }));
  }

  function clearFinished() {
    rows = rows.filter((r) => r.state === "progressing");
  }

  function get(id) {
    const row = rows.find((r) => r.id === id);
    return row ? { ...row } : null;
  }

  /** Take one row off the list (never the file). A download still running stays. */
  function remove(id) {
    const row = rows.find((r) => r.id === id);
    if (!row || row.state === "progressing") return false;
    rows = rows.filter((r) => r.id !== id);
    return true;
  }

  /** Can this row be asked for again? Anything with a web address that is not done or running. */
  function retryable(id) {
    const row = rows.find((r) => r.id === id);
    return Boolean(row && /^https?:\/\//i.test(row.url) && ["cancelled", "interrupted", "blocked"].includes(row.state));
  }

  return { clearFinished, get, list, remove, retryable, start, update };
}

module.exports = { MAX_ROWS, STATES, createDownloads };
