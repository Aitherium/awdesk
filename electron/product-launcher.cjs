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
 * `registryRecords()` are the command-registry.cjs records (group "products",
 * `product: <id>`). They join COMMANDS in the same change that teaches main.cjs's
 * runCommand default branch `if (command.product) return runProductCommand(...)`
 * -- command-registry.test.cjs refuses a record nothing routes, correctly.
 */

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const SHOP_BASE = String(process.env.AITHER_SHOP_URL || "https://aitherium.com/shop").replace(/\/+$/, "");

const PRODUCTS = Object.freeze([
  Object.freeze({ id: "deep-research", name: "Deep Research Studio", kind: "local", pack: "deep-research",
    executables: Object.freeze(["deep-research-agent", "deep-research-studio"]) }),
  Object.freeze({ id: "saga", name: "Saga", kind: "local", pack: "saga",
    executables: Object.freeze(["saga"]) }),
  Object.freeze({ id: "agent-home", name: "Agent Home", kind: "local", pack: "agent-home",
    executables: Object.freeze(["agent-home", "aither-agent-home"]) }),
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

/** Path of the product's executable, or null. Hosted products are never installed. */
function findInstalled(product, { env = process.env, platform = process.platform, exists = fs.existsSync, which } = {}) {
  if (!product || product.kind !== "local") return null;
  const dir = path.join(appsDir(env), product.id);
  for (const exe of product.executables) {
    for (const name of platform === "win32" ? [`${exe}.exe`, exe] : [exe]) {
      const candidate = path.join(dir, name);
      if (exists(candidate)) return candidate;
    }
  }
  const lookup = which || ((name) => defaultWhich(name, { env, platform, exists }));
  for (const exe of product.executables) {
    const hit = lookup(exe);
    if (hit) return hit;
  }
  return null;
}

/** { action: "open"|"launch"|"shop", url?, path? } -- same rule as core/products.py. */
function planFor(product, opts = {}) {
  if (product.kind === "hosted") return { action: "open", url: product.webUrl };
  const installed = findInstalled(product, opts);
  if (installed) return { action: "launch", path: installed };
  return { action: "shop", url: shopUrl(product) };
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
    try {
      const child = spawn(plan.path, [], { detached: true, stdio: "ignore" });
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
  PRODUCTS, SHOP_BASE, byProductId, shopUrl, appsDir, findInstalled, planFor,
  registryRecords, runProductCommand,
};
