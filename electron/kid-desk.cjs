"use strict";

/**
 * kid-desk — "Kid desk" mode for a child's PC (kids' suite S7).
 *
 * A grown-up turns it on for the child's computer; the child never can from inside the
 * desk. In kid mode the desk is ONE thing: the child's own classroom (Aither Learn at
 * app.aitherium.com/learn, signed in as the child) with their own sprite. Everything adult
 * is absent, not hidden behind a toggle:
 *
 *   - the character ROSTER is empty (no VRM bodies, no adult-rated anything, no agent
 *     avatars): listCharacters() answers [] and a switch/install/spawn is refused;
 *   - no avatar overlay, no agent apps, no command palette, no global shortcuts, no
 *     settings window, no fleet, no MCP bridge;
 *   - the classroom window navigates only on the EXACT classroom host (app.aitherium.com
 *     unless the machine policy names another aitherium.com page host); any other link
 *     (a sibling subdomain, a new window, a redirect off-site) is refused and never opens a
 *     browser. It has its own session partition, so no grown-up's desk sign-in rides along.
 *
 * Who controls it: the GUARDIAN, through MACHINE policy a standard (child) Windows account
 * cannot write or delete. Either one turns it on, and nothing in the child's own scope
 * (a launch flag, a user environment variable, a file in their AppData) can turn it on or
 * off -- those are child-removable and are not read at all:
 *   - Windows: HKLM\SOFTWARE\Policies\Aitherium\AWDesk  KidDesk (REG_DWORD) = 1, or
 *   - <machine ProgramData>\Aitherium\awdesk\kid-desk.json = {"enabled": true}, written by
 *     an administrator (an admin-created ProgramData file is read-only to standard users).
 *     "Machine ProgramData" is read from HKLM (ProfileList\ProgramData, its %SystemDrive%
 *     expanded from HKLM too), NEVER from the process environment: a standard account can
 *     set a per-user ProgramData variable (or launch the desk with any env it likes) and
 *     point the lookup at an empty folder, which would turn kid mode OFF. If HKLM cannot
 *     be read, the file is not read at all and only the HKLM policy value counts;
 *   - macOS: /Library/Application Support/Aitherium/awdesk/kid-desk.json;
 *     Linux: /etc/aitherium/awdesk/kid-desk.json (root-owned).
 * The policy file may carry "classroom_origin" (an https aitherium.com page host; honoured
 * only when that file is what turns kid mode on). Turning it off is the grown-up removing
 * that policy; no in-desk control exists. A second launch (any flag, any desk:// link)
 * only brings the classroom forward (main.cjs).
 *
 * Pure decisions here (tested in kid-desk.test.cjs); main.cjs wires them to Electron.
 */

const fs = require("node:fs");
const path = require("node:path");

const DEFAULT_ONLINE = "https://app.aitherium.com/";
const CLASSROOM_PATH = "/learn";
const FILE = "kid-desk.json";
const PARTITION = "persist:awdesk-kid";
const REG_KEY = "HKLM\\SOFTWARE\\Policies\\Aitherium\\AWDesk";
const REG_VALUE = "KidDesk";
/** reg.exe by ABSOLUTE path: a bare "reg" is searched in the working directory and the
 *  PATH first, both of which the launching (child) account controls. */
const REG_EXE = "C:\\Windows\\System32\\reg.exe";
const PROFILE_LIST_KEY = "HKLM\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\ProfileList";
const SESSION_ENV_KEY = "HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment";
const NT_CURRENT_KEY = "HKLM\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion";
const REG_OPTS = { encoding: "utf8", windowsHide: true, timeout: 5000, stdio: ["ignore", "pipe", "ignore"] };

/** Is `hostname` on the aitherium.com page host family? Only vets the policy's
 *  classroom_origin; navigation is checked against the ONE classroom origin. */
function isAitheriumHost(hostname) {
  const h = String(hostname || "").toLowerCase();
  return h === "aitherium.com" || h.endsWith(".aitherium.com");
}

/** One HKLM string value via reg.exe (REG_SZ / REG_EXPAND_SZ, unexpanded), or "". */
function regString(key, value, { execFileSync = null } = {}) {
  try {
    const run = execFileSync || require("node:child_process").execFileSync;
    const out = String(run(REG_EXE, ["query", key, "/v", value], REG_OPTS));
    for (const line of out.split(/\r?\n/)) {
      const m = line.match(/^\s*(\S+)\s+REG_(?:EXPAND_)?SZ\s+(.+?)\s*$/);
      if (m && m[1].toLowerCase() === value.toLowerCase()) return m[2];
    }
    return "";
  } catch {
    return "";
  }
}

/**
 * The MACHINE's ProgramData folder, from HKLM only (never the environment): ProfileList's
 * ProgramData value with %SystemDrive% / %SystemRoot% expanded from HKLM as well. Any other
 * variable, a relative result or an unreadable key = "" (the caller then skips the file).
 */
function machineProgramData({ platform = process.platform, execFileSync = null } = {}) {
  if (platform !== "win32") return "";
  const q = (key, value) => regString(key, value, { execFileSync });
  const raw = q(PROFILE_LIST_KEY, "ProgramData");
  if (!raw) return "";
  let systemRoot = null;
  const root = () => (systemRoot === null ? (systemRoot = q(NT_CURRENT_KEY, "SystemRoot")) : systemRoot);
  const vars = {
    systemdrive: () => q(SESSION_ENV_KEY, "SystemDrive") || (/^[A-Za-z]:/.test(root()) ? root().slice(0, 2) : ""),
    systemroot: root,
  };
  let unresolved = false;
  const expanded = raw.replace(/%([^%]+)%/g, (_m, name) => {
    const get = vars[String(name).toLowerCase()];
    const v = get ? get() : "";
    if (!v) unresolved = true;
    return v;
  });
  if (unresolved || expanded.includes("%") || !/^[A-Za-z]:\\/.test(expanded)) return "";
  return path.win32.normalize(expanded);
}

/** Where the machine policy file lives on this platform (admin/root-writable only), or ""
 *  on Windows when the machine ProgramData cannot be read from HKLM. */
function policyFilePath({ platform = process.platform, programData = undefined, execFileSync = null } = {}) {
  if (platform === "win32") {
    const root = programData === undefined ? machineProgramData({ platform, execFileSync }) : programData;
    return root ? path.win32.join(root, "Aitherium", "awdesk", FILE) : "";
  }
  if (platform === "darwin") return path.posix.join("/Library/Application Support/Aitherium/awdesk", FILE);
  return path.posix.join("/etc/aitherium/awdesk", FILE);
}

/** The HKLM policy value (Windows): true when KidDesk is a non-zero DWORD. Unset = false. */
function readRegistryPolicy({ platform = process.platform, execFileSync = null } = {}) {
  if (platform !== "win32") return false;
  try {
    const run = execFileSync || require("node:child_process").execFileSync;
    const out = String(run(REG_EXE, ["query", REG_KEY, "/v", REG_VALUE], REG_OPTS));
    const m = out.match(/KidDesk\s+REG_DWORD\s+0x([0-9a-f]+)/i);
    return Boolean(m && parseInt(m[1], 16) !== 0);
  } catch {
    return false;
  }
}

/** The machine policy file as an object. Missing, unreadable or no path = {}. */
function readPolicyFile(file) {
  if (!file) return {};
  try {
    const raw = JSON.parse(fs.readFileSync(file, "utf8"));
    return raw && typeof raw === "object" ? raw : {};
  } catch {
    return {};
  }
}

/** The classroom origin: the policy's https aitherium.com page host, else app.aitherium.com. */
function classroomOrigin(wanted) {
  try {
    const u = new URL(String(wanted || ""));
    if (u.protocol === "https:" && isAitheriumHost(u.hostname) && !u.username && !u.password) {
      return u.origin;
    }
  } catch { /* fall through to the default */ }
  return new URL(DEFAULT_ONLINE).origin;
}

/**
 * Is kid-desk mode on? Reads ONLY machine policy (see the header): `readRegistry` and
 * `policyFile` are injectable for tests; production passes neither.
 */
function resolveKidDesk({ platform = process.platform, policyFile = "", readRegistry = null } = {}) {
  const fromRegistry = Boolean((readRegistry || (() => readRegistryPolicy({ platform })))());
  const policy = readPolicyFile(policyFile || policyFilePath({ platform }));
  const fromFile = policy.enabled === true;
  const enabled = fromRegistry || fromFile;
  return Object.freeze({
    enabled,
    source: fromRegistry ? "machine-registry" : fromFile ? "machine-file" : "",
    // The file's classroom_origin counts only when that file is what turned kid mode on:
    // under a registry policy, a file a child dropped into an empty ProgramData folder
    // cannot move the classroom to another host.
    origin: classroomOrigin(!fromRegistry && fromFile ? policy.classroom_origin : ""),
  });
}

/** The classroom URL for a resolved state (or the default page host). */
function classroomUrl(state) {
  const origin = (state && state.origin) || classroomOrigin("");
  return new URL(`${CLASSROOM_PATH}?desk=kid`, `${origin}/`).toString();
}

/** May the kid-desk window go to `target`? Only https on the EXACT classroom origin (same
 *  host, default port, no credentials): a sibling aitherium.com host is refused too. */
function allowNavigation(target, state) {
  const origin = (state && state.origin) || classroomOrigin("");
  try {
    const u = new URL(String(target || ""));
    return u.protocol === "https:" && u.origin === origin && !u.username && !u.password;
  } catch {
    return false;
  }
}

/**
 * Debug doors a child could open from their own scope to drive the classroom window
 * (CDP can navigate anywhere and run script in it): the DESK_CDP_PORT env var main.cjs
 * honours, and Chromium's own --remote-debugging-* switches on the launch line. In kid
 * mode none is honoured. `commandLine` is Electron's app.commandLine (before ready).
 */
const DEBUG_SWITCHES = ["remote-debugging-port", "remote-debugging-pipe", "remote-debugging-address"];
function allowCdpPort(state) {
  return !(state && state.enabled);
}
function scrubDebugSwitches(state, commandLine) {
  if (!(state && state.enabled) || !commandLine) return [];
  const removed = [];
  for (const name of DEBUG_SWITCHES) {
    try {
      if (commandLine.hasSwitch(name)) {
        commandLine.removeSwitch(name);
        removed.push(name);
      }
    } catch { /* an Electron without removeSwitch: nothing to scrub */ }
  }
  return removed;
}

/** The roster in kid mode: empty. Outside kid mode: unchanged. */
function gateRoster(state, names) {
  if (state && state.enabled) return [];
  return Array.isArray(names) ? names : [];
}

/** May the desk switch to / install / spawn a roster character? Never in kid mode. */
function allowCharacterChange(state) {
  return !(state && state.enabled);
}

/** The tray menu template in kid mode: open my classroom, nothing else. */
function kidTrayTemplate({ openClassroom }) {
  return [
    { label: "My classroom", click: () => openClassroom() },
  ];
}

/**
 * Open (or focus) the single kid-desk window. `deps` carries Electron's BrowserWindow so a
 * test can pass a fake. Returns the window.
 */
function openClassroomWindow(deps, { state = null, existing = null } = {}) {
  if (existing && !existing.isDestroyed()) {
    existing.show();
    existing.focus();
    return existing;
  }
  const win = new deps.BrowserWindow({
    width: 1280,
    height: 860,
    title: "My classroom",
    autoHideMenuBar: true,
    backgroundColor: "#050507",
    webPreferences: {
      partition: PARTITION,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webviewTag: false,
    },
  });
  win.setMenuBarVisibility?.(false);
  const contents = win.webContents;
  // No new windows at all; an off-site link does nothing (never a browser).
  contents.setWindowOpenHandler(() => ({ action: "deny" }));
  const guard = (event, url) => {
    if (!allowNavigation(url, state)) event.preventDefault();
  };
  contents.on("will-navigate", guard);
  contents.on("will-redirect", guard);
  contents.on("will-attach-webview", (event) => event.preventDefault());
  win.loadURL(classroomUrl(state));
  return win;
}

module.exports = {
  CLASSROOM_PATH,
  DEFAULT_ONLINE,
  FILE,
  PARTITION,
  DEBUG_SWITCHES,
  NT_CURRENT_KEY,
  PROFILE_LIST_KEY,
  REG_EXE,
  REG_KEY,
  REG_VALUE,
  SESSION_ENV_KEY,
  allowCdpPort,
  allowCharacterChange,
  allowNavigation,
  classroomOrigin,
  classroomUrl,
  gateRoster,
  isAitheriumHost,
  kidTrayTemplate,
  machineProgramData,
  openClassroomWindow,
  policyFilePath,
  readRegistryPolicy,
  regString,
  resolveKidDesk,
  scrubDebugSwitches,
};
