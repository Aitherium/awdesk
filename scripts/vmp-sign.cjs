"use strict";

/**
 * vmp-sign -- the production Widevine signature (VMP) for a packaged Aither.
 *
 * Aither builds on castLabs' Electron for Content Security, so the browser can play
 * protected video and music. Services that verify the platform (Netflix does) only
 * license a build whose binary carries a production VMP signature. castLabs signs for
 * free through its EVS service, which needs an EVS account. The binary castLabs ships
 * is signed for development only, and packaging renames and edits it, which breaks even
 * that: measured 2026-11-13, a renamed, fused copy reports PLATFORM_TAMPERED.
 *
 * This file is electron-builder's `afterPack` and `afterSign` hook (package.json
 * "build"). It does nothing unless AITHER_VMP_SIGN=1, so a build without an account is
 * unchanged. With it, the build FAILS when signing fails: a release never ships
 * believing it was signed.
 *
 * When each platform signs (castLabs: macOS BEFORE code-signing, Windows AFTER):
 *   macOS    afterPack. electron-builder flips the fuses after this hook, and the fuses
 *            live in the signed binary, so the hook flips them first (the later flip
 *            writes the same bytes: measured idempotent).
 *   Windows  afterSign. It fires with or without a certificate, after the icon, the
 *            version strings, the fuses and any Authenticode signature are written.
 *   Linux    never. Widevine on Linux has no VMP.
 *
 * Credentials: EVS_ACCOUNT_NAME and EVS_PASSWD in the environment, read by the EVS
 * client itself (never on a command line, never printed here). docs/WIDEVINE.md.
 *
 * Also a CLI:  node scripts/vmp-sign.cjs --verify <unpacked dir> [name]
 * Exit 0 valid, 1 invalid, 2 could not run.
 */

const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

/** Is signing asked for? Only the literal "1": an empty CI secret must stay off. */
function vmpEnabled(env = process.env) {
  return String(env.AITHER_VMP_SIGN || "") === "1";
}

/** The Python that has castlabs-evs installed. */
function pythonCommand({ env = process.env, platform = process.platform } = {}) {
  return env.AITHER_VMP_PYTHON || (platform === "win32" ? "python" : "python3");
}

/**
 * The packaged app's name, as EVS's --name-hint wants it (no extension): the one .app on
 * macOS, the main .exe on Windows. `names` are candidates in order; the first that exists
 * wins. Null when none does.
 */
function packageName({ platform, appOutDir, names = [], exists = fs.existsSync } = {}) {
  const ext = platform === "darwin" ? ".app" : ".exe";
  for (const name of names.filter(Boolean)) {
    if (exists(path.join(appOutDir, `${name}${ext}`))) return String(name);
  }
  return null;
}

/**
 * What one hook does. Pure.
 * @returns {{run: false, reason: string} | {run: true, flipFuses: boolean, command: string, args: string[]}}
 */
function vmpPlan({ hook, platform, appOutDir, name, env = process.env } = {}) {
  if (!vmpEnabled(env)) return { run: false, reason: "AITHER_VMP_SIGN is not 1 (this build keeps no production VMP signature)" };
  if (platform !== "darwin" && platform !== "win32") return { run: false, reason: `Widevine has no VMP on ${platform}` };
  const due = platform === "darwin" ? "afterPack" : "afterSign";
  if (hook !== due) return { run: false, reason: `${platform} signs in ${due}` };
  if (!name) throw new Error(`vmp-sign: no packaged app found in ${appOutDir}`);
  return {
    run: true,
    flipFuses: platform === "darwin",
    command: pythonCommand({ env, platform }),
    args: ["-m", "castlabs_evs.vmp", "--no-ask", "sign-pkg", "--name-hint", name, appOutDir],
  };
}

function candidateNames(context) {
  const packager = context.packager || {};
  const options = packager.platformSpecificBuildOptions || {};
  const info = packager.appInfo || {};
  return [info.productFilename, options.executableName, info.productName];
}

async function runHook(hook, context, { env = process.env, spawn = spawnSync, log = console.log } = {}) {
  const platform = context.electronPlatformName;
  const appOutDir = context.appOutDir;
  const name = vmpEnabled(env) ? packageName({ platform, appOutDir, names: candidateNames(context) }) : null;
  const plan = vmpPlan({ hook, platform, appOutDir, name, env });
  if (!plan.run) {
    log(`  • VMP signing skipped (${hook}): ${plan.reason}`);
    return plan;
  }
  if (plan.flipFuses) {
    const packager = context.packager;
    const fuses = packager.config && packager.config.electronFuses;
    if (fuses) await packager.addElectronFuses(context, await packager.generateFuseConfig(fuses));
  }
  log(`  • VMP signing ${name} with castLabs EVS (${hook})`);
  const result = spawn(plan.command, plan.args, { stdio: "inherit", env });
  if (result.error) {
    throw new Error(`vmp-sign: could not run ${plan.command} (${result.error.message}). Install the client: ${plan.command} -m pip install --upgrade castlabs-evs`);
  }
  if (result.status !== 0) {
    throw new Error(`vmp-sign: castLabs EVS refused or failed (exit ${result.status}). The client must be installed (${plan.command} -m pip install --upgrade castlabs-evs) and signed in (EVS_ACCOUNT_NAME / EVS_PASSWD, or once: ${plan.command} -m castlabs_evs.account reauth)`);
  }
  return plan;
}

const afterPack = (context) => runHook("afterPack", context);
const afterSign = (context) => runHook("afterSign", context);

function verifyCli(argv) {
  const dir = argv[0];
  if (!dir || !fs.existsSync(dir)) {
    console.error("usage: node scripts/vmp-sign.cjs --verify <unpacked dir> [name]");
    return 2;
  }
  const command = pythonCommand();
  const args = ["-m", "castlabs_evs.vmp", "--no-ask", "verify-pkg", ...(argv[1] ? ["--name-hint", argv[1]] : []), dir];
  const result = spawnSync(command, args, { stdio: "inherit" });
  if (result.error) {
    console.error(`vmp-sign: could not run ${command}: ${result.error.message}`);
    return 2;
  }
  return result.status === 0 ? 0 : 1;
}

if (require.main === module) {
  const argv = process.argv.slice(2);
  if (argv[0] === "--verify") process.exitCode = verifyCli(argv.slice(1));
  else {
    console.error("usage: node scripts/vmp-sign.cjs --verify <unpacked dir> [name]");
    process.exitCode = 2;
  }
}

module.exports = { afterPack, afterSign, packageName, pythonCommand, runHook, vmpEnabled, vmpPlan };
