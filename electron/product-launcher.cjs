"use strict";

/**
 * Product launcher -- Deep Research Studio, Saga, Agent Home (local) and Iris
 * (hosted) as Desk commands: launch the installed app, or open its page.
 *
 * Electron-free and side-effect-free until `runProductCommand` is called with a
 * `shell` and `spawn`, so the whole decision is asserted under `node --test`.
 *
 * The catalog mirrors AitherDesktop's core/products.py (its parity test reads
 * this file). Install detection is the same rule: an executable in
 * ~/.aither/apps/<id>/ (where `aither install <id> --from <link>` puts a
 * download) or on PATH. Desk does not read the license: an app that is not
 * installed opens its shop page, which holds the purchase and resend flows.
 *
 * A product that ships as a CLI (Aither Hearth: awdk's `aither-hearth` console
 * script) names the arguments a launch passes (`launchArgs`) and sets `console`:
 * it opens in a terminal of its own, because the buyer must read what it prints
 * (the phone pairing code). An executable that only MAY carry the product (`adk`,
 * which has `adk home` only in recent awdk releases) counts as installed only when
 * its `probeArgs` exit 0.
 *
 * `registryRecords()` are the command-registry.cjs records (group "products",
 * `product: <id>`). They join COMMANDS in the same change that teaches main.cjs's
 * runCommand default branch `if (command.product) return runProductCommand(...)`
 * -- command-registry.test.cjs refuses a record nothing routes, correctly.
 */

const childProcess = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const SHOP_BASE = String(process.env.AITHER_SHOP_URL || "https://aitherium.com/shop").replace(/\/+$/, "");

const PRODUCTS = Object.freeze([
  Object.freeze({ id: "deep-research", name: "Deep Research Studio", kind: "local", pack: "deep-research",
    executables: Object.freeze(["deep-research-agent", "deep-research-studio"]) }),
  Object.freeze({ id: "saga", name: "Saga", kind: "local", pack: "saga",
    executables: Object.freeze(["saga"]) }),
  Object.freeze({ id: "agent-home", name: "Aither Hearth", kind: "local", pack: "agent-home",
    // awdk ships `aither-hearth`; bare it prints help and exits, so a launch runs
    // `serve --pair` in a terminal (the agent answers and prints the pairing code).
    // agent-home / aither-agent-home are the pre-rename names, kept as fallbacks;
    // `adk home serve --pair` covers an awdk older than the console script.
    executables: Object.freeze(["aither-hearth", "agent-home", "aither-agent-home", "adk"]),
    launchArgs: Object.freeze({
      "aither-hearth": Object.freeze(["serve", "--pair"]),
      adk: Object.freeze(["home", "serve", "--pair"]),
    }),
    probeArgs: Object.freeze({ adk: Object.freeze(["home", "--help"]) }),
    console: true }),
  Object.freeze({ id: "iris", name: "Iris", kind: "hosted", pack: null,
    executables: Object.freeze([]), webUrl: "https://aitherium.com/iris" }),
]);

function byProductId(id) {
  return PRODUCTS.find((p) => p.id === String(id || "").toLowerCase()) || null;
}

function shopUrl(product) {
  return `${SHOP_BASE}/${product.id}`;
}

function appsDir(env = process.env) {
  return env.AITHER_APPS_DIR || path.join(os.homedir(), ".aither", "apps");
}

function defaultWhich(name, { env = process.env, platform = process.platform, exists = fs.existsSync } = {}) {
  const exts = platform === "win32" ? String(env.PATHEXT || ".EXE;.CMD;.BAT").split(";").filter(Boolean) : [""];
  for (const dir of String(env.PATH || "").split(path.delimiter).filter(Boolean)) {
    for (const ext of exts) {
      const candidate = path.join(dir, name + ext);
      if (exists(candidate)) return candidate;
    }
  }
  return null;
}

const probeCache = new Map();

/** True when `file args...` exits 0 -- cached per process (it changes only on an upgrade). */
function defaultProbe(file, args) {
  const key = JSON.stringify([file, ...args]);
  if (!probeCache.has(key)) {
    const r = childProcess.spawnSync(file, args, { stdio: "ignore", timeout: 30_000, windowsHide: true });
    probeCache.set(key, !r.error && r.status === 0);
  }
  return probeCache.get(key);
}

function argsFor(product, exe) {
  return [...((product.launchArgs || {})[exe] || [])];
}

/** { path, args } a launch would run, or null. Hosted products are never installed. */
function findLaunch(product, { env = process.env, platform = process.platform, exists = fs.existsSync, which,
  probe = defaultProbe } = {}) {
  if (!product || product.kind !== "local") return null;
  const admitted = (exe, file) => {
    const needs = (product.probeArgs || {})[exe];
    return !needs || probe(file, [...needs]);
  };
  const dir = path.join(appsDir(env), product.id);
  for (const exe of product.executables) {
    for (const name of platform === "win32" ? [`${exe}.exe`, exe] : [exe]) {
      const candidate = path.join(dir, name);
      if (exists(candidate) && admitted(exe, candidate)) return { path: candidate, args: argsFor(product, exe) };
    }
  }
  const lookup = which || ((name) => defaultWhich(name, { env, platform, exists }));
  for (const exe of product.executables) {
    const hit = lookup(exe);
    if (hit && admitted(exe, hit)) return { path: hit, args: argsFor(product, exe) };
  }
  return null;
}

/** Path of the product's executable, or null. Hosted products are never installed. */
function findInstalled(product, opts = {}) {
  const hit = findLaunch(product, opts);
  return hit ? hit.path : null;
}

/** { action: "open"|"launch"|"shop", url?, path?, args? } -- same rule as core/products.py. */
function planFor(product, opts = {}) {
  if (product.kind === "hosted") return { action: "open", url: product.webUrl };
  const hit = findLaunch(product, opts);
  if (hit) return { action: "launch", path: hit.path, args: hit.args };
  return { action: "shop", url: shopUrl(product) };
}

const LINUX_TERMINALS = Object.freeze([
  ["x-terminal-emulator", ["-e"]], ["gnome-terminal", ["--"]], ["konsole", ["-e"]],
  ["xfce4-terminal", ["-x"]], ["xterm", ["-e"]],
]);

/** POSIX shell single-quoting (for the one line Terminal runs on macOS). */
function shQuote(s) {
  const text = String(s);
  return /^[A-Za-z0-9_\-.,:/=@%+]+$/.test(text) ? text : `'${text.replace(/'/g, `'"'"'`)}'`;
}

/**
 * { cmd, args, options? } that run `file args` in a NEW visible terminal, or null when there
 * is none. Windows: `cmd /c start "" file args` (the start idiom awsh uses to open
 * a page) gives the program a console window of its own. macOS: Terminal via
 * osascript. Linux: the first terminal emulator on PATH.
 */
function consoleCommand(file, args, { env = process.env, platform = process.platform, exists = fs.existsSync,
  which } = {}) {
  if (platform === "win32") {
    // Verbatim + every token quoted: a path is never split by cmd on a space or `&`
    // (Windows paths cannot contain a double quote, so the quoting cannot be escaped).
    const line = ["start", '""', ...[file, ...args].map((a) => `"${a}"`)].join(" ");
    return { cmd: "cmd.exe", args: ["/d", "/s", "/c", `"${line}"`], options: { windowsVerbatimArguments: true } };
  }
  if (platform === "darwin") {
    const line = [file, ...args].map(shQuote).join(" ").replace(/\\/g, "\\\\").replace(/"/g, '\\"');
    return { cmd: "osascript", args: ["-e", `tell application "Terminal" to do script "${line}"`,
      "-e", 'tell application "Terminal" to activate'] };
  }
  const lookup = which || ((name) => defaultWhich(name, { env, platform, exists }));
  for (const [term, flag] of LINUX_TERMINALS) {
    const hit = lookup(term);
    if (hit) return { cmd: hit, args: [...flag, file, ...args] };
  }
  return null;
}

/** The command-registry records: one per product, group "products". */
function registryRecords() {
  return PRODUCTS.map((p) => Object.freeze({
    id: `products.${p.id}`,
    label: p.kind === "hosted" ? `${p.name} (web)…` : `${p.name}…`,
    group: "products",
    surfaces: ["tray", "palette"],
    product: p.id,
  }));
}

/**
 * Perform a product command. `shell.openExternal` opens pages, `spawn` starts an
 * installed app detached. Returns the plan it carried out, for the palette.
 */
function runProductCommand(command, { shell, spawn, ...opts } = {}) {
  const product = byProductId(command && command.product);
  if (!product) return { ok: false, action: null, message: "unknown product" };
  const plan = planFor(product, opts);
  if (plan.action === "launch") {
    let cmd = plan.path;
    let args = plan.args || [];
    let extra = {};
    if (product.console) {
      // The buyer must SEE this one (Hearth prints its pairing code).
      const wrapped = consoleCommand(plan.path, args, opts);
      if (!wrapped) {
        const line = [plan.path, ...args].join(" ");
        return { ok: false, ...plan, message: `no terminal found -- run \`${line}\` in one` };
      }
      ({ cmd, args } = wrapped);
      extra = wrapped.options || {};
    }
    try {
      const child = spawn(cmd, args, { detached: true, stdio: "ignore", ...extra });
      if (child && typeof child.on === "function") child.on("error", () => {});
      if (child && typeof child.unref === "function") child.unref();
      return { ok: true, ...plan, message: `${product.name} launching` };
    } catch (err) {
      return { ok: false, ...plan, message: `could not start ${product.name}: ${err && err.message}` };
    }
  }
  if (!/^https:\/\//i.test(plan.url || "")) return { ok: false, ...plan, message: "refusing a non-https url" };
  Promise.resolve(shell.openExternal(plan.url)).catch(() => {});
  return { ok: true, ...plan, message: `${product.name}: ${plan.url}` };
}

module.exports = {
  PRODUCTS, SHOP_BASE, byProductId, shopUrl, appsDir, findInstalled, findLaunch, planFor,
  consoleCommand, registryRecords, runProductCommand,
};
