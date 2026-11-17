"use strict";

/**
 * share-detect.cjs -- "strangers seeing the desk on a share or stream = safe mode" (owner,
 * 2026-11-17). Windows gives an app no event for "someone is capturing the screen", so this
 * reads what IS observable: a process that exists only while the screen is going out.
 *
 *   obs64 / obs32 / obs           OBS Studio (streaming or recording -- either way, an audience)
 *   Streamlabs OBS / Streamlabs Desktop, XSplit.Core, PRISM Live Studio
 *   CptHost                       Zoom's screen-share host: it runs only WHILE sharing
 *
 * Not detectable this way, said plainly in the gallery: a Discord Go Live, a Teams or Meet share
 * (the app is the same process shared or not) -- for those the panic key is the switch.
 *
 * Pure `sharingFrom(names)`; `createShareWatch` polls `tasklist` and calls back on change.
 */

const { execFile } = require("node:child_process");

const SHARE_PROCESSES = Object.freeze([
  ["obs64.exe", "OBS"],
  ["obs32.exe", "OBS"],
  ["obs.exe", "OBS"],
  ["streamlabs obs.exe", "Streamlabs"],
  ["streamlabs desktop.exe", "Streamlabs"],
  ["xsplit.core.exe", "XSplit"],
  ["prismlivestudio.exe", "PRISM Live"],
  ["cpthost.exe", "Zoom screen share"],
]);
const NOT_DETECTABLE = Object.freeze(["Discord Go Live", "Teams / Meet screen share"]);

/** Which capture apps are running, from a list of process image names. [] when none. */
function sharingFrom(names) {
  const have = new Set((Array.isArray(names) ? names : []).map((n) => String(n || "").trim().toLowerCase()));
  const out = [];
  for (const [exe, label] of SHARE_PROCESSES) if (have.has(exe) && !out.includes(label)) out.push(label);
  return out;
}

/** Image names from `tasklist /fo csv /nh` output. */
function parseTasklist(text) {
  const out = [];
  for (const line of String(text || "").split(/\r?\n/)) {
    const m = /^"([^"]+)"/.exec(line.trim());
    if (m) out.push(m[1]);
  }
  return out;
}

function listProcesses() {
  return new Promise((resolve) => {
    if (process.platform !== "win32") return resolve([]);
    execFile("tasklist", ["/fo", "csv", "/nh"], { windowsHide: true, timeout: 5000, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => {
      resolve(err ? null : parseTasklist(stdout));
    });
  });
}

/**
 * Poll every `intervalMs`; `onChange(labels)` fires when the set of capture apps changes
 * (including to []). A failed poll changes nothing (never flips safe mode off by accident).
 */
function createShareWatch({ onChange, onStatus, intervalMs = 4000, list = listProcesses } = {}) {
  let last = null;
  let timer = null;
  let busy = false;
  let failures = 0;
  let status = "starting";
  const setStatus = (next) => {
    if (next === status) return;
    status = next;
    if (typeof onStatus === "function") onStatus(next);
  };
  const tick = async () => {
    if (busy) return;
    busy = true;
    try {
      const names = await list();
      // Never silent (review of #122): three failed polls in a row = "unavailable", which the
      // gallery shows -- a share cannot be detected and the panic key is the only switch.
      if (!Array.isArray(names)) {
        failures += 1;
        if (failures >= 3) setStatus("unavailable");
        return;
      }
      failures = 0;
      setStatus("watching");
      const now = sharingFrom(names);
      const key = now.join(",");
      if (key !== last) {
        last = key;
        if (typeof onChange === "function") onChange(now);
      }
    } finally {
      busy = false;
    }
  };
  return {
    start() {
      if (timer) return;
      void tick();
      timer = setInterval(tick, intervalMs);
      if (typeof timer.unref === "function") timer.unref();
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
    },
    tick,
    current: () => (last ? last.split(",").filter(Boolean) : []),
    status: () => status,
  };
}

module.exports = { SHARE_PROCESSES, NOT_DETECTABLE, sharingFrom, parseTasklist, createShareWatch };
