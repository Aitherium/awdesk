"use strict";

/**
 * agent-update — tell the person when their local Aither agent (awdk, and any other
 * installed brick) needs an update, and update them all from one notice.
 *
 * Owner, 2026-10-25: a fix shipped to PyPI (awdk 3.8.92) reached nobody on their own
 * machine -- the Settings > Bricks page could upgrade it, but nothing said there was
 * anything to upgrade. This module only ASKS `adk bricks list` and shows one notice;
 * the click runs `adk bricks upgrade <id>` for each brick, which awdk already makes
 * safe: it tests after the upgrade and rolls back on a failed test. A second
 * implementation of that logic here would drift from the CLI.
 *
 * Owner, 2026-11-14: "why does desk only ever prompt me to update awgraph, not any of
 * the other software/bricks?" Every row with `editable: true` was dropped, and on a
 * developer machine almost every brick is an editable install, so only awgraph ever
 * qualified -- while the editable ones sat half-updated (awkno's tree 0.2.9 under
 * 0.2.1 metadata). awdk now gives editable rows a `state`; a `refresh` row (tree newer
 * than its metadata) is offered here too, and `adk bricks upgrade` re-runs
 * `pip install -e` for it. A tree that is BEHIND the index or missing is never
 * replaced from the desk (that would swap a developer's checkout for a wheel); the
 * notice only counts it and points at Settings > Bricks.
 *
 * Pure: every effect (listing, upgrading, notifying, the clock, the seen-store) is
 * injected, so the test drives it with no Electron and no subprocess.
 */

const SIX_HOURS = 6 * 60 * 60 * 1000;
const FIRST_CHECK_MS = 2 * 60 * 1000;
/** The agent itself first; the rest of the installed bricks after it. */
const PRIMARY = "awdk";
/** Editable states the desk reports but does not act on. */
const SOURCE_SYNC = new Set(["tree-behind-index", "tree-missing"]);

/** "index" (a released wheel is newer), "refresh" (an editable tree is newer than its
 *  metadata), or null when the desk has nothing to run for this row. */
function kindOf(r) {
  if (!r || !r.installed) return null;
  if (r.state === "refresh" && r.tree) return "refresh";
  if (r.outdated === true && r.editable !== true && r.latest && !r.error) return "index";
  return null;
}

/** The version a row goes to. */
function targetOf(r) {
  return kindOf(r) === "refresh" ? r.tree : r.latest;
}

/** Rows worth a notice: an index update or an editable refresh, the agent first. */
function updatable(rows) {
  const list = Array.isArray(rows) ? rows : [];
  const out = list.filter((r) => kindOf(r) !== null);
  out.sort((a, b) => (a.id === PRIMARY ? -1 : b.id === PRIMARY ? 1 : 0));
  return out;
}

/** Editable rows whose source needs a sync the desk will not do itself. */
function needsSourceSync(rows) {
  return (Array.isArray(rows) ? rows : []).filter((r) => r && r.editable === true && SOURCE_SYNC.has(r.state));
}

/** The notice for a set of updatable rows, or null. Plain words, no emoji. */
function noticeFor(rows, { behind = 0 } = {}) {
  if (!rows.length) return null;
  const top = rows[0];
  const agent = top.id === PRIMARY;
  const more = rows.length - 1;
  const refreshes = rows.filter((r) => kindOf(r) === "refresh").length;
  const ids = rows.map((r) => r.id);
  const key = rows.map((r) => `${r.id}@${targetOf(r)}`).join(",");
  let title;
  if (rows.length === 1) {
    title = agent
      ? `Aither agent update ready (${top.installed} -> ${targetOf(top)})`
      : kindOf(top) === "refresh"
        ? `${top.id} needs a refresh (${top.installed} -> ${targetOf(top)})`
        : `Update ready: ${top.id} ${targetOf(top)}`;
  } else {
    const noun = refreshes === rows.length ? "need a refresh" : "need an update";
    title = agent
      ? `Aither agent update ready, and ${more} more brick${more === 1 ? "" : "s"}`
      : `${rows.length} bricks ${noun}`;
  }
  const what = rows.length === 1
    ? (agent ? "Click to update your local agent." : "Click to update it.")
    : `Click to update all ${rows.length} (${ids.slice(0, 4).join(", ")}${rows.length > 4 ? ", ..." : ""}).`;
  const safety = " Each is tested afterwards; a failed update is rolled back.";
  const sync = behind > 0
    ? ` ${behind} more need${behind === 1 ? "s" : ""} a source sync: see Settings > Bricks.`
    : "";
  return { id: top.id, ids, version: targetOf(top), key, title, body: what + safety + sync };
}

function createAgentUpdateNotices({
  listBricks,
  actOnBrick,
  notify,
  allowed = () => true,
  seen = new Map(),
  intervalMs = SIX_HOURS,
  firstCheckMs = FIRST_CHECK_MS,
  setTimer = setTimeout,
  log = () => {},
} = {}) {
  let timer = null;
  let busy = false;

  async function runOne(id) {
    try {
      const res = await actOnBrick("upgrade", id);
      return res || { ok: false, error: "no answer from adk bricks" };
    } catch (e) {
      return { ok: false, error: String((e && e.message) || e) };
    }
  }

  async function upgrade(id) {
    if (busy) return { ok: false, error: "an update is already running" };
    busy = true;
    try {
      const res = await runOne(id);
      const ok = !!(res && res.ok);
      notify({
        title: ok ? `${id === PRIMARY ? "Aither agent" : id} updated` : `${id} update did not finish`,
        body: ok
          ? "Updated and tested. The local agent picks it up the next time it restarts."
          : `Nothing changed: ${String((res && res.error) || "the update failed and was rolled back").slice(0, 160)}`,
      });
      return res;
    } finally {
      busy = false;
    }
  }

  /** One click, every brick: one at a time (pip is not parallel-safe), one summary. */
  async function upgradeAll(ids) {
    const list = (Array.isArray(ids) ? ids : []).filter(Boolean);
    if (list.length <= 1) return list.length ? upgrade(list[0]) : { ok: true, results: [] };
    if (busy) return { ok: false, error: "an update is already running" };
    busy = true;
    try {
      const results = [];
      for (const id of list) results.push({ id, ...(await runOne(id)) });
      const failed = results.filter((r) => !r.ok);
      const done = results.length - failed.length;
      notify({
        title: failed.length ? `${done} of ${results.length} bricks updated` : `${done} bricks updated`,
        body: failed.length
          ? `Did not finish: ${failed.map((r) => `${r.id} (${String(r.error || "failed").slice(0, 60)})`).join("; ").slice(0, 220)}`
          : "Updated and tested. Running agents pick it up the next time they restart.",
      });
      return { ok: failed.length === 0, results };
    } finally {
      busy = false;
    }
  }

  /** One check. Resolves the notice it showed, or null. Never throws. */
  async function check() {
    if (!allowed()) return null;
    let res;
    try {
      res = await listBricks();
    } catch (e) {
      log(`agent-update: list failed: ${e && e.message}`);
      return null;
    }
    if (!res || !res.ok) return null;
    const note = noticeFor(updatable(res.data), { behind: needsSourceSync(res.data).length });
    if (!note) return null;
    if (seen.get("bricks") === note.key) return null; // once per set of versions
    seen.set("bricks", note.key);
    notify({ title: note.title, body: note.body, click: () => void upgradeAll(note.ids) });
    log(`agent-update: offered ${note.key}`);
    return note;
  }

  function schedule(ms) {
    timer = setTimer(async () => {
      await check();
      schedule(intervalMs);
    }, ms);
    if (timer && typeof timer.unref === "function") timer.unref();
  }

  return {
    check,
    upgrade,
    upgradeAll,
    start() { schedule(firstCheckMs); },
    stop() { if (timer) clearTimeout(timer); timer = null; },
  };
}

module.exports = { createAgentUpdateNotices, updatable, noticeFor, needsSourceSync, kindOf, PRIMARY };
