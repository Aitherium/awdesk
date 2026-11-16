"use strict";

/**
 * assist-engine.cjs -- the one controller behind every Aither assist surface.
 *
 * The desk pop-up (assist-window.cjs) and the browser overlay (AitherConnect, over the
 * desk's loopback POST /assist/run) call the SAME three methods, so a verb has one
 * prompt, one log line and one failure message wherever it is used:
 *
 *   suggest(ctx)          -> {chips, send, refine?}   offline chips now; a model refines
 *                            them ONLY when assist-core.mayAutoSuggest() allows it
 *   run({verb, ctx, ...}) -> {ok, text} | {ok:false, error}   model verbs (transform/answer)
 *   route({verb, ctx,...})-> {ok, text?}                      agent / workflow / save verbs
 *   note(outcome, ...)    -> logs accept / undo / cancel / retry
 *
 * Every method writes a "started" log line BEFORE anything leaves the machine, then the
 * outcome. A log that cannot be written REFUSES the action: "every action is logged" is a
 * precondition, not a best effort (the one place this module is stricter than the log).
 * Electron-free; all effects injected.
 */

const core = require("./assist-core.cjs");

function createAssistEngine({ llm, log, getSettings = () => ({}), saveNote = null, now = Date.now, newId = null } = {}) {
  let counter = 0;
  const nextId = newId || (() => `a${now().toString(36)}${(counter += 1).toString(36)}`);
  const settings = () => core.normalizeSettings(getSettings());

  function write(rec) {
    const verdict = log.append(rec);
    return verdict && verdict.ok !== false ? null : (verdict && verdict.error) || "the action log is not writable";
  }

  /** Disclosure + offline chips for a freshly captured context. */
  function suggest(rawCtx, { surface = "desk" } = {}) {
    const ctx = core.normalizeContext({ ...rawCtx, surface });
    const blocked = core.refusal(ctx);
    if (blocked) return { ok: false, refused: true, error: blocked, chips: [] };
    const s = settings();
    const out = {
      ok: true,
      chips: core.heuristicSuggestions(ctx),
      send: core.describeSend(ctx, s),
      canInsert: ctx.canInsert,
      hasSelection: Boolean(ctx.selection.trim()),
    };
    const wantRefine = core.mayAutoSuggest(s) && Boolean(core.suggestionMessages(ctx).ok);
    out.refine = wantRefine
      ? async () => {
        const id = nextId();
        const prep = core.suggestionMessages(ctx);
        if (!prep.ok) return [];
        const failed = write(core.logRecord({ id, surface, verb: "suggest", ctx, settings: s, outcome: "started", now: now() }));
        if (failed) return [];
        const res = await llm.chat({ messages: prep.messages, maxTokens: 120, source: `assist:${surface}:suggest`, temperature: 0.7 });
        write(core.logRecord({ id, surface, verb: "suggest", ctx, settings: s, outcome: res.ok ? "ok" : "error", error: res.ok ? undefined : res.error, now: now() }));
        return res.ok ? core.parseSuggestions(res.text) : [];
      }
      : null;
    return out;
  }

  /** A model verb. */
  async function run({ verb, ctx: rawCtx, prompt = "", arg = "", surface = "desk", retryOf = null } = {}) {
    const v = core.verbById(verb);
    if (!v || v.kind === "route" || v.kind === "save") return { ok: false, error: `${verb || "that"} is not a model verb` };
    const ctx = core.normalizeContext({ ...rawCtx, surface });
    const s = settings();
    const id = nextId();
    const prep = core.buildMessages({ verb: v, ctx, request: prompt, arg });
    if (!prep.ok) {
      write(core.logRecord({ id, surface, verb: v.id, ctx, settings: s, outcome: "refused", error: prep.error, now: now() }));
      return { ok: false, refused: true, error: prep.error };
    }
    const failed = write(core.logRecord({ id, surface, verb: v.id, ctx, settings: s, outcome: retryOf ? "retried" : "started", extra: retryOf ? { retryOf } : undefined, now: now() }));
    if (failed) return { ok: false, error: `Not run: the action log is not writable (${failed}).` };
    const res = await llm.chat({ messages: prep.messages, source: `assist:${surface}:${v.id}` });
    if (!res.ok) {
      write(core.logRecord({ id, surface, verb: v.id, ctx, settings: s, outcome: "error", error: res.error, now: now() }));
      return { ok: false, id, error: res.error };
    }
    const text = core.cleanResult(res.text);
    write(core.logRecord({ id, surface, verb: v.id, ctx, settings: s, outcome: "ok", text, now: now() }));
    return { ok: true, id, verb: v.id, kind: v.kind, text, model: res.model, destination: core.destination(s).label };
  }

  /** Agent / workflow / memory / note verbs: a named user action, logged, never a model call of ours. */
  async function route({ verb, ctx: rawCtx, agent, name, text, surface = "desk" } = {}) {
    const v = core.verbById(verb);
    if (!v || (v.kind !== "route" && v.kind !== "save")) return { ok: false, error: `${verb || "that"} is not a routing verb` };
    const ctx = core.normalizeContext({ ...rawCtx, surface });
    const blocked = core.refusal(ctx);
    if (blocked) return { ok: false, refused: true, error: blocked };
    const s = settings();
    const body = String(text || ctx.selection || "").trim();
    if (!body) return { ok: false, error: `${v.label} needs some selected text` };
    const id = nextId();
    const who = String(agent || s.agent);
    const extra = { target: v.route === "workflow" ? String(name || "") : v.sink || who };
    const failed = write(core.logRecord({ id, surface, verb: v.id, ctx, settings: s, outcome: "started", extra, now: now() }));
    if (failed) return { ok: false, error: `Not run: the action log is not writable (${failed}).` };
    let res;
    const framed = ctx.url || ctx.title ? `${body}\n\n(from ${[ctx.app, ctx.title, ctx.url].filter(Boolean).join(" | ")})` : body;
    if (v.id === "ask-agent") res = await llm.askAgent({ agent: who, question: framed });
    else if (v.id === "send-agent") res = await llm.delegate({ agent: who, description: framed });
    else if (v.id === "send-workflow") {
      if (!String(name || "").trim()) res = { ok: false, error: "Pick a workflow to send this to." };
      else res = await llm.workflow({ name, text: framed });
    } else if (v.id === "save-memory") res = await llm.remember({ text: framed, tags: "assist,selection" });
    else if (v.id === "save-note") {
      res = typeof saveNote === "function" ? await saveNote({ text: framed, title: ctx.title }) : { ok: false, error: "Notes are not available on this PC." };
    } else res = { ok: false, error: "unhandled verb" };
    write(core.logRecord({ id, surface, verb: v.id, ctx, settings: s, outcome: res.ok ? "ok" : "error", error: res.ok ? undefined : res.error, text: res.ok ? res.text || "" : undefined, extra, now: now() }));
    return res.ok ? { ok: true, id, verb: v.id, text: res.text || "", destination: v.id === "save-note" ? "a note on this PC" : who } : { ok: false, id, error: res.error };
  }

  /** accepted | undone | cancelled | retried -- the user's decision on a result. */
  function note(outcome, { id, verb, surface = "desk", ctx, text } = {}) {
    const allowed = ["accepted", "undone", "cancelled"];
    if (!allowed.includes(outcome)) return { ok: false, error: "unknown outcome" };
    const failed = write(core.logRecord({ id, surface, verb, ctx, settings: settings(), outcome, text, now: now() }));
    return failed ? { ok: false, error: failed } : { ok: true };
  }

  return { suggest, run, route, note, settings };
}

module.exports = { createAssistEngine };
