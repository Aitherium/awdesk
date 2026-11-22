"use strict";

/**
 * agent-swarm-host.cjs -- the controller behind "every agent I run, as a fairy swarm and
 * as full avatars". It owns three things and nothing else:
 *
 *   1. the live roster (agent-roster-live.cjs) and the fairy presence rows it feeds the ONE
 *      cluster (orb-window setPresence -- no second cluster, no second renderer);
 *   2. each agent's FORM: "fairy" (a dot in the swarm) or "avatar" (its own VRM body on the
 *      avatar window's stage, or GargBot's 2D goblin), with a smooth grow / shrink;
 *   3. the clean API the real-time voice / lip-sync / Discord-hangout sibling drives:
 *        setAgentForm(agentId, 'fairy' | 'avatar')
 *        speak(agentId, input)          input = text | {text} | {audioBase64} | a stream
 *        visemes(agentId, weights | {frames})
 *
 * Every window and the stage come in through `deps` (main.cjs wires the real ones, the test
 * wires fakes), so the whole controller runs under node --test.
 *
 * Bodies: the resident slot0 is Aither (the fairy already grows into it through the orb's
 * expand hook). Every other agent gets a stage slot (spawnAvatarSlot with its own character
 * and `agent`, so its voice resolves through cast.json exactly as a room-stage body's does).
 * All form changes are serialised: two grows never tween over each other.
 */

const swarm = require("./agent-swarm.cjs");

const SETTLE_MS = 1100; // a spawned VRM needs this long to load before its grow can be seen
const VOICE_TARGET_MS = 90000;
const MAX_VISEME_FRAMES = 1200;
const MAX_AUDIO_BYTES = 24 * 1024 * 1024;

function lerp(a, b, t) {
  return a + (b - a) * t;
}

function easeInOut(t) {
  return t < 0.5 ? 2 * t * t : 1 - ((-2 * t + 2) ** 2) / 2;
}

/** Drain a Buffer | Uint8Array | async iterable | Node Readable | web ReadableStream into one Buffer. */
async function drainAudio(input, { maxBytes = MAX_AUDIO_BYTES } = {}) {
  if (Buffer.isBuffer(input)) return input;
  if (input instanceof Uint8Array) return Buffer.from(input);
  const chunks = [];
  let total = 0;
  const push = (chunk) => {
    const buf = typeof chunk === "string" ? Buffer.from(chunk, "base64") : Buffer.from(chunk);
    total += buf.length;
    if (total > maxBytes) throw new Error(`audio stream larger than ${maxBytes} bytes`);
    chunks.push(buf);
  };
  if (input && typeof input[Symbol.asyncIterator] === "function") {
    for await (const chunk of input) push(chunk);
  } else if (input && typeof input.getReader === "function") {
    const reader = input.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      push(value);
    }
  } else {
    throw new Error("audio must be a Buffer, a stream or an async iterable of Buffers");
  }
  return Buffer.concat(chunks);
}

function createSwarmHost({
  reader,
  avatar,
  orb,
  goblin,
  speakAloud,
  playAudio,
  askAgent = null,
  runTool = null,
  wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now = Date.now,
  log = () => {},
} = {}) {
  const forms = new Map(); // agentId -> "avatar" (absent = fairy)
  const slots = new Map(); // agentId -> slotId (non-resident bodies)
  let mode = "light";
  let snapshot = { roster: [], sources: {}, at: 0 };
  let voiceTarget = null; // {agent, until}
  let queue = Promise.resolve();
  let residentHidden = false;
  const positions = new Map(); // slotId -> x last placed by the swarm
  // STAGES (owner 2026-11-16: how do I combine, split and control stages): an explicit, visible
  // group of grown bodies. A body is in at most one stage; a LOCKED stage never loses a member by
  // itself (only an explicit leave does); an unlocked one drops a member whose body goes away.
  const stages = new Map(); // stageId -> {id, members:Set<agentId>, locked}
  let stageSeq = 0;
  const stageOf = (agentId) => [...stages.values()].find((s) => s.members.has(agentId)) || null;

  const rosterRow = (id) => snapshot.roster.find((r) => r.id === id) || null;

  function serial(fn) {
    const run = queue.then(fn, fn);
    queue = run.catch(() => {});
    return run;
  }

  // -- the roster and what the fairy swarm draws ------------------------------------

  async function refresh({ force = false } = {}) {
    snapshot = await reader.read({ force });
    // A body whose agent left the roster (its bot stopped) keeps its slot until shrunk.
    publish();
    return snapshot;
  }

  /** Presence rows for the cluster: the platform rows main already has, merged with the swarm's. */
  function composePresence(base = []) {
    const mine = swarm.presenceFor(snapshot.roster, forms);
    const grown = (id) => forms.get(id) === "avatar";
    const byAgent = new Map();
    for (const row of Array.isArray(base) ? base : []) {
      if (!row || !row.agent || grown(row.agent)) continue;
      byAgent.set(row.agent, row);
    }
    for (const row of mine) {
      const prev = byAgent.get(row.agent);
      byAgent.set(row.agent, prev
        ? { ...prev, kind: row.kind, belongsTo: row.belongsTo, discord: prev.discord || row.discord, label: prev.label || row.label }
        : row);
    }
    return [...byAgent.values()];
  }

  let basePresence = [];
  function publish() {
    try { orb.setPresence(composePresence(basePresence)); } catch (error) { log("swarm presence failed", error && error.message); }
    applyAnchor();
    if (stages.size || publishedStages) publishStages({ force: true }); // the roster refresh re-sends: a reloaded avatar window gets its handles back
  }

  // -- the entity verbs (owner 2026-11-16: for later tasks) -------------------------------
  // perceive(view), act(tool), walkTo(screenRect), lookAt(screenPoint) and a screen-context subscribe
  // hook: what an agent standing on this desk can see and do. The DarkMatter engine move (board
  // 21db327b-c63) keeps these signatures; only what is behind them changes.

  const screenListeners = new Set();
  let screenContext = null;

  /** The focused window / screen facts, from main. Subscribers hear every change. */
  function publishScreenContext(ctx) {
    screenContext = ctx && typeof ctx === "object" ? { ...ctx, at: now() } : null;
    for (const fn of [...screenListeners]) {
      try { fn(screenContext); } catch (error) { log("screen context listener failed", error && error.message); }
    }
    return screenContext;
  }

  /** subscribe(fn): fn(context|null) now (the last known) and on every change; returns unsubscribe. */
  function subscribeScreenContext(fn) {
    if (typeof fn !== "function") return () => {};
    screenListeners.add(fn);
    if (screenContext) { try { fn(screenContext); } catch { /* a listener bug stays there */ } }
    return () => screenListeners.delete(fn);
  }

  /** What `agent` can see. view: self | stage | roster | screen. */
  function perceive(agent, view = "self") {
    const id = agent ? swarm.rosterId(agent) : swarm.HOME_AGENT;
    const what = String(view || "self");
    if (what === "screen") return { ok: true, view: what, screen: screenContext };
    if (what === "roster") return { ok: true, view: what, roster: snapshot.roster.map((r) => swarm.publicRow(r, forms)) };
    if (what === "stage") {
      return {
        ok: true, view: what,
        bodies: bodyIds().map((slotId) => ({ slotId, agent: agentOfSlot(slotId), x: positions.get(slotId) ?? null })),
        stages: [...stages.values()].map(stageResult),
        talkingTo: currentTarget(),
      };
    }
    if (what === "self") {
      const row = rosterRow(id);
      if (!row) return { ok: false, error: `${id || "that agent"} is not in the live roster` };
      const st = stageOf(id);
      return {
        ok: true, view: what, agent: id, row: swarm.publicRow(row, forms), form: forms.get(id) === "avatar" ? "avatar" : "fairy",
        slotId: forms.get(id) === "avatar" ? slotFor(id) : null, stage: st ? stageResult(st) : null, screen: screenContext,
      };
    }
    return { ok: false, error: `unknown view "${what}" (self | stage | roster | screen)` };
  }

  /** Tools an agent may NOT start through act(): credentials, money, destruction. The gateway still decides;
   *  this keeps a verb meant for "press a button on the desk" from becoming a secrets door. */
  const ACT_DENY = /(secret|credential|password|token|key|delete|destroy|purge|wipe|reboot|restart|provision|payment|refund|stripe|invoice|send_email|set_|rotate)/i;

  /** Run a tool for an agent through the injected runner (main wires the gateway). */
  async function act(agent, tool, args = {}) {
    const name = String(tool || "");
    if (!/^[a-z][a-z0-9_]{1,63}$/.test(name)) return { ok: false, error: "a tool name is lower-case letters, digits and underscores" };
    if (ACT_DENY.test(name)) return { ok: false, error: `${name} is not something an agent starts from the desk` };
    if (typeof runTool !== "function") return { ok: false, error: "no tool runner is wired in this build" };
    const id = agent ? swarm.rosterId(agent) : swarm.HOME_AGENT;
    try {
      const result = await runTool(id, name, args && typeof args === "object" ? args : {});
      return { ok: true, agent: id, tool: name, result };
    } catch (error) {
      return { ok: false, agent: id, tool: name, error: String((error && error.message) || error) };
    }
  }

  /** The avatar window's origin, so a screen point becomes a point in its client area. */
  function windowOrigin() {
    const win = avatar.window && avatar.window();
    const b = win && win.getBounds ? win.getBounds() : null;
    return b ? { x: b.x, y: b.y } : { x: 0, y: 0 };
  }

  /** The grown body of `agent`, or the reason there is none. */
  function bodyOf(agent) {
    const id = agent ? swarm.rosterId(agent) : swarm.HOME_AGENT;
    if (!id || forms.get(id) !== "avatar") return { error: `${id || "that agent"} is not grown into an avatar` };
    return { id, slotId: slotFor(id) };
  }

  /** The body walks to stand under a screen rect (DIPs: {x, y, width, height}). */
  function walkTo(agent, screenRect) {
    const body = bodyOf(agent);
    if (body.error) return { ok: false, error: body.error };
    const r = screenRect && typeof screenRect === "object" ? screenRect : null;
    const x = Number(r && r.x);
    const y = Number(r && r.y);
    const width = Number((r && (r.width ?? r.w)) || 0);
    const height = Number((r && (r.height ?? r.h)) || 0);
    if (![x, y, width, height].every(Number.isFinite)) return { ok: false, error: "walkTo needs a screen rect {x, y, width, height}" };
    const o = windowOrigin();
    avatar.send({ type: "walk-to", slotId: body.slotId, rect: { x: x - o.x, y: y - o.y, width, height } });
    return { ok: true, agent: body.id, slotId: body.slotId };
  }

  /** The body turns toward a screen point ({x, y}); null turns it back. */
  function lookAt(agent, screenPoint) {
    const body = bodyOf(agent);
    if (body.error) return { ok: false, error: body.error };
    if (screenPoint === null) {
      avatar.send({ type: "look-at", slotId: body.slotId, point: null });
      return { ok: true, agent: body.id, slotId: body.slotId };
    }
    const x = Number(screenPoint && screenPoint.x);
    const y = Number(screenPoint && screenPoint.y);
    if (![x, y].every(Number.isFinite)) return { ok: false, error: "lookAt needs a screen point {x, y} (or null)" };
    const o = windowOrigin();
    avatar.send({ type: "look-at", slotId: body.slotId, point: { x: x - o.x, y: y - o.y } });
    return { ok: true, agent: body.id, slotId: body.slotId };
  }

  /** GargBot's web overlay registers its goblin and agents: they join the one roster (deduped by
   *  agent identity), so the overlay and the desk never draw two clusters. */
  async function registerOverlay(source, agents) {
    if (!reader.registerOverlay) return { ok: false, error: "this roster reader takes no overlay rows" };
    const out = reader.registerOverlay(source, agents);
    await refresh({ force: true });
    return { ...out, roster: snapshot.roster.length };
  }

  /** main's own presence poll hands its rows here, and gets the composed list back. */
  function withBase(base) {
    basePresence = Array.isArray(base) ? base : [];
    return composePresence(basePresence);
  }

  // -- the stage ---------------------------------------------------------------------

  function bodyIds() {
    const ids = [];
    if (forms.get(swarm.HOME_AGENT) === "avatar") ids.push("slot0");
    for (const slotId of slots.values()) ids.push(slotId);
    return ids;
  }

  function applyAnchor() {
    try {
      const win = avatar.window && avatar.window();
      if (win && !win.isDestroyed() && win.isVisible() && bodyIds().length) {
        const b = win.getBounds();
        orb.setSwarmAnchor({ x: b.x + b.width / 2, y: b.y + Math.round(b.height * 0.1) });
      } else {
        orb.setSwarmAnchor(null);
      }
    } catch (error) {
      log("swarm anchor failed", error && error.message);
    }
  }

  /** Size and place the avatar window for `ids`, show it, and keep its height. */
  function prepareStage(ids) {
    const win = avatar.window();
    if (!win || win.isDestroyed()) return null;
    const cur = win.getBounds();
    const size = avatar.savedSize ? avatar.savedSize() : { width: cur.width, height: cur.height };
    const height = Math.max(cur.height || 0, size.height || 640, 480);
    const centre = { x: cur.x + cur.width / 2, y: cur.y + cur.height / 2 };
    const area = avatar.workArea({ x: Math.round(centre.x), y: Math.round(centre.y) });
    const width = swarm.stageWidthFor(ids.length, height, area.width);
    let x = Math.round(centre.x - width / 2);
    x = Math.min(Math.max(area.x, x), area.x + area.width - width);
    const y = area.y + area.height - height - 12;
    try { win.setMinimumSize(1, 1); } catch { /* older electron */ }
    win.setBounds({ x, y, width, height });
    win.setOpacity(1);
    if (!win.isVisible()) win.showInactive();
    return { x, y, width, height };
  }

  /** The name tag and outline colour a body wears while hovered or selected. */
  function look(slotId, row) {
    avatar.send({ type: "slot-look", slotId, look: row ? { label: row.label, color: row.color } : null });
  }

  function place(slotId, fields) {
    avatar.send({ type: "place-avatar", slotId, ...fields });
  }

  function setResidentVisible(visible) {
    if (residentHidden === !visible) return;
    residentHidden = !visible;
    avatar.send({ type: "slot-visible", slotId: "slot0", visible });
  }

  /** Slide every body to the row for `after` while `moving` plays its frames. */
  async function tweenStage({ moving, frames, before, after }) {
    const n = frames.length;
    for (let i = 0; i < n; i += 1) {
      const t = easeInOut((i + 1) / n);
      for (const id of Object.keys(after)) {
        if (id === moving) continue;
        const from = Number.isFinite(before[id]) ? before[id] : positions.get(id) ?? after[id];
        const x = lerp(from, after[id], t);
        positions.set(id, x);
        place(id, { position: [Number(x.toFixed(4)), 0, 0] });
      }
      place(moving, { scale: frames[i].scale, yaw: frames[i].yaw, ...(after[moving] !== undefined ? { position: [after[moving], 0, 0] } : {}) });
      await wait(swarm.FRAME_MS);
    }
    for (const id of Object.keys(after)) positions.set(id, after[id]);
  }

  // -- forms -------------------------------------------------------------------------

  async function growBody(agentId, row) {
    const isResident = agentId === swarm.HOME_AGENT;
    const before = swarm.rowPositions(bodyIds());
    let slotId;
    if (isResident) {
      slotId = "slot0";
    } else {
      slotId = avatar.nextSlotId();
    }
    const ids = [...bodyIds(), slotId];
    const after = swarm.rowPositions(ids);
    const first = swarm.bodyFrames("grow", { scale: 1 });
    if (isResident) {
      setResidentVisible(true);
      prepareStage(ids);
      place("slot0", { position: [after.slot0, 0, 0], scale: first[0].scale, yaw: first[0].yaw });
      forms.set(agentId, "avatar");
      look("slot0", row);
      positions.set("slot0", after.slot0);
    } else {
      // No owner-assigned body: stay a fairy (owner 2026-11-17). Checked BEFORE the stage moves.
      if (!row || !row.character) return { ok: false, error: `${agentId} has no body chosen; it stays a fairy until you pick one in the gallery` };
      if (!bodyIds().includes("slot0")) setResidentVisible(false);
      prepareStage(ids);
      const ok = avatar.spawnSlot(slotId, row.character, agentId, { position: [after[slotId], 0, 0], scale: first[0].scale, yaw: first[0].yaw });
      if (!ok) return { ok: false, error: `could not put ${row.character} on stage for ${agentId}` };
      slots.set(agentId, slotId);
      forms.set(agentId, "avatar");
      look(slotId, row);
      positions.set(slotId, after[slotId]);
      await wait(SETTLE_MS);
    }
    await tweenStage({ moving: slotId, frames: first, before, after });
    if (!isResident) avatar.send({ type: "focus-avatar", slotId: null });
    applyAnchor();
    publish();
    return { ok: true, slotId };
  }

  async function shrinkBody(agentId) {
    const isResident = agentId === swarm.HOME_AGENT;
    const slotId = isResident ? "slot0" : slots.get(agentId);
    if (!slotId) { forms.delete(agentId); return { ok: true, already: true }; }
    const idsBefore = bodyIds();
    const idsAfter = idsBefore.filter((id) => id !== slotId);
    dropFromStage(agentId);
    const before = swarm.rowPositions(idsBefore);
    const after = swarm.rowPositions(idsAfter);
    const frames = swarm.bodyFrames("shrink", { scale: 1 });
    await tweenStage({ moving: slotId, frames, before, after: { ...after, [slotId]: before[slotId] } });
    if (isResident) {
      forms.delete(agentId);
      if (idsAfter.length) setResidentVisible(false);
    } else {
      avatar.removeSlot(slotId);
      slots.delete(agentId);
      forms.delete(agentId);
      positions.delete(slotId);
    }
    if (idsAfter.length) {
      prepareStage(idsAfter);
    } else {
      setResidentVisible(true);
      positions.delete("slot0");
      avatar.hide();
    }
    applyAnchor();
    publish();
    return { ok: true, slotId };
  }

  /**
   * Put one agent in a form. Aither is the resident body and goes through the orb's own
   * door (the fairy click does the same); GargBot's goblin is the 2D body; every other agent
   * is a stage slot wearing its own character.
   */
  function setAgentForm(agentId, form) {
    if (!swarm.isForm(form)) return Promise.resolve({ ok: false, error: `form must be one of ${swarm.FORMS.join(", ")}` });
    const id = swarm.rosterId(agentId);
    return serial(async () => {
      if (!snapshot.roster.length) await refresh();
      const row = rosterRow(id);
      if (!row) return { ok: false, error: `${agentId} is not in the live roster` };
      const was = forms.get(id) === "avatar" ? "avatar" : "fairy";
      if (id === swarm.GOBLIN_ID) return goblinForm(form, row);
      if (was === form) return { ok: true, agent: id, form, already: true };
      if (id === swarm.HOME_AGENT) {
        const r = form === "avatar" ? await orb.expand() : await orb.collapse();
        if (!r || r.ok === false) return { ok: false, agent: id, error: (r && r.error) || "the orb did not answer" };
        publish();
        return { ok: true, agent: id, form, character: row.character };
      }
      const r = form === "avatar" ? await growBody(id, row) : await shrinkBody(id);
      if (!r.ok) return { ok: false, agent: id, error: r.error };
      if (form === "avatar") talkTo(id);
      return { ok: true, agent: id, form, slotId: r.slotId, character: row.character };
    });
  }

  async function goblinForm(form, row) {
    if (form === "avatar") {
      const r = await goblin.summon({ from: orb.fairyBounds() });
      if (r && r.ok) { forms.set(row.id, "avatar"); talkTo(row.id); }
      return { ok: Boolean(r && r.ok), agent: row.id, form, character: "goblin", error: r && r.error };
    }
    const r = await goblin.dismiss({ to: orb.fairyBounds() });
    if (r && r.ok) forms.delete(row.id);
    return { ok: Boolean(r && r.ok), agent: row.id, form, error: r && r.error };
  }

  /** The goblin's window closed by itself (right-click on him): the form follows. */
  function goblinChanged({ summoned }) {
    if (!summoned) forms.delete(swarm.GOBLIN_ID);
    else forms.set(swarm.GOBLIN_ID, "avatar");
  }

  /** The orb grew or shrank Aither by itself (a fairy click): the form follows. */
  function residentChanged(form) {
    if (form === "avatar") { forms.set(swarm.HOME_AGENT, "avatar"); look("slot0", rosterRow(swarm.HOME_AGENT)); }
    else forms.delete(swarm.HOME_AGENT);
    publish();
    // The orb hides its cluster right after its expand hook returns; re-anchor once it has.
    const t = setTimeout(applyAnchor, 120);
    if (t.unref) t.unref();
  }

  /**
   * The whole swarm at once, staggered so it reads as a wave. `avatar` honours the mode
   * (light mode keeps terminals, subagents and remote endpoints small); `include: "all"`
   * overrides that for one call.
   */
  async function setAllForms(form, { include = "" } = {}) {
    if (!swarm.isForm(form)) return { ok: false, error: `form must be one of ${swarm.FORMS.join(", ")}` };
    await refresh();
    const useMode = include === "all" ? "full" : mode;
    const targets = swarm.targetsFor(snapshot.roster, forms, form, useMode);
    const results = [];
    for (const id of targets) {
      results.push(await setAgentForm(id, form));
      await wait(90);
    }
    return {
      ok: results.every((r) => r.ok),
      form,
      mode: useMode,
      changed: results.filter((r) => r.ok && !r.already).map((r) => r.agent),
      failed: results.filter((r) => !r.ok).map((r) => ({ agent: r.agent, error: r.error })),
    };
  }

  function setMode(next) {
    if (!swarm.MODES.includes(next)) return { ok: false, error: `mode must be one of ${swarm.MODES.join(", ")}` };
    mode = next;
    return { ok: true, mode };
  }

  async function showSwarm(on) {
    await refresh();
    // ONE cluster (owner rule): while the awdesk swarm is up, the AitherOS / GargBot web overlay
    // keeps no companions of its own (orb-window setTenantCompanion hides its [data-companion]).
    if (on !== false && typeof orb.hideTenantCompanion === "function") {
      try { orb.hideTenantCompanion(); } catch { /* the overlay may not be up */ }
    }
    return orb.setSwarmVisible(on !== false);
  }

  // -- stages ------------------------------------------------------------------------

  const grown = (agentId) => forms.get(agentId) === "avatar" || (agentId === swarm.GOBLIN_ID && goblin.isSummoned());

  function dropFromStage(agentId) {
    const st = stageOf(agentId);
    if (!st) return;
    st.members.delete(agentId);
    if (st.members.size < 2) stages.delete(st.id); // a stage of one is not a stage
  }

  /** The slot a stage member's body stands in (the goblin has no slot: it is not arranged). */
  const memberSlot = (agentId) => (agentId === swarm.GOBLIN_ID ? null : slotFor(agentId));

  function stageResult(st) {
    return { id: st.id, members: [...st.members], locked: st.locked };
  }

  /** Re-seat a stage bodies in `mode` (row | circle) around the stage current centre. */
  function seat(st, mode, { cx = null } = {}) {
    const slotsOf = [...st.members].map(memberSlot).filter(Boolean);
    if (slotsOf.length < 1) return;
    const xs = slotsOf.map((id) => positions.get(id)).filter((x) => Number.isFinite(x));
    const centre = cx !== null ? cx : (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
    if (mode === "circle") {
      const ring = swarm.circlePositions(slotsOf.length, centre);
      slotsOf.forEach((id, i) => {
        positions.set(id, ring[i].x);
        place(id, { position: [ring[i].x, 0, ring[i].z], yaw: ring[i].yaw });
      });
    } else {
      const row = swarm.rowPositions(slotsOf);
      slotsOf.forEach((id) => {
        const x = Math.max(-swarm.STAGE_BOUND, Math.min(swarm.STAGE_BOUND, row[id] + centre));
        positions.set(id, x);
        place(id, { position: [Number(x.toFixed(4)), 0, 0], yaw: 0 });
      });
    }
  }

  /** The agent standing in `slotId` (the resident body is Aither), or "". */
  function agentOfSlot(slotId) {
    if (slotId === "slot0") return swarm.HOME_AGENT;
    for (const [agentId, id] of slots) if (id === slotId) return agentId;
    return "";
  }

  /** The stage `slotId`'s body stands in, or null. */
  function stageOfSlot(slotId) {
    const agentId = agentOfSlot(slotId);
    return agentId ? stageOf(agentId) : null;
  }

  /** What the renderer draws a handle over: every stage with its bodies' slots. */
  function stageGroups() {
    return [...stages.values()].map((st) => ({
      id: st.id,
      locked: st.locked,
      members: [...st.members],
      slots: [...st.members].map(memberSlot).filter(Boolean),
    }));
  }

  let publishedStages = false;
  let lastStagesKey = "[]";
  function publishStages({ force = false } = {}) {
    publishedStages = stages.size > 0;
    // Only when the groups changed: the renderer re-draws the handles on every new array (review of #105).
    const groups = stageGroups();
    const key = JSON.stringify(groups);
    if (!force && key === lastStagesKey) return;
    lastStagesKey = key;
    try { avatar.send({ type: "stage-groups", groups }); } catch (error) { log("stage groups failed", error && error.message); }
  }

  /** A body dropped on another in the renderer: they join one stage. */
  function joinSlots(slotId, targetSlotId) {
    const agent = agentOfSlot(slotId);
    const target = agentOfSlot(targetSlotId);
    if (!agent || !target) return { ok: false, error: "that body is not an agent on this stage" };
    return stageOp("join", { agent, target });
  }

  /** Right-click > Leave stage. */
  function leaveSlot(slotId) {
    const agent = agentOfSlot(slotId);
    return agent ? stageOp("leave", { agent }) : { ok: false, error: "that body is not an agent on this stage" };
  }

  /** A stage moved by its handle: keep our copy of where its bodies stand ({slotId: x}). */
  function syncPositions(raw) {
    if (!raw || typeof raw !== "object") return { ok: false };
    for (const [slotId, x] of Object.entries(raw).slice(0, 64)) {
      if (agentOfSlot(slotId) && Number.isFinite(Number(x))) positions.set(slotId, Number(x));
    }
    return { ok: true };
  }

  /**
   * One verb for every stage control: join (agent -> target stage), leave, lock, arrange
   * (row | circle), move (dx world units), size (scale), turn (yaw radians), state.
   */
  function stageOp(op, args = {}) {
    const out = stageOpInner(op, args);
    if (out && out.ok && op !== "state") publishStages();
    return out;
  }

  function stageOpInner(op, args = {}) {
    const id = args.agent ? swarm.rosterId(args.agent) : "";
    switch (op) {
      case "state":
        return { ok: true, stages: [...stages.values()].map(stageResult) };
      case "join": {
        const target = swarm.rosterId(args.target || "");
        if (!id || !target || id === target) return { ok: false, error: "join needs two different agents: agent + target" };
        if (!grown(id) || !grown(target)) return { ok: false, error: "both agents must be grown into avatars to share a stage" };
        let st = stageOf(target);
        const mine = stageOf(id);
        if (mine && st && mine.id === st.id) return { ok: true, stage: stageResult(st), already: true };
        if (mine && mine.locked) return { ok: false, error: `${id} is in a locked stage; unlock it or leave first` };
        if (!st) {
          stageSeq += 1;
          st = { id: `stage${stageSeq}`, members: new Set([target]), locked: false };
          stages.set(st.id, st);
        } else if (st.locked) {
          return { ok: false, error: `${target} stage is locked` };
        }
        dropFromStage(id);
        st.members.add(id);
        seat(st, args.mode === "circle" ? "circle" : "row", { cx: positions.get(memberSlot(target)) ?? 0 });
        return { ok: true, stage: stageResult(st) };
      }
      case "leave": {
        const st = id ? stageOf(id) : null;
        if (!st) return { ok: true, already: true };
        dropFromStage(id);
        const slot = memberSlot(id);
        if (slot) {
          // Step out to the nearest free lane so it does not stay on top of the group.
          const taken = [...positions.entries()].filter(([s]) => s !== slot).map(([, x]) => x);
          let x = Math.min(swarm.STAGE_BOUND, (positions.get(slot) ?? 0) + 1.3);
          if (taken.some((t) => Math.abs(t - x) < 0.9)) x = Math.max(-swarm.STAGE_BOUND, (positions.get(slot) ?? 0) - 1.3);
          positions.set(slot, x);
          place(slot, { position: [Number(x.toFixed(4)), 0, 0], yaw: 0 });
        }
        return { ok: true, left: id };
      }
      case "lock": {
        const st = id ? stageOf(id) : [...stages.values()][0];
        if (!st) return { ok: false, error: "no such stage" };
        st.locked = args.locked !== false;
        return { ok: true, stage: stageResult(st) };
      }
      case "arrange":
      case "move":
      case "size":
      case "turn": {
        const st = (id && stageOf(id)) || (args.stage && stages.get(args.stage)) || (!id && [...stages.values()][0]) || null;
        if (!st) return { ok: false, error: "no such stage" };
        const slotsOf = [...st.members].map(memberSlot).filter(Boolean);
        if (op === "arrange") seat(st, args.mode === "circle" ? "circle" : "row");
        if (op === "move") {
          const dx = Number(args.dx) || 0;
          for (const s of slotsOf) {
            const x = Math.max(-swarm.STAGE_BOUND, Math.min(swarm.STAGE_BOUND, (positions.get(s) ?? 0) + dx));
            positions.set(s, x);
            place(s, { position: [Number(x.toFixed(4)), 0, 0] });
          }
        }
        if (op === "size") for (const s of slotsOf) place(s, { scale: Math.max(0.3, Math.min(3, Number(args.scale) || 1)) });
        if (op === "turn") for (const s of slotsOf) place(s, { yaw: Number(args.yaw) || 0 });
        return { ok: true, stage: stageResult(st) };
      }
      default:
        return { ok: false, error: `unknown stage op "${op}"` };
    }
  }

  // -- talking -----------------------------------------------------------------------

  function slotFor(agentId) {
    if (agentId === swarm.HOME_AGENT) return "slot0";
    return slots.get(agentId) || "slot0";
  }

  /** Whose fairy / body the owner is talking to: voice goes to them for a while. */
  function talkTo(agentId, { openChat = false } = {}) {
    const id = swarm.rosterId(agentId);
    if (!id) return { ok: false, error: "not an agent" };
    voiceTarget = { agent: id, until: now() + VOICE_TARGET_MS };
    // Opening the chat is the fairy click's job (orb-window -> main's chat hook, which calls
    // back here); a grow or a voice target alone must not throw a window at the owner.
    if (openChat) {
      try { orb.chat(id); } catch { /* the chat door is optional */ }
    }
    return { ok: true, agent: id };
  }

  function currentTarget() {
    if (voiceTarget && voiceTarget.until > now()) return voiceTarget.agent;
    voiceTarget = null;
    return null;
  }

  /**
   * Speak as an agent. `input`: a string, {text, voice?, speed?}, {audioBase64, mime?,
   * volume?} for pre-rendered audio, or a stream / async iterable of audio Buffers (drained
   * whole, then played -- playback starts when the stream ends). The mouth that moves is
   * the agent's own body (its slot, or slot0 for the resident); the voice is the agent's
   * own (cast.json authors[<agent>].voice, else voice-resolve's stable pick).
   */
  async function speak(agentId, input) {
    const id = swarm.rosterId(agentId);
    if (!id) return { ok: false, error: "not an agent" };
    const slotId = slotFor(id);
    const form = forms.get(id) === "avatar" ? "avatar" : "fairy";
    // A coding session, a subagent or a remote endpoint is silent unless the owner opted it into a voice
    // (speech-arbiter.cjs, owner 2026-11-16): the flag rides to main's speakAloud.
    const speakRow = rosterRow(id);
    const speaker = { agent: id, ...(speakRow && (speakRow.kind === "session" || speakRow.kind === "subagent" || speakRow.kind === "remote" || String(id).startsWith("session-")) ? { session: true, author: id, seat: 0 } : {}) };
    if (id === swarm.GOBLIN_ID) goblin.setMood("talking", { forMs: 4000 });
    try {
      if (typeof input === "string" || (input && typeof input === "object" && typeof input.text === "string" && !input.audioBase64)) {
        const o = typeof input === "string" ? { text: input } : input;
        const r = await speakAloud(String(o.text), o.voice || undefined, o.speed, slotId, "service:awdesk-swarm", speaker);
        if (id === swarm.GOBLIN_ID && r && r.durationMs) goblin.setMood("talking", { forMs: r.durationMs + 300 });
        return { ...r, agent: id, form, slotId };
      }
      let audio;
      let mime = "";
      let volume;
      if (input && typeof input === "object" && typeof input.audioBase64 === "string") {
        audio = Buffer.from(input.audioBase64, "base64");
        mime = String(input.mime || "");
        volume = input.volume;
      } else {
        const source = input && typeof input === "object" && input.audioStream ? input.audioStream : input;
        audio = await drainAudio(source);
        if (input && typeof input === "object" && input.volume != null) volume = input.volume;
        mime = String((input && input.mime) || "");
      }
      if (!audio.length) return { ok: false, agent: id, error: "empty audio" };
      const delivered = playAudio({ slotId, audioBase64: audio.toString("base64"), volume, mime });
      if (id === swarm.GOBLIN_ID) goblin.setMood("talking", { forMs: 4000 });
      return { ok: delivered > 0, agent: id, form, slotId, bytes: audio.length, windows: delivered, streamed: false };
    } catch (error) {
      return { ok: false, agent: id, error: String((error && error.message) || error) };
    }
  }

  /**
   * Mouth shapes for an agent's body: {aa, ee, ih, oh, ou} (0..1) held for ttlMs, or
   * {frames: [{t, aa..}]} played from now (t in ms), or null to release. A frame stream is
   * the lip-sync driver's job; this only forwards, it does not guess.
   */
  function visemes(agentId, input, ttlMs = 250) {
    const id = swarm.rosterId(agentId);
    if (!id) return { ok: false, error: "not an agent" };
    const slotId = slotFor(id);
    if (input === null || input === undefined) {
      avatar.send({ type: "viseme", slotId, weights: null });
      return { ok: true, agent: id, slotId, released: true };
    }
    if (input && Array.isArray(input.frames)) {
      const frames = input.frames.slice(0, MAX_VISEME_FRAMES);
      const hold = Number(input.ttlMs) > 0 ? Number(input.ttlMs) : ttlMs;
      for (const f of frames) {
        const t = Math.max(0, Number(f && f.t) || 0);
        const timer = setTimeout(() => avatar.send({ type: "viseme", slotId, weights: f, ttlMs: hold }), t);
        if (timer.unref) timer.unref();
      }
      const end = setTimeout(() => avatar.send({ type: "viseme", slotId, weights: null }), Math.max(0, ...frames.map((f) => Number(f && f.t) || 0)) + hold + 50);
      if (end.unref) end.unref();
      return { ok: true, agent: id, slotId, scheduled: frames.length };
    }
    avatar.send({ type: "viseme", slotId, weights: input, ttlMs });
    return { ok: true, agent: id, slotId };
  }

  /**
   * A transcript from push-to-talk, while the owner is talking to an agent: ask THAT agent
   * and speak the answer in ITS voice, from ITS body. Returns null when nobody is the
   * target (the desk's own command path then runs, unchanged).
   */
  async function handleVoice(text) {
    const target = currentTarget();
    const said = String(text || "").trim();
    if (!target || !said || typeof askAgent !== "function") return null;
    const row = rosterRow(target);
    if (!row || row.kind === "session" || row.kind === "subagent" || row.kind === "remote") return null;
    voiceTarget = { agent: target, until: now() + VOICE_TARGET_MS };
    let reply;
    try { reply = String((await askAgent(target, said)) || "").trim(); } catch (error) { log("swarm ask failed", error && error.message); }
    if (!reply) reply = `${row.label} could not answer just now.`;
    const spoken = await speak(target, reply.slice(0, 800));
    return { ok: true, agent: target, text: said, reply, spoken };
  }

  // -- the public state ----------------------------------------------------------------

  /** The hovered / selected body, named by agent (the avatar window reports slots). */
  function pickInfo() {
    const raw = avatar.pick ? avatar.pick() : null;
    const agentOf = (slotId) => {
      if (!slotId) return null;
      if (slotId === "slot0") return swarm.HOME_AGENT;
      for (const [agent, s] of slots) if (s === slotId) return agent;
      return null;
    };
    return {
      hover: raw && raw.hover ? { slotId: raw.hover, agent: agentOf(raw.hover) } : null,
      selected: raw && raw.selected ? { slotId: raw.selected, agent: agentOf(raw.selected) } : null,
    };
  }

  function state() {
    return {
      ok: true,
      mode,
      swarmVisible: Boolean(orb.swarmVisible && orb.swarmVisible()),
      at: snapshot.at,
      sources: snapshot.sources,
      roster: snapshot.roster.map((r) => swarm.publicRow(r, forms)),
      bodies: [...(forms.get(swarm.HOME_AGENT) === "avatar" ? [{ agent: swarm.HOME_AGENT, slotId: "slot0" }] : []), ...[...slots.entries()].map(([agent, slotId]) => ({ agent, slotId }))],
      goblin: { summoned: Boolean(goblin.isSummoned()) },
      talkingTo: currentTarget(),
      stages: [...stages.values()].map(stageResult),
      pick: pickInfo(),
    };
  }

  /** The orb's expand / collapse hooks call these when other bodies already hold the stage. */
  async function growResidentIntoStage() {
    const r = await growBody(swarm.HOME_AGENT, rosterRow(swarm.HOME_AGENT) || { character: swarm.DEFAULT_BODY });
    return r.ok ? { ok: true, stage: true } : r;
  }

  async function shrinkResidentFromStage() {
    const r = await shrinkBody(swarm.HOME_AGENT);
    return r.ok ? { ok: true, stage: true } : r;
  }

  return {
    growResidentIntoStage,
    shrinkResidentFromStage,
    refresh,
    state,
    withBase,
    composePresence,
    setAgentForm,
    setAllForms,
    setMode,
    showSwarm,
    talkTo,
    speak,
    visemes,
    handleVoice,
    stageOp,
    perceive,
    act,
    walkTo,
    lookAt,
    publishScreenContext,
    subscribeScreenContext,
    registerOverlay,
    joinSlots,
    leaveSlot,
    syncPositions,
    stageOfSlot,
    agentOfSlot,
    stageGroups,
    publishStages,
    goblinChanged,
    residentChanged,
    ownsSlot: (slotId) => [...slots.values()].includes(slotId),
    hasBodies: () => slots.size > 0,
    hasStage: () => bodyIds().length > 0,
    mode: () => mode,
    anchor: applyAnchor,
    drainAudio,
  };
}

module.exports = { createSwarmHost, drainAudio };
