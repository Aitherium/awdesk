"use strict";

/**
 * fairy-owner.cjs -- ONE fairy cluster per machine (owner, 2026-11-13: "two fairy
 * clusters on screen at once ... one cluster only, ever").
 *
 * The single-instance lock lives in the profile (userData), so a second desk started
 * with another profile -- a test build, `--user-data-dir`, a second install -- is a
 * second process with its own fairy. Measured 2026-11-13: a verification build run
 * beside the owner's desk drew a second cluster with the same "31" badge.
 *
 * So the fairies belong to ONE process per user: `~/.aither/desk-fairy-owner.json`
 * {pid, at}. The first desk to show its fairy claims it; a live other pid refuses
 * the claim; a dead pid (a crash, a restart) is taken over. Release on quit.
 *
 * DESK_FAIRY_OWNER_FILE overrides the path (tests). Never mkdir recursive (Defender
 * controlled folder access spins forever on it): one level, and a failure to write
 * never blocks the fairy -- the lock is a guard against two, not a gate on one.
 */

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

function ownerFile() {
  if (process.env.DESK_FAIRY_OWNER_FILE) return String(process.env.DESK_FAIRY_OWNER_FILE);
  return path.join(os.homedir(), ".aither", "desk-fairy-owner.json");
}

/** Is `pid` a running process? A permission error still means it runs. */
function alive(pid) {
  const n = Number(pid);
  if (!Number.isInteger(n) || n <= 0) return false;
  try {
    process.kill(n, 0);
    return true;
  } catch (error) {
    return Boolean(error && error.code === "EPERM");
  }
}

function read() {
  try {
    const raw = JSON.parse(fs.readFileSync(ownerFile(), "utf8"));
    return raw && typeof raw === "object" ? raw : null;
  } catch {
    return null;
  }
}

/**
 * Claim the fairies for this process.
 *
 * Returns {ok:true} when this process owns them (now or already), or
 * {ok:false, pid} when another live process does.
 */
function claim({ pid = process.pid, isAlive = alive } = {}) {
  const cur = read();
  if (cur && Number(cur.pid) !== pid && isAlive(cur.pid)) return { ok: false, pid: Number(cur.pid) };
  if (cur && Number(cur.pid) === pid) return { ok: true, pid };
  try {
    const file = ownerFile();
    try { fs.mkdirSync(path.dirname(file)); } catch { /* exists, or not ours to make */ }
    fs.writeFileSync(file, JSON.stringify({ pid, at: new Date().toISOString() }));
  } catch { /* cannot write: the guard is off, the fairy is not */ }
  return { ok: true, pid };
}

/** Let go, only if this process holds it. */
function release({ pid = process.pid } = {}) {
  const cur = read();
  if (!cur || Number(cur.pid) !== pid) return false;
  try { fs.rmSync(ownerFile(), { force: true }); } catch { return false; }
  return true;
}

module.exports = { ownerFile, alive, claim, release };
