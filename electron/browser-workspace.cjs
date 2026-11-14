"use strict";

/**
 * browser-workspace.cjs -- the electron half of the managed browser (docs/WORKSPACE-POLICY.md).
 *
 * browser-window.cjs calls into this at its existing seams (openTab, loadInView, the
 * navigation guard, the permission handlers, will-download, runBrowserAction, the context
 * menu, layout); the rules themselves are pure and live in
 *   browser-workspace-policy.cjs  the signed policy, decide() and gate()
 *   browser-audit.cjs             the local audit spool
 *   browser-watermark.cjs         the overlay's text and rectangle
 *   browser-mesh-door.cjs         the loopback door to private apps
 *
 * What it does on a governed origin (one a good policy names):
 *   - opens it in the work partition persist:aither-work-<tenant>, whose proxy script
 *     sends the private apps' hosts to the door and everything else direct;
 *   - refuses a private app in an agent's or an InPrivate tab, and every governed app
 *     while the policy is expired, tampered with, rolled back or missing;
 *   - blocks what the app's deny list names, says so in the toolbar, writes one audit row;
 *   - shows the watermark overlay and keeps the window out of screen captures.
 */

const policyMod = require("./browser-workspace-policy.cjs");
const auditMod = require("./browser-audit.cjs");
const watermark = require("./browser-watermark.cjs");
const meshDoor = require("./browser-mesh-door.cjs");

/** A right-click row -> the policy action it needs. */
const MENU_ACTIONS = Object.freeze({
  copy: "copy", cut: "copy", "copy-text": "copy", "image-copy": "copy", search: "copy",
  paste: "paste", "paste-plain": "paste",
  "image-save": "download", "save-page": "capture", translate: "capture", "read-aloud": "capture",
  print: "print", inspect: "devtools",
});
/** runBrowserAction names that need a policy action. */
const BROWSER_ACTIONS = Object.freeze({ print: "print", translate: "capture", "read-aloud": "capture" });
/** Electron permission -> the policy action it needs. */
const PERMISSION_ACTIONS = Object.freeze({ "clipboard-sanitized-write": "copy", "clipboard-read": "paste" });

const SAID = Object.freeze({
  copy: "Copying is", paste: "Pasting is", download: "Downloads are", upload: "Uploads are", print: "Printing is",
  capture: "Saving or capturing the page is", devtools: "Developer tools are",
});
const REFRESH_MS = 15 * 60 * 1000;
const REPEAT_MS = 700;
const PRINT_CSS = "@media print { html { display: none !important; } }";

/** The policy action a key press needs on a governed page, or null. Pure. */
function keyAction(input) {
  if (!input || input.type !== "keyDown") return null;
  const key = String(input.key || "");
  const lower = key.toLowerCase();
  const mod = Boolean(input.control || input.meta);
  if (key === "F12") return "devtools";
  if (input.shift && !mod && !input.alt) {
    if (key === "Insert") return "paste";
    if (key === "Delete") return "copy"; // the old cut key
    return null;
  }
  if (!mod || input.alt) return null;
  if (input.shift) {
    if (lower === "i" || lower === "j" || lower === "c") return "devtools";
    if (lower === "v") return "paste";
    return null;
  }
  if (lower === "c" || lower === "x" || key === "Insert") return "copy";
  if (lower === "v") return "paste";
  if (lower === "s") return "capture";
  return null;
}

/**
 * The page's own guard, run in the isolated world (the page cannot see or remove it):
 * copy, cut and drag-out; paste and drop; a file put into the page. `nonce` marks the
 * console line main listens for, so the block is said in the toolbar and audited.
 */
function guardScript(deny, nonce) {
  return `(() => {
  const K = "__aitherWorkspaceGuard";
  const deny = ${JSON.stringify(deny)};
  if (window[K]) { window[K].deny = deny; return true; }
  const g = window[K] = { deny };
  const say = (a) => { try { console.debug(${JSON.stringify(nonce)} + a); } catch (e) {} };
  const files = (e) => { const t = e.clipboardData || e.dataTransfer; return Boolean(t && t.types && Array.prototype.includes.call(t.types, "Files")); };
  const on = (type, action, test) => window.addEventListener(type, (e) => {
    if (!g.deny.includes(action) || (test && !test(e))) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    try { if (e.clipboardData) e.clipboardData.clearData(); } catch (err) {}
    say(action);
  }, true);
  on("copy", "copy"); on("cut", "copy"); on("dragstart", "copy");
  on("paste", "upload", files); on("drop", "upload", files);
  on("paste", "paste"); on("drop", "paste", (e) => !files(e));
  on("click", "upload", (e) => Boolean(e.target && e.target.matches && e.target.matches("input[type=file]")));
  return true;
})()`;
}

function blockedText(action, host) {
  return `${SAID[action] || "This is"} turned off on ${host} by your workspace policy.`;
}

/**
 * @param {object} host what browser-window.cjs lends:
 *   electron()                 the electron module
 *   userData()                 the userData directory
 *   window()                   the browser window or null
 *   tab(id), tabIds(), activeId(), tabIdOf(wc), pageOf(id)
 *   activeBounds()             the on-screen page view's bounds inside the window, or null
 *   setNotice(id, notice), isolated(wc, code), hardenSession(ses), openTab(by, url, opts)
 *   blockedPage(url, reason)   the dark "did not open" document
 *   remote                     {origin(), token(), fetchImpl} for the policy route
 *   account()                  who is signed in (the watermark's name)
 *   keys                       pinned keys (the smoke's seam; the app passes none)
 */
function createWorkspace(host) {
  const dir = host.userData();
  const policy = policyMod.createWorkspacePolicy({ dir, ...(host.keys ? { keys: host.keys } : {}), remote: host.remote || null });
  const audit = auditMod.createAudit({ dir });
  const nonce = `⁣aither-ws:${require("node:crypto").randomBytes(12).toString("hex")}:`;
  const door = meshDoor.createMeshDoor({
    resolve: (h, p) => policy.privateTarget(h, p),
    audit: (row) => audit.record({ tenant: policy.tenantId(), origin: row.origin || (row.host ? `http://${row.host}:${row.port}` : ""),
      action: "mesh-connect", verdict: row.verdict, tab: "door" }),
  });
  const wired = new WeakSet();
  const printSheets = new WeakMap(); // wc -> Promise<css key>
  const lastBlock = new Map(); // "tab action" -> when it was last said
  let doorReady = Promise.resolve();
  let lastPac = null;
  let loginWired = false;
  let overlay = null; // { win, text, rect }
  let protectedNow = false;
  let user = "";
  let expiryTimer = null;
  let refreshTimer = null;
  let started = false;

  const electron = () => host.electron();
  const alive = (wc) => Boolean(wc && !wc.isDestroyed());

  function workSession() {
    const part = policy.partition();
    return part ? electron().session.fromPartition(part) : null;
  }

  /** The page's security origin (an about:blank popup has its opener's), else its address. */
  function originOfContents(wc) {
    if (!alive(wc)) return "";
    try {
      const o = wc.mainFrame && wc.mainFrame.origin;
      if (o && /^https?:/i.test(o)) return o;
    } catch { /* the frame is gone */ }
    try { return policyMod.originOf(wc.getURL()); } catch { return wc.getURL(); }
  }

  function tabKind(id) {
    const tab = id == null ? null : host.tab(id);
    if (!tab) return "owner";
    if (tab.private) return "private";
    if (tab.by === "agent") return "agent";
    return (tab.viewSpec || {}).webPartition === policy.partition() ? "work" : "owner";
  }

  function hostOf(origin) {
    try { return new URL(origin).host; } catch { return "this site"; }
  }

  function record(id, origin, action, verdict) {
    return audit.record({ tenant: policy.tenantId(), origin, action, verdict, tab: tabKind(id) });
  }

  /** Something was blocked in tab `id`: one audit row and the toolbar says why. */
  function said(id, origin, action, text) {
    const key = `${id} ${action}`;
    const now = Date.now();
    if (now - (lastBlock.get(key) || 0) < REPEAT_MS) return;
    lastBlock.set(key, now);
    record(id, origin, action, "deny");
    if (id != null && host.tab(id)) {
      host.setNotice(id, { kind: "workspace-policy", keep: true, text: text || blockedText(action, hostOf(origin)),
        actions: [{ id: "dismiss", label: "OK" }] });
    }
  }

  /**
   * Is `action` turned off for the page in tab `id`? Says so and audits unless `quiet`.
   * Every tab is judged by its page's origin, whoever opened it.
   */
  function blocks(id, action, { quiet = false, wc = null } = {}) {
    const page = wc || (id == null ? null : host.pageOf(id));
    if (!alive(page)) return false;
    const origin = originOfContents(page);
    const verdict = policy.decide(origin, action);
    if (verdict.allow) return false;
    if (!quiet) said(id, origin, action);
    return true;
  }

  const blocksMenu = (id, itemId) => (MENU_ACTIONS[itemId] ? blocks(id, MENU_ACTIONS[itemId]) : false);
  const blocksAction = (id, action) => (BROWSER_ACTIONS[action] ? blocks(id, BROWSER_ACTIONS[action]) : false);

  function blocksPermission(wc, permission, { quiet = false } = {}) {
    const action = PERMISSION_ACTIONS[permission];
    if (!action || !alive(wc)) return false;
    return blocks(host.tabIdOf(wc), action, { quiet, wc });
  }

  /** will-download: cancelled when the page it came from, or the file's own site, forbids downloads. */
  function blocksDownload(item, wc) {
    const id = alive(wc) ? host.tabIdOf(wc) : null;
    const origins = [];
    if (alive(wc)) origins.push(originOfContents(wc));
    try { origins.push(policyMod.originOf(item.getURL())); } catch { origins.push(item.getURL()); }
    const hit = origins.find((o) => o && !policy.decide(o, "download").allow);
    if (!hit) return false;
    try { item.cancel(); } catch { /* already over */ }
    said(id == null ? host.activeId() : id, hit, "download");
    return true;
  }

  // ------------------------------------------------------------------ where a page may open

  function contextOf(id) {
    const tab = id == null ? null : host.tab(id);
    return { by: tab ? tab.by : "you", private: Boolean(tab && tab.private), partition: tab ? (tab.viewSpec || {}).webPartition || null : null };
  }

  /**
   * policy.gate for tab `id`. Only an ordinary WEB tab is moved into the work partition:
   * a console page, a signed-in hosted page and a view that is no tab stay where they are
   * (their deny rules still apply, by origin).
   */
  function gateFor(id, url) {
    const tab = id == null ? null : host.tab(id);
    const g = policy.gate({ url, ...contextOf(id) });
    if (g.verdict === "work" && (!tab || (tab.kind || "web") !== "web")) return { verdict: "allow" };
    return g;
  }

  /** The dark page a refused app gets, the notice and the audit row. */
  function showClosed(id, wc, url, reason) {
    let origin;
    try { origin = policyMod.originOf(url); } catch { origin = ""; }
    const text = `${hostOf(origin)} is a workspace app and did not open: ${reason}.`;
    if (alive(wc)) void wc.loadURL(host.blockedPage(url, `Workspace policy: ${reason}.`)).catch(() => {});
    said(id, origin, "open", text);
  }

  /**
   * openTab's question, before a view exists. {partition} = build the tab in the work
   * session; {error} = do not open it (an agent asking for a private app); {} = as usual.
   */
  function gateOpen({ by, url, private: inPrivate = false }) {
    const g = policy.gate({ url, by, private: inPrivate, partition: null });
    if (g.verdict === "work" && g.partition) {
      host.hardenSession(electron().session.fromPartition(g.partition));
      void syncDoor();
      return { partition: g.partition };
    }
    if (g.verdict === "refuse" && by !== "you") {
      let origin;
      try { origin = policyMod.originOf(url); } catch { origin = ""; }
      audit.record({ tenant: policy.tenantId(), origin, action: "open", verdict: "deny", tab: "agent" });
      return { error: `${hostOf(origin)} is a private workspace app: ${g.reason}.` };
    }
    return {};
  }

  /**
   * loadInView's question for an address about to load in tab `id`'s view. Resolves true
   * when the load must NOT go on (it was moved to a work tab, or refused with the dark
   * page). A view of the work session first waits for the door and its proxy script.
   */
  async function beforeLoad(view, url) {
    const wc = view && view.webContents;
    if (!alive(wc)) return false;
    const id = host.tabIdOf(wc);
    const g = gateFor(id, url);
    if (g.verdict === "allow") {
      if (wc.session === workSession()) await doorReady.catch(() => {});
      return false;
    }
    if (g.verdict === "work") {
      host.openTab("you", url, { activate: true, after: id });
      return true;
    }
    showClosed(id, wc, url, g.reason);
    throw new Error(`workspace policy: ${g.reason}`);
  }

  /**
   * A navigation the page itself started (will-navigate, will-redirect, a frame's).
   * Returns true when it was stopped here.
   */
  function onNavigate(id, url, event, { frame = false } = {}) {
    const g = gateFor(id, url);
    if (g.verdict === "allow") return false;
    // A frame of an ordinary page: a governed app in force may be embedded as before.
    if (frame && g.verdict === "work") return false;
    try { event.preventDefault(); } catch { /* a details object without it */ }
    if (frame) return true;
    if (g.verdict === "work") host.openTab("you", url, { activate: true, after: id });
    else setImmediate(() => showClosed(id, host.pageOf(id), url, g.reason));
    return true;
  }

  // ------------------------------------------------------------------ one page

  function applyGuards(wc, id) {
    if (!alive(wc)) return;
    const origin = originOfContents(wc);
    const app = policy.appFor(origin);
    if (!app) return;
    void host.isolated(wc, guardScript(app.deny, nonce));
    const wantsPrintOff = app.deny.includes("print");
    if (wantsPrintOff && !printSheets.has(wc)) printSheets.set(wc, wc.insertCSS(PRINT_CSS, { cssOrigin: "user" }).catch(() => null));
    if (!wantsPrintOff && printSheets.has(wc)) {
      const sheet = printSheets.get(wc);
      printSheets.delete(wc);
      void sheet.then((key) => (key && alive(wc) ? wc.removeInsertedCSS(key) : null)).catch(() => {});
    }
    if (app.deny.includes("devtools") && wc.isDevToolsOpened()) { wc.closeDevTools(); said(id, origin, "devtools"); }
  }

  /** A committed page is judged again: the backstop for every way of getting there. */
  function judgeCommitted(wc, id) {
    if (!alive(wc)) return;
    const url = wc.getURL();
    const g = gateFor(id, url);
    if (g.verdict === "closed" || g.verdict === "refuse") { showClosed(id, wc, url, g.reason); return; }
    const app = policy.appFor(originOfContents(wc));
    if (app && app.audit) record(id, app.origin, "open", "allow");
  }

  /** wirePage's hook: keys, developer tools, the isolated-world guard, the committed-page check. */
  function wire(wc, id) {
    if (!alive(wc) || wired.has(wc)) return;
    wired.add(wc);
    wc.on("before-input-event", (event, input) => {
      const action = keyAction(input);
      if (action && blocks(id, action, { wc })) event.preventDefault();
    });
    wc.on("devtools-opened", () => { if (blocks(id, "devtools", { wc })) wc.closeDevTools(); });
    wc.on("did-navigate", () => { printSheets.delete(wc); judgeCommitted(wc, id); sync(); });
    wc.on("dom-ready", () => applyGuards(wc, id));
    wc.on("did-navigate-in-page", () => applyGuards(wc, id));
    wc.on("console-message", (details, _level, legacyMessage) => {
      const message = details && typeof details.message === "string" ? details.message : legacyMessage;
      if (typeof message !== "string" || !message.startsWith(nonce)) return;
      const action = message.slice(nonce.length);
      if (policyMod.ACTIONS.includes(action)) said(id, originOfContents(wc), action);
    });
  }

  // ------------------------------------------------------------------ the door and the work session

  function wireLogin() {
    if (loginWired) return;
    loginWired = true;
    // The door's credential, for the door only, to the work session only.
    electron().app.on("login", (event, wc, _details, authInfo, callback) => {
      if (!authInfo || !authInfo.isProxy || authInfo.realm !== meshDoor.REALM) return;
      if (authInfo.host !== "127.0.0.1" || !door.port() || Number(authInfo.port) !== door.port()) return;
      event.preventDefault();
      const ses = alive(wc) ? wc.session : null;
      if (ses && ses === workSession() && policy.status().state === "ok") {
        const c = door.credential();
        callback(c.username, c.password);
      } else {
        callback(); // an agent's, an InPrivate or any other session: no credential
      }
    });
  }

  /** The door listens and the work session's proxy script names the private hosts as of now. */
  function syncDoor() {
    const run = async () => {
      const ses = workSession();
      const hosts = policy.privateHosts();
      if (!ses) return;
      if (hosts.length) { wireLogin(); await door.start(); }
      const pac = hosts.length ? meshDoor.pacUrl(hosts, door.port()) : "";
      const key = `${policy.partition()} ${pac}`;
      if (key === lastPac) return;
      await ses.setProxy(pac ? { mode: "pac_script", pacScript: pac } : { mode: "direct" });
      // Nothing rides a connection made under the old policy.
      door.dropAll();
      try { await ses.closeAllConnections(); } catch { /* an older electron */ }
      lastPac = key;
    };
    doorReady = doorReady.catch(() => {}).then(run);
    return doorReady;
  }

  // ------------------------------------------------------------------ watermark and capture

  function closeOverlay() {
    const o = overlay;
    overlay = null;
    if (o && o.win && !o.win.isDestroyed()) o.win.destroy();
  }

  function setProtected(win, on) {
    if (protectedNow === on) return;
    protectedNow = on;
    try { win.setContentProtection(on); } catch { /* not on this platform */ }
  }

  /**
   * The overlay window: made as soon as a policy in force has an app that wants a
   * watermark, and KEPT (hidden) while the browser is open. Building a window and loading
   * its document takes seconds on a busy computer; an app must not show bare meanwhile.
   */
  function ensureOverlay(win) {
    const text = watermark.label({ user, tenant: policy.tenantId() });
    if (!overlay) {
      const { BrowserWindow } = electron();
      const w = new BrowserWindow({ parent: win, frame: false, transparent: true, focusable: false, skipTaskbar: true, resizable: false,
        movable: false, minimizable: false, maximizable: false, hasShadow: false, show: false, width: 16, height: 16,
        webPreferences: { partition: watermark.PARTITION, sandbox: true, contextIsolation: true, nodeIntegration: false, javascript: false } });
      w.setIgnoreMouseEvents(true);
      w.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
      w.webContents.on("will-navigate", (event) => event.preventDefault());
      // A document that did not arrive, or a renderer that died, is put back: an app that
      // asks for a watermark is not left showing without one.
      w.webContents.on("did-fail-load", () => { if (overlay && overlay.win === w) { overlay.text = null; setTimeout(sync, 400); } });
      w.webContents.on("render-process-gone", () => { if (overlay && overlay.win === w) { closeOverlay(); setTimeout(sync, 400); } });
      overlay = { win: w, text: null, rect: null, clickThrough: true };
    }
    const owc = overlay.win.webContents;
    if (overlay.text !== text || (!owc.isLoading() && !owc.getURL().startsWith("data:"))) {
      overlay.text = text;
      void overlay.win.loadURL(watermark.page(text)).catch(() => {});
    }
    return overlay;
  }

  function hideOverlay() {
    if (overlay && overlay.win && !overlay.win.isDestroyed() && overlay.win.isVisible()) overlay.win.hide();
  }

  /** layout()'s hook: the overlay and the capture guard follow the tab on screen. */
  function sync() {
    const win = host.window();
    if (!win) { closeOverlay(); protectedNow = false; return; }
    if (policy.apps().some(watermark.wanted)) ensureOverlay(win);
    else closeOverlay();
    const id = host.activeId();
    const wc = id == null ? null : host.pageOf(id);
    const app = alive(wc) ? policy.appFor(originOfContents(wc)) : null;
    const bounds = app ? host.activeBounds() : null;
    const showing = Boolean(app && bounds && win.isVisible() && !win.isMinimized());
    setProtected(win, Boolean(showing && (app.watermark || app.deny.includes("capture"))));
    const rect = showing && watermark.wanted(app) ? watermark.screenRect(win.getContentBounds(), bounds) : null;
    if (!rect || !overlay) { hideOverlay(); return; }
    if (JSON.stringify(overlay.rect) !== JSON.stringify(rect)) {
      overlay.rect = rect;
      overlay.win.setBounds(rect);
    }
    if (!overlay.win.isVisible()) overlay.win.showInactive();
  }

  /** Who the watermark names: the signed-in account, else this computer's user. */
  async function refreshUser() {
    let name;
    try { name = String((await host.account()) || ""); } catch { name = ""; }
    if (!name) { try { name = require("node:os").userInfo().username; } catch { name = ""; } }
    if (name !== user) { user = name; sync(); }
  }

  // ------------------------------------------------------------------ the policy changed

  function armExpiry() {
    clearTimeout(expiryTimer);
    const st = policy.status();
    if (st.state !== "ok" || !st.not_after) return;
    const wait = Date.parse(st.not_after) - Date.now();
    expiryTimer = setTimeout(() => policy.tick(), Math.min(Math.max(wait, 0) + 50, 2 ** 31 - 1));
    if (typeof expiryTimer.unref === "function") expiryTimer.unref();
  }

  /** Every open tab is judged against the policy as it is now. */
  function onPolicyChange() {
    armExpiry();
    void syncDoor();
    for (const id of host.tabIds()) {
      const wc = host.pageOf(id);
      if (!alive(wc)) continue;
      const url = wc.getURL();
      const g = gateFor(id, url);
      if (g.verdict === "closed" || g.verdict === "refuse") showClosed(id, wc, url, g.reason);
      else applyGuards(wc, id);
    }
    sync();
  }
  policy.onChange(onPolicyChange);

  /** The browser window opened: read the policy, then ask the platform for a newer one. */
  function start() {
    const win = host.window();
    if (win) for (const evt of ["move", "resize", "show", "hide", "minimize", "restore"]) win.on(evt, () => sync());
    policy.load();
    armExpiry();
    void syncDoor();
    void refreshUser();
    void policy.refresh().catch(() => {});
    if (started) return;
    started = true;
    refreshTimer = setInterval(() => { void policy.refresh().catch(() => {}); void refreshUser(); }, REFRESH_MS);
    if (typeof refreshTimer.unref === "function") refreshTimer.unref();
  }

  function windowClosed() {
    closeOverlay();
    protectedNow = false;
  }

  /** For the app's shutdown and the smoke: timers off, the overlay and the door closed. */
  async function dispose() {
    clearTimeout(expiryTimer);
    clearInterval(refreshTimer);
    closeOverlay();
    const win = host.window();
    if (win) setProtected(win, false);
    // A door that is still starting is waited for, so that it is the one stopped.
    await doorReady.catch(() => {});
    await door.stop();
  }

  return {
    audit, policy, door,
    beforeLoad, blocks, blocksAction, blocksDownload, blocksMenu, blocksPermission, gateOpen, onNavigate, wire, sync, start, windowClosed, dispose,
    reload: async () => { const st = policy.load(); await syncDoor(); return st; },
    refresh: async () => { const st = await policy.refresh(); await syncDoor(); return st; },
    refreshUser,
    ready: () => doorReady,
    /** What is on screen, for the live proof. */
    state: () => ({
      status: policy.status(), partition: policy.partition(), doorPort: door.port(), protected: protectedNow, user,
      watermark: overlay && overlay.win && !overlay.win.isDestroyed() && overlay.win.isVisible()
        ? { shown: overlay.win.isVisible(), bounds: overlay.win.getBounds(), text: overlay.text, clickThrough: overlay.clickThrough,
          focusable: overlay.win.isFocusable(), url: overlay.win.webContents.getURL() }
        : null,
    }),
  };
}

module.exports = { BROWSER_ACTIONS, MENU_ACTIONS, PERMISSION_ACTIONS, blockedText, createWorkspace, guardScript, keyAction };
