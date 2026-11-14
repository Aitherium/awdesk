"use strict";

/**
 * quick-menu.cjs -- the right-click-anywhere quick menu (owner 2026-11-02: "would
 * be nice to be able to just right click anywhere and start capturing/recording/
 * drawing/writing/taking notes"), now also the RADIAL ring of the one Alt+Space
 * key (owner 2026-11-02: "PRESS AND HOLD TO BRING UP A RADIAL MENU UI/UX ... KIND
 * OF LIKE ALFRED ON MAC?").
 *
 * Two presentations, ONE module and one window:
 *   radial  Ctrl+Alt+Q, and the HOLD half of Alt+Space. A ring centred on the
 *           mouse; a click chooses, and when opened by a hold, releasing the key
 *           over a slice runs it (the direction from the centre decides; the
 *           dead zone in the middle cancels). The geometry is launcher-core.cjs's
 *           (sliceAngle / sliceIndexAt), so there is no second copy of the math.
 *   grid    kept for the tray's pinned list and for a future pointer-only menu.
 *
 * 🚩 Parallel lanes add ink.*, audio.* and orb.* WHILE this ships. A command id
 * that is not in commandRegistry.byId() is HIDDEN here, never rendered as a dead
 * cell: `availableItems()` is the one filter, and quick-menu.test.cjs asserts a
 * missing id disappears rather than appearing greyed. A slice with a `fallback`
 * (Ask: orb.ask -> chat.open) appears under the fallback until the real command
 * lands.
 *
 * The window side takes Electron by injection so `node --test` can assert the
 * pure layout/filter, and a standalone probe app can open the real window.
 */

const path = require("node:path");
const launcherCore = require("./launcher-core.cjs");

/**
 * The grid's cells, in reading order: the toolkit's three groups (Create / Capture /
 * Send, toolkit-core.cjs MENU; owner 2026-11-13: "menus are already crowded and glitchy"
 * -- one short list, grouped). Missing commands are skipped by availableItems.
 */
const toolkitCore = require("./toolkit-core.cjs");
const ITEM_IDS = Object.freeze([...toolkitCore.MENU_IDS]);
/** id -> {group, short}: the cell caption is the toolkit group, the name its short label. */
const MENU_META = new Map(toolkitCore.MENU.flatMap((g) => g.items.map((i) => [i.id, { group: g.group, short: i.short }])));

/**
 * The radial's slices, clockwise from the top. Same 10 capabilities the owner
 * named; `fallback` is used only while the preferred command does not exist.
 */
const RADIAL_SPEC = Object.freeze([
  Object.freeze({ id: "snip.region", short: "Snip" }),
  Object.freeze({ id: "record.region", short: "Record" }),
  Object.freeze({ id: "ink.toggle", short: "Draw" }),
  Object.freeze({ id: "note.new", short: "Note" }),
  Object.freeze({ id: "board.new", short: "Board" }),
  Object.freeze({ id: "orb.ask-screen", fallback: "chat.open", short: "Ask" }),
  Object.freeze({ id: "desktop.overlay.toggle", short: "Overlay" }),
  Object.freeze({ id: "terminal.open", short: "Terminal" }),
  Object.freeze({ id: "files.open", short: "Files" }),
  Object.freeze({ id: "audio.settings", short: "Audio" }),
]);
const RADIAL_IDS = Object.freeze(RADIAL_SPEC.map((s) => s.id));

/** Ring geometry, in DIPs: the window is a square centred on the cursor. */
const RADIAL = Object.freeze({ size: 400, radius: 142, item: 74, deadZonePx: launcherCore.DEAD_ZONE_PX });

const CELL = Object.freeze({ width: 132, height: 78, gap: 6, pad: 10 });

/** Labels as the day's context reads them (a command may count things). */
function itemFor(command, ctx = {}) {
  const text = typeof command.label === "function" ? command.label(ctx) : command.label;
  const meta = MENU_META.get(command.id);
  return {
    id: command.id,
    label: String((meta && meta.short) || text || command.id),
    group: (meta && meta.group) || command.group || null,
    icon: command.icon || null,
  };
}

/** The live cells: ids that resolve in the registry, in ITEM_IDS order. */
function availableItems(registry, { ids = ITEM_IDS, ctx = {} } = {}) {
  const out = [];
  for (const id of ids) {
    const command = registry && typeof registry.byId === "function" ? registry.byId(id) : null;
    if (command) out.push(itemFor(command, ctx));
  }
  return out;
}

/**
 * The live radial slices, clockwise from the top. A spec entry resolves to its own
 * id, else its fallback; an entry with neither is omitted (and the surviving
 * slices are re-spread evenly, so one missing command never leaves a gap).
 */
function radialSlices(registry, { spec = RADIAL_SPEC, ctx = {} } = {}) {
  const items = [];
  for (const entry of spec) {
    const command = [entry.id, entry.fallback]
      .filter(Boolean)
      .map((id) => (registry && typeof registry.byId === "function" ? registry.byId(id) : null))
      .find(Boolean);
    // Owner 2026-11-02: "the wheel has too many words and some get cut off" --
    // a slice shows ONE short word; the hub shows the full label of the hot slice.
    if (command) items.push({ ...itemFor(command, ctx), short: entry.short || null });
  }
  return items.map((item, index) => ({
    ...item,
    index,
    angle: launcherCore.sliceAngle(index, items.length),
    slice: 360 / Math.max(1, items.length),
  }));
}

/** Width/height of the grid pop-up for `count` cells: 3 columns up to 6, else 4. */
function layout(count) {
  const n = Math.max(0, Math.min(64, Number(count) || 0));
  const cols = n <= 6 ? 3 : 4;
  const rows = Math.max(1, Math.ceil(n / cols));
  return {
    columns: cols,
    width: CELL.pad * 2 + cols * CELL.width + (cols - 1) * CELL.gap,
    height: CELL.pad * 2 + rows * CELL.height + (rows - 1) * CELL.gap,
  };
}

/**
 * Where the pop-up sits: its top-left at the cursor; flipped left/up when it would
 * run past the work area, then clamped in. The cursor therefore lands on the first
 * cell in the common case and the menu is never half off-screen.
 */
function positionFor(cursor, workArea, size, margin = 8) {
  const area = workArea && Number.isFinite(workArea.width) ? workArea : { x: 0, y: 0, width: 1920, height: 1080 };
  const w = Math.max(1, Number(size && size.width) || 1);
  const h = Math.max(1, Number(size && size.height) || 1);
  const cx = Number(cursor && cursor.x) || 0;
  const cy = Number(cursor && cursor.y) || 0;
  let x = cx;
  let y = cy;
  if (x + w > area.x + area.width - margin) x = cx - w;
  if (y + h > area.y + area.height - margin) y = cy - h;
  x = Math.min(Math.max(x, area.x + margin), area.x + area.width - w - margin);
  y = Math.min(Math.max(y, area.y + margin), area.y + area.height - h - margin);
  return { x: Math.round(x), y: Math.round(y), width: Math.round(w), height: Math.round(h) };
}

/**
 * Where the radial window sits: a square CENTRED on the cursor, clamped only when
 * it would leave the work area. The returned `center` is the ring's real centre,
 * which is what the release direction is measured from (so an edge-clamped ring
 * still selects correctly).
 */
function radialBounds(cursor, workArea, size = RADIAL.size, margin = 8) {
  const area = workArea && Number.isFinite(workArea.width) ? workArea : { x: 0, y: 0, width: 1920, height: 1080 };
  const n = Math.max(1, Number(size) || RADIAL.size);
  const cx = Number(cursor && cursor.x) || 0;
  const cy = Number(cursor && cursor.y) || 0;
  const minX = area.x + margin;
  const maxX = Math.max(minX, area.x + area.width - n - margin);
  const minY = area.y + margin;
  const maxY = Math.max(minY, area.y + area.height - n - margin);
  const x = Math.round(Math.min(Math.max(cx - n / 2, minX), maxX));
  const y = Math.round(Math.min(Math.max(cy - n / 2, minY), maxY));
  return { x, y, width: n, height: n, center: { x: x + n / 2, y: y + n / 2 } };
}

/**
 * @param {object} opts
 * @param {object} opts.electron  require("electron") (injected for the probe/tests)
 * @param {object} opts.registry  command-registry.cjs
 * @param {Function} opts.run     (id) => void -- main's runCommand
 * @param {string[]} [opts.ids]
 * @param {Function} [opts.now]
 */
function createQuickMenu({ electron, registry, run, ids = ITEM_IDS, spec = RADIAL_SPEC, now = Date.now } = {}) {
  if (!electron) throw new Error("quick-menu needs electron");
  const { BrowserWindow, ipcMain, screen } = electron;
  let win = null;
  let wired = false;
  let shownAt = 0;
  let mode = "grid";
  let hold = false;
  let center = null;
  let done = null;

  function alive() {
    return Boolean(win && !win.isDestroyed());
  }

  function fromMenu(event) {
    return Boolean(alive() && event && event.sender === win.webContents);
  }

  function finish(result) {
    const callback = done;
    done = null;
    hold = false;
    hide();
    if (callback) {
      try { callback(result); } catch { /* a caller bug stays in the caller */ }
    }
  }

  function hide() {
    if (alive() && win.isVisible()) win.hide();
  }

  /** Select the slice under the REAL cursor and run it (the hold release). */
  function releaseSelection() {
    if (mode !== "radial" || !hold) return { ok: true, ignored: true };
    const slices = radialSlices(registry, { spec });
    const cursor = screen.getCursorScreenPoint();
    const index = launcherCore.sliceIndexAt(cursor, center || { x: 0, y: 0 }, slices.length,
      { deadZonePx: RADIAL.deadZonePx });
    if (index == null || !slices[index]) { finish({ cancelled: true }); return { ok: true, cancelled: true }; }
    const chosen = slices[index];
    try { run(chosen.id); } catch { /* the desk's own runCommand never throws at a caller */ }
    finish({ id: chosen.id });
    return { ok: true, ran: chosen.id };
  }

  function ensureIpc() {
    if (wired) return;
    wired = true;
    ipcMain.handle("quick:items", (event) => {
      if (!fromMenu(event)) return { ok: false, reason: "not the quick menu" };
      if (mode === "radial") {
        return {
          ok: true, mode, hold,
          slices: radialSlices(registry, { spec }),
          radius: RADIAL.radius, item: RADIAL.item, deadZonePx: RADIAL.deadZonePx, size: RADIAL.size,
        };
      }
      return { ok: true, mode: "grid", items: availableItems(registry) };
    });
    ipcMain.handle("quick:run", (event, rawId) => {
      if (!fromMenu(event)) return { ok: false, reason: "not the quick menu" };
      const id = String(rawId || "");
      const command = registry && registry.byId ? registry.byId(id) : null;
      if (!command) return { ok: false, reason: "that command is not available" };
      const wasHold = mode === "radial" && hold;
      try { run(id); } catch { /* the desk's own runCommand never throws at a caller */ }
      if (wasHold) finish({ id }); else hide();
      return { ok: true };
    });
    // The HOLD half: the renderer saw the key come up. Direction decides the
    // slice; the dead zone in the middle cancels; a missing result is a cancel.
    ipcMain.handle("quick:release", (event) => {
      if (!fromMenu(event)) return { ok: false, reason: "not the quick menu" };
      return releaseSelection();
    });
    ipcMain.handle("quick:hide", (event) => {
      if (!fromMenu(event)) return { ok: false, reason: "not the quick menu" };
      if (mode === "radial" && hold) finish({ cancelled: true }); else hide();
      return { ok: true };
    });
  }

  function create() {
    win = new BrowserWindow({
      width: layout(9).width, height: layout(9).height, show: false,
      frame: false, transparent: true, resizable: false, movable: false, minimizable: false,
      maximizable: false, fullscreenable: false, skipTaskbar: true, alwaysOnTop: true,
      hasShadow: true, backgroundColor: "#00000000",
      webPreferences: {
        preload: path.join(__dirname, "quick-menu-preload.cjs"),
        contextIsolation: true, nodeIntegration: false, sandbox: true,
      },
    });
    win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    win.webContents.on("will-navigate", (event) => event.preventDefault());
    // Click-away / focus stolen = close (the native-menu contract). The hold ring
    // gets longer: releasing Alt can move focus on Windows, and the keyup that is
    // still on its way is the selection.
    win.on("blur", () => {
      const grace = mode === "radial" && hold ? 500 : 120;
      if (now() - shownAt > grace) { if (mode === "radial" && hold) finish({ cancelled: true }); else hide(); }
    });
    win.on("closed", () => { win = null; });
    void win.loadFile(path.join(__dirname, "quick-menu.html"));
    return win;
  }

  /** Open (or close) the grid pop-up. `at` is a screen point; omitted = the cursor. */
  function open({ x, y } = {}) {
    const point = Number.isFinite(x) && Number.isFinite(y) ? { x, y } : screen.getCursorScreenPoint();
    const display = screen.getDisplayNearestPoint(point);
    const items = availableItems(registry, { ids });
    if (!items.length) return { ok: false, reason: "no quick-menu commands are available" };
    ensureIpc();
    if (!alive()) create();
    mode = "grid";
    hold = false;
    center = null;
    const box = layout(items.length);
    const bounds = positionFor(point, display.workArea, box);
    win.setBounds(bounds);
    shownAt = now();
    if (win.isVisible()) { hide(); return { ok: true, closed: true }; }
    win.show();
    win.focus();
    if (win.webContents && !win.webContents.isLoading()) win.webContents.send("quick:refresh");
    return { ok: true, bounds };
  }

  /** Open (or hide) the radial ring at the cursor. */
  function openRadial({ at = null, hold: held = false, onDone = null, force = false } = {}) {
    const point = at && Number.isFinite(at.x) && Number.isFinite(at.y) ? at : screen.getCursorScreenPoint();
    const display = screen.getDisplayNearestPoint(point);
    const slices = radialSlices(registry, { spec });
    if (!slices.length) return { ok: false, reason: "no radial actions are available" };
    ensureIpc();
    if (!alive()) create();
    if (win.isVisible() && mode === "radial" && !force && !held) {
      if (hold) finish({ cancelled: true }); else hide();
      return { ok: true, closed: true };
    }
    const box = radialBounds(point, display.workArea, RADIAL.size);
    mode = "radial";
    hold = Boolean(held);
    done = typeof onDone === "function" ? onDone : null;
    center = box.center;
    win.setBounds({ x: box.x, y: box.y, width: box.width, height: box.height });
    shownAt = now();
    win.show();
    win.focus();
    if (win.webContents && !win.webContents.isLoading()) win.webContents.send("quick:refresh");
    return { ok: true, bounds: box, slices: slices.map((s) => s.id) };
  }

  function openAtCursor() {
    return openRadial();
  }

  function toggle() {
    if (alive() && win.isVisible()) { hide(); return { ok: true, closed: true }; }
    return open();
  }

  /** Tray submenu rows: the same live cells, plus the pop-up itself. */
  function submenuItems(runId) {
    const callback = typeof runId === "function" ? runId : run;
    // Grouped Create / Capture / Send: a disabled header, the rows, a separator.
    const rows = [];
    let group = null;
    for (const item of availableItems(registry)) {
      if (item.group !== group) {
        if (rows.length) rows.push({ type: "separator" });
        group = item.group;
        rows.push({ label: String(group || ""), enabled: false });
      }
      rows.push({ label: item.label, click: () => callback(item.id) });
    }
    return [
      ...rows,
      { type: "separator" },
      { label: "Ring at the cursor (Ctrl+Alt+Q)", click: () => openRadial() },
    ];
  }

  return {
    open, openAtCursor, openRadial, releaseSelection, toggle, hide, submenuItems, ensureIpc,
    isVisible: () => Boolean(alive() && win.isVisible()),
    isRadialHold: () => Boolean(mode === "radial" && hold && alive() && win.isVisible()),
    availableItems: () => availableItems(registry),
    radialSlices: () => radialSlices(registry, { spec }),
  };
}

module.exports = {
  ITEM_IDS, RADIAL_SPEC, RADIAL_IDS, RADIAL, CELL, availableItems, itemFor, layout, positionFor,
  radialBounds, radialSlices, createQuickMenu,
};
