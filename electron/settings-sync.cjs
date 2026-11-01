"use strict";

/**
 * settings-sync — cast.json follows the owner to the next machine, by itself.
 *
 * `awsettings --domain desk pull|push` already does the whole job from a shell.
 * This module is only the part that remembers to run it: a PULL when the desk
 * starts (a new machine is stale before its first line is spoken), and a
 * debounced PUSH when cast.json changes (a fader moved here is on its way to the
 * others before the owner has finished the thought).
 *
 * IT SHELLS OUT, AND THAT IS THE DESIGN. The merge rules -- fields merge leaf by
 * leaf, `voice.endpoint` stays home in both directions, a key the server dropped
 * is reported by path -- live in ONE engine. A second implementation in
 * JavaScript would be a second place for the next bug, and the first time these
 * rules were implemented twice, one copy had a hole the other had already fixed.
 *
 * DEFAULT ON ONCE THE DESK HAS A MEMBER IDENTITY (~/.aither/member.json, written by
 * device-identity.cjs after enroll-self): the member's hub + bearer file + a per-member
 * namespace. Without one it is OFF, and either way cast.json's own `sync` section
 * decides (`"enabled": false` stays off) -- the section the sync
 * tool never sends and refuses on arrival, because `profile` and `tokenFile` are
 * paths on THIS machine:
 *
 *   "sync": { "enabled": true, "profile": "D:/Dropbox/awsettings.json" }
 *   "sync": { "enabled": true, "url": "https://…/api/settings/preferences",
 *             "tokenFile": "C:/Users/me/.aither/session-bearer" }
 *
 * FAILURE IS A RENDERED STATE, NEVER A BLOCKER. Offline is the normal state of a
 * laptop: every outcome resolves to a status row the Cast pane shows, nothing
 * here throws, and nothing here can delay or fail the desk's launch.
 *
 * NO LOOP BY CONSTRUCTION: a push never writes cast.json, so the change watcher
 * cannot re-arm itself. A pull that changed the file does trigger one push of the
 * merged result, which is convergent (the other side already holds it).
 */

const { spawn } = require("node:child_process");
const fs = require("node:fs");

const DEFAULT_DEBOUNCE_MS = 4000;
const DEFAULT_TIMEOUT_MS = 45000;
const WATCH_INTERVAL_MS = 2000;
const OUTPUT_LIMIT = 600;
/** The member settings hub a joined desk syncs with when cast.json names none. */
const MEMBER_SYNC_URL = "https://api.aitherium.com/api/v1/settings";

/** The joined member, or null -- device-identity.cjs writes it after enroll-self. */
function defaultMember() {
  try {
    return require("./device-identity.cjs").loadMember();
  } catch {
    return null;
  }
}

/** awsettings' own exit contract, in words the pane can show. */
const VERDICTS = Object.freeze({
  0: "in step",
  1: "refused — the server kept less than it was sent",
  2: "could not reach the profile",
});

/**
 * plan — PURE. What would run, or why nothing will. Exported so the rule that
 * decides whether the owner's settings leave this machine is testable without a
 * child process.
 */
function plan(settings, castFile, member = null) {
  const own = (settings && settings.sync) || {};
  // DEFAULT ON once this desk has a workspace member identity (joined through
  // device-identity.cjs): the member's own hub, the member's own bearer FILE, and a
  // per-member namespace (AWSETTINGS_MEMBER). cast.json's sync section still wins:
  // `"enabled": false` turns it off, an explicit profile/url replaces the default.
  const memberOn = Boolean(member && member.user_id) && own.enabled !== false;
  const sync = memberOn && !own.profile && !own.url
    ? { ...own, enabled: true, url: MEMBER_SYNC_URL, tokenFile: member.token_file || own.tokenFile }
    : (memberOn ? { ...own, enabled: true } : own);
  if (sync.enabled !== true) return { enabled: false, reason: "sync.enabled is off" };
  if (!sync.profile && !sync.url) {
    return { enabled: false, reason: "sync is on but names neither sync.profile nor sync.url" };
  }
  const env = { AWSETTINGS_DESK_FILE: String(castFile) };
  // A URL wins, exactly as it does in the CLI's own resolver; the file is the
  // no-account path and is what makes this usable with nothing but a synced folder.
  if (sync.url) {
    env.AWSETTINGS_URL = String(sync.url);
    // The bearer is NEVER read here. Its PATH is handed over and the CLI opens
    // it: this process, its logs and its crash dumps never hold the credential.
    if (sync.tokenFile) env.AWSETTINGS_TOKEN_FILE = String(sync.tokenFile);
  } else {
    env.AWSETTINGS_PROFILE = String(sync.profile);
  }
  if (member && member.user_id) env.AWSETTINGS_MEMBER = String(member.user_id);
  return {
    enabled: true,
    env,
    target: sync.url ? `url ${sync.url}` : `file ${sync.profile}`,
    pullOnStart: sync.pullOnStart !== false,
    pushOnChange: sync.pushOnChange !== false,
  };
}

/** The launch candidates, in order. The console script first; `python -m` second,
 *  because a desk started from a Startup shim often has a shorter PATH than the
 *  shell the owner installed the tool from. */
const LAUNCHERS = Object.freeze([
  { cmd: "awsettings", pre: [] },
  { cmd: "python", pre: ["-m", "awsettings.cli"] },
]);

function createSettingsSync({
  castFile,
  settings,
  spawnImpl = spawn,
  log = () => {},
  debounceMs = DEFAULT_DEBOUNCE_MS,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  watchFile = fs.watchFile,
  unwatchFile = fs.unwatchFile,
  now = () => new Date().toISOString(),
  member = defaultMember,
} = {}) {
  const getMember = typeof member === "function" ? member : () => member;
  const getFile = typeof castFile === "function" ? castFile : () => castFile;
  const getSettings = typeof settings === "function" ? settings : () => settings;
  const state = { pull: null, push: null, watching: false, reason: null, target: null };
  let timer = null;
  let running = Promise.resolve();
  let watched = null;

  function spawnOnce(launcher, args, env) {
    return new Promise((resolve) => {
      let child;
      let output = "";
      let settled = false;
      const done = (result) => {
        if (settled) return;
        settled = true;
        resolve(result);
      };
      try {
        child = spawnImpl(launcher.cmd, [...launcher.pre, ...args], {
          env: { ...process.env, ...env },
          windowsHide: true,
          stdio: ["ignore", "pipe", "pipe"],
        });
      } catch (error) {
        return done({ missing: true, error: String(error && error.message ? error.message : error) });
      }
      const kill = setTimeout(() => {
        try { child.kill(); } catch { /* already gone */ }
        done({ code: 2, output: `${output}\ntimed out after ${timeoutMs} ms`.trim() });
      }, timeoutMs);
      const collect = (chunk) => { if (output.length < OUTPUT_LIMIT) output += String(chunk); };
      if (child.stdout) child.stdout.on("data", collect);
      if (child.stderr) child.stderr.on("data", collect);
      child.on("error", (error) => {
        clearTimeout(kill);
        done({ missing: error && error.code === "ENOENT", error: String(error && error.message ? error.message : error) });
      });
      child.on("close", (code) => {
        clearTimeout(kill);
        done({ code: typeof code === "number" ? code : 2, output: output.trim().slice(0, OUTPUT_LIMIT) });
      });
    });
  }

  async function run(verb) {
    const planned = plan(getSettings(), getFile(), getMember());
    state.target = planned.target || null;
    if (!planned.enabled) {
      state.reason = planned.reason;
      return { ok: false, skipped: true, verb, reason: planned.reason };
    }
    state.reason = null;
    const args = ["--domain", "desk", "--quiet", verb];
    let last = null;
    for (const launcher of LAUNCHERS) {
      last = await spawnOnce(launcher, args, planned.env);
      if (!last.missing) break;
    }
    const result = last && !last.missing
      ? { ok: last.code === 0, verb, code: last.code, verdict: VERDICTS[last.code] || `exit ${last.code}`, output: last.output, at: now() }
      : { ok: false, verb, code: null, verdict: "awsettings is not installed (pip install awsettings)", output: (last && last.error) || "", at: now() };
    state[verb] = result;
    log(`[settings-sync] ${verb}: ${result.verdict}${result.output ? ` — ${result.output.split("\n")[0]}` : ""}`);
    return result;
  }

  /** Serialised: a push must never overlap the pull that is rewriting the file. */
  function enqueue(verb) {
    const next = running.then(() => run(verb), () => run(verb));
    running = next.catch(() => {});
    return next;
  }

  function schedulePush() {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      const planned = plan(getSettings(), getFile(), getMember());
      if (planned.enabled && planned.pushOnChange) void enqueue("push");
    }, debounceMs);
    if (timer && typeof timer.unref === "function") timer.unref();
  }

  function start() {
    const file = getFile();
    const planned = plan(getSettings(), file, getMember());
    state.target = planned.target || null;
    state.reason = planned.enabled ? null : planned.reason;
    // Watch even while sync is OFF: turning it on in the pane is itself a change
    // to this file, and that is the moment the first push should happen.
    if (!state.watching) {
      watched = file;
      watchFile(file, { interval: WATCH_INTERVAL_MS, persistent: false }, (curr, prev) => {
        if (curr.mtimeMs !== prev.mtimeMs) schedulePush();
      });
      state.watching = true;
    }
    if (planned.enabled && planned.pullOnStart) return enqueue("pull");
    return Promise.resolve({ ok: false, skipped: true, verb: "pull", reason: state.reason || "pullOnStart is off" });
  }

  function stop() {
    if (timer) clearTimeout(timer);
    timer = null;
    if (state.watching && watched) {
      try { unwatchFile(watched); } catch { /* best effort */ }
    }
    state.watching = false;
  }

  function status() {
    const planned = plan(getSettings(), getFile(), getMember());
    return {
      enabled: planned.enabled,
      reason: planned.enabled ? null : planned.reason,
      target: planned.target || null,
      pull: state.pull,
      push: state.push,
    };
  }

  return { start, stop, status, pullNow: () => enqueue("pull"), pushNow: () => enqueue("push"), schedulePush };
}

module.exports = { createSettingsSync, plan, VERDICTS, MEMBER_SYNC_URL };
