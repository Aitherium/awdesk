"use strict";

/**
 * browser-window.cjs -- the Aither Browser: a browser window INSIDE awdesk (not a
 * Chromium fork) where an agent browses while the owner watches and can take
 * over, and where the owner can simply browse.
 *
 * Three surfaces in one BrowserWindow, each with the least privilege it needs:
 *
 *   window webContents  browser-chrome.html + browser-chrome-preload.cjs: URL bar,
 *                       back/forward/reload, the "Agent is driving" banner and
 *                       the Take over / Let the agent continue button.
 *   page views          ONE WebContentsView PER TAB. A WEB tab lives in the
 *                       browser's OWN partition, contextIsolation, sandbox, no
 *                       node, and NO preload -- web content gets no bridge into
 *                       the desk at all. Tabs belong to whoever opened them
 *                       (browser-tabs.cjs): an agent drives only its own tabs.
 *   aither:// tabs      THE CONSOLE (plan slices 8+9). Every Aither Console pane is
 *                       a page, aither://<pane> (browser-internal.cjs), in its own
 *                       INTERNAL partition -- the only session that resolves the
 *                       scheme -- with ONLY that pane's preload. A web tab can
 *                       neither navigate to nor frame one, and an internal tab
 *                       sends any web link to a new web tab. Hosted panes
 *                       (AitherOS Online) open as HOSTED tabs in the pane's own
 *                       signed-in partition. Inbox, AitherOS Online and Workspace
 *                       are pinned at the front of the strip.
 *   panel view          ONE self-contained, swappable assistant view, created by
 *                       createAssistantPanel() -- the Connect panel,
 *                       connect-panel.html (awconnect's side panel in the desk:
 *                       chat about the page with history, quick actions, "Do it"
 *                       for an agent, Open in Chrome, downloads, and the Agents
 *                       tab: live sessions, open cards answerable in place, the
 *                       room -- agents-panel.cjs). It hands the
 *                       page, fenced as untrusted data, to the desk's one
 *                       CommandAgent. Swapping it changes ASSISTANT_PANEL and
 *                       nothing else. Take over lives on the toolbar, not the
 *                       panel, so a swapped panel cannot lose it.
 *
 * Every decision (URL scheme, permissions, the take-over gate, the ask prompt)
 * lives in browser-policy.cjs so it is tested without a window; this module is
 * the Electron wiring. Agent control arrives through mcp-server.cjs's browser_*
 * tools -> browserAgent() -> the gate -> the driver below.
 */

const path = require("node:path");
const policy = require("./browser-policy.cjs");
const internal = require("./browser-internal.cjs");
const contextPush = require("./browser-context-push.cjs");
const { TabSet } = require("./browser-tabs.cjs");
const { createLibrary } = require("./browser-library.cjs");
const { createDownloads } = require("./browser-downloads.cjs");
const agentsPanel = require("./agents-panel.cjs");
const rail = require("./browser-rail.cjs");
const taskbar = require("./browser-taskbar.cjs");
const extensions = require("./browser-extensions.cjs");

const PARTITION = "persist:aither-browser";
const CHROME_HEIGHT = 118; // tab strip (34) + toolbar (44) + banner (40); browser-chrome.html matches
// The assistant panel: one HTML file + one preload. Point these at the awkit
// Connect panel to swap it (see createAssistantPanel).
const ASSISTANT_PANEL = Object.freeze({
  // The Connect panel (2026-10-03): awconnect's side panel, in the desk's browser --
  // chat about the page with history, quick actions, "have an agent do it", open in
  // Chrome, and the downloads shelf.
  html: "connect-panel.html",
  preload: "connect-panel-preload.cjs",
});
// Page scripts run in an isolated world: the page's own JS cannot patch
// querySelector/click under the agent (they share the DOM, not the globals).
const ISOLATED_WORLD_ID = 1017;
const READ_TEXT_CHARS = 20_000;
const READ_LINKS = 60;
const IDLE_WAIT_MS = 10_000;
/** browser_snapshot lists at most this many elements; `truncated` says when it cut. */
const SNAPSHOT_MAX = 200;
/** A page that settles is pushed to AitherDesktop once, this long after it stops loading. */
const CONTEXT_PUSH_DELAY_MS = 1500;
/** browser_screenshot is scaled down to this width so one image stays readable in a turn. */
const SCREENSHOT_MAX_WIDTH = 1280;
/** PRESSABLE_KEYS (browser-policy) -> Electron sendInputEvent keyCode. */
const KEY_CODES = Object.freeze({
  Enter: "Enter", Tab: "Tab", Escape: "Escape", Space: "Space", Backspace: "Backspace", Delete: "Delete",
  ArrowUp: "Up", ArrowDown: "Down", ArrowLeft: "Left", ArrowRight: "Right",
  PageUp: "PageUp", PageDown: "PageDown", Home: "Home", End: "End",
});

function electron() {
  return require("electron");
}

let win = null;
/** tab id -> its WebContentsView. The TabSet decides; this map only holds the views. */
const views = new Map();
let tabs = new TabSet();
let panelView = null;
let ipcWired = false;
let sessionHardened = false;
let internalReady = false;
/** What main injects so aither:// pages resolve (configureInternal). */
let internalConfig = { rendererUrl: "", hostedUrl: null, hostedPrepare: null, beforeInternal: null,
  workspaceUrl: null, modelFile: null };
/** The inbox count, shown on the pinned Inbox tab and the taskbar button. */
let inbox = { count: 0, image: null, tooltip: "" };
let askAgent = null;
let agentHandle = null;
/**
 * The Connect panel's Agents tab: {view(), check(id, choice), answer(id, choice, win)}.
 * main installs it (setAgentsHost) because the sources -- the session directory,
 * the open cards, the room feed and the ONE answer path the Inbox uses -- live there.
 */
let agentsHost = null;
/**
 * The layers around the browser (owner, 2026-10-04: "awsh -> awdesk/avatar -> browser
 * -> AitherOS Online overlay"). main installs it (setShellHost): whether the avatar is
 * docked in the rail, whether the Online overlay is up, the ONE menu (the tray's) and
 * the rail's allowlisted commands. {docked(), overlayVisible(), popupMenu(win), run(id)}
 */
let shellHost = null;
/**
 * The owner's layout (owner, 2026-10-04: "side bars need to be draggable/customizable"):
 * rail and panel widths, either collapsed, which rail sections are folded, whether the
 * taskbar shows. browser-layout.json in userData; normalizeLayout() sanitizes it.
 */
let prefs = null;
function layoutFile() {
  return path.join(electron().app.getPath("userData"), "browser-layout.json");
}
function getPrefs() {
  if (prefs) return prefs;
  let raw = {};
  try { raw = JSON.parse(require("node:fs").readFileSync(layoutFile(), "utf8")); } catch { /* defaults */ }
  prefs = rail.normalizeLayout(raw);
  return prefs;
}
let prefsTimer = null;
function setPrefs(patch) {
  prefs = rail.normalizeLayout({ ...getPrefs(), ...patch });
  clearTimeout(prefsTimer);
  // A drag sends a width per frame; the file is written once it settles.
  prefsTimer = setTimeout(() => {
    try {
      require("node:fs").mkdirSync(path.dirname(layoutFile()), { recursive: true });
      require("node:fs").writeFileSync(layoutFile(), JSON.stringify(prefs, null, 2));
    } catch { /* best-effort: the next open uses the defaults */ }
  }, 400);
  return prefs;
}
/** A gutter is being dragged: page views are hidden so the chrome page keeps the mouse. */
let dragging = false;
/** The living desktop's taskbar (browser-taskbar.cjs): its view, and whether its menu is open. */
let taskbarView = null;
let taskbarOpen = false;
let taskbarStatus = "off";
/** awconnect loaded into the web partition (browser-extensions.cjs): {ok, id, version} | {ok: false, error}. */
let awconnect = { ok: false, error: "not loaded yet" };
let awconnectLoading = null;
function ensureAwconnect() {
  if (awconnect.ok || awconnectLoading) return awconnectLoading;
  const ses = electron().session.fromPartition(PARTITION);
  awconnectLoading = extensions.loadAwconnect(ses).then((result) => {
    awconnect = result;
    awconnectLoading = null;
    pushState();
    return result;
  });
  return awconnectLoading;
}

/** Open awconnect's own UI as a tab of yours (reusing one that is open). */
async function openAwconnect() {
  const loaded = awconnect.ok ? awconnect : await ensureAwconnect();
  if (!loaded || !loaded.ok) return { ok: false, error: (loaded && loaded.error) || "awconnect is not loaded" };
  const url = extensions.uiUrl(loaded.id, loaded.ui);
  const open = tabs.tabs.find((t) => t.kind === "extension");
  if (open) {
    showTab(open.id);
    return { ok: true };
  }
  const opened = openTab("you", url, { kind: "extension", label: "awconnect" });
  return opened.ok ? { ok: true } : { ok: false, error: opened.error };
}
/** Told whenever the window moves, resizes, hides or closes (main re-seats the docked avatar). */
const geometryListeners = new Set();
function notifyGeometry(reason) {
  for (const listener of geometryListeners) {
    try { listener(reason); } catch { /* one listener never stops the others */ }
  }
}
function hostDocked() {
  try { return Boolean(shellHost && shellHost.docked()); } catch { return false; }
}
let pushTimer = null;
/** History + bookmarks (browser-library.json in userData), opened on first use. */
let library = null;
function getLibrary() {
  if (!library) library = createLibrary({ file: path.join(electron().app.getPath("userData"), "browser-library.json") });
  return library;
}
/** The downloads shelf: every download is a row, including one an agent was refused. */
const downloads = createDownloads();
/** The last AitherDesktop push: {ok, status, url, at} -- shown in state() so a dead feed is visible. */
let lastContextPush = null;
const gate = new policy.AgentGate();
gate.on("change", (snap) => {
  pushState();
  // An agent handing the wheel over must be SEEN: raise the window and flash it.
  if (snap && snap.handoff && win && !win.isDestroyed()) {
    win.show();
    win.focus();
    win.flashFrame(true);
  }
});

function homeUrl() {
  const verdict = policy.sanitizeUrl(process.env.DESK_BROWSER_HOME || "https://aitherium.com");
  return verdict.ok ? verdict.url : "https://aitherium.com/";
}

function alive(view) {
  return Boolean(view && view.webContents && !view.webContents.isDestroyed());
}

function viewOf(id) {
  const view = id == null ? null : views.get(id);
  return alive(view) ? view : null;
}

/** The tab on screen (the owner's toolbar, Ask about this page, the context push). */
function activeView() {
  return viewOf(tabs.active);
}

/** Every tab, with what the strip shows. */
function tabList() {
  const snap = tabs.snapshot();
  return snap.tabs.map((t) => {
    const view = viewOf(t.id);
    const tab = tabs.get(t.id) || {};
    return {
      id: t.id,
      by: t.by,
      kind: t.kind || "web",
      pinned: Boolean(t.pinned),
      label: tab.label || "",
      badge: tab.key === "inbox" && inbox.count > 0 ? inbox.count : 0,
      active: t.id === snap.active,
      agentTarget: t.id === snap.agentTarget,
      url: view ? view.webContents.getURL() : "",
      title: view ? view.webContents.getTitle() : "",
      loading: view ? view.webContents.isLoading() : false,
    };
  });
}

function state() {
  const view = activeView();
  if (!win || win.isDestroyed() || !view) return { open: false, agent: gate.snapshot(), tabs: [] };
  const wc = view.webContents;
  const history = wc.navigationHistory;
  return {
    open: true,
    url: wc.getURL(),
    title: wc.getTitle(),
    loading: wc.isLoading(),
    canGoBack: history ? history.canGoBack() : false,
    canGoForward: history ? history.canGoForward() : false,
    agent: gate.snapshot(),
    contextPush: lastContextPush,
    tabs: tabList(),
    bookmarked: getLibrary().isBookmarked(wc.getURL()),
    downloads: downloads.list(),
    rail: railState(),
  };
}

function pushState() {
  const payload = state();
  if (win && !win.isDestroyed()) win.webContents.send("desk:browser-state", payload);
  if (alive(panelView)) panelView.webContents.send("desk:browser-state", payload);
}

/** Deny-by-default permissions and agent-time downloads on the page partition. */
function hardenSession(ses) {
  if (sessionHardened) return;
  sessionHardened = true;
  ses.setPermissionRequestHandler((_wc, permission, callback) => callback(policy.allowPermission(permission)));
  ses.setPermissionCheckHandler((_wc, permission) => policy.allowPermission(permission));
  if (typeof ses.setDevicePermissionHandler === "function") ses.setDevicePermissionHandler(() => false);
  // A download an AGENT triggers lands on the owner's disk unseen; while the agent
  // drives (and the owner has not taken over) downloads are cancelled. The owner
  // takes over to download. Either way it is a ROW on the shelf (browser-downloads):
  // a silent cancel read as "the download button is broken".
  ses.on("will-download", (_event, item) => {
    const g = gate.snapshot();
    const meta = { filename: item.getFilename(), url: item.getURL(), total: item.getTotalBytes() };
    if (g.driving && !g.paused) {
      item.cancel();
      downloads.start({ ...meta, blocked: true });
      pushState();
      return;
    }
    const id = downloads.start(meta);
    item.on("updated", (_e, st) => {
      downloads.update(id, { received: item.getReceivedBytes(), total: item.getTotalBytes(),
        state: st === "interrupted" ? "interrupted" : "progressing" });
      pushState();
    });
    item.once("done", (_e, st) => {
      downloads.update(id, { state: st, received: item.getReceivedBytes(), path: item.getSavePath() });
      pushState();
    });
    pushState();
  });
}

async function loadInView(view, url) {
  try {
    await view.webContents.loadURL(url);
  } catch (error) {
    // A redirect or a client-side navigation aborts the first load (-3); the
    // page still arrives. Anything else is a real failure.
    if (!/ERR_ABORTED|\(-3\)/.test(String(error && error.message))) throw error;
  }
}

function layout() {
  if (!win || win.isDestroyed()) return;
  // The rail (avatar slot, every Aither page, the layer strip) is the chrome page's
  // own left column; page views and the panel sit to its right (browser-rail.cjs).
  const rects = currentRects();
  for (const [id, view] of views) {
    if (!alive(view)) continue;
    const shown = id === tabs.active && !dragging;
    view.setVisible(shown);
    if (shown) view.setBounds(rects.page);
  }
  if (alive(panelView)) {
    panelView.setVisible(!dragging && rects.panel.width > 0);
    panelView.setBounds(rects.panel);
  }
  if (alive(taskbarView)) {
    const shown = !dragging && rects.taskbar.height > 0;
    taskbarView.setVisible(shown);
    // Its Start menu and tray popovers open UPWARD: while one is open the view grows
    // over the page (the page is still there underneath; closing it shrinks back).
    if (shown) taskbarView.setBounds(taskbarOpen ? taskbar.expandedRect(rects) : rects.taskbar);
  }
  notifyGeometry("layout");
}

function currentRects() {
  return currentRectsFor(win.getContentBounds(), hostDocked());
}

/** The rail's avatar slot in screen DIP, or null (no window, rail collapsed, avatar floating). */
function avatarSlotRect() {
  if (!win || win.isDestroyed() || win.isMinimized() || !win.isVisible()) return null;
  const bounds = win.getContentBounds();
  const slot = currentRectsFor(bounds, true).avatar;
  return slot ? { x: bounds.x + slot.x, y: bounds.y + slot.y, width: slot.width, height: slot.height } : null;
}
function currentRectsFor(bounds, docked) {
  const p = getPrefs();
  return rail.railLayout(bounds, {
    collapsed: p.railCollapsed, docked, chromeHeight: CHROME_HEIGHT, railWidth: p.railWidth,
    panelWidth: p.panelWidth, panelCollapsed: p.panelCollapsed,
    taskbarHeight: p.taskbar && taskbarStatus !== "unavailable" ? rail.TASKBAR_HEIGHT : 0,
  });
}

/** awconnect, built in: a row under Online that opens its own UI (browser-extensions.cjs). */
function withAwconnectRow(sections, active) {
  const row = {
    kind: "browser", id: "awconnect", label: "awconnect", icon: "globe", active: Boolean(active && active.kind === "extension"),
    hint: awconnect.ok ? `The awconnect extension ${awconnect.version}, built into this browser`
      : `awconnect is not loaded: ${awconnect.error}`,
  };
  const online = sections.find((sec) => sec.name === "Online");
  if (online) online.rows = [...online.rows, row];
  else sections.push({ name: "Online", rows: [row] });
  // Media Forge: its own UI, in a tab (images, clips, 3D, avatars on the fleet GPU).
  const apps = sections.find((sec) => sec.name === "Apps");
  const forge = { kind: "browser", id: "forge", label: "Media Forge", icon: "image", active: false,
    hint: "Media Forge: images, clips, 3D and avatars on the fleet's GPU" };
  if (apps) apps.rows = [forge, ...apps.rows];
  return sections;
}

/** What the rail shows: sections of pages and apps, the layer strip, collapsed or not. */
function railState() {
  const active = tabs.get(tabs.active);
  let overlayVisible = false;
  try { overlayVisible = Boolean(shellHost && shellHost.overlayVisible()); } catch { /* off */ }
  const docked = hostDocked();
  const p = getPrefs();
  const rects = win && !win.isDestroyed() ? currentRects() : null;
  return {
    collapsed: p.railCollapsed,
    width: rects ? rects.rail.width : rail.railWidth(p.railCollapsed, p.railWidth),
    gutter: rail.GUTTER,
    panel: rects ? { x: rects.panel.x, width: rects.panel.width, collapsed: p.panelCollapsed } : null,
    taskbar: { on: p.taskbar, status: taskbarStatus, height: rects ? rects.taskbar.height : 0 },
    collapsedSections: p.collapsedSections,
    docked,
    slot: rects ? rects.avatar : null,
    sections: withAwconnectRow(rail.railSections(require("./console-window.cjs").PANES,
      { activePane: active && active.by === "you" ? active.paneId || null : null }), active),
    awconnect: awconnect.ok ? { ok: true, version: awconnect.version } : { ok: false, error: awconnect.error },
    layers: rail.layerRows({ docked, overlayVisible, browserOpen: true }),
  };
}

/**
 * What a URL opens as: a web page, an aither:// page (internal), or a hosted pane
 * (AitherOS Online in its own signed-in partition). Unknown aither:// pages refuse.
 */
function classify(url) {
  const parsed = internal.parseInternalUrl(url);
  if (!parsed) return { kind: "web", url, paneId: null, partition: null };
  const route = internal.resolveRequest(url, { rendererUrl: internalConfig.rendererUrl,
    hostedUrl: internalConfig.hostedUrl });
  if (route.type === "hosted") return { kind: "hosted", url: route.url, paneId: parsed.paneId, partition: route.partition };
  if (route.type === "missing" && route.status === 404) return { kind: "refused", error: route.reason };
  return { kind: "internal", url, paneId: parsed.paneId, partition: null };
}

/** The aither:// handler, on the internal session only, once. */
function ensureInternalSession() {
  if (internalReady) return;
  const { session } = electron();
  const ses = session.fromPartition(internal.INTERNAL_PARTITION);
  internal.installInternalProtocol(ses, {
    rendererUrl: () => (typeof internalConfig.rendererUrl === "function"
      ? internalConfig.rendererUrl() : internalConfig.rendererUrl),
    hostedUrl: internalConfig.hostedUrl,
    // Read at request time: main may configure after the session exists.
    modelFile: (name) => (typeof internalConfig.modelFile === "function" ? internalConfig.modelFile(name) : null),
  });
  // The microphone, for an aither: page only -- the grant the console's default
  // session gave its panes (Inbox dictation, Settings "Grant mic"). Web tabs live
  // in another session and keep policy.allowPermission's deny-all.
  internal.installInternalPermissions(ses);
  internalReady = true;
}

/** A hosted tab is signed in BEFORE it loads, the way the console's hosted pane is. */
async function loadHostedTab(view, url) {
  const prepare = internalConfig.hostedPrepare;
  if (typeof prepare === "function") {
    try { await prepare(); } catch { /* it still loads; the site shows its own sign-in */ }
  }
  if (alive(view)) await loadInView(view, url);
}

/** AitherOS Online's signed-in partition (the hosted pane's), which the taskbar shares. */
function onlinePartition() {
  const hosted = require("./console-window.cjs").PANES.find((pane) => pane && pane.kind === "hosted");
  return (hosted && hosted.partition) || PARTITION;
}

/** A page the taskbar asked for: an aitherium.com page in the pinned Online tab, else a web tab. */
function openFromTaskbar(url) {
  const route = taskbar.routeFor(url);
  if (route === "web") return void openTab("you", url);
  if (route !== "online") return;
  openInternal("desktop", null);
  const tab = tabForPane("desktop");
  const view = tab ? viewOf(tab.id) : null;
  if (view && view.webContents.getURL() !== url) void loadHostedTab(view, url).catch(() => {});
}

/** The living desktop's taskbar along the bottom (browser-taskbar.cjs), created once per window. */
function ensureTaskbar() {
  if (!win || win.isDestroyed() || alive(taskbarView) || !getPrefs().taskbar) return;
  const url = taskbar.taskbarUrl(internal.onlineUrl());
  if (!url) return;
  const { WebContentsView } = electron();
  taskbarView = new WebContentsView({
    webPreferences: internal.tabPreferences("hosted", { webPartition: PARTITION, hostedPartition: onlinePartition() }),
  });
  if (typeof taskbarView.setBackgroundColor === "function") taskbarView.setBackgroundColor("#00000000");
  taskbarStatus = "loading";
  taskbarOpen = false;
  const wc = taskbarView.webContents;
  // Only a CLICK on a loaded taskbar opens a tab. A redirect, or a page script moving
  // itself while it loads (a route that is not deployed, a sign-in bounce), never
  // does: it would open AitherOS Online on its own and take the screen. Measured in
  // browser-tabs-smoke 2026-10-04 -- the pinned Online tab stole an agent's popup focus.
  let loadedAt = 0;
  const clicked = () => taskbarStatus === "ok" && loadedAt && Date.now() - loadedAt > taskbar.SETTLE_MS;
  wc.on("did-finish-load", () => { loadedAt = Date.now(); });
  wc.setWindowOpenHandler(({ url: target }) => {
    if (clicked()) openFromTaskbar(target);
    return { action: "deny" };
  });
  wc.on("will-navigate", (event, target) => {
    if (taskbar.routeFor(target) === "stay") return;
    event.preventDefault();
    if (clicked()) openFromTaskbar(target);
  });
  wc.on("will-redirect", (event, target) => {
    if (taskbar.routeFor(target) === "stay") return;
    // Bounced elsewhere (not deployed, signed out): there is no taskbar to show.
    event.preventDefault();
    taskbarStatus = "unavailable";
    layout();
    pushState();
  });
  wc.on("did-navigate", (_event, _url, httpResponseCode) => {
    taskbarStatus = taskbar.isUnavailable(httpResponseCode) ? "unavailable" : "ok";
    layout();
    pushState();
  });
  wc.on("did-fail-load", (_event, code, _desc, _url, isMainFrame) => {
    if (!isMainFrame || code === -3) return;
    taskbarStatus = "unavailable";
    layout();
    pushState();
  });
  wc.on("page-title-updated", (_event, title) => {
    const open = taskbar.isOpenTitle(title);
    if (open === taskbarOpen) return;
    taskbarOpen = open;
    layout();
  });
  win.contentView.addChildView(taskbarView);
  layout();
  void loadHostedTab(taskbarView, url).catch(() => {
    taskbarStatus = "unavailable";
    layout();
    pushState();
  });
}

/**
 * Open a tab owned by `by` ("you" | "agent") and load `url` in it.
 * @returns {{ok: true, id: number, view: object} | {ok: false, error: string}}
 */
function openTab(by, url, { activate = true, after = null, pinned = false, key = null, label = "",
  hostedPartition = null, kind: wantKind = null } = {}) {
  if (!win || win.isDestroyed()) return { ok: false, error: "The Aither Browser is not open." };
  // Main wires the pane's handlers (and where the bundle and AitherOS Online are)
  // BEFORE the page is classified or loads: a pane talks to main the moment it loads.
  if (by === "you" && internal.isInternalUrl(url) && typeof internalConfig.beforeInternal === "function") {
    try { internalConfig.beforeInternal(); } catch { /* the page shows its own error */ }
  }
  // awconnect's own pages: only the owner, only the loaded extension's id.
  const extensionTab = wantKind === "extension";
  if (extensionTab && (by !== "you" || !extensions.isExtensionPage(url, awconnect.id))) {
    return { ok: false, error: "not an awconnect page" };
  }
  // (a chrome-extension: URL classifies as "web"; extensionTab below makes it its own kind)
  const target = classify(url);
  if (target.kind === "refused") return { ok: false, error: target.error };
  // A pinned https tab that names a partition (Workspace) is hosted too: same login as Online.
  const hosted = target.kind === "web" && hostedPartition && internal.isHostedSite(url);
  const kind = extensionTab ? "extension" : hosted ? "hosted" : target.kind;
  const added = tabs.add(by, { activate, after, kind, pinned, key });
  if (!added.ok) return added;
  const tab = tabs.get(added.id);
  tab.paneId = target.paneId;
  tab.label = label;
  if (kind === "internal") ensureInternalSession();
  const { WebContentsView } = electron();
  // Web content gets NO preload (tabPreferences("web")); an aither:// tab gets the
  // one internal preload, which hands the page only its own pane's bridge.
  // awconnect's own page gets the compat shim its worker has (withCompat adds a preload
  // for kind "extension" ONLY; a web tab's preferences pass through untouched).
  const view = new WebContentsView({
    webPreferences: extensions.withCompat(kind, internal.tabPreferences(kind === "extension" ? "web" : kind, {
      webPartition: PARTITION, hostedPartition: target.partition || hostedPartition,
    })),
  });
  views.set(added.id, view);
  wirePage(view.webContents, added.id);
  win.contentView.addChildView(view);
  // The panel and the taskbar stay on top of every page view (an open Start menu
  // grows over the page).
  if (alive(panelView)) win.contentView.addChildView(panelView);
  if (alive(taskbarView)) win.contentView.addChildView(taskbarView);
  layout();
  pushState();
  if (kind === "hosted") void loadHostedTab(view, target.url).catch(() => {});
  else void loadInView(view, target.url).catch(() => {});
  return { ok: true, id: added.id, view };
}

/** aither://search/?q=<text> in the owner's search tab (reused), which runs the query. */
function openSearch(text) {
  if (!openInternal("search", null)) return false;
  const tab = tabForPane("search");
  const view = tab ? viewOf(tab.id) : null;
  if (!view) return false;
  void loadInView(view, `aither://search/?q=${encodeURIComponent(String(text).slice(0, 500))}`).catch(() => {});
  return true;
}

/** Media Forge's own UI in a web tab of yours (search-client forgeUrl finds where it runs). */
async function openForge() {
  const where = await require("./search-window.cjs").client().forgeUrl();
  if (!where.ok) return where;
  const opened = openTab("you", where.url);
  return opened.ok ? { ok: true } : { ok: false, error: opened.error };
}

/** The pinned front of the strip: Inbox, AitherOS Online, Workspace -- opened once each. */
function ensurePinned() {
  for (const pin of internal.pinnedTabs({ workspaceUrl: internalConfig.workspaceUrl })) {
    if (tabs.byKey(pin.key)) continue;
    openTab("you", pin.url, { activate: false, pinned: true, key: pin.key, label: pin.label,
      hostedPartition: pin.hostedPartition || null });
  }
}

/** The owner's tab already showing a pane (aither://<pane>), or null. */
function tabForPane(paneId) {
  return tabs.tabs.find((t) => t.paneId === paneId && t.by === "you") || null;
}

/**
 * THE console door (plan slice 9): raise the browser on aither://<pane>, with the
 * pinned tabs in place. Reuses the pane's tab; `param` (a card id) reloads it on
 * that card. Returns false for a pane that does not exist.
 */
function openInternal(paneId, param = null, opts = {}) {
  const pane = internal.paneById(paneId);
  if (!pane) return false;
  const url = internal.internalUrl(pane, param);
  createBrowserWindow({ ...opts, url: null, home: false });
  ensurePinned();
  const existing = tabForPane(pane.id);
  if (existing) {
    showTab(existing.id);
    const view = viewOf(existing.id);
    if (param != null && view && existing.kind === "internal" && view.webContents.getURL() !== url) {
      void loadInView(view, url).catch(() => {});
    }
  } else {
    const opened = openTab("you", url, { activate: true });
    if (!opened.ok) return false;
  }
  return true;
}

/** Main's hooks for aither:// pages: where the renderer bundle and hosted panes are. */
function configureInternal(config = {}) {
  internalConfig = { ...internalConfig, ...config };
}

/** Every internal tab hears a broadcast (the theme changing, say). */
function sendToInternalTabs(channel, payload) {
  for (const t of tabs.tabs) {
    if (t.kind !== "internal") continue;
    const view = viewOf(t.id);
    if (view) {
      try { view.webContents.send(channel, payload); } catch { /* a page mid-navigation */ }
    }
  }
}

/**
 * A pane's own "close" (Esc, its close button) from an aither:// tab closes THAT tab,
 * never the browser. True when the sender was an internal tab.
 */
function closeInternalTabOf(sender) {
  for (const t of tabs.tabs) {
    const view = viewOf(t.id);
    if (view && view.webContents === sender && t.kind === "internal") {
      if (!t.pinned) closeTab(t.id, "you");
      return true;
    }
  }
  return false;
}

/** The inbox count on the pinned Inbox tab and the browser's taskbar button. */
function setInboxBadge({ count = 0, image = null, tooltip = "" } = {}) {
  inbox = { count: Number(count) || 0, image, tooltip };
  if (win && !win.isDestroyed()) {
    try {
      win.setOverlayIcon(inbox.count > 0 ? inbox.image : null, inbox.count > 0 ? inbox.tooltip : "");
    } catch { /* not every platform draws overlays; the tab still carries the number */ }
  }
  pushState();
}

/** Close a tab (the owner, or the agent for its own). The last tab closing opens a fresh home tab. */
function closeTab(id, by = "you") {
  const closed = tabs.close(id, by);
  if (!closed.ok) return closed;
  const view = views.get(id);
  views.delete(id);
  if (alive(view)) {
    if (win && !win.isDestroyed()) win.contentView.removeChildView(view);
    view.webContents.close();
  }
  if (tabs.tabs.length === 0 && win && !win.isDestroyed()) openTab("you", homeUrl());
  layout();
  pushState();
  return { ok: true, closed: id, active: tabs.active };
}

function showTab(id) {
  const shown = tabs.activate(id);
  if (shown.ok) {
    layout();
    pushState();
    scheduleContextPush(id);
  }
  return shown;
}

function wirePage(wc, id) {
  const kindOf = () => (tabs.get(id) || {}).kind || "web";
  // A popup becomes a TAB beside its opener, owned by the opener's owner (an agent
  // page's popup is still the agent's), never a second window. A web page may only
  // open web pages; an aither:// page may open another Aither page or a web tab.
  wc.setWindowOpenHandler(({ url }) => {
    const opener = tabs.get(id);
    if (!opener) return { action: "deny" };
    if (policy.isNavigable(url)) {
      openTab(opener.by, url, { activate: true, after: id });
    } else if (opener.kind === "internal" && internal.isInternalUrl(url)) {
      openTab("you", url, { activate: true, after: id });
    }
    return { action: "deny" };
  });
  // Navigation is judged per tab KIND (browser-internal navigationVerdict): a web
  // tab never reaches aither://; an internal tab sends a web link to a web tab.
  const verdictFor = (url, opts) => (kindOf() === "extension"
    // awconnect's pages stay on awconnect; a web link from it opens a web tab.
    ? (extensions.isExtensionPage(url, awconnect.id) ? "allow" : (opts && opts.frame) ? "deny"
      : internal.navigationVerdict("web", url) === "allow" ? "web-tab" : "deny")
    : internal.navigationVerdict(kindOf(), url, opts));
  const guard = (event, url) => {
    const verdict = verdictFor(url);
    if (verdict === "allow") return;
    event.preventDefault();
    const opener = tabs.get(id);
    if (verdict === "web-tab" && opener) openTab(opener.by, url, { activate: true, after: id });
  };
  wc.on("will-navigate", guard);
  // A redirect cannot be split into another tab: anything but "allow" stops it.
  wc.on("will-redirect", (event, url) => {
    if (verdictFor(url) !== "allow") event.preventDefault();
  });
  // Frames: a web page cannot frame aither:// (its session has no handler either).
  wc.on("will-frame-navigate", (details) => {
    if (!details || details.isMainFrame) return;
    const verdict = kindOf() === "extension" ? verdictFor(details.url, { frame: true })
      : internal.navigationVerdict(kindOf(), details.url, { frame: true });
    if (verdict !== "allow") details.preventDefault();
  });
  wc.on("will-attach-webview", (event) => event.preventDefault());
  for (const name of ["did-navigate", "did-navigate-in-page", "page-title-updated", "did-start-loading", "did-stop-loading"]) {
    wc.on(name, () => pushState());
  }
  wc.on("did-stop-loading", () => scheduleContextPush(id));
  // History: the finished page, remembered with WHO opened its tab.
  wc.on("did-stop-loading", () => {
    const tab = tabs.get(id);
    // Console pages are not "history": the address bar suggests them by name instead.
    if (tab && tab.kind === "web") getLibrary().visit(wc.getURL(), wc.getTitle(), tab.by);
  });
}

/**
 * Tell AitherDesktop what this window has open (browser-context-push.cjs): the
 * page's machine layer, never its text or a field value. Debounced, so a page
 * that redirects twice is pushed once.
 */
function scheduleContextPush(id) {
  if (!contextPush.enabled() || id !== tabs.active) return;
  // Only WEB pages are "what the user is browsing"; a console page or the signed-in
  // desktop is the desk itself.
  if ((tabs.get(id) || {}).kind !== "web") return;
  clearTimeout(pushTimer);
  pushTimer = setTimeout(async () => {
    // Only the tab on screen is "what the user is looking at".
    if (id !== tabs.active) return;
    const view = viewOf(id);
    if (!view) return;
    const wc = view.webContents;
    const url = wc.getURL();
    if (!contextPush.pushable(url)) return;
    try {
      const page = await wc.executeJavaScriptInIsolatedWorld(ISOLATED_WORLD_ID, [{ code: contextPush.CONTEXT_SCRIPT }], false);
      const verdict = await contextPush.postPush(contextPush.buildPush(page, { trigger: "page_loaded" }));
      lastContextPush = { ...verdict, url, at: Date.now() };
    } catch (error) {
      lastContextPush = { ok: false, status: 0, reason: String(error && error.message || error).slice(0, 200), url, at: Date.now() };
    }
    pushState();
  }, CONTEXT_PUSH_DELAY_MS);
}

/**
 * Open (or raise) the Aither Browser.
 * @param {{askAgent?: (prompt: string) => Promise<{ok?: boolean, reply?: string}>, url?: string}} [opts]
 */
function createBrowserWindow({ askAgent: ask = null, url = null, home = true } = {}) {
  if (typeof ask === "function") askAgent = ask;
  wireIpc();
  const target = url ? policy.sanitizeUrl(url) : null;
  if (win && !win.isDestroyed()) {
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
    // A link the OWNER opened from elsewhere in the desk: a new tab of theirs.
    if (target && target.ok) openTab("you", target.url);
    return win;
  }
  const { BrowserWindow, WebContentsView, session } = electron();
  hardenSession(session.fromPartition(PARTITION));
  void ensureAwconnect();

  win = new BrowserWindow({
    width: 1320,
    height: 880,
    minWidth: 720,
    minHeight: 480,
    show: false,
    title: "Aither Browser",
    backgroundColor: "#0f1218",
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, "browser-chrome-preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  win.webContents.on("will-navigate", (event) => event.preventDefault());

  tabs = new TabSet();
  panelView = createAssistantPanel(WebContentsView);
  win.contentView.addChildView(panelView);
  win.on("resize", layout);
  // A docked avatar is an owned window: it follows the browser, so every geometry
  // change re-seats it (main listens through onGeometry).
  for (const evt of ["move", "minimize", "restore", "show", "hide", "maximize", "unmaximize", "enter-full-screen", "leave-full-screen"]) {
    win.on(evt, () => notifyGeometry(evt));
  }
  win.once("ready-to-show", () => {
    ensureTaskbar();
    layout();
    win.show();
    win.focus();
    setInboxBadge(inbox);
  });
  win.on("closed", () => {
    for (const view of [...views.values(), panelView, taskbarView]) {
      if (alive(view)) view.webContents.close();
    }
    taskbarView = null;
    taskbarOpen = false;
    taskbarStatus = "off";
    views.clear();
    tabs = new TabSet();
    win = null;
    panelView = null;
    gate.release();
    notifyGeometry("closed");
  });

  void win.loadFile(path.join(__dirname, "browser-chrome.html"));
  // `home: false` is the console door (openInternal): it opens its own pane tab,
  // so a home page underneath it would be one more tab nobody asked for.
  if (home || (target && target.ok)) openTab("you", target && target.ok ? target.url : homeUrl());
  return win;
}

/**
 * The ONE loader for the assistant panel: builds the view, locks it down and
 * loads ASSISTANT_PANEL. Swapping in the awkit Connect panel means changing
 * ASSISTANT_PANEL (or this function) only -- the window, page view, toolbar,
 * take-over gate and MCP tools do not know which panel is mounted. The panel
 * speaks only the three desk:browser-state / desk:browser-ask channels.
 * @param {typeof import("electron").WebContentsView} WebContentsView
 */
function createAssistantPanel(WebContentsView, panel = ASSISTANT_PANEL) {
  const view = new WebContentsView({
    webPreferences: {
      preload: path.join(__dirname, panel.preload),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  view.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  view.webContents.on("will-navigate", (event) => event.preventDefault());
  void view.webContents.loadFile(path.join(__dirname, panel.html));
  return view;
}

function waitForIdle(wc, timeoutMs = IDLE_WAIT_MS) {
  if (!wc.isLoading()) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(done, timeoutMs);
    function done() {
      clearTimeout(timer);
      wc.removeListener("did-stop-loading", done);
      resolve();
    }
    wc.once("did-stop-loading", done);
  });
}

// Shared by every page script. Pure strings; nothing here reads an argument.
const PAGE_HELPERS = `
  const clean = (t, n = 120) => String(t == null ? "" : t).replace(/\\s+/g, " ").trim().slice(0, n);
  const labelOf = (el) => {
    const aria = el.getAttribute("aria-label");
    if (aria && clean(aria)) return clean(aria);
    const by = el.getAttribute("aria-labelledby");
    if (by) {
      const t = by.split(/\\s+/).map((id) => document.getElementById(id)).filter(Boolean).map((n) => n.innerText).join(" ");
      if (clean(t)) return clean(t);
    }
    if (el.id) {
      try {
        const l = document.querySelector('label[for="' + CSS.escape(el.id) + '"]');
        if (l && clean(l.innerText)) return clean(l.innerText);
      } catch (e) { /* an id CSS.escape cannot handle */ }
    }
    const wrap = el.closest("label");
    if (wrap) {
      // The label's OWN words: a <select> inside its label would otherwise lend it
      // every option ("Support topic 1. Multiplayer Other").
      const copy = wrap.cloneNode(true);
      copy.querySelectorAll("select, textarea, input, button, option").forEach((n) => n.remove());
      if (clean(copy.textContent)) return clean(copy.textContent);
    }
    if (el.placeholder) return clean(el.placeholder);
    const tag = el.tagName;
    if (tag === "A" || tag === "BUTTON" || tag === "SUMMARY" || el.getAttribute("role")) {
      const t = clean(el.innerText || el.value);
      if (t) return t;
    }
    if (el.title) return clean(el.title);
    if (el.name) return clean(el.name);
    return "";
  };
`;

/**
 * The page-side script for one agent action. Pure; every argument is embedded
 * with JSON.stringify so a selector, ref or text can never break out of its literal.
 *
 * Element actions take a TARGET: {ref} from the last browser_snapshot (the map
 * lives in the isolated world, so page JS can neither read nor forge it, and a
 * navigation clears it), or {selector}.
 */
function scriptFor(action, args = {}) {
  if (action === "read") {
    return `(() => ({ ok: true, url: location.href, title: document.title,
      text: (document.body ? document.body.innerText : "").slice(0, ${READ_TEXT_CHARS}),
      links: Array.from(document.querySelectorAll("a[href]")).slice(0, ${READ_LINKS})
        .map((a) => ({ text: (a.innerText || "").trim().slice(0, 120), href: a.href })) }))()`;
  }
  if (action === "selection") {
    return `(() => ({ ok: true, text: String(window.getSelection ? window.getSelection() : "").slice(0, 4000) }))()`;
  }
  if (action === "overview") {
    // What the overlay host shows AitherOS Online about the tab on screen.
    return `(() => { const clean = (t, n) => String(t == null ? "" : t).replace(/\\s+/g, " ").trim().slice(0, n);
      const meta = document.querySelector('meta[name="description"], meta[property="og:description"]');
      return { ok: true, url: location.href, title: document.title,
        description: meta ? clean(meta.getAttribute("content"), 300) : "",
        headings: Array.from(document.querySelectorAll("h1, h2, h3")).slice(0, 20).map((h) => clean(h.innerText, 160)),
        text: (document.body ? document.body.innerText : "").slice(0, ${READ_TEXT_CHARS}) }; })()`;
  }
  if (action === "snapshot") {
    return `(() => { ${PAGE_HELPERS}
      const refs = new Map();
      window.__aitherRefs = refs;
      const SELECTOR = 'input:not([type=hidden]), textarea, select, button, a[href], summary, [contenteditable=""], '
        + '[contenteditable="true"], [role=button], [role=link], [role=checkbox], [role=radio], [role=switch], '
        + '[role=tab], [role=menuitem], [role=option], [role=combobox], [role=textbox]';
      const visible = (el) => {
        const r = el.getBoundingClientRect();
        if (r.width <= 0 || r.height <= 0) return false;
        const cs = getComputedStyle(el);
        return cs.visibility !== "hidden" && cs.display !== "none";
      };
      const elements = [];
      let total = 0;
      for (const el of document.querySelectorAll(SELECTOR)) {
        if (!visible(el)) continue;
        total += 1;
        if (elements.length >= ${SNAPSHOT_MAX}) continue;
        const ref = "e" + (elements.length + 1);
        refs.set(ref, el);
        const tag = el.tagName.toLowerCase();
        const role = el.getAttribute("role");
        const item = { ref, tag, label: labelOf(el) };
        if (role) item.role = role;
        if (tag === "input") item.type = String(el.type || "text").toLowerCase();
        if (el.disabled) item.disabled = true;
        if (el.required) item.required = true;
        const box = item.type === "checkbox" || item.type === "radio" || role === "checkbox" || role === "radio" || role === "switch";
        if (box) {
          item.checked = typeof el.checked === "boolean" ? el.checked : el.getAttribute("aria-checked") === "true";
        } else if (tag === "select") {
          const chosen = el.options[el.selectedIndex];
          item.value = chosen ? clean(chosen.text, 80) : "";
          item.options = Array.from(el.options).slice(0, 30).map((o) => clean(o.text, 80));
        } else if (tag === "input" || tag === "textarea") {
          // A password's VALUE never leaves the page; only whether it is filled.
          item.value = item.type === "password" ? (el.value ? "(filled)" : "") : clean(el.value, 160);
        } else if (el.isContentEditable) {
          item.value = clean(el.innerText, 160);
        }
        if (tag === "a") item.href = String(el.href).slice(0, 200);
        elements.push(item);
      }
      const frames = document.querySelectorAll("iframe").length;
      const out = { ok: true, url: location.href, title: document.title, count: elements.length, total,
        truncated: total > elements.length, elements };
      if (frames) {
        out.frames = frames;
        out.note = "Elements inside iframes (captchas, embedded sign-in, card fields) are not listed. "
          + "Hand those steps to the owner with browser_hand_to_owner.";
      }
      return out; })()`;
  }
  const target = args.target && typeof args.target === "object" ? args.target : { selector: String(args.selector || "") };
  const find = `${PAGE_HELPERS}
      const target = ${JSON.stringify({ ref: target.ref || null, selector: target.selector || null })};
      const el = (() => {
        if (target.ref) {
          const map = window.__aitherRefs;
          const hit = map && map.get(target.ref);
          return hit && hit.isConnected ? hit : { stale: true };
        }
        try { return document.querySelector(target.selector); }
        catch (e) { return { invalid: String(e && e.message || e) }; }
      })();
      if (!el) return { ok: false, error: "no element matches the selector" };
      if (el.stale) return { ok: false, error: "ref " + target.ref + " is stale (the page changed or navigated); call browser_snapshot again" };
      if (el.invalid) return { ok: false, error: "invalid selector: " + el.invalid };
      const label = labelOf(el);`;
  if (action === "click") {
    return `(() => { ${find}
      el.scrollIntoView({ block: "center" }); el.click();
      return { ok: true, clicked: el.tagName.toLowerCase(), label, text: clean(el.innerText || el.value) }; })()`;
  }
  if (action === "type") {
    return `(() => { ${find}
      const text = ${JSON.stringify(String(args.text ?? ""))};
      el.scrollIntoView({ block: "center" });
      el.focus();
      let now;
      if (el.isContentEditable) { el.textContent = text; now = el.textContent; }
      else if (el.tagName === "INPUT" || el.tagName === "TEXTAREA") {
        const desc = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), "value");
        if (desc && desc.set) desc.set.call(el, text); else el.value = text;
        now = el.value;
      } else { return { ok: false, error: "element is not a text field (" + el.tagName.toLowerCase() + ")", label }; }
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
      // Read it back: a field that rewrote or refused the text says so here.
      return { ok: now === text, typed: text.length, into: el.tagName.toLowerCase(), label,
        error: now === text ? undefined : "the field did not keep the text (it holds " + String(now).length + " characters)" }; })()`;
  }
  if (action === "select") {
    return `(() => { ${find}
      if (el.tagName !== "SELECT") return { ok: false, error: "element is not a <select> (" + el.tagName.toLowerCase() + "); click it and its options instead", label };
      const want = ${JSON.stringify(String(args.option ?? ""))};
      const options = Array.from(el.options);
      let i = options.findIndex((o) => o.value === want);
      if (i < 0) i = options.findIndex((o) => clean(o.text) === clean(want));
      if (i < 0) i = options.findIndex((o) => clean(o.text).toLowerCase().includes(clean(want).toLowerCase()));
      if (i < 0) return { ok: false, error: "no option matches", label, options: options.slice(0, 30).map((o) => clean(o.text, 80)) };
      const desc = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value");
      if (desc && desc.set) desc.set.call(el, options[i].value); else el.value = options[i].value;
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
      const chosen = el.options[el.selectedIndex];
      return { ok: el.selectedIndex === i, selected: chosen ? clean(chosen.text, 80) : "", label }; })()`;
  }
  if (action === "check") {
    return `(() => { ${find}
      const want = ${JSON.stringify(Boolean(args.checked))};
      const read = () => (typeof el.checked === "boolean" ? el.checked : el.getAttribute("aria-checked") === "true");
      const isBox = el.type === "checkbox" || el.type === "radio" || ["checkbox", "radio", "switch"].includes(el.getAttribute("role"));
      if (!isBox) return { ok: false, error: "element is not a checkbox, radio or switch", label };
      if (read() !== want) { el.scrollIntoView({ block: "center" }); el.click(); }
      const now = read();
      return { ok: now === want, checked: now, label,
        error: now === want ? undefined : "the box did not change (the page may handle it elsewhere; click its label)" }; })()`;
  }
  if (action === "highlight") {
    return `(() => { ${find}
      el.scrollIntoView({ block: "center" });
      el.style.outline = "3px solid #a855f7";
      el.style.outlineOffset = "3px";
      return { ok: true, label }; })()`;
  }
  if (action === "focus") {
    return `(() => { ${find}
      el.scrollIntoView({ block: "center" }); el.focus();
      return { ok: true, label }; })()`;
  }
  throw new Error(`no page script for ${action}`);
}

/**
 * The view an action runs in. The AGENT acts in its target tab only (never one of
 * the owner's); the owner's own read ("Ask about this page") uses the tab on screen.
 */
function viewFor(who) {
  if (!win || win.isDestroyed()) return { ok: false, error: "The Aither Browser is not open; call browser_open first." };
  if (who === "owner") {
    const view = activeView();
    return view ? { ok: true, view } : { ok: false, error: "no tab is open" };
  }
  const target = tabs.target();
  if (!target.ok) return target;
  const view = viewOf(target.id);
  return view ? { ok: true, view, id: target.id } : { ok: false, error: "the agent's tab is gone; call browser_open" };
}

async function runInPage(action, args, who = "agent") {
  const picked = viewFor(who);
  if (!picked.ok) return { ok: false, error: picked.error };
  const wc = picked.view.webContents;
  await waitForIdle(wc);
  const result = await wc.executeJavaScriptInIsolatedWorld(ISOLATED_WORLD_ID, [{ code: scriptFor(action, args) }], false);
  return result && typeof result === "object" ? result : { ok: false, error: "page returned nothing" };
}

const driver = {
  /**
   * Open a page in the agent's tab (a new agent tab when it has none, or when
   * newTab is set). The tab is SHOWN, so the owner watches where the agent went.
   */
  async open(url, { newTab = false } = {}) {
    createBrowserWindow({ url: null });
    const target = tabs.target();
    let id;
    let view;
    if (target.ok && !newTab) {
      id = target.id;
      view = viewOf(id);
      tabs.agentSwitch(id);
      layout();
      pushState();
      await loadInView(view, url);
    } else {
      const opened = openTab("agent", url);
      if (!opened.ok) return opened;
      id = opened.id;
      view = opened.view;
      await waitForIdle(view.webContents);
    }
    return { ok: true, tab: id, url: view.webContents.getURL(), title: view.webContents.getTitle() };
  },
  tabs: async () => ({ ok: true, tabs: tabList() }),
  async switchTab(id) {
    const switched = tabs.agentSwitch(id);
    if (!switched.ok) return switched;
    layout();
    pushState();
    const view = viewOf(id);
    return { ok: true, tab: id, url: view ? view.webContents.getURL() : "", title: view ? view.webContents.getTitle() : "" };
  },
  closeTab: async (id) => closeTab(id, "agent"),
  read: () => runInPage("read", {}),
  snapshot: () => runInPage("snapshot", {}),
  click: (target) => runInPage("click", { target }),
  type: (target, text) => runInPage("type", { target, text }),
  select: (target, option) => runInPage("select", { target, option }),
  check: (target, checked) => runInPage("check", { target, checked }),
  highlight: (target) => runInPage("highlight", { target }),
  /** A key goes to whatever has focus in the page, as a real input event. */
  async press(key) {
    const picked = viewFor("agent");
    if (!picked.ok) return { ok: false, error: picked.error };
    const keyCode = KEY_CODES[key];
    if (!keyCode) return { ok: false, error: `no key mapping for ${key}` };
    const wc = picked.view.webContents;
    await waitForIdle(wc);
    wc.focus();
    wc.sendInputEvent({ type: "keyDown", keyCode });
    if (key === "Enter" || key === "Space") wc.sendInputEvent({ type: "char", keyCode: key === "Enter" ? "\r" : " " });
    wc.sendInputEvent({ type: "keyUp", keyCode });
    return { ok: true, pressed: key };
  },
  /** The page as a PNG, scaled to SCREENSHOT_MAX_WIDTH. */
  async screenshot() {
    const picked = viewFor("agent");
    if (!picked.ok) return { ok: false, error: picked.error };
    const wc = picked.view.webContents;
    await waitForIdle(wc);
    let image = await wc.capturePage();
    const size = image.getSize();
    if (size.width > SCREENSHOT_MAX_WIDTH) image = image.resize({ width: SCREENSHOT_MAX_WIDTH });
    const out = image.getSize();
    return { ok: true, url: wc.getURL(), title: wc.getTitle(), width: out.width, height: out.height,
      png: image.toPNG().toString("base64") };
  },
};

/** The dispatcher the MCP browser_* tools call (gate first, then the driver). */
function browserAgent({ askAgent: ask = null } = {}) {
  if (typeof ask === "function") askAgent = ask;
  if (!agentHandle) agentHandle = policy.createBrowserAgent({ gate, driver });
  return agentHandle;
}

function fromChrome(event) {
  return Boolean(win && !win.isDestroyed() && event.sender === win.webContents);
}

function fromPanel(event) {
  return Boolean(alive(panelView) && event.sender === panelView.webContents);
}

function wireIpc() {
  if (ipcWired) return;
  ipcWired = true;
  const { ipcMain } = electron();
  // Every handler checks its sender: only OUR chrome/panel pages may drive
  // these, never the page view (which has no preload anyway) or another window.
  ipcMain.handle("desk:browser-state", (event) => (fromChrome(event) || fromPanel(event) ? state() : null));
  // The rail: open an Aither page, run an allowlisted command, pop THE menu, collapse.
  ipcMain.handle("desk:browser-rail", (event, action, arg) => {
    if (!fromChrome(event)) return { ok: false, error: "not the browser's own chrome" };
    const relayout = () => { layout(); pushState(); return { ok: true }; };
    if (action === "collapse") return setPrefs({ railCollapsed: Boolean(arg) }) && relayout();
    if (action === "panel") return setPrefs({ panelCollapsed: Boolean(arg) }) && relayout();
    if (action === "taskbar") {
      setPrefs({ taskbar: Boolean(arg) });
      if (arg) ensureTaskbar();
      return relayout();
    }
    if (action === "section") {
      const name = String(arg || "");
      const folded = new Set(getPrefs().collapsedSections);
      if (folded.has(name)) folded.delete(name); else folded.add(name);
      return setPrefs({ collapsedSections: [...folded] }) && relayout();
    }
    if (action === "reset-layout") return setPrefs({ railWidth: null, panelWidth: null, railCollapsed: false,
      panelCollapsed: false, taskbar: true, collapsedSections: [] }) && relayout();
    // A gutter drag: "drag" true/false brackets it, "rail-width"/"panel-width" carry the size.
    if (action === "drag") {
      dragging = Boolean(arg);
      return relayout();
    }
    if (action === "rail-width") return setPrefs({ railWidth: Number(arg), railCollapsed: false }) && relayout();
    if (action === "panel-width") return setPrefs({ panelWidth: Number(arg), panelCollapsed: false }) && relayout();
    if (action === "page") {
      const ok = openInternal(String(arg || ""), null);
      return ok ? { ok: true } : { ok: false, error: `no Aither page called ${arg}` };
    }
    if (action === "command") {
      if (!rail.railMayRun(arg)) return { ok: false, error: "the rail cannot run that" };
      if (!shellHost) return { ok: false, error: "the desk is still starting" };
      shellHost.run(String(arg));
      setTimeout(() => { layout(); pushState(); }, 150);
      return { ok: true };
    }
    if (action === "browser") {
      if (arg === "awconnect") return openAwconnect();
      if (arg === "forge") return openForge();
      return { ok: false, error: "unknown browser action" };
    }
    if (action === "menu") {
      if (!shellHost) return { ok: false, error: "the desk is still starting" };
      shellHost.popupMenu(win);
      return { ok: true };
    }
    return { ok: false, error: "unknown rail action" };
  });
  ipcMain.handle("desk:browser-navigate", async (event, input) => {
    if (!fromChrome(event)) return { ok: false, reason: "not the browser toolbar" };
    // The OWNER typing aither://<pane> into the address bar opens that console page.
    // Only here: sanitizeUrl (what agents and links pass through) still refuses it.
    const typed = typeof input === "string" ? input.trim() : "";
    const page = internal.parseInternalUrl(typed);
    if (page) {
      return openInternal(page.paneId) ? { ok: true, url: internal.internalUrl(page.paneId) }
        : { ok: false, reason: `no Aither page called ${page.paneId}` };
    }
    const verdict = policy.sanitizeUrl(input);
    // Plain words are a search (aither://search), not an error: "not a web address"
    // was all the address bar said to "best local llm" (owner, 2026-10-04).
    if (!verdict.ok && rail.isSearchText(typed)) {
      return openSearch(typed) ? { ok: true, url: "aither://search/" } : { ok: false, reason: "search is not available" };
    }
    const view = activeView();
    if (!verdict.ok || !view) return verdict.ok ? { ok: false, reason: "browser closed" } : verdict;
    // A console page or a signed-in hosted tab never turns into an arbitrary web
    // page: the address opens in a new web tab instead.
    const active = tabs.get(tabs.active);
    if (active && internal.navigationVerdict(active.kind, verdict.url) !== "allow") {
      const opened = openTab("you", verdict.url);
      return opened.ok ? { ok: true, url: verdict.url, tab: opened.id } : { ok: false, reason: opened.error };
    }
    void loadInView(view, verdict.url).catch(() => {});
    return { ok: true, url: verdict.url };
  });
  // Tabs: the OWNER's strip. They may show or close any tab; a new one is theirs.
  ipcMain.handle("desk:browser-tab-new", (event) => {
    if (!fromChrome(event)) return { ok: false, reason: "not the browser toolbar" };
    const opened = openTab("you", homeUrl());
    return opened.ok ? { ok: true, id: opened.id } : opened;
  });
  // History + bookmarks: the OWNER's toolbar only. No agent tool reads them.
  ipcMain.handle("desk:browser-suggest", (event, text) => {
    if (!fromChrome(event)) return [];
    const q = typeof text === "string" ? text.slice(0, 200) : "";
    // The console's pages first ("settings", "aither://fle"), then bookmarks and history.
    const pages = internal.suggestInternal(q).slice(0, 4);
    return [...pages, ...getLibrary().suggest(q, Math.max(0, 8 - pages.length))];
  });
  ipcMain.handle("desk:browser-bookmark", (event) => {
    const view = activeView();
    if (!fromChrome(event) || !view) return { ok: false };
    const on = getLibrary().toggleBookmark(view.webContents.getURL(), view.webContents.getTitle());
    pushState();
    return { ok: true, bookmarked: on };
  });
  // The Connect panel: what the owner has selected, an agent task, and "Open in Chrome".
  ipcMain.handle("desk:browser-selection", async (event) => {
    if (!fromPanel(event)) return { ok: false, text: "" };
    return runInPage("selection", {}, "owner").catch(() => ({ ok: false, text: "" }));
  });
  ipcMain.handle("desk:browser-task", async (event, instruction) => {
    if (!fromPanel(event)) return { ok: false, reply: "not the browser panel" };
    if (typeof askAgent !== "function") return { ok: false, reply: "The desk's agent is not wired to this window." };
    const text = typeof instruction === "string" ? instruction.trim() : "";
    if (!text) return { ok: false, reply: "Say what the agent should do." };
    const view = activeView();
    if (!view) return { ok: false, reply: "No tab is open." };
    const prompt = policy.buildTaskPrompt({ url: view.webContents.getURL(), title: view.webContents.getTitle(), instruction: text });
    try {
      const result = await askAgent(prompt);
      return { ok: result?.ok !== false, reply: String(result?.reply || "") };
    } catch (error) {
      return { ok: false, reply: String(error?.message || error) };
    }
  });
  ipcMain.handle("desk:browser-open-external", async (event) => {
    if (!fromPanel(event)) return { ok: false };
    const view = activeView();
    const url = view ? view.webContents.getURL() : "";
    if (!policy.isNavigable(url)) return { ok: false, error: "only http(s) pages open in Chrome" };
    await electron().shell.openExternal(url);
    return { ok: true, url };
  });
  // Downloads: the panel shows the shelf; "Show" opens only a FINISHED file's folder.
  ipcMain.on("desk:browser-downloads-clear", (event) => {
    if (!fromPanel(event)) return;
    downloads.clearFinished();
    pushState();
  });
  ipcMain.on("desk:browser-download-show", (event, id) => {
    if (!fromPanel(event)) return;
    const row = downloads.get(Number(id));
    if (row && row.state === "completed" && row.path) electron().shell.showItemInFolder(row.path);
  });
  ipcMain.on("desk:browser-tab-activate", (event, id) => {
    if (fromChrome(event)) showTab(Number(id));
  });
  ipcMain.on("desk:browser-tab-close", (event, id) => {
    if (fromChrome(event)) closeTab(Number(id), "you");
  });
  ipcMain.on("desk:browser-nav", (event, verb) => {
    const view = activeView();
    if (!fromChrome(event) || !view) return;
    const wc = view.webContents;
    const history = wc.navigationHistory;
    if (verb === "back" && history.canGoBack()) history.goBack();
    else if (verb === "forward" && history.canGoForward()) history.goForward();
    else if (verb === "reload") wc.reload();
    else if (verb === "stop") wc.stop();
  });
  ipcMain.on("desk:browser-takeover", (event) => {
    if (fromChrome(event)) gate.takeOver();
  });
  ipcMain.on("desk:browser-handback", (event) => {
    if (fromChrome(event)) gate.handBack();
  });
  // The Agents tab: live sessions, the open cards and the room, read-only except for
  // answering a card with one of its OWN options through main's answer path.
  ipcMain.handle("desk:browser-agents", async (event) => {
    if (!fromPanel(event)) return null;
    if (!agentsHost) return agentsPanel.unavailableView("the desk has not wired the Agents tab");
    try {
      return await agentsHost.view();
    } catch (error) {
      return agentsPanel.unavailableView(String(error?.message || error));
    }
  });
  ipcMain.handle("desk:browser-agents-answer", async (event, id, choice) => {
    if (!fromPanel(event)) return { ok: false, error: "not the browser panel" };
    if (!agentsHost) return { ok: false, error: "the desk has not wired the Agents tab" };
    const verdict = agentsHost.check(id, choice);
    if (!verdict.ok) return verdict;
    try {
      return await agentsHost.answer(id, choice, win && !win.isDestroyed() ? win : null);
    } catch (error) {
      return { ok: false, error: String(error?.message || error) };
    }
  });
  ipcMain.handle("desk:browser-ask", async (event, question, extra) => {
    if (!fromPanel(event)) return { ok: false, reply: "not the browser panel" };
    if (typeof askAgent !== "function") return { ok: false, reply: "The desk's agent is not wired to this window." };
    // The OWNER's read: not an agent tool call, so it does not pass the gate.
    const page = await runInPage("read", {}, "owner").catch((error) => ({ ok: false, error: String(error.message || error) }));
    if (!page || page.ok === false) return { ok: false, reply: `Could not read the page: ${page && page.error}` };
    const opts = extra && typeof extra === "object" ? extra : {};
    const prompt = policy.buildConnectPrompt({
      url: page.url, title: page.title, text: page.text, question: typeof question === "string" ? question.slice(0, 2000) : "",
      selection: typeof opts.selection === "string" ? opts.selection : "",
      history: Array.isArray(opts.history) ? opts.history : [],
    });
    try {
      const result = await askAgent(prompt);
      return { ok: result?.ok !== false, reply: String(result?.reply || "") };
    } catch (error) {
      return { ok: false, reply: String(error?.message || error) };
    }
  });
}

/**
 * The tab on screen, for the overlay host (overlay-browser-host.cjs decides what of
 * it AitherOS Online may see). The OWNER's read, so it does not pass the agent gate.
 */
async function screenPage() {
  const view = activeView();
  if (!view) return { page: null, by: null };
  const tab = tabs.get(tabs.active);
  const page = await runInPage("overview", {}, "owner").catch(() => null);
  return { page, by: tab ? tab.by : null };
}

/** main installs the Agents tab's sources + answer path (see agentsHost). */
function setAgentsHost(host) {
  const ok = host && typeof host.view === "function" && typeof host.check === "function"
    && typeof host.answer === "function";
  agentsHost = ok ? host : null;
}

/** main installs the layers around the browser (see shellHost). */
function setShellHost(host) {
  const ok = host && typeof host.docked === "function" && typeof host.overlayVisible === "function"
    && typeof host.popupMenu === "function" && typeof host.run === "function";
  shellHost = ok ? host : null;
}

/** Re-lay the window and re-send its state (the dock or the overlay changed outside). */
function refreshShell() {
  layout();
  pushState();
}

function closeBrowserWindow() {
  if (win && !win.isDestroyed()) win.close();
}

function isBrowserWindowOpen() {
  return Boolean(win && !win.isDestroyed());
}

module.exports = {
  ASSISTANT_PANEL,
  CHROME_HEIGHT,
  classify,
  closeInternalTabOf,
  configureInternal,
  openInternal,
  sendToInternalTabs,
  setInboxBadge,
  ISOLATED_WORLD_ID,
  KEY_CODES,
  PARTITION,
  browserAgent,
  closeBrowserWindow,
  createAssistantPanel,
  createBrowserWindow,
  getGate: () => gate,
  getTabs: () => tabs,
  getState: () => state(),
  getLibrary,
  screenPage,
  /** The owner clicking a tab, for browser-tabs-smoke.cjs (the strip's IPC needs a real sender). */
  __showTabForTest: (id) => showTab(id),
  isBrowserWindowOpen,
  scriptFor,
  setAgentsHost,
  setShellHost,
  refreshShell,
  avatarSlotRect,
  getWindow: () => (win && !win.isDestroyed() ? win : null),
  onGeometry: (listener) => {
    geometryListeners.add(listener);
    return () => geometryListeners.delete(listener);
  },
};
