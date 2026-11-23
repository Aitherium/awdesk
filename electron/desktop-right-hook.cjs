"use strict";

/**
 * desktop-right-hook.cjs -- the desk side of the native right-click hook.
 *
 * Owner, 2026-11-23: a plain right-click on the EMPTY desktop opens the one ring.
 * The hit test itself is native (native/windows/DeskMouseHook.cs, a WH_MOUSE_LL
 * helper): it acts only on the shell's desktop window or its icon view with no icon
 * under the cursor, passes every other click through untouched, and passes
 * Shift+right-click through so Windows' own menu still opens. A qualifying press is
 * swallowed (no native menu) and one JSON line comes back here.
 *
 * This module:
 *   - compiles the helper on first use with the .NET Framework csc.exe (no Visual
 *     Studio needed) and caches the EXE in userData, rebuilding when the .cs is newer;
 *   - spawns it hidden, parses its JSON lines, and calls onRight({x,y});
 *   - is fail-soft: a missing compiler, a refused hook or a dead child only logs --
 *     the desktop keeps working because every non-qualifying event is passed through;
 *   - exposes stats() for the measured per-click cost.
 *
 * Dependency-injected so node --test can exercise the framing without Windows.
 */

const path = require("node:path");
const fs = require("node:fs");
const { spawn, execFileSync } = require("node:child_process");

/** The .NET Framework C# compiler that ships with Windows (no VS required). */
function cscPath(env = process.env, fsImpl = fs) {
  const win = env.WINDIR || "C:\\Windows";
  const candidates = [
    path.join(win, "Microsoft.NET", "Framework64", "v4.0.30319", "csc.exe"),
    path.join(win, "Microsoft.NET", "Framework", "v4.0.30319", "csc.exe"),
  ];
  return candidates.find((p) => {
    try { return fsImpl.existsSync(p); } catch { return false; }
  }) || null;
}

/**
 * @param {object} opts
 * @param {object} [opts.app]        Electron app (userData path); omitted in tests
 * @param {string} [opts.root]       repo root (defaults to this file's parent)
 * @param {Function} [opts.onRight]  ({x,y}) => void -- a qualifying desktop click
 * @param {Function} [opts.log]
 * @param {Function} [opts.spawnImpl]
 * @param {Function} [opts.execImpl]
 * @param {object}   [opts.fsImpl]
 */
function createDesktopRightHook({
  app = null,
  root = path.join(__dirname, ".."),
  onRight = () => {},
  log = () => {},
  spawnImpl = spawn,
  execImpl = execFileSync,
  fsImpl = fs,
} = {}) {
  // Dev: the source lives in the checkout. Packaged: it is shipped as an extra
  // resource outside app.asar, because csc.exe (an external process) cannot read
  // inside an asar archive.
  const candidates = [
    process.resourcesPath ? path.join(process.resourcesPath, "native", "windows", "DeskMouseHook.cs") : null,
    path.join(root, "native", "windows", "DeskMouseHook.cs"),
  ].filter(Boolean);
  const source = candidates.find((p) => {
    try { return fsImpl.existsSync(p); } catch { return false; }
  }) || candidates[candidates.length - 1];
  const exe = app && typeof app.getPath === "function"
    ? path.join(app.getPath("userData"), "desk-mouse-hook.exe")
    : path.join(root, "build", "DeskMouseHook.exe");
  const statsTimeoutMs = 1500;

  let child = null;
  let ready = false;
  let buffer = "";
  let pendingStats = null;

  /** Compile when the EXE is missing or older than its source. Returns a verdict. */
  function compile() {
    try {
      const srcStat = fsImpl.statSync(source);
      let exeStat = null;
      try { exeStat = fsImpl.statSync(exe); } catch { exeStat = null; }
      if (exeStat && exeStat.mtimeMs >= srcStat.mtimeMs) return { ok: true, exe, rebuilt: false };
      const csc = cscPath(process.env, fsImpl);
      if (!csc) return { ok: false, error: "no csc.exe (the .NET Framework compiler) on this machine" };
      fsImpl.mkdirSync(path.dirname(exe), { recursive: true });
      execImpl(csc, [
        "-nologo", "-target:exe", "-platform:anycpu", "-optimize+",
        `-out:${exe}`, "-r:System.dll", source,
      ], { windowsHide: true, stdio: "ignore" });
      return { ok: true, exe, rebuilt: true };
    } catch (error) {
      return { ok: false, error: String((error && error.message) || error) };
    }
  }

  /** One stdout line from the helper. */
  function handleLine(line) {
    let msg;
    try { msg = JSON.parse(String(line || "").trim()); } catch { return false; }
    if (!msg || typeof msg !== "object") return false;
    if (msg.type === "ready") { ready = true; return true; }
    if (msg.type === "stats") {
      const settle = pendingStats;
      pendingStats = null;
      if (settle) settle(msg);
      return true;
    }
    if (msg.type === "right") {
      const x = Number(msg.x);
      const y = Number(msg.y);
      if (!Number.isFinite(x) || !Number.isFinite(y)) return false;
      try { onRight({ x: Math.round(x), y: Math.round(y) }); } catch { /* caller */ }
      return true;
    }
    if (msg.type === "error") { log(`desktop hook: ${msg.error || "error"}`); return true; }
    return false;
  }

  function start() {
    if (child) return { ok: true, running: true };
    const built = compile();
    if (!built.ok) { log(`desktop hook: ${built.error}`); return built; }
    let c;
    try {
      c = spawnImpl(built.exe, [], { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    } catch (error) {
      return { ok: false, error: String((error && error.message) || error) };
    }
    child = c;
    if (c.stdout && typeof c.stdout.setEncoding === "function") {
      c.stdout.setEncoding("utf8");
      c.stdout.on("data", (chunk) => {
        buffer += chunk;
        let nl;
        while ((nl = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, nl).trim();
          buffer = buffer.slice(nl + 1);
          if (line) handleLine(line);
        }
      });
    }
    if (c.stderr) c.stderr.on("data", () => { /* the helper reports errors on stdout */ });
    c.on("error", (error) => {
      log(`desktop hook failed: ${error && error.message ? error.message : error}`);
      if (child === c) child = null;
      ready = false;
    });
    c.on("exit", (code) => {
      if (child === c) {
        child = null;
        log(`desktop hook exited (${code}); the desktop is untouched`);
      }
      ready = false;
    });
    return { ok: true, rebuilt: built.rebuilt, exe: built.exe };
  }

  function stop() {
    const c = child;
    child = null;
    ready = false;
    if (!c) return { ok: true };
    try { c.stdin.write("quit\n"); } catch { /* already gone */ }
    try { c.kill(); } catch { /* already gone */ }
    return { ok: true };
  }

  /** The helper's measured per-click cost, or null. */
  function stats() {
    if (!child) return Promise.resolve(null);
    return new Promise((resolve) => {
      if (pendingStats) { pendingStats(null); pendingStats = null; }
      const timer = setTimeout(() => {
        pendingStats = null;
        resolve(null);
      }, statsTimeoutMs);
      if (timer.unref) timer.unref();
      pendingStats = (msg) => { clearTimeout(timer); resolve(msg); };
      try { child.stdin.write("stats\n"); } catch {
        clearTimeout(timer);
        pendingStats = null;
        resolve(null);
      }
    });
  }

  return {
    start, stop, stats, handleLine, compile,
    isRunning: () => Boolean(child),
    isReady: () => ready,
    exePath: () => exe,
  };
}

module.exports = { createDesktopRightHook, cscPath };
