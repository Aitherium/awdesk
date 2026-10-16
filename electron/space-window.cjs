"use strict";

/**
 * space-window.cjs -- the IPC of the aither://space/ pane.
 *
 *   desk:space-get      the universe (space-client.cjs get(): remote, last-good or local)
 *   desk:space-verb     run ONE verb on ONE node
 *   desk:space-explore  "Explore with Aither" on ONE node, on the agent lane
 *
 * The renderer names a node and a verb; it never supplies what runs. Main re-reads
 * the node from ITS OWN last snapshot, refuses anything that node does not carry,
 * re-checks a fleet verb against fleet-control.cjs ACTION_NAMES and DESTRUCTIVE (a
 * destructive verb needs confirmed === true), and runs it through the same
 * FleetControl the tray, the Fleet pane and MCP use. An `open` verb opens a plane
 * pane and nothing else. An `info` verb (why-kept) answers the node's own meta and runs
 * nothing. A `profile` verb (profile-add|remove:<tier>, reclassify-edge:<a>:<b>) runs
 * AitherOS/dev/tools/stack_profiles.py with argv built HERE (profileArgv): the key from
 * node.id, the tier from the verb id; core is refused, and so is removing a derived
 * member. The bridge's POST /space/verb (aitherium.com relayed by Genesis) lands on this
 * same handler. The explore prompt is BUILT here from the node, so the
 * page cannot smuggle a fleet verb into it -- and it runs on lane "agent", where
 * the CommandAgent never classifies text as a fleet verb anyway.
 *
 * A VIRTUAL moon (bead-space attachCards: a card's subject with no node, such as
 * `secret:NAME` for a credential ask) exists only in the renderer. Main rebuilds it
 * from its OWN open cards (virtualNodeOf): an id an open card points at gets a node
 * with no verbs and the generic explore; any other id stays "unknown object".
 *
 * After a fleet verb that can change the fleet, main asks FleetControl for a fresh
 * `status` so the desk's own fleet verdict (space-client.cjs) catches up.
 *
 * Card answers are NOT here: the pane uses deck.answer / deck.credential, the one
 * answer path every desk surface shares (answerDeckCard: destructive -> passkey).
 */

const { ACTION_NAMES, DESTRUCTIVE } = require("./fleet-control.cjs");
const { PLANE_IDS } = require("./plane-client.cjs");
const { ID_RE } = require("./space-client.cjs");

const QUESTION_MAX = 500;
/** A fleet verb still running after this answers {ok:true, pending:true}; it keeps going. */
const VERB_PENDING_MS = 5000;

function errorText(error) {
  return String((error && error.message) || error || "unknown error");
}

/** Kinds bead-space attachCards may draw as a virtual moon (VIRTUAL_PARENTS there). */
const VIRTUAL_PARENTS = Object.freeze({
  secret: ["svc:Secrets", "galaxy:data"],
  session: ["solar:agents/sessions", "galaxy:agents"],
  routine: ["galaxy:fleet"],
  repo: ["galaxy:cloud"],
  agent: ["galaxy:agents"],
});
const REPO_ID = "repo:Aitherium/AitherOS";

/** attach.ts slug(), word for word. */
function slug(text) {
  return String(text).trim().replace(/[^A-Za-z0-9._/@:-]+/g, "-").slice(0, 160);
}

/** Every virtual-moon id one card can point at (attach.ts subjectOf, its moon-making rules). */
function cardSubjects(card) {
  const out = new Set();
  if (!card || typeof card !== "object") return out;
  if (typeof card.subject === "string" && card.subject) out.add(card.subject);
  if (String(card.kind).toLowerCase() === "credential" && card.secretName) out.add(`secret:${slug(card.secretName)}`);
  if (card.agent) out.add(`agent:${slug(card.agent)}`);
  if (card.sessionId) out.add(`session:${slug(card.sessionId)}`);
  const key = typeof card.dedupeKey === "string" ? card.dedupeKey : "";
  const recipe = typeof card.recipe === "string" ? card.recipe : "";
  for (const k of [key, recipe]) {
    if (k.startsWith("escalation:")) {
      const agent = card.agent || k.slice("escalation:".length).split(":")[0];
      if (agent) out.add(`agent:${slug(agent)}`);
    }
    if (k.startsWith("expedition-gate:")) out.add("agent:atlas");
    if (k.startsWith("pr-review")) out.add(REPO_ID);
  }
  const parts = key.split(":");
  const at = parts.findIndex((p) => p.startsWith("wake-"));
  if (at >= 0 && at + 1 < parts.length) out.add(`routine:${slug(parts[at + 1])}`);
  if (card.cwd) {
    const base = String(card.cwd).replace(/[\\/]+$/, "").split(/[\\/]/).pop() || "";
    if (base === "AitherOS-Fresh" || base === "AitherOS") out.add(REPO_ID);
  }
  return out;
}

/**
 * The virtual moon for `nodeId`, rebuilt from main's own open cards, or null. Only a
 * well-formed id of a virtual kind that an open card points at; no verbs, ever.
 */
function virtualNodeOf(nodeId, cards, universe) {
  if (typeof nodeId !== "string" || !ID_RE.test(nodeId)) return null;
  const colon = nodeId.indexOf(":");
  const kind = colon > 0 ? nodeId.slice(0, colon) : "";
  if (!Object.prototype.hasOwnProperty.call(VIRTUAL_PARENTS, kind)) return null;
  const list = Array.isArray(cards) ? cards : [];
  if (!list.some((c) => cardSubjects(c).has(nodeId))) return null;
  const ids = new Set((universe && Array.isArray(universe.nodes) ? universe.nodes : []).map((n) => n && n.id));
  const parent = VIRTUAL_PARENTS[kind].find((p) => ids.has(p)) || "platform";
  return {
    id: nodeId,
    title: nodeId.slice(colon + 1),
    level: "moon",
    parent,
    cluster: parent,
    status: "open",
    health: { state: "unknown", reason: "known only from an open card", source: "cards" },
    verbs: [],
    explore: [],
    virtual: true,
  };
}

const PROFILE_VERB_RE = /^profile-(add|remove):(business|platform|critical)$/;
const EDGE_VERB_RE = /^reclassify-edge:([A-Za-z][A-Za-z0-9._-]{0,60}):([A-Za-z][A-Za-z0-9._-]{0,60})$/;
const SVC_KEY_RE = /^svc:([A-Za-z][A-Za-z0-9._-]{0,80})$/;
/** universe.py ADDED_PREFIX: only a hand add: row may be removed from a tier. */
const ADDED_PREFIX = "added: ";

/**
 * argv for AitherOS/dev/tools/stack_profiles.py, from MAIN's copy of the node. Pure.
 * The key is the node id's, the tier the verb id's; a core node (criticality core) gets
 * nothing, and a remove of anything not hand-added (a derived closure member) is refused.
 */
function profileArgv(node, verbId) {
  const keyMatch = SVC_KEY_RE.exec(String((node && node.id) || ""));
  if (!keyMatch) return { ok: false, error: "only a service can change profile" };
  const meta = node.meta && typeof node.meta === "object" ? node.meta : {};
  if (meta.criticality === "core") return { ok: false, error: `${node.title} is core: never stopped, never edited` };
  const key = keyMatch[1];
  const p = PROFILE_VERB_RE.exec(String(verbId || ""));
  if (p) {
    const why = typeof meta.kept_because === "string" ? meta.kept_because : "";
    if (p[1] === "remove" && why && !why.startsWith(ADDED_PREFIX)) {
      return { ok: false, error: `${node.title} is kept by its dependencies (${why.slice(0, 120)}); move the edge instead` };
    }
    // stack_profiles.py refuses an add row without --why (STK011): the row says who kept
    // it and from where, so the PR and the sidecar both carry a reason.
    const title = String(node.title || key).replace(/[^\w .:/()-]/g, "").slice(0, 60);
    const addWhy = ["--why", `kept by the owner from BeadSpace: ${title}`];
    return { ok: true, argv: [p[1], p[2], key, ...(p[1] === "add" ? addWhy : []), "--pr", "--json"] };
  }
  const e = EDGE_VERB_RE.exec(String(verbId || ""));
  if (e) return { ok: true, argv: ["reclassify-edge", e[1], e[2], "--pr", "--json"] };
  return { ok: false, error: `${String(verbId || "").slice(0, 60)} is not a profile verb` };
}

const DEFAULT_STACK_PROFILES_SCRIPT = "C:\\AitherOS-Fresh\\AitherOS\\dev\\tools\\stack_profiles.py";
/** Worktree + regenerate + check_stack_map + PR: minutes, not seconds. */
const PROFILE_TIMEOUT_MS = 900_000;

/**
 * Run stack_profiles.py with an argv profileArgv built. Its --json verdict is the LAST
 * JSON object on stdout; a non-zero exit with none is a failure carrying stderr's tail.
 */
function runStackProfiles(argv, { execFile = require("node:child_process").execFile, env = process.env } = {}) {
  const script = env.AWDESK_STACK_PROFILES_SCRIPT || DEFAULT_STACK_PROFILES_SCRIPT;
  const file = env.AWDESK_PYTHON || "python";
  return new Promise((resolve) => {
    execFile(file, [script, ...argv], { windowsHide: true, timeout: PROFILE_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024 },
      (error, stdout, stderr) => {
        const lines = String(stdout || "").trim().split(/\r?\n/).reverse();
        for (const line of lines) {
          const t = line.trim();
          if (!t.startsWith("{")) continue;
          try {
            const doc = JSON.parse(t);
            if (doc && typeof doc === "object") {
              resolve(error && doc.ok !== false ? { ...doc, ok: false, error: doc.error || errorText(error) } : doc);
              return;
            }
          } catch { /* not the verdict line */ }
        }
        const tail = String(stderr || "").trim().split(/\r?\n/).slice(-3).join(" ").slice(0, 300);
        resolve(error ? { ok: false, error: tail || errorText(error) } : { ok: false, error: "stack_profiles.py printed no verdict" });
      });
  });
}

/** The PR a profile verb opened: stack_profiles.py says `pr`, older callers `pr_url`. */
function prUrlOf(verdict) {
  if (!verdict || typeof verdict !== "object") return {};
  const url = [verdict.pr_url, verdict.pr].find((u) => typeof u === "string" && /^https:\/\//.test(u));
  return url ? { pr_url: url } : {};
}

/** A verdict worth showing (an inference lane table, a PR) rides back as `result`. */
function resultOf(verdict) {
  if (!verdict || typeof verdict !== "object") return {};
  const extra = Object.keys(verdict).filter((k) => !["ok", "error", "message", "busy"].includes(k));
  return extra.length ? { result: verdict } : {};
}

/** The generic explore prompt, the same words as bead-space universe/verbs exploreFor. */
function genericExplore(node) {
  return {
    label: "Explore with Aither",
    prompt: `Tell me about ${node.title} (${node.id}): what it is, how it is doing right now, and anything that needs my attention.`,
  };
}

/** The whole explore prompt, built from main's copy of the node. Pure. */
function explorePrompt(node, exploreIndex, question) {
  const list = Array.isArray(node.explore) ? node.explore.filter((e) => e && typeof e.prompt === "string" && e.prompt) : [];
  const index = Number.isInteger(exploreIndex) ? exploreIndex : 0;
  let pick = list[index];
  if (!pick && index === 0 && list.length === 0) pick = genericExplore(node);
  if (!pick) return null;
  const health = node.health && typeof node.health === "object" ? node.health : {};
  const state = typeof health.state === "string" ? health.state : "unknown";
  const reason = typeof health.reason === "string" && health.reason ? health.reason : "no reason given";
  const ask = typeof question === "string" ? question.trim().slice(0, QUESTION_MAX) : "";
  return `Explore ${node.title} (${node.id}), health ${state}: ${reason}. ${pick.prompt}${ask ? ` ${ask}` : ""}`;
}

/**
 * The handler table, pure over its injected pieces so it is testable without Electron.
 * @param {{getControl: () => {run: (id: string) => Promise<object>}, client: {get: Function, current: Function},
 *          askAgent: (prompt: string) => Promise<{ok?: boolean, reply?: string}>,
 *          openInternal: (paneId: string) => unknown, cards?: () => object[], pendingMs?: number}} deps
 */
function spaceHandlers({ getControl, client, askAgent, openInternal, cards = () => [], pendingMs = VERB_PENDING_MS,
  runProfile = null }) {
  async function nodeOf(nodeId) {
    if (typeof nodeId !== "string" || !nodeId) return null;
    let universe = client.current();
    if (!universe) {
      const fresh = await client.get();
      universe = fresh && fresh.universe;
    }
    const nodes = universe && Array.isArray(universe.nodes) ? universe.nodes : [];
    const real = nodes.find((n) => n && n.id === nodeId);
    if (real) return real;
    let open;
    try { open = cards(); } catch { open = []; }
    return virtualNodeOf(nodeId, open, universe);
  }

  /** A verb that can change the fleet makes the desk's verdict old: re-probe, quietly. */
  function refreshStatus(control, verbId) {
    if (/(^|-)status$/.test(verbId)) return;
    Promise.resolve()
      .then(() => control.run("status"))
      .catch(() => { /* the next pane poll shows whatever the desk has */ });
  }

  async function runFleet(verbId) {
    let control;
    try { control = getControl(); } catch (error) { return { ok: false, error: errorText(error) }; }
    if (!control || typeof control.run !== "function") return { ok: false, error: "fleet control is not available in this desk" };
    const running = Promise.resolve()
      .then(() => control.run(verbId))
      .then((verdict) => {
        if (!(verdict && verdict.busy)) refreshStatus(control, verbId);
        return verdict;
      })
      .then((verdict) => ({
        ok: Boolean(verdict && verdict.ok),
        ...(verdict && !verdict.ok ? { error: String(verdict.error || verdict.message || "the fleet refused").slice(0, 300) } : {}),
        ...resultOf(verdict),
      }), (error) => ({ ok: false, error: errorText(error) }));
    return raceWithPending(running);
  }

  async function raceWithPending(running) {
    let timer = null;
    const pending = new Promise((resolve) => {
      timer = setTimeout(() => resolve({ ok: true, pending: true }), pendingMs);
      if (timer && typeof timer.unref === "function") timer.unref();
    });
    try {
      return await Promise.race([running, pending]);
    } finally {
      clearTimeout(timer);
    }
  }

  /** profile / reclassify-edge: argv built HERE from main's node, never from the page. */
  async function runProfileVerb(node, verb) {
    const argv = profileArgv(node, verb.id);
    if (!argv.ok) return { ok: false, error: argv.error };
    if (typeof runProfile !== "function") return { ok: false, error: "profile edits are not available in this desk" };
    const running = Promise.resolve()
      .then(() => runProfile(argv.argv))
      .then((verdict) => ({
        ok: Boolean(verdict && verdict.ok),
        ...(verdict && !verdict.ok ? { error: String(verdict.error || "the profile edit failed").slice(0, 300) } : {}),
        // stack_profiles.py --pr answers {pr: <url>}; the panel renders pr_url.
        ...prUrlOf(verdict),
        ...resultOf(verdict),
      }), (error) => ({ ok: false, error: errorText(error) }));
    return raceWithPending(running);
  }

  return {
    "desk:space-get": async () => {
      try {
        return await client.get();
      } catch (error) {
        return { ok: false, error: errorText(error) };
      }
    },

    "desk:space-verb": async (_event, payload) => {
      const { nodeId, verbId, confirmed } = payload && typeof payload === "object" ? payload : {};
      const node = await nodeOf(nodeId).catch(() => null);
      if (!node) return { ok: false, error: "unknown object" };
      const verb = (Array.isArray(node.verbs) ? node.verbs : []).find((v) => v && v.id === verbId);
      if (!verb) return { ok: false, error: `${node.title} has no verb ${String(verbId || "").slice(0, 60)}` };
      if (verb.transport === "fleet") {
        if (!ACTION_NAMES.includes(verb.id)) return { ok: false, error: `${verb.id} is not a fleet action` };
        if (DESTRUCTIVE.has(verb.id) && confirmed !== true) {
          return { ok: false, error: `${verb.label} takes things down: confirm it first` };
        }
        return runFleet(verb.id);
      }
      if (verb.transport === "info") {
        // why-kept: the node's own meta, rendered. Nothing runs.
        const meta = node.meta && typeof node.meta === "object" ? node.meta : {};
        return { ok: true, text: String(meta.kept_because || "") };
      }
      if (verb.transport === "profile") return runProfileVerb(node, verb);
      if (verb.transport === "open") {
        const m = /^open-plane:([a-z]+)$/.exec(verb.id);
        if (!m || !PLANE_IDS.includes(m[1])) return { ok: false, error: `${verb.id} opens nothing the desk knows` };
        try {
          return openInternal(m[1]) ? { ok: true } : { ok: false, error: `could not open ${m[1]}` };
        } catch (error) {
          return { ok: false, error: errorText(error) };
        }
      }
      return { ok: false, error: `${verb.id} has no transport the desk runs` };
    },

    "desk:space-explore": async (_event, payload) => {
      const { nodeId, exploreIndex, question } = payload && typeof payload === "object" ? payload : {};
      const node = await nodeOf(nodeId).catch(() => null);
      if (!node) return { ok: false, error: "unknown object" };
      const prompt = explorePrompt(node, exploreIndex, question);
      if (!prompt) return { ok: false, error: `${node.title} has no such explore` };
      try {
        const result = await askAgent(prompt);
        const text = String((result && (result.reply || result.text)) || "");
        return result && result.ok === false ? { ok: false, error: text || "the agent did not answer", text }
          : { ok: true, text };
      } catch (error) {
        return { ok: false, error: errorText(error) };
      }
    },
  };
}

let wired = null;

/**
 * Register the space IPC once. main.cjs calls this in wireConsoleHost next to
 * ensurePlaneIpc; the smoke calls it with a stub client. Returns the handler table, so
 * the bridge's POST /space/verb (aitherium.com's relay) runs the SAME desk:space-verb.
 */
function ensureSpaceIpc(deps) {
  if (wired) return wired;
  wired = spaceHandlers(deps);
  const { ipcMain } = require("electron");
  for (const [channel, handler] of Object.entries(wired)) ipcMain.handle(channel, handler);
  return wired;
}

/** The registered desk:space-verb, or null before the console host wired it. */
function spaceVerbHandler() {
  return wired ? wired["desk:space-verb"] : null;
}

module.exports = {
  ensureSpaceIpc, spaceVerbHandler, spaceHandlers, explorePrompt, virtualNodeOf, cardSubjects, profileArgv,
  runStackProfiles, QUESTION_MAX, VERB_PENDING_MS,
};
