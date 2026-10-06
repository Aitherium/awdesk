"use strict";

/**
 * decision-cards — Desk's window onto the decision-card plane.
 *
 * Desk is the surface that is ALWAYS on the owner's screen, which makes it the
 * right carrier for "a card is waiting on you": tray badge, native notification,
 * and one click into the queue window. Until 2026-08-25 nothing joined the two —
 * cards piled up in ~/.aither/decisions while every Desk surface stayed silent.
 *
 * READ side: the store directory directly. Same box, plain JSON files, and a
 * directory-signature fast path so polling costs two stats, not a full parse.
 *
 * WRITE side: deliberately NOT here. Answering a card must also deliver the
 * answer into the raising session's steer mailbox; that logic lives in the awask
 * store and re-implementing it in JS would be a rival store that drifts
 * (the DCS001 class). Desk opens the queue window (`awask window`) and the
 * owner answers there — one implementation, every surface.
 */

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn, execFileSync } = require("node:child_process");

/**
 * The ABSOLUTE path to the awask binary, resolved once. Spawning a bare
 * "awask" inherits this process's PATH; an app launched from a context whose
 * PATH lacks the Python Scripts dir gets a shell that says "not recognized"
 * on a hidden console — and the spawn has already reported success, so an
 * answer that never ran reads as delivered (the silent no-op class). An
 * absolute path removes the PATH dependency; the close code reports the rest.
 */
let _awaskBin = null;
function awaskBin() {
  if (_awaskBin !== null) return _awaskBin;
  try {
    const where = process.platform === "win32" ? "where.exe" : "which";
    const out = execFileSync(where, ["awask"], { encoding: "utf8" });
    const first = out.split(/\r?\n/).map((l) => l.trim()).find(Boolean);
    _awaskBin = first || "awask";
  } catch {
    _awaskBin = "awask";
  }
  return _awaskBin;
}

function storeDir() {
  const env = (process.env.AITHER_DECISIONS_DIR || "").trim();
  return env || path.join(os.homedir(), ".aither", "decisions");
}

function isCardFile(name) {
  return name.startsWith("d-") && name.endsWith(".json");
}

/**
 * Cheap change token: "count:newestMtimeNs:totalBytes". Mirrors
 * awask.store.DecisionStore.signature() — the two must agree that "changed"
 * means a file was written, created or removed. An unreadable directory yields
 * a token no real directory produces, so the caller re-lists rather than
 * treating silence as "no change".
 */
function signature(dir = storeDir()) {
  let count = 0;
  let newest = 0n;
  let total = 0;
  let entries;
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return "unreadable";
  }
  for (const name of entries) {
    if (!isCardFile(name)) continue;
    let info;
    try {
      info = fs.statSync(path.join(dir, name), { bigint: true });
    } catch {
      continue;
    }
    count += 1;
    total += Number(info.size);
    if (info.mtimeNs > newest) newest = info.mtimeNs;
  }
  return `${count}:${newest}:${total}`;
}

/** One stored card → the shape every desk surface reads, or null when it is not an open card. */
function cardFromRaw(raw) {
if (!raw || typeof raw !== "object" || raw.status !== "open") return null;
if (typeof raw.id !== "string" || raw.id.length === 0) return null;
  const source = raw.source && typeof raw.source === "object" ? raw.source : {};
  const kind = typeof raw.kind === "string" ? raw.kind : "decision";
  // A credential card asks the owner for a secret. The VALUE never travels on
  // this feed — the desk's masked field hands it to main, which pipes it into
  // the vault write and forgets it — but the desk must know WHICH key the card
  // wants, WHY, and into WHICH store, or its only options are the standalone
  // Tk dialog (the separate dialogue the owner vetoed, 2026-10-05) or nothing.
  // Carried for credential cards ONLY: on any other kind these fields do not
  // exist, and rendering them would be inventing an ask.
  const credential = String(kind).toLowerCase() === "credential";
  // The card's OWN answer choices, so a desk surface can offer exactly what
  // the raiser defined (a waiting notice is ack/later; a product decision may
  // be three options) instead of hardcoding buttons that do not exist on the
  // card. `defaultKey` is the raiser's "I recommend this one" hint.
  const options = Array.isArray(raw.options)
    ? raw.options
        .filter((o) => o && typeof o === "object" && typeof o.key === "string")
        .map((o) => ({
          key: o.key,
          label: typeof o.label === "string" ? o.label : o.key,
          // WHAT THE BUTTON DOES. A card recipe (awask.card_recipes) turns the
          // answer into an ACTION — "Disable this wake" runs
          // `awrise disable --name <job>` — and the raiser wrote that sentence
          // into the option. Dropping it here left Desk offering a button whose
          // effect is invisible until after it is pressed, which is the one
          // thing a decidable card must never do. Bounded: a desk button is not
          // a place to render 600 characters.
          consequence:
            typeof o.consequence === "string" ? o.consequence.slice(0, 200) : "",
          recommended: Boolean(o.recommended),
        }))
    : [];
  return {
    id: raw.id,
    title: typeof raw.title === "string" ? raw.title : "Decision needed",
    summary: typeof raw.summary === "string" ? raw.summary : "",
    kind,
    urgency: typeof raw.urgency === "string" ? raw.urgency : "normal",
    createdAt: Number(raw.created_at) || 0,
    // The deadline is the card's OWN answer: an unanswered recipe card applies
    // its declared default when this passes, so a surface that shows a card
    // without it is hiding the fact that not answering is also a choice.
    deadline: Number(raw.deadline) || 0,
    options,
    defaultKey: typeof raw.default_key === "string" ? raw.default_key : "",
    // The recipe this card was built from, "" for a hand-raised card. A desk
    // surface uses it to say the answer will DO something rather than merely be
    // recorded, and it is the only honest way to distinguish the two.
    recipe: typeof raw.card_recipe === "string" ? raw.card_recipe : "",
    // The producer's identity for the QUESTION ("this job, this failure
    // streak"). Desk never writes it — it is carried so a surface can group a
    // streak instead of showing what looks like a repeat card.
    dedupeKey: typeof raw.dedupe_key === "string" ? raw.dedupe_key : "",
    // WHERE the ask came from — a toast with no identity is noise the owner
    // cannot act on when a dozen sessions are open (owner report 2026-08-25).
    tab: typeof source.tab_title === "string" ? source.tab_title : "",
    cwd: typeof source.cwd === "string" ? source.cwd : "",
    agent: typeof source.agent === "string" ? source.agent : "",
    // kind==='credential' only (see `credential` above); ""/null on every other
    // kind so a surface concatenating these into text never prints `undefined`.
    secretName: credential && typeof raw.secret_name === "string"
      ? raw.secret_name.slice(0, 120) : "",
    credentialScope: credential && typeof raw.credential_scope === "string"
      ? raw.credential_scope.slice(0, 40) : "",
    credentialDescription: credential && typeof raw.credential_description === "string"
      ? raw.credential_description.slice(0, 300) : "",
    credentialFormat: credential && typeof raw.credential_format === "string"
      ? raw.credential_format.slice(0, 40) : "",
    // The signed audit of a CLOSED card (what was vaulted, where, which door,
    // a digest — never the value). A listed card is open so this is normally
    // null; carried so a surface that found a closed one could show proof
    // rather than re-ask.
    credentialReceipt: credential && raw.credential_receipt
      && typeof raw.credential_receipt === "object" ? raw.credential_receipt : null,
  };
}

/** Open cards, oldest first — the one blocking longest is the one to surface. */
function listOpen(dir = storeDir()) {
  let entries;
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return [];
  }
  const cards = [];
  for (const name of entries) {
    if (!isCardFile(name)) continue;
    let raw;
    try {
      raw = JSON.parse(fs.readFileSync(path.join(dir, name), "utf8"));
    } catch {
      continue; // a half-written card must not take the list down
    }
    const card = cardFromRaw(raw);
    if (card) cards.push(card);
  }
  cards.sort((a, b) => a.createdAt - b.createdAt);
  return cards;
}

/**
 * Classify a card as DECISION or CONTEXT using triage rules.
 *
 * DECISION: has options, has a deadline, or is credential/blocked kind.
 * CONTEXT: info-only (status updates, hourly digests, etc).
 *
 * Returns "decision" or "context".
 */
// What the daemon's /decisions/triage-patterns says when it cannot be asked.
// The early `return "decision"` that stood here counted EVERY card while the
// daemon was down or the caller passed no patterns (main.cjs's bell does) --
// i.e. "3 decisions waiting" was one ask and two facts again, the exact noise
// the bell was rebuilt to stop (measured 2026-09-08 by the actionableCount test).
const DEFAULT_TRIAGE_PATTERNS = Object.freeze({
  decision_kinds: ["credential", "blocked"],
  context_phrases: [],
  context_kinds: ["info"],
});

// kind=info is a REPORT whatever else it carries. A deadline on an info card
// used to make it a "decision", so a digest with a deadline lit the bell — the
// noise the badge was rebuilt to keep out. Kept even when the daemon's patterns
// predate `context_kinds`, so an older daemon cannot re-open the leak.
const ALWAYS_CONTEXT_KINDS = Object.freeze(["info"]);

function triageCard(card, patterns) {
  if (!patterns || typeof patterns !== "object") patterns = DEFAULT_TRIAGE_PATTERNS;

  const kind = (card.kind || "decision").toLowerCase();
  const options = Array.isArray(card.options) ? card.options : [];
  const hasDeadline = card.deadline !== null && card.deadline !== undefined;

  // Info is never a decision, deadline or not (the store refuses an info card
  // with options, so an optionless one is the only shape that exists).
  const contextKinds = Array.isArray(patterns.context_kinds)
    ? patterns.context_kinds
    : ALWAYS_CONTEXT_KINDS;
  if (
    options.length === 0 &&
    (ALWAYS_CONTEXT_KINDS.includes(kind) || contextKinds.includes(kind))
  ) {
    return "context";
  }

  // Credentials and blocked cards are always decisions.
  if (patterns.decision_kinds && patterns.decision_kinds.includes(kind)) {
    return "decision";
  }

  // Has a future deadline? Decision.
  if (hasDeadline && card.deadline > Date.now() / 1000) {
    return "decision";
  }

  // Has actionable options? Decision.
  if (options.length > 0) {
    // Check if all options are status-only phrases (not actionable).
    const actionable = options.filter((o) => {
      const label = o.label || "";
      // Check against each status-only pattern.
      if (patterns.context_phrases) {
        for (const pattern of patterns.context_phrases) {
          try {
            const re = new RegExp(pattern, "i");
            if (re.test(label)) {
              return false; // status-only
            }
          } catch {
            // bad regex, skip
          }
        }
      }
      return true; // actionable
    });
    if (actionable.length > 0) {
      return "decision";
    }
  }

  // No options, no deadline, not credential/blocked. Info-only.
  return "context";
}

/**
 * How many of these cards are actually WAITING on the owner — i.e., DECISIONS.
 * Using triage classification to filter out context/info cards.
 * The tray bell counts decisions only, not digests or status updates.
 */
function actionableCount(cards, patterns) {
  return cards.filter((c) => triageCard(c, patterns) === "decision").length;
}

/**
 * Run an awask CLI subcommand detached and windowless (never blocks the app,
 * nothing flashes — the gate-1t class). Injectable spawnFn for tests.
 * awask is the single WRITE implementation of the card plane (store + steer
 * mailbox delivery); spawning it keeps Desk a read-only consumer, so the
 * two can never become rival stores (the DCS001 class).
 */
function runAwask(args, spawnFn = spawn) {
  try {
    const child = spawnFn(awaskBin(), args, {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    });
    child.unref();
    return true;
  } catch {
    return false;
  }
}

/**
 * Where a card surface should OPEN.
 *
 * Owner, 2026-09-08, on being shown the console: "I WANT TO CONSOLIDATE AND DEDUPE".
 * The awask Tk window was the last independent popup source on this box -- a third
 * place decision cards could appear, alongside the deck panel and the console's
 * Cards pane, none of which knew about the others. So these two functions no longer
 * decide; they ASK. main.cjs installs a router that lands the card in the console,
 * and only if the router declines (no console, or it failed) does the Tk window
 * spawn. Nothing is removed: the popup is still the fallback and still what awask
 * itself opens for other sessions.
 */
let windowRouter = null;

/** @param fn (kind: "queue"|"card", id: string|null) => boolean -- true = handled. */
function setWindowRouter(fn) {
  windowRouter = typeof fn === "function" ? fn : null;
}

function routed(kind, id) {
  if (!windowRouter) return false;
  try {
    return windowRouter(kind, id) === true;
  } catch {
    // A throwing router must not swallow the card: fall through to the popup,
    // which is the whole reason the fallback was kept.
    return false;
  }
}

/**
 * Open the shared queue. The console's Cards pane first; the detached Tk window
 * only if nothing hosted it. Detached so Desk never holds the window's lifetime,
 * windowless spawn so nothing flashes (the gate-1t class).
 */
function openQueueWindow() {
  if (routed("queue", null)) return true;
  return runAwask(["window"]);
}

/** Open ONE card. Same ladder: the console's Cards pane, else that card's own Tk
 *  pop-out (the flipper's "Pop out" button, one card at a time). */
function openCardWindow(id) {
  if (typeof id !== "string" || id.length === 0) return false;
  if (routed("card", id)) return true;
  return runAwask(["window", id]);
}

/**
 * Answer a card from a desk surface. `choice` is the card's OWN option key
 * (listOpen carries options for exactly this), and the awask store delivers
 * the answer into the raising session's steer mailbox — never re-implemented
 * here, so a desk button and the popup window are one implementation.
 */
function answerCard(id, choice, note = "", spawnFn = spawn) {
  if (typeof id !== "string" || id.length === 0) return false;
  if (typeof choice !== "string" || choice.length === 0) return false;
  const args = ["answer", id, choice, "--via", "desk"];
  if (note) args.push("--note", String(note).slice(0, 2000));
  return runAwask(args, spawnFn);
}

/**
 * Withdraw a card from a desk surface (the "this is not now" path for cards
 * whose own options do not include a defer choice). The awask store cancels
 * it AND notifies the raising session, so the agent stops waiting.
 */
function cancelCard(id, note = "", spawnFn = spawn) {
  if (typeof id !== "string" || id.length === 0) return false;
  const args = ["cancel", id, "--note", String(note || "").slice(0, 2000)];
  return runAwask(args, spawnFn);
}

/**
 * STEER a card: send the raising session a work order instead of picking one of
 * its options. This is the verb that turns a card from a multiple-choice quiz
 * into a conversation -- "none of these; do X instead" -- and until 2026-09-08
 * the deck could answer and cancel but not steer, so every card whose right
 * answer was not on the card had to be retyped in a terminal (integration-map
 * gap 3). Same doctrine as answer/cancel: awask is the single WRITE
 * implementation, Desk stays a read-only consumer of the store.
 */
function steerCard(id, text, spawnFn = spawn) {
  if (typeof id !== "string" || id.length === 0) return false;
  const body = String(text || "").trim();
  if (!body) return false;
  // `awask steer <id> <text...>` -- the text is positional and variadic; pass it
  // as ONE argv element so a sentence is not re-split into flags.
  return runAwask(["steer", id, body.slice(0, 2000), "--via", "desk"], spawnFn);
}

/**
 * The store, read WITHOUT blocking the event loop.
 *
 * Answered cards are never removed from the directory: measured 2026-09-18 it
 * held 2,788 files, the 15 s watcher `statSync`ed every one (903 ms of blocked
 * main process per 25 s, scripts/main-profile.cjs) and every change -- and every
 * /decisions request -- `readFileSync`ed and parsed all of them (1.4-3.6 s
 * blocks on /health.stage.mainLag; the perf gate's first MCP call was reset).
 *
 * `scanAsync` stats in bounded batches and re-reads ONLY files whose
 * (mtimeNs, size) moved; `cache` carries the parsed result between scans.
 * Returns the same signature token as `signature()` plus the open cards.
 */
async function scanAsync(dir = storeDir(), cache = new Map(), fsp = fs.promises, batch = 64) {
  let entries;
  try {
    entries = await fsp.readdir(dir);
  } catch {
    return { signature: "unreadable", cards: [] };
  }
  const names = entries.filter(isCardFile);
  let count = 0;
  let newest = 0n;
  let total = 0;
  const seen = new Set();
  for (let i = 0; i < names.length; i += batch) {
    await Promise.all(
      names.slice(i, i + batch).map(async (name) => {
        let info;
        try {
          info = await fsp.stat(path.join(dir, name), { bigint: true });
        } catch {
          return;
        }
        count += 1;
        total += Number(info.size);
        if (info.mtimeNs > newest) newest = info.mtimeNs;
        seen.add(name);
        const stamp = `${info.mtimeNs}:${info.size}`;
        const hit = cache.get(name);
        if (hit && hit.stamp === stamp) return;
        let card;
        try {
          card = cardFromRaw(JSON.parse(await fsp.readFile(path.join(dir, name), "utf8")));
        } catch {
          return; // half-written: leave it uncached so the next scan retries
        }
        cache.set(name, { stamp, card });
      }),
    );
  }
  for (const name of [...cache.keys()]) if (!seen.has(name)) cache.delete(name);
  const cards = [...cache.values()].map((v) => v.card).filter(Boolean);
  cards.sort((a, b) => a.createdAt - b.createdAt);
  return { signature: `${count}:${newest}:${total}`, cards };
}

// What the watcher last saw -- the answer for synchronous readers (the bridge's
// /decisions, the deck state) that must not walk the store themselves.
let lastOpenCards = null;
function lastOpen(dir = storeDir()) {
  return lastOpenCards ?? listOpen(dir);
}

/** fs.watch fires a burst of events per write (tmp create, rename, ...); one scan
 *  per burst is enough, and the signature diff makes an extra scan harmless. */
const WATCH_DEBOUNCE_MS = 300;

/** The FALLBACK poll cadence. fs.watch is the primary mechanism (a card must be on
 *  the owner's screen within ~a second of the write, not up to 15 s later — the
 *  awask Tk window it replaces appeared instantly, and a desk that is slower reads
 *  as "the desk never showed it"). The interval stays as the safety net for a
 *  directory fs.watch cannot watch (a network mount, a watcher error). */
const WATCH_FALLBACK_MS = 30_000;

/**
 * Watch the store; call onChange(cards) when the signature moves (and once at
 * start). Primary mechanism: `fs.watch` on the directory with a ~300 ms
 * debounce; fallback: a 30 s interval, used automatically when the OS watcher
 * cannot be created (or dies) and whenever the injected interval is ticked by
 * hand in tests. A poll never stacks (the `running` guard) and a quiet poll
 * never fires onChange (the signature diff). Injectable pieces for tests.
 * Returns a stop function that closes both mechanisms.
 */
function watch({ intervalMs = WATCH_FALLBACK_MS, onChange, dir = storeDir(), setIntervalFn = setInterval, clearIntervalFn = clearInterval, scanFn = scanAsync, watchFn = fs.watch, setTimeoutFn = setTimeout, clearTimeoutFn = clearTimeout } = {}) {
  if (typeof onChange !== "function") throw new TypeError("watch requires onChange");
  let lastSig = null;
  let running = false;
  const cache = new Map();
  const poll = async () => {
    if (running) return; // a slow disk must not stack scans
    running = true;
    try {
      const { signature: sig, cards } = await scanFn(dir, cache);
      if (dir === storeDir()) lastOpenCards = cards;
      if (sig === lastSig) return;
      lastSig = sig;
      try {
        onChange(cards);
      } catch {
        /* a bad consumer must not kill the watcher */
      }
    } finally {
      running = false;
    }
  };
  void poll();
  const handle = setIntervalFn(() => poll(), intervalMs);
  // The OS watcher. `persistent: false` so a watcher never holds the process
  // open (tests, and a quit that is already in flight). Creation can throw
  // (missing dir, unsupported FS) and the watcher can error later (the dir
  // vanished); both fall back to the interval, which is why it stays.
  let watcher = null;
  let debounce = null;
  const onFsEvent = () => {
    if (debounce) clearTimeoutFn(debounce);
    debounce = setTimeoutFn(() => {
      debounce = null;
      void poll();
    }, WATCH_DEBOUNCE_MS);
    if (debounce && typeof debounce.unref === "function") debounce.unref();
  };
  try {
    watcher = watchFn(dir, { persistent: false }, onFsEvent);
    if (watcher && typeof watcher.on === "function") {
      watcher.on("error", () => {
        try { watcher.close(); } catch { /* already gone */ }
        watcher = null;
      });
    }
  } catch {
    watcher = null; // no OS watcher here: the interval carries the watch alone
  }
  return () => {
    clearIntervalFn(handle);
    if (debounce) clearTimeoutFn(debounce);
    if (watcher) {
      try { watcher.close(); } catch { /* already gone */ }
      watcher = null;
    }
  };
}

// ── the desk's liveness heartbeat ───────────────────────────────────────────
//
// awask reads this file (adk.decisions.notify.desk_alive) before it spawns its
// own Tk card window: while the desk is up, the card is the DESK's to surface
// — the owner's words (2026-10-05): the notifications "need to actually come up
// in awdesk … not a separate thing". The MTIME is the signal: the file's
// content is informational, and a killed app leaves the file behind, so a
// heartbeat nobody is refreshing must read as dead (awask's staleness window is
// 90 s against this 20 s beat).
const DESK_ALIVE_FILENAME = ".desk-alive";
const HEARTBEAT_MS = 20_000;

/**
 * Write <store>/.desk-alive now and every `intervalMs`, until stop(). The beat
 * is UNREF'D (it must never hold the app open) and every failure is swallowed —
 * a heartbeat that cannot be written must not take the desk down; the cost is
 * only that awask falls back to its own Tk window.
 */
function startHeartbeat({ dir = storeDir(), intervalMs = HEARTBEAT_MS, setIntervalFn = setInterval, clearIntervalFn = clearInterval } = {}) {
  const beatPath = path.join(dir, DESK_ALIVE_FILENAME);
  const beat = () => {
    try {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(beatPath, JSON.stringify({ pid: process.pid, at: new Date().toISOString() }));
    } catch {
      /* best-effort: see above */
    }
  };
  beat();
  const handle = setIntervalFn(beat, intervalMs);
  if (handle && typeof handle.unref === "function") handle.unref();
  return () => {
    clearIntervalFn(handle);
    // Best-effort cleanup on quit: awask goes back to its own window the moment
    // this lands, instead of waiting out the staleness window.
    try { fs.rmSync(beatPath, { force: true }); } catch { /* best-effort */ }
  };
}

module.exports = {
  storeDir,
  signature,
  listOpen,
  lastOpen,
  scanAsync,
  cardFromRaw,
  triageCard,
  actionableCount,
  setWindowRouter,
  openQueueWindow,
  openCardWindow,
  answerCard,
  cancelCard,
  steerCard,
  watch,
  startHeartbeat,
};
