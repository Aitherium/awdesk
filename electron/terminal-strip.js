/* global window, module */
/* aither://terminal — how the tab strip folds the daemon's sessions.

   The owner's screen had twelve chips reading "resumed: credential stored": one
   session per row, none of them saying which task was continuing, so the strip
   could not be used to pick one. Grouping identical labels turns that wall into
   ONE chip with a "+11" — the same information in one slot.

   Presentation only: every session id stays in `ids`, so folding never drops a
   tab, and the strip caps at `cap` groups rather than growing without limit.

   Plain script (no DOM, no bundler): the page reads window.TerminalStrip, and
   the node test requires the module.exports tail. */
(function (root) {
  "use strict";

  var DEFAULT_CAP = 5;

  /**
   * @param {Array<{info?: {id?: string, label?: string}}>} tabs
   * @param {(tab: any) => string} [key] label to group by (default: tab.info.label)
   * @param {number} [cap] most groups the strip shows at once
   * @returns {Array<{label: string, ids: string[], count: number, hidden: number, overflow: boolean}>}
   *   `count` is the real number of sessions in the group; `hidden` is how many
   *   of them the single chip stands in for; `ids` is every one of them, in order;
   *   `overflow` marks the synthetic "+N" chip, which the page turns into a
   *   "show the rest" action rather than a session.
   */
  function groupTabs(tabs, key, cap) {
    var list = Array.isArray(tabs) ? tabs : [];
    var keyOf = typeof key === "function" ? key : function (tab) { return tab && tab.info ? tab.info.label : ""; };
    var limit = Number.isFinite(cap) && cap > 0 ? Math.floor(cap) : DEFAULT_CAP;

    var groups = [];
    var byLabel = new Map();
    for (var i = 0; i < list.length; i += 1) {
      var tab = list[i];
      var label = String(keyOf(tab) || "").trim() || "untitled";
      var group = byLabel.get(label);
      if (!group) {
        group = { label: label, ids: [], count: 0, hidden: 0, overflow: false };
        byLabel.set(label, group);
        groups.push(group);
      }
      var id = String((tab && tab.info && tab.info.id) || (tab && tab.id) || "");
      if (id && group.ids.indexOf(id) < 0) {
        group.ids.push(id);
        group.count += 1;
      }
    }

    // One chip stands for the whole group: everything past the first is folded.
    for (var g = 0; g < groups.length; g += 1) {
      groups[g].hidden = groups[g].count > 1 ? groups[g].count - 1 : 0;
    }

    if (groups.length <= limit) return groups;

    // Keep the strip at `cap` slots: the first slots are real groups, the last
    // is the "+N more groups" affordance, and its ids stay reachable.
    var head = groups.slice(0, limit - 1);
    var rest = groups.slice(limit - 1);
    var ids = [];
    for (var r = 0; r < rest.length; r += 1) ids = ids.concat(rest[r].ids);
    head.push({ label: "+" + rest.length, ids: ids, count: ids.length, hidden: 0, overflow: true });
    return head;
  }

  var api = { groupTabs: groupTabs, DEFAULT_CAP: DEFAULT_CAP };
  // The page's real interface is the global (a classic <script> cannot export).
  // `module.exports` is offered too, for a CommonJS loader; the package is
  // "type": "module", so Node classifies this file as ESM and hands it a
  // DETACHED `module` — which is exactly why the global is set unconditionally
  // rather than in an else-branch the test would then never see.
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.TerminalStrip = api;
}(typeof window !== "undefined" ? window : globalThis));
