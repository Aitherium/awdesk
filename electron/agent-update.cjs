"use strict";

/**
 * agent-update — tell the person when their local Aither agent (awdk, and any other
 * installed brick) has a newer version, and update it from the notice.
 *
 * Owner, 2026-10-25: a fix shipped to PyPI (awdk 3.8.92) reached nobody on their own
 * machine -- the Settings > Bricks page could upgrade it, but nothing said there was
 * anything to upgrade. This module only ASKS `adk bricks list` and shows one notice per
 * new version; the click runs `adk bricks upgrade <id>`, which awdk already makes safe:
 * it refuses an editable checkout, tests after the upgrade and rolls back on a failed
 * test. A second implementation of that logic here would drift from the CLI.
 *
 * Pure: every effect (listing, upgrading, notifying, the clock, the seen-store) is
 * injected, so the test drives it with no Electron and no subprocess.
 */

const SIX_HOURS = 6 * 60 * 60 * 1000;
const FIRST_CHECK_MS = 2 * 60 * 1000;
/** The agent itself first; the rest of the installed bricks after it. */
const PRIMARY = "awdk";

/** Rows worth a notice: outdated, installed from the index (never an editable tree). */
function updatable(rows) {
  const list = Array.isArray(rows) ? rows : [];
  const out = list.filter((r) => r && r.outdated === true && r.editable !== true
    && r.installed && r.latest && !r.error);
  out.sort((a, b) => (a.id === PRIMARY ? -1 : b.id === PRIMARY ? 1 : 0));
  return out;
}

/** The notice for a set of updatable rows, or null. Plain words, no emoji. */
function noticeFor(rows) {
  if (!rows.length) return null;
  const top = rows[0];
  const agent = top.id === PRIMARY;
  const more = rows.length - 1;
  const title = agent
    ? `Aither agent update ready (${top.installed} -> ${top.latest})`
    : `Update ready: ${top.id} ${top.latest}`;
  const body = (agent
    ? "Click to update your local agent. It tests itself afterwards and rolls back if anything breaks."
    : "Click to update it. It is tested after the update and rolled back if the test fails.")
    + (more > 0 ? ` ${more} more update${more === 1 ? "" : "s"} in Settings > Bricks.` : "");
  return { id: top.id, version: top.latest, title, body };
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

  async function upgrade(id) {
    if (busy) return { ok: false, error: "an update is already running" };
    busy = true;
    try {
      const res = await actOnBrick("upgrade", id);
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
    const note = noticeFor(updatable(res.data));
    if (!note) return null;
    if (seen.get(note.id) === note.version) return null; // once per version
    seen.set(note.id, note.version);
    notify({ title: note.title, body: note.body, click: () => void upgrade(note.id) });
    log(`agent-update: offered ${note.id} ${note.version}`);
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
    start() { schedule(firstCheckMs); },
    stop() { if (timer) clearTimeout(timer); timer = null; },
  };
}

module.exports = { createAgentUpdateNotices, updatable, noticeFor, PRIMARY };
