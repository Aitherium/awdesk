"use strict";

/**
 * aw-cli.cjs -- the aw* CLIs from Alt+Space, the palette, the tray and the
 * right-click menu (owner 2026-11-02: "launcher/registry rows for the aw* CLIs").
 *
 * Each verb is ONE argv, run as the SYSTEM binary found on PATH (`where` on
 * Windows, `which` elsewhere) with execFile and no shell -- never Electron's own
 * executable as node, never `cmd /c` with typed text in it. A binary that
 * resolves to a .cmd/.bat shim is refused rather than run through a shell, so a
 * query can never become a command line. Every run is capped at 30 s and its
 * output is clipped for the orb's bubble.
 *
 * Read-only on purpose: recall, graph query, git state, recover listing and a
 * settings PULL. Nothing here commits, pushes, restores or deletes.
 */

const os = require("node:os");

const TIMEOUT_MS = 30000;
const OUTPUT_MAX = 1800;
const ARG_MAX = 400;

/**
 * verb -> how to run it. `needsArg` verbs open the bubble's field when called
 * with nothing typed; `argv(arg)` builds the argument list (arg already cleaned).
 */
const AW_VERBS = Object.freeze({
  "aw-recall": Object.freeze({
    bin: "awm", needsArg: true, title: "Memory",
    placeholder: "Recall from memory… (optionally start with tenant:user:project)",
    // awm derives its scope from the cwd's repo and REFUSES outside one, so a
    // leading `tenant:user:project` token is passed as --scope; AWM_SCOPE and
    // DESK_AW_CWD (a repo dir) are the standing alternatives.
    argv: (arg) => {
      const m = /^([\w.-]+:[\w.-]+:[\w.-]+)\s+(.+)$/.exec(arg);
      return m
        ? ["recall", "--scope", m[1], "--query", m[2], "--limit", "8"]
        : ["recall", "--query", arg, "--limit", "8"];
    },
  }),
  "aw-graph": Object.freeze({
    bin: "awgraph", needsArg: true, title: "Code graph",
    placeholder: "Query the code graph…",
    argv: (arg) => ["query", arg, "-k", "8"],
  }),
  "aw-git": Object.freeze({
    bin: "awgit", needsArg: false, title: "Git state",
    // `awgit state`: branch, worktree, stack, open PRs. An arg is the repo dir.
    argv: () => ["state"], cwdFromArg: true,
  }),
  "aw-recover": Object.freeze({
    bin: "awrecover", needsArg: true, title: "Snapshots",
    placeholder: "Snapshot store directory to list…",
    // Listing only: restore/drop stay a typed CLI decision.
    argv: (arg) => ["list", "--store", arg],
  }),
  "aw-settings": Object.freeze({
    bin: "awsettings", needsArg: false, title: "Settings sync",
    argv: () => ["--quiet", "pull"],
  }),
});

/** One line of typed text, no control characters, capped. */
function cleanArg(arg) {
  // eslint-disable-next-line no-control-regex -- stripping control characters is the point
  return String(arg == null ? "" : arg).replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, ARG_MAX);
}

/** Exactly what would run: {bin, args, cwd} or {error}. Pure. */
function plan(verb, arg, { home = process.env.DESK_AW_CWD || os.homedir() } = {}) {
  const spec = AW_VERBS[String(verb || "")];
  if (!spec) return { error: `unknown aw verb ${verb}` };
  const a = cleanArg(arg);
  if (spec.needsArg && !a) return { error: "needs-arg", spec };
  const cwd = spec.cwdFromArg && a ? a : home;
  return { bin: spec.bin, args: spec.needsArg ? spec.argv(a) : spec.argv(), cwd, title: spec.title };
}

/** The first PATH hit for `bin`, or null. Shims (.cmd/.bat/.ps1) are skipped. */
function resolveBin(bin, { execFile = require("node:child_process").execFile, platform = process.platform } = {}) {
  const finder = platform === "win32" ? "where" : "which";
  return new Promise((resolve) => {
    try {
      execFile(finder, [bin], { timeout: 5000, windowsHide: true }, (error, stdout) => {
        if (error) return resolve(null);
        const hits = String(stdout || "").split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
        const ok = hits.find((h) => !/\.(cmd|bat|ps1)$/i.test(h));
        resolve(ok || null);
      });
    } catch {
      resolve(null);
    }
  });
}

/** Clip output for the bubble: the head is what matters, so keep it. */
function clip(text) {
  // eslint-disable-next-line no-control-regex -- ANSI colour codes off the CLI
  const s = String(text || "").replace(/\r\n/g, "\n").replace(/\u001b\[[0-9;]*m/g, "").trim();
  return s.length > OUTPUT_MAX ? `${s.slice(0, OUTPUT_MAX - 1)}…` : s;
}

/**
 * Run one verb. Resolves {ok, text, code?, missing?, needsArg?}; never rejects.
 */
async function runAw(verb, arg, {
  execFile = require("node:child_process").execFile, platform = process.platform,
  timeoutMs = TIMEOUT_MS, home = process.env.DESK_AW_CWD || os.homedir(), resolve = null,
} = {}) {
  const p = plan(verb, arg, { home });
  if (p.error === "needs-arg") return { ok: false, needsArg: true, text: p.spec.placeholder };
  if (p.error) return { ok: false, text: p.error };
  const exe = await (resolve || ((b) => resolveBin(b, { execFile, platform })))(p.bin);
  if (!exe) return { ok: false, missing: true, text: `${p.bin} is not installed on this computer (not on PATH).` };
  return new Promise((done) => {
    try {
      execFile(exe, p.args, {
        cwd: p.cwd, timeout: timeoutMs, windowsHide: true, shell: false, maxBuffer: 1024 * 1024,
        env: { ...process.env, PYTHONIOENCODING: "utf-8", NO_COLOR: "1" },
      }, (error, stdout, stderr) => {
        const out = clip(stdout) || clip(stderr);
        if (error) {
          const timedOut = error.killed || error.signal === "SIGTERM" || error.code === "ETIMEDOUT";
          const why = timedOut ? `${p.bin} timed out after ${Math.round(timeoutMs / 1000)} s` : `${p.bin} failed (${error.code ?? "error"})`;
          return done({ ok: false, code: typeof error.code === "number" ? error.code : null, title: p.title, text: out ? `${why}\n${out}` : why });
        }
        done({ ok: true, code: 0, title: p.title, text: out || `${p.bin}: done (no output).` });
      });
    } catch (error) {
      done({ ok: false, title: p.title, text: `${p.bin} could not start: ${String((error && error.message) || error)}` });
    }
  });
}

module.exports = { AW_VERBS, TIMEOUT_MS, OUTPUT_MAX, plan, cleanArg, resolveBin, runAw, clip };
