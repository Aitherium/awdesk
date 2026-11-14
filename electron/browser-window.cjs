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
const { TabSet, agentTabView } = require("./browser-tabs.cjs");
const { createLibrary } = require("./browser-library.cjs");
const { createDownloads } = require("./browser-downloads.cjs");
const agentsPanel = require("./agents-panel.cjs");
const rail = require("./browser-rail.cjs");
const launchModes = require("./launch-modes.cjs");
const taskbar = require("./browser-taskbar.cjs");
const extensions = require("./browser-extensions.cjs");
const overlayMod = require("./browser-overlay.cjs");
const deskTenant = require("./desk-tenant.cjs");
const tabDiscard = require("./tab-discard.cjs");
const terminalWindow = require("./terminal-window.cjs");
const agentSessions = require("./browser-agent-cookies.cjs");
// The layout document (pane sides, presets, the rail's arrangement, detached bounds,
// canvas boards) -- one more key of browser-layout.json, never a second store.
const deskLayout = require("./desk-layout.cjs");
// Edge parity (owner 2026-11-13, "close the gaps"): keys, right-click, find, zoom, print,
// InPrivate, session restore, translate, DRM hand-off. The pure parts live there.
const everyday = require("./browser-everyday.cjs");
const { createSurfaceState } = require("./surface-state.cjs");
let knowledgeImpl = null;
function knowledgeClient() {
  if (!knowledgeImpl) knowledgeImpl = require("./knowledge-client.cjs").createKnowledgeClient();
  return knowledgeImpl;
}

const PARTITION = "persist:aither-browser";
/** The agent's OWN session (BROWSER-M3, browser-agent-cookies.cjs): its tabs ride this. */
const AGENT_PARTITION = agentSessions.AGENT_PARTITION;
const CHROME_HEIGHT = 78; // tab strip (34) + toolbar (44, the agent indicator lives in it); browser-chrome.html matches
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
let internalReady = false;
/** What main injects so aither:// pages resolve (configureInternal). */
let internalConfig = { rendererUrl: "", hostedUrl: null, hostedPrepare: null, beforeInternal: null,
  workspaceUrl: null, modelFile: null, homeFor: null };
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
/**
 * Edit-layout mode (the Customize panel's "Edit layout", the palette's layout.edit):
 * every page view steps aside, exactly as during a gutter drag, so the chrome page can
 * draw the panes as labelled boxes with drop zones and handles over the whole window.
 * Not persisted: a restart never comes back in edit mode.
 */
let editingLayout = false;
/** Page views give the chrome page the whole window (a drag, or edit-layout mode). */
function viewsAside() {
  return dragging || editingLayout;
}

/**
 * Panes in their own windows (desk-layout DETACHABLE: the assistant panel, the terminal
 * dock, the taskbar). surface-state.cjs owns WHERE each one is -- the same single owner
 * the console's panes have -- and the pane windows are the oracle it is reconciled
 * against, so a window closed from its own title bar reattaches instead of leaving a
 * hole the layout still reserves.
 */
const paneSurfaces = createSurfaceState(deskLayout.DETACHABLE);
/** pane -> its own BrowserWindow, while detached. */
const paneWindows = new Map();
/** The browser window is closing: pane windows go with it and stay "open" for next time. */
let closingBrowser = false;
function paneDetached(pane) {
  return paneSurfaces.presentationOf(pane) === "detached";
}
/** The canvas host (browser-canvas.cjs), made on first use. */
let canvasHost = null;
/** The living desktop's taskbar (browser-taskbar.cjs): its view, and whether its menu is open. */
let taskbarView = null;
let taskbarOpen = false;
/** The taskbar page's open/closed signal, rate-limited (browser-taskbar.cjs createOpenSignal). */
let openSignal = null;
let taskbarStatus = "off";
/**
 * The terminal dock (owner, 2026-10-28): aither://terminal/?dock=1 along the bottom of
 * every page, above the taskbar. It IS the terminal page, so terminal-window.cjs's
 * sender check passes it and nothing else. "off" | "loading" | "ok" | "unavailable".
 */
let dockView = null;
let dockStatus = "off";
const DOCK_URL = "aither://terminal/?dock=1";
/**
 * Popped-out tabs (owner, 2026-10-04: "pop out any screen into its own floating window").
 * tab id -> its own BrowserWindow. The tab stays in the TabSet (same owner, same agent
 * rules); only its VIEW lives in the pop window. Closing that window docks it back.
 */
const popped = new Map();
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

/** Is `url` a page of an extension loaded into the web session (awconnect or one you added)? */
function isLoadedExtensionPage(url) {
  try {
    const parsed = new URL(String(url || ""));
    if (parsed.protocol !== "chrome-extension:") return false;
    const ses = electron().session.fromPartition(PARTITION);
    const api = ses.extensions || ses;
    return Boolean(typeof api.getExtension === "function" && api.getExtension(parsed.hostname));
  } catch {
    return false;
  }
}

/** An extension's own page (side panel, else popup) as a tab of yours, reusing one open on it. */
function openExtensionUi(id) {
  const ses = electron().session.fromPartition(PARTITION);
  const api = ses.extensions || ses;
  const ext = typeof api.getExtension === "function" ? api.getExtension(String(id || "")) : null;
  if (!ext) return { ok: false, error: "no such extension" };
  const url = extensions.uiUrl(ext.id, extensions.uiPath(ext.manifest));
  const open = tabs.tabs.find((t) => t.kind === "extension" && (viewOf(t.id) || { webContents: { getURL: () => "" } })
    .webContents.getURL().startsWith(`chrome-extension://${ext.id}/`));
  if (open) {
    showTab(open.id);
    return { ok: true };
  }
  const opened = openTab("you", url, { kind: "extension", label: ext.name || "extension" });
  return opened.ok ? { ok: true } : { ok: false, error: opened.error };
}

/** Open awconnect's own UI as a tab of yours (reusing one that is open). */
async function openAwconnect() {
  const loaded = awconnect.ok ? awconnect : await ensureAwconnect();
  if (!loaded || !loaded.ok) return { ok: false, error: (loaded && loaded.error) || "awconnect is not loaded" };
  return openExtensionUi(loaded.id);
}
/** Told whenever the window moves, resizes, hides or closes (main re-seats the docked avatar). */
const geometryListeners = new Set();
function notifyGeometry(reason) {
  for (const listener of geometryListeners) {
    try { listener(reason); } catch { /* one listener never stops the others */ }
  }
}
/** Is the desk linked as the platform OWNER? Unknown counts as no: the owner-only rows stay hidden. */
function hostOwner() {
  try { return Boolean(shellHost && typeof shellHost.isOwner === "function" && shellHost.isOwner()); } catch { return false; }
}
/** Is the Online partition signed in (the desk's account)? Unknown counts as yes: the platform still gates. */
function hostSignedIn() {
  try { return !shellHost || typeof shellHost.signedIn !== "function" || Boolean(shellHost.signedIn()); } catch { return true; }
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

/** The home page: DESK_BROWSER_HOME, else the tenant's host (desk-tenant.cjs), else the apex. */
function homeUrl() {
  const verdict = policy.sanitizeUrl(process.env.DESK_BROWSER_HOME
    || deskTenant.baseUrl(deskTenant.currentTenant(), "https://aitherium.com"));
  return verdict.ok ? verdict.url : "https://aitherium.com/";
}

/**
 * The account's workspace host was adopted (or forgotten) mid-run (desk-tenant-auto.cjs):
 * the pinned AitherOS Online tab and the taskbar move to it now, so the owner is not left
 * on the platform OS until the next launch. A tab already on that origin is left alone
 * (its open windows stay). Returns what moved.
 */
function followTenant() {
  const moved = { online: false, taskbar: false };
  if (!win || win.isDestroyed()) return moved;
  try { win.setTitle(deskTenant.decorateTitle("Aither Browser", deskTenant.currentTenant())); } catch { /* closing */ }
  const target = internal.onlineUrl();
  const online = tabs.byKey("online");
  const view = online ? viewOf(online.id) : null;
  if (alive(view)) {
    let here = "";
    try { here = new URL(view.webContents.getURL()).origin; } catch { /* not loaded yet */ }
    if (here && here !== new URL(target).origin) {
      void loadHostedTab(view, target).catch(() => {});
      moved.online = true;
    }
  }
  if (alive(taskbarView)) {
    let here = "";
    try { here = new URL(taskbarView.webContents.getURL()).origin; } catch { /* not loaded yet */ }
    const next = taskbar.taskbarUrl(target);
    if (next && here && here !== new URL(next).origin) {
      void taskbarView.webContents.loadURL(next).catch(() => {});
      moved.taskbar = true;
    }
  }
  return moved;
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

/**
 * Every tab, with what the strip shows. This is the OWNER's view (the strip, the
 * panel); an agent gets agentTabView(tabList()), which withholds the owner's tabs.
 */
function tabList() {
  const snap = tabs.snapshot();
  const ownerSession = electron().session.fromPartition(PARTITION);
  return snap.tabs.map((t) => {
    const view = viewOf(t.id);
    const tab = tabs.get(t.id) || {};
    const url = view ? view.webContents.getURL() : (discarded.get(t.id) || {}).url || "";
    return {
      id: t.id,
      by: t.by,
      kind: t.kind || "web",
      pinned: Boolean(t.pinned),
      label: tab.label || "",
      badge: tab.key === "inbox" && inbox.count > 0 ? inbox.count : 0,
      active: t.id === snap.active,
      agentTarget: t.id === snap.agentTarget,
      url,
      title: view ? view.webContents.getTitle() : (discarded.get(t.id) || {}).title || "",
      loading: view ? view.webContents.isLoading() : false,
      popped: popped.has(t.id),
      shared: t.by === "you" && tabs.isShared(t.id, url),
      // An AGENT tab riding the OWNER's cookies because its site is allowed
      // (BROWSER-M3): read from the live session, not from the prefs, so a tab
      // opened before the allow shows where it really is.
      agentSignIn: t.by === "agent" && Boolean(view) && view.webContents.session === ownerSession,
      private: Boolean(tab.private),
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
    // "Let the agent use my sign-in" for the page on screen (BROWSER-M3): its site,
    // whether the agent may ride the owner's session there, and every allowed site.
    agentSignIn: agentSessions.stateFor(getPrefs().agentCookieSites, wc.getURL()),
    ...everydayState(wc),
  };
}

/**
 * Send the strip/panel state, at most once per PUSH_MIN_MS (the latest state wins).
 *
 * Every tab event (title, navigation, load start/stop) calls this. A page that rewrites
 * its own title thousands of times a second (two title watchers fighting, measured on a
 * customer's workspace 2026-10-16) turned each write into a full state build plus two
 * IPC sends; the renderers could not drain them and the main process grew without bound.
 */
const PUSH_MIN_MS = 100;
let pushPending = null;
let lastPushAt = 0;
function pushState() {
  if (pushPending) return;
  const wait = Math.max(0, lastPushAt + PUSH_MIN_MS - Date.now());
  pushPending = setTimeout(() => {
    pushPending = null;
    lastPushAt = Date.now();
    pushStateNow();
  }, wait);
}
function pushStateNow() {
  if (win && !win.isDestroyed() && sessionRestored && getPrefs().restoreSession !== false) getSessionStore().save(tabList());
  const payload = state();
  if (win && !win.isDestroyed()) win.webContents.send("desk:browser-state", payload);
  if (alive(panelView)) panelView.webContents.send("desk:browser-state", payload);
}

/**
 * Deny-by-default permissions and agent-time downloads on EVERY page partition:
 * the owner's (PARTITION) and the agent's own (AGENT_PARTITION, BROWSER-M3). The
 * guard is per session -- one hardened session must not leave the next one open.
 */
const hardenedSessions = new WeakSet();
function hardenSession(ses) {
  if (!ses || hardenedSessions.has(ses)) return;
  hardenedSessions.add(ses);
  ses.setPermissionRequestHandler((_wc, permission, callback) => callback(policy.allowPermission(permission)));
  ses.setPermissionCheckHandler((_wc, permission) => policy.allowPermission(permission));
  if (typeof ses.setDevicePermissionHandler === "function") ses.setDevicePermissionHandler(() => false);
  // Ads and trackers are cancelled at the network layer (browser-adblock.cjs).
  try { getAdblock().attach(ses, { onBlocked: () => pushState() }); } catch { /* browsing still works */ }
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
  // `.aither` addresses resolve through the AitherNet Index (aither-address.cjs); a
  // failure anywhere shows a dark page with the reason, never a blank white view
  // (owner 2026-11-08: "why blank white page, I hate it").
  const addr = require("./aither-address.cjs");
  let target;
  try {
    target = await addr.resolveAitherUrl(url);
  } catch (error) {
    if (alive(view)) await view.webContents.loadURL(addr.errorPageUrl(url, String((error && error.message) || error))).catch(() => {});
    throw error;
  }
  try {
    await view.webContents.loadURL(target);
  } catch (error) {
    // A redirect or a client-side navigation aborts the first load (-3); the
    // page still arrives. Anything else is a real failure.
    if (/ERR_ABORTED|\(-3\)/.test(String(error && error.message))) return;
    if (alive(view) && /^https?:/i.test(String(target))) {
      await view.webContents.loadURL(addr.errorPageUrl(url, String((error && error.message) || error))).catch(() => {});
    }
    throw error;
  }
}

// What each view was last given, so an unchanged layout touches no native window. Measured
// on Garg's tenant 2026-10-16: re-setting identical bounds on every pass (and re-seating
// the docked avatar after each) was where a title storm turned into 6 GB of native memory.
const lastBounds = new WeakMap();
const lastVisible = new WeakMap();
let lastLayoutKey = "";
function placeView(view, visible, rect) {
  if (lastVisible.get(view) !== visible) {
    lastVisible.set(view, visible);
    view.setVisible(visible);
  }
  if (!visible || !rect) return;
  const prev = lastBounds.get(view);
  if (prev && prev.x === rect.x && prev.y === rect.y && prev.width === rect.width && prev.height === rect.height) return;
  lastBounds.set(view, { x: rect.x, y: rect.y, width: rect.width, height: rect.height });
  view.setBounds(rect);
}

/** Something else placed this view (a pop-out window): the next layout sets it afresh. */
function forgetPlacement(view) {
  lastBounds.delete(view);
  lastVisible.delete(view);
}

function layout() {
  syncPageTaskbars();
  if (!win || win.isDestroyed()) return;
  // A discarded tab put on screen gets its renderer back first (tab-discard.cjs).
  restoreDiscarded(tabs.active);
  // The rail (avatar slot, every Aither page, the layer strip) is the chrome page's
  // own left column; page views and the panel sit to its right (browser-rail.cjs).
  const rects = currentRects();
  const now = Date.now();
  for (const [id, view] of views) {
    if (!alive(view) || popped.has(id)) continue;
    const shown = id === tabs.active && !viewsAside();
    if (shown) shownAt.set(id, now);
    placeView(view, shown, rects.page);
  }
  // A detached pane lives in its own window (detachPane): this layout leaves it alone.
  if (alive(panelView) && !paneDetached("panel")) placeView(panelView, !viewsAside() && rects.panel.width > 0, rects.panel);
  if (alive(taskbarView) && !paneDetached("taskbar")) {
    const shown = !viewsAside() && rects.taskbar.height > 0;
    // Its Start menu and tray popovers open UPWARD: while one is open the view grows
    // over the page (the page is still there underneath; closing it shrinks back).
    placeView(taskbarView, shown, taskbarOpen ? taskbar.expandedRect(rects) : rects.taskbar);
  }
  if (alive(dockView) && !paneDetached("dock")) placeView(dockView, !viewsAside() && rects.dock.height > 0, rects.dock);
  // The canvas's live app cards follow its tab (shown, hidden, moved, popped out).
  if (canvasHost) canvasHost.relayout();
  // The docked avatar follows the rail only when the rail really moved.
  const key = JSON.stringify([rects.avatar || null, rects.page, win.getContentBounds()]);
  const layoutChanged = key !== lastLayoutKey;
  lastLayoutKey = key;
  if (layoutChanged) notifyGeometry("layout");
}

// ── Hidden tabs give their renderer back (tab-discard.cjs) ─────────────────────────
const shownAt = new Map(); // tab id -> when it was last on screen
const discarded = new Map(); // tab id -> { url, title }
let discardTimer = null;

function tabFacts() {
  return tabs.tabs.map((t) => {
    const view = views.get(t.id);
    let audible = false;
    try { audible = alive(view) && view.webContents.isCurrentlyAudible(); } catch { /* gone */ }
    return { id: t.id, by: t.by, kind: t.kind, pinned: t.pinned, active: t.id === tabs.active, popped: popped.has(t.id),
      audible, discarded: discarded.has(t.id), shownAt: shownAt.get(t.id) || 0 };
  });
}

/** Close the renderers of hidden tabs nobody is looking at; their place and address stay. */
function discardHiddenTabs({ pressure = false } = {}) {
  if (!win || win.isDestroyed() || !tabs) return 0;
  let n = 0;
  for (const id of tabDiscard.pickDiscards(tabFacts(), { now: Date.now(), pressure })) {
    const view = views.get(id);
    if (!alive(view)) continue;
    const wc = view.webContents;
    discarded.set(id, { url: wc.getURL(), title: wc.getTitle() });
    views.delete(id);
    try { win.contentView.removeChildView(view); } catch { /* already detached */ }
    try { wc.close(); } catch { /* already closing */ }
    n += 1;
  }
  if (n) pushState();
  return n;
}

/** A discarded tab is about to be shown: give it a renderer and reload its address. */
function restoreDiscarded(id) {
  const gone = id == null ? null : discarded.get(id);
  if (!gone || !win || win.isDestroyed()) return;
  const tab = tabs.get(id);
  discarded.delete(id);
  if (!tab || !tab.viewSpec) return;
  const spec = tab.viewSpec;
  // The same session the tab was opened in (an agent tab comes back on its own
  // AGENT_PARTITION, not on the owner's because it was restored).
  const view = createPageView(spec.kind, { paneId: spec.paneId, partition: spec.partition }, null, spec.webPartition || PARTITION);
  views.set(id, view);
  wirePage(view.webContents, id);
  win.contentView.addChildView(view);
  if (alive(panelView)) win.contentView.addChildView(panelView);
  if (alive(taskbarView)) win.contentView.addChildView(taskbarView);
  if (spec.kind === "hosted") void loadHostedTab(view, gone.url || spec.url).catch(() => {});
  else void loadInView(view, gone.url || spec.url).catch(() => {});
}

/**
 * THE page-view builder: every tab's view (a new tab, a discarded tab coming back) is made
 * here. Web content gets NO preload (tabPreferences("web")); an aither:// tab gets the one
 * internal preload, which hands the page only its own pane's bridge. awconnect's own page
 * gets the compat shim its worker has (withCompat adds a preload for kind "extension"
 * ONLY). The pinned AitherOS Online tab is a DESK HOST (internal.withDeskHost).
 *
 * `webPartition` is which WEB session the tab rides: the owner's PARTITION, or the
 * agent's own AGENT_PARTITION (BROWSER-M3) -- the caller picks it with
 * agentSessions.partitionFor, so no view is ever created without that decision.
 */
function createPageView(kind, target, hostedPartition, webPartition = PARTITION) {
  const { WebContentsView } = electron();
  const view = new WebContentsView({
    webPreferences: internal.withDeskHost(kind, target.paneId, extensions.withCompat(kind, internal.tabPreferences(kind === "extension" ? "web" : kind, {
      webPartition, hostedPartition: target.partition || hostedPartition,
    }))),
  });
  return view;
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
/** The strip is enabled and its route is served (it may still step aside, below). */
function stripEnabled() {
  return Boolean(getPrefs().taskbar) && taskbarStatus !== "unavailable";
}
/** Who owns the browser's taskbar right now (browser-taskbar.cjs stripOwner). */
function currentStripOwner() {
  return taskbar.stripOwner({ overlayUp: overlayOnDesktop(), tabOverlay: Boolean(getPrefs().overlay) });
}
/** The strip is on screen: enabled, and no desktop overlay owns the taskbar. */
function stripShown() {
  return stripEnabled() && currentStripOwner() === "host";
}

// One taskbar: while the strip is enabled, a page that draws its own (AitherOS Online,
// the dock-shell pages) is marked data-host="desk" and Veil drops its dock (the same
// rule is inserted here for a Veil build that predates host "desk"). While the desktop
// overlay owns the taskbar the strip hides and the page's dock STAYS hidden: the
// overlay's dock is the screen's one taskbar. Per page document: { css, flag }.
const pageTaskbarCss = new WeakMap();
function syncPageTaskbar(wc) {
  if (!wc || wc.isDestroyed()) return;
  const want = stripEnabled() && taskbar.pageHasOwnTaskbar(wc.getURL());
  const state = pageTaskbarCss.get(wc) || { css: null, flag: null };
  pageTaskbarCss.set(wc, state);
  if (state.flag !== want) {
    state.flag = want;
    void wc.executeJavaScriptInIsolatedWorld(ISOLATED_WORLD_ID, [{ code: taskbar.hostFlagScript(want) }])
      .catch(() => { if (pageTaskbarCss.get(wc) === state) state.flag = null; });
  }
  if (want && !state.css) {
    state.css = "pending";
    wc.insertCSS(taskbar.HOST_DOCK_CSS).then((k) => { state.css = k; }, () => { state.css = null; });
  } else if (!want && state.css && state.css !== "pending") {
    const key = state.css;
    state.css = null;
    void wc.removeInsertedCSS(key).catch(() => {});
  }
}
// AitherOS Online over web pages (browser-overlay.cjs), one per window's web tabs.
let overlay = null;
function getOverlay() {
  if (!overlay) {
    overlay = overlayMod.createOverlay({
      dir: () => extensions.awconnectDir(),
      thread: () => getDeskThread(),
      session: () => { try { return electron().session.fromPartition(onlinePartition()); } catch { return null; } },
    });
  }
  return overlay;
}
/** A local-node / compose / adapter answer, exactly as the overlay over a web tab gets it. */
function overlayAnswer(msg) {
  return getOverlay().answer(msg);
}

/** Ctrl+K (Cmd+K on macOS), no other modifier: the browser's awsh key. Pure. */
function isAwshKey(input) {
  if (!input || input.type !== "keyDown" || input.alt || input.shift) return false;
  if (!(input.control || input.meta)) return false;
  return String(input.key || "").toLowerCase() === "k";
}

/**
 * awsh from anywhere (aither-host/1 os-command): raise the pinned AitherOS Online tab and
 * ask it to open awsh. The tab's desk-host preload turns the IPC into os-command.
 */
function openAwsh(args = {}) {
  if (!win || win.isDestroyed()) createBrowserWindow({ url: null, home: false });
  ensurePinned();
  const online = tabs.byKey("online");
  if (!online) return false;
  showTab(online.id);
  const view = viewOf(online.id);
  if (!alive(view)) return false;
  try { view.webContents.send("living-desktop:os-command", { id: "awsh.open", args }); } catch { return false; }
  return true;
}

/** ONE THREAD (desk-thread.cjs): the conversation every surface shares, the desk's copy. */
let deskThread = null;
function getDeskThread() {
  if (!deskThread) deskThread = require("./desk-thread.cjs").createDeskThread({ token: () => onlineToken() });
  return deskThread;
}
/**
 * ONE identity: the Online partition's platform bearer, the same one the OS overlay gets.
 * The desk-hosted OS pages (living-desktop-window host-token) and the built-in awconnect
 * (awconnect-webauth desk-session) read it here; never a local daemon or harness token.
 */
function onlineToken() {
  return getOverlay().token();
}
/** Follow the Online session's sign-in/out (cookie jar verdict, debounced). */
function watchOnlineAuth(fn) {
  getOverlay().watchAuth();
  return getOverlay().onAuth(fn);
}
/**
 * The desk session for an extension, only for the awconnect build the desk staged and
 * loaded (its path is browser-extensions awconnectDir); any other extension gets {}.
 */
async function awconnectDeskSession(id, ses) {
  const api = ses && (ses.extensions || ses);
  let ext;
  try { ext = api && typeof api.getExtension === "function" ? api.getExtension(id) : null; } catch { ext = null; }
  const dir = extensions.awconnectDir();
  if (!ext || !dir || require("node:path").resolve(String(ext.path || "")) !== require("node:path").resolve(dir)) return {};
  return { token: await onlineToken() };
}
function overlayWanted(tabId) {
  const tab = tabs.get(tabId);
  return Boolean(getPrefs().overlay && tab && tab.kind === "web");
}
/** Bring a web tab's overlay in line with the pref (on its new document, or on a toggle). */
function syncOverlay(tabId) {
  const view = viewOf(tabId);
  if (!alive(view)) return;
  const wc = view.webContents;
  if (overlayWanted(tabId) && overlayMod.overlayAllowed(wc.getURL())) {
    // Once per session (idempotent): a sign-out in Online reaches the OS over pages.
    getOverlay().watchAuth();
    void getOverlay().inject(wc).catch(() => {});
  } else void getOverlay().remove(wc);
}
function setOverlay(on) {
  setPrefs({ overlay: Boolean(on) });
  for (const id of views.keys()) syncOverlay(id);
  pushState();
  return true;
}
// Read aloud: the selection, else the page's main text, from the tab on screen. Read in
// the isolated world (a web tab has no preload); the page never sees the call.
const READ_ALOUD_SCRIPT = `(() => {
  const sel = String(getSelection ? getSelection() : "").trim();
  if (sel) return sel;
  const main = document.querySelector("article, main, [role=main]") || document.body;
  return main ? String(main.innerText || "").replace(/\\s+/g, " ").trim() : "";
})()`;
async function readAloud() {
  if (!shellHost || typeof shellHost.speak !== "function") return { ok: false, error: "the desk has no voice wired" };
  const view = activeView();
  if (!alive(view)) return { ok: false, error: "no page" };
  let text;
  try { text = await view.webContents.executeJavaScriptInIsolatedWorld(ISOLATED_WORLD_ID, [{ code: READ_ALOUD_SCRIPT }]); } catch { text = ""; }
  text = String(text || "").slice(0, 2000);
  if (!text) return { ok: false, error: "nothing to read on this page" };
  void Promise.resolve(shellHost.speak(text)).catch(() => {});
  return { ok: true, chars: text.length };
}

// ================================================================== Edge parity
// Owner, 2026-11-13: "close the gaps" (what switching from Edge would lose). Everything
// here acts for the OWNER only: an agent tab never gets a password, a fill, an InPrivate
// tab or a session entry. Page work runs in the isolated world (web tabs have no preload).

const closedTabs = everyday.createClosedTabs();
const tabNotices = new Map(); // tab id -> { kind, text, actions: [{id, label}], data, keep }
const findResults = new Map(); // tab id -> { text, matches, active }
const pwFilled = new Map(); // tab id -> the URL already autofilled (once per page)
// tab id -> { key, prev }: the capture key of the document on screen and of the one before
// (its submit message can land just after the next document starts). browser-passwords.cjs.
const pwKeys = new Map();
const drmStay = new Set(); // hosts the owner chose to keep here this run
let sessionRestored = false;

function userDataPath(...parts) {
  return path.join(electron().app.getPath("userData"), ...parts);
}

let adblockImpl = null;
function getAdblock() {
  if (!adblockImpl) {
    adblockImpl = require("./browser-adblock.cjs").createAdblock({ dir: userDataPath("adblock") });
    adblockImpl.loadCached();
    void adblockImpl.refresh().catch(() => {});
  }
  return adblockImpl;
}

let vaultImpl = null;
function passwordsMod() { return require("./browser-passwords.cjs"); }
function getVault() {
  if (!vaultImpl) vaultImpl = passwordsMod().createVault({ file: userDataPath("browser-passwords.json"), safeStorage: electron().safeStorage });
  return vaultImpl;
}

let sessionStoreImpl = null;
function getSessionStore() {
  if (!sessionStoreImpl) sessionStoreImpl = everyday.createSessionStore({ file: userDataPath("browser-session.json") });
  return sessionStoreImpl;
}

/** Reopen last time's tabs. Returns how many came back. Saving starts only after this. */
function restoreSession() {
  let n = 0;
  try {
    const saved = getSessionStore().load();
    const activeAt = saved.findIndex((t) => t.active);
    saved.forEach((t, i) => {
      const r = openTab("you", t.url, { activate: i === (activeAt >= 0 ? activeAt : saved.length - 1) });
      if (r.ok) n += 1;
    });
  } catch { /* a broken file restores nothing */ }
  sessionRestored = true;
  return n;
}

function forgetTabExtras(id) {
  tabNotices.delete(id);
  findResults.delete(id);
  pwFilled.delete(id);
  pwKeys.delete(id);
}

/** An InPrivate tab: the in-memory partition, hardened like the others, no history. */
function openPrivateTab(url, { activate = true, after = null } = {}) {
  const { session } = electron();
  hardenSession(session.fromPartition(everyday.INPRIVATE_PARTITION));
  const added = tabs.add("you", { activate, after, kind: "web" });
  if (!added.ok) return added;
  const tab = tabs.get(added.id);
  tab.private = true;
  tab.label = "";
  tab.viewSpec = { kind: "web", paneId: null, partition: null, webPartition: everyday.INPRIVATE_PARTITION, url };
  const view = createPageView("web", { paneId: null }, null, everyday.INPRIVATE_PARTITION);
  views.set(added.id, view);
  wirePage(view.webContents, added.id);
  win.contentView.addChildView(view);
  if (alive(panelView)) win.contentView.addChildView(panelView);
  if (alive(taskbarView)) win.contentView.addChildView(taskbarView);
  layout();
  pushState();
  void loadInView(view, url).catch(() => {});
  return { ok: true, id: added.id, view };
}

/** The last InPrivate tab closed: its cookies, cache and storage go with it. */
function clearPrivateIfLast() {
  const anyLeft = tabs.snapshot().tabs.some((t) => (tabs.get(t.id) || {}).private);
  if (anyLeft) return;
  try {
    const ses = electron().session.fromPartition(everyday.INPRIVATE_PARTITION);
    void ses.clearStorageData().catch(() => {});
    void ses.clearCache().catch(() => {});
  } catch { /* nothing to clear */ }
}

function privateHomeUrl() {
  const home = homeUrl();
  const c = classify(home);
  return c.kind === "web" ? c.url : "https://duckduckgo.com/";
}

function setNotice(id, notice) {
  if (notice) tabNotices.set(id, { keep: false, ...notice });
  else tabNotices.delete(id);
  pushState();
}

/** The parity facts of the tab on screen, merged into state(). */
function everydayState(wc) {
  const id = tabs.active;
  const tab = tabs.get(id) || {};
  const url = wc.getURL();
  const notice = tabNotices.get(id);
  let saved = 0;
  try {
    if (!tab.private && tab.by === "you" && passwordsMod().shouldOffer({ tabBy: tab.by, url })) saved = getVault().forOrigin(url).length;
  } catch { /* vault unavailable: no key icon */ }
  const ab = adblockImpl;
  return {
    private: Boolean(tab.private),
    zoom: Math.round((wc.getZoomFactor() || 1) * 100),
    find: findResults.get(id) || null,
    notice: notice ? { kind: notice.kind, text: notice.text, actions: notice.actions || [] } : null,
    passwords: saved,
    adblock: ab ? { enabled: ab.enabled(), siteOff: ab.siteOff(url), blocked: ab.blockedOn(wc.id) } : null,
  };
}

function isolated(wc, code) {
  return wc.executeJavaScriptInIsolatedWorld(ISOLATED_WORLD_ID, [{ code }]).catch(() => null);
}

/** May this tab's page get password capture and fill? The owner's own, saved-able page only. */
function passwordsAllowed(id, wc) {
  const tab = tabs.get(id);
  if (!tab || tab.private || tab.by !== "you") return false;
  try { return passwordsMod().shouldOffer({ tabBy: tab.by, url: wc.getURL() }); } catch { return false; }
}

/** A login the page just submitted: offer to save it (never when it is already saved as is). */
async function collectLogin(id, wc) {
  if (!passwordsAllowed(id, wc)) return;
  const got = await isolated(wc, passwordsMod().PENDING_SCRIPT);
  offerLogin(id, wc, got);
}

/** A login the page submitted (from the console channel or the pending read): offer to save it. */
function offerLogin(id, wc, got) {
  if (!got || !got.password || !passwordsAllowed(id, wc)) return;
  const P = passwordsMod();
  const shown = tabNotices.get(id);
  if (shown && shown.kind === "password-save" && shown.data && shown.data.origin === got.origin
    && shown.data.username === got.username && shown.data.password === got.password) return;
  if (got.origin !== P.normalizeOrigin(wc.getURL())) return;
  try {
    const vault = getVault();
    const same = vault.forOrigin(got.origin).find((e) => e.username === (got.username || ""));
    if (same && vault.reveal(same.id) === got.password) return;
    const host = new URL(got.origin).host;
    setNotice(id, {
      kind: "password-save", keep: true, data: got,
      text: same ? `Update the saved password for ${got.username || "this account"} on ${host}?`
        : `Save the password for ${got.username || "this account"} on ${host}?`,
      actions: [{ id: "password-save", label: same ? "Update" : "Save" }, { id: "dismiss", label: "Not now" }],
    });
  } catch { /* no vault: nothing offered */ }
}

/**
 * A login form with saved accounts: OFFER the fill, never fill unasked. A password put
 * into the DOM on load is readable by every script on the page (Chromium hides an
 * autofilled value from scripts until the user interacts; a page here cannot), so the
 * owner's click is the gesture: the notice's Fill, or the key icon.
 */
async function autofill(id, wc) {
  if (!passwordsAllowed(id, wc)) return;
  const url = wc.getURL();
  // One capture listener per document, with that document's own key.
  const keys = pwKeys.get(id) || { key: null, prev: null };
  if (!keys.key) {
    keys.key = passwordsMod().newCaptureKey();
    pwKeys.set(id, keys);
    void isolated(wc, passwordsMod().captureScriptFor(keys.key));
  }
  let entries;
  try { entries = getVault().forOrigin(url); } catch { return; }
  pushState();
  if (!entries.length || pwFilled.get(id) === url || tabNotices.has(id)) return;
  const hasLogin = await isolated(wc, passwordsMod().DETECT_LOGIN_SCRIPT);
  if (!hasLogin || pageWc(id) !== wc || wc.getURL() !== url) return;
  const one = entries.length === 1 ? entries[0] : null;
  setNotice(id, {
    kind: "password-fill", data: { url, entryId: one ? one.id : null },
    text: one ? `Sign in as ${one.username || "your saved account"}?` : `${entries.length} saved accounts for this site.`,
    actions: one ? [{ id: "password-fill", label: "Fill" }, { id: "dismiss", label: "Not now" }]
      : [{ id: "password-pick", label: "Choose…" }, { id: "dismiss", label: "Not now" }],
  });
}

async function fillAccount(id, wc, entryId) {
  if (!passwordsAllowed(id, wc)) return { ok: false };
  const vault = getVault();
  const entry = vault.forOrigin(wc.getURL()).find((e) => e.id === entryId);
  if (!entry) return { ok: false };
  pwFilled.set(id, wc.getURL());
  const r = await isolated(wc, passwordsMod().fillScript(entry.username, vault.reveal(entry.id),
    passwordsMod().normalizeOrigin(wc.getURL())));
  return { ok: Boolean(r && r.filled) };
}

/** Load-time hooks for one page: right-click, find results, logins, DRM, ad counter. */
function wireEveryday(wc, id) {
  wc.on("context-menu", (_event, params) => showContextMenu(id, wc, params));
  wc.on("found-in-page", (_event, result) => {
    const prev = findResults.get(id) || { text: "" };
    findResults.set(id, { text: prev.text, matches: result.matches || 0, active: result.activeMatchOrdinal || 0 });
    pushState();
  });
  wc.on("did-start-navigation", (details, legacyUrl, legacyInPlace, legacyMain) => {
    const isMain = details && typeof details.isMainFrame === "boolean" ? details.isMainFrame : legacyMain;
    const same = details && typeof details.isSameDocument === "boolean" ? details.isSameDocument : legacyInPlace;
    if (!isMain || same) return;
    // The old document's isolated world still holds a login it just submitted.
    void collectLogin(id, wc);
    if (adblockImpl) adblockImpl.resetCount(wc.id);
    findResults.delete(id);
  });
  // A login submitted in the isolated world arrives here before the page unloads.
  wc.on("console-message", (details, legacyLevel, legacyMessage) => {
    const message = details && typeof details.message === "string" ? details.message : legacyMessage;
    if (typeof message !== "string" || !message.startsWith(passwordsMod().CHANNEL)) return;
    const keys = pwKeys.get(id);
    if (!keys) return;
    const got = passwordsMod().decodeCaptured(message, keys.key) || passwordsMod().decodeCaptured(message, keys.prev);
    if (got) offerLogin(id, wc, got);
  });
  wc.on("did-navigate", (_event, url) => {
    const k = pwKeys.get(id);
    if (k) pwKeys.set(id, { key: null, prev: k.key || k.prev });
    const n = tabNotices.get(id);
    if (n && n.keep) n.keep = false;
    else if (n) tabNotices.delete(id);
    const tab = tabs.get(id);
    if (tab && tab.by === "you" && everyday.needsDrm(url)) {
      let host = "";
      try { host = new URL(url).hostname; } catch { /* not a URL */ }
      if (!drmStay.has(host) && everyday.edgeExecutable()) {
        setNotice(id, {
          kind: "drm", data: { url, host },
          text: "This site plays protected video or music (DRM), which this browser cannot play yet. Watch it in Edge?",
          actions: [{ id: "open-edge", label: "Open in Edge" }, { id: "drm-stay", label: "Stay here" }],
        });
      }
    }
    const store = require("./browser-webstore.cjs").parseExtensionId(url);
    if (tab && tab.by === "you" && !tab.private && store.ok && /\/detail\//.test(url)) {
      setNotice(id, {
        kind: "extension", data: { url },
        text: "Install this extension in the Aither Browser (the store's own button asks for Chrome).",
        actions: [{ id: "extension-install", label: "Add to Aither" }, { id: "dismiss", label: "Not now" }],
      });
    }
  });
  wc.on("did-stop-loading", () => {
    void collectLogin(id, wc).then(() => autofill(id, wc));
  });
}

/** Open Edge on `url` (only Edge: shell.openExternal would come back here once Aither is the default). */
function openInEdge(url) {
  const exe = everyday.edgeExecutable();
  if (!exe) return { ok: false, error: "Microsoft Edge is not installed" };
  const target = String(url || "");
  if (!/^(https?|edge):/i.test(target)) return { ok: false, error: "only web pages open in Edge" };
  try {
    require("node:child_process").spawn(exe, [target], { detached: true, stdio: "ignore", windowsHide: false }).unref();
    return { ok: true };
  } catch (error) {
    return { ok: false, error: String((error && error.message) || error) };
  }
}

/** The tab's page, if it is a live web page. */
function pageWc(id) {
  const view = viewOf(id);
  return alive(view) ? view.webContents : null;
}

/** Translate the page in place with this machine's own model (nothing leaves for a translation service). */
async function translatePage(id) {
  const wc = pageWc(id);
  if (!wc) return { ok: false };
  let target = "English";
  try { target = new Intl.DisplayNames(["en"], { type: "language" }).of(electron().app.getLocale().split("-")[0]) || "English"; } catch { /* English */ }
  const got = await isolated(wc, everyday.TRANSLATE_COLLECT_SCRIPT);
  const texts = got && Array.isArray(got.texts) ? got.texts : [];
  if (!texts.length) { setNotice(id, { kind: "info", text: "Nothing on this page to translate." }); return { ok: false }; }
  const batches = everyday.translateBatches(texts);
  let done = 0;
  let changed = 0;
  const ask = async (prompt) => {
    const r = await Promise.resolve(overlayAnswer({ type: "os-compose", prompt, maxTokens: 2048, temperature: 0.1 })).catch(() => null);
    if (r && r.ok && r.text) return r.text;
    if (typeof askAgent === "function") {
      const a = await Promise.resolve(askAgent(prompt)).catch(() => null);
      return a && a.ok !== false ? String(a.reply || "") : "";
    }
    return "";
  };
  for (const batch of batches) {
    setNotice(id, { kind: "info", text: `Translating into ${target} on this computer… ${done}/${batches.length}`,
      actions: [{ id: "show-original", label: "Show original" }] });
    const reply = await ask(everyday.translatePrompt(batch.texts, target));
    const out = everyday.parseTranslation(reply, batch.texts.length);
    if (out && pageWc(id) === wc) changed += Number(await isolated(wc, everyday.translateApplyScript(batch.start, out))) || 0;
    done += 1;
  }
  setNotice(id, changed
    ? { kind: "info", text: `Translated into ${target} by your local model.`, actions: [{ id: "show-original", label: "Show original" }] }
    : { kind: "info", text: "Translation failed: no local model answered (start one on aither://local-ai)." });
  return { ok: changed > 0, changed };
}

function zoomTo(wc, dir) {
  if (!wc) return false;
  wc.setZoomFactor(everyday.nextZoom(wc.getZoomFactor(), dir));
  pushState();
  return true;
}

function sendToChrome(channel, payload) {
  if (!win || win.isDestroyed()) return false;
  win.webContents.focus();
  win.webContents.send(channel, payload);
  return true;
}

/**
 * One place every standard key, menu item and right-click lands. Returns true when it
 * was a browser action (so the key is not passed to the page).
 */
function runBrowserAction(action, arg, id = tabs.active) {
  const wc = pageWc(id);
  const tab = tabs.get(id) || {};
  const history = wc && wc.navigationHistory;
  const order = tabs.snapshot().tabs.map((t) => t.id);
  const at = order.indexOf(tabs.active);
  switch (action) {
    case "new-tab": return openTab("you", homeUrl()).ok || true;
    case "close-tab": closeTab(tabs.active, "you"); return true;
    case "focus-address": return sendToChrome("desk:browser-focus-address");
    case "find": return sendToChrome("desk:browser-find-open", (findResults.get(id) || {}).text || "");
    case "find-next":
    case "find-prev": {
      const text = (findResults.get(id) || {}).text;
      if (wc && text) wc.findInPage(text, { forward: action === "find-next", findNext: true });
      return true;
    }
    case "print": if (wc) wc.print({ printBackground: true }, () => {}); return true;
    case "zoom-in": return zoomTo(wc, 1);
    case "zoom-out": return zoomTo(wc, -1);
    case "zoom-reset": return zoomTo(wc, 0);
    case "inprivate": return openTab("you", arg || privateHomeUrl(), { private: true }).ok || true;
    case "reopen-closed": {
      const last = closedTabs.pop();
      if (last) openTab("you", last.url);
      return true;
    }
    case "next-tab": case "prev-tab": {
      if (order.length > 1) showTab(order[(at + (action === "next-tab" ? 1 : -1) + order.length) % order.length]);
      return true;
    }
    case "tab-index": {
      const n = Number(arg);
      const pick = n === 9 ? order[order.length - 1] : order[n - 1];
      if (pick != null) showTab(pick);
      return true;
    }
    case "reload": if (wc) wc.reload(); return true;
    case "back": if (history && history.canGoBack()) history.goBack(); return true;
    case "forward": if (history && history.canGoForward()) history.goForward(); return true;
    case "home": if (wc) void loadInView(viewOf(id), homeUrl()).catch(() => {}); return true;
    case "fullscreen": if (win && !win.isDestroyed()) win.setFullScreen(!win.isFullScreen()); return true;
    case "bookmark":
      if (wc && !tab.private) getLibrary().toggleBookmark(wc.getURL(), wc.getTitle());
      pushState();
      return true;
    case "history": return openInternal("history", null) !== false;
    case "downloads": return false; // the side panel shows downloads; no page to open
    case "translate": void translatePage(id); return true;
    case "read-aloud": void readAloud(); return true;
    case "open-edge": return openInEdge(wc ? wc.getURL() : "").ok;
    default: return false;
  }
}

/** The page's right-click menu (Electron draws none). */
function showContextMenu(id, wc, params) {
  const { Menu, clipboard, dialog } = electron();
  const history = wc.navigationHistory;
  const tab = tabs.get(id) || {};
  const spec = everyday.contextMenuSpec(params, {
    canGoBack: history ? history.canGoBack() : false,
    canGoForward: history ? history.canGoForward() : false,
    private: Boolean(tab.private),
  });
  const run = (item) => {
    switch (item.id) {
      case "spell-replace": wc.replaceMisspelling(item.arg); break;
      case "spell-add": wc.session.addWordToSpellCheckerDictionary(item.arg); break;
      case "link-new-tab": openTab(tab.private ? "you" : (tab.by || "you"), item.arg,
        { activate: false, after: id, private: Boolean(tab.private) }); break;
      case "link-inprivate": openTab("you", item.arg, { private: true }); break;
      case "copy-text": clipboard.writeText(String(item.arg || "")); break;
      case "image-save": wc.downloadURL(item.arg); break;
      case "image-copy": wc.copyImageAt(params.x, params.y); break;
      case "undo": wc.undo(); break;
      case "redo": wc.redo(); break;
      case "cut": wc.cut(); break;
      case "copy": wc.copy(); break;
      case "paste": wc.paste(); break;
      case "paste-plain": wc.pasteAndMatchStyle(); break;
      case "select-all": wc.selectAll(); break;
      case "search": openSearch(item.arg); break;
      case "save-page":
        void dialog.showSaveDialog(win, { defaultPath: `${(wc.getTitle() || "page").replace(/[\\/:*?"<>|]+/g, " ").slice(0, 80)}.html`,
          filters: [{ name: "Web page, complete", extensions: ["html"] }] })
          .then((r) => { if (!r.canceled && r.filePath) return wc.savePage(r.filePath, "HTMLComplete"); return null; })
          .catch(() => {});
        break;
      case "inspect": wc.inspectElement(params.x, params.y); break;
      default: runBrowserAction(item.id, item.arg, id);
    }
  };
  const template = spec.map((item) => (item.type === "separator" ? { type: "separator" }
    : { label: item.label, enabled: item.enabled !== false, click: () => run(item) }));
  Menu.buildFromTemplate(template).popup({ window: win });
}

/** A notice button (save password, open in Edge, add extension...). */
async function noticeAction(actionId) {
  const id = tabs.active;
  const notice = tabNotices.get(id);
  const wc = pageWc(id);
  if (!notice) return { ok: false };
  switch (actionId) {
    case "password-save": {
      const d = notice.data || {};
      tabNotices.delete(id);
      let r;
      try { r = getVault().add({ origin: d.origin, username: d.username || "", password: d.password }); } catch (error) { r = { ok: false, error: String(error.message) }; }
      setNotice(id, r && r.ok ? null : { kind: "info", text: `The password was not saved: ${(r && r.error) || "the vault refused"}` });
      return r;
    }
    case "open-edge": {
      const r = openInEdge((notice.data && notice.data.url) || (wc ? wc.getURL() : ""));
      setNotice(id, r.ok ? null : { kind: "info", text: r.error });
      return r;
    }
    case "password-fill": {
      const d = notice.data || {};
      setNotice(id, null);
      if (!wc || wc.getURL() !== d.url || !d.entryId) return { ok: false };
      return fillAccount(id, wc, d.entryId);
    }
    case "password-pick": setNotice(id, null); return passwordMenu();
    case "drm-stay": drmStay.add((notice.data && notice.data.host) || ""); setNotice(id, null); return { ok: true };
    case "extension-install": return installExtensionFrom(id, (notice.data && notice.data.url) || (wc ? wc.getURL() : ""));
    case "show-original": setNotice(id, null); if (wc) wc.reload(); return { ok: true };
    case "delete-file": {
      const file = notice.data && notice.data.file;
      try { if (file) require("node:fs").unlinkSync(file); setNotice(id, { kind: "info", text: "The CSV file is deleted." }); } catch (error) {
        setNotice(id, { kind: "info", text: `Could not delete ${file}: ${error.message}` });
      }
      return { ok: true };
    }
    default: setNotice(id, null); return { ok: true };
  }
}

/** Add a Chrome Web Store / Edge Add-ons extension (its page's URL) to the browser. */
async function installExtensionFrom(id, url) {
  setNotice(id, { kind: "info", text: "Downloading the extension…" });
  const store = require("./browser-webstore.cjs");
  const r = await store.installFromStore(url, { dir: userDataPath("extensions-store") }).catch((error) => ({ ok: false, error: String(error.message || error) }));
  if (!r || !r.ok) { setNotice(id, { kind: "info", text: `The extension was not installed: ${(r && r.error) || "unknown error"}` }); return r; }
  // Show what it may touch BEFORE it loads into the owner's session (review 2026-11-13).
  // Unpacked to disk is inert; it runs only after this confirm.
  const reach = extensionReach(r.path);
  const { dialog } = electron();
  const ask = await dialog.showMessageBox(win, {
    type: "warning", buttons: ["Add extension", "Cancel"], defaultId: 1, cancelId: 1, noLink: true,
    message: `Add "${r.name}" ${r.version}?`,
    detail: `It will be able to:\n${reach.join("\n") || "- (asks for no special permissions)"}`,
  });
  if (ask.response !== 0) {
    try { require("node:fs").rmSync(r.path, { recursive: true, force: true }); } catch { /* inert files */ }
    setNotice(id, { kind: "info", text: `${r.name} was not added.` });
    return { ok: false, error: "cancelled" };
  }
  const ew = require("./extensions-window.cjs");
  ew.saveDirs([...ew.savedDirs(), r.path]);
  try {
    const ses = electron().session.fromPartition(PARTITION);
    const api = ses.extensions || ses;
    for (const e of (api.getAllExtensions ? api.getAllExtensions() : [])) if (e.id === r.id) api.removeExtension(e.id);
    await api.loadExtension(r.path, { allowFileAccess: false });
  } catch (error) {
    setNotice(id, { kind: "info", text: `${r.name} is installed but did not load: ${error.message}` });
    return { ok: false, error: error.message };
  }
  const warn = Array.isArray(r.warnings) && r.warnings.length ? ` Some parts may not work here (${r.warnings.join(", ")}).` : "";
  setNotice(id, { kind: "info", text: `${r.name} ${r.version} is added.${warn}` });
  return r;
}

/** What an unpacked extension asks to reach, in plain lines, from its manifest. */
function extensionReach(dir) {
  let m;
  try { m = JSON.parse(require("node:fs").readFileSync(path.join(dir, "manifest.json"), "utf8")); } catch { return ["- (manifest unreadable)"]; }
  const hosts = new Set([...(Array.isArray(m.host_permissions) ? m.host_permissions : []),
    ...(Array.isArray(m.permissions) ? m.permissions.filter((p) => /[:/*]/.test(String(p))) : []),
    ...(Array.isArray(m.content_scripts) ? m.content_scripts.flatMap((c) => (Array.isArray(c.matches) ? c.matches : [])) : [])]);
  const perms = (Array.isArray(m.permissions) ? m.permissions : []).filter((p) => !/[:/*]/.test(String(p)));
  const out = [];
  const all = [...hosts].some((h) => /<all_urls>|^\*:\/\/\*\/|^https?:\/\/\*\//.test(String(h)));
  if (all) out.push("- Read and change everything on every website you visit");
  else if (hosts.size) out.push(`- Read and change: ${[...hosts].slice(0, 8).join(", ")}${hosts.size > 8 ? ` (+${hosts.size - 8} more)` : ""}`);
  if (perms.length) out.push(`- Use: ${perms.slice(0, 12).join(", ")}${perms.length > 12 ? " ..." : ""}`);
  return out;
}

async function importPasswordsCsv() {
  const { dialog } = electron();
  const id = tabs.active;
  const pick = await dialog.showOpenDialog(win, { title: "Passwords CSV exported from Edge", properties: ["openFile"],
    filters: [{ name: "CSV", extensions: ["csv"] }] });
  if (pick.canceled || !pick.filePaths[0]) return { ok: false };
  const file = pick.filePaths[0];
  let r;
  try {
    const text = require("node:fs").readFileSync(file, "utf8");
    r = await require("./browser-edge-import.cjs").importPasswordCsv({ text, vault: getVault() });
  } catch (error) {
    r = { ok: false, error: String(error.message) };
  }
  setNotice(id, r && r.ok
    ? { kind: "info", text: `Imported ${r.added} passwords${r.skipped ? ` (${r.skipped} skipped)` : ""}. The CSV holds them in plain text: delete it now.`, data: { file },
      actions: [{ id: "delete-file", label: "Delete the CSV" }, { id: "dismiss", label: "Keep it" }] }
    : { kind: "info", text: `No passwords imported: ${(r && r.error) || "unreadable file"}` });
  return r;
}

async function importFromEdgeProfile(dir) {
  const id = tabs.active;
  setNotice(id, { kind: "info", text: "Importing from Edge…" });
  const r = await require("./browser-edge-import.cjs").importFromEdge({ profileDir: dir, library: getLibrary() })
    .catch((error) => ({ ok: false, bookmarks: 0, history: 0, errors: [String(error.message)] }));
  setNotice(id, { kind: "info", text: `From Edge: ${r.bookmarks} bookmarks and ${r.history} history entries added.`
    + `${r.errors && r.errors.length ? ` Not imported: ${r.errors.join("; ")}.` : ""} Passwords: export them from Edge and import the CSV (menu > Passwords).` });
  return r;
}

async function makeDefaultBrowser() {
  const { app, shell } = electron();
  const id = tabs.active;
  const r = await require("./browser-default.cjs").createDefaultBrowser({
    exe: process.execPath, appArgs: app.isPackaged ? [] : [app.getAppPath()], openExternal: (u) => shell.openExternal(u),
  }).register();
  setNotice(id, r.ok
    ? { kind: "info", text: "Aither Browser is registered. In the Settings window that opened, click \"Set default\" next to Aither Browser." }
    : { kind: "info", text: `Could not register: ${r.error}` });
  return r;
}

/** The ⋯ menu: everything Edge keeps in its own. */
function browserMenu() {
  if (!win || win.isDestroyed()) return { ok: false };
  const { Menu, clipboard } = electron();
  const id = tabs.active;
  const wc = pageWc(id);
  const url = wc ? wc.getURL() : "";
  const ab = getAdblock();
  const zoom = wc ? Math.round(wc.getZoomFactor() * 100) : 100;
  let accounts = [];
  try { accounts = getVault().list(); } catch { /* no vault */ }
  let edgeProfiles = [];
  try { edgeProfiles = require("./browser-edge-import.cjs").edgeProfileDirs(); } catch { /* no Edge */ }
  const store = require("./browser-webstore.cjs").parseExtensionId(url);
  const pwItems = accounts.slice(0, 40).map((a) => ({
    label: `${a.origin.replace(/^https:\/\//, "")}  ${a.username || "(no name)"}`,
    submenu: [
      { label: "Copy password", click: () => { clipboard.writeText(getVault().reveal(a.id) || ""); setTimeout(() => clipboard.clear(), 30000); } },
      { label: "Copy username", click: () => clipboard.writeText(a.username || "") },
      { label: "Delete", click: () => { getVault().remove(a.id); pushState(); } },
    ],
  }));
  const template = [
    { label: "New tab", accelerator: "CmdOrCtrl+T", registerAccelerator: false, click: () => runBrowserAction("new-tab") },
    { label: "New InPrivate tab", accelerator: "CmdOrCtrl+Shift+N", registerAccelerator: false, click: () => runBrowserAction("inprivate") },
    { label: "Reopen closed tab", accelerator: "CmdOrCtrl+Shift+T", registerAccelerator: false, enabled: closedTabs.list().length > 0, click: () => runBrowserAction("reopen-closed") },
    { type: "separator" },
    { label: `Zoom (${zoom}%)`, submenu: [
      { label: "Zoom in", accelerator: "CmdOrCtrl+=", registerAccelerator: false, click: () => runBrowserAction("zoom-in") },
      { label: "Zoom out", accelerator: "CmdOrCtrl+-", registerAccelerator: false, click: () => runBrowserAction("zoom-out") },
      { label: "Reset to 100%", accelerator: "CmdOrCtrl+0", registerAccelerator: false, click: () => runBrowserAction("zoom-reset") },
    ] },
    { label: "Find on page", accelerator: "CmdOrCtrl+F", registerAccelerator: false, click: () => runBrowserAction("find") },
    { label: "Print…", accelerator: "CmdOrCtrl+P", registerAccelerator: false, click: () => runBrowserAction("print") },
    { label: "Translate page", click: () => runBrowserAction("translate") },
    { label: "Read aloud", click: () => runBrowserAction("read-aloud") },
    { label: "Open in Edge", enabled: /^https?:/i.test(url) && Boolean(everyday.edgeExecutable()), click: () => runBrowserAction("open-edge") },
    { type: "separator" },
    { label: "Block ads and trackers", type: "checkbox", checked: ab.enabled(), click: (item) => { ab.setEnabled(item.checked); pushState(); } },
    { label: "Allow ads on this site", type: "checkbox", enabled: ab.enabled() && /^https?:/i.test(url), checked: ab.siteOff(url),
      click: (item) => { ab.setSiteOff(url, item.checked); if (wc) wc.reload(); } },
    { label: `Update the block lists (${ab.hostCount().toLocaleString()} hosts)`, click: () => { void ab.refresh({ force: true }).then(() => pushState()); } },
    { type: "separator" },
    { label: `Passwords (${accounts.length})`, submenu: [
      ...(pwItems.length ? pwItems : [{ label: "No saved passwords yet", enabled: false }]),
      { type: "separator" },
      { label: "Import passwords from a CSV…", click: () => { void importPasswordsCsv(); } },
      { label: "Export them from Edge first…", enabled: Boolean(everyday.edgeExecutable()), click: () => openInEdge("edge://settings/passwords") },
    ] },
    { label: "Import from Edge", submenu: edgeProfiles.length
      ? edgeProfiles.map((p) => ({ label: `${p.name}: bookmarks and history`, click: () => { void importFromEdgeProfile(p.dir); } }))
      : [{ label: "No Edge profile found", enabled: false }] },
    { label: "Extensions", submenu: [
      { label: "Add this extension to Aither", enabled: store.ok, click: () => { void installExtensionFrom(id, url); } },
      { label: "Open the Chrome Web Store", click: () => openTab("you", "https://chromewebstore.google.com/") },
      { label: "Open Edge Add-ons", click: () => openTab("you", "https://microsoftedge.microsoft.com/addons") },
      { label: "Manage extensions", click: () => openInternal("extensions", null) },
    ] },
    { type: "separator" },
    { label: "Reopen my tabs when the browser starts", type: "checkbox", checked: getPrefs().restoreSession !== false,
      click: (item) => setPrefs({ restoreSession: item.checked }) },
    { label: "Make Aither your default browser…", visible: process.platform === "win32", click: () => { void makeDefaultBrowser(); } },
  ];
  Menu.buildFromTemplate(template).popup({ window: win });
  return { ok: true };
}

/** The key icon: fill one of this site's saved accounts. */
function passwordMenu() {
  const id = tabs.active;
  const wc = pageWc(id);
  if (!wc || !passwordsAllowed(id, wc)) return { ok: false };
  const { Menu } = electron();
  const entries = getVault().forOrigin(wc.getURL());
  const template = entries.map((e) => ({ label: `Fill ${e.username || "(no name)"}`, click: () => { void fillAccount(id, wc, e.id); } }));
  if (!template.length) return { ok: false };
  Menu.buildFromTemplate(template).popup({ window: win });
  return { ok: true };
}
// ============================================================== end Edge parity

/** AitherOS Online is hovering on the real desktop (the desk's overlay window). */
function overlayOnDesktop() {
  try { return Boolean(shellHost && shellHost.overlayVisible()); } catch { return false; }
}

/** The OS frame of the overlay on the tab on screen, when there is one. */
function activeOverlayFrame() {
  const view = activeView();
  return getPrefs().overlay && alive(view) ? getOverlay().osFrame(view.webContents) : null;
}

function syncPageTaskbars() {
  for (const view of views.values()) if (alive(view)) syncPageTaskbar(view.webContents);
}

function currentRectsFor(bounds, docked) {
  const p = getPrefs();
  const panes = p.desk.panes;
  // A detached pane takes no room here: its window holds it.
  return rail.railLayout(bounds, {
    collapsed: p.railCollapsed, docked, chromeHeight: CHROME_HEIGHT, railWidth: p.railWidth,
    panelWidth: p.panelWidth, panelCollapsed: p.panelCollapsed || paneDetached("panel"),
    taskbarHeight: stripShown() && !paneDetached("taskbar") ? rail.TASKBAR_HEIGHT : 0,
    dockHeight: dockShown() && !paneDetached("dock") ? rail.dockHeightFor(p) : 0,
    railSide: panes.rail.side, panelSide: panes.panel.side, dockSide: panes.dock.side,
    avatarSide: panes.avatar.side, layersSide: panes.layers.side, layersVisible: panes.layers.visible,
    avatarOrder: panes.avatar.order, layersOrder: panes.layers.order,
  });
}

/** The dock takes its strip: enabled, and its page did not fail to load. */
function dockShown() {
  return Boolean(getPrefs().dock) && dockStatus !== "unavailable";
}

/** Ctrl+` (Cmd+` on macOS), no other modifier: the terminal dock's key (VS Code's). Pure. */
function isDockKey(input) {
  if (!input || input.type !== "keyDown" || input.alt || input.shift) return false;
  if (!(input.control || input.meta)) return false;
  return input.code === "Backquote" || input.key === "`";
}

/** Tell the dock page whether it is open, so its strip draws the right chevron. */
function sendDockState() {
  sendTaskbarState();
  if (!alive(dockView)) return;
  const p = getPrefs();
  try {
    dockView.webContents.send("desk:terminal-dock-state", { open: Boolean(p.dockOpen), height: p.dockHeight });
  } catch { /* the page is going away */ }
}

/**
 * The taskbar strip's desk-state (browser-taskbar-preload.cjs): the commands it may offer
 * (Veil draws the terminal button only when "terminal-dock.toggle" is listed) and the
 * dock's open state. The strip is a different document from the dock, so it is told too.
 */
const TASKBAR_COMMANDS = Object.freeze(["terminal-dock.toggle"]);
function sendTaskbarState() {
  if (!alive(taskbarView)) return;
  const p = getPrefs();
  const commands = p.dock && dockStatus !== "unavailable" ? TASKBAR_COMMANDS.slice() : [];
  try {
    taskbarView.webContents.send("desk:taskbar-state", { commands, terminalDock: { open: Boolean(p.dockOpen) } });
  } catch { /* the page is going away */ }
}

/** Open, close (or flip, when `open` is undefined) the dock; opening focuses it. */
function setDockOpen(open) {
  const want = open === undefined ? !getPrefs().dockOpen : Boolean(open);
  setPrefs({ dockOpen: want, dock: true });
  ensureDock();
  layout();
  pushState();
  sendDockState();
  if (want && alive(dockView)) dockView.webContents.focus();
  return { ok: true, open: want };
}

/** What the dock page may ask of the window (terminal-window.cjs desk:terminal-dock). */
function dockAction(action, arg) {
  if (action === "toggle") return setDockOpen(undefined);
  if (action === "open") return setDockOpen(true);
  if (action === "close") return setDockOpen(false);
  if (action === "state") return { ok: true, open: Boolean(getPrefs().dockOpen) };
  if (action === "popout") {
    // The session moves to the full aither://terminal tab; the dock keeps its strip.
    const id = String(arg || "");
    if (!/^[A-Za-z0-9_-]{1,80}$/.test(id)) return { ok: false, error: "bad session id" };
    return openInternalUrl(`aither://terminal/?attach=${encodeURIComponent(id)}`)
      ? { ok: true } : { ok: false, error: "the terminal page is not available" };
  }
  return { ok: false, error: `no dock action ${action}` };
}
terminalWindow.setDockHost({ run: dockAction });

/** The terminal dock along the bottom (an aither://terminal page), created once per window. */
function ensureDock() {
  if (!win || win.isDestroyed() || alive(dockView) || !getPrefs().dock) return;
  ensureInternalSession();
  dockView = createPageView("internal", { paneId: "terminal", partition: null }, null);
  dockStatus = "loading";
  const view = dockView;
  const wc = view.webContents;
  // The dock never leaves the terminal page: a web link opens as a tab.
  wc.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(String(url))) openTab("you", url, { activate: true });
    return { action: "deny" };
  });
  wc.on("will-navigate", (event, url) => {
    if (!String(url).startsWith("aither://terminal/")) event.preventDefault();
  });
  wc.on("before-input-event", (event, input) => {
    if (isDockKey(input)) { event.preventDefault(); setDockOpen(undefined); }
  });
  wc.on("did-finish-load", () => { dockStatus = "ok"; sendDockState(); });
  wc.on("did-fail-load", (_e, code, desc, _url, isMain) => {
    if (!isMain || code === -3) return;
    console.warn(`[desk] terminal dock did not load: ${desc} (${code})`);
    dockStatus = "unavailable";
    layout();
    pushState();
  });
  wc.on("render-process-gone", () => {
    // A crashed dock comes back rather than leaving a hole above the taskbar.
    if (dockView !== view) return;
    try { win.contentView.removeChildView(view); } catch { /* already detached */ }
    dockView = null;
    dockStatus = "off";
    setTimeout(() => { ensureDock(); layout(); }, 1000);
  });
  win.contentView.addChildView(view);
  // The taskbar's menus open upward over the dock: keep the taskbar on top.
  if (alive(taskbarView)) win.contentView.addChildView(taskbarView);
  void loadInView(view, DOCK_URL).catch(() => {
    if (dockView !== view) return;
    dockStatus = "unavailable";
    layout();
    pushState();
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
  if (online) {
    online.rows = [...online.rows, row];
    online.total = (online.total || 0) + 1;
    online.hidden = Math.max(0, online.total - online.rows.length);
  } else {
    // A destination the catalogue did not file (awconnect is the browser's own): it
    // rides behind "More destinations", like every non-primary section.
    sections.push({ name: "Online", primary: false, rows: [row], hidden: 0, total: 1 });
  }
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
    taskbar: { on: p.taskbar, status: taskbarStatus, height: rects ? rects.taskbar.height : 0, owner: currentStripOwner() },
    dock: { on: p.dock, open: p.dockOpen, status: dockStatus, rect: rects ? rects.dock : null },
    collapsedSections: p.collapsedSections,
    expandedSections: p.expandedSections || [],
    // The page size the rail caps at, so the chrome never hard-codes the five law.
    sectionPage: rail.SECTION_PAGE,
    // Reveal the non-primary destinations (the rail's "More destinations").
    allSections: Boolean(p.railAllSections),
    docked,
    slot: rects ? rects.avatar : null,
    // The owner's arrangement (desk-layout arrangeRail) BEFORE the five-row cap, so
    // "+N more" applies to the rail they arranged. Pinned is always a primary section.
    sections: withAwconnectRow(rail.railView(arrangedSections(active),
      { expanded: p.expandedSections || [], primary: [deskLayout.PINNED_SECTION, ...rail.PRIMARY_SECTIONS] }), active),
    awconnect: awconnect.ok ? { ok: true, version: awconnect.version } : { ok: false, error: awconnect.error },
    layers: deskLayout.orderLayers(rail.layerRows({ docked, overlayVisible, browserOpen: true, overPages: getPrefs().overlay }),
      p.desk.layerOrder),
    // Every pane's rectangle: the grips, the edit-layout schematic and the chrome's own
    // columns are placed from these, never from a second copy of the geometry.
    rects: rects ? { rail: rects.rail, page: rects.page, panel: rects.panel, dock: rects.dock, taskbar: rects.taskbar } : null,
    layout: layoutState(),
  };
}

/** railSections() in the owner's arrangement (pins, moved and removed rows, section order). */
function arrangedSections(active = tabs.get(tabs.active)) {
  const p = getPrefs();
  return deskLayout.arrangeRail(rail.railSections(require("./console-window.cjs").PANES,
    { activePane: active && active.by === "you" ? active.paneId || null : null, signedIn: hostSignedIn(),
      owner: hostOwner(), modes: p.launchModes }), p.desk.rail);
}

/** What the Customize panel and edit-layout mode render: sides, presets, what is detached. */
function layoutState() {
  const desk = getPrefs().desk;
  return {
    editing: editingLayout,
    sides: Object.fromEntries(Object.entries(desk.panes).map(([id, pane]) => [id, pane.side])),
    layersVisible: desk.panes.layers.visible,
    avatarOrder: desk.panes.avatar.order,
    layersOrder: desk.panes.layers.order,
    allowed: deskLayout.SIDES,
    labels: deskLayout.PANE_LABELS,
    detachable: deskLayout.DETACHABLE,
    detached: paneSurfaces.snapshot(),
    presets: deskLayout.presetList(desk),
    activePreset: desk.activePreset,
    hiddenRows: desk.rail.hidden.length,
    pinnedRows: desk.rail.pinned.length,
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
  // A window on a desktop already on screen, never a page load (browser-taskbar.cjs
  // inPlaceTargets): the overlay over the page, then the tab on screen when it is an
  // AitherOS page itself, then the pinned Online tab.
  const id = taskbar.spawnIdOf(url);
  const over = activeOverlayFrame();
  const active = activeView();
  const targets = taskbar.inPlaceTargets({
    spawnId: id, overlay: Boolean(over), activeUrl: alive(active) ? active.webContents.getURL() : "",
  });
  const tryAt = (i) => {
    const kind = targets[i];
    if (kind === "online" || !kind) return openFromOnlineTab(url);
    const runner = kind === "overlay" ? over : active.webContents;
    runner.executeJavaScript(taskbar.openAppScript(id), true)
      .then((answer) => { if (taskbar.nextAfterAnswer(kind, answer) === "next") tryAt(i + 1); })
      .catch(() => tryAt(i + 1));
  };
  tryAt(0);
}

function openFromOnlineTab(url) {
  openInternal("desktop", null);
  const tab = tabForPane("desktop");
  const view = tab ? viewOf(tab.id) : null;
  if (!view) return;
  const wc = view.webContents;
  const id = taskbar.spawnIdOf(url);
  let here = null;
  try { here = new URL(wc.getURL()); } catch { /* not loaded yet */ }
  // The desktop is already up: open the app in it, no reload (its windows stay open).
  // Any path: /workspace/* boots the same desktop, and it answers desk-open-app too.
  if (id && here && here.origin === new URL(url).origin && !wc.isLoading()) {
    // A refusal is final: a reload applies the same gates and loses the open windows.
    wc.executeJavaScript(taskbar.openAppScript(id), true)
      .then((answer) => {
        if (taskbar.nextAfterAnswer("online", answer) === "reload" && alive(view)) return loadHostedTab(view, url);
      })
      .catch(() => {});
    return;
  }
  if (wc.getURL() !== url) void loadHostedTab(view, url).catch(() => {});
}

/** Close the taskbar strip's page and hide the strip until the browser is opened again. */
function unloadTaskbar(why) {
  setImmediate(() => {
    const view = taskbarView;
    if (!alive(view)) return;
    console.warn(`[desk] taskbar strip unloaded: ${why}`);
    taskbarView = null;
    taskbarOpen = false;
    taskbarStatus = "unavailable";
    if (openSignal) openSignal.dispose();
    openSignal = null;
    try { if (win && !win.isDestroyed()) win.contentView.removeChildView(view); } catch { /* detached */ }
    try { view.webContents.close(); } catch { /* closing */ }
    layout();
    pushState();
  });
}

/** The living desktop's taskbar along the bottom (browser-taskbar.cjs), created once per window. */
function ensureTaskbar() {
  if (!win || win.isDestroyed() || alive(taskbarView) || !getPrefs().taskbar) return;
  const url = taskbar.taskbarUrl(internal.onlineUrl());
  if (!url) return;
  const { WebContentsView } = electron();
  taskbarView = new WebContentsView({
    webPreferences: { ...internal.tabPreferences("hosted", { webPartition: PARTITION, hostedPartition: onlinePartition() }),
      preload: path.join(__dirname, "browser-taskbar-preload.cjs") },
  });
  if (typeof taskbarView.setBackgroundColor === "function") taskbarView.setBackgroundColor("#00000000");
  // Its ONE bridge: the desk plane, for the terminal button (browser-taskbar-preload.cjs).
  // Re-told every few seconds: Veil mounts its listener after hydration, whenever that is.
  const stateTimer = setInterval(() => sendTaskbarState(), 5000);
  taskbarView.webContents.once("destroyed", () => clearInterval(stateTimer));
  taskbarView.webContents.on("did-finish-load", () => {
    for (const ms of [0, 1500, 4000]) setTimeout(() => sendTaskbarState(), ms);
  });
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
  // The title is the page's open/closed signal (Start, the tray). Rate-limited and
  // flap-proof (browser-taskbar.cjs createOpenSignal): a title fight on the page must
  // never become a layout storm here.
  if (openSignal) openSignal.dispose();
  openSignal = taskbar.createOpenSignal({
    apply: (open) => {
      if (open === taskbarOpen) return;
      taskbarOpen = open;
      layout();
    },
    // A page whose title fights itself burns its own renderer whatever Desk does with the
    // signal: unload the strip (the browser works without it; the next open retries).
    onFlap: () => unloadTaskbar("its title is fighting itself"),
  });
  wc.on("page-title-updated", (_event, title) => {
    if (openSignal) openSignal.title(title);
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
  hostedPartition = null, kind: wantKind = null, private: inPrivate = false } = {}) {
  if (!win || win.isDestroyed()) return { ok: false, error: "The Aither Browser is not open." };
  // InPrivate: the owner's, web pages only, on the in-memory partition (nothing on disk,
  // no history, no passwords, no session restore). An agent never opens one.
  if (inPrivate) {
    if (by !== "you") return { ok: false, error: "only you open InPrivate tabs" };
    const privTarget = classify(url);
    if (privTarget.kind !== "web" && privTarget.kind !== "hosted") return { ok: false, error: "InPrivate opens web pages only" };
    return openPrivateTab(privTarget.url, { activate, after });
  }
  // Aitherium's own apps open natively (owner 2026-11-08): an aitherium.com URL a pane
  // declares in `web` becomes its aither:// page. Owner tabs only -- an agent never gets
  // an internal pane (browser-internal.upgradeToInternal; null = load the web page).
  if (by === "you" && !wantKind) url = internal.upgradeToInternal(url) || url;
  // Main wires the pane's handlers (and where the bundle and AitherOS Online are)
  // BEFORE the page is classified or loads: a pane talks to main the moment it loads.
  if (by === "you" && internal.isInternalUrl(url) && typeof internalConfig.beforeInternal === "function") {
    try { internalConfig.beforeInternal(); } catch { /* the page shows its own error */ }
  }
  // awconnect's own pages: only the owner, only the loaded extension's id.
  const extensionTab = wantKind === "extension";
  if (extensionTab && (by !== "you" || !isLoadedExtensionPage(url))) {
    return { ok: false, error: "not a page of a loaded extension" };
  }
  // (a chrome-extension: URL classifies as "web"; extensionTab below makes it its own kind)
  const target = classify(url);
  if (target.kind === "refused") return { ok: false, error: target.error };
  // An aitherium.com page the OWNER opens (Family, a pinned Workspace, a link) is hosted:
  // the same signed-in partition as Online, signed in before it loads. An agent's tab
  // never rides the owner's session (browser-internal.ownerHostedPartition).
  const signedInPartition = target.kind === "web" && !extensionTab
    ? internal.ownerHostedPartition(by, url, { explicit: hostedPartition, online: onlinePartition() })
    : null;
  if (signedInPartition) hostedPartition = signedInPartition;
  const kind = extensionTab ? "extension" : signedInPartition ? "hosted" : target.kind;
  // WHICH session the tab rides (BROWSER-M3): the owner's PARTITION for every owner
  // tab; an agent tab gets its OWN session unless the owner allowed this site ("Let
  // the agent use my sign-in"). One picker, so no view is ever built without it.
  const webPartition = kind === "extension" ? PARTITION : agentSessions.partitionFor({
    by, url: target.url, sites: getPrefs().agentCookieSites, ownerPartition: PARTITION, agentPartition: AGENT_PARTITION,
  });
  const added = tabs.add(by, { activate, after, kind, pinned, key });
  if (!added.ok) return added;
  const tab = tabs.get(added.id);
  tab.paneId = target.paneId;
  tab.label = label;
  if (kind === "internal") ensureInternalSession();
  // The view comes from the ONE page-view builder (createPageView: no preload for web
  // content). viewSpec lets a discarded tab be rebuilt the same way (tab-discard.cjs),
  // and carries the session so a restored tab rides the one it was opened in.
  tab.viewSpec = { kind, paneId: target.paneId, partition: target.partition || hostedPartition, webPartition, url: target.url };
  const view = createPageView(kind, target, hostedPartition, webPartition);
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

/**
 * A rail Online app (browser-rail AGENT_APPS, SPACE_APPS, ...). The platform's own gate
 * (ACTA / sign-in / owner) decides what opens; the desk refuses only an id that is not
 * on its list. WHERE it opens is the owner's per-app launch mode (launch-modes.cjs).
 */
function openAgentApp(id) {
  if (!rail.isAgentApp(id)) return { ok: false, error: "not an agent app" };
  return openOnlineApp(id);
}

/**
 * Open AitherOS Online app `id` in its launch mode (owner, 2026-10-13: Sprite, Academy
 * and Spaces all booted the FULL Living Desktop; "we need to be able to configure this"):
 *   tab      <online>/solo?app=<id> in its own signed-in tab, reused when already open
 *   window   that tab popped out into its own window
 *   desktop  <online>/?spawn=<id> on the pinned Online desktop (the old behaviour)
 * Callers vet `id` (the rail's list, main's command registry); this checks only its shape.
 */
function openOnlineApp(id) {
  if (!launchModes.isAppId(id)) return { ok: false, error: "not an app id" };
  if (!win || win.isDestroyed()) createBrowserWindow({ url: null, home: false });
  const mode = launchModes.launchModeFor(getPrefs().launchModes, id);
  const url = launchModes.appUrl(internal.onlineUrl(), id, mode);
  if (!url) return { ok: false, error: "no AitherOS Online address" };
  if (mode === "desktop") {
    openFromTaskbar(url);
    return { ok: true, mode };
  }
  const key = `app:${id}`;
  let tab = tabs.byKey(key);
  if (!tab || !viewOf(tab.id)) {
    const opened = openTab("you", url, { key, hostedPartition: onlinePartition() });
    if (!opened.ok) return { ok: false, error: opened.error };
    tab = tabs.get(opened.id);
  } else if (!popped.has(tab.id)) {
    showTab(tab.id);
  }
  if (mode === "window") return { ...popOutTab(tab.id), mode };
  // Asked for a tab and it is popped out: bring that window forward rather than steal the view.
  if (popped.has(tab.id)) return { ...popOutTab(tab.id), mode };
  return { ok: true, mode };
}

/** A workspace page (browser-rail WORKSPACE_PAGES) in the pinned, signed-in Workspace tab. */
function openWorkspacePage(pagePath) {
  // Command & control pages open only for the owner (the site's RBAC still decides).
  const admin = rail.isAdminPage(pagePath);
  if (admin && !hostOwner()) return { ok: false, error: "owner only" };
  if (!admin && !rail.isWorkspacePage(pagePath)) return { ok: false, error: "not a workspace page" };
  const url = new URL(pagePath, internal.onlineUrl()).href;
  createBrowserWindow({ url: null, home: false });
  ensurePinned();
  const tab = tabs.byKey("workspace");
  const view = tab ? viewOf(tab.id) : null;
  if (!view) return { ok: false, error: "the Workspace tab is not open" };
  showTab(tab.id);
  void loadHostedTab(view, url).catch(() => {});
  return { ok: true };
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
  return showInternal(pane, internal.internalUrl(pane, param), param != null, opts);
}

/**
 * Open a full aither:// address (a BeadSpace deep link: aither://space/?focus=next).
 * Reuses the pane's tab and loads the address into it when it differs. Callers hand
 * a URL they built or re-built themselves (space-home.cjs), never a page's raw string.
 */
function openInternalUrl(url, opts = {}) {
  const parsed = internal.parseInternalUrl(url);
  const pane = parsed && internal.paneById(parsed.paneId);
  if (!pane) return false;
  // "always": a deep link is read once when the page mounts, so the same link clicked
  // again (after the owner wandered off inside the pane) must reload to refocus.
  return showInternal(pane, String(url), "always", opts);
}

function showInternal(pane, url, reload, opts) {
  createBrowserWindow({ ...opts, url: null, home: false });
  ensurePinned();
  const existing = tabForPane(pane.id);
  if (existing) {
    showTab(existing.id);
    const view = viewOf(existing.id);
    if (reload && view && existing.kind === "internal"
        && (reload === "always" || view.webContents.getURL() !== url)) {
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
  const before = tabs.get(id);
  const beforeView = views.get(id);
  const beforeUrl = alive(beforeView) ? beforeView.webContents.getURL() : (discarded.get(id) || {}).url || "";
  const closed = tabs.close(id, by);
  if (!closed.ok) return closed;
  if (before) {
    closedTabs.push({ by: before.by, private: before.private, url: beforeUrl,
      title: alive(beforeView) ? beforeView.webContents.getTitle() : "" });
  }
  forgetTabExtras(id);
  const pop = popped.get(id);
  popped.delete(id);
  if (pop && !pop.isDestroyed()) {
    const v = views.get(id);
    if (alive(v)) pop.contentView.removeChildView(v);
    pop.destroy();
  }
  const view = views.get(id);
  views.delete(id);
  discarded.delete(id);
  shownAt.delete(id);
  if (alive(view)) {
    if (win && !win.isDestroyed()) win.contentView.removeChildView(view);
    view.webContents.close();
  }
  if (before && before.private) clearPrivateIfLast();
  if (tabs.tabs.length === 0 && win && !win.isDestroyed()) openTab("you", homeUrl());
  layout();
  pushState();
  return { ok: true, closed: id, active: tabs.active };
}

/** Move a tab's view into its own window (a floating pane you can put on any monitor). */
function popOutTab(id) {
  const view = viewOf(id);
  const tab = tabs.get(id);
  if (!view || !tab || !win || win.isDestroyed()) return { ok: false, error: "no such tab" };
  const existing = popped.get(id);
  if (existing && !existing.isDestroyed()) { existing.show(); existing.focus(); return { ok: true }; }
  const { BrowserWindow } = electron();
  const main = win.getBounds();
  const pop = new BrowserWindow({
    width: 1000, height: 720, x: main.x + 60, y: main.y + 60, minWidth: 360, minHeight: 240,
    title: view.webContents.getTitle() || "Aither", autoHideMenuBar: true, backgroundColor: "#0f1218",
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  pop.loadURL("about:blank").catch(() => {});
  win.contentView.removeChildView(view);
  pop.contentView.addChildView(view);
  const fit = () => {
    if (pop.isDestroyed() || !alive(view)) return;
    const { width, height } = pop.getContentBounds();
    forgetPlacement(view);
    view.setVisible(true);
    view.setBounds({ x: 0, y: 0, width, height });
  };
  fit();
  pop.on("resize", fit);
  const retitle = () => { if (!pop.isDestroyed()) pop.setTitle(`${view.webContents.getTitle() || "Aither"} \u2014 popped out`); };
  view.webContents.on("page-title-updated", retitle);
  retitle();
  pop.on("closed", () => dockTab(id, { closing: true }));
  popped.set(id, pop);
  // The strip moves on to another tab; the popped one keeps its place in the list.
  const next = tabs.tabs.find((t) => t.id !== id && !popped.has(t.id));
  if (next && tabs.active === id) tabs.activate(next.id);
  layout();
  pushState();
  return { ok: true };
}

/** Bring a popped-out tab's view back into the browser and close its window. */
function dockTab(id, { closing = false } = {}) {
  const pop = popped.get(id);
  popped.delete(id);
  const view = views.get(id);
  if (pop && !pop.isDestroyed() && alive(view)) pop.contentView.removeChildView(view);
  if (alive(view) && win && !win.isDestroyed()) {
    forgetPlacement(view);
    win.contentView.addChildView(view);
    if (alive(panelView)) win.contentView.addChildView(panelView);
    if (alive(taskbarView)) win.contentView.addChildView(taskbarView);
    tabs.activate(id);
  }
  if (pop && !closing && !pop.isDestroyed()) pop.close();
  layout();
  pushState();
  return { ok: true };
}

function showTab(id) {
  // A popped-out tab lives in its own window: clicking it on the strip summons that window.
  const pop = popped.get(id);
  if (pop && !pop.isDestroyed()) {
    pop.show();
    pop.focus();
    return { ok: true };
  }
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
  // An extension tab stays on ITS extension's pages (never hops to another extension's).
  const sameExtension = (url) => {
    try {
      return new URL(url).protocol === "chrome-extension:" && new URL(url).hostname === new URL(wc.getURL()).hostname
        && isLoadedExtensionPage(url);
    } catch {
      return false;
    }
  };
  const verdictFor = (url, opts) => (kindOf() === "extension"
    // awconnect's pages stay on awconnect; a web link from it opens a web tab.
    ? (sameExtension(url) ? "allow" : (opts && opts.frame) ? "deny"
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
  // Onto an AitherOS Online page: mark it data-host="desk" so ITS taskbar drops, the strip stays (one taskbar).
  wc.on("did-navigate", () => { pageTaskbarCss.delete(wc); if (overlay) overlay.forget(wc); }); // a new document drops both
  wc.on("dom-ready", () => { if (overlayWanted(id)) syncOverlay(id); });
  // The in-tab overlay's own taskbar drops while the strip is enabled (one taskbar, over
  // pages too): the OS frame is marked data-host="desk", the same flag as the Online tab.
  wc.on("did-frame-finish-load", (_e, isMain, processId, routingId) => {
    if (isMain || !overlayWanted(id) || !stripEnabled()) return;
    let frame = null;
    try { frame = electron().webFrameMain.fromId(processId, routingId); } catch { /* gone */ }
    if (!frame || frame.origin !== overlayMod.OS_ORIGIN) return;
    const css = JSON.stringify(taskbar.HOST_DOCK_CSS);
    void frame.executeJavaScript(`(() => { ${taskbar.hostFlagScript(true)}; const s = document.createElement("style"); s.textContent = ${css}; document.head.append(s); })()`).catch(() => {});
  });
  wireEveryday(wc, id);
  // Alt+O, awconnect's own key for the overlay.
  wc.on("before-input-event", (event, input) => {
    const act = everyday.keyAction(input);
    if (act && runBrowserAction(act.action, act.arg, id)) {
      event.preventDefault();
      return;
    }
    if (input.type === "keyDown" && input.alt && !input.control && !input.meta && String(input.key).toLowerCase() === "o") {
      event.preventDefault();
      setOverlay(!getPrefs().overlay);
      return;
    }
    // Ctrl+`: the terminal dock, from any tab.
    if (isDockKey(input)) {
      event.preventDefault();
      setDockOpen(undefined);
      return;
    }
    // Ctrl+K: awsh from any tab (os-command). Console pages keep their own palette key.
    if (isAwshKey(input) && kindOf() !== "internal") {
      event.preventDefault();
      openAwsh();
    }
  });
  for (const name of ["dom-ready", "did-navigate-in-page"]) wc.on(name, () => syncPageTaskbar(wc));
  wc.on("did-stop-loading", () => scheduleContextPush(id));
  // History: the finished page, remembered with WHO opened its tab.
  wc.on("did-stop-loading", () => {
    const tab = tabs.get(id);
    // Console pages are not "history": the address bar suggests them by name instead.
    if (tab && tab.kind === "web" && !tab.private) getLibrary().visit(wc.getURL(), wc.getTitle(), tab.by);
  });
}

/** May an agent see tab `id` as it is now: its own, or an owner tab shared on this page's origin. */
function agentMaySee(id) {
  const tab = tabs.get(id);
  if (!tab) return false;
  if (tab.by === "agent") return true;
  const view = viewOf(id);
  return tabs.isShared(id, view ? view.webContents.getURL() : "");
}

/** The owner's "Share with agent" toggle on one of their tabs (the strip's button). */
function shareTab(id, on) {
  const view = viewOf(id);
  const result = tabs.share(id, on ? (view ? view.webContents.getURL() : "") : null);
  if (result.ok && result.shared) scheduleContextPush(id);
  pushState();
  return result;
}

/**
 * Rebuild one agent tab's view in the session it should ride now (the toolbar's
 * "Let the agent use my sign-in" granted or revoked for its site). The tab keeps its
 * id, its place in the strip and its address; the page reloads in the other session.
 * A POPPED-OUT tab is left alone (its view lives in another window) -- it moves the
 * next time it is opened.
 */
function rebuildAgentView(id) {
  const tab = tabs.get(id);
  const view = viewOf(id);
  if (!tab || !view || popped.has(id)) return false;
  const url = view.webContents.getURL();
  const spec = tab.viewSpec || {};
  const webPartition = agentSessions.partitionFor({
    by: "agent", url, sites: getPrefs().agentCookieSites, ownerPartition: PARTITION, agentPartition: AGENT_PARTITION,
  });
  try { win.contentView.removeChildView(view); } catch { /* already detached */ }
  views.delete(id);
  try { view.webContents.close(); } catch { /* already closing */ }
  tab.viewSpec = { ...spec, kind: tab.kind, paneId: tab.paneId, url, webPartition };
  const next = createPageView(tab.kind, { paneId: tab.paneId, partition: spec.partition }, spec.partition, webPartition);
  views.set(id, next);
  wirePage(next.webContents, id);
  win.contentView.addChildView(next);
  if (alive(panelView)) win.contentView.addChildView(panelView);
  if (alive(taskbarView)) win.contentView.addChildView(taskbarView);
  layout();
  void loadInView(next, url).catch(() => {});
  return true;
}

/** Move every agent tab on `host` into the session the prefs now pick for it. */
function rehomeAgentTabs(host) {
  let moved = 0;
  for (const tab of tabs.tabs) {
    if (tab.by !== "agent" || tab.kind !== "web") continue;
    const view = viewOf(tab.id);
    if (!view || agentSessions.hostOf(view.webContents.getURL()) !== host) continue;
    if (rebuildAgentView(tab.id)) moved += 1;
  }
  return moved;
}

/**
 * The owner's "Let the agent use my sign-in" switch for the site on screen
 * (BROWSER-M3). Granting lets the agent's tabs for that site ride the OWNER's
 * session (his logins work); granting or revoking moves the agent tabs already open
 * on that site, so the switch takes effect at once -- a revoke is not a promise.
 * Default is off for every site.
 */
function agentSignIn(url, on) {
  const result = on
    ? agentSessions.allow(getPrefs().agentCookieSites, url)
    : agentSessions.revoke(getPrefs().agentCookieSites, url);
  if (!result.ok) return result;
  setPrefs({ agentCookieSites: result.sites });
  if (win && !win.isDestroyed()) rehomeAgentTabs(result.host);
  pushState();
  return { ok: true, host: result.host, on: Boolean(on), sites: result.sites };
}

/**
 * Tell AitherDesktop what this window has open (browser-context-push.cjs): the
 * page's machine layer, never its text or a field value. Debounced, so a page
 * that redirects twice is pushed once.
 */
function scheduleContextPush(id) {
  if (!contextPush.enabled() || id !== tabs.active) return;
  // BROWSER-5: the push feeds every agent's browser_context / browser_context_history,
  // so an OWNER tab goes only when they shared it. Their own question about the page
  // ("Ask about this page", desk:browser-ask) is the other door and needs no push.
  if (!agentMaySee(id)) return;
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
    if (!contextPush.pushable(url) || !agentMaySee(id)) return;
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
  // The agent's own session is hardened the same way (deny-by-default permissions,
  // an agent's download cancelled), and gets NO owner extension: awconnect is loaded
  // into PARTITION only, so an agent tab cannot reach the desk's signed-in bridges.
  hardenSession(session.fromPartition(AGENT_PARTITION));
  void ensureAwconnect();
  // Extensions you added on aither://extensions load with the browser.
  void require("./extensions-window.cjs").loadSaved(session.fromPartition(PARTITION)).catch(() => {});

  win = new BrowserWindow({
    width: 1320,
    height: 880,
    minWidth: 720,
    minHeight: 480,
    show: false,
    title: deskTenant.decorateTitle("Aither Browser", deskTenant.currentTenant()),
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
  win.webContents.on("before-input-event", (event, input) => {
    if (isDockKey(input)) { event.preventDefault(); setDockOpen(undefined); return; }
    // The standard keys work with the toolbar focused too (the address bar keeps its
    // own editing keys: none of them is a browser action).
    const act = everyday.keyAction(input);
    if (act && runBrowserAction(act.action, act.arg, tabs.active)) event.preventDefault();
  });
  // Session restore: what was open is written as the window closes (before the views go).
  win.on("close", () => { if (getPrefs().restoreSession !== false) getSessionStore().flush(tabList()); });

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
    ensureDock();
    ensureTaskbar();
    // Panes the owner left in their own windows come back there, where they were.
    for (const pane of deskLayout.DETACHABLE) {
      const was = getPrefs().desk.detached[pane];
      if (was && was.open) detachPane(pane);
    }
    layout();
    win.show();
    win.focus();
    setInboxBadge(inbox);
  });
  if (discardTimer) clearInterval(discardTimer);
  discardTimer = setInterval(() => discardHiddenTabs(), 60 * 1000);
  if (typeof discardTimer.unref === "function") discardTimer.unref();
  win.on("closed", () => {
    // Pane windows close with the browser, but stay "open" in the layout for next time.
    closingBrowser = true;
    for (const [, w] of paneWindows) if (w && !w.isDestroyed()) w.destroy();
    paneWindows.clear();
    paneSurfaces.reconcile(Object.fromEntries(deskLayout.DETACHABLE.map((pane) => [pane, false])));
    closingBrowser = false;
    editingLayout = false;
    if (discardTimer) clearInterval(discardTimer);
    discardTimer = null;
    if (openSignal) openSignal.dispose();
    openSignal = null;
    discarded.clear();
    shownAt.clear();
    lastLayoutKey = "";
    for (const view of [...views.values(), panelView, taskbarView, dockView]) {
      if (alive(view)) view.webContents.close();
    }
    dockView = null;
    dockStatus = "off";
    taskbarView = null;
    taskbarOpen = false;
    taskbarStatus = "off";
    for (const [, pop] of popped) if (pop && !pop.isDestroyed()) pop.destroy();
    popped.clear();
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
  // Continue where you left off (Edge's default): the owner's tabs from last time come
  // back first, then the page this open asked for. Nothing saved: the home page.
  const restored = getPrefs().restoreSession === false ? 0 : restoreSession();
  if (target && target.ok) openTab("you", target.url);
  else if (home && !restored) openTab("you", homeUrl());
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
/** Pure: does an editor's innerText hold what was typed? innerText adds a
 *  trailing newline in some editors and renders NBSP for runs of spaces. */
function editorKept(now, want) {
  const NBSP = String.fromCharCode(160);
  const LF = String.fromCharCode(10);
  const norm = (v) => {
    let t = String(v ?? "").split(NBSP).join(" ");
    while (t.endsWith(LF)) t = t.slice(0, -1);
    return t;
  };
  return norm(now) === norm(want);
}

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
      if (el.isContentEditable) {
        // A rich editor (Discord's Slate, Lexical, ProseMirror) keeps its OWN model
        // and redraws from it: textContent shows the words while the model stays
        // empty, so Enter sends nothing (measured 2026-11-09, three Enters into a
        // Discord DM). Select the editor's contents here; the main process then
        // inserts the text as real input (webContents.insertText), which every
        // editor handles through beforeinput, and reads it back.
        const range = document.createRange();
        range.selectNodeContents(el);
        const sel = window.getSelection();
        sel.removeAllRanges();
        sel.addRange(range);
        return { ok: true, editable: true, into: el.tagName.toLowerCase(), label };
      }
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
  if (action === "readback") {
    return `(() => { ${find}
      return { ok: true, now: el.isContentEditable ? el.innerText : el.value, label }; })()`;
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
  // BROWSER-5: the agent sees its own tabs whole, the owner's as ids and a count.
  tabs: async () => ({ ok: true, ...agentTabView(tabList()) }),
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
  async type(target, text) {
    const first = await runInPage("type", { target, text });
    if (!first || !first.editable) return first;
    // A contenteditable: the page selected its contents; insert as real input.
    const picked = viewFor("agent");
    if (!picked.ok) return { ok: false, error: picked.error };
    const wc = picked.view.webContents;
    wc.focus();
    const want = String(text ?? "");
    if (want) await wc.insertText(want);
    else wc.delete();
    const back = await runInPage("readback", { target });
    const now = back && back.ok ? String(back.now ?? "") : "";
    const kept = editorKept(now, want);
    return { ok: kept, typed: want.length, into: first.into, label: first.label,
      error: kept ? undefined : `the editor did not keep the text (it holds ${now.length} characters)` };
  },
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
  ipcMain.handle("desk:browser-tab-popout", (event, id) => (fromChrome(event) ? popOutTab(Number(id)) : { ok: false }));
  // The taskbar strip's terminal button: its own webContents only, its one command only.
  ipcMain.on("desk:taskbar-command", (event, id) => {
    if (!alive(taskbarView) || event.sender !== taskbarView.webContents) return;
    if (id === "terminal-dock.toggle") setDockOpen(undefined);
  });
  ipcMain.on("desk:taskbar-hello", (event) => {
    if (alive(taskbarView) && event.sender === taskbarView.webContents) sendTaskbarState();
  });
  ipcMain.handle("desk:browser-tab-dock", (event, id) => (fromChrome(event) ? dockTab(Number(id)) : { ok: false }));
  ipcMain.handle("desk:browser-rail", (event, action, arg) => {
    if (!fromChrome(event)) return { ok: false, error: "not the browser's own chrome" };
    const relayout = () => { layout(); pushState(); return { ok: true }; };
    if (action === "collapse") return setPrefs({ railCollapsed: Boolean(arg) }) && relayout();
    if (action === "panel") {
      // Hiding a panel that floats in its own window brings it home first.
      if (arg && paneDetached("panel")) attachPane("panel");
      return setPrefs({ panelCollapsed: Boolean(arg) }) && relayout();
    }
    if (action === "overlay") {
      // Back from the desktop (or off): the desk's overlay window steps down first.
      if (overlayOnDesktop()) shellHost.run("desktop.overlay.toggle");
      setOverlay(Boolean(arg));
      setTimeout(() => { layout(); pushState(); }, 150);
      return { ok: true };
    }
    if (action === "overlay-detach") {
      // Detach (owner, 2026-10-04): Online leaves the page and hovers on the real desktop
      // -- the desk's click-through overlay window (living-desktop), the same OS.
      if (!shellHost) return { ok: false, error: "the desk is still starting" };
      setOverlay(false);
      if (!overlayOnDesktop()) shellHost.run("desktop.overlay.toggle");
      setTimeout(() => { layout(); pushState(); }, 150);
      return { ok: true };
    }
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
    // The five law's own controls: un-fold ONE section's "+N more", or reveal the
    // non-primary destinations behind "More destinations".
    if (action === "section-all") {
      const name = String(arg || "");
      const open = new Set(getPrefs().expandedSections);
      if (open.has(name)) open.delete(name); else open.add(name);
      return setPrefs({ expandedSections: [...open] }) && relayout();
    }
    if (action === "sections-all") {
      const on = arg == null ? !getPrefs().railAllSections : Boolean(arg);
      return setPrefs({ railAllSections: on }) && relayout();
    }
    if (action === "reset-layout") return resetLayout();
    // The terminal dock: on/off for good, open/closed, and a drag of its top edge.
    if (action === "dock-on") {
      if (!arg && paneDetached("dock")) attachPane("dock");
      setPrefs({ dock: Boolean(arg) });
      if (arg) ensureDock();
      else if (alive(dockView)) placeView(dockView, false, null);
      return relayout();
    }
    if (action === "dock") return setDockOpen(arg == null ? undefined : Boolean(arg));
    if (action === "dock-drag") {
      const bounds = win.getContentBounds();
      setPrefs(rail.dockHeightFromDrag(Number(arg), { height: bounds.height,
        taskbarHeight: stripShown() ? rail.TASKBAR_HEIGHT : 0, side: getPrefs().desk.panes.dock.side, top: CHROME_HEIGHT }));
      sendDockState();
      return relayout();
    }
    // A gutter drag: "drag" true/false brackets it, "rail-width"/"panel-width" carry the size.
    if (action === "drag") {
      dragging = Boolean(arg);
      return relayout();
    }
    if (action === "rail-width") return setPrefs({ railWidth: Number(arg), railCollapsed: false }) && relayout();
    if (action === "panel-width") return setPrefs({ panelWidth: Number(arg), panelCollapsed: false }) && relayout();
    if (action === "page") {
      // Main may send a door somewhere else (space-home.cjs: Inbox/Fleet -> BeadSpace
      // when overlay.spaceHome is on). null = the pane itself, exactly as before.
      const home = typeof internalConfig.homeFor === "function" ? internalConfig.homeFor(String(arg || "")) : null;
      if (home && openInternalUrl(home)) return { ok: true };
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
    if (action === "online") return openAgentApp(String(arg || ""));
    // "<id>:<mode>" -- the rail row's mode chip (launch-modes.cjs). Persisted per app.
    if (action === "launch-mode") {
      const want = launchModes.parseModeArg(arg);
      if (!want || !rail.isAgentApp(want.id)) return { ok: false, error: "not an app launch mode" };
      setPrefs({ launchModes: launchModes.withMode(getPrefs().launchModes, want.id, want.mode) });
      pushState();
      return { ok: true, mode: want.mode };
    }
    if (action === "workspace") return openWorkspacePage(String(arg || ""));
    if (action === "local") {
      // The owner's loopback tools (Grafana, Prometheus): owner-only, fixed URLs.
      if (!hostOwner() || !rail.isOwnerLocal(arg)) return { ok: false, error: "not available" };
      const opened = openTab("you", String(arg));
      return opened.ok ? { ok: true } : { ok: false, error: opened.error };
    }
    if (action === "browser") {
      if (arg === "awconnect") return openAwconnect();
      if (arg === "forge") return openForge();
      if (arg === "read-aloud") return readAloud();
      return { ok: false, error: "unknown browser action" };
    }
    if (action === "menu") {
      if (!shellHost) return { ok: false, error: "the desk is still starting" };
      shellHost.popupMenu(win);
      return { ok: true };
    }
    // The layout document (desk-layout.cjs): edit mode, sides, detach, presets, the
    // rail's arrangement, layer order, export/import. Every one is also a palette
    // command (layoutCommand) -- no capability is gesture-only.
    const layoutVerdict = layoutAction(action, arg);
    if (layoutVerdict) return layoutVerdict;
    return { ok: false, error: "unknown rail action" };
  });
  // A tab's right-click: Pin to canvas, pop out / dock back, close.
  ipcMain.handle("desk:browser-tab-menu", (event, id) => (fromChrome(event) ? tabMenu(Number(id)) : { ok: false }));
  // aither://canvas: its boards, widgets and live app cards (browser-canvas.cjs).
  getCanvas().wire(ipcMain);
  ipcMain.handle("desk:browser-navigate", async (event, input) => {
    if (!fromChrome(event)) return { ok: false, reason: "not the browser toolbar" };
    // The OWNER typing aither://<pane> into the address bar opens that console page.
    // Only here: sanitizeUrl (what agents and links pass through) still refuses it.
    const typed = typeof input === "string" ? input.trim() : "";
    const page = internal.parseInternalUrl(typed);
    if (page) {
      // A deep link (aither://space/?at=<id>) keeps its validated keys; nothing else rides.
      const link = internal.deepLinkOf(page);
      return openInternal(page.paneId, link) ? { ok: true, url: internal.internalUrl(page.paneId, link) }
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
  // Edge parity: the ⋯ menu, the key icon, a notice's buttons, find on page, zoom badge.
  ipcMain.handle("desk:browser-menu", (event) => (fromChrome(event) ? browserMenu() : { ok: false }));
  ipcMain.handle("desk:browser-passwords", (event) => (fromChrome(event) ? passwordMenu() : { ok: false }));
  ipcMain.handle("desk:browser-notice", (event, action) => (fromChrome(event) ? noticeAction(String(action || "")) : { ok: false }));
  ipcMain.on("desk:browser-find", (event, text, forward) => {
    const wc = pageWc(tabs.active);
    if (!fromChrome(event) || !wc) return;
    const q = typeof text === "string" ? text.slice(0, 500) : "";
    const prev = findResults.get(tabs.active) || {};
    if (!q) { wc.stopFindInPage("clearSelection"); findResults.delete(tabs.active); pushState(); return; }
    findResults.set(tabs.active, { text: q, matches: prev.text === q ? prev.matches : 0, active: prev.text === q ? prev.active : 0 });
    wc.findInPage(q, { forward: forward !== false, findNext: prev.text === q });
  });
  ipcMain.on("desk:browser-find-stop", (event) => {
    const wc = pageWc(tabs.active);
    if (!fromChrome(event) || !wc) return;
    wc.stopFindInPage("keepSelection");
    findResults.delete(tabs.active);
    pushState();
    wc.focus();
  });
  ipcMain.on("desk:browser-action", (event, action) => {
    if (fromChrome(event)) runBrowserAction(String(action || ""), null, tabs.active);
  });
  // The Connect panel: what the owner has selected, an agent task, and "Open in Chrome".
  // Notes and memory about the page on screen (knowledge-client.cjs). The PANEL asks;
  // main supplies the page's title and address and the owner's selection itself.
  ipcMain.handle("desk:browser-knowledge", async (event, action, args) => {
    if (!fromPanel(event)) return { ok: false, error: "not the side panel" };
    const view = activeView();
    const page = view ? { title: view.webContents.getTitle(), url: view.webContents.getURL() } : { title: "", url: "" };
    const kc = knowledgeClient();
    const comment = String((args && args.comment) || "");
    if (action === "related") return kc.related(page);
    if (action !== "save" && action !== "remember") return { ok: false, error: "unknown notes action" };
    const sel = await runInPage("selection", {}, "owner").catch(() => ({ text: "" }));
    const selection = String((sel && sel.text) || "");
    if (action === "save") return kc.savePage({ ...page, selection, comment });
    return kc.rememberText({ text: [selection, comment].filter(Boolean).join("\n\n"), ...page });
  });
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
  ipcMain.handle("desk:browser-tab-share", (event, id, on) => (fromChrome(event) ? shareTab(Number(id), Boolean(on)) : { ok: false }));
  // BROWSER-M3: "Let the agent use my sign-in" on the site on screen, and the
  // revoke list's rows (a bare host, no page). Only the browser's own chrome asks.
  ipcMain.handle("desk:browser-agent-signin", (event, url, on) => (fromChrome(event)
    ? agentSignIn(String(url ?? ""), Boolean(on)) : { ok: false, error: "not the browser's own chrome" }));
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
    return askAboutPage(question, extra);
  });
}

/**
 * Ask about the page on screen: the panel's chat, and the owner's VOICE while the browser
 * has focus (main desk:voice-heard -> voiceAsk). The OWNER's read of the page, their notes
 * and memories as graph-RAG context, one agent answer.
 */
async function askAboutPage(question, extra) {
  if (typeof askAgent !== "function") return { ok: false, reply: "The desk's agent is not wired to this window." };
  // The OWNER's read: not an agent tool call, so it does not pass the gate.
  const page = await runInPage("read", {}, "owner").catch((error) => ({ ok: false, error: String(error.message || error) }));
  if (!page || page.ok === false) return { ok: false, reply: `Could not read the page: ${page && page.error}` };
  const opts = extra && typeof extra === "object" ? extra : {};
  // Graph RAG, the owner's half: their notes and memories that match this page ride
  // along (knowledge-client related()), bounded so a slow memory never stalls an answer.
  const related = await Promise.race([
    knowledgeClient().related({ title: page.title, url: page.url }).catch(() => null),
    new Promise((resolve) => setTimeout(() => resolve(null), 4000)),
  ]);
  const knowledge = related ? [
    ...(related.notes || []).map((n) => ({ kind: "note", text: `${n.title}: ${n.snippet}` })),
    ...(related.memories || []).map((m) => ({ kind: "memory", text: m.text })),
  ] : [];
  const prompt = policy.buildConnectPrompt({
    knowledge,
    url: page.url, title: page.title, text: page.text, question: typeof question === "string" ? question.slice(0, 2000) : "",
    selection: typeof opts.selection === "string" ? opts.selection : "",
    history: Array.isArray(opts.history) ? opts.history : [],
  });
  try {
    const result = await askAgent(prompt);
    const ok = result?.ok !== false;
    const reply = String(result?.reply || "");
    // ONE THREAD: the local brain's answer joins the shared server thread, so awconnect and
    // AitherOS Online see it too. Fire-and-forget: a signed-out desk keeps it local only.
    if (ok && reply) void getDeskThread().persistTurn(question, reply).catch(() => null);
    return { ok, reply };
  } catch (error) {
    return { ok: false, reply: String(error?.message || error) };
  }
}

/** The browser (or a page popped out of it) has focus: the owner's voice is about this page. */
function hasVoiceFocus() {
  if (win && !win.isDestroyed() && win.isFocused()) return true;
  for (const pop of popped.values()) if (pop && !pop.isDestroyed() && pop.isFocused()) return true;
  return false;
}

/** A spoken question about the page: answered by askAboutPage, shown in the panel's chat too. */
async function voiceAsk(said) {
  const question = String(said || "").slice(0, 2000);
  const sendPanel = (payload) => { if (alive(panelView)) panelView.webContents.send("desk:browser-voice", payload); };
  sendPanel({ q: question, a: null });
  const result = await askAboutPage(question, {});
  sendPanel({ q: question, a: result.reply, ok: result.ok });
  return result;
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
// ── the layout document: detach, presets, the rail's arrangement, the canvas ──────
// Owner, 2026-11-07: "resize and detach/reattach, reorganize and rearrange, and have
// access to a canvas for pinning apps and widgets." The pure rules live in
// desk-layout.cjs and canvas-model.cjs; this block is the electron half.

/** The view a detachable pane is. */
function paneView(pane) {
  return pane === "panel" ? panelView : pane === "dock" ? dockView : pane === "taskbar" ? taskbarView : null;
}

/** Ask the pane windows (the oracle) and fold the answer into paneSurfaces. */
function observePanes() {
  const observed = {};
  for (const pane of deskLayout.DETACHABLE) {
    const w = paneWindows.get(pane);
    observed[pane] = Boolean(w && !w.isDestroyed());
  }
  return paneSurfaces.reconcile(observed);
}

/** Default size of a pane's own window, before the owner moves it. */
const PANE_WINDOW_SIZE = Object.freeze({
  panel: { width: 420, height: 760 }, dock: { width: 960, height: 380 }, taskbar: { width: 960, height: 120 },
});

/**
 * Pop a pane into its own window (put it on any monitor). Same move as a popped-out
 * tab: the VIEW changes window, so the page keeps its state and its IPC sender is
 * still the one main checks. Its bounds are remembered per pane and reused next time
 * -- unless that monitor is gone (desk-layout.fitBounds).
 */
function detachPane(pane) {
  if (!deskLayout.DETACHABLE.includes(pane)) {
    return { ok: false, error: `${deskLayout.PANE_LABELS[pane] || pane} cannot leave the window (it is the window's own chrome)` };
  }
  if (!win || win.isDestroyed()) return { ok: false, error: "The Aither Browser is not open." };
  if (pane === "dock") { if (!getPrefs().dock) setPrefs({ dock: true }); ensureDock(); }
  if (pane === "taskbar") { if (!getPrefs().taskbar) setPrefs({ taskbar: true }); ensureTaskbar(); }
  if (pane === "panel" && getPrefs().panelCollapsed) setPrefs({ panelCollapsed: false });
  const view = paneView(pane);
  if (!alive(view)) return { ok: false, error: `${deskLayout.PANE_LABELS[pane]} is not running` };
  const existing = paneWindows.get(pane);
  if (existing && !existing.isDestroyed()) { existing.show(); existing.focus(); return { ok: true }; }
  const { BrowserWindow, screen } = electron();
  const main = win.getBounds();
  const size = PANE_WINDOW_SIZE[pane];
  const fallback = { x: main.x + 80, y: main.y + 80, ...size };
  let areas = [];
  try { areas = screen.getAllDisplays().map((d) => d.workArea); } catch { /* no screen yet */ }
  const saved = getPrefs().desk.detached[pane];
  const bounds = deskLayout.fitBounds(saved && saved.bounds, areas, fallback);
  const w = new BrowserWindow({
    ...bounds, minWidth: 240, minHeight: 100, title: `${deskLayout.PANE_LABELS[pane]} — Aither`,
    autoHideMenuBar: true, backgroundColor: "#0f1218",
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  w.loadURL("about:blank").catch(() => {});
  try { win.contentView.removeChildView(view); } catch { /* not a child */ }
  w.contentView.addChildView(view);
  const fit = () => {
    if (w.isDestroyed() || !alive(view)) return;
    const { width, height } = w.getContentBounds();
    forgetPlacement(view);
    view.setVisible(true);
    view.setBounds({ x: 0, y: 0, width, height });
  };
  fit();
  let saveTimer = null;
  const remember = () => {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      if (!w.isDestroyed()) setPrefs({ desk: deskLayout.withDetached(getPrefs().desk, pane, { bounds: w.getBounds() }) });
    }, 300);
  };
  w.on("resize", () => { fit(); remember(); });
  w.on("move", remember);
  // Closed from its own title bar: the pane comes home (the window is the oracle).
  w.on("closed", () => { clearTimeout(saveTimer); attachPane(pane, { closing: true }); });
  paneWindows.set(pane, w);
  setPrefs({ desk: deskLayout.withDetached(getPrefs().desk, pane, { bounds: w.getBounds(), open: true }) });
  observePanes();
  layout();
  pushState();
  return { ok: true };
}

/** Bring a detached pane back into the browser and close its window. */
function attachPane(pane, { closing = false } = {}) {
  if (!deskLayout.DETACHABLE.includes(pane)) return { ok: false, error: `${pane} is not a detachable pane` };
  const w = paneWindows.get(pane);
  paneWindows.delete(pane);
  const view = paneView(pane);
  if (w && !w.isDestroyed() && alive(view)) {
    try { w.contentView.removeChildView(view); } catch { /* already gone */ }
  }
  if (alive(view) && win && !win.isDestroyed() && !closingBrowser) {
    forgetPlacement(view);
    win.contentView.addChildView(view);
    // The taskbar stays on top (its menus open upward over the page).
    if (pane !== "taskbar" && alive(taskbarView) && !paneDetached("taskbar")) win.contentView.addChildView(taskbarView);
  }
  // A browser that is closing keeps "open": the pane comes back detached next time.
  if (!closingBrowser) setPrefs({ desk: deskLayout.withDetached(getPrefs().desk, pane, { open: false }) });
  if (w && !closing && !w.isDestroyed()) w.close();
  observePanes();
  layout();
  pushState();
  return { ok: true };
}

/** Reset layout: geometry, sides, layer order and the rail's section/row order. Pins, presets and boards stay. */
function resetLayout() {
  for (const pane of deskLayout.DETACHABLE) if (paneDetached(pane)) attachPane(pane);
  const desk = getPrefs().desk;
  const fresh = deskLayout.normalizeDesk({});
  setPrefs({ railWidth: null, panelWidth: null, railCollapsed: false,
    panelCollapsed: false, taskbar: true, collapsedSections: [], expandedSections: [], railAllSections: false,
    dock: true, dockOpen: false, dockHeight: null,
    desk: { ...desk, panes: fresh.panes, layerOrder: fresh.layerOrder, activePreset: null,
      rail: { ...fresh.rail, pinned: desk.rail.pinned } } });
  ensureDock();
  ensureTaskbar();
  layout();
  pushState();
  return { ok: true };
}

/** A structured argument from the chrome page (the preload stringifies everything). */
function parseArg(arg) {
  if (arg && typeof arg === "object") return arg;
  try { return JSON.parse(String(arg || "")); } catch { return null; }
}

/** Apply a prefs patch from desk-layout and re-lay the window. */
function applyPatch(result) {
  if (!result || !result.ok) return result || { ok: false, error: "refused" };
  setPrefs(result.patch);
  if (getPrefs().dock) ensureDock();
  if (getPrefs().taskbar) ensureTaskbar();
  if (canvasHost && result.patch.desk && result.patch.desk.boards) canvasHost.broadcast();
  layout();
  pushState();
  sendDockState();
  return { ok: true };
}

/** One edit of the rail's arrangement (desk-layout.editRail), judged against what is on screen. */
function railEdit(op) {
  const result = deskLayout.editRail(getPrefs().desk.rail, op, arrangedSections());
  if (!result.ok) return result;
  setPrefs({ desk: { ...getPrefs().desk, rail: result.custom } });
  layout();
  pushState();
  return { ok: true };
}

/** Every rail row as the owner sees it now, flat, with the section it shows in. */
function railRows() {
  const out = [];
  for (const sec of arrangedSections()) for (const row of sec.rows) out.push({ row, section: sec.name });
  return out;
}

/** A row's address, for "Pin to canvas" (null: a command row opens nothing to pin). */
function rowUrl(row) {
  if (!row) return null;
  try {
    if (row.kind === "page") return internal.internalUrl(internal.paneById(row.id), null);
    if (row.kind === "workspace") return new URL(row.id, internal.onlineUrl()).href;
    if (row.kind === "local") return String(row.id);
    if (row.kind === "online") return launchModes.appUrl(internal.onlineUrl(), row.id, "tab");
  } catch { /* not addressable */ }
  return null;
}

/** A rail row's right-click: pin / remove / move, and Pin to canvas. Keyboard: the context-menu key. */
function rowMenu(key) {
  if (!win || win.isDestroyed()) return { ok: false };
  const { Menu } = electron();
  const all = railRows();
  const hit = all.find((x) => deskLayout.railRowKey(x.row) === key);
  if (!hit) return { ok: false, error: "that row is not on the rail" };
  const custom = getPrefs().desk.rail;
  const pinned = custom.pinned.includes(key);
  const sections = arrangedSections().map((s) => s.name).filter((n) => n !== deskLayout.PINNED_SECTION);
  const url = rowUrl(hit.row);
  const template = [
    pinned ? { label: "Unpin from rail", click: () => railEdit({ op: "unpin", key }) }
      : { label: "Pin to rail", click: () => railEdit({ op: "pin", key }) },
    { label: "Remove from rail", click: () => railEdit({ op: "hide", key }) },
    { type: "separator" },
    { label: "Move up", accelerator: "Alt+Up", click: () => railEdit({ op: "nudge-row", key, by: -1 }) },
    { label: "Move down", accelerator: "Alt+Down", click: () => railEdit({ op: "nudge-row", key, by: 1 }) },
    { label: "Move to section", submenu: sections.filter((n) => n !== hit.section)
      .map((name) => ({ label: name, click: () => railEdit({ op: "move-row", key, section: name, index: 0 }) })) },
    { type: "separator" },
    { label: "Pin to canvas", enabled: Boolean(url), click: () => pinToCanvas(url, hit.row.label) },
  ];
  if (custom.hidden.length) {
    template.push({ type: "separator" },
      { label: `Restore removed rows (${custom.hidden.length})`, click: () => railEdit({ op: "restore" }) });
  }
  Menu.buildFromTemplate(template).popup({ window: win });
  return { ok: true };
}

/** A tab's right-click (also the context-menu key on a focused tab). */
function tabMenu(id) {
  if (!win || win.isDestroyed()) return { ok: false };
  const tab = tabs.get(id);
  const view = viewOf(id);
  if (!tab) return { ok: false, error: "no such tab" };
  const { Menu } = electron();
  const url = view ? view.webContents.getURL() : (discarded.get(id) || {}).url || "";
  const title = view ? view.webContents.getTitle() : "";
  const pinnable = Boolean(canvasModelUrl(url)) && tab.by === "you";
  // "Pin this tab to desktop" is desk-pins-ink's `pins.tab` command (a card on the real
  // desktop); the row is live only once the registry carries it.
  const desktopPin = Boolean(require("./command-registry.cjs").byId("pins.tab")) && Boolean(shellHost);
  const template = [
    { label: "Pin to canvas", enabled: pinnable, click: () => void pinToCanvas(url, title) },
    { label: "Pin this tab to desktop", enabled: desktopPin && pinnable,
      click: () => shellHost.run("pins.tab", id) },
    { type: "separator" },
    popped.has(id) ? { label: "Dock back into the browser", click: () => dockTab(id) }
      : { label: "Pop out into its own window", click: () => popOutTab(id) },
  ];
  if (!tab.pinned) template.push({ label: "Close tab", click: () => closeTab(id) });
  Menu.buildFromTemplate(template).popup({ window: win });
  return { ok: true };
}

function canvasModelUrl(url) {
  return require("./canvas-model.cjs").appUrl(url);
}

/** "Export layout": the layout model, the owner's presets and boards, as one JSON file. */
async function exportLayout() {
  const { dialog } = electron();
  const doc = deskLayout.exportDoc(getPrefs());
  const pick = await dialog.showSaveDialog(win && !win.isDestroyed() ? win : undefined, {
    title: "Export the browser layout", defaultPath: "aither-layout.json",
    filters: [{ name: "Aither layout", extensions: ["json"] }],
  });
  if (pick.canceled || !pick.filePath) return { ok: false, canceled: true };
  require("node:fs").writeFileSync(pick.filePath, JSON.stringify(doc, null, 2));
  return { ok: true, path: pick.filePath };
}

/** "Import layout": strict (desk-layout.importDoc) -- a bad file says why and changes nothing. */
async function importLayout() {
  const { dialog } = electron();
  const pick = await dialog.showOpenDialog(win && !win.isDestroyed() ? win : undefined, {
    title: "Import a browser layout", properties: ["openFile"],
    filters: [{ name: "Aither layout", extensions: ["json"] }],
  });
  if (pick.canceled || !pick.filePaths || !pick.filePaths[0]) return { ok: false, canceled: true };
  const fs = require("node:fs");
  const file = pick.filePaths[0];
  if (fs.statSync(file).size > 2 * 1024 * 1024) return { ok: false, error: "that file is over 2 MB; a layout is a few KB" };
  const result = deskLayout.importDoc(getPrefs(), fs.readFileSync(file, "utf8"));
  if (!result.ok) return { ok: false, error: result.errors.slice(0, 5).join("; ") };
  return applyPatch(result);
}

/**
 * The rail/customize actions of the layout document. Returns null for an action that
 * is not one of these (the caller keeps looking).
 */
function layoutAction(action, arg) {
  const relayout = () => { layout(); pushState(); return { ok: true }; };
  switch (action) {
    case "edit-layout":
      editingLayout = typeof arg === "boolean" ? arg : !editingLayout;
      return relayout();
    case "pane-side": {
      const want = deskLayout.parsePaneSide(arg);
      if (!want) return { ok: false, error: "say a pane and a side: panel:left" };
      return applyPatch(deskLayout.setPaneSide(getPrefs(), want.pane, want.side));
    }
    case "pane-detach":
      return detachPane(String(arg || ""));
    case "pane-attach":
      return attachPane(String(arg || ""));
    case "layers-visible": {
      const desk = JSON.parse(JSON.stringify(getPrefs().desk));
      desk.panes.layers.visible = typeof arg === "boolean" ? arg : !desk.panes.layers.visible;
      desk.activePreset = null;
      setPrefs({ desk });
      return relayout();
    }
    case "preset":
      return applyPatch(deskLayout.applyPreset(getPrefs(), String(arg || "")));
    case "preset-save":
      return applyPatch(deskLayout.savePreset(getPrefs(), String(arg || "")));
    case "preset-rename": {
      const o = parseArg(arg) || {};
      return applyPatch(deskLayout.renamePreset(getPrefs(), o.from, o.to));
    }
    case "preset-delete":
      return applyPatch(deskLayout.deletePreset(getPrefs(), String(arg || "")));
    case "layout-export":
      return exportLayout();
    case "layout-import":
      return importLayout();
    case "rail-edit":
      return railEdit(parseArg(arg));
    case "row-menu":
      return rowMenu(String(arg || ""));
    case "layer-move": {
      const o = parseArg(arg) || {};
      const moved = deskLayout.moveLayer(getPrefs().desk.layerOrder, String(o.key || ""),
        { index: o.index == null ? null : Number(o.index), by: Number(o.by) || 0 });
      if (!moved.ok) return moved;
      setPrefs({ desk: { ...getPrefs().desk, layerOrder: moved.order } });
      return relayout();
    }
    default:
      return null;
  }
}

/* ── the canvas (aither://canvas) ─────────────────────────────────────────────── */

/**
 * The live view behind an app card: the browser's ONE page-view builder, the session a
 * tab of that address would ride (the owner's; an aitherium.com page signed in), and
 * the same navigation rules a tab of that kind has.
 */
function makeCardView(url) {
  const target = classify(url);
  if (target.kind === "refused") return { ok: false, error: target.error };
  let kind = target.kind;
  let address = target.url;
  let hostedPartition = target.partition || null;
  if (kind === "web") {
    const verdict = policy.sanitizeUrl(url);
    if (!verdict.ok) return { ok: false, error: verdict.reason };
    address = verdict.url;
    const signedIn = internal.ownerHostedPartition("you", address, { explicit: null, online: onlinePartition() });
    if (signedIn) { kind = "hosted"; hostedPartition = signedIn; }
  }
  if (kind === "internal") {
    if (target.paneId === "canvas") return { ok: false, error: "the canvas does not hold itself" };
    if (typeof internalConfig.beforeInternal === "function") {
      try { internalConfig.beforeInternal(); } catch { /* the page shows its own error */ }
    }
    ensureInternalSession();
  }
  const view = createPageView(kind, { ...target, partition: hostedPartition }, hostedPartition, PARTITION);
  guardCardView(view.webContents, kind);
  if (kind === "hosted") void loadHostedTab(view, address).catch(() => {});
  else void loadInView(view, address).catch(() => {});
  return { ok: true, view, kind };
}

/** A card's page obeys its kind's navigation rules; a popup or a foreign link becomes an owner tab. */
function guardCardView(wc, kind) {
  wc.setWindowOpenHandler(({ url }) => {
    if (policy.isNavigable(url)) openTab("you", url, { activate: true });
    else if (kind === "internal" && internal.isInternalUrl(url)) openTab("you", url, { activate: true });
    return { action: "deny" };
  });
  const verdict = (url, opts) => internal.navigationVerdict(kind, url, opts);
  wc.on("will-navigate", (event, url) => {
    const v = verdict(url);
    if (v === "allow") return;
    event.preventDefault();
    if (v === "web-tab") openTab("you", url, { activate: true });
  });
  wc.on("will-redirect", (event, url) => { if (verdict(url) !== "allow") event.preventDefault(); });
  wc.on("will-frame-navigate", (details) => {
    if (!details || details.isMainFrame) return;
    if (verdict(details.url, { frame: true }) !== "allow") details.preventDefault();
  });
  wc.on("will-attach-webview", (event) => event.preventDefault());
}

/** Which window holds the canvas page `wc`, where its page area starts, and is it on screen. */
function canvasHostOf(wc) {
  let id = null;
  for (const [tabId, view] of views) if (alive(view) && view.webContents === wc) { id = tabId; break; }
  if (id == null || !win || win.isDestroyed()) return null;
  const pop = popped.get(id);
  if (pop && !pop.isDestroyed()) return { window: pop, origin: { x: 0, y: 0 }, shown: pop.isVisible() };
  const rects = currentRects();
  return { window: win, origin: { x: rects.page.x, y: rects.page.y }, shown: id === tabs.active && !viewsAside() };
}

let termClient = null;
let aitheroneClient = null;
function getCanvas() {
  if (canvasHost) return canvasHost;
  canvasHost = require("./browser-canvas.cjs").createCanvasHost({
    // ONE store: the canvas is a desk whiteboard (boards-core / boards-window).
    store: require("./boards-window.cjs"),
    // The layout document only says WHICH board the canvas shows.
    getActive: () => getPrefs().desk.canvasBoard,
    setActive: (id) => setPrefs({ desk: { ...getPrefs().desk, canvasBoard: id || null } }),
    // AitherOne: the Online site's /api/docs/* (the routes Veil's canvas uses), with
    // the desk's existing Online session bearer. No new credential path.
    aitherone: () => {
      let base;
      try { base = internal.onlineUrl(); } catch { base = null; }
      if (!base) return null;
      if (!aitheroneClient || aitheroneClient.base !== base) {
        aitheroneClient = { base, client: require("./aitherone-link.cjs").createClient({
          base, token: async () => onlineToken(), fetchImpl: (url, init) => electron().net.fetch(url, init) }) };
      }
      return aitheroneClient;
    },
    makeView: (url) => makeCardView(url),
    hostOf: (wc) => canvasHostOf(wc),
    openTab: (url) => {
      if (internal.isInternalUrl(url)) return openInternalUrl(url) ? { ok: true } : { ok: false, error: "no such Aither page" };
      const opened = openTab("you", url, { activate: true });
      return opened.ok ? { ok: true } : { ok: false, error: opened.error };
    },
    // Read-only sources for the widgets (canvas-widgets/*.cjs): the same numbers the
    // tray badge, the terminal page and the Inference Ops window show.
    widgetCtx: {
      inbox: () => inbox.count,
      sessions: () => {
        if (!termClient) termClient = require("./terminal-client.cjs").createTerminalClient();
        return termClient.list();
      },
      inference: () => require("./inference-window.cjs").getInferenceOpsWidget().poll(),
    },
  });
  return canvasHost;
}

/** Pin an address onto the active board (as the kind it is: pin-item.pinItemFromUrl). */
async function pinToCanvas(url, title = "") {
  const result = await getCanvas().pin(String(url || ""), String(title || ""));
  if (result.ok) pushState();
  return result.ok ? { ok: true, card: result.pin } : result;
}

/** A rail row by what the owner typed: its label (case-insensitive) or its key. */
function rowByName(text) {
  const want = String(text || "").trim().toLowerCase();
  if (!want) return null;
  const rows = railRows();
  return rows.find((x) => deskLayout.railRowKey(x.row).toLowerCase() === want)
    || rows.find((x) => String(x.row.label || "").toLowerCase() === want) || null;
}

/**
 * The registry's layout commands (command-registry records carrying `layout`), so every
 * gesture has a palette path. `arg` is the palette's typed text for a `prompt` record.
 */
function layoutCommand(verb, arg = "") {
  const v = String(verb || "");
  const text = String(arg == null ? "" : arg).trim();
  if (!win || win.isDestroyed()) createBrowserWindow({ url: null, home: true });
  if (v.startsWith("preset:")) return layoutAction("preset", v.slice("preset:".length));
  switch (v) {
    case "edit": return layoutAction("edit-layout", undefined);
    case "save": return layoutAction("preset-save", text);
    case "load": return layoutAction("preset", text);
    case "export": return exportLayout();
    case "import": return importLayout();
    case "reset": return resetLayout();
    case "side": {
      // "panel left", "dock top", "rail right"
      const [pane, side] = text.toLowerCase().split(/[\s:]+/);
      return layoutAction("pane-side", `${pane || ""}:${side || ""}`);
    }
    case "detach": return detachPane(text.toLowerCase());
    case "attach": return attachPane(text.toLowerCase());
    case "layers": return layoutAction("layers-visible", undefined);
    case "rail.pin":
    case "rail.remove": {
      const hit = rowByName(text);
      if (!hit) return { ok: false, error: `no rail row called ${text}` };
      return railEdit({ op: v === "rail.pin" ? "pin" : "hide", key: deskLayout.railRowKey(hit.row) });
    }
    case "rail.restore": return railEdit({ op: "restore" });
    case "rail.move": {
      // "Files up" | "Files down" | "Files to Work"
      const m = /^(.+?)\s+(up|down|to\s+(.+))$/i.exec(text);
      const hit = m && rowByName(m[1]);
      if (!hit) return { ok: false, error: "say a row and up, down, or 'to <section>'" };
      const key = deskLayout.railRowKey(hit.row);
      if (m[3]) {
        const section = arrangedSections().map((s) => s.name).find((n) => n.toLowerCase() === m[3].trim().toLowerCase());
        if (!section) return { ok: false, error: `no section called ${m[3]}` };
        return railEdit({ op: "move-row", key, section, index: 0 });
      }
      return railEdit({ op: "nudge-row", key, by: m[2].toLowerCase() === "up" ? -1 : 1 });
    }
    case "canvas.open":
      return openInternal("canvas", null) ? { ok: true } : { ok: false, error: "the canvas page is missing" };
    case "canvas.pin-tab": {
      const view = activeView();
      if (!view) return { ok: false, error: "no tab to pin" };
      return pinToCanvas(view.webContents.getURL(), view.webContents.getTitle());
    }
    case "canvas.pin-url":
      return pinToCanvas(/^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `https://${text}`, "");
    default:
      return { ok: false, error: `no layout command ${v}` };
  }
}


function setAgentsHost(host) {
  const ok = host && typeof host.view === "function" && typeof host.check === "function"
    && typeof host.answer === "function";
  agentsHost = ok ? host : null;
}

require("./extensions-window.cjs").setExtensionsHost({
  session: () => electron().session.fromPartition(PARTITION),
  awconnectId: () => (awconnect.ok ? awconnect.id : null),
  openExtensionUi: (id) => openExtensionUi(id),
});

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
  /** Memory pressure (resource-watchdog.cjs): close hidden tabs' renderers now. */
  discardHiddenTabs,
  ASSISTANT_PANEL,
  CHROME_HEIGHT,
  classify,
  closeInternalTabOf,
  configureInternal,
  openInternal,
  openInternalUrl,
  sendToInternalTabs,
  setInboxBadge,
  ISOLATED_WORLD_ID,
  KEY_CODES,
  PARTITION,
  /** The agent's own session (BROWSER-M3); its tabs ride this unless a site is allowed. */
  AGENT_PARTITION,
  browserAgent,
  closeBrowserWindow,
  createAssistantPanel,
  createBrowserWindow,
  openOnlineApp,
  getGate: () => gate,
  getTabs: () => tabs,
  getState: () => state(),
  getLibrary,
  screenPage,
  /** Edge parity: a standard key / menu action by name, a notice button, and their pieces (smoke). */
  runBrowserAction,
  noticeAction,
  browserMenu,
  getAdblock,
  getVault,
  __pageForTest: (id) => pageWc(id),
  __noticeForTest: (id) => tabNotices.get(id) || null,
  /** The owner clicking a tab, for browser-tabs-smoke.cjs (the strip's IPC needs a real sender). */
  __showTabForTest: (id) => showTab(id),
  /**
   * BROWSER-M3, for browser-tabs-smoke.cjs: the live Session a tab's view rides, and
   * the toolbar's "Let the agent use my sign-in" switch (the IPC needs a real sender).
   */
  __tabSessionForTest: (id) => { const v = viewOf(id); return v ? v.webContents.session : null; },
  __agentSignInForTest: (url, on) => agentSignIn(String(url ?? ""), Boolean(on)),
  /** AitherOS Online over web pages (browser-overlay.cjs): the Online layer / Alt+O. */
  setOverlay,
  /** One identity: the Online session's bearer, its sign-in/out, and awconnect's view of it. */
  onlineToken,
  followTenant,
  watchOnlineAuth,
  getDeskThread,
  overlayAnswer,
  /** awsh from anywhere: raise Online and open awsh there (Ctrl+K in the browser). */
  openAwsh,
  isAwshKey,
  /** Ctrl+`: the terminal dock; and the dock page's verbs (open/close/toggle/popout). */
  isDockKey,
  dockAction,
  /** A linked phone opening one of the owner's tabs (phone-link.cjs tab.show). */
  showTab: (id) => showTab(String(id || "")),
  awconnectDeskSession,
  /** Read the selection, else the page, aloud (the Voice section's Read aloud). */
  readAloud,
  /** The owner's voice, while the browser has focus, goes to the page's agent (main desk:voice-heard). */
  hasVoiceFocus,
  voiceAsk,
  /** The pinned Online tab(s) carrying the desk-host preload, for living-desktop-window's fence. */
  deskHostContents: () => tabs ? tabs.tabs.filter((t) => t.kind === "hosted" && t.paneId === "desktop")
    .map((t) => viewOf(t.id)).filter(alive).map((v) => v.webContents) : [],
  /** A tab the owner opened, for overlay-smoke.cjs. */
  __openTabForTest: (url) => openTab("you", url),
  isBrowserWindowOpen,
  /** The registry's layout.* / rail.* / canvas.* commands (command-registry `layout` field). */
  layoutCommand,
  /** "Pin to canvas" from outside the browser (main, a phone): an address onto the active board. */
  pinToCanvas,
  /** The floating board window's pin door (boards-window.cjs): same cards, same live views. */
  pinHost: () => getCanvas().boardWindow,
  scriptFor,
  editorKept,
  setAgentsHost,
  setShellHost,
  refreshShell,
  avatarSlotRect,
  getWindow: () => (win && !win.isDestroyed() ? win : null),
  /** Popped-out tab windows, for the window manager: key pop:<host> -> window. */
  poppedWindows: () => {
    const out = {};
    for (const [id, pop] of popped) {
      if (!pop || pop.isDestroyed()) continue;
      const view = views.get(id);
      let host = String(id);
      try { host = new URL(view.webContents.getURL()).host || host; } catch { /* keep the id */ }
      out[`pop:${host}`] = () => pop;
    }
    return out;
  },
  onGeometry: (listener) => {
    geometryListeners.add(listener);
    return () => geometryListeners.delete(listener);
  },
};
