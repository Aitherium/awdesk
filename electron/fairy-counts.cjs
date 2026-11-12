"use strict";

/**
 * fairy-counts -- ONE place that counts the cards the fairy shows.
 *
 * Owner, 2026-11-12, four numbers on screen at once: "Why do the fairy counts not
 * match the one in my current desktop?" Measured that day, one queue, 33 open cards:
 *
 *   where                      what it counted                              showed
 *   card panel header          every open card (reports included)           33
 *   terminal status line       every open card                              33
 *   orb badge                  unread orb answers + owner-only blockers     1
 *   whisper "N more waiting"   cards due a nudge (not stale, muted, no-op)  24 -> "23 more"
 *   a click's whisper          the fairy's cards minus one                  30
 *   companion badge            that agent's cards                           12, 7, 3, ...
 *
 * None was wrong for what it counted; no two were labelled, and three claimed to be
 * the same thing. The rule this module holds, and its test pins:
 *
 *   needYou   = the decision cards handed to the fairy (reports are not "need you")
 *   badge     = needYou                      the orb's number IS the queue's number
 *   more      = needYou - 1                  the whisper shows one; the rest are "more"
 *   perAgent  = that agent's share of needYou; the shares sum to needYou
 *   open      = needYou + reports            what the panel and the status line print
 *
 * The queue is the machine's, not a workspace's: switching to a customer workspace
 * changes the site the desk shows, never which cards wait. `scope` says so.
 */

const SCOPE = "all workspaces";

function listOf(cards) {
  return Array.isArray(cards) ? cards.filter((c) => c && typeof c.id === "string") : [];
}

/**
 * `decisions`: the cards the fairy carries (decision-cards.partitionCards().decisions).
 * `open`: every open card (omit when unknown: reports then reads 0 and `open` = needYou).
 * `agentOf(card)`: who a card is from (agent-fairy.cardAgent); "" = nobody's.
 * `blockers`: the needs-you strip (credential / blocked) -- a subset, never added on top.
 * `unread`: orb answers not yet read; a different thing, reported beside, never summed.
 */
function fairyCounts({ decisions, open = null, agentOf = null, worn = "", blockers = 0, unread = 0 } = {}) {
  const list = listOf(decisions);
  const ids = new Set(list.map((c) => c.id));
  const all = open == null ? list : listOf(open);
  const reports = all.filter((c) => !ids.has(c.id)).length;
  const perAgent = {};
  let unowned = 0;
  for (const card of list) {
    const key = typeof agentOf === "function" ? String(agentOf(card) || "") : "";
    if (!key) { unowned += 1; continue; }
    perAgent[key] = (perAgent[key] || 0) + 1;
  }
  const needYou = list.length;
  const wornKey = String(worn || "");
  return {
    needYou,
    badge: needYou,
    more: Math.max(0, needYou - 1),
    reports,
    open: needYou + reports,
    perAgent,
    unowned,
    worn: wornKey,
    wornCount: wornKey ? perAgent[wornKey] || 0 : 0,
    blockers: Math.min(needYou, Math.max(0, Math.floor(Number(blockers) || 0))),
    unread: Math.max(0, Math.floor(Number(unread) || 0)),
    scope: SCOPE,
  };
}

/** The whisper's "N more" for a card being shown: everything else that needs the owner. */
function moreAfter(decisions, shownId = "") {
  const list = listOf(decisions);
  const shown = shownId && list.some((c) => c.id === shownId) ? 1 : (list.length ? 1 : 0);
  return Math.max(0, list.length - shown);
}

/** What the orb badge says on hover: the number, what it is, and its scope. */
function badgeTitle(counts) {
  const c = counts || {};
  const n = Number(c.needYou) || 0;
  const parts = [`${n} need${n === 1 ? "s" : ""} you`];
  if (c.reports) parts.push(`${c.reports} report${c.reports === 1 ? "" : "s"}`);
  if (c.unread) parts.push(`${c.unread} answer${c.unread === 1 ? "" : "s"} to read`);
  return `${parts.join(" · ")} · ${c.scope || SCOPE}`;
}

/** The queue window's header: the same number, named, with its scope. */
function queueHeader(counts, { shown = null } = {}) {
  const c = counts || {};
  const n = Number(c.needYou) || 0;
  const head = shown != null && shown !== n ? `${shown} of ${n}` : String(n);
  return `${head} need${n === 1 && shown == null ? "s" : ""} you · ${c.scope || SCOPE}`;
}

/** Every identity that must hold; [] when they all do. The test and `fairy.counts` use it. */
function problems(counts, companions = []) {
  const c = counts || {};
  const out = [];
  if (c.badge !== c.needYou) out.push(`badge ${c.badge} is not needYou ${c.needYou}`);
  if (c.more !== Math.max(0, c.needYou - 1)) out.push(`more ${c.more} is not needYou - 1`);
  if (c.open !== c.needYou + c.reports) out.push(`open ${c.open} is not needYou + reports`);
  const shares = Object.values(c.perAgent || {}).reduce((a, n) => a + n, 0) + (c.unowned || 0);
  if (shares !== c.needYou) out.push(`per-agent shares sum to ${shares}, not needYou ${c.needYou}`);
  if (c.blockers > c.needYou) out.push(`blockers ${c.blockers} exceed needYou ${c.needYou}`);
  const drawn = (Array.isArray(companions) ? companions : []).reduce((a, m) => a + (Number(m && m.count) || 0), 0);
  if (companions && companions.length && drawn + (c.wornCount || 0) + (c.unowned || 0) !== c.needYou) {
    out.push(`companion badges ${drawn} + worn ${c.wornCount || 0} + unowned ${c.unowned || 0} is not needYou ${c.needYou}`);
  }
  return out;
}

module.exports = { SCOPE, fairyCounts, moreAfter, badgeTitle, queueHeader, problems };
