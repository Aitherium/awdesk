"use strict";

/**
 * window-manager.cjs -- every desk window, on whichever monitor you want, in arrangements
 * you can save and bring back (owner, 2026-10-04: "assign browser / awdesk / awask / any
 * detached windows / avatars stage to specific monitors and save monitor arrangements ...
 * pop out any screen into its own floating window ... summon / hide at will, like macOS
 * Stage Manager but better").
 *
 *   list()                 every window: key, title, which display, bounds, shown or hidden
 *   displays()             every monitor: id, label, work area, primary
 *   moveTo(key, displayId) the window keeps its place RELATIVE to the work area it leaves
 *   show / hide / focus    summon or put away
 *   save(name) / restore(name) / layouts() / remove(name)
 *                          named arrangements in window-layouts.json (userData): per window
 *                          key, its display, bounds and whether it was shown
 *
 * Keys are stable across restarts: a registered window has its own (browser, avatar,
 * overlay); any other desk window is `title:<its title>`; a popped-out browser tab is
 * `pop:<host>`. A saved window that is not open when you restore is skipped, not opened.
 *
 * Electron is injected (screen, BrowserWindow) and the placement math is pure, so it is
 * asserted under node --test.
 */

const fs = require("node:fs");
const path = require("node:path");

/** Move `b` from work area `from` to work area `to`, keeping its relative spot; clamped inside `to`. */
function placeOnDisplay(b, from, to) {
  const fx = from.width > 0 ? (b.x - from.x) / from.width : 0;
  const fy = from.height > 0 ? (b.y - from.y) / from.height : 0;
  const width = Math.min(b.width, to.width);
  const height = Math.min(b.height, to.height);
  const x = Math.round(Math.min(Math.max(to.x + fx * to.width, to.x), to.x + to.width - width));
  const y = Math.round(Math.min(Math.max(to.y + fy * to.height, to.y), to.y + to.height - height));
  return { x, y, width, height };
}

/** The display a rectangle is mostly on (largest overlap), else the first. */
function displayFor(b, displays) {
  let best = displays[0] || null;
  let bestArea = -1;
  for (const d of displays) {
    const a = d.workArea;
    const w = Math.max(0, Math.min(b.x + b.width, a.x + a.width) - Math.max(b.x, a.x));
    const h = Math.max(0, Math.min(b.y + b.height, a.y + a.height) - Math.max(b.y, a.y));
    if (w * h > bestArea) { best = d; bestArea = w * h; }
  }
  return best;
}

const NAME = /^[\w .-]{1,40}$/;

function createWindowManager({ electron = () => require("electron"), file = null, registered = () => ({}) } = {}) {
  const store = () => file || path.join(electron().app.getPath("userData"), "window-layouts.json");
  const readAll = () => {
    try { return JSON.parse(fs.readFileSync(store(), "utf8")) || {}; } catch { return {}; }
  };
  const writeAll = (data) => {
    fs.mkdirSync(path.dirname(store()), { recursive: true });
    fs.writeFileSync(store(), JSON.stringify(data, null, 2));
  };

  function displays() {
    const { screen } = electron();
    const primary = screen.getPrimaryDisplay().id;
    return screen.getAllDisplays().map((d, i) => ({
      id: d.id, label: d.label || `Display ${i + 1}`, primary: d.id === primary,
      workArea: d.workArea, size: d.size, scale: d.scaleFactor,
    }));
  }

  /** key -> BrowserWindow for every desk window worth arranging. */
  function windows() {
    const { BrowserWindow } = electron();
    const named = registered() || {};
    const out = new Map();
    for (const [key, get] of Object.entries(named)) {
      const w = typeof get === "function" ? get() : null;
      if (w && !w.isDestroyed()) out.set(key, w);
    }
    const known = new Set(out.values());
    for (const w of BrowserWindow.getAllWindows()) {
      if (w.isDestroyed() || known.has(w)) continue;
      const title = String(w.getTitle() || "").trim();
      if (!title) continue; // an untitled helper (a hidden worker) is not a window you arrange
      const key = `title:${title.slice(0, 80)}`;
      if (!out.has(key)) out.set(key, w);
    }
    return out;
  }

  function list() {
    const ds = displays();
    return [...windows()].map(([key, w]) => {
      const b = w.getBounds();
      const d = displayFor(b, ds);
      return { key, title: String(w.getTitle() || key), shown: w.isVisible() && !w.isMinimized(),
        displayId: d ? d.id : null, bounds: b, onTop: w.isAlwaysOnTop() };
    });
  }

  const find = (key) => windows().get(String(key || "")) || null;

  function moveTo(key, displayId) {
    const w = find(key);
    if (!w) return { ok: false, error: "no such window" };
    const ds = displays();
    const to = ds.find((d) => d.id === Number(displayId));
    if (!to) return { ok: false, error: "no such display" };
    const b = w.getBounds();
    const from = displayFor(b, ds);
    if (w.isMaximized()) w.unmaximize();
    w.setBounds(placeOnDisplay(b, from.workArea, to.workArea));
    if (!w.isVisible()) w.show();
    return { ok: true };
  }

  function show(key) {
    const w = find(key);
    if (!w) return { ok: false, error: "no such window" };
    if (w.isMinimized()) w.restore();
    w.show();
    w.focus();
    return { ok: true };
  }

  function hide(key) {
    const w = find(key);
    if (!w) return { ok: false, error: "no such window" };
    w.hide();
    return { ok: true };
  }

  function setOnTop(key, on) {
    const w = find(key);
    if (!w) return { ok: false, error: "no such window" };
    w.setAlwaysOnTop(Boolean(on), on ? "floating" : undefined);
    return { ok: true };
  }

  function layouts() {
    const all = readAll();
    return Object.entries(all).map(([name, l]) => ({ name, windows: Object.keys(l.windows || {}).length, savedAt: l.savedAt || null }));
  }

  function save(name) {
    if (!NAME.test(String(name || ""))) return { ok: false, error: "name it with letters, numbers, spaces, dots or dashes" };
    const ds = displays();
    const snapshot = {};
    for (const row of list()) {
      const d = ds.find((x) => x.id === row.displayId);
      snapshot[row.key] = { displayId: row.displayId, displayLabel: d ? d.label : "", bounds: row.bounds, shown: row.shown,
        onTop: row.onTop };
    }
    const all = readAll();
    all[name] = { savedAt: Date.now(), windows: snapshot };
    writeAll(all);
    return { ok: true, windows: Object.keys(snapshot).length };
  }

  function restore(name) {
    const l = readAll()[String(name || "")];
    if (!l) return { ok: false, error: "no such arrangement" };
    const ds = displays();
    let placed = 0;
    let skipped = 0;
    for (const [key, s] of Object.entries(l.windows || {})) {
      const w = find(key);
      if (!w) { skipped++; continue; }
      // The saved monitor if it is still attached; else the same spot on the primary.
      const target = ds.find((d) => d.id === s.displayId) || ds.find((d) => d.primary) || ds[0];
      const saved = ds.find((d) => d.id === s.displayId);
      const b = saved ? s.bounds : placeOnDisplay(s.bounds, s.bounds, target.workArea);
      if (w.isMaximized()) w.unmaximize();
      w.setBounds(b);
      if (typeof s.onTop === "boolean") w.setAlwaysOnTop(s.onTop, s.onTop ? "floating" : undefined);
      if (s.shown) { if (w.isMinimized()) w.restore(); w.showInactive(); } else w.hide();
      placed++;
    }
    return { ok: true, placed, skipped };
  }

  function remove(name) {
    const all = readAll();
    delete all[String(name || "")];
    writeAll(all);
    return { ok: true };
  }

  return { displays, list, moveTo, show, hide, setOnTop, layouts, save, restore, remove };
}

module.exports = { createWindowManager, displayFor, placeOnDisplay };
