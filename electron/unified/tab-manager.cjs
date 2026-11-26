"use strict";

/**
 * tab-manager.cjs -- Clean WebContentsView tab & workspace-partition manager
 * for the single BaseWindow Unified AitherBrowser.
 *
 * Reuses:
 *   - ../browser-adblock.cjs (network tracker/ad blocking)
 *   - ../browser-stages.cjs (partition naming)
 *   - ./workbench-layout.cjs (smart URL normalization)
 *
 * Zero BrowserWindows are ever spawned here. Tabs detach cleanly in "avatar"
 * mode so idle GPU/compositor cost drops to zero without losing tab history.
 */

const { normalizeUrlInput } = require("./workbench-layout.cjs");

const OWNER_PARTITION = "persist:aither-owner";

function partitionForWorkspace(workspaceSlug) {
  const slug = String(workspaceSlug || "").trim().toLowerCase().replace(/[^a-z0-9_-]/g, "");
  return slug ? `persist:aither-work-${slug}` : OWNER_PARTITION;
}

/**
 * Pure tab list state + Electron WebContentsView attachment controller.
 * Electron APIs (`WebContentsView`, `session`) are injected so core logic
 * can be unit-tested without launching Chromium.
 */
function createTabManager({
  baseWindow = null,
  WebContentsViewCtor = null,
  sessionApi = null,
  adblock = null,
  stores = null,
  desktopPreloadPath = null,
  defaultWorkspace = "",
  homeUrl = "https://aithr.net",
  onChange = null,
  onShortcut = null,
} = {}) {
  let seq = 1;
  /** @type {Array<{id:string, url:string, title:string, workspace:string, partition:string, loading:boolean, canGoBack:boolean, canGoForward:boolean, view:any, pinned:boolean, zoomFactor:number}>} */
  const tabs = [];
  let activeTabId = null;
  let secondaryTabId = null;
  let desktopView = null;
  const attachedViews = new Set();
  const wiredPartitions = new Set();

  function emit() {
    if (stores && typeof stores.saveActiveStageTabs === "function") {
      try { stores.saveActiveStageTabs(tabs); } catch { /* best effort */ }
    }
    if (typeof onChange === "function") {
      try {
        onChange(snapshot());
      } catch {
        /* listener error must not break navigation */
      }
    }
  }

  function wireSession(partition) {
    if (!sessionApi || wiredPartitions.has(partition)) return;
    wiredPartitions.add(partition);
    try {
      const ses = sessionApi.fromPartition(partition);
      if (adblock && typeof adblock.attach === "function") {
        adblock.attach(ses);
      }
      if (stores && typeof stores.attachSessionDownloads === "function") {
        stores.attachSessionDownloads(ses);
      }
    } catch {
      /* ignore in mock/headless */
    }
  }

  function makeView(partition, url, tab, { preload = null } = {}) {
    if (!WebContentsViewCtor) return null;
    wireSession(partition);
    const webPreferences = {
      partition,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: true,
    };
    if (preload) webPreferences.preload = preload;
    const view = new WebContentsViewCtor({ webPreferences });
    const wc = view.webContents;
    if (wc && typeof wc.on === "function") {
      wc.on("did-start-loading", () => {
        if (tab) { tab.loading = true; emit(); }
      });
      wc.on("did-stop-loading", () => {
        if (tab) {
          tab.loading = false;
          tab.url = wc.getURL() || tab.url;
          tab.title = wc.getTitle() || tab.title;
          tab.canGoBack = typeof wc.navigationHistory?.canGoBack === "function" ? wc.navigationHistory.canGoBack() : false;
          tab.canGoForward = typeof wc.navigationHistory?.canGoForward === "function" ? wc.navigationHistory.canGoForward() : false;
          emit();
        }
      });
      wc.on("page-title-updated", (_ev, title) => {
        if (tab && title) { tab.title = title; emit(); }
      });
      wc.on("did-navigate", (_ev, navUrl) => {
        if (tab && navUrl) {
          tab.url = navUrl;
          stores?.recordVisit?.(navUrl, tab.title);
          emit();
        }
      });
      wc.on("did-navigate-in-page", (_ev, navUrl) => {
        if (tab && navUrl) {
          tab.url = navUrl;
          stores?.recordVisit?.(navUrl, tab.title);
          emit();
        }
      });
      if (typeof onShortcut === "function") {
        wc.on("before-input-event", (event, input) => {
          if (input?.type !== "keyDown") return;
          if (onShortcut(input)) event.preventDefault();
        });
      }
      if (typeof wc.setWindowOpenHandler === "function") {
        // Never spawn popup BrowserWindows -- open target URLs as a new tab in the same window!
        wc.setWindowOpenHandler(({ url: nextUrl }) => {
          if (nextUrl && /^https?:\/\//i.test(nextUrl)) {
            openTab({ url: nextUrl, workspace: tab ? tab.workspace : "", activate: true });
          }
          return { action: "deny" };
        });
      }
    }
    if (wc && typeof wc.loadURL === "function") {
      Promise.resolve(wc.loadURL(url)).catch(() => {});
    }
    return view;
  }

  function openTab({ url = homeUrl, title = "", workspace = "", activate = true, pinned = false } = {}) {
    const normalized = normalizeUrlInput(url, homeUrl);
    const partition = partitionForWorkspace(workspace);
    const id = `tab-${seq++}`;
    const tab = {
      id,
      url: normalized,
      title: title || normalized.replace(/^https?:\/\//i, "").split("/")[0] || "AitherNet",
      workspace: String(workspace || ""),
      partition,
      loading: false,
      canGoBack: false,
      canGoForward: false,
      pinned: Boolean(pinned),
      zoomFactor: 1,
      view: null,
    };
    tab.view = makeView(partition, normalized, tab);
    tabs.push(tab);
    if (activate || !activeTabId) {
      activeTabId = id;
    }
    emit();
    return tab;
  }

  function closeTab(id) {
    const idx = tabs.findIndex((t) => t.id === id);
    if (idx < 0) return false;
    const [removed] = tabs.splice(idx, 1);
    detachView(removed.view);
    try {
      if (removed.view?.webContents && !removed.view.webContents.isDestroyed?.()) {
        removed.view.webContents.close?.();
      }
    } catch { /* already closed */ }
    if (secondaryTabId === id) secondaryTabId = null;
    if (activeTabId === id) {
      const next = tabs[Math.min(idx, tabs.length - 1)] || null;
      activeTabId = next ? next.id : null;
    }
    if (tabs.length === 0) {
      openTab({ url: homeUrl, title: "AitherNet", activate: true, pinned: true });
    } else {
      emit();
    }
    return true;
  }

  function activateTab(id) {
    const found = tabs.find((t) => t.id === id);
    if (!found) return false;
    activeTabId = found.id;
    emit();
    return true;
  }

  function setSecondaryTab(id) {
    if (!id) {
      secondaryTabId = null;
      emit();
      return true;
    }
    const found = tabs.find((t) => t.id === id && t.id !== activeTabId);
    if (!found) return false;
    secondaryTabId = found.id;
    emit();
    return true;
  }

  function navigate(id, rawInput) {
    const target = tabs.find((t) => t.id === (id || activeTabId));
    if (!target) return null;
    const nextUrl = normalizeUrlInput(rawInput, homeUrl);
    target.url = nextUrl;
    if (target.view?.webContents?.loadURL) {
      Promise.resolve(target.view.webContents.loadURL(nextUrl)).catch(() => {});
    }
    emit();
    return target;
  }

  function goBack(id) {
    const target = tabs.find((t) => t.id === (id || activeTabId));
    target?.view?.webContents?.navigationHistory?.goBack?.();
  }

  function goForward(id) {
    const target = tabs.find((t) => t.id === (id || activeTabId));
    target?.view?.webContents?.navigationHistory?.goForward?.();
  }

  function reload(id) {
    const target = tabs.find((t) => t.id === (id || activeTabId));
    target?.view?.webContents?.reload?.();
  }

  function cycleTab(delta = 1) {
    if (tabs.length < 2) return false;
    const curIdx = Math.max(0, tabs.findIndex((t) => t.id === activeTabId));
    const nextIdx = (curIdx + delta + tabs.length) % tabs.length;
    activeTabId = tabs[nextIdx].id;
    emit();
    return true;
  }

  function findInPage(id, text, opts = {}) {
    const target = tabs.find((t) => t.id === (id || activeTabId));
    const wc = target?.view?.webContents;
    if (!wc || typeof wc.findInPage !== "function") return false;
    const q = String(text || "");
    if (!q) {
      wc.stopFindInPage?.("clearSelection");
      return false;
    }
    wc.findInPage(q, { forward: opts.forward !== false, findNext: Boolean(opts.findNext) });
    return true;
  }

  function stopFindInPage(id) {
    const target = tabs.find((t) => t.id === (id || activeTabId));
    target?.view?.webContents?.stopFindInPage?.("clearSelection");
  }

  function toggleDevTools(id) {
    const target = tabs.find((t) => t.id === (id || activeTabId));
    const wc = target?.view?.webContents;
    if (!wc) return false;
    if (wc.isDevToolsOpened?.()) wc.closeDevTools?.();
    else wc.openDevTools?.({ mode: "detach" });
    return true;
  }

  function zoomTab(id, action) {
    const target = tabs.find((t) => t.id === (id || activeTabId));
    if (!target) return 1;
    let next = target.zoomFactor || 1;
    if (action === "in") next = Math.min(2.5, Number((next + 0.1).toFixed(2)));
    else if (action === "out") next = Math.max(0.5, Number((next - 0.1).toFixed(2)));
    else next = 1;
    target.zoomFactor = next;
    target.view?.webContents?.setZoomFactor?.(next);
    emit();
    return next;
  }

  function replaceAllTabs(descriptors) {
    for (const t of tabs.splice(0, tabs.length)) {
      detachView(t.view);
      try { t.view?.webContents?.close?.(); } catch { /* ignore */ }
    }
    activeTabId = null;
    secondaryTabId = null;
    const list = Array.isArray(descriptors) && descriptors.length > 0
      ? descriptors
      : [{ url: homeUrl, title: "AitherNet", workspace: "", pinned: true }];
    for (let i = 0; i < list.length; i += 1) {
      openTab({ ...list[i], activate: i === 0 });
    }
    return snapshot();
  }

  function detachView(view) {
    if (!view || !attachedViews.has(view)) return;
    attachedViews.delete(view);
    try {
      baseWindow?.contentView?.removeChildView?.(view);
    } catch { /* ignore */ }
  }

  function attachViewAt(view, rect) {
    if (!view || !baseWindow?.contentView) return;
    if (!attachedViews.has(view)) {
      baseWindow.contentView.addChildView(view);
      attachedViews.add(view);
    }
    view.setBounds({
      x: Math.round(rect.x),
      y: Math.round(rect.y),
      width: Math.max(1, Math.round(rect.width)),
      height: Math.max(1, Math.round(rect.height)),
    });
  }

  /**
   * Synchronize which WebContentsViews are attached and their exact pixel bounds
   * for the current morph mode + layout rects.
   */
  function syncLayout(layoutResult) {
    const wanted = new Map();
    if (layoutResult.mode === "desktop" && layoutResult.browserViews.length > 0) {
      if (!desktopView && WebContentsViewCtor) {
        desktopView = makeView(partitionForWorkspace(defaultWorkspace), homeUrl, null, { preload: desktopPreloadPath });
      }
      if (desktopView) {
        wanted.set(desktopView, layoutResult.browserViews[0]);
      }
    } else if (layoutResult.mode === "workbench" && layoutResult.browserViews.length > 0) {
      const primary = tabs.find((t) => t.id === activeTabId) || tabs[0];
      if (primary?.view) {
        wanted.set(primary.view, layoutResult.browserViews[0]);
      }
      if (layoutResult.browserViews.length > 1) {
        const second =
          tabs.find((t) => t.id === secondaryTabId && t.id !== primary?.id) ||
          tabs.find((t) => t.id !== primary?.id);
        if (second?.view) {
          wanted.set(second.view, layoutResult.browserViews[1]);
        }
      }
    }
    // Detach any view not visible in the current mode (e.g., all views in "avatar" mode!)
    for (const v of Array.from(attachedViews)) {
      if (!wanted.has(v)) detachView(v);
    }
    for (const [v, rect] of wanted.entries()) {
      attachViewAt(v, rect);
    }
  }

  function snapshot() {
    return {
      homeUrl,
      activeTabId,
      secondaryTabId,
      attachedViewCount: attachedViews.size,
      tabs: tabs.map((t) => ({
        id: t.id,
        url: t.url,
        title: t.title,
        workspace: t.workspace,
        partition: t.partition,
        loading: t.loading,
        canGoBack: t.canGoBack,
        canGoForward: t.canGoForward,
        pinned: t.pinned,
        zoomFactor: t.zoomFactor,
      })),
    };
  }

  function dispose() {
    for (const v of Array.from(attachedViews)) detachView(v);
    for (const t of tabs) {
      try { t.view?.webContents?.close?.(); } catch { /* ignore */ }
    }
    try { desktopView?.webContents?.close?.(); } catch { /* ignore */ }
  }

  return {
    openTab,
    closeTab,
    activateTab,
    setSecondaryTab,
    navigate,
    goBack,
    goForward,
    reload,
    cycleTab,
    findInPage,
    stopFindInPage,
    toggleDevTools,
    zoomTab,
    replaceAllTabs,
    syncLayout,
    snapshot,
    dispose,
    getActiveTab: () => tabs.find((t) => t.id === activeTabId) || null,
  };
}

module.exports = {
  OWNER_PARTITION,
  partitionForWorkspace,
  createTabManager,
};
