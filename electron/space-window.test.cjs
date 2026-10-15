"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { spaceHandlers, explorePrompt, virtualNodeOf, QUESTION_MAX } = require("./space-window.cjs");

function node(id, verbs = [], extra = {}) {
  return { id, title: id.split(":").pop(), level: "system", parent: "platform", health: { state: "down", reason: "stopped" },
    verbs, explore: [], ...extra };
}

const UNIVERSE = {
  universe_version: 1,
  nodes: [
    node("platform"),
    node("galaxy:fleet", [
      { id: "fleet-wake", label: "Wake fleet", danger: "none", transport: "fleet", primary: true },
      { id: "fleet-sleep", label: "Sleep fleet", danger: "confirm", transport: "fleet" },
      // Not an ACTIONS name: normalisation drops these, the IPC must refuse them anyway.
      { id: "format-c", label: "Format", danger: "none", transport: "fleet" },
      { id: "open-plane:nope", label: "Open nope", danger: "none", transport: "open" },
    ], { explore: [{ label: "Explore with Aither", prompt: "Summarise the fleet." }] }),
    node("svc:Strata", [{ id: "open-plane:strata", label: "Open Strata", danger: "none", transport: "open" }]),
  ],
  links: [],
};

function rig() {
  const runs = [];
  const asked = [];
  const opened = [];
  const handlers = spaceHandlers({
    getControl: () => ({ run: async (id) => { runs.push(id); return { ok: true }; } }),
    client: { current: () => UNIVERSE, get: async () => ({ ok: true, universe: UNIVERSE }) },
    askAgent: async (prompt) => { asked.push(prompt); return { ok: true, reply: "all fine" }; },
    openInternal: (pane) => { opened.push(pane); return true; },
  });
  const verb = (payload) => handlers["desk:space-verb"]({}, payload);
  const explore = (payload) => handlers["desk:space-explore"]({}, payload);
  return { handlers, verb, explore, runs, asked, opened };
}

test("an unknown node is refused", async () => {
  const { verb, runs } = rig();
  const r = await verb({ nodeId: "galaxy:nowhere", verbId: "fleet-wake", confirmed: true });
  assert.equal(r.ok, false);
  assert.match(r.error, /unknown object/);
  assert.deepEqual(runs, []);
});

test("a verb the node does not carry is refused, even a real fleet action", async () => {
  const { verb, runs } = rig();
  const r = await verb({ nodeId: "svc:Strata", verbId: "fleet-wake", confirmed: true });
  assert.equal(r.ok, false);
  assert.deepEqual(runs, []);
});

test("a fleet verb that is not in ACTIONS is refused", async () => {
  const { verb, runs } = rig();
  const r = await verb({ nodeId: "galaxy:fleet", verbId: "format-c", confirmed: true });
  assert.equal(r.ok, false);
  assert.match(r.error, /not a fleet action/);
  assert.deepEqual(runs, []);
});

test("a destructive verb without confirmed === true is refused", async () => {
  const { verb, runs } = rig();
  for (const confirmed of [false, undefined, "true", 1]) {
    const r = await verb({ nodeId: "galaxy:fleet", verbId: "fleet-sleep", confirmed });
    assert.equal(r.ok, false, `confirmed=${String(confirmed)}`);
  }
  assert.deepEqual(runs, []);
});

test("a confirmed destructive verb runs once, then main re-probes status", async () => {
  const { verb, runs } = rig();
  const r = await verb({ nodeId: "galaxy:fleet", verbId: "fleet-sleep", confirmed: true });
  assert.deepEqual(r, { ok: true });
  await new Promise((resolve) => setImmediate(resolve));
  // The verb exactly once; then a status probe so the desk's fleet verdict is not the pre-sleep one.
  assert.deepEqual(runs, ["fleet-sleep", "status"]);
});

test("a status read is not followed by another probe, and a busy refusal is not either", async () => {
  const runs = [];
  const u = { ...UNIVERSE, nodes: [...UNIVERSE.nodes, node("galaxy:x", [
    { id: "verbs-status", label: "Fleet status", danger: "none", transport: "fleet" },
    { id: "fleet-wake", label: "Wake fleet", danger: "none", transport: "fleet" },
  ])] };
  const handlers = spaceHandlers({
    getControl: () => ({ run: async (id) => { runs.push(id); return id === "fleet-wake" ? { ok: false, busy: "status" } : { ok: true }; } }),
    client: { current: () => u, get: async () => ({ universe: u }) },
    askAgent: async () => ({}),
    openInternal: () => true,
  });
  await handlers["desk:space-verb"]({}, { nodeId: "galaxy:x", verbId: "verbs-status" });
  await handlers["desk:space-verb"]({}, { nodeId: "galaxy:x", verbId: "fleet-wake" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(runs, ["verbs-status", "fleet-wake"]);
});

test("a fleet verb that outlives the window answers pending and keeps running", async () => {
  let release;
  const handlers = spaceHandlers({
    getControl: () => ({ run: () => new Promise((resolve) => { release = resolve; }) }),
    client: { current: () => UNIVERSE, get: async () => ({ universe: UNIVERSE }) },
    askAgent: async () => ({}),
    openInternal: () => true,
    pendingMs: 20,
  });
  const r = await handlers["desk:space-verb"]({}, { nodeId: "galaxy:fleet", verbId: "fleet-wake" });
  assert.deepEqual(r, { ok: true, pending: true });
  release({ ok: true });
});

test("open-plane opens a known plane and refuses an unknown one", async () => {
  const { verb, opened } = rig();
  assert.deepEqual(await verb({ nodeId: "svc:Strata", verbId: "open-plane:strata" }), { ok: true });
  const bad = await verb({ nodeId: "galaxy:fleet", verbId: "open-plane:nope" });
  assert.equal(bad.ok, false);
  assert.deepEqual(opened, ["strata"]);
});

test("the explore prompt is built in main from main's node, on the agent lane", async () => {
  const { explore, asked } = rig();
  const r = await explore({ nodeId: "galaxy:fleet", exploreIndex: 0, question: "and the GPU?" });
  assert.deepEqual(r, { ok: true, text: "all fine" });
  assert.equal(asked.length, 1);
  assert.equal(asked[0], "Explore fleet (galaxy:fleet), health down: stopped. Summarise the fleet. and the GPU?");
  // An index the node does not have is refused, not invented.
  const bad = await explore({ nodeId: "galaxy:fleet", exploreIndex: 2 });
  assert.equal(bad.ok, false);
  // The question is capped.
  const long = explorePrompt(UNIVERSE.nodes[1], 0, "x".repeat(2000));
  assert.ok(long.endsWith(" " + "x".repeat(QUESTION_MAX)));
});

test("main wires explore to the agent lane (askAgent = CommandAgent lane 'agent')", () => {
  const main = require("node:fs").readFileSync(require("node:path").join(__dirname, "main.cjs"), "utf8");
  const at = main.indexOf("ensureSpaceIpc({");
  assert.ok(at > 0, "main.cjs calls ensureSpaceIpc");
  const block = main.slice(at, at + 900);
  assert.match(block, /source: "space", lane: "agent"/);
  assert.match(block, /getControl: getFleetControl/);
});

test("desk:space-get never throws across the bridge", async () => {
  const handlers = spaceHandlers({
    getControl: () => null,
    client: { current: () => null, get: async () => { throw new Error("boom"); } },
    askAgent: async () => ({}),
    openInternal: () => false,
  });
  assert.deepEqual(await handlers["desk:space-get"](), { ok: false, error: "boom" });
});

// A credential card whose subject is NOT in the universe: bead-space attachCards draws a
// virtual moon `secret:<name>` in the renderer only. Explore on it must still work.
const PROBE_CARD = {
  id: "card-1", kind: "credential", title: "Store the probe secret", secretName: "OWNER_ASK_PROBE",
  options: [], dedupeKey: "", recipe: "", subject: "",
};

function cardRig(cards) {
  const asked = [];
  const runs = [];
  const handlers = spaceHandlers({
    getControl: () => ({ run: async (id) => { runs.push(id); return { ok: true }; } }),
    client: { current: () => UNIVERSE, get: async () => ({ ok: true, universe: UNIVERSE }) },
    askAgent: async (prompt) => { asked.push(prompt); return { ok: true, reply: "it is the probe" }; },
    openInternal: () => true,
    cards: () => cards,
  });
  return { handlers, asked, runs };
}

test("explore on a credential card's virtual moon works (main rebuilds it from its cards)", async () => {
  assert.ok(!UNIVERSE.nodes.some((n) => n.id === "secret:OWNER_ASK_PROBE"), "the subject is absent from the universe");
  const { handlers, asked } = cardRig([PROBE_CARD]);
  const r = await handlers["desk:space-explore"]({}, { nodeId: "secret:OWNER_ASK_PROBE", exploreIndex: 0 });
  assert.equal(r.ok, true, r.error);
  assert.equal(r.text, "it is the probe");
  assert.equal(asked.length, 1);
  assert.match(asked[0], /^Explore OWNER_ASK_PROBE \(secret:OWNER_ASK_PROBE\), health unknown: known only from an open card\./);
});

test("a virtual moon carries no verbs: a fleet verb on it is refused", async () => {
  const { handlers, runs } = cardRig([PROBE_CARD]);
  const r = await handlers["desk:space-verb"]({}, { nodeId: "secret:OWNER_ASK_PROBE", verbId: "fleet-sleep", confirmed: true });
  assert.equal(r.ok, false);
  assert.match(r.error, /has no verb/);
  assert.deepEqual(runs, []);
});

test("a virtual id no open card points at stays unknown", async () => {
  const { handlers, asked } = cardRig([PROBE_CARD]);
  for (const nodeId of ["secret:SOMETHING_ELSE", "svc:Nope", "galaxy:nowhere", "secret:../../x y"]) {
    const r = await handlers["desk:space-explore"]({}, { nodeId });
    assert.equal(r.ok, false, nodeId);
    assert.match(r.error, /unknown object/);
  }
  assert.deepEqual(asked, []);
  // The card closed: the moon is gone too.
  const closed = cardRig([]);
  const r = await closed.handlers["desk:space-explore"]({}, { nodeId: "secret:OWNER_ASK_PROBE" });
  assert.match(r.error, /unknown object/);
});

test("virtualNodeOf follows attach.ts: explicit subject, session and wake-job moons", () => {
  const cards = [
    { id: "a", kind: "decision", subject: "routine:nightly", dedupeKey: "", recipe: "" },
    { id: "b", kind: "blocked", sessionId: "abc 123", dedupeKey: "", recipe: "" },
    { id: "c", kind: "decision", dedupeKey: "awrise:wake-failed:backup:1700", recipe: "" },
  ];
  assert.equal(virtualNodeOf("routine:nightly", cards, UNIVERSE).virtual, true);
  assert.equal(virtualNodeOf("session:abc-123", cards, UNIVERSE).title, "abc-123");
  assert.equal(virtualNodeOf("routine:backup", cards, UNIVERSE).parent, "galaxy:fleet");
  assert.equal(virtualNodeOf("svc:Secrets", cards, UNIVERSE), null, "svc is never virtual");
});
