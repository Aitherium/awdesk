"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const { createOpsClient, parseResult, isTerminal } = require("./ops-client.cjs");

function recorder(answers) {
  const calls = [];
  const call = async (name, args) => {
    calls.push({ name, args });
    let a = typeof answers === "function" ? answers(name, args, calls.length) : answers[name];
    if (typeof a === "function") a = a(name, args, calls.length);
    if (a instanceof Error) throw a;
    return typeof a === "string" ? a : JSON.stringify(a);
  };
  return { call, calls };
}

test("run() always sends via=awdesk, and delegate_to when asked", async () => {
  const { call, calls } = recorder({ ops_run: { dry_run: false, run: { id: "r1", state: "running" } } });
  const ops = createOpsClient({ call });
  const out = await ops.run("backups.verify", "", { delegateTo: "genesis" });
  assert.equal(out.run.id, "r1");
  assert.equal(calls[0].name, "ops_run");
  assert.equal(calls[0].args.via, "awdesk");
  assert.equal(calls[0].args.op, "backups.verify");
  assert.equal(calls[0].args.delegate_to, "genesis");

  await ops.run("backups.run", { set: "pg" });
  assert.equal(calls[1].args.via, "awdesk");
  assert.equal(calls[1].args.params, '{"set":"pg"}', "object params are serialised for the string arg");
});

test("plan/state/status/cancel name the right tools and parse the JSON string", async () => {
  const { call, calls } = recorder({
    ops_plan: { dry_run: true, approval_required: true, would: { sets: 3 } },
    ops_state: { run: { id: "s", state: "succeeded", proof: { passed: true, checks: [] } } },
    ops_status: (_n, args) => (args.run_id ? { run: { id: args.run_id, state: "running" } } : { runs: [], count: 0 }),
    ops_cancel: { run: { id: "r9", state: "cancelled" } },
  });
  const ops = createOpsClient({ call: (n, a) => call(n, a) });
  const plan = await ops.plan("backups.run");
  assert.equal(plan.approval_required, true);
  assert.equal(plan.would.sets, 3);
  assert.equal((await ops.state("backups")).run.proof.passed, true);
  assert.deepEqual(await ops.status({ noun: "backups", limit: 5 }), { runs: [], count: 0 });
  assert.equal((await ops.status("r2")).run.id, "r2");
  assert.equal((await ops.cancel("r9")).run.state, "cancelled");
  const byName = calls.map((c) => c.name);
  assert.deepEqual(byName, ["ops_plan", "ops_state", "ops_status", "ops_status", "ops_cancel"]);
  assert.equal(calls[2].args.noun, "backups");
  assert.equal(calls[2].args.limit, 5);
  assert.equal(calls[0].args.via, undefined, "a plan is a dry run; via belongs to runs");
});

test("a gateway error surfaces -- it never reads as an empty result", async () => {
  const ops = createOpsClient({ call: async () => { throw new Error("HTTP 503: identity_unreachable"); } });
  await assert.rejects(ops.state("backups"), /HTTP 503: identity_unreachable/);
  await assert.rejects(ops.status({ noun: "backups" }), /identity_unreachable/);
});

test("a tool-level {error} body throws, as does an unparseable or empty one", async () => {
  const errBody = createOpsClient({ call: async () => JSON.stringify({ error: "Connection refused — service not running" }) });
  await assert.rejects(errBody.state(), /ops_state: Connection refused/);

  const prose = createOpsClient({ call: async () => "Genesis said no" });
  await assert.rejects(prose.catalog(), /ops_catalog: unparseable answer: Genesis said no/);

  const empty = createOpsClient({ call: async () => "" });
  await assert.rejects(empty.catalog(), /unparseable answer \(empty\)/);

  assert.throws(() => parseResult("ops_status", "null"), /expected a JSON object/);
  assert.throws(() => parseResult("ops_run", '{"detail":"forbidden"}'), /ops_run: forbidden/);
});

test("watch() reports each change and stops on the first terminal state", async () => {
  const states = ["running", "running", "verifying", "succeeded", "running"];
  let i = 0;
  const { call, calls } = recorder(() => {
    const state = states[Math.min(i, states.length - 1)];
    i += 1;
    return { run: { id: "r1", state, updated_at: `t${state}` } };
  });
  const ops = createOpsClient({ call, sleep: async () => {} });
  const seen = [];
  const out = await ops.watch("r1", (run) => { if (run) seen.push(run.state); }, { intervalMs: 1, timeoutMs: 60000 });
  assert.equal(out.done, true);
  assert.equal(out.run.state, "succeeded");
  assert.equal(calls.length, 4, "no poll after the terminal state");
  assert.deepEqual(seen, ["running", "verifying", "succeeded"], "unchanged polls are not re-reported");
  for (const s of ["succeeded", "failed", "blocked", "cancelled"]) assert.ok(isTerminal(s), s);
  for (const s of ["planned", "awaiting_approval", "running", "verifying"]) assert.ok(!isTerminal(s), s);
});

test("watch() times out honestly and throws after repeated poll failures", async () => {
  const stuck = createOpsClient({
    call: async () => JSON.stringify({ run: { id: "r", state: "awaiting_approval" } }),
    sleep: async () => {},
  });
  const out = await stuck.watch("r", () => {}, { intervalMs: 1, timeoutMs: 0 });
  assert.equal(out.done, false);
  assert.equal(out.timedOut, true);
  assert.equal(out.run.state, "awaiting_approval");

  const errors = [];
  const dead = createOpsClient({ call: async () => { throw new Error("gateway timeout"); }, sleep: async () => {} });
  await assert.rejects(
    dead.watch("r", (run, err) => { if (err) errors.push(err.message); }, { intervalMs: 1, maxErrors: 3 }),
    /gateway timeout/,
  );
  assert.equal(errors.length, 3);
});

test("ops-client reuses gateway-mcp and opens no transport of its own", () => {
  const src = fs.readFileSync(path.join(__dirname, "ops-client.cjs"), "utf8");
  assert.match(src, /require\("\.\/gateway-mcp\.cjs"\)/);
  assert.doesNotMatch(src, /require\("node:https?"\)|\bfetch\(/);
});

test("ops-window handlers answer {ok,error}, fence the op list, and push watch updates", async () => {
  const { opsHandlers, RUNNABLE_OPS } = require("./ops-window.cjs");
  const { call, calls } = recorder((name, args) => {
    if (name === "ops_state") throw new Error("HTTP 503: down");
    if (name === "ops_status") return { run: { id: args.run_id, state: "succeeded" } };
    return { dry_run: name === "ops_plan", run: { id: "r1", state: "running" } };
  });
  const h = opsHandlers(createOpsClient({ call, sleep: async () => {} }));

  const state = await h["desk:ops-state"]({}, "backups");
  assert.deepEqual(state, { ok: false, error: "HTTP 503: down" });

  const refused = await h["desk:ops-run"]({}, "backups.restore", {});
  assert.equal(refused.ok, false);
  assert.match(refused.error, /not runnable from the desk/);
  assert.ok(!RUNNABLE_OPS.includes("backups.restore"));
  assert.equal((await h["desk:ops-plan"]({}, "backups.verify", { delegateTo: "evil" })).ok, false);

  const ran = await h["desk:ops-run"]({}, "backups.verify", { delegateTo: "genesis" });
  assert.equal(ran.ok, true);
  const runCall = calls.find((c) => c.name === "ops_run");
  assert.equal(runCall.args.via, "awdesk");
  assert.equal(runCall.args.delegate_to, "genesis");

  const sent = [];
  const watched = await h["desk:ops-watch"]({ sender: { isDestroyed: () => false, send: (ch, p) => sent.push([ch, p]) } }, "r1");
  assert.equal(watched.ok, true);
  assert.equal(watched.data.done, true);
  assert.equal(sent[0][0], "desk:ops-run-update");
  assert.equal(sent[0][1].run.state, "succeeded");
});
