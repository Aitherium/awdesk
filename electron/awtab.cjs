"use strict";

/**
 * awtab.cjs — AitherTab: the pure half of mirroring the owner's real browser tabs
 * (Chrome, Edge, Firefox) into the desk's Aither Browser, in groups.
 *
 * Owner, 2026-11-25: "we need a way to mirror chrome/edge/firefox browser tabs to
 * aitherbrowser, but in groups automatically" and "one fairy, this is the reason I
 * wanted rings that can be expanded on". Visible name: AitherTab. Internal brick: awtab.
 *
 * The browser half is ONE extension (extension/awtab, posted to the desk bridge); this
 * module holds only the rules, so `node --test electron/awtab.test.cjs` pins them with
 * no browser and no display:
 *
 *   normalizeSnapshot  what the extension sent -> sanitized windows/groups/tabs
 *   planGroups         native tab groups first, ungrouped tabs grouped by window
 *   diff               current mirrored stages vs next plan (create/update/remove)
 *   ringModel          inner ring = groups, outer ring = the picked group's tabs
 *   fairyEntry         the ONE AitherTab companion (null when nothing is mirrored)
 *
 * Privacy is a rule here, not a promise: only http(s), never a private/incognito
 * window, never a browser-internal URL, and URLs lose any embedded credentials.
 */

const BROWSERS = Object.freeze(["chrome", "edge", "firefox"]);
/** Wall-paper caps: a snapshot is a menu, not a dataset. */
const MAX_TABS = 200;
const MAX_GROUPS = 8;
const MAX_GROUP_TABS = 12;
/** Chrome/Edge tab-group colours, used for the stage tint. */
const COLOURS = Object.freeze(["grey", "blue", "red", "yellow", "green", "pink", "purple", "cyan", "orange"]);

function text(v, max = 200) {
  // eslint-disable-next-line no-control-regex
  return typeof v === "string" ? v.replace(/[\u0000-\u001f]/g, "").trim().slice(0, max) : "";
}

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : -1;
}

/** A tab we may mirror: an http(s) page, with no credentials in its address. */
function mirrorUrl(raw) {
  const s = text(raw, 2000);
  if (!s) return "";
  try {
    const u = new URL(s);
    if (u.protocol !== "http:" && u.protocol !== "https:") return "";
    u.username = "";
    u.password = "";
    return u.toString();
  } catch {
    return "";
  }
}

function normalizeTab(raw, index) {
  if (!raw || typeof raw !== "object") return null;
  const url = mirrorUrl(raw.url);
  if (!url) return null;
  return {
    id: text(raw.id, 40),
    url,
    title: text(raw.title, 200) || url,
    active: raw.active === true,
    pinned: raw.pinned === true,
    index: num(raw.index) >= 0 ? num(raw.index) : index,
    groupId: raw.groupId == null ? -1 : num(raw.groupId),
  };
}

function normalizeWindow(raw, index) {
  if (!raw || typeof raw !== "object") return null;
  if (raw.incognito === true || raw.private === true) return null;
  const tabs = (Array.isArray(raw.tabs) ? raw.tabs : [])
    .map((t, i) => normalizeTab(t, i))
    .filter(Boolean)
    .sort((a, b) => a.index - b.index)
    .slice(0, MAX_TABS);
  return {
    id: num(raw.id) >= 0 ? num(raw.id) : index,
    active: raw.active === true || raw.focused === true,
    tabs,
  };
}

function normalizeGroup(raw) {
  if (!raw || typeof raw !== "object") return null;
  const id = num(raw.id);
  if (id < 0) return null;
  const colour = text(raw.color, 20).toLowerCase();
  return {
    id,
    windowId: num(raw.windowId),
    title: text(raw.title, 40),
    colour: COLOURS.includes(colour) ? colour : "grey",
    collapsed: raw.collapsed === true,
  };
}

/**
 * Whatever the extension sent, as the only shape the rest of the desk reads.
 * A missing/invalid snapshot is null: "could not look" is never an empty list.
 */
function normalizeSnapshot(raw) {
  if (!raw || typeof raw !== "object") return null;
  const browser = text(raw.browser, 20).toLowerCase();
  if (!BROWSERS.includes(browser)) return null;
  const windows = (Array.isArray(raw.windows) ? raw.windows : [])
    .map((w, i) => normalizeWindow(w, i))
    .filter(Boolean)
    .slice(0, 12);
  const groups = (Array.isArray(raw.groups) ? raw.groups : []).map(normalizeGroup).filter(Boolean);
  return {
    browser,
    profile: text(raw.profile, 40) || "default",
    at: num(raw.at) >= 0 ? num(raw.at) : Date.now(),
    windows,
    groups,
  };
}

/** A stable key: it survives a browser restart only when the group name survives. */
function groupKey(browser, profile, kind, id) {
  return `awtab:${browser}:${profile}:${kind}${id}`;
}

function browserLabel(browser) {
  return browser === "edge" ? "Edge" : browser === "firefox" ? "Firefox" : "Chrome";
}

/**
 * The groups to mirror. Native tab groups first (name and colour kept), then each
 * window's ungrouped tabs as its own group. A group with no http(s) tab is dropped.
 */
function planGroups(snapshot, { maxGroups = MAX_GROUPS, maxTabs = MAX_GROUP_TABS } = {}) {
  if (!snapshot) return [];
  const byWindow = new Map(snapshot.windows.map((w) => [w.id, w]));
  const out = [];
  const seen = new Set();
  const push = (kind, id, windowId, name, colour, tabs) => {
    if (!tabs.length || out.length >= maxGroups) return;
    const key = groupKey(snapshot.browser, snapshot.profile, kind, id);
    if (seen.has(key)) return;
    seen.add(key);
    out.push({
      key,
      browser: snapshot.browser,
      browserLabel: browserLabel(snapshot.browser),
      profile: snapshot.profile,
      kind,
      sourceId: id,
      windowId,
      name: text(name, 40) || `${kind === "g" ? "Group" : "Window"} ${id}`,
      colour,
      tabs: tabs.slice(0, maxTabs).map((t) => ({ url: t.url, title: t.title, active: t.active })),
      total: tabs.length,
    });
  };

  // Native groups (Chromium). A group's tabs live in the window that owns the group.
  for (const g of snapshot.groups) {
    const win = byWindow.get(g.windowId);
    const tabs = win ? win.tabs.filter((t) => t.groupId === g.id) : [];
    push("g", g.id, g.windowId, g.title || `Group ${g.id}`, g.colour, tabs);
  }
  // Ungrouped tabs, per window, oldest window id first (stable ordering across pushes).
  const windows = [...snapshot.windows].sort((a, b) => a.id - b.id);
  for (const win of windows) {
    const loose = win.tabs.filter((t) => !(t.groupId >= 0 && snapshot.groups.some((g) => g.id === t.groupId && g.windowId === win.id)));
    const active = win.tabs.find((t) => t.active) || loose[0];
    const name = text(active && active.title, 32) || `Window ${win.id}`;
    push("w", win.id, win.id, name, "grey", loose);
  }
  return out;
}

/** Do two plans describe the same groups (same keys, same tabs in the same order)? */
function sameGroups(a, b) {
  const left = Array.isArray(a) ? a : [];
  const right = Array.isArray(b) ? b : [];
  if (left.length !== right.length) return false;
  for (let i = 0; i < left.length; i += 1) {
    const x = left[i];
    const y = right[i];
    if (!x || !y || x.key !== y.key || x.name !== y.name || x.colour !== y.colour) return false;
    const xt = (x.tabs || []).map((t) => t.url).join("\n");
    const yt = (y.tabs || []).map((t) => t.url).join("\n");
    if (xt !== yt) return false;
  }
  return true;
}

/**
 * What to do with the mirrored stages: `current` is [{stageId, key, name, colour, urls}].
 * Pure, so the window layer only applies the verdict.
 */
function diff(current, next) {
  const cur = Array.isArray(current) ? current : [];
  const plan = Array.isArray(next) ? next : [];
  const byKey = new Map(cur.map((c) => [String(c.key || ""), c]));
  const create = [];
  const update = [];
  for (const group of plan) {
    const have = byKey.get(group.key);
    if (!have) { create.push(group); continue; }
    byKey.delete(group.key);
    const urls = (group.tabs || []).map((t) => t.url);
    const same = (have.urls || []).join("\n") === urls.join("\n");
    if (!same || have.name !== group.name || have.colour !== group.colour) {
      update.push({ ...group, stageId: have.stageId });
    }
  }
  const remove = [...byKey.values()].map((c) => c.stageId).filter(Boolean);
  return { create, update, remove };
}

/**
 * The fairy's nested rings: inner = one slice per group, outer = the picked group's
 * tabs (max 12, with a "+N" slice that opens the whole group as a stage).
 */
function ringModel(groups, selectedKey = "", { maxOuter = MAX_GROUP_TABS } = {}) {
  const list = Array.isArray(groups) ? groups : [];
  const inner = list.map((g) => ({
    id: `aithertab:group:${g.key}`,
    label: `${g.browserLabel || browserLabel(g.browser)} · ${g.name}`,
    short: `${g.name} (${(g.tabs || []).length})`,
    colour: g.colour || "grey",
    count: (g.tabs || []).length,
  }));
  const picked = list.find((g) => g.key === String(selectedKey || ""));
  if (!picked) return { inner, outer: [], selected: "" };
  const tabs = picked.tabs || [];
  const outer = tabs.slice(0, maxOuter).map((t, i) => ({
    id: `aithertab:tab:${picked.key}:${i}`,
    label: text(t.title, 60) || t.url,
    short: text(t.title, 24) || `Tab ${i + 1}`,
    url: t.url,
  }));
  if (tabs.length > outer.length) {
    outer.push({
      id: `aithertab:more:${picked.key}`,
      label: `Open all ${tabs.length} tabs as a stage`,
      short: `+${tabs.length - outer.length} more`,
      stage: picked.key,
    });
  }
  return { inner, outer, selected: picked.key, hub: picked.name };
}

/** The ONE AitherTab companion. Null when nothing is mirrored (never a dead fairy). */
function fairyEntry(groups, nowMs = Date.now()) {
  const list = Array.isArray(groups) ? groups : [];
  if (!list.length) return null;
  const browsers = [...new Set(list.map((g) => g.browserLabel || browserLabel(g.browser)))];
  const tabs = list.reduce((n, g) => n + (g.tabs || []).length, 0);
  return {
    key: "t:aithertab",
    kind: "aithertab",
    source: "aithertab",
    agent: "aithertab",
    label: "AitherTab",
    state: "idle",
    cardId: "",
    sessionId: "",
    count: list.length,
    title: `${list.length} mirrored group${list.length === 1 ? "" : "s"} · ${tabs} tab${tabs === 1 ? "" : "s"} (${browsers.join(", ")})`,
    at: nowMs,
  };
}

module.exports = {
  BROWSERS, COLOURS, MAX_TABS, MAX_GROUPS, MAX_GROUP_TABS,
  browserLabel, diff, fairyEntry, groupKey, mirrorUrl, normalizeSnapshot, planGroups, ringModel, sameGroups,
};
