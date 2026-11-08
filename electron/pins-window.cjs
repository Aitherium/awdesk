"use strict";

/**
 * pins-window.cjs -- desktop pins: frameless, transparent, resizable windows that
 * hold one pin-item card each (a GIF, an image, a YouTube video, a web page, a
 * browser tab's page, an app tile, a note). Owner 2026-11-07: "searching for GIFs
 * and pinning them on the desktop, or a YouTube video, or a web page tab, or an app".
 *
 * Per pin: drag the strip to move, drag an edge to resize, opacity, lock
 * (click-through: the pin shows, the mouse reaches what is under it -- hovering
 * the lock badge catches the mouse again so it can be unlocked), on-top vs
 * desktop level, mute, close. The list persists under userData (pins-core
 * STORE_FILE) and comes back on restart.
 *
 * 🚩 EMBEDDED WEB CONTENT. A page or a YouTube embed runs in a WebContentsView
 * that is sandboxed, context-isolated, has NO preload and NO node, lives in its
 * own partition ("persist:aither-pins"), and every permission request except
 * fullscreen is denied. Navigation goes through navigation-policy.cjs (same
 * origin stays in the pin); anything else -- a link to another site, a popup --
 * opens as an Aither browser tab instead, sanitised by browser-policy.cjs. The
 * pin's own controls page (pin.html) is a separate file:// renderer whose CSP
 * allows https images and nothing remote besides. An app pin is a tile that
 * LAUNCHES; an aither:// page is never embedded (it needs a preload no pin gets).
 *
 * Desktop level on Windows: Electron has no "below every window" level there, so
 * "desktop" means NOT always-on-top (other windows cover it; Win+D hides it).
 */

const fs = require("node:fs");
const path = require("node:path");
const core = require("./pins-core.cjs");
const { pinItemFromUrl, DEFAULT_SIZE } = require("./pin-item.cjs");

/** "example.com/x" -> "https://example.com/x"; anything with a scheme is left alone. */
function withScheme(text) {
  const t = String(text == null ? "" : text).trim();
  if (/^[a-z][a-z0-9+.-]*:/i.test(t)) return t;
  return /^(localhost|[\w-]+(\.[\w-]+)+)(:\d+)?([/?#]|$)/i.test(t) ? `https://${t}` : t;
}
const { isAllowedRendererNavigation } = require("./navigation-policy.cjs");

const PARTITION = "persist:aither-pins";
const YT_REFERRER = "https://aitherium.com/";

let configured = {
  electron: null,
  storeFile: null,
  launchApp: null,
  openInBrowser: null,
  onChange: null,
};
let store = core.emptyStore();
let loaded = false;
/** pin id -> {win, view, saveTimer} */
const entries = new Map();
let wired = false;
let sessionGuarded = false;

function electron() {
  return configured.electron || require("electron");
}

/** Inject collaborators (main wires launch/open; tests pass a fake electron + temp file). */
function configurePins(next = {}) {
  configured = { ...configured, ...next };
  if (next.storeFile !== undefined) loaded = false;
}

function storeFile() {
  if (configured.storeFile) return configured.storeFile;
  return path.join(electron().app.getPath("userData"), core.STORE_FILE);
}

function load() {
  if (loaded) return store;
  loaded = true;
  try {
    store = core.normalizeStore(JSON.parse(fs.readFileSync(storeFile(), "utf8")));
  } catch {
    store = core.emptyStore();
  }
  return store;
}

/** Atomic write (tmp + rename); userData already exists, so no mkdir of any kind. */
function persist() {
  const file = storeFile();
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(tmp, `${JSON.stringify(store, null, 2)}\n`, "utf8");
    fs.renameSync(tmp, file);
    return { ok: true };
  } catch (error) {
    try { fs.unlinkSync(tmp); } catch { /* never written */ }
    return { ok: false, reason: String((error && error.message) || error).slice(0, 160) };
  }
}

function changed() {
  try { if (configured.onChange) configured.onChange(); } catch { /* a tray refresh must not fail a pin */ }
}

function record(id) {
  return load().pins.find((p) => p.id === id) || null;
}

function publicPin(pin) {
  return { pin: { ...pin }, content: core.contentFor(pin), strip: core.STRIP };
}

function send(entry, channel, payload) {
  try { if (entry && entry.win && !entry.win.isDestroyed()) entry.win.webContents.send(channel, payload); } catch { /* closing */ }
}

// ── embedded web content ─────────────────────────────────────────────────────

function openInBrowser(url) {
  try {
    const verdict = require("./browser-policy.cjs").sanitizeUrl(String(url || ""));
    if (!verdict.ok) return { ok: false, reason: verdict.reason };
    if (configured.openInBrowser) return configured.openInBrowser(verdict.url) || { ok: true };
    return { ok: false, reason: "the Aither browser is not wired" };
  } catch (error) {
    return { ok: false, reason: String((error && error.message) || error).slice(0, 160) };
  }
}

/** Once per process: the pin partition denies every permission but fullscreen. */
function guardSession() {
  if (sessionGuarded) return;
  sessionGuarded = true;
  try {
    const ses = electron().session.fromPartition(PARTITION);
    ses.setPermissionRequestHandler((_wc, permission, callback) => callback(permission === "fullscreen"));
    ses.setPermissionCheckHandler((_wc, permission) => permission === "fullscreen");
  } catch { /* a probe without sessions */ }
}

/** The navigation rules every embedded page lives under. */
function guardContents(contents) {
  contents.setWindowOpenHandler(({ url }) => {
    openInBrowser(url);
    return { action: "deny" };
  });
  contents.on("will-navigate", (event, url) => {
    let current;
    try { current = contents.getURL(); } catch { current = ""; }
    if (current && isAllowedRendererNavigation(url, current)) return;
    event.preventDefault();
    openInBrowser(url);
  });
  // No <webview> may ever be attached inside a pin.
  contents.on("will-attach-webview", (event) => event.preventDefault());
}

function attachView(entry, pin, content) {
  const { WebContentsView } = electron();
  const view = new WebContentsView({
    webPreferences: {
      sandbox: true, contextIsolation: true, nodeIntegration: false,
      partition: PARTITION, webviewTag: false, backgroundThrottling: true,
    },
  });
  guardSession();
  guardContents(view.webContents);
  entry.win.contentView.addChildView(view);
  view.setBounds(core.viewBounds(entry.win.getBounds()));
  try { view.webContents.setAudioMuted(Boolean(pin.muted)); } catch { /* old electron */ }
  // YouTube refuses an embed with no referrer (player error 153); name ours.
  const opts = content.embed === "youtube" ? { httpReferrer: YT_REFERRER } : {};
  void view.webContents.loadURL(content.url, opts).catch(() => { /* the strip shows the title; reload retries */ });
  entry.view = view;
}

// ── windows ──────────────────────────────────────────────────────────────────

function applySwitches(entry, pin) {
  const win = entry.win;
  if (!win || win.isDestroyed()) return;
  try {
    if (pin.onTop) win.setAlwaysOnTop(true, "floating");
    else win.setAlwaysOnTop(false);
    win.setOpacity(pin.opacity);
    if (pin.locked) win.setIgnoreMouseEvents(true, { forward: true });
    else win.setIgnoreMouseEvents(false);
    if (entry.view) entry.view.webContents.setAudioMuted(Boolean(pin.muted));
    if (pin.hidden) win.hide();
    else if (!win.isVisible()) win.showInactive();
  } catch { /* the window was closing */ }
}

function queueBoundsSave(id) {
  const entry = entries.get(id);
  if (!entry || !entry.win || entry.win.isDestroyed()) return;
  if (entry.view) {
    try { entry.view.setBounds(core.viewBounds(entry.win.getBounds())); } catch { /* closing */ }
  }
  if (entry.saveTimer) clearTimeout(entry.saveTimer);
  entry.saveTimer = setTimeout(() => {
    entry.saveTimer = null;
    if (!entry.win || entry.win.isDestroyed()) return;
    const r = core.patchPin(store, id, { bounds: entry.win.getBounds() });
    if (r.pin) { store = r.store; persist(); }
  }, 400);
  if (entry.saveTimer.unref) entry.saveTimer.unref();
}

function openWindow(pin) {
  const known = entries.get(pin.id);
  if (known && known.win && !known.win.isDestroyed()) {
    applySwitches(known, pin);
    send(known, "pin:state", publicPin(pin));
    return known;
  }
  const { BrowserWindow, screen } = electron();
  let bounds = pin.bounds;
  try { bounds = core.visibleBounds(pin.bounds, screen.getAllDisplays().map((d) => d.workArea)); } catch { /* probe */ }
  const content = core.contentFor(pin);
  // A WebContentsView inside a TRANSPARENT window is not composited on Windows
  // (measured 2026-11-07, Electron 39: the page loaded and capturePage() had it,
  // the screen showed straight through). Web pins get an opaque dark window;
  // a GIF, an image, a tile or a note keeps the see-through one.
  const web = Boolean(content && content.mode === "web");
  const win = new BrowserWindow({
    ...bounds,
    frame: false, transparent: !web, resizable: true, hasShadow: web, show: false,
    minWidth: 80, minHeight: 60, skipTaskbar: true, fullscreenable: false, maximizable: false,
    title: pin.title, backgroundColor: web ? "#14141a" : "#00000000",
    webPreferences: {
      preload: path.join(__dirname, "pin-preload.cjs"),
      contextIsolation: true, nodeIntegration: false, sandbox: true, webviewTag: false,
    },
  });
  const entry = { id: pin.id, win, view: null, saveTimer: null };
  entries.set(pin.id, entry);
  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  win.webContents.on("will-navigate", (event) => event.preventDefault());
  win.on("move", () => queueBoundsSave(pin.id));
  win.on("resize", () => queueBoundsSave(pin.id));
  win.on("closed", () => {
    const e = entries.get(pin.id);
    if (e && e.win === win) entries.delete(pin.id);
  });
  win.once("ready-to-show", () => {
    const now = record(pin.id) || pin;
    applySwitches(entry, now);
  });
  if (web) attachView(entry, pin, content);
  void win.loadFile(path.join(__dirname, "pin.html"));
  return entry;
}

function cursorPlace(size) {
  try {
    const { screen } = electron();
    const point = screen.getCursorScreenPoint();
    return core.placeAt(point, size, screen.getDisplayNearestPoint(point).workArea);
  } catch {
    return { x: 80, y: 80, ...size };
  }
}

/**
 * Pin a card (a pin-item object) or an address (any text pinItemFromUrl reads).
 * New pins open centred on the cursor unless the card carries real bounds.
 *
 * @returns {{ok: true, pin: object, dropped: string[]} | {ok: false, reason: string}}
 */
function addPin(input, { title = "", bounds = null } = {}) {
  load();
  const card = input && typeof input === "object" ? input : pinItemFromUrl(withScheme(input), { title });
  if (!card) return { ok: false, reason: "not something a pin can show — paste an http(s) address, a YouTube link, a GIF or an app" };
  const size = (card.bounds && card.bounds.width && card.bounds.height)
    ? { width: card.bounds.width, height: card.bounds.height }
    : (DEFAULT_SIZE[card.kind] || DEFAULT_SIZE.url);
  const hasPlace = bounds || (card.bounds && (card.bounds.x || card.bounds.y));
  const place = bounds || (hasPlace ? card.bounds : cursorPlace(size));
  const r = core.addPin(store, { ...card, title: card.title || title, bounds: place });
  if (!r.pin) return { ok: false, reason: "that pin did not read back — nothing was pinned" };
  store = r.store;
  for (const gone of r.dropped) closeWindow(gone);
  persist();
  ensureIpc();
  openWindow(r.pin);
  changed();
  return { ok: true, pin: r.pin, dropped: r.dropped };
}

/** Pin the page an Aither browser tab shows ({url, title}); the tab stays open. */
function pinTab(tab) {
  if (!tab || !tab.url) return { ok: false, reason: "no browser tab to pin — open one first" };
  return addPin(String(tab.url), { title: String(tab.title || tab.label || "") });
}

function closeWindow(id) {
  const entry = entries.get(id);
  if (!entry) return;
  entries.delete(id);
  if (entry.saveTimer) clearTimeout(entry.saveTimer);
  try { if (entry.win && !entry.win.isDestroyed()) entry.win.destroy(); } catch { /* gone */ }
}

/** Remove a pin for good (its window and its row). */
function closePin(id) {
  load();
  const r = core.removePin(store, String(id || ""));
  if (!r.removed) return { ok: false, reason: "that pin is not open" };
  store = r.store;
  closeWindow(String(id));
  persist();
  changed();
  return { ok: true };
}

/** Change a pin's switches; the window follows at once. */
function setPin(id, patch) {
  load();
  const r = core.patchPin(store, String(id || ""), patch);
  if (!r.pin) return { ok: false, reason: "that pin is not open" };
  store = r.store;
  persist();
  const entry = entries.get(r.pin.id);
  if (entry) {
    applySwitches(entry, r.pin);
    if (patch && patch.muted !== undefined && entry.view && r.pin.kind === "youtube") {
      // The embed's own mute follows the switch on the next load; the audio mute is immediate.
      try { entry.view.webContents.setAudioMuted(r.pin.muted); } catch { /* closing */ }
    }
    send(entry, "pin:state", publicPin(r.pin));
  } else if (!r.pin.hidden) {
    openWindow(r.pin);
  }
  changed();
  return { ok: true, pin: r.pin };
}

/** Bring one pin forward and unhide it. */
function showPin(id) {
  const r = setPin(id, { hidden: false });
  if (!r.ok) return r;
  const entry = entries.get(r.pin.id);
  try { if (entry && entry.win && !entry.win.isDestroyed()) entry.win.showInactive(); } catch { /* gone */ }
  store = core.raisePin(store, r.pin.id).store;
  persist();
  return r;
}

function setAllHidden(hidden) {
  load();
  for (const p of [...store.pins]) setPin(p.id, { hidden });
  return { ok: true, count: store.pins.length };
}

function closeAll() {
  load();
  const n = store.pins.length;
  for (const p of [...store.pins]) closeWindow(p.id);
  store = core.emptyStore();
  persist();
  changed();
  return { ok: true, closed: n };
}

/** Bring every saved pin back (startup). Hidden pins stay hidden until shown. */
function restorePins() {
  load();
  ensureIpc();
  let opened = 0;
  for (const p of store.pins) {
    if (p.hidden) continue;
    try { openWindow(p); opened += 1; } catch { /* one bad pin must not stop the rest */ }
  }
  return { ok: true, opened, total: store.pins.length };
}

function listPins() {
  return load().pins.map((p) => ({ ...p }));
}

function summary() {
  return core.listSummary(load());
}

/** The tray's Pins submenu: every pin (click = show + raise), then the bulk rows. */
function traySubmenu() {
  const sum = summary();
  const rows = sum.rows.map((r) => ({ label: r.label, click: () => { showPin(r.id); } }));
  if (sum.more) rows.push({ label: `+${sum.more} more — Alt+Space, type "pins"`, enabled: false });
  if (!rows.length) rows.push({ label: "0 pins — Alt+Space, type \"pin <address>\" or \"gif <word>\"", enabled: false });
  rows.push({ type: "separator" });
  rows.push({ label: "Show all pins", enabled: sum.total > 0, click: () => { setAllHidden(false); } });
  rows.push({ label: "Hide all pins", enabled: sum.total > 0, click: () => { setAllHidden(true); } });
  rows.push({ label: "Close all pins", enabled: sum.total > 0, click: () => { closeAll(); } });
  return rows;
}

// ── IPC (pin.html) ───────────────────────────────────────────────────────────

function entryFor(event) {
  for (const entry of entries.values()) {
    if (entry.win && !entry.win.isDestroyed() && entry.win.webContents === event.sender) return entry;
  }
  return null;
}

function handlers() {
  const guarded = (fn) => (event, ...args) => {
    const entry = entryFor(event);
    if (!entry) return { ok: false, reason: "not a pin window" };
    return fn(entry, ...args);
  };
  return {
    "pin:init": guarded((entry) => {
      const pin = record(entry.id);
      return pin ? { ok: true, ...publicPin(pin) } : { ok: false, reason: "that pin is gone" };
    }),
    "pin:set": guarded((entry, patch) => {
      const p = patch && typeof patch === "object" ? patch : {};
      const allowed = {};
      for (const key of ["opacity", "locked", "onTop", "muted", "title", "src"]) if (p[key] !== undefined) allowed[key] = p[key];
      return setPin(entry.id, allowed);
    }),
    "pin:close": guarded((entry) => closePin(entry.id)),
    "pin:hide": guarded((entry) => setPin(entry.id, { hidden: true })),
    "pin:hover-chrome": guarded((entry, over) => {
      const pin = record(entry.id);
      if (!pin || !pin.locked) return { ok: true };
      try {
        if (over) entry.win.setIgnoreMouseEvents(false);
        else entry.win.setIgnoreMouseEvents(true, { forward: true });
      } catch { /* closing */ }
      return { ok: true };
    }),
    "pin:launch": guarded((entry) => {
      const pin = record(entry.id);
      const content = core.contentFor(pin);
      if (!content || content.mode !== "app") return { ok: false, reason: "only an app pin launches" };
      if (!configured.launchApp) return { ok: false, reason: "app launching is not wired" };
      return configured.launchApp(content.target) || { ok: true };
    }),
    "pin:open-in-browser": guarded((entry) => {
      const pin = record(entry.id);
      if (!pin || !["url", "youtube", "gif", "image"].includes(pin.kind)) return { ok: false, reason: "nothing to open" };
      return openInBrowser(pin.src);
    }),
    "pin:reload": guarded((entry) => {
      try { if (entry.view) entry.view.webContents.reload(); } catch { /* closing */ }
      return { ok: true };
    }),
  };
}

function ensureIpc() {
  if (wired) return;
  wired = true;
  try {
    const { ipcMain } = electron();
    for (const [channel, fn] of Object.entries(handlers())) ipcMain.handle(channel, fn);
  } catch { wired = false; }
}

module.exports = {
  PARTITION,
  configurePins, addPin, pinTab, closePin, setPin, showPin, setAllHidden, closeAll,
  restorePins, listPins, summary, traySubmenu, handlers, ensureIpc, openInBrowser, withScheme,
  // test seams
  __entries: entries,
  __reset: () => { store = core.emptyStore(); loaded = false; entries.clear(); wired = false; sessionGuarded = false; },
};
