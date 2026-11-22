"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { Readable } = require("node:stream");
const swarm = require("./agent-swarm.cjs");
const { createSwarmHost } = require("./agent-swarm-host.cjs");

function roster() {
  return swarm.withIdentity(swarm.mergeRoster([
    { id: "aither", kind: "persona", bot: true, source: "discord" },
    { id: "atlas", kind: "persona", bot: true, state: "working", source: "discord" },
    { id: "hera", kind: "persona", bot: true, source: "discord" },
    swarm.goblinRow(),
    { id: "session-aaaa1111", label: "Music video", kind: "session", state: "waiting", source: "sessions" },
    { id: "remote-box", label: "box", kind: "remote", source: "remote" },
  ]), { authors: OWNER_AUTHORS, characters: new Set(["aither-v2", "aither-m", "charlie-5e48d775", "hera"]) });
}

/** The bodies the OWNER assigned (cast.json authors). Since 2026-11-17 nothing else grows a body. */
const OWNER_AUTHORS = Object.freeze({
  atlas: { character: "charlie-5e48d775", voice: "en-US-MichelleNeural" },
  hera: { character: "hera" },
  "session-aaaa1111": { character: "aither-m" },
  "remote-box": { character: "aither-v2" },
});

function harness({ spawnOk = true, rows = null } = {}) {
  const sent = [];
  const spoke = [];
  const audio = [];
  const calls = [];
  let presence = [];
  let anchor = "unset";
  let slotN = 0;
  const win = {
    bounds: { x: 100, y: 100, width: 420, height: 640 },
    visible: false,
    isDestroyed: () => false,
    isVisible() { return this.visible; },
    getBounds() { return { ...this.bounds }; },
    setBounds(b) { this.bounds = { ...b }; },
    setOpacity() {},
    setMinimumSize() {},
    showInactive() { this.visible = true; },
  };
  const goblinState = { summoned: false };
  const host = createSwarmHost({
    reader: { read: async () => ({ roster: rows || roster(), sources: { discord: { ok: true } }, at: 1 }) },
    avatar: {
      window: () => win,
      savedSize: () => ({ width: 420, height: 640 }),
      workArea: () => ({ x: 0, y: 0, width: 3000, height: 1000 }),
      nextSlotId: () => `slot${++slotN}`,
      spawnSlot: (slotId, name, agent, place) => { calls.push(["spawn", slotId, name, agent, place]); return spawnOk; },
      removeSlot: (slotId) => { calls.push(["remove", slotId]); return true; },
      send: (e) => sent.push(e),
      hide: () => { win.visible = false; calls.push(["hide"]); },
    },
    orb: {
      setPresence: (list) => { presence = list; },
      setSwarmAnchor: (p) => { anchor = p; },
      setSwarmVisible: (on) => ({ ok: true, swarm: on }),
      swarmVisible: () => true,
      fairyBounds: () => ({ x: 1800, y: 900, width: 72, height: 72 }),
      chat: (agent) => calls.push(["chat", agent]),
      expand: async () => { host.residentChanged("avatar"); return { ok: true }; },
      collapse: async () => { host.residentChanged("fairy"); return { ok: true }; },
    },
    goblin: {
      summon: async () => { goblinState.summoned = true; return { ok: true }; },
      dismiss: async () => { goblinState.summoned = false; return { ok: true }; },
      setMood: (m) => calls.push(["mood", m]),
      isSummoned: () => goblinState.summoned,
    },
    speakAloud: async (text, voice, speed, slotId, origin, speaker) => { spoke.push({ text, slotId, origin, speaker }); return { ok: true, durationMs: 1200 }; },
    playAudio: (a) => { audio.push(a); return 1; },
    askAgent: async (agent, text) => `${agent} heard: ${text}`,
    wait: async () => {},
  });
  return { host, sent, spoke, audio, calls, win, goblinState, presence: () => presence, anchor: () => anchor };
}

test("grow one agent: a stage slot with ITS character and agent, tiny at first, exactly full after, gone from the swarm", async () => {
  const h = harness();
  await h.host.refresh();
  assert.ok(h.presence().some((r) => r.agent === "atlas"), "atlas starts as a fairy");
  const r = await h.host.setAgentForm("atlas", "avatar");
  assert.equal(r.ok, true);
  assert.equal(r.slotId, "slot1");
  const spawn = h.calls.find((c) => c[0] === "spawn");
  assert.deepEqual(spawn.slice(1, 4), ["slot1", "charlie-5e48d775", "atlas"]);
  assert.ok(spawn[4].scale < 0.5, "the body appears fairy-sized");
  const places = h.sent.filter((e) => e.type === "place-avatar" && e.slotId === "slot1" && e.scale !== undefined);
  assert.equal(places.length, swarm.FRAMES);
  assert.equal(places[places.length - 1].scale, 1);
  assert.equal(places[places.length - 1].yaw, 0);
  assert.ok(!h.presence().some((r2) => r2.agent === "atlas"), "a grown agent leaves the fairy swarm");
  assert.equal(h.win.visible, true);
  assert.ok(h.sent.some((e) => e.type === "slot-visible" && e.slotId === "slot0" && e.visible === false), "the resident is hidden while Aither is a fairy");
  assert.ok(h.anchor() && h.anchor().x > 0, "the one cluster is anchored over the stage");
  assert.equal(h.host.state().roster.find((x) => x.id === "atlas").form, "avatar");
});

test("shrink: the body goes back to fairy size, its slot is removed, the stage hides, the fairy returns", async () => {
  const h = harness();
  await h.host.setAgentForm("atlas", "avatar");
  const r = await h.host.setAgentForm("atlas", "fairy");
  assert.equal(r.ok, true);
  assert.deepEqual(h.calls.filter((c) => c[0] === "remove"), [["remove", "slot1"]]);
  assert.equal(h.win.visible, false);
  assert.ok(h.sent.some((e) => e.type === "slot-visible" && e.slotId === "slot0" && e.visible === true), "the resident is shown again");
  assert.ok(h.presence().some((x) => x.agent === "atlas"), "atlas is a fairy again");
  assert.equal(h.anchor(), null);
  const down = h.sent.filter((e) => e.type === "place-avatar" && e.slotId === "slot1" && e.scale !== undefined).slice(-swarm.FRAMES);
  assert.ok(down[0].scale > down[down.length - 1].scale);
});

test("two bodies share a row: the first slides over as the second grows", async () => {
  const h = harness();
  await h.host.setAgentForm("atlas", "avatar");
  h.sent.length = 0;
  await h.host.setAgentForm("hera", "avatar");
  const xs = h.sent.filter((e) => e.type === "place-avatar" && e.slotId === "slot1" && e.position).map((e) => e.position[0]);
  assert.ok(xs.length >= 2 && xs[0] !== xs[xs.length - 1], "atlas slides to make room");
  assert.deepEqual(h.host.state().bodies.map((b) => b.agent), ["atlas", "hera"]);
  assert.ok(h.win.bounds.width > 420, "the stage window widens for two bodies");
});

test("Aither grows through the orb's own door, and the swarm hears about it", async () => {
  const h = harness();
  const r = await h.host.setAgentForm("aither", "avatar");
  assert.equal(r.ok, true);
  assert.equal(h.host.state().roster.find((x) => x.id === "aither").form, "avatar");
  assert.deepEqual(h.host.state().bodies, [{ agent: "aither", slotId: "slot0" }]);
  const back = await h.host.setAgentForm("aither", "fairy");
  assert.equal(back.ok, true);
  assert.deepEqual(h.host.state().bodies, []);
});

test("light mode: grow-all grows the Aitherium agents only (terminals and remotes stay fairies); full mode grows all", async () => {
  const h = harness();
  const all = await h.host.setAllForms("avatar");
  assert.equal(all.mode, "light");
  assert.deepEqual(all.changed.sort(), ["aither", "atlas", "gargbot", "hera"]);
  assert.equal(h.goblinState.summoned, true);
  const state = h.host.state();
  assert.equal(state.roster.find((x) => x.id === "session-aaaa1111").form, "fairy");
  assert.equal(state.roster.find((x) => x.id === "remote-box").form, "fairy");
  const rows = h.presence();
  assert.ok(rows.some((x) => x.agent === "session-aaaa1111" && x.belongsTo === "aither"), "the terminal still orbits Aither");
  const shrunk = await h.host.setAllForms("fairy");
  assert.deepEqual(shrunk.changed.sort(), ["aither", "atlas", "gargbot", "hera"]);
  assert.equal(h.goblinState.summoned, false);
  assert.deepEqual(h.host.state().bodies, []);
  h.host.setMode("full");
  const full = await h.host.setAllForms("avatar");
  assert.ok(full.changed.includes("session-aaaa1111") && full.changed.includes("remote-box"));
});

test("a single named terminal the owner gave a body can always be grown, even in light mode", async () => {
  const h = harness();
  const r = await h.host.setAgentForm("session-aaaa1111", "avatar");
  assert.equal(r.ok, true);
  assert.equal(h.calls.find((c) => c[0] === "spawn")[2], "aither-m", "the body the owner assigned, nothing else");
});

test("the goblin is summoned and dismissed on demand", async () => {
  const h = harness();
  assert.equal((await h.host.setAgentForm("gargbot", "avatar")).ok, true);
  assert.equal(h.host.state().goblin.summoned, true);
  assert.equal(h.host.state().roster.find((x) => x.id === "gargbot").form, "avatar");
  assert.equal((await h.host.setAgentForm("gargbot", "fairy")).ok, true);
  assert.equal(h.host.state().goblin.summoned, false);
});

test("unknown agent and bad form are refused with the reason; a failed spawn leaves no half-grown body", async () => {
  const h = harness({ spawnOk: false });
  assert.match((await h.host.setAgentForm("nobody", "avatar")).error, /not in the live roster/);
  assert.match((await h.host.setAgentForm("atlas", "giant")).error, /form must be/);
  const r = await h.host.setAgentForm("atlas", "avatar");
  assert.equal(r.ok, false);
  assert.deepEqual(h.host.state().bodies, []);
  assert.equal(h.host.state().roster.find((x) => x.id === "atlas").form, "fairy");
});

test("speak: text goes through the agent's own slot and identity; a fairy agent still speaks as itself", async () => {
  const h = harness();
  await h.host.setAgentForm("atlas", "avatar");
  const a = await h.host.speak("atlas", "hello");
  assert.equal(a.ok, true);
  assert.equal(h.spoke[0].slotId, "slot1");
  assert.deepEqual(h.spoke[0].speaker, { agent: "atlas" });
  const b = await h.host.speak("hera", { text: "hi there", voice: "x" });
  assert.equal(b.form, "fairy");
  assert.equal(h.spoke[1].slotId, "slot0");
  assert.deepEqual(h.spoke[1].speaker, { agent: "hera" });
});

test("speak: pre-rendered audio and a stream of chunks are played whole on the agent's body", async () => {
  const h = harness();
  await h.host.setAgentForm("atlas", "avatar");
  const wav = Buffer.from("RIFF....WAVEfmt ");
  const one = await h.host.speak("atlas", { audioBase64: wav.toString("base64"), volume: 0.5 });
  assert.equal(one.ok, true);
  assert.equal(h.audio[0].slotId, "slot1");
  assert.equal(h.audio[0].volume, 0.5);
  const stream = Readable.from([Buffer.from("RIFF"), Buffer.from("....WAVE")]);
  const two = await h.host.speak("atlas", stream);
  assert.equal(two.ok, true);
  assert.equal(two.bytes, 12);
  assert.equal(Buffer.from(h.audio[1].audioBase64, "base64").toString(), "RIFF....WAVE");
  assert.equal((await h.host.speak("atlas", Readable.from([]))).error, "empty audio");
  assert.match((await h.host.speak("atlas", 42)).error, /Buffer, a stream/);
});

test("visemes: weights go to the agent's slot, a frame list is scheduled, null releases", async () => {
  const h = harness();
  await h.host.setAgentForm("atlas", "avatar");
  h.sent.length = 0;
  assert.equal(h.host.visemes("atlas", { aa: 0.9, ou: 0.2 }, 120).slotId, "slot1");
  assert.deepEqual(h.sent[0], { type: "viseme", slotId: "slot1", weights: { aa: 0.9, ou: 0.2 }, ttlMs: 120 });
  assert.equal(h.host.visemes("atlas", null).released, true);
  assert.deepEqual(h.sent[1], { type: "viseme", slotId: "slot1", weights: null });
  const r = h.host.visemes("atlas", { frames: [{ t: 0, aa: 1 }, { t: 30, ee: 1 }] });
  assert.equal(r.scheduled, 2);
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.ok(h.sent.filter((e) => e.type === "viseme" && e.weights).length >= 3);
});

test("voice: while the owner is talking to an agent, a transcript is asked of THAT agent and answered in its voice and body", async () => {
  const h = harness();
  assert.equal(await h.host.handleVoice("hello"), null, "nobody is the target yet");
  await h.host.setAgentForm("atlas", "avatar"); // growing an agent makes it the one you talk to
  const r = await h.host.handleVoice("what is blocked?");
  assert.equal(r.agent, "atlas");
  assert.equal(r.reply, "atlas heard: what is blocked?");
  assert.equal(h.spoke.at(-1).slotId, "slot1");
  assert.deepEqual(h.spoke.at(-1).speaker, { agent: "atlas" });
  h.host.talkTo("session-aaaa1111");
  assert.equal(await h.host.handleVoice("hi"), null, "a terminal is not asked through the agent door");
});

test("presence composition: the platform's rows are merged with the swarm's, a grown agent is dropped from both", async () => {
  const h = harness();
  await h.host.refresh();
  const merged = h.host.withBase([
    { agent: "atlas", label: "Atlas", state: "working", work: [{ title: "PR 12", url: "https://x" }], discord: { bot: true } },
    { agent: "aeon", label: "Aeon", state: "idle", work: [] },
  ]);
  const atlas = merged.find((r) => r.agent === "atlas");
  assert.equal(atlas.work.length, 1, "platform work links survive");
  assert.equal(atlas.kind, "persona", "and the swarm's kind joins them");
  assert.ok(merged.some((r) => r.agent === "aeon"));
  await h.host.setAgentForm("atlas", "avatar");
  assert.ok(!h.host.withBase([{ agent: "atlas", label: "Atlas", state: "idle", work: [] }]).some((r) => r.agent === "atlas"));
});

test("form changes are serialised: two grows never tween over each other", async () => {
  const h = harness();
  const [a, b] = await Promise.all([h.host.setAgentForm("atlas", "avatar"), h.host.setAgentForm("hera", "avatar")]);
  assert.ok(a.ok && b.ok);
  assert.deepEqual(h.host.state().bodies.map((x) => x.slotId), ["slot1", "slot2"]);
});

test("stages: join makes an explicit group that arranges, moves, sizes and turns together; leave splits it", async () => {
  const h = harness();
  await h.host.setAgentForm("atlas", "avatar");
  await h.host.setAgentForm("hera", "avatar");
  assert.equal(h.host.stageOp("join", { agent: "hera", target: "atlas" }).ok, true);
  const st = h.host.stageOp("state").stages;
  assert.deepEqual(st[0].members.sort(), ["atlas", "hera"]);
  assert.equal(h.host.state().stages.length, 1);
  h.sent.length = 0;
  h.host.stageOp("arrange", { agent: "atlas", mode: "circle" });
  const circle = h.sent.filter((e) => e.type === "place-avatar");
  assert.equal(circle.length, 2);
  assert.ok(circle.every((e) => Number.isFinite(e.position[2]) && e.yaw !== undefined), "a circle uses depth and turns bodies inward");
  h.sent.length = 0;
  h.host.stageOp("move", { agent: "atlas", dx: 0.5 });
  assert.equal(h.sent.filter((e) => e.type === "place-avatar").length, 2, "the whole group moves");
  h.host.stageOp("size", { agent: "atlas", scale: 1.4 });
  h.host.stageOp("turn", { agent: "atlas", yaw: 0.3 });
  assert.ok(h.sent.some((e) => e.scale === 1.4) && h.sent.some((e) => e.yaw === 0.3));
  assert.equal(h.host.stageOp("leave", { agent: "hera" }).left, "hera");
  assert.deepEqual(h.host.stageOp("state").stages, [], "a stage of one is not a stage");
});

test("stages: a locked stage refuses joins and never loses a member by itself; only grown agents can join", async () => {
  const h = harness();
  await h.host.setAgentForm("atlas", "avatar");
  await h.host.setAgentForm("hera", "avatar");
  h.host.stageOp("join", { agent: "hera", target: "atlas" });
  assert.equal(h.host.stageOp("lock", { agent: "atlas" }).stage.locked, true);
  const third = await h.host.setAgentForm("session-aaaa1111", "avatar");
  assert.equal(third.ok, true);
  const refused = h.host.stageOp("join", { agent: "session-aaaa1111", target: "atlas" });
  assert.equal(refused.ok, false);
  assert.match(refused.error, /locked/);
  assert.match(h.host.stageOp("join", { agent: "remote-box", target: "atlas" }).error, /grown/);
  assert.match(h.host.stageOp("nope").error, /unknown stage op/);
});

test("stages by direct manipulation: a body dropped on another joins, the renderer is told the groups, Leave stage splits, a moved stage is remembered", async () => {
  const h = harness();
  await h.host.setAgentForm("atlas", "avatar");
  await h.host.setAgentForm("hera", "avatar");
  const slotOf = (agent) => h.host.state().bodies.find((b) => b.agent === agent).slotId;
  assert.equal(h.host.stageOfSlot(slotOf("hera")), null, "no stage until one is made");
  h.sent.length = 0;
  const joined = h.host.joinSlots(slotOf("hera"), slotOf("atlas"));
  assert.equal(joined.ok, true);
  const groups = h.sent.filter((e) => e.type === "stage-groups");
  assert.equal(groups.length, 1, "one stage-groups event per change");
  assert.deepEqual(groups[0].groups[0].slots.sort(), [slotOf("atlas"), slotOf("hera")].sort());
  assert.deepEqual(groups[0].groups[0].members.sort(), ["atlas", "hera"]);
  assert.ok(h.host.stageOfSlot(slotOf("hera")), "the right-click menu offers Leave stage for a body in a stage");
  assert.equal(h.host.joinSlots("slotNope", slotOf("atlas")).ok, false, "a body that is not an agent on this stage joins nothing");

  // The stage moved by its handle: main keeps the renderer's positions, so a later arrange starts from them.
  assert.equal(h.host.syncPositions({ [slotOf("atlas")]: 1.2, [slotOf("hera")]: 2, nope: 9 }).ok, true);
  h.sent.length = 0;
  h.host.stageOp("arrange", { agent: "atlas", mode: "row" });
  const placed = h.sent.filter((e) => e.type === "place-avatar").map((e) => e.position[0]);
  assert.ok(placed.every((x) => x > 0.2), "the row is seated around where the owner moved the stage");

  h.sent.length = 0;
  assert.equal(h.host.leaveSlot(slotOf("hera")).ok, true);
  assert.equal(h.host.stageOfSlot(slotOf("hera")), null);
  const cleared = h.sent.filter((e) => e.type === "stage-groups");
  assert.deepEqual(cleared[cleared.length - 1].groups, [], "the handle goes with the stage");
  assert.equal(h.host.leaveSlot("slotNope").ok, false);
});

test("owner P0 2026-11-17: a session with no owner-assigned body never grows one; it stays a fairy", async () => {
  const rows = swarm.withIdentity(swarm.mergeRoster([
    { id: "aither", kind: "persona", bot: true, source: "discord" },
    { id: "session-bf1f", label: "room-custom-name-server-butto-bf1f", kind: "session", source: "sessions" },
  ]), { authors: {}, characters: new Set(["aither-v2", "gold-kitsune", "session-bf1f"]) });
  const session = rows.find((r) => r.id === "session-bf1f");
  assert.equal(session.character, "", "not even a model named like the session");
  const h = harness({ rows });
  const r = await h.host.setAgentForm("session-bf1f", "avatar");
  assert.equal(r.ok, false);
  assert.match(r.error, /no body chosen/);
  assert.equal(h.calls.filter((c) => c[0] === "spawn").length, 0, "nothing was spawned");
});
