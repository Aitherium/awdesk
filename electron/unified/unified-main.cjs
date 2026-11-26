"use strict";

/**
 * unified-main.cjs -- Single-Window Unified AitherBrowser Entry Point.
 *
 * Architectural contract:
 *   - EXACTLY ONE BaseWindow for the entire app (Avatar / Workbench / Living Desktop).
 *   - ZERO popup BrowserWindows, ZERO layered transparent DWM click-through loops,
 *     ZERO gl.readPixels stalls.
 *   - Default home page: https://aithr.net.
 *   - Bridge server mounted on :47931 (DESK_BRIDGE_PORT) for awsh / awconnect / agents.
 *   - Sovereign local voice via awvoice (:8768) + persistent Stages, Bookmarks/History,
 *     Downloads, Widevine CDM, keyboard shortcuts, and --smoke CI verification.
 *   - Pass `--legacy` (or AWDESK_LEGACY=1) to fall back to electron/main.cjs if needed.
 */

const USE_LEGACY = process.argv.includes("--legacy") || process.env.AWDESK_LEGACY === "1";

const path = require("node:path");
const {
  app,
  BaseWindow,
  WebContentsView,
  ipcMain,
  screen,
  session,
  shell,
  globalShortcut,
  Tray,
  Menu,
  nativeImage,
} = require("electron");

const morphState = require("./morph-state.cjs");
const workbenchLayout = require("./workbench-layout.cjs");
const { createTabManager } = require("./tab-manager.cjs");
const { createAgentBridge } = require("./agent-bridge.cjs");
const { createBrowserStores } = require("./stage-store.cjs");
const { createVoiceBridge } = require("./voice-bridge.cjs");
const { resolveUnifiedTenant } = require("./tenant-context.cjs");
const { createAdblock } = require("../browser-adblock.cjs");
const { createBridgeServer, DEFAULT_PORT: DEFAULT_BRIDGE_PORT } = require("../bridge-server.cjs");
const { getWidevine } = require("../browser-widevine.cjs");
const decisionCards = require("../decision-cards.cjs");

const ROOT_DIR = path.resolve(__dirname, "..", "..");
const IS_SMOKE = process.argv.includes("--smoke");

let mainWindow = null;
let shellView = null;
let tray = null;
let state = null;
let tenantCtx = null;
let tabManager = null;
let agentBridge = null;
let voiceBridge = null;
let stores = null;
let bridgeServer = null;
let bridgePort = null;
let widevinePhase = "idle";
let activeDrag = null;
let activeResize = null;
let decisionPollTimer = null;

function activeDisplayWorkArea() {
  try {
    if (mainWindow && !mainWindow.isDestroyed()) {
      const b = mainWindow.getBounds();
      return screen.getDisplayMatching(b).workArea;
    }
    return screen.getPrimaryDisplay().workArea;
  } catch {
    return { x: 0, y: 0, width: 1920, height: 1080 };
  }
}

function appMemoryStats() {
  try {
    const metrics = app.getAppMetrics();
    let totalKb = 0;
    let mainKb = 0;
    for (const m of metrics) {
      const kb = Number(m?.memory?.workingSetSize || 0);
      totalKb += kb;
      if (m.type === "Browser") mainKb += kb;
    }
    return {
      mainMb: Math.round(mainKb / 1024),
      totalMb: Math.round(totalKb / 1024),
      processes: metrics.length,
    };
  } catch {
    return { mainMb: 0, totalMb: 0, processes: 0 };
  }
}

function broadcastState() {
  if (!mainWindow || mainWindow.isDestroyed() || !shellView) return null;
  const content = mainWindow.getContentBounds();
  const layout = workbenchLayout.computeLayout({
    mode: state.mode,
    width: content.width,
    height: content.height,
    layout: state.layout,
    splitCount: state.layout.browserSplit ? 2 : 1,
  });
  shellView.setBounds(layout.shell);
  if (tabManager) tabManager.syncLayout(layout);

  const mem = appMemoryStats();
  const payload = {
    mode: state.mode,
    previousMode: state.previousMode,
    homeUrl: state.homeUrl,
    avatarRenderer: state.avatarRenderer,
    selectedVrm: state.selectedVrm,
    layout: state.layout,
    computed: layout,
    windowCount: BaseWindow.getAllWindows().length,
    bridgePort,
    widevinePhase,
    memoryMb: mem.totalMb,
    customer: Boolean(tenantCtx?.customer),
    brandName: tenantCtx?.brandName || "AitherBrowser",
    accent: tenantCtx?.accent || "#7c8cff",
    workspaceSlug: tenantCtx?.workspaceSlug || "",
    quickWorkspaces: tenantCtx?.quickWorkspaces || [],
  };
  try {
    shellView.webContents.send("unified:state", payload);
  } catch { /* renderer not ready yet */ }
  return payload;
}

function applyMode(nextMode) {
  if (!mainWindow || mainWindow.isDestroyed()) return null;
  const display = activeDisplayWorkArea();
  const currentBounds = mainWindow.getBounds();
  const { state: nextState, windowSpec } = morphState.transitionMode(state, nextMode, currentBounds, display);
  state = nextState;

  mainWindow.setAlwaysOnTop(windowSpec.alwaysOnTop, windowSpec.alwaysOnTop ? "floating" : "normal");
  mainWindow.setResizable(windowSpec.resizable);
  mainWindow.setMinimumSize(windowSpec.minWidth, windowSpec.minHeight);
  mainWindow.setBounds(windowSpec.bounds, false);

  morphState.saveState(app.getPath("userData"), state);
  return broadcastState();
}

function handleFocusedShortcut(input) {
  if (!input || !tabManager) return false;
  const mod = Boolean(input.control || input.meta);
  const key = String(input.key || "").toLowerCase();

  if (key === "f12") {
    tabManager.toggleDevTools();
    return true;
  }
  if (key === "f5") {
    tabManager.reload();
    return true;
  }
  if (!mod) return false;

  if (key === "t") {
    tabManager.openTab({ url: state.homeUrl, title: "AitherNet", activate: true });
    if (state.mode === "avatar") applyMode("workbench");
    else broadcastState();
    return true;
  }
  if (key === "w") {
    const active = tabManager.getActiveTab();
    if (active) {
      tabManager.closeTab(active.id);
      broadcastState();
    }
    return true;
  }
  if (key === "tab") {
    tabManager.cycleTab(input.shift ? -1 : 1);
    broadcastState();
    return true;
  }
  if (key === "r") {
    tabManager.reload();
    return true;
  }
  if (key === "l") {
    shellView?.webContents?.send("unified:shortcut-ui", { action: "focus-url" });
    return true;
  }
  if (key === "f") {
    shellView?.webContents?.send("unified:shortcut-ui", { action: "toggle-find" });
    return true;
  }
  if (key === "d") {
    const active = tabManager.getActiveTab();
    if (active && stores) {
      stores.toggleBookmark(active.url, active.title);
      shellView?.webContents?.send("unified:shortcut-ui", { action: "refresh-library" });
    }
    return true;
  }
  if (key === "=" || key === "+") {
    tabManager.zoomTab(null, "in");
    return true;
  }
  if (key === "-") {
    tabManager.zoomTab(null, "out");
    return true;
  }
  if (key === "0") {
    tabManager.zoomTab(null, "reset");
    return true;
  }
  return false;
}

function loadShellUrl() {
  const devUrl = process.env.VITE_DEV_SERVER_URL;
  if (devUrl) {
    shellView.webContents.loadURL(`${devUrl.replace(/\/$/, "")}/unified.html`);
  } else {
    shellView.webContents.loadFile(path.join(ROOT_DIR, "dist", "unified.html"));
  }
}

function buildTray() {
  try {
    const iconPath = path.join(ROOT_DIR, "build", "icon.png");
    const img = nativeImage.createFromPath(iconPath);
    tray = new Tray(img.isEmpty() ? nativeImage.createEmpty() : img);
    const label = tenantCtx?.brandName || "AitherBrowser";
    tray.setToolTip(label);
    const items = tenantCtx?.customer
      ? [
          { label: `Open ${label} (Alt+3)`, click: () => { mainWindow?.show(); applyMode("desktop"); } },
          { label: `${label} Workbench (Alt+2)`, click: () => { mainWindow?.show(); applyMode("workbench"); } },
          { label: `Compact Companion (Alt+1)`, click: () => { mainWindow?.show(); applyMode("avatar"); } },
          { type: "separator" },
          { label: `Quit ${label}`, click: () => app.quit() },
        ]
      : [
          { label: "Avatar Mode (Alt+1)", click: () => { mainWindow?.show(); applyMode("avatar"); } },
          { label: "Workbench — AitherBrowser (Alt+2)", click: () => { mainWindow?.show(); applyMode("workbench"); } },
          { label: "Living Desktop — aithr.net (Alt+3)", click: () => { mainWindow?.show(); applyMode("desktop"); } },
          { type: "separator" },
          { label: "Quit AitherBrowser", click: () => app.quit() },
        ];
    tray.setContextMenu(Menu.buildFromTemplate(items));
    tray.on("click", () => {
      if (!mainWindow) return;
      if (mainWindow.isVisible()) mainWindow.focus();
      else mainWindow.show();
    });
  } catch { /* tray optional in headless CI */ }
}

function startBridge() {
  const port = Number(process.env.DESK_BRIDGE_PORT) || DEFAULT_BRIDGE_PORT;
  bridgeServer = createBridgeServer({
    port,
    onEvent: () => {},
    decisionsProvider: () => decisionCards.bridgeQueue(),
    needsYouProvider: () => decisionCards.bridgeNeedsYou(),
    wakesProvider: () => ({ ok: true, wakes: agentBridge.listAutomations() }),
    avatarBoundsProvider: () => (mainWindow && !mainWindow.isDestroyed() ? mainWindow.getBounds() : null),
    memoryProvider: () => appMemoryStats(),
    browserHandler: ({ url } = {}) => {
      if (!url) return { ok: false, error: "missing url" };
      mainWindow?.show();
      const tab = tabManager.openTab({ url, activate: true });
      if (state.mode === "avatar") applyMode("workbench");
      else {
        state.layout.showBrowser = true;
        broadcastState();
      }
      return { ok: true, tabId: tab.id, url: tab.url };
    },
    desktopHandler: (action) => {
      mainWindow?.show();
      if (action === "overlay" || action?.action === "overlay") {
        const next = state.mode === "desktop" ? "workbench" : "desktop";
        applyMode(next);
        return { ok: true, mode: next };
      }
      return { ok: true, mode: state.mode };
    },
    consoleHandler: () => {
      mainWindow?.show();
      if (state.mode !== "workbench") applyMode("workbench");
      return { ok: true, mode: state.mode };
    },
    speakHandler: async ({ text, voice } = {}) => {
      if (!voiceBridge) return { ok: false, offline: true };
      return voiceBridge.speak(text, voice);
    },
  });

  bridgeServer
    .listen()
    .then((addr) => {
      bridgePort = typeof addr === "object" && addr ? addr.port : port;
      broadcastState();
    })
    .catch(() => {
      // Side-by-side launch when legacy awdesk already holds :47931 -- stay alive cleanly.
      bridgePort = null;
    });
}

function registerIpc() {
  ipcMain.handle("unified:get-state", () => {
    const activeUrl = tabManager.getActiveTab()?.url || state.homeUrl;
    return {
      state: broadcastState(),
      tabs: tabManager.snapshot(),
      stages: stores.listStages(),
      library: stores.getLibrarySnapshot(activeUrl),
      downloads: stores.listDownloads(),
      decisions: agentBridge.listDecisions(),
      conversations: agentBridge.listConversations(),
      automations: agentBridge.listAutomations(),
    };
  });

  ipcMain.handle("unified:set-mode", (_ev, mode) => applyMode(mode));

  ipcMain.handle("unified:update-layout", (_ev, patch) => {
    state = morphState.normalizeState(
      { ...state, layout: { ...state.layout, ...(patch || {}) } },
      activeDisplayWorkArea(),
    );
    morphState.saveState(app.getPath("userData"), state);
    return broadcastState();
  });

  ipcMain.handle("unified:set-avatar-renderer", (_ev, renderer) => {
    state = morphState.normalizeState({ ...state, avatarRenderer: renderer }, activeDisplayWorkArea());
    morphState.saveState(app.getPath("userData"), state);
    return broadcastState();
  });

  ipcMain.handle("unified:set-selected-vrm", (_ev, vrmId) => {
    state = morphState.normalizeState({ ...state, selectedVrm: vrmId }, activeDisplayWorkArea());
    morphState.saveState(app.getPath("userData"), state);
    return broadcastState();
  });

  ipcMain.handle("unified:vrm-list", () =>
    agentBridge.listVrmModels(ROOT_DIR).map(({ id, label, sizeBytes }) => ({ id, label, sizeBytes })),
  );
  ipcMain.handle("unified:vrm-load", (_ev, vrmId) => agentBridge.readVrmBytes(vrmId, ROOT_DIR));
  ipcMain.handle("unified:swarms-list", () => agentBridge.listSwarms());

  // Deterministic middle-mouse / titlebar drag
  ipcMain.on("unified:drag-start", (_ev, pt) => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    activeDrag = morphState.beginDrag(state.mode, mainWindow.getBounds(), pt);
  });
  ipcMain.on("unified:drag-move", (_ev, pt) => {
    if (!activeDrag || !mainWindow || mainWindow.isDestroyed()) return;
    const next = morphState.stepDrag(activeDrag, pt, activeDisplayWorkArea());
    if (next) mainWindow.setBounds(next, false);
  });
  ipcMain.on("unified:drag-end", () => {
    if (activeDrag && mainWindow && !mainWindow.isDestroyed()) {
      if (state.mode === "avatar" || state.mode === "workbench") {
        state.boundsByMode[state.mode] = mainWindow.getBounds();
        morphState.saveState(app.getPath("userData"), state);
      }
    }
    activeDrag = null;
  });

  // Frameless edge/corner resize handles
  ipcMain.on("unified:resize-start", (_ev, { edge, x, y }) => {
    if (!mainWindow || mainWindow.isDestroyed() || state.mode === "desktop") return;
    activeResize = {
      edge: String(edge || "se"),
      startX: Number(x) || 0,
      startY: Number(y) || 0,
      startBounds: mainWindow.getBounds(),
    };
  });
  ipcMain.on("unified:resize-move", (_ev, { x, y }) => {
    if (!activeResize || !mainWindow || mainWindow.isDestroyed()) return;
    const next = morphState.applyResize(
      state.mode,
      activeResize.startBounds,
      activeResize.edge,
      (Number(x) || 0) - activeResize.startX,
      (Number(y) || 0) - activeResize.startY,
      activeDisplayWorkArea(),
    );
    if (next) mainWindow.setBounds(next, false);
  });
  ipcMain.on("unified:resize-end", () => {
    if (activeResize && mainWindow && !mainWindow.isDestroyed()) {
      if (state.mode === "avatar" || state.mode === "workbench") {
        state.boundsByMode[state.mode] = mainWindow.getBounds();
        morphState.saveState(app.getPath("userData"), state);
      }
    }
    activeResize = null;
  });

  ipcMain.on("unified:window-action", (_ev, action) => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    if (action === "minimize") mainWindow.minimize();
    else if (action === "maximize") {
      if (mainWindow.isMaximized()) mainWindow.unmaximize();
      else mainWindow.maximize();
    } else if (action === "close") mainWindow.close();
  });

  // Browser tab controls + find + devtools + zoom
  ipcMain.handle("unified:tab-open", (_ev, opts) => {
    const tab = tabManager.openTab(opts || {});
    if (state.mode === "avatar") applyMode("workbench");
    else if (state.mode === "workbench" && !state.layout.showBrowser) {
      state.layout.showBrowser = true;
      broadcastState();
    } else broadcastState();
    return { id: tab.id, snapshot: tabManager.snapshot() };
  });
  ipcMain.handle("unified:tab-close", (_ev, id) => {
    tabManager.closeTab(id);
    broadcastState();
    return tabManager.snapshot();
  });
  ipcMain.handle("unified:tab-activate", (_ev, id) => {
    tabManager.activateTab(id);
    broadcastState();
    return tabManager.snapshot();
  });
  ipcMain.handle("unified:tab-secondary", (_ev, id) => {
    tabManager.setSecondaryTab(id);
    broadcastState();
    return tabManager.snapshot();
  });
  ipcMain.handle("unified:tab-navigate", (_ev, { id, url }) => {
    tabManager.navigate(id, url);
    return tabManager.snapshot();
  });
  ipcMain.handle("unified:tab-nav", (_ev, { id, action }) => {
    if (action === "back") tabManager.goBack(id);
    else if (action === "forward") tabManager.goForward(id);
    else if (action === "reload") tabManager.reload(id);
    else if (action === "home") tabManager.navigate(id, state.homeUrl);
    return tabManager.snapshot();
  });
  ipcMain.handle("unified:tab-find", (_ev, { id, text, opts }) => tabManager.findInPage(id, text, opts));
  ipcMain.handle("unified:tab-find-stop", (_ev, id) => { tabManager.stopFindInPage(id); return true; });
  ipcMain.handle("unified:tab-devtools", (_ev, id) => tabManager.toggleDevTools(id));
  ipcMain.handle("unified:tab-zoom", (_ev, { id, action }) => tabManager.zoomTab(id, action));

  // Stages, Bookmarks/History, Downloads
  ipcMain.handle("unified:stages-list", () => stores.listStages());
  ipcMain.handle("unified:stages-create", (_ev, opts) => {
    const created = stores.createStage(opts || {});
    const snap = tabManager.replaceAllTabs(created.tabs);
    broadcastState();
    return { stages: created.list, tabs: snap };
  });
  ipcMain.handle("unified:stages-switch", (_ev, id) => {
    const switched = stores.switchStage(id);
    if (!switched) return null;
    const snap = tabManager.replaceAllTabs(switched.tabs);
    broadcastState();
    return { stages: switched.list, tabs: snap };
  });
  ipcMain.handle("unified:stages-delete", (_ev, id) => {
    const res = stores.deleteStage(id);
    const snap = tabManager.replaceAllTabs(res.tabs);
    broadcastState();
    return { stages: res.list, tabs: snap };
  });
  ipcMain.handle("unified:library-get", (_ev, activeUrl) =>
    stores.getLibrarySnapshot(activeUrl || tabManager.getActiveTab()?.url || ""),
  );
  ipcMain.handle("unified:library-bookmark-toggle", (_ev, { url, title }) =>
    stores.toggleBookmark(url, title),
  );
  ipcMain.handle("unified:library-suggest", (_ev, query) => stores.suggestUrls(query, 8));
  ipcMain.handle("unified:downloads-list", () => stores.listDownloads());
  ipcMain.handle("unified:downloads-clear", () => stores.clearFinishedDownloads());
  ipcMain.handle("unified:downloads-open", (_ev, { filePath, mode }) => {
    if (!filePath) return false;
    if (mode === "folder") shell.showItemInFolder(filePath);
    else shell.openPath(filePath);
    return true;
  });

  // Conversations, decisions, credentials, automations, awsh sessions
  ipcMain.handle("unified:conversations-list", () => agentBridge.listConversations());
  ipcMain.handle("unified:conversations-create", (_ev, opts) => agentBridge.createConversation(opts));
  ipcMain.handle("unified:conversations-delete", (_ev, id) => agentBridge.deleteConversation(id));
  ipcMain.handle("unified:chat-send", (_ev, opts) =>
    agentBridge.sendChatMessage({
      ...opts,
      onChunk: (conversationId, messageId, delta) => {
        try {
          shellView?.webContents?.send("unified:chat-chunk", { conversationId, messageId, delta });
        } catch { /* ignore */ }
      },
    }),
  );
  ipcMain.handle("unified:decisions-list", () => agentBridge.listDecisions());
  ipcMain.handle("unified:decisions-answer", async (_ev, { id, optionKey, note }) => {
    const res = await agentBridge.answerDecision(id, optionKey, note);
    try { shellView?.webContents?.send("unified:decisions", agentBridge.listDecisions()); } catch { /* ignore */ }
    return res;
  });
  ipcMain.handle("unified:decisions-cancel", async (_ev, id) => {
    const res = await agentBridge.cancelDecision(id);
    try { shellView?.webContents?.send("unified:decisions", agentBridge.listDecisions()); } catch { /* ignore */ }
    return res;
  });
  ipcMain.handle("unified:decisions-credential", async (_ev, { id, secretValue }) => {
    const res = await agentBridge.submitCredential(id, secretValue, { appRootDir: ROOT_DIR });
    try { shellView?.webContents?.send("unified:decisions", agentBridge.listDecisions()); } catch { /* ignore */ }
    return res;
  });
  ipcMain.handle("unified:automations-list", () => agentBridge.listAutomations());
  ipcMain.handle("unified:awsh-sessions", () => agentBridge.listAwshSessions());
  ipcMain.handle("unified:models-list", () => agentBridge.listModels());
  ipcMain.handle("unified:voice-status", () => voiceBridge.status());
  ipcMain.handle("unified:voice-speak", (_ev, { text, voice }) => voiceBridge.speak(text, voice));
  ipcMain.handle("unified:voice-transcribe", (_ev, { audioBase64, format }) =>
    voiceBridge.transcribeBase64(audioBase64, format),
  );

  // Living Desktop (https://aithr.net) host-protocol verbs
  ipcMain.handle("unified:desktop-host-action", (_ev, payload) => {
    const action = payload && payload.action;
    if (action === "status") {
      return { ok: true, mode: state.mode, windowCount: BaseWindow.getAllWindows().length, bridgePort };
    }
    if (action === "morph" && morphState.MODES.includes(payload.mode)) {
      applyMode(payload.mode);
      return { ok: true, mode: state.mode };
    }
    if (action === "open-tab" && typeof payload.url === "string" && /^https?:\/\//i.test(payload.url)) {
      const tab = tabManager.openTab({ url: payload.url, activate: true });
      applyMode("workbench");
      return { ok: true, tabId: tab.id, url: tab.url };
    }
    return { ok: false, error: "unsupported desktop host action" };
  });
}

function createUnifiedWindow() {
  const userData = app.getPath("userData");
  const display = activeDisplayWorkArea();
  tenantCtx = resolveUnifiedTenant();
  state = morphState.loadState(userData, display);
  state.homeUrl = tenantCtx.homeUrl;
  // Customer workspace installs (e.g. GargBot) default to full opaque app window (db1ce5d).
  if (tenantCtx.customer) {
    state.mode = "desktop";
  }

  const initialBounds =
    state.mode === "desktop"
      ? morphState.defaultBoundsFor("desktop", display)
      : morphState.clampBounds(state.mode, state.boundsByMode[state.mode], display);
  const lim = morphState.MODE_LIMITS[state.mode];

  // Single opaque BaseWindow -- eliminates Windows DWM layered alpha stalls completely!
  mainWindow = new BaseWindow({
    x: initialBounds.x,
    y: initialBounds.y,
    width: initialBounds.width,
    height: initialBounds.height,
    minWidth: lim.minW,
    minHeight: lim.minH,
    frame: false,
    transparent: false,
    backgroundColor: "#0a0b0f",
    roundedCorners: true,
    alwaysOnTop: lim.alwaysOnTop,
    resizable: lim.resizable,
    title: tenantCtx.windowTitle,
  });

  shellView = new WebContentsView({
    webPreferences: {
      preload: path.join(__dirname, "unified-preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  mainWindow.contentView.addChildView(shellView);
  shellView.webContents.on("before-input-event", (event, input) => {
    if (input?.type !== "keyDown") return;
    if (handleFocusedShortcut(input)) event.preventDefault();
  });

  const adblock = createAdblock({ dir: path.join(userData, "adblock") });
  agentBridge = createAgentBridge({ userDataDir: userData });
  voiceBridge = createVoiceBridge();
  stores = createBrowserStores({
    userDataDir: userData,
    homeUrl: state.homeUrl,
    onDownloadsChange: (rows) => {
      try { shellView?.webContents?.send("unified:downloads", rows); } catch { /* ignore */ }
    },
  });

  tabManager = createTabManager({
    baseWindow: mainWindow,
    WebContentsViewCtor: WebContentsView,
    sessionApi: session,
    adblock,
    stores,
    desktopPreloadPath: path.join(__dirname, "desktop-preload.cjs"),
    defaultWorkspace: tenantCtx.workspaceSlug,
    homeUrl: state.homeUrl,
    onShortcut: handleFocusedShortcut,
    onChange: (snap) => {
      try { shellView?.webContents?.send("unified:tabs", snap); } catch { /* ignore */ }
    },
  });

  // Restore active stage's persisted tabs (in --smoke, stay offline with about:blank)
  if (IS_SMOKE) {
    tabManager.replaceAllTabs([{ url: "about:blank", title: "Smoke", workspace: "", pinned: true }]);
  } else if (tenantCtx.customer) {
    tabManager.replaceAllTabs([
      { url: tenantCtx.homeUrl, title: tenantCtx.brandName, workspace: tenantCtx.workspaceSlug, pinned: true },
    ]);
  } else {
    tabManager.replaceAllTabs(stores.activeStageTabs());
  }

  mainWindow.on("resize", () => broadcastState());
  mainWindow.on("moved", () => {
    if (state.mode === "avatar" || state.mode === "workbench") {
      state.boundsByMode[state.mode] = mainWindow.getBounds();
      morphState.saveState(userData, state);
    }
  });
  mainWindow.on("closed", () => {
    if (decisionPollTimer) clearInterval(decisionPollTimer);
    bridgeServer?.close?.().catch?.(() => {});
    tabManager?.dispose();
    mainWindow = null;
  });

  shellView.webContents.on("did-finish-load", () => {
    broadcastState();
    shellView.webContents.send("unified:tabs", tabManager.snapshot());
    shellView.webContents.send("unified:decisions", agentBridge.listDecisions());
    shellView.webContents.send("unified:downloads", stores.listDownloads());
    if (IS_SMOKE) {
      const ok = BaseWindow.getAllWindows().length === 1;
      setTimeout(() => app.exit(ok ? 0 : 1), 200);
    }
  });

  if (IS_SMOKE) {
    shellView.webContents.on("did-fail-load", (_ev, code, desc) => {
      console.error(`[unified-smoke] shell failed to load (${code}): ${desc}`);
      app.exit(1);
    });
    const smokeGuard = setTimeout(() => {
      console.error("[unified-smoke] timed out waiting for shell did-finish-load");
      app.exit(1);
    }, 15000);
    if (typeof smokeGuard.unref === "function") smokeGuard.unref();
  }

  loadShellUrl();
  if (!IS_SMOKE) {
    buildTray();
    startBridge();
    // Non-blocking Widevine CDM init for Castlabs Electron
    try {
      getWidevine()
        .ensure()
        .then((snap) => {
          widevinePhase = snap?.phase || "ready";
          broadcastState();
        })
        .catch(() => {});
    } catch { /* non-Castlabs fallback */ }

    decisionPollTimer = setInterval(() => {
      if (!shellView || shellView.webContents.isDestroyed()) return;
      try {
        shellView.webContents.send("unified:decisions", agentBridge.listDecisions());
      } catch { /* ignore */ }
    }, 5000);
  }
}

if (USE_LEGACY) {
  require("../main.cjs");
} else {
  if (!IS_SMOKE) {
    const gotLock = app.requestSingleInstanceLock();
    if (!gotLock) {
      app.quit();
    } else {
      app.on("second-instance", () => {
        if (!mainWindow || mainWindow.isDestroyed()) return;
        if (mainWindow.isMinimized()) mainWindow.restore();
        mainWindow.show();
        mainWindow.focus();
      });
    }
  }

  app.whenReady().then(() => {
    registerIpc();
    createUnifiedWindow();
    if (!IS_SMOKE) {
      try {
        globalShortcut.register("Alt+1", () => { mainWindow?.show(); applyMode("avatar"); });
        globalShortcut.register("Alt+2", () => { mainWindow?.show(); applyMode("workbench"); });
        globalShortcut.register("Alt+3", () => { mainWindow?.show(); applyMode("desktop"); });
      } catch { /* headless fallback */ }
    }
  });

  app.on("will-quit", () => {
    globalShortcut.unregisterAll();
    bridgeServer?.close?.().catch?.(() => {});
  });

  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
  });
}
