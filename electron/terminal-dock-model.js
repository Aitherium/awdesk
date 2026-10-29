/* terminal-dock-model.js -- the pure half of the terminal dock (aither://terminal/?dock=1).
   Loaded by terminal.html as a plain script (window.TerminalDockModel) and by
   terminal-client.test.cjs in a vm context, so the list logic is asserted under node --test.

   The dock MIRRORS the daemon: every session the awsh daemon runs -- started from this
   window, another window, `awsh` on the CLI or MCP awsh_spawn -- is a tab in its strip.
   Nothing is mirrored that the daemon does not own: a pty we did not start is not ours. */
/* global self */
(function (root, factory) {
  "use strict";
  root.TerminalDockModel = factory();
})(self, function () {
  "use strict";

  /** How often the dock re-reads the daemon's session list. */
  const POLL_MS = 3000;

  function live(s) {
    return Boolean(s) && s.state !== "exited";
  }

  /** Sessions still running. */
  function runningCount(sessions) {
    return (sessions || []).filter(live).length;
  }

  /**
   * The strip's order: running before exited, then oldest first, so a tab does not jump
   * when another one starts. Exited sessions stay only while a tab still shows them.
   */
  function stripOrder(sessions, open) {
    const keep = open instanceof Set ? open : new Set(open || []);
    return (sessions || [])
      .filter((s) => s && s.id && (live(s) || keep.has(s.id)))
      .slice()
      .sort((a, b) => (live(b) - live(a)) || ((a.createdAt || 0) - (b.createdAt || 0)) || String(a.id).localeCompare(String(b.id)));
  }

  /**
   * What changed between two reads of the daemon's list (each an array of tab rows).
   * `changed` = same id, different state or label -- the strip re-renders only then.
   */
  function diffSessions(prev, next) {
    const before = new Map((prev || []).map((s) => [s.id, s]));
    const after = new Map((next || []).map((s) => [s.id, s]));
    const added = [];
    const changed = [];
    const removed = [];
    for (const [id, s] of after) {
      const old = before.get(id);
      if (!old) added.push(id);
      else if (old.state !== s.state || old.label !== s.label) changed.push(id);
    }
    for (const id of before.keys()) if (!after.has(id)) removed.push(id);
    return { added, changed, removed, same: !added.length && !changed.length && !removed.length };
  }

  /** The collapsed strip's summary: "3 running", "no sessions", "daemon offline". */
  function summary(sessions, { daemonUp = true } = {}) {
    if (!daemonUp) return "awsh daemon offline";
    const n = runningCount(sessions);
    if (!n) return (sessions || []).length ? "no sessions running" : "no sessions";
    return n === 1 ? "1 running" : `${n} running`;
  }

  /** External Claude tabs worth offering to resume: not already a daemon tab, newest first. */
  function resumeChoices(external, sessions, limit = 8) {
    const mine = new Set((sessions || []).map((s) => s.id));
    return (external || [])
      .filter((x) => x && x.id && !mine.has(x.id))
      .slice()
      .sort((a, b) => (b.lastActivityAt || 0) - (a.lastActivityAt || 0))
      .slice(0, limit);
  }

  return { POLL_MS, diffSessions, resumeChoices, runningCount, stripOrder, summary };
});
