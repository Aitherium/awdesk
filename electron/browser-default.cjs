"use strict";

/**
 * browser-default.cjs -- make the Aither Browser a Windows default-browser choice.
 *
 * Windows lets an app REGISTER as a browser; only the person picks the default
 * (Settings > Default apps; the UserChoice key is hash-protected, so no app may set
 * it). This module writes the registration under HKCU (no admin) and opens the
 * Settings page for the Aither Browser, where the owner clicks "Set default" once.
 *
 * Registered: a URL ProgID for http/https, the Capabilities key, and the RegisteredApplications entry that makes Windows
 * list it. The command is `"<exe>" ["<app dir>"] --browser-url "%1"`; main.cjs
 * opens that URL as an owner tab (cold start or second instance). Unregister
 * deletes exactly the keys this module writes.
 */

const path = require("node:path");

const APP_NAME = "Aither Browser";
const CLIENT_KEY = "HKCU\\Software\\Clients\\StartMenuInternet\\AitherBrowser";
const URL_PROGID = "AitherBrowserURL";
const HTML_PROGID = "AitherBrowserHTML";
const URL_FLAG = "--browser-url";
const REG_TIMEOUT_MS = 10_000;

/** `"<exe>" "<app dir>" --browser-url "%1"`: every path quoted. */
function openCommand({ exe, appArgs = [] }) {
  const exePath = String(exe || "").trim();
  if (!exePath || !path.win32.isAbsolute(exePath)) throw new Error("the desk executable path must be absolute");
  if (/"/.test(exePath) || appArgs.some((a) => /"/.test(String(a)))) throw new Error("a quote inside a path is refused");
  return `${[exePath, ...appArgs.map(String)].map((p) => `"${p}"`).join(" ")} ${URL_FLAG} "%1"`;
}

/**
 * Every reg.exe `add` argv, in order. `icon` is "<exe>,0".
 * @returns {string[][]}
 */
function registerCommands({ exe, appArgs = [] }) {
  const cmd = openCommand({ exe, appArgs });
  const icon = `${String(exe)},0`;
  const add = (key, name, data) => (name === null
    ? ["add", key, "/ve", "/t", "REG_SZ", "/d", data, "/f"]
    : ["add", key, "/v", name, "/t", "REG_SZ", "/d", data, "/f"]);
  const classes = "HKCU\\Software\\Classes";
  const caps = `${CLIENT_KEY}\\Capabilities`;
  const out = [];
  for (const [progid, label] of [[URL_PROGID, `${APP_NAME} URL`], [HTML_PROGID, `${APP_NAME} Document`]]) {
    out.push(add(`${classes}\\${progid}`, null, label));
    out.push(add(`${classes}\\${progid}`, "FriendlyTypeName", label));
    out.push(add(`${classes}\\${progid}\\DefaultIcon`, null, icon));
    out.push(add(`${classes}\\${progid}\\shell\\open\\command`, null, cmd));
  }
  out.push(add(CLIENT_KEY, null, APP_NAME));
  out.push(add(`${CLIENT_KEY}\\DefaultIcon`, null, icon));
  out.push(add(`${CLIENT_KEY}\\shell\\open\\command`, null, `${openCommand({ exe, appArgs }).replace(` ${URL_FLAG} "%1"`, "")} --browser`));
  out.push(add(caps, "ApplicationName", APP_NAME));
  out.push(add(caps, "ApplicationDescription", "The Aither Browser: your browser, with your agents beside you."));
  out.push(add(caps, "ApplicationIcon", icon));
  for (const scheme of ["http", "https"]) out.push(add(`${caps}\\URLAssociations`, scheme, URL_PROGID));
  // No file associations: the browser opens only http(s) (browser-policy refuses file:).
  out.push(add(`${caps}\\StartMenu`, "StartMenuInternet", "AitherBrowser"));
  out.push(add("HKCU\\Software\\RegisteredApplications", APP_NAME, `Software\\Clients\\StartMenuInternet\\AitherBrowser\\Capabilities`));
  return out;
}

/** The reg.exe `delete` argv lists that undo registerCommands exactly. */
function unregisterCommands() {
  return [
    ["delete", "HKCU\\Software\\RegisteredApplications", "/v", APP_NAME, "/f"],
    ["delete", CLIENT_KEY, "/f"],
    ["delete", `HKCU\\Software\\Classes\\${URL_PROGID}`, "/f"],
    ["delete", `HKCU\\Software\\Classes\\${HTML_PROGID}`, "/f"],
  ];
}

/** The Settings page that lists the Aither Browser's own defaults (Windows 11). */
function settingsUri() {
  return `ms-settings:defaultapps?registeredAppUser=${encodeURIComponent(APP_NAME)}`;
}

/**
 * The URL a `--browser-url <url>` argv asks for (Windows passes "%1" as its own
 * argument), or null. Only http(s).
 */
function urlFromArgv(argv) {
  const list = Array.isArray(argv) ? argv.map(String) : [];
  let raw = null;
  const at = list.indexOf(URL_FLAG);
  if (at >= 0 && list[at + 1]) raw = list[at + 1];
  const eq = list.find((a) => a.startsWith(`${URL_FLAG}=`));
  if (!raw && eq) raw = eq.slice(URL_FLAG.length + 1);
  if (!raw) return null;
  raw = raw.trim();
  if (/^https?:\/\//i.test(raw)) {
    try { return new URL(raw).href; } catch { return null; }
  }
  return null;
}

function regExe(env = process.env) {
  const root = env.SystemRoot || env.SYSTEMROOT || "C:\\Windows";
  return path.join(root, "System32", "reg.exe");
}

function defaultExecFile(file, args, opts) {
  return new Promise((resolve) => {
    require("node:child_process").execFile(file, args, { ...opts, windowsHide: true }, (error, stdout, stderr) => {
      const code = error ? (typeof error.code === "number" ? error.code : 1) : 0;
      resolve({ code, stdout: String(stdout || ""), stderr: String(stderr || "") });
    });
  });
}

/**
 * @param {{execFile?: Function, platform?: string, exe?: string, appArgs?: string[], env?: object,
 *   openExternal?: (uri: string) => Promise<void>}} opts
 */
function createDefaultBrowser({
  execFile = defaultExecFile, platform = process.platform, exe = process.execPath, appArgs = [],
  env = process.env, openExternal = null,
} = {}) {
  const reg = (args) => Promise.resolve(execFile(regExe(env), args, { windowsHide: true, timeout: REG_TIMEOUT_MS }))
    .catch((error) => ({ code: -1, stdout: "", stderr: String((error && error.message) || error) }));
  return {
    /** Is the registration in place, pointing at THIS desk's executable? */
    async registered() {
      if (platform !== "win32") return false;
      const r = await reg(["query", `HKCU\\Software\\Classes\\${URL_PROGID}\\shell\\open\\command`, "/ve"]);
      if (r.code !== 0) return false;
      try { return r.stdout.includes(openCommand({ exe, appArgs })); } catch { return false; }
    },
    /** Write the registration, then open Settings so the owner picks the default. */
    async register({ openSettings = true } = {}) {
      if (platform !== "win32") return { ok: false, error: "default-browser registration is Windows only" };
      let cmds;
      try { cmds = registerCommands({ exe, appArgs }); } catch (error) { return { ok: false, error: String(error.message) }; }
      for (const args of cmds) {
        const r = await reg(args);
        if (r.code !== 0) {
          for (const undo of unregisterCommands()) await reg(undo);
          return { ok: false, error: `reg.exe refused (${(r.stderr || "").trim().slice(0, 160) || `exit ${r.code}`}) -- rolled back` };
        }
      }
      if (openSettings && typeof openExternal === "function") {
        try { await openExternal(settingsUri()); } catch { /* the registration still stands */ }
      }
      return { ok: true, settings: settingsUri() };
    },
    async unregister() {
      if (platform !== "win32") return { ok: false, error: "Windows only" };
      for (const args of unregisterCommands()) await reg(args);
      return { ok: true };
    },
  };
}

module.exports = {
  APP_NAME, CLIENT_KEY, HTML_PROGID, URL_FLAG, URL_PROGID,
  createDefaultBrowser, openCommand, registerCommands, settingsUri, unregisterCommands, urlFromArgv,
};
