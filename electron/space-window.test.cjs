"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  spaceHandlers, explorePrompt, virtualNodeOf, profileArgv, runStackProfiles, QUESTION_MAX,
} = require("./space-window.cjs");

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

// ---- the profile overlay: info and profile transports ------------------------------

const PV = (id, label) => ({ id, label, danger: "none", transport: "profile" });
const PROFILE_UNIVERSE = {
  universe_version: 1,
  links: [],
  nodes: [
    node("svc:Veil", [PV("profile-add:business", "Add to business")],
      { meta: { criticality: "important", unit: "aither-veil", profiles: ["platform"] } }),
    node("svc:Gargbot", [PV("profile-remove:business", "Remove from business")],
      { meta: { unit: "aither-aitheros-gargbot", kept_because: "added: paying customer" } }),
    node("svc:CognitionAdvanced", [
      { id: "why-kept", label: "Why kept", danger: "none", transport: "info" },
      // A renderer- or snapshot-forged remove on a derived member: main must refuse it.
      PV("profile-remove:business", "Remove from business"),
      PV("reclassify-edge:Will:Axiom", "Make Will -> Axiom soft"),
    ], { meta: { unit: "aither-cognition-advanced", kept_because: "Will(core) -> Axiom(compound in CognitionAdvanced)" } }),
    // Core with a forged add verb: refused all the same.
    node("svc:Chronicle", [PV("profile-add:business", "Add"), PV("profile-remove:critical", "Remove")],
      { meta: { criticality: "core", kept_because: "core: never stopped" } }),
    node("galaxy:dgx", [{ id: "inference-status", label: "Inference status", danger: "none", transport: "fleet", primary: true }]),
  ],
};

// stack_profiles.py --pr --json's real verdict shape: the PR url is `pr`, not `pr_url`.
function profileRig({ verdict = { ok: true, action: "add", pr: "https://github.com/x/y/pull/1" } } = {}) {
  const argvs = [];
  const runs = [];
  const handlers = spaceHandlers({
    getControl: () => ({ run: async (id) => { runs.push(id); return { ok: true, mode: "dgx", lanes: [{ lane: "orchestrator", verdict: "PASS" }] }; } }),
    client: { current: () => PROFILE_UNIVERSE, get: async () => ({ universe: PROFILE_UNIVERSE }) },
    askAgent: async () => ({}),
    openInternal: () => true,
    runProfile: async (argv) => { argvs.push(argv); return verdict; },
  });
  return { verb: (p) => handlers["desk:space-verb"]({}, p), argvs, runs };
}

test("profile argv is built in main from the node id and the verb id", async () => {
  const { verb, argvs } = profileRig();
  const r = await verb({ nodeId: "svc:Veil", verbId: "profile-add:business", key: "Genesis", argv: ["rm", "-rf"] });
  assert.equal(r.ok, true, r.error);
  assert.equal(r.pr_url, "https://github.com/x/y/pull/1");
  // The renderer's key and argv are ignored: the key is node.id's. An add carries the
  // --why stack_profiles.py refuses to go without (STK011).
  assert.deepEqual(argvs, [["add", "business", "Veil", "--why", "kept by the owner from BeadSpace: Veil",
    "--pr", "--json"]]);
});

test("a hand-added row can be removed; a derived member cannot, its edge can be moved", async () => {
  const { verb, argvs } = profileRig();
  assert.equal((await verb({ nodeId: "svc:Gargbot", verbId: "profile-remove:business" })).ok, true);
  const refused = await verb({ nodeId: "svc:CognitionAdvanced", verbId: "profile-remove:business" });
  assert.equal(refused.ok, false);
  assert.match(refused.error, /kept by its dependencies/);
  assert.equal((await verb({ nodeId: "svc:CognitionAdvanced", verbId: "reclassify-edge:Will:Axiom" })).ok, true);
  assert.deepEqual(argvs, [
    ["remove", "business", "Gargbot", "--pr", "--json"],
    ["reclassify-edge", "Will", "Axiom", "--pr", "--json"],
  ]);
});

test("core is refused every profile verb, even one the snapshot carries", async () => {
  const { verb, argvs } = profileRig();
  for (const verbId of ["profile-add:business", "profile-remove:critical"]) {
    const r = await verb({ nodeId: "svc:Chronicle", verbId, confirmed: true });
    assert.equal(r.ok, false, verbId);
    assert.match(r.error, /core/);
  }
  assert.deepEqual(argvs, []);
});

test("why-kept renders meta and executes nothing", async () => {
  const { verb, argvs, runs } = profileRig();
  const r = await verb({ nodeId: "svc:CognitionAdvanced", verbId: "why-kept" });
  assert.deepEqual(r, { ok: true, text: "Will(core) -> Axiom(compound in CognitionAdvanced)" });
  assert.deepEqual(argvs, []);
  assert.deepEqual(runs, []);
});

test("an older pr_url verdict still renders; a non-https url never does", async () => {
  assert.equal((await profileRig({ verdict: { ok: true, pr_url: "https://x/pull/3" } }).verb(
    { nodeId: "svc:Veil", verbId: "profile-add:business" })).pr_url, "https://x/pull/3");
  const r = await profileRig({ verdict: { ok: true, pr: "javascript:alert(1)" } }).verb(
    { nodeId: "svc:Veil", verbId: "profile-add:business" });
  assert.equal(r.pr_url, undefined);
});

test("profileArgv strips a title down to plain words in --why", () => {
  const r = profileArgv({ id: "svc:Veil", title: "Veil`$(x)\";", meta: {} }, "profile-add:business");
  assert.equal(r.ok, true);
  assert.equal(r.argv[4], "kept by the owner from BeadSpace: Veil(x)");
});

test("profileArgv refuses a tier or shape it does not know", () => {
  const n = { id: "svc:Veil", title: "Veil", meta: {} };
  assert.equal(profileArgv(n, "profile-add:full").ok, false);
  assert.equal(profileArgv(n, "profile-add:business;rm").ok, false);
  assert.equal(profileArgv({ id: "galaxy:fleet", title: "f", meta: {} }, "profile-add:business").ok, false);
});

test("a failed profile edit says so, never green", async () => {
  const { verb } = profileRig({ verdict: { ok: false, error: "check_stack_map failed" } });
  const r = await verb({ nodeId: "svc:Veil", verbId: "profile-add:business" });
  assert.equal(r.ok, false);
  assert.match(r.error, /check_stack_map failed/);
});

test("runStackProfiles reads the last JSON verdict and fails loudly without one", async () => {
  const calls = [];
  const fake = (out, err, code) => (file, args, opts, cb) => {
    calls.push({ file, args, opts });
    cb(code ? Object.assign(new Error("exit"), { code }) : null, out, err);
  };
  const env = { AWDESK_STACK_PROFILES_SCRIPT: "S.py", AWDESK_PYTHON: "py" };
  const ok = await runStackProfiles(["add", "business", "Veil", "--pr", "--json"],
    { execFile: fake('working...\n{"ok": true, "pr_url": "https://x/pull/2"}\n', "", 0), env });
  assert.deepEqual(ok, { ok: true, pr_url: "https://x/pull/2" });
  assert.deepEqual(calls[0].args, ["S.py", "add", "business", "Veil", "--pr", "--json"]);
  assert.equal(calls[0].file, "py");
  assert.equal(calls[0].opts.windowsHide, true);
  const missing = await runStackProfiles(["add"], { execFile: fake("", "can't open file 'S.py'", 2), env });
  assert.equal(missing.ok, false);
  assert.match(missing.error, /can't open file/);
  const lied = await runStackProfiles(["add"], { execFile: fake('{"ok": true}', "", 1), env });
  assert.equal(lied.ok, false, "a non-zero exit is never green");
});

test("a fleet verdict worth showing rides back as result (the inference lane table)", async () => {
  const handlers = spaceHandlers({
    getControl: () => ({ run: async () => ({ ok: true, mode: "dgx", lanes: [{ lane: "orchestrator", verdict: "PASS" }] }) }),
    client: { current: () => PROFILE_UNIVERSE, get: async () => ({ universe: PROFILE_UNIVERSE }) },
    askAgent: async () => ({}),
    openInternal: () => true,
  });
  // inference-status is not in ACTION_NAMES until brief B lands: refused, fail closed.
  const r = await handlers["desk:space-verb"]({}, { nodeId: "galaxy:dgx", verbId: "inference-status" });
  const { ACTION_NAMES } = require("./fleet-control.cjs");
  if (ACTION_NAMES.includes("inference-status")) {
    assert.equal(r.ok, true);
    assert.deepEqual(r.result.lanes, [{ lane: "orchestrator", verdict: "PASS" }]);
  } else {
    assert.equal(r.ok, false);
    assert.match(r.error, /not a fleet action/);
  }
});
