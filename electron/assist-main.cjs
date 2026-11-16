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
const { createAssistPairing } = require("./assist-pairing.cjs");
const { loadOrCreateSalt } = require("./assist-salt.cjs");
const { createAssistIdentity } = require("./assist-identity.cjs");
const { createTools } = require("./assist-tools.cjs");

const SETTINGS_FILE = "assist.json";

function loadAgents() {
  try {
    const doc = JSON.parse(fs.readFileSync(path.join(__dirname, "agent-roster.generated.json"), "utf8"));
    return Array.isArray(doc.agents) ? doc.agents.filter((a) => typeof a === "string").slice(0, 200) : [];
  } catch { return []; }
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

function createAssistMain({ electron, userDataDir, gateway = null, notes = null, spawn, post, utilsOverride = null, filesOverride = null, pairingOverride = null, identityOverride = null, toolsOverride = null, saltOverride = null } = {}) {
  const settingsPath = path.join(userDataDir, SETTINGS_FILE);
  function getSettings() {
    try { return core.normalizeSettings(JSON.parse(fs.readFileSync(settingsPath, "utf8"))); } catch { return core.normalizeSettings({}); }
  }
  const llm = createAssistLlm({ getSettings, gateway, ...(post ? { post } : {}) });
  // Log hashes are HMAC under a per-install salt beside the pairing secret (assist-salt.cjs).
  // No salt (cannot be stored user-only) = no hashes in the log, never an unsalted one.
  const salt = saltOverride || loadOrCreateSalt({ dir: userDataDir });
  core.useLogSalt(salt.ok ? salt.salt : null);
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
  // Tools are found in known install dirs only (never PATH) and signature-checked before they run.
  const tools = toolsOverride || createTools({});
  const utils = utilsOverride || createAssistUtils({ clipboard: electron.clipboard, caret, log, getSettings, tools });
  // The Explorer verbs. Images are answered by the desk's vision ladder (MicroScheduler first).
  const files = filesOverride || createAssistFiles({
    engine, gateway, log, getSettings, findExe: (n) => tools.locate([`${n}.exe`], "converter"),
    verifyExe: async (n) => (await tools.resolve([`${n}.exe`], "converter")) || { ok: false, error: `${n} is not installed` },
    confirm: cardConfirm(gateway),
    vision: (p, q) => require("./orb-vision.cjs").askVision(p, q),
  });
  // The per-install bearer + the user-confirmed pairing (assist-pairing.cjs). The dialog is
  // native and shows the code the extension shows, so the owner can tell his browser's
  // request from a forged one.
  // The desk's own identity (assist-identity.cjs): pinned by the extension at pairing time.
  const identity = identityOverride || createAssistIdentity({ dir: userDataDir });
  const pairing = pairingOverride || createAssistPairing({
    dir: userDataDir,
    confirm: async ({ code }) => {
      const { dialog } = electron;
      if (!dialog || typeof dialog.showMessageBox !== "function") return false;
      const me = identity.info();
      if (!me.ok) return false; // a desk that cannot prove who it is does not pair
      const r = await dialog.showMessageBox({
        type: "question", buttons: ["Deny", "Allow"], defaultId: 0, cancelId: 0, noLink: true,
        title: "Pair AitherConnect with Aither",
        message: "AitherConnect wants to use Aither at the caret in your browser.",
        detail: `Your browser should be showing the code ${code}.\nThis desk's key: ${me.fingerprint}\n\nAllow only if the code matches. Allowing lets that browser send text you select or type to YOUR agents and models through this desk. You can revoke it by pairing again.`,
      });
      return r.response === 1;
    },
  });
  const win = createAssistWindow({ electron, engine, caret, agents: loadAgents(), utils, files });

  /** The registry's `assist:` field: "open" or a verb id. */
  function run(kind, meta = {}) {
    const verb = String(kind || "open");
    if (verb === "open") return win.open();
    // Explorer: `file:<verb>` plus the selected path (the shell menu's --arg).
    // ONLY from the shell menu: POST /commands/run (surface "bridge"), a palette row or a
    // second program must not be able to open a file verb on a path.
    if (verb.startsWith("file:")) {
      if (meta.surface !== "shell-menu") return Promise.resolve({ ok: false, error: "Explorer verbs run from the Explorer right-click menu." });
      return win.openFile({ path: meta.arg, verb: verb.slice(5) });
    }
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
  async function bridge({ route, body = {}, origin = "" }) {
    // Pairing steps (the bridge already checked the pinned origin): no bearer by design.
    if (route === "pair/start") return pairing.start(origin);
    // The extension challenges the desk before it sends the bearer or any text.
    if (route === "hello") return identity.hello(body && body.nonce);
    if (route === "pair/finish") {
      const me = identity.info();
      if (!me.ok) return { ok: false, status: 503, error: `This desk cannot prove its identity: ${me.error}` };
      const done = pairing.finish(body && body.id);
      return done.ok ? { ...done, deskKey: me.key, fingerprint: me.fingerprint } : done;
    }
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

  return { run, bridge, pairing, identity, tools, engine, window: win, caret, utils, files, log, getSettings, settingsPath };
}

module.exports = { createAssistMain, cardConfirm, SETTINGS_FILE };
