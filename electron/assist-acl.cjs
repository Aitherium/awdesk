"use strict";

/**
 * assist-acl.cjs -- "this file is readable by the current user only", shared by every
 * secret the assist stack keeps in userData (the pairing bearer, the log salt, the desk
 * identity key).
 *
 * Windows: icacls removes inheritance and grants only DOMAIN\USER. Elsewhere: chmod 600.
 * Never throws; a caller that stores a secret MUST treat { ok:false } as "do not use it".
 * The tool path is absolute (System32), never a PATH lookup.
 */

const fs = require("node:fs");
const path = require("node:path");

function userName(env) {
  return env.USERNAME ? `${env.USERDOMAIN ? `${env.USERDOMAIN}\\` : ""}${env.USERNAME}` : "";
}

function icaclsCall(file, env) {
  const user = userName(env);
  if (!user) return null;
  return { exe: path.win32.join(env.SystemRoot || "C:\\Windows", "System32", "icacls.exe"), args: [file, "/inheritance:r", "/grant:r", `${user}:(F)`] };
}

/** Async: used where a callback is already in flight (pairing). */
function lockFile({ file, fsImpl = fs, execFile = require("node:child_process").execFile, platform = process.platform, env = process.env } = {}) {
  return new Promise((resolve) => {
    if (platform !== "win32") { try { fsImpl.chmodSync(file, 0o600); } catch { /* best effort off Windows */ } resolve({ ok: true }); return; }
    const call = icaclsCall(file, env);
    if (!call) { resolve({ ok: false, error: "no current user name" }); return; }
    try {
      execFile(call.exe, call.args, { windowsHide: true, timeout: 10000 }, (error) => resolve(error ? { ok: false, error: String(error.message || error) } : { ok: true }));
    } catch (error) { resolve({ ok: false, error: String((error && error.message) || error) }); }
  });
}

/** Sync: used at start-up, where the next line needs the secret (salt, identity key). */
function lockFileSync({ file, fsImpl = fs, execFileSync = require("node:child_process").execFileSync, platform = process.platform, env = process.env } = {}) {
  if (platform !== "win32") { try { fsImpl.chmodSync(file, 0o600); } catch { /* best effort off Windows */ } return { ok: true }; }
  const call = icaclsCall(file, env);
  if (!call) return { ok: false, error: "no current user name" };
  try {
    execFileSync(call.exe, call.args, { windowsHide: true, timeout: 10000, stdio: "ignore" });
    return { ok: true };
  } catch (error) { return { ok: false, error: String((error && error.message) || error) }; }
}

module.exports = { lockFile, lockFileSync, userName };
