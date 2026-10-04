"use strict";

/** The Aitheros Online surface as a REAL desktop overlay — not a browser tab.
 *
 *  History, so nobody rebuilds the failures:
 *  - Attempt 1 loaded the old portal host in a framed BrowserWindow and rendered
 *    BLANK WHITE: portal. is auth-gated, a fresh webContents has no cookies, and the
 *    login redirect renders nothing.
 *  - Attempt 2 punted to shell.openExternal — explicitly rejected by the owner ("I don't
 *    want it opening a browser window, I want a desktop overlay").
 *  - This version loads the PUBLIC Aitheros Online shell at https://aitherium.com/?mode=overlay
 *    (the GitHub Pages static export — renders with NO session, and `mode=overlay` is
 *    the shell's own first-party transparent mode, the exact one AitherConnect embeds
 *    in-browser) into a full-work-area frameless transparent window, so the Aitheros Online
 *    chrome floats over the real Windows desktop.
 *
 *  Session: partition "persist:living-desktop" — any login done inside the shell's own
 *  iframed app windows (portal./relay./…) persists across restarts. One login, kept.
 *
 *  Verification is honest by construction: did-fail-load and a capturePage uniformity
 *  probe are appended to %TEMP%/desk-living-desktop.log on the one real window the
 *  owner opens. No extra diagnostic windows are ever spawned (owner-banned).
 */

const path = require("node:path");
const os = require("node:os");
const fs = require("node:fs");
const { BrowserWindow, ipcMain, screen, session, shell } = require("electron");

const BASE_URL = process.env.LIVING_DESKTOP_URL || "https://aitherium.com/";
const LOG_FILE = path.join(os.tmpdir(), "desk-living-desktop.log");

/** `?mode=overlay` is Aitheros Online's OWN first-party overlay mode (Veil
 *  `src/components/os/overlay-mode.ts` — the exact mode AitherConnect embeds): it skips
 *  the boot greeter, sets `html.aither-os-overlay` whose CSS is
 *  `background: transparent !important`, and goes straight to the desktop stage. No
 *  hand-rolled wallpaper-strip CSS needed — the shell renders transparent by design. */
function urlFor(transparent) {
  try {
    const url = new URL(BASE_URL);
    if (transparent) url.searchParams.set("mode", "overlay");
    else url.searchParams.delete("mode");
    if (shellId) url.searchParams.set("shell", shellId);
    else url.searchParams.delete("shell");
    return url.href;
  } catch {
    return BASE_URL;
  }
}

/** The Aitheros Online swappable-shell plane (Veil shell-registry.tsx): the overlay can run
 *  any registered shell. Unknown ids fall back to the Aitheros Online server-side, so a
 *  stale entry here degrades gracefully rather than blanking the overlay. */
const SHELL_CHOICES = [
  { id: null, label: "Aitheros Online (default)" },
  { id: "aither-desktop", label: "Desktop Anywhere" },
  { id: "aither-shell", label: "AitherShell cockpit" },
  { id: "gobbonet", label: "GobboNet" },
];
let shellId = null;

function setShell(id) {
  shellId = id;
  if (isOpen()) void desktopWin.loadURL(urlFor(transparentMode));
  else showLivingDesktop();
}

const PARTITION = "persist:living-desktop";
//: The apex, not the old `portal.` host: that one is RETIRED and 301s here
//: (measured 2026-09-19). Loading the redirect costs a round trip and leaves a
//: dead hostname in the one window the owner signs in through.
const PORTAL_LOGIN_URL = "https://aitherium.com/login";

let desktopWin = null; // the singleton overlay window
let transparentMode = true; // owner-facing toggle; survives close/reopen within a run
let ghostMode = true; // click-through everywhere the Aitheros Online isn't drawing

// ── Ghost mode (click-through) ─────────────────────────────────────────────────
// The overlay page reports its interactive hit-rects (see living-desktop-preload.cjs);
// a main-process poll flips setIgnoreMouseEvents by cursor position. Fail-INTERACTIVE:
// if no regions report arrived recently (page changed, solid mode, protocol drift) the
// whole window stays clickable — a silently un-clickable Aitheros Online would read as
// "just broken", which is worse than losing click-through.
const hitState = { regions: [], dock: null, reportedAt: 0 };
const REGIONS_FRESH_MS = 5000;
const REGION_PAD = 8;
let ghostTimer = null;
let ignoringMouse = false;

ipcMain.on("living-desktop:regions", (event, payload) => {
  if (!isOpen() || event.sender !== desktopWin.webContents) return;
  hitState.regions = payload.regions;
  hitState.dock = payload.dock;
  hitState.reportedAt = Date.now();
});

// ── The overlay as a HOST for AitherOS Online (overlay-browser-host.cjs) ────────
// AitherOS Online's overlay-host.ts asks its host to read and drive a page. The
// desk answers with the Aither Browser. Handlers are injected by main (it owns the
// browser); only OUR overlay and app windows may call them.
let overlayHost = null;
function setOverlayHost(handlers) {
  overlayHost = handlers || null;
}
function fromOverlay(event) {
  const senders = [desktopWin, appWin].filter((w) => w && !w.isDestroyed()).map((w) => w.webContents);
  return senders.includes(event.sender);
}
ipcMain.handle("living-desktop:host-page", async (event, msg) => {
  if (!fromOverlay(event)) return { ok: false, error: "not the AitherOS Online overlay" };
  if (!overlayHost || typeof overlayHost.page !== "function") return { ok: false, error: "the desk has no browser host wired" };
  return overlayHost.page(msg && typeof msg === "object" ? msg : {});
});
ipcMain.handle("living-desktop:host-context", async (event) => {
  if (!fromOverlay(event) || !overlayHost || typeof overlayHost.context !== "function") return null;
  return overlayHost.context();
});
ipcMain.on("living-desktop:desk-command", (event, id) => {
  if (!fromOverlay(event) || !overlayHost || typeof overlayHost.command !== "function") return;
  overlayHost.command(String(id || ""));
});

function cursorOverInteractive() {
  if (Date.now() - hitState.reportedAt > REGIONS_FRESH_MS) return true; // fail-interactive
  const bounds = desktopWin.getContentBounds();
  const cursor = screen.getCursorScreenPoint();
  const x = cursor.x - bounds.x;
  const y = cursor.y - bounds.y;
  if (x < 0 || y < 0 || x > bounds.width || y > bounds.height) return false;
  const dock = hitState.dock;
  if (dock && typeof dock.thickness === "number") {
    const t = dock.thickness + REGION_PAD;
    if (
      (dock.edge === "bottom" && y >= bounds.height - t) ||
      (dock.edge === "top" && y <= t) ||
      (dock.edge === "left" && x <= t) ||
      (dock.edge === "right" && x >= bounds.width - t)
    ) {
      return true;
    }
  }
  for (const r of hitState.regions) {
    if (
      x >= r.x - REGION_PAD &&
      x <= r.x + r.w + REGION_PAD &&
      y >= r.y - REGION_PAD &&
      y <= r.y + r.h + REGION_PAD
    ) {
      return true;
    }
  }
  return false;
}

function applyGhostTick() {
  if (!isOpen() || !desktopWin.isVisible()) return;
  const shouldInteract = !ghostMode || !transparentMode || cursorOverInteractive();
  const shouldIgnore = !shouldInteract;
  if (shouldIgnore !== ignoringMouse) {
    ignoringMouse = shouldIgnore;
    // forward:true keeps mousemove flowing to the page while ignored, so Aitheros Online
    // hover states still track even in the pass-through areas.
    desktopWin.setIgnoreMouseEvents(shouldIgnore, { forward: true });
  }
}

function startGhostLoop() {
  if (ghostTimer) return;
  ghostTimer = setInterval(applyGhostTick, 60);
}

function stopGhostLoop() {
  if (ghostTimer) {
    clearInterval(ghostTimer);
    ghostTimer = null;
  }
  if (isOpen() && ignoringMouse) {
    ignoringMouse = false;
    desktopWin.setIgnoreMouseEvents(false);
  }
}

// ── Session (why the shell shows "sign in" instead of david@) ─────────────────────
// This window is its OWN browser profile (the persist: partition) — the login living in
// the owner's normal Chrome never reaches it. desk-session.cjs decides what the
// partition's aither_auth_token should be: the cookie it holds if Identity still
// accepts it, else the user's own login from ~/.aither/auth.json (adk login / Set up
// Aither), else the vault's portal token (the owner box's last resort). A cookie is
// never trusted on presence alone: a revoked one used to block every refresh.
const deskSession = require("./desk-session.cjs");

/** Who the windows are signed in as. Never carries a token. */
let account = { signedIn: false, username: "", source: "", state: "unknown", checkedAt: 0 };
const ACCOUNT_RECHECK_MS = 5 * 60 * 1000;
const accountListeners = new Set();
function setAccount(next) {
  const changed = next.signedIn !== account.signedIn || next.username !== account.username;
  account = { ...next, checkedAt: Date.now() };
  if (changed) {
    for (const fn of accountListeners) {
      try {
        fn(accountStatus());
      } catch {
        /* a listener must never break the session plane */
      }
    }
  }
}
function accountStatus() {
  return {
    signedIn: account.signedIn, username: account.username, source: account.source, state: account.state,
    line: deskSession.accountLine(account),
  };
}
function onAccountChange(fn) {
  accountListeners.add(fn);
  return () => accountListeners.delete(fn);
}

async function partitionCookieToken() {
  try {
    const cookies = await session
      .fromPartition(PARTITION)
      .cookies.get({ name: deskSession.COOKIE_NAME });
    const hit = cookies.find((c) => (c.domain || "").includes("aitherium.com") && c.value);
    return hit ? hit.value : "";
  } catch (err) {
    log(`cookie check failed: ${err}`);
    return "";
  }
}

async function hasSessionCookie() {
  return Boolean(await partitionCookieToken());
}

async function setPartitionToken(token, expiresAt = null) {
  await session.fromPartition(PARTITION).cookies.set(deskSession.cookieDetails(token, { expiresAt }));
}

async function clearPartitionToken() {
  const ses = session.fromPartition(PARTITION);
  // Every variant: the apex host-only shadow and the canonical domain cookie.
  // app.aitherium.com is the page host since 2026-10-04: a host-only shadow there would
  // survive Sign out and still read as signed in (partitionCookieToken matches any
  // *.aitherium.com cookie).
  for (const url of ["https://aitherium.com", "https://www.aitherium.com", "https://api.aitherium.com",
    "https://app.aitherium.com"]) {
    try {
      await ses.cookies.remove(url, deskSession.COOKIE_NAME);
    } catch {
      /* not there */
    }
  }
}

// ── Vault rung (owner-approved 2026-08-25) ────────────────────────────────────────
// On the owner's own fleet box the vault holds the platform's portal session token
// (AITHER_PORTAL_TOKEN). It is now the LAST rung -- after the cookie and the user's own
// auth.json -- and runs only when both are missing or dead. Materialized with the
// sanctioned vault reader (--to-file, never stdout) into a temp file read and deleted
// here; the value never reaches a transcript, a log, or an env var. On a machine with
// no monorepo checkout the reader is absent and this rung yields nothing.
const PORTAL_TOKEN_FILE = path.join(os.tmpdir(), "desk-portal-token");
// The vault reader executes in the DISTRO (WSL) and refuses Windows-style --to-file
// targets ("C:/... is a relative directory named C:") — hand it the same physical
// file via its /mnt/c spelling; main reads and deletes it by the Windows path.
const PORTAL_TOKEN_FILE_DISTRO =
  "/mnt/c/" + PORTAL_TOKEN_FILE.replace(/\\/g, "/").replace(/^[A-Za-z]:\//, "");
const VAULT_READER = "C:\\AitherOS-Fresh\\AitherOS\\dev\\tools\\aither_secret.py";
async function readVaultPortalToken() {
  if (!fs.existsSync(VAULT_READER)) return "";
  // Cap the reader wait: opening a window must never stall on a slow/hung vault.
  await new Promise((resolve) => {
    const { spawn } = require("node:child_process");
    const child = spawn(
      "python",
      [VAULT_READER, "AITHER_PORTAL_TOKEN", "--to-file", PORTAL_TOKEN_FILE_DISTRO],
      { stdio: "ignore", windowsHide: true },
    );
    const cap = setTimeout(() => {
      log("portal token reader exceeded 5s — skipping the vault rung this time");
      try {
        child.kill();
      } catch {
        /* already gone */
      }
      resolve();
    }, 5000);
    child.on("exit", () => {
      clearTimeout(cap);
      resolve();
    });
    child.on("error", () => {
      clearTimeout(cap);
      resolve();
    });
  });
  try {
    const token = fs.readFileSync(PORTAL_TOKEN_FILE, "utf-8").trim();
    fs.unlinkSync(PORTAL_TOKEN_FILE);
    return token;
  } catch {
    try {
      fs.unlinkSync(PORTAL_TOKEN_FILE);
    } catch {
      /* already gone */
    }
    return "";
  }
}

/**
 * Make the partition signed-in if any rung can, and record who it is. `force`
 * re-validates even a cookie checked a moment ago (Sign in, an explicit reload).
 */
// An explicit Sign out holds until an explicit Sign in: without this the next window
// open would re-link auth.json and the owner could never leave. (In-run only; a desk
// restart links again, the way every other local tool reads auth.json.)
let userSignedOut = false;

async function syncPortalSessionCookie({ force = false, useVault = true } = {}) {
  const cookieToken = await partitionCookieToken();
  if (userSignedOut && !force) return accountStatus();
  if (!force && cookieToken && account.signedIn && Date.now() - account.checkedAt < ACCOUNT_RECHECK_MS) {
    return accountStatus();
  }
  let verdict;
  try {
    verdict = await deskSession.resolveSession({
      cookieToken,
      authStore: () => deskSession.readAuthStoreToken(),
      vault: useVault ? readVaultPortalToken : async () => "",
      check: (t) => deskSession.checkToken(t),
    });
  } catch (err) {
    log(`session resolve failed: ${err}`);
    return accountStatus();
  }
  try {
    if (verdict.action === "set") {
      await setPartitionToken(verdict.token, verdict.expiresAt);
      log(`session set in the window partition from ${verdict.source} (${verdict.state})`);
    } else if (verdict.action === "clear") {
      await clearPartitionToken();
      log("the window partition's session was rejected by Identity and nothing replaced it — cleared");
    }
  } catch (err) {
    log(`session write failed: ${err}`);
  }
  const signedIn = verdict.action === "keep" || verdict.action === "set";
  setAccount({ signedIn, username: verdict.username || "", source: verdict.source, state: verdict.state });
  return accountStatus();
}

/** Reload every open window so the shell re-reads the session it now has. */
function reloadSignedInWindows() {
  if (isOpen()) void desktopWin.loadURL(urlFor(transparentMode));
  if (isAppOpen()) void appWin.loadURL(desktopAppUrl());
}

let signInRunning = null;
/**
 * "Sign in…" -- for BOTH windows, the AitherDesktop app as much as the overlay.
 * 1. A login this machine already has (auth.json / vault) is used with no browser.
 * 2. Otherwise the desk's own OIDC sign-in opens in the SYSTEM browser, which already
 *    holds the idp.aitherium.com session, so nothing is typed; the new desk session
 *    goes to auth.json and into the windows.
 * 3. If that cannot run, the old in-window aitherium.com/login page, in the window
 *    the owner is looking at, with a cookie watch that returns him to the desktop.
 */
function beginSignIn() {
  if (signInRunning) return signInRunning;
  userSignedOut = false;
  signInRunning = (async () => {
    try {
      const now = await syncPortalSessionCookie({ force: true });
      if (now.signedIn) {
        log(`sign-in: already signed in (${now.source}) — reloading the windows`);
        if (!isOpen() && !isAppOpen()) showDesktopApp();
        else reloadSignedInWindows();
        return now;
      }
      log("sign-in: no usable login on this machine — opening the browser sign-in");
      const got = await deskSession.signInWithBrowser({ openExternal: (url) => shell.openExternal(url) });
      await setPartitionToken(got.token, got.expiresAt);
      got.token = null;
      setAccount({ signedIn: true, username: got.username, source: `browser:${got.via}`, state: "valid" });
      log(`sign-in: signed in via the browser (${got.via}); auth.json updated`);
      if (!isOpen() && !isAppOpen()) showDesktopApp();
      else reloadSignedInWindows();
      return accountStatus();
    } catch (err) {
      log(`sign-in: browser sign-in did not complete (${err && err.code ? err.code : err}) — in-window login`);
      signInInWindow();
      return accountStatus();
    } finally {
      signInRunning = null;
    }
  })();
  return signInRunning;
}

let signInPoll = null;
function signInInWindow() {
  const target = isAppOpen() ? appWin : showLivingDesktop();
  void target.loadURL(PORTAL_LOGIN_URL);
  // Portal's open-redirect guard strips foreign returnUrls, so instead of trusting a
  // bounce-back we watch for the cookie to appear and return to the desktop ourselves.
  if (signInPoll) clearInterval(signInPoll);
  const startedAt = Date.now();
  signInPoll = setInterval(async () => {
    if ((!isOpen() && !isAppOpen()) || Date.now() - startedAt > 10 * 60 * 1000) {
      clearInterval(signInPoll);
      signInPoll = null;
      return;
    }
    if (await hasSessionCookie()) {
      clearInterval(signInPoll);
      signInPoll = null;
      log("sign-in detected (aither_auth_token set in partition) — returning to the desktop");
      await syncPortalSessionCookie({ force: true, useVault: false });
      reloadSignedInWindows();
    }
  }, 2000);
}

/** Sign the WINDOWS out (the partition cookie). auth.json is adk's; it stays. */
async function signOut() {
  userSignedOut = true;
  await clearPartitionToken();
  setAccount({ signedIn: false, username: "", source: "", state: "signed-out" });
  log("signed out of the window partition");
  reloadSignedInWindows();
  return accountStatus();
}

function log(line) {
  try {
    fs.appendFileSync(LOG_FILE, `[${new Date().toISOString()}] ${line}\n`);
  } catch {
    /* logging must never break the overlay */
  }
}

function isAitheriumFamily(rawUrl) {
  try {
    const { protocol, hostname } = new URL(rawUrl);
    if (protocol !== "https:") return false;
    return hostname === "aitherium.com" || hostname.endsWith(".aitherium.com");
  } catch {
    return false;
  }
}

function isOpen() {
  return Boolean(desktopWin && !desktopWin.isDestroyed());
}

/** Blank-page probe on the REAL window: capture and measure pixel spread. The attempt-1
 *  failure mode was a uniformly white page that every "did it load" signal called
 *  healthy — only looking at the pixels separates "rendered the Aitheros Online" from
 *  "rendered nothing". Appended to the log, never popped up anywhere. */
async function probeRendered(win) {
  try {
    const image = await win.webContents.capturePage();
    const { width, height } = image.getSize();
    if (!width || !height) {
      log("PROBE: capturePage returned an empty image — cannot judge");
      return;
    }
    const bitmap = image.toBitmap(); // BGRA
    let min = 255;
    let max = 0;
    let opaque = 0;
    const stride = 4 * 97; // sample ~1/97 of pixels — cheap and plenty
    for (let i = 0; i + 3 < bitmap.length; i += stride) {
      const lum = (bitmap[i] + bitmap[i + 1] + bitmap[i + 2]) / 3;
      if (lum < min) min = lum;
      if (lum > max) max = lum;
      if (bitmap[i + 3] > 8) opaque += 1;
    }
    const spread = max - min;
    const verdict =
      spread < 8 && opaque > 0
        ? `SUSPECT-BLANK (uniform lum ${min.toFixed(0)}..${max.toFixed(0)})`
        : `RENDERED (lum spread ${spread.toFixed(0)}, sampled opaque px ${opaque})`;
    log(`PROBE ${win.webContents.getURL()} -> ${verdict}`);
  } catch (err) {
    log(`PROBE failed: ${err}`);
  }
}

function createWindow() {
  const { workArea } = screen.getPrimaryDisplay();
  const win = new BrowserWindow({
    x: workArea.x,
    y: workArea.y,
    width: workArea.width,
    height: workArea.height,
    frame: false,
    transparent: true,
    backgroundColor: "#00000000",
    hasShadow: false,
    roundedCorners: false,
    // NOT alwaysOnTop: the avatar windows are alwaysOnTop and must float ABOVE the
    // Aitheros Online, the way they float above everything else.
    skipTaskbar: false, // a real surface the owner alt-tabs to and can close from the taskbar
    title: "AitherOS Aitheros Online",
    webPreferences: {
      partition: PARTITION,
      preload: path.join(__dirname, "living-desktop-preload.cjs"),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  // Keep the overlay inside the aitherium family; anything else goes to the system
  // browser instead of hijacking the overlay surface.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (isAitheriumFamily(url)) return { action: "allow" };
    void shell.openExternal(url);
    return { action: "deny" };
  });
  win.webContents.on("will-navigate", (event, targetUrl) => {
    if (!isAitheriumFamily(targetUrl)) {
      event.preventDefault();
      void shell.openExternal(targetUrl);
    }
  });

  win.webContents.on("did-fail-load", (_e, code, desc, failedUrl, isMainFrame) => {
    if (isMainFrame) log(`did-fail-load ${failedUrl}: ${code} ${desc}`);
  });
  win.webContents.on("did-finish-load", () => {
    // Local-node probing consent (owner-approved 2026-08-25): the shell's detector
    // (Veil local-node-optin.ts) only probes loopback after an explicit opt-in, and
    // this overlay partition starts with none — so the owner's own shell "detects no
    // local services" while the fleet runs on the same box. Desk is the owner's own
    // installed app on the owner's own machine: opening the Aitheros Online FROM Desk
    // is the explicit act, so grant it here per load. (The probes still need the
    // adk/awnode loopback ports to be UP; granting only removes the consent gate, it
    // cannot invent a service.)
    win.webContents
      .executeJavaScript(
        "try{localStorage.setItem('aither-local-node-probe-optin','1')}catch(e){}; true;",
      )
      .catch(() => {});
    setTimeout(() => {
      if (!win.isDestroyed()) void probeRendered(win);
    }, 4000);
    // Push the Desk snapshot once the shell has booted its listeners.
    setTimeout(() => {
      if (!win.isDestroyed()) pushDeskState();
    }, 2000);
  });

  // Frameless window needs a way out that doesn't depend on the page: Esc hides it.
  win.webContents.on("before-input-event", (_event, input) => {
    if (input.type === "keyDown" && input.key === "Escape") hideLivingDesktop();
  });

  win.on("closed", () => {
    stopGhostLoop();
    desktopWin = null;
  });
  win.on("show", startGhostLoop);
  win.on("hide", stopGhostLoop);

  const target = urlFor(transparentMode);
  log(`opening ${target} (transparent=${transparentMode}, ghost=${ghostMode})`);
  // Link the session BEFORE the first paint so the shell never flashes signed-out.
  void (async () => {
    const acct = await syncPortalSessionCookie();
    if (win.isDestroyed()) return;
    await win.loadURL(target);
    log(acct.signedIn
      ? `session linked (${acct.source}) — shell will see ${acct.username || "the signed-in account"}`
      : "NO usable session — shell renders signed-out; use Sign in from the tray or the AitherOS Online menu");
  })();
  startGhostLoop();
  return win;
}

function showLivingDesktop() {
  if (isOpen()) {
    desktopWin.show();
    desktopWin.focus();
    return desktopWin;
  }
  desktopWin = createWindow();
  return desktopWin;
}

function hideLivingDesktop() {
  if (isOpen()) desktopWin.hide();
}

function toggleLivingDesktop() {
  if (isOpen() && desktopWin.isVisible()) {
    hideLivingDesktop();
  } else {
    showLivingDesktop();
  }
}

function setSolidBackground(solid) {
  transparentMode = !solid;
  // Overlay-vs-solid is the page's own `?mode=overlay` switch, so flipping it is a
  // reload with the other URL — not a CSS patch that drifts with Veil deploys.
  if (isOpen()) void desktopWin.loadURL(urlFor(transparentMode));
}

// The overlay's menu rows are RECORDS in command-registry.cjs (group `desktop`),
// rendered onto the tray, every body's menu and the palette. This module used to
// export a hand-built menu fragment for them; the 09-13 consolidation deleted its
// two call sites and it sat here with zero callers for a week, which is how the
// overlay became unreachable by hand. What stays here is the STATE those rows
// read (desktopStatus) and the setters they call.
function setGhostMode(on) {
  ghostMode = Boolean(on);
  applyGhostTick();
}

function reloadLivingDesktop() {
  if (isOpen()) desktopWin.webContents.reload();
}

// ── Desk -> Aitheros Online state channel ──────────────────────────────────────────────
// main.cjs registers a snapshot provider (decision cards, avatar slots, agents,
// relay feed); the overlay receives the latest snapshot on every load and whenever
// main calls pushDeskState(). The page-side listener is the Veil OS
// (overlay-host/os-client listens for { __aither: 'desk-state' } postMessages —
// the same family as the os-regions protocol the preload already relays).
let deskStateProvider = null;
function setDeskStateProvider(fn) {
  deskStateProvider = fn;
}
function pushDeskState() {
  if (!isOpen() || typeof deskStateProvider !== "function") return;
  const snapshot = deskStateProvider();
  if (!snapshot) return;
  desktopWin.webContents.send("living-desktop:desk-state", snapshot);
}

// ── The AitherDesktop APP window ────────────────────────────────────────────────────
// Owner, 2026-09-08: "one is an overlay that goes on top of the OS/browser, the
// other is a fully AitherDesktop app ... the same AitherDesktop on aitherium.com".
// The overlay above is the first. This is the second: a REAL framed, opaque,
// maximisable window on the same aitherium.com desktop, shell `aither-desktop`
// ("Desktop Anywhere" — Veil `shell-registry.tsx`, `@aitheros/desktop-core`
// DesktopShell), reached by `?shell=` because `/desktop` is auth-gated in prod.
// Same session partition as the overlay, so signing in once signs in both; same
// navigation fence, so the window stays inside the aitherium family.
const DESKTOP_APP_SHELL = "aither-desktop";
let appWin = null;

// `app` opens one window on arrival: both desktop shells read `?app=<id>` once.
function desktopAppUrl(app = "") {
  try {
    const url = new URL(BASE_URL);
    url.searchParams.delete("mode");
    url.searchParams.set("shell", DESKTOP_APP_SHELL);
    if (app) url.searchParams.set("app", app);
    return url.href;
  } catch {
    return BASE_URL;
  }
}

function isAppOpen() {
  return appWin != null && !appWin.isDestroyed();
}

function showDesktopApp({ app = "" } = {}) {
  if (isAppOpen()) {
    if (appWin.isMinimized()) appWin.restore();
    // The shells read `?app=` once per load, so a named app needs a navigation.
    if (app) void appWin.loadURL(desktopAppUrl(app));
    appWin.show();
    appWin.focus();
    return appWin;
  }
  const { workArea } = screen.getPrimaryDisplay();
  appWin = new BrowserWindow({
    width: Math.min(1440, workArea.width - 80),
    height: Math.min(900, workArea.height - 80),
    minWidth: 960,
    minHeight: 600,
    show: false,
    frame: true,
    autoHideMenuBar: true,
    backgroundColor: "#0b0d12",
    title: "AitherDesktop",
    webPreferences: {
      partition: PARTITION,
      preload: path.join(__dirname, "living-desktop-preload.cjs"),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  appWin.webContents.setWindowOpenHandler(({ url }) => {
    if (isAitheriumFamily(url)) return { action: "allow" };
    void shell.openExternal(url);
    return { action: "deny" };
  });
  appWin.webContents.on("will-navigate", (event, targetUrl) => {
    if (!isAitheriumFamily(targetUrl)) {
      event.preventDefault();
      void shell.openExternal(targetUrl);
    }
  });
  appWin.webContents.on("did-fail-load", (_e, code, desc, failedUrl, isMainFrame) => {
    if (isMainFrame) log(`[app] did-fail-load ${failedUrl}: ${code} ${desc}`);
  });
  // The apex boots through a landing ("AI that runs on hardware you own" / Enter
  // the OS) unless THIS TAB already reached the desktop this session — Veil's
  // os-client.tsx keys that on sessionStorage 'aither-os-session'. A fresh
  // Electron window is a fresh tab, so the owner got the marketing hero instead
  // of the desktop (screenshot, 2026-09-08 09:40). Mark the session booted on
  // the first load and reload ONCE; the second load lands on the desktop stage.
  let bootSkipped = false;
  appWin.webContents.on("did-finish-load", () => {
    appWin.webContents
      .executeJavaScript(
        "try{localStorage.setItem('aither-local-node-probe-optin','1')}catch(e){};" +
          "(function(){try{if(sessionStorage.getItem('aither-os-session'))return 'booted';" +
          "sessionStorage.setItem('aither-os-session','1');return 'marked'}catch(e){return 'no-storage'}})();",
      )
      .then((state) => {
        if (state === "marked" && !bootSkipped && appWin && !appWin.isDestroyed()) {
          bootSkipped = true;
          log("[app] first load reached the landing; session marked booted, reloading to the desktop stage");
          appWin.webContents.reload();
        }
      })
      .catch(() => {});
  });
  appWin.once("ready-to-show", () => {
    appWin.maximize();
    appWin.show();
    appWin.focus();
  });
  appWin.on("closed", () => {
    appWin = null;
  });
  const target = desktopAppUrl(app);
  log(`[app] opening ${target}`);
  void (async () => {
    await syncPortalSessionCookie();
    if (appWin && !appWin.isDestroyed()) await appWin.loadURL(target);
  })();
  return appWin;
}

/** Which of the two surfaces are up — for the deck rows, MCP and the bridge. */
function desktopStatus() {
  return {
    overlay: { open: isOpen(), visible: isOpen() && desktopWin.isVisible(), shell: shellId, ghost: ghostMode, transparent: transparentMode },
    app: { open: isAppOpen(), visible: isAppOpen() && appWin.isVisible(), shell: DESKTOP_APP_SHELL },
    url: BASE_URL,
    shells: SHELL_CHOICES.map((c) => ({ id: c.id, label: c.label })),
  };
}

/** Close the AitherDesktop app window (the console's "reattach"). No-op when absent. */
function closeDesktopApp() {
  if (appWin && !appWin.isDestroyed()) appWin.close();
}

/**
 * Make the shared partition signed-in if it can be, and say whether it is.
 *
 * For any surface that shows aitherium.com from this partition WITHOUT being the
 * overlay window -- today the console's AitherOS Online pane. The overlay ran
 * syncPortalSessionCookie() before its own load; the pane ran nothing, so with no
 * cookie already in the partition it loaded the apex signed-out and the owner got
 * the marketing landing page inside his own console (screenshot, 2026-09-20).
 */
async function ensureDesktopSession() {
  const acct = await syncPortalSessionCookie();
  return acct.signedIn;
}

/** Refresh who the windows are signed in as WITHOUT opening one (tray label at boot).
 *  Cookie and auth.json only: the vault rung waits until a window actually opens. */
function refreshAccount() {
  return syncPortalSessionCookie({ useVault: false });
}

module.exports = {
  ensureDesktopSession,
  portalLoginUrl: () => PORTAL_LOGIN_URL,
  openLivingDesktop: showLivingDesktop, // kept for older callers
  closeDesktopApp,
  showLivingDesktop,
  showDesktopApp,
  desktopStatus,
  desktopAppUrl,
  isAppOpen,
  setShell,
  SHELL_CHOICES,
  DESKTOP_APP_SHELL,
  hideLivingDesktop,
  toggleLivingDesktop,
  setSolidBackground,
  setGhostMode,
  reloadLivingDesktop,
  beginSignIn,
  signOut,
  accountStatus,
  onAccountChange,
  refreshAccount,
  setDeskStateProvider,
  setOverlayHost,
  pushDeskState,
  isOpen,
  LOG_FILE,
};
