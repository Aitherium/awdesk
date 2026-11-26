"use strict";

/**
 * stage-store.cjs -- Unified persistence facade over browser-stages.cjs,
 * browser-library.cjs (bookmarks + history), and browser-downloads.cjs.
 *
 * Pure Node CJS (zero Electron imports).
 */

const path = require("node:path");
const browserStages = require("../browser-stages.cjs");
const { createLibrary } = require("../browser-library.cjs");
const { createDownloads } = require("../browser-downloads.cjs");

function createBrowserStores({ userDataDir = "", homeUrl = "https://aithr.net", onDownloadsChange = null } = {}) {
  const stagesFile = userDataDir ? path.join(userDataDir, browserStages.FILE_NAME) : "";
  let stagesDoc = stagesFile ? browserStages.load(stagesFile).doc : browserStages.defaultDoc();

  const library = userDataDir
    ? createLibrary({ file: path.join(userDataDir, "browser-library.json") })
    : null;

  const downloads = createDownloads();

  function persistStages() {
    if (!stagesFile) return false;
    try {
      return browserStages.save(stagesFile, stagesDoc).ok === true;
    } catch {
      return false;
    }
  }

  function listStages() {
    const items = browserStages.list(stagesDoc);
    const active = browserStages.activeStage(stagesDoc);
    return {
      activeId: active ? active.id : null,
      stages: items.map((s) => ({
        id: s.id,
        name: s.name,
        workspace: s.workspace || "",
        tabCount: Array.isArray(s.tabs) ? s.tabs.length : 0,
      })),
    };
  }

  function activeStageTabs() {
    const active = browserStages.activeStage(stagesDoc);
    if (!active || !Array.isArray(active.tabs) || active.tabs.length === 0) {
      return [{ url: homeUrl, title: "AitherNet", workspace: active?.workspace || "", pinned: true }];
    }
    return active.tabs.map((t) => ({
      url: t.url || homeUrl,
      title: t.title || "AitherNet",
      workspace: active.workspace || "",
      pinned: Boolean(t.pinned),
    }));
  }

  function saveActiveStageTabs(tabs) {
    const active = browserStages.activeStage(stagesDoc);
    if (!active) return false;
    const res = browserStages.setTabs(
      stagesDoc,
      active.id,
      (Array.isArray(tabs) ? tabs : []).map((t) => ({
        url: t.url,
        title: t.title,
        kind: "web",
        pinned: Boolean(t.pinned),
      })),
    );
    if (!res.ok) return false;
    stagesDoc = res.doc;
    return persistStages();
  }

  function createStage({ name = "Workspace", workspace = "" } = {}) {
    const res = browserStages.create(stagesDoc, { name, workspace });
    if (res.ok && res.doc) stagesDoc = res.doc;
    persistStages();
    return { stage: res.stage || browserStages.activeStage(stagesDoc), list: listStages(), tabs: activeStageTabs() };
  }

  function switchStage(id) {
    const res = browserStages.setActive(stagesDoc, id);
    if (!res.ok) return null;
    stagesDoc = res.doc;
    persistStages();
    return { stage: browserStages.activeStage(stagesDoc), list: listStages(), tabs: activeStageTabs() };
  }

  function deleteStage(id) {
    const res = browserStages.remove(stagesDoc, id);
    if (res.ok && res.doc) stagesDoc = res.doc;
    persistStages();
    return { list: listStages(), tabs: activeStageTabs() };
  }

  // Library helpers
  function recordVisit(url, title = "") {
    if (!library || !url) return;
    try { library.visit(url, title, "you"); } catch { /* ignore */ }
  }

  function toggleBookmark(url, title = "") {
    if (!library || !url) return { bookmarked: false, bookmarks: [] };
    const bookmarked = library.toggleBookmark(url, title);
    return { bookmarked, bookmarks: library.bookmarks() };
  }

  function getLibrarySnapshot(activeUrl = "") {
    if (!library) {
      return { bookmarks: [], history: [], isBookmarked: false };
    }
    return {
      bookmarks: library.bookmarks().slice(0, 100),
      history: library.history(60),
      isBookmarked: activeUrl ? library.isBookmarked(activeUrl) : false,
    };
  }

  function suggestUrls(query, limit = 8) {
    if (!library) return [];
    return library.suggest(query, limit);
  }

  // Downloads helpers
  function emitDownloads() {
    if (typeof onDownloadsChange === "function") {
      try { onDownloadsChange(downloads.list()); } catch { /* ignore */ }
    }
  }

  function attachSessionDownloads(ses) {
    if (!ses || typeof ses.on !== "function") return false;
    ses.on("will-download", (_event, item) => {
      const id = downloads.start({
        filename: item.getFilename?.() || "download",
        url: item.getURL?.() || "",
        total: item.getTotalBytes?.() || 0,
      });
      if (item.getSavePath?.()) {
        downloads.update(id, { path: item.getSavePath() });
      }
      emitDownloads();
      item.on?.("updated", () => {
        downloads.update(id, {
          received: item.getReceivedBytes?.() || 0,
          total: item.getTotalBytes?.() || 0,
          path: item.getSavePath?.() || "",
          state: item.getState?.() === "interrupted" ? "interrupted" : "progressing",
        });
        emitDownloads();
      });
      item.once?.("done", (_e, dlState) => {
        downloads.update(id, {
          received: item.getReceivedBytes?.() || 0,
          total: item.getTotalBytes?.() || 0,
          path: item.getSavePath?.() || "",
          state: dlState === "completed" ? "completed" : dlState === "cancelled" ? "cancelled" : "interrupted",
        });
        emitDownloads();
      });
    });
    return true;
  }

  return {
    listStages,
    activeStageTabs,
    saveActiveStageTabs,
    createStage,
    switchStage,
    deleteStage,
    recordVisit,
    toggleBookmark,
    getLibrarySnapshot,
    suggestUrls,
    attachSessionDownloads,
    downloads,
    listDownloads: () => downloads.list(),
    clearFinishedDownloads: () => {
      downloads.clearFinished();
      emitDownloads();
      return downloads.list();
    },
  };
}

module.exports = { createBrowserStores };
