"use strict";

/**
 * assist-main.cjs -- wires the assist modules into the desk with ONE call, so main.cjs
 * carries a require, a case and a bridge handler instead of a second menu system.
 *
 *   createAssistMain({electron, userDataDir, gateway, notes, utils, files})
 *     -> { run(id, arg), bridge(req), engine, window }
 *
 * `run` is what main's runCommand calls for the registry's `assist.*` rows (command-
 * registry.cjs `assist:` field). `bridge` is the loopback handler for the browser overlay
 * (AitherConnect): POST /assist/suggest | /assist/run | /assist/route | /assist/note, the
 * same engine, so a browser action and a desk action are the same verb with the same log.
 */

const fs = require("node:fs");
const path = require("node:path");
const core = require("./assist-core.cjs");
const { createAssistLlm } = require("./assist-llm.cjs");
const { createAssistLog } = require("./assist-log.cjs");
const { createAssistEngine } = require("./assist-engine.cjs");
const { createCaret } = require("./assist-caret.cjs");
const { createAssistWindow } = require("./assist-window.cjs");
const { createAssistUtils } = require("./assist-utils.cjs");
const { createAssistFiles } = require("./assist-files.cjs");

const SETTINGS_FILE = "assist.json";

function loadAgents() {
  try {
    const doc = JSON.parse(fs.readFileSync(path.join(__dirname, "agent-roster.generated.json"), "utf8"));
    return Array.isArray(doc.agents) ? doc.agents.filter((a) => typeof a === "string").slice(0, 200) : [];
  } catch { return []; }
}

/** First hit of `name`(.exe) on PATH or a few usual install dirs: the converters the owner installed. */
function findExeOnPath(name, env = process.env) {
  const dirs = String(env.PATH || env.Path || "").split(path.delimiter).filter(Boolean);
  for (const extra of [env.ProgramFiles && path.join(env.ProgramFiles, "ImageMagick-7"), env.ProgramFiles && path.join(env.ProgramFiles, "ffmpeg", "bin"), env.LOCALAPPDATA && path.join(env.LOCALAPPDATA, "Microsoft", "WinGet", "Links"), env.LOCALAPPDATA && path.join(env.LOCALAPPDATA, "Pandoc")]) if (extra) dirs.push(extra);
  for (const dir of dirs) {
    const candidate = path.join(dir, `${name}.exe`);
    try { if (fs.existsSync(candidate)) return candidate; } catch { /* unreadable */ }
  }
  return null;
}

/**
 * The owner's answer to a bulk action, through the decision-card path (gateway
 * `decisions_raise`, which waits). No gateway, no card, an unreadable or missing answer, or
 * a timeout all return null: silence is never a yes.
 */
function cardConfirm(gateway) {
  return async ({ title, summary, facts, options }) => {
    if (!gateway || typeof gateway.callTool !== "function") return null;
    try {
      const res = await gateway.callTool("decisions_raise", { title, summary, facts, options, kind: "approval", urgency: "normal", agent: "aither", wait_seconds: 300 });
      const text = res && res.content && res.content[0] && res.content[0].text ? String(res.content[0].text) : "";
      let answer = "";
      try { const doc = JSON.parse(text); answer = String(doc.answer || doc.choice || doc.option || doc.response || ""); } catch { answer = ""; }
      return options.find((o) => o === answer) || null;
    } catch { return null; }
  };
}

function createAssistMain({ electron, userDataDir, gateway = null, notes = null, spawn, post, utilsOverride = null, filesOverride = null } = {}) {
  const settingsPath = path.join(userDataDir, SETTINGS_FILE);
  function getSettings() {
    try { return core.normalizeSettings(JSON.parse(fs.readFileSync(settingsPath, "utf8"))); } catch { return core.normalizeSettings({}); }
  }
  const llm = createAssistLlm({ getSettings, gateway, ...(post ? { post } : {}) });
  const log = createAssistLog({ dir: userDataDir });
  const engine = createAssistEngine({
    llm, log, getSettings,
    saveNote: notes ? async ({ text, title }) => {
      const made = await notes.createNote({ text, title: title ? `Aither: ${String(title).slice(0, 60)}` : "Aither note" });
      return made && made.ok !== false ? { ok: true, text: "" } : { ok: false, error: (made && made.reason) || "could not create a note" };
    } : null,
  });
  const caret = createCaret({ ...(spawn ? { spawn } : {}) });
  // The PowerToys / Sysinternals utilities: they drive the tools the owner installed.
  const utils = utilsOverride || createAssistUtils({ clipboard: electron.clipboard, caret, log, getSettings });
  // The Explorer verbs. Images are answered by the desk's vision ladder (MicroScheduler first).
  const files = filesOverride || createAssistFiles({
    engine, gateway, log, getSettings, findExe: (n) => findExeOnPath(n), confirm: cardConfirm(gateway),
    vision: (p, q) => require("./orb-vision.cjs").askVision(p, q),
  });
  const win = createAssistWindow({ electron, engine, caret, agents: loadAgents(), utils, files });

  /** The registry's `assist:` field: "open" or a verb id. */
  function run(kind, meta = {}) {
    const verb = String(kind || "open");
    if (verb === "open") return win.open();
    // Explorer: `file:<verb>` plus the selected path (the shell menu's --arg).
    if (verb.startsWith("file:")) return win.openFile({ path: meta.arg, verb: verb.slice(5) });
    if (core.verbById(verb)) return win.open({ verb });
    return Promise.resolve({ ok: false, error: `unknown assist command ${verb}` });
  }

  /**
   * Browser overlay -> desk. The overlay sends the context it captured IN THE PAGE (the
   * user's own gesture); the engine normalizes, refuses password fields, logs and calls the
   * model. `surface` is forced to "browser": the page cannot claim to be the desk.
   */
  const stamps = [];
  /** A runaway page script must not drain the owner's model budget: 30 bridge calls a minute. */
  function limited() {
    const t = Date.now();
    while (stamps.length && t - stamps[0] > 60000) stamps.shift();
    if (stamps.length >= 30) return true;
    stamps.push(t);
    return false;
  }
  async function bridge({ route, body = {} }) {
    if (limited()) return { ok: false, status: 429, error: "Too many assist requests this minute. Wait a moment." };
    const b = body && typeof body === "object" ? body : {};
    const ctx = { ...(b.ctx && typeof b.ctx === "object" ? b.ctx : {}), surface: "browser" };
    if (route === "suggest") {
      const s = engine.suggest(ctx, { surface: "browser" });
      return { ok: s.ok, refused: s.refused || false, error: s.error, chips: s.chips, send: s.send, canRefine: Boolean(s.refine) };
    }
    if (route === "refine") {
      const s = engine.suggest(ctx, { surface: "browser" });
      return { ok: true, chips: s.refine ? await s.refine() : [] };
    }
    if (route === "run") return engine.run({ verb: String(b.verb || "write"), ctx, prompt: String(b.prompt || "").slice(0, core.MAX_PROMPT), arg: String(b.arg || "").slice(0, 40), surface: "browser", retryOf: b.retryOf ? String(b.retryOf).slice(0, 40) : null });
    if (route === "route") return engine.route({ verb: String(b.verb || ""), ctx, agent: String(b.agent || ""), name: String(b.name || "").slice(0, 120), surface: "browser" });
    if (route === "note") return engine.note(String(b.outcome || ""), { id: String(b.id || "").slice(0, 40), verb: String(b.verb || ""), surface: "browser", ctx, text: typeof b.text === "string" ? b.text.slice(0, 20000) : undefined });
    return { ok: false, error: "unknown assist route" };
  }

  return { run, bridge, engine, window: win, caret, utils, files, log, getSettings, settingsPath };
}

module.exports = { createAssistMain, findExeOnPath, cardConfirm, SETTINGS_FILE };
