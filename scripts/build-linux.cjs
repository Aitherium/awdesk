"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const PROJECT_ROOT = path.join(__dirname, "..");
const BUILDER = path.join(PROJECT_ROOT, "node_modules", ".bin", "electron-builder");

function linuxPackagingCommand({
  nixos = fs.existsSync("/etc/NIXOS") || process.env.NIX_STORE === "/nix/store",
} = {}) {
  const builderArguments = [BUILDER, "--linux", "AppImage", "deb", "--publish", "never"];
  if (nixos) {
    return {
      command: "nix",
      args: [
        "shell",
        "nixpkgs#fpm",
        "-c",
        "env",
        "USE_SYSTEM_FPM=true",
        ...builderArguments,
      ],
    };
  }
  return {
    command: BUILDER,
    args: builderArguments.slice(1),
  };
}

function buildLinux(options) {
  if (process.platform !== "linux") {
    throw new Error("Linux packages must be built on Linux.");
  }
  const invocation = linuxPackagingCommand(options);
  const result = spawnSync(invocation.command, invocation.args, {
    cwd: PROJECT_ROOT,
    encoding: "utf8",
    stdio: "inherit",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`Linux packaging failed with exit code ${result.status}.`);
  }
}

if (require.main === module) {
  try {
    buildLinux();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

module.exports = { buildLinux, linuxPackagingCommand };
