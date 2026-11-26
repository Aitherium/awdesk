"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const morph = require("./morph-state.cjs");
const layout = require("./workbench-layout.cjs");
const { createTabManager, partitionForWorkspace, OWNER_PARTITION } = require("./tab-manager.cjs");
const { createAgentBridge } = require("./agent-bridge.cjs");
const { createBrowserStores } = require("./stage-store.cjs");
const { createVoiceBridge } = require("./voice-bridge.cjs");
const { resolveUnifiedTenant } = require("./tenant-context.cjs");

test("morph-state: defaults to workbench with https://aithr.net and transitions across all 3 modes preserving bounds", () => {
  const display = { x: 0, y: 0, width: 1920, height: 1080 };
  const s0 = morph.createInitialState(display);
  assert.equal(s0.mode, "workbench");
  assert.equal(s0.homeUrl, "https://aithr.net");
  assert.equal(s0.avatarRenderer, "orb2d");

  // Workbench -> Avatar (preserves custom workbench bounds)
  const customWb = { x: 100, y: 80, width: 1500, height: 920 };
  const t1 = morph.transitionMode(s0, "avatar", customWb, display);
  assert.equal(t1.state.mode, "avatar");
  assert.equal(t1.state.previousMode, "workbench");
  assert.deepEqual(t1.state.boundsByMode.workbench, customWb);
  assert.equal(t1.windowSpec.alwaysOnTop, true);
  assert.equal(t1.windowSpec.resizable, true);

  // Avatar -> Desktop (full work area, preserves moved avatar bounds)
  const movedAvatar = { x: 1400, y: 500, width: 360, height: 500 };
  const t2 = morph.transitionMode(t1.state, "desktop", movedAvatar, display);
  assert.equal(t2.state.mode, "desktop");
  assert.deepEqual(t2.windowSpec.bounds, display);
  assert.equal(t2.windowSpec.resizable, false);
  assert.deepEqual(t2.state.boundsByMode.avatar, movedAvatar);

  // Desktop -> Workbench (restores customWb)
  const t3 = morph.transitionMode(t2.state, "workbench", display, display);
  assert.equal(t3.state.mode, "workbench");
  assert.deepEqual(t3.windowSpec.bounds, customWb);
});

test("morph-state: middle-mouse drag and edge resize work cleanly in avatar/workbench and clamp on screen", () => {
  const display = { x: 0, y: 0, width: 1920, height: 1080 };
  const start = { x: 1200, y: 400, width: 340, height: 480 };

  const drag = morph.beginDrag("avatar", start, { x: 1300, y: 450 });
  assert.ok(drag);
  const moved = morph.stepDrag(drag, { x: 1100, y: 350 }, display);
  assert.deepEqual(moved, { x: 1000, y: 300, width: 340, height: 480 });

  // Clamp off-screen top
  const clamped = morph.stepDrag(drag, { x: 1300, y: -500 }, display);
  assert.equal(clamped.y, 0);

  // Desktop refuses drag
  assert.equal(morph.beginDrag("desktop", display, { x: 500, y: 500 }), null);

  // Corner resize respects min/max bounds
  const grown = morph.applyResize("avatar", start, "se", 100, 120, display);
  assert.equal(grown.width, 440);
  assert.equal(grown.height, 600);

  const shrunk = morph.applyResize("avatar", start, "se", -500, -500, display);
  assert.equal(shrunk.width, morph.MODE_LIMITS.avatar.minW);
  assert.equal(shrunk.height, morph.MODE_LIMITS.avatar.minH);

  // Northwest resize shifts origin properly
  const nw = morph.applyResize("avatar", start, "nw", -40, -50, display);
  assert.equal(nw.width, 380);
  assert.equal(nw.height, 530);
  assert.equal(nw.x, 1160);
  assert.equal(nw.y, 350);
});

test("morph-state: persistence round-trips atomically", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "unified-morph-"));
  try {
    const s = morph.createInitialState({ x: 0, y: 0, width: 1920, height: 1080 });
    s.mode = "avatar";
    s.layout.railWidth = 300;
    assert.equal(morph.saveState(tmp, s), true);
    const loaded = morph.loadState(tmp, { x: 0, y: 0, width: 1920, height: 1080 });
    assert.equal(loaded.mode, "avatar");
    assert.equal(loaded.layout.railWidth, 300);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("workbench-layout: smart URL normalization never hijacks localhost or IP:port into search", () => {
  assert.equal(layout.normalizeUrlInput("http://127.0.0.1:8765"), "http://127.0.0.1:8765");
  assert.equal(layout.normalizeUrlInput("127.0.0.1:8765"), "http://127.0.0.1:8765");
  assert.equal(layout.normalizeUrlInput("localhost:3000/studio"), "http://localhost:3000/studio");
  assert.equal(layout.normalizeUrlInput("aithr.net"), "https://aithr.net");
  assert.equal(layout.normalizeUrlInput(""), "https://aithr.net");
  assert.match(layout.normalizeUrlInput("how does electron basewindow work"), /duckduckgo\.com/);
});

test("workbench-layout: computes zero views in avatar, 1-2 panes in workbench, full-bleed in desktop", () => {
  const av = layout.computeLayout({ mode: "avatar", width: 340, height: 480 });
  assert.equal(av.browserViews.length, 0);

  const wb1 = layout.computeLayout({ mode: "workbench", width: 1440, height: 900, splitCount: 1 });
  assert.equal(wb1.rail.width, 248);
  assert.ok(wb1.chat.width >= 300);
  assert.equal(wb1.browserViews.length, 1);
  assert.equal(wb1.browserViews[0].y, layout.TITLEBAR_HEIGHT + layout.BROWSER_CHROME_HEIGHT);

  const wb2 = layout.computeLayout({ mode: "workbench", width: 1440, height: 900, splitCount: 2 });
  assert.equal(wb2.browserViews.length, 2);
  assert.equal(wb2.dividers.length, 1);

  const desk = layout.computeLayout({ mode: "desktop", width: 1920, height: 1080 });
  assert.equal(desk.browserViews.length, 1);
  assert.equal(desk.browserViews[0].y, layout.DESKTOP_TOPBAR_HEIGHT);
  assert.equal(desk.browserViews[0].width, 1920);
  assert.equal(desk.browserViews[0].height, 1080 - layout.DESKTOP_TOPBAR_HEIGHT);
});

test("tab-manager: isolates workspace cookie partitions and detaches all WebContentsViews in avatar mode", () => {
  const attached = new Set();
  const boundsLog = new Map();
  class FakeView {
    constructor(opts) {
      this.opts = opts;
      this.webContents = {
        url: "",
        on() {},
        setWindowOpenHandler() {},
        loadURL: (u) => { this.webContents.url = u; return Promise.resolve(); },
        close() {},
      };
    }
    setBounds(r) { boundsLog.set(this, r); }
  }
  const fakeWindow = {
    contentView: {
      addChildView(v) { attached.add(v); },
      removeChildView(v) { attached.delete(v); },
    },
  };
  const mgr = createTabManager({
    baseWindow: fakeWindow,
    WebContentsViewCtor: FakeView,
    homeUrl: "https://aithr.net",
  });

  assert.equal(partitionForWorkspace(""), OWNER_PARTITION);
  assert.equal(partitionForWorkspace("Garg"), "persist:aither-work-garg");

  const t1 = mgr.openTab({ url: "https://aithr.net", title: "AitherNet" });
  const t2 = mgr.openTab({ url: "127.0.0.1:8765", workspace: "garg", activate: false });
  assert.equal(t1.partition, OWNER_PARTITION);
  assert.equal(t2.partition, "persist:aither-work-garg");
  assert.equal(t2.url, "http://127.0.0.1:8765");

  // Workbench single pane attaches 1 view
  mgr.syncLayout(layout.computeLayout({ mode: "workbench", width: 1440, height: 900, splitCount: 1 }));
  assert.equal(attached.size, 1);
  assert.equal(mgr.snapshot().attachedViewCount, 1);

  // Workbench split attaches 2 views
  mgr.syncLayout(layout.computeLayout({ mode: "workbench", width: 1440, height: 900, splitCount: 2 }));
  assert.equal(attached.size, 2);

  // Avatar mode detaches ALL WebContentsViews (0 GPU compositor tax)
  mgr.syncLayout(layout.computeLayout({ mode: "avatar", width: 340, height: 480 }));
  assert.equal(attached.size, 0);
  assert.equal(mgr.snapshot().attachedViewCount, 0);

  // Desktop mode attaches 1 full-bleed aithr.net view
  mgr.syncLayout(layout.computeLayout({ mode: "desktop", width: 1920, height: 1080 }));
  assert.equal(attached.size, 1);

  // Cycle tabs & zoom
  assert.equal(mgr.cycleTab(1), true);
  assert.equal(mgr.zoomTab(null, "in"), 1.1);
  assert.equal(mgr.zoomTab(null, "reset"), 1);
});

test("stage-store: persists stages, tabs, bookmarks, history, suggestions, and downloads", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "unified-stores-"));
  try {
    const s1 = createBrowserStores({ userDataDir: tmp, homeUrl: "https://aithr.net" });
    assert.equal(s1.activeStageTabs()[0].url, "https://aithr.net");

    // Save custom tabs and verify restart persistence
    s1.saveActiveStageTabs([
      { url: "https://aithr.net", title: "AitherNet", pinned: true },
      { url: "http://127.0.0.1:8765", title: "Studio", pinned: false },
    ]);
    const s2 = createBrowserStores({ userDataDir: tmp, homeUrl: "https://aithr.net" });
    assert.equal(s2.activeStageTabs().length, 2);
    assert.equal(s2.activeStageTabs()[1].url, "http://127.0.0.1:8765");

    // Create & switch workspace stage
    const created = s2.createStage({ name: "Garg Work", workspace: "garg" });
    assert.equal(created.list.stages.length, 2);
    assert.equal(created.stage.workspace, "garg");

    // Bookmarks, history, suggestions
    s2.recordVisit("https://aithr.net/docs", "Aither Docs");
    const bm = s2.toggleBookmark("https://aithr.net/docs", "Aither Docs");
    assert.equal(bm.bookmarked, true);
    const snap = s2.getLibrarySnapshot("https://aithr.net/docs");
    assert.equal(snap.isBookmarked, true);
    assert.ok(snap.history.length >= 1);
    assert.ok(s2.suggestUrls("aithr").length >= 1);

    // Downloads lifecycle
    const dlId = s2.downloads.start({ filename: "model.gguf", url: "https://aithr.net/m.gguf", total: 100 });
    s2.downloads.update(dlId, { received: 100, state: "completed" });
    assert.equal(s2.listDownloads().length, 1);
    s2.clearFinishedDownloads();
    assert.equal(s2.listDownloads().length, 0);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("agent-bridge: persists conversations, handles offline LLM/swarms honestly, and allowlists VRM reads", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "unified-bridge-"));
  const vrmDir = path.join(tmp, "public", "assets");
  fs.mkdirSync(vrmDir, { recursive: true });
  fs.writeFileSync(path.join(vrmDir, "model-avreg-aither-v2.vrm"), Buffer.from("glTF-fake-vrm"));
  try {
    const bridge = createAgentBridge({
      userDataDir: tmp,
      fetchImpl: async () => { throw new Error("ECONNREFUSED"); },
    });
    const conv = bridge.createConversation({ title: "Rewrite Plan" });
    assert.ok(conv.id.startsWith("conv-"));
    const res = await bridge.sendChatMessage({ conversationId: conv.id, text: "status?" });
    assert.equal(res.ok, false);
    assert.equal(res.offline, true);
    assert.match(res.message.content, /offline|unreachable/i);

    // Swarms offline returns sovereign fairies cleanly without throwing
    const sw = await bridge.listSwarms();
    assert.equal(sw.offline, true);
    assert.equal(sw.fairies.length, 6);

    // Models offline returns default models cleanly
    const md = await bridge.listModels();
    assert.equal(md.offline, true);
    assert.ok(md.models.includes("aither-orchestrator"));

    // VRM discovery + path-traversal rejection
    const models = bridge.listVrmModels(tmp);
    assert.ok(models.some((m) => m.id === "model-avreg-aither-v2.vrm"));
    const okBytes = bridge.readVrmBytes("model-avreg-aither-v2.vrm", tmp);
    assert.ok(okBytes && okBytes.bytes.byteLength > 0);
    assert.equal(bridge.readVrmBytes("../../etc/passwd", tmp), null);
    assert.equal(bridge.readVrmBytes("not-a-vrm.txt", tmp), null);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("voice-bridge: synthesizes local Kokoro WAV, transcribes base64 STT, and degrades honestly when offline", async () => {
  const wavBytes = Buffer.from("RIFFfakewav");
  const okVoice = createVoiceBridge({
    fetchImpl: async (url) => {
      if (String(url).includes("/audio/speech")) {
        return {
          ok: true,
          status: 200,
          headers: { get: () => "audio/wav" },
          arrayBuffer: async () => wavBytes.buffer.slice(wavBytes.byteOffset, wavBytes.byteOffset + wavBytes.byteLength),
        };
      }
      if (String(url).includes("/transcribe/base64")) {
        return { ok: true, status: 200, json: async () => ({ success: true, text: "approve rush" }) };
      }
      return { ok: true, status: 200 };
    },
  });

  const st = await okVoice.status();
  assert.equal(st.ok, true);
  const sp = await okVoice.speak("Hello Aither");
  assert.equal(sp.ok, true);
  assert.match(sp.audioDataUrl, /^data:audio\/wav;base64,/);
  const tr = await okVoice.transcribeBase64("ZmFrZQ==", "wav");
  assert.equal(tr.ok, true);
  assert.equal(tr.text, "approve rush");

  const offlineVoice = createVoiceBridge({
    fetchImpl: async () => { throw new Error("ECONNREFUSED"); },
  });
  const offSp = await offlineVoice.speak("Offline test");
  assert.equal(offSp.ok, false);
  assert.equal(offSp.offline, true);
  assert.equal(offSp.fallbackBrowserSpeech, true);
});

test("tenant-context: boots GargBot customer installs into garg.aitherium.com full app and keeps owner on aithr.net", () => {
  // Owner default (no tenant)
  const owner = resolveUnifiedTenant({ tenant: null, env: {} });
  assert.equal(owner.customer, false);
  assert.equal(owner.homeUrl, "https://aithr.net");
  assert.equal(owner.defaultMode, "workbench");
  assert.equal(owner.workspaceSlug, "");
  assert.ok(owner.quickWorkspaces.some((w) => w.slug === "garg" && w.url === "https://garg.aitherium.com/"));

  // GargBot customer workspace install
  const garg = resolveUnifiedTenant({
    tenant: { host: "garg.aitherium.com", origin: "https://garg.aitherium.com/", name: "GargBot", accent: "#e05254", firstParty: true },
    env: {},
  });
  assert.equal(garg.customer, true);
  assert.equal(garg.singleApp, true);
  assert.equal(garg.homeUrl, "https://garg.aitherium.com/");
  assert.equal(garg.defaultMode, "desktop");
  assert.equal(garg.brandName, "GargBot");
  assert.equal(garg.accent, "#e05254");
  assert.equal(garg.workspaceSlug, "garg");

  // Single-app customer layout fills 100% of the window with zero extra chrome
  const gargLayout = layout.computeLayout({ mode: "desktop", width: 1440, height: 900, customerSingleApp: true });
  assert.equal(gargLayout.browserChrome, null);
  assert.equal(gargLayout.rail, null);
  assert.equal(gargLayout.chat, null);
  assert.deepEqual(gargLayout.browserViews, [{ x: 0, y: 0, width: 1440, height: 900 }]);

  // Owner peeking into Garg (ownerSwitch: true) stays owner posture
  const peek = resolveUnifiedTenant({
    tenant: { host: "garg.aitherium.com", origin: "https://garg.aitherium.com/", name: "GargBot", ownerSwitch: true },
    env: {},
  });
  assert.equal(peek.customer, false);
  assert.equal(peek.defaultMode, "workbench");
});

test("architectural invariants: unified shell has 1 BaseWindow, 0 BrowserWindows, 0 readPixels, 0 setIgnoreMouseEvents", () => {
  const pkg = JSON.parse(fs.readFileSync(path.resolve(__dirname, "..", "..", "package.json"), "utf8"));
  assert.equal(pkg.main, "electron/unified/unified-main.cjs", "package.json main must point to unified-main.cjs");
  const unifiedDir = __dirname;
  const files = fs.readdirSync(unifiedDir).filter((f) => f.endsWith(".cjs") && !f.endsWith(".test.cjs"));
  let baseWindowCount = 0;
  for (const file of files) {
    const src = fs.readFileSync(path.join(unifiedDir, file), "utf8");
    assert.equal(/\bnew\s+BrowserWindow\s*\(/.test(src), false, `${file} must never construct a BrowserWindow`);
    assert.equal(/\.readPixels\s*\(/.test(src), false, `${file} must never call gl.readPixels`);
    assert.equal(/\.setIgnoreMouseEvents\s*\(/.test(src), false, `${file} must never call setIgnoreMouseEvents`);
    const matches = src.match(/\bnew\s+BaseWindow\s*\(/g);
    if (matches) baseWindowCount += matches.length;
  }
  assert.equal(baseWindowCount, 1, "Unified shell must create exactly ONE BaseWindow");

  // Also verify zero gl.readPixels in the React unified renderer
  const srcUnifiedDir = path.resolve(__dirname, "..", "..", "src", "unified");
  const uiFiles = fs.readdirSync(srcUnifiedDir).filter((f) => /\.(ts|tsx)$/.test(f) && !f.endsWith(".test.tsx"));
  assert.ok(uiFiles.length >= 6, "Expected unified React source files to exist");
  for (const file of uiFiles) {
    const uiSrc = fs.readFileSync(path.join(srcUnifiedDir, file), "utf8");
    assert.equal(/\.readPixels\s*\(/.test(uiSrc), false, `src/unified/${file} must never call gl.readPixels`);
  }
});
