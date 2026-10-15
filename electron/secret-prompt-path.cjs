"use strict";

/**
 * Which secret_prompt.py the desk's credential row pipes a typed value into.
 *
 * Order: AWDESK_SECRET_PROMPT_SCRIPT, then a walk up from the app tree, then the
 * default checkout. A candidate must SPEAK the stdin door (`--value-stdin`), not
 * merely exist. Measured 2026-10-07: the default checkout carried a two-day-old
 * copy without it, the walk returned that copy because it existed, and every
 * "Store in vault" press died with "unrecognized arguments: --value-stdin" while
 * the owner's secret never landed. Stale copies are skipped; when every copy is
 * stale the first one comes back with `stale: true` so the row names the file to
 * update instead of surfacing an argparse error.
 *
 * 2026-10-15: speaking `--value-stdin` is no longer enough. A loose
 * D:\AitherOS\scripts\secret_prompt.py from 10-07 had the flag, wrote the
 * vault, could not close the card, printed "NOT closed" and exited 0. A copy
 * must now carry `DESK_DOOR_PROTOCOL = <n>` with n >= DESK_DOOR_PROTOCOL here:
 * the version of the contract "exit 0 means the card was closed with a receipt".
 */

const nodeFs = require("node:fs");
const nodePath = require("node:path");

const DEFAULT_SCRIPT = "C:\\AitherOS-Fresh\\AitherOS\\scripts\\secret_prompt.py";
const REL = ["AitherOS", "scripts", "secret_prompt.py"];
const DESK_DOOR_PROTOCOL = 2;
const MARKER = /^DESK_DOOR_PROTOCOL\s*(?::\s*int\s*)?=\s*(\d+)\s*$/m;

/** The door protocol a script declares, or 0 when it declares none. */
function doorProtocol(file, fs = nodeFs) {
  try {
    const m = MARKER.exec(fs.readFileSync(file, "utf8"));
    return m ? Number(m[1]) : 0;
  } catch { return 0; }
}

/** Does this copy speak the desk door the desk expects? */
function speaksStdin(file, fs = nodeFs) {
  return doorProtocol(file, fs) >= DESK_DOOR_PROTOCOL;
}

function resolveSecretPromptScript({
  startDir, env = process.env, fs = nodeFs, path = nodePath, fallback = DEFAULT_SCRIPT,
} = {}) {
  const override = String((env && env.AWDESK_SECRET_PROMPT_SCRIPT) || "").trim();
  if (override) return { path: override, stale: false };
  const candidates = [];
  let dir = startDir;
  for (let i = 0; dir && i < 6; i += 1) {
    candidates.push(path.join(dir, ...REL));
    const up = path.dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  candidates.push(fallback);
  let firstExisting = "";
  for (const candidate of candidates) {
    try {
      if (!fs.existsSync(candidate)) continue;
    } catch { continue; }
    if (speaksStdin(candidate, fs)) return { path: candidate, stale: false };
    if (!firstExisting) firstExisting = candidate;
  }
  if (firstExisting) return { path: firstExisting, stale: true };
  return { path: fallback, stale: false };
}

module.exports = { resolveSecretPromptScript, speaksStdin, doorProtocol, DESK_DOOR_PROTOCOL, DEFAULT_SCRIPT };
