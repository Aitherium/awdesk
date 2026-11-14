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

/** When this machine booted (ms epoch). A claim older than that is from before a reboot:
 *  Windows does not run before-quit at logoff or shutdown, and a pid is reused. */
function bootedAt() {
  return Date.now() - os.uptime() * 1000;
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
function claim({ pid = process.pid, isAlive = alive, booted = bootedAt() } = {}) {
  const cur = read();
  const fromThisBoot = cur && Date.parse(String(cur.at || "")) >= booted - 60_000;
  if (cur && Number(cur.pid) !== pid && fromThisBoot && isAlive(cur.pid)) return { ok: false, pid: Number(cur.pid) };
  if (cur && Number(cur.pid) === pid) return { ok: true, pid };
  const body = JSON.stringify({ pid, at: new Date().toISOString() });
  const file = ownerFile();
  try { fs.mkdirSync(path.dirname(file)); } catch { /* exists, or not ours to make */ }
  try {
    // No file: create it exclusively, so two desks starting together cannot both win.
    if (!cur) {
      try {
        fs.writeFileSync(file, body, { flag: "wx" });
      } catch (error) {
        if (error && error.code === "EEXIST") {
          const now = read();
          if (now && Number(now.pid) !== pid && isAlive(now.pid)) return { ok: false, pid: Number(now.pid) };
        }
        fs.writeFileSync(file, body);
      }
    } else {
      const tmp = `${file}.${pid}.tmp`;
      fs.writeFileSync(tmp, body);
      fs.renameSync(tmp, file);
    }
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

// A normal exit lets go even when before-quit never ran (a crash or a logoff leaves the
// file, which the boot-time check and the pid check retire).
process.once("exit", () => { try { release(); } catch { /* exiting */ } });

module.exports = { ownerFile, alive, bootedAt, claim, release };
