"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const {
  createSpendClient, shapeSpend, spendTrayLabel, spendTrayItems, windowHours, NOT_DEPLOYED_TEXT,
} = require("./spend-client.cjs");
const { spendHandlers } = require("./spend-window.cjs");

// The contract the backend (MicroScheduler GET /cloud/spend, gateway `cloud_spend`) answers.
function contract(overrides = {}) {
  return {
    window_hours: 24,
    generated_at: "2026-10-04T12:00:00Z",
    total_usd: 1.2345,
    unpriced_requests: 0,
    providers: [
      {
        provider: "openai", usd: 0.2, prompt_tokens: 10, completion_tokens: 5, requests: 2, failed: 0,
        models: [{ model: "gpt-x", usd: 0.2, prompt_tokens: 10, completion_tokens: 5, requests: 2 }],
      },
      {
        provider: "deepseek", usd: 1.0345, prompt_tokens: 120000, completion_tokens: 30000, requests: 40, failed: 3,
        models: [
          { model: "deepseek-v4-flash", usd: 0.0345, prompt_tokens: 20000, completion_tokens: 1000, requests: 10 },
          { model: "deepseek-v4-pro", usd: 1.0, prompt_tokens: 100000, completion_tokens: 29000, requests: 30 },
        ],
      },
    ],
    top_sources: [{ source: "vnext_pillars_teacher", usd: 0.9, requests: 25, tokens: 100000 }],
    balance: {
      deepseek: { available: true, total_balance: "12.34", currency: "USD", checked_at: "2026-10-04T11:59:00Z", error: null },
    },
    ...overrides,
  };
}

/** A fake gateway callTool: answers by tool name, records every call. */
function fakeCall(answer) {
  const calls = [];
  const call = async (name, args) => {
    calls.push({ name, args });
    const a = typeof answer === "function" ? answer(name, args, calls.length) : answer;
    if (a instanceof Error) throw a;
    return typeof a === "string" ? a : JSON.stringify(a);
  };
  return { call, calls };
}

test("shapeSpend: providers and models sorted by spend, totals summed, numbers coerced", () => {
  const d = shapeSpend(contract());
  assert.equal(d.total_usd, 1.2345);
  assert.deepEqual(d.providers.map((p) => p.provider), ["deepseek", "openai"]);
  assert.deepEqual(d.providers[0].models.map((m) => m.model), ["deepseek-v4-pro", "deepseek-v4-flash"]);
  assert.equal(d.requests, 42);
  assert.equal(d.failed, 3);
  assert.equal(d.prompt_tokens, 120010);
  assert.equal(d.completion_tokens, 30005);
  assert.equal(d.top_sources[0].source, "vnext_pillars_teacher");
  assert.equal(d.balance.deepseek.available, true);
  assert.equal(d.balance.deepseek.total_balance, "12.34");
  // A missing count is 0, never NaN in a table.
  const sparse = shapeSpend(contract({ providers: [{ provider: "deepseek", models: [{ model: "m" }] }] }));
  assert.equal(sparse.providers[0].requests, 0);
  assert.equal(sparse.providers[0].models[0].usd, 0);
});

test("shapeSpend REFUSES a body that is not the contract -- never zeros for an answer we did not get", () => {
  assert.throws(() => shapeSpend(null), /expected a JSON object/);
  assert.throws(() => shapeSpend([]), /expected a JSON object/);
  assert.throws(() => shapeSpend({ total_usd: 0 }), /no providers list/);
  assert.throws(() => shapeSpend({ providers: [] }), /no numeric total_usd/);
  assert.throws(() => shapeSpend({ error: "microscheduler unreachable" }), /microscheduler unreachable/);
});

test("report(): calls cloud_spend {hours} through the injected gateway and caches 60 s per window", async () => {
  let t = 1_000_000;
  const { call, calls } = fakeCall(contract());
  const client = createSpendClient({ call, now: () => t });
  const first = await client.report(24);
  assert.equal(first.ok, true);
  assert.equal(first.data.total_usd, 1.2345);
  assert.deepEqual(calls[0], { name: "cloud_spend", args: { hours: 24 } });
  t += 59_000;
  await client.report(24);
  assert.equal(calls.length, 1, "inside 60 s the cached answer is reused");
  await client.report(168);
  assert.equal(calls.length, 2, "a different window is its own cache entry");
  assert.deepEqual(calls[1].args, { hours: 168 });
  t += 2_000;
  await client.report(24);
  assert.equal(calls.length, 3, "after 60 s the gateway is asked again");
  await client.report(24, { fresh: true });
  assert.equal(calls.length, 4, "fresh bypasses the cache");
  // An unknown window falls back to 24 h rather than asking for an arbitrary span.
  assert.equal(windowHours(99), 24);
  assert.equal(windowHours("720"), 720);
});

test("report(): concurrent asks for one window share one gateway call", async () => {
  const { call, calls } = fakeCall(contract());
  const client = createSpendClient({ call });
  const [a, b] = await Promise.all([client.report(24), client.report(24)]);
  assert.equal(calls.length, 1);
  assert.equal(a, b);
});

test("an absent cloud_spend tool reads 'not deployed yet', whether it throws or answers prose", async () => {
  for (const answer of [
    new Error("cloud_spend: Unknown tool: cloud_spend"),
    "Unknown tool: cloud_spend",
    new Error("cloud_spend: Tool cloud_spend not found"),
  ]) {
    const client = createSpendClient({ call: fakeCall(answer).call });
    const out = await client.report(24);
    assert.equal(out.ok, false);
    assert.equal(out.notDeployed, true, `not classified as not-deployed: ${answer}`);
    assert.equal(out.reason, NOT_DEPLOYED_TEXT);
    assert.equal("data" in out, false, "a not-deployed answer carries no numbers at all");
  }
});

test("any other failure is {ok:false, reason} with the real reason, never zeros", async () => {
  const dead = createSpendClient({ call: fakeCall(new Error("no session bearer")).call });
  const out = await dead.report(24);
  assert.deepEqual(out, { ok: false, notDeployed: false, reason: "no session bearer" });
  const junk = await createSpendClient({ call: fakeCall("<html>502</html>").call }).report(24);
  assert.equal(junk.ok, false);
  assert.equal(junk.notDeployed, false);
  assert.match(junk.reason, /unparseable answer/);
  const wrong = await createSpendClient({ call: fakeCall({ total_usd: 0 }).call }).report(24);
  assert.equal(wrong.ok, false);
  assert.match(wrong.reason, /no providers list/);
});

test("tray label: spend today and the DeepSeek balance", () => {
  const ok = { ok: true, data: shapeSpend(contract()) };
  assert.equal(spendTrayLabel(ok), "AI spend today: $1.23 · DeepSeek balance $12.34");
});

test("tray label: unpriced requests are named, a missing balance says unavailable", () => {
  const data = shapeSpend(contract({
    unpriced_requests: 7,
    balance: { deepseek: { available: false, total_balance: "", currency: "USD", checked_at: "", error: "401" } },
  }));
  assert.equal(spendTrayLabel({ ok: true, data }), "AI spend today: $1.23 + 7 unpriced · DeepSeek balance unavailable");
  const cny = shapeSpend(contract({
    balance: { deepseek: { available: true, total_balance: "88.5", currency: "CNY", checked_at: "", error: null } },
  }));
  assert.equal(spendTrayLabel({ ok: true, data: cny }), "AI spend today: $1.23 · DeepSeek balance 88.50 CNY");
  // No balance block at all -> no balance clause (nothing claimed either way).
  assert.equal(spendTrayLabel({ ok: true, data: shapeSpend(contract({ balance: {} })) }), "AI spend today: $1.23");
});

test("tray label: not deployed and unavailable are honest text, never $0.00", () => {
  assert.equal(spendTrayLabel({ ok: false, notDeployed: true, reason: NOT_DEPLOYED_TEXT }),
    "AI spend: spend reporting not deployed yet");
  const down = spendTrayLabel({ ok: false, notDeployed: false, reason: "gateway timeout" });
  assert.equal(down, "AI spend: unavailable (gateway timeout)");
  assert.equal(spendTrayLabel(null), "AI spend: checking…");
  for (const label of [down, spendTrayLabel(null)]) assert.ok(!label.includes("$"), label);
});

test("tray row is clickable and opens the spend page", () => {
  let opened = 0;
  const rows = spendTrayItems({ ok: false, notDeployed: true }, () => { opened += 1; });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].enabled, true);
  rows[0].click();
  assert.equal(opened, 1);
});

test("spendHandlers: report passes hours/fresh through, open runs the wired opener", async () => {
  const seen = [];
  const client = { report: async (h, o) => { seen.push([h, o]); return { ok: true, data: { h } }; } };
  let opened = 0;
  const handlers = spendHandlers(client, () => () => { opened += 1; });
  assert.deepEqual(await handlers["desk:spend-report"]({}, 168, { fresh: true }), { ok: true, data: { h: 168 } });
  assert.deepEqual(seen[0], [168, { fresh: true }]);
  assert.deepEqual(handlers["desk:spend-open"](), { ok: true });
  assert.equal(opened, 1);
  const unwired = spendHandlers(client, () => null);
  assert.equal(unwired["desk:spend-open"]().ok, false);
  const throwing = spendHandlers({ report: async () => { throw new Error("boom"); } }, () => null);
  assert.deepEqual(await throwing["desk:spend-report"]({}, 24), { ok: false, notDeployed: false, reason: "boom" });
});

test("the Spend pane: a FILE pane in PANES, routed to spend-preload by console and browser", () => {
  const { PANES, paneSources } = require("./console-window.cjs");
  const pane = PANES.find((p) => p.id === "spend");
  assert.ok(pane, "spend is not in PANES");
  assert.equal(pane.kind, "file");
  assert.equal(pane.file, "spend.html");
  assert.equal(pane.section, "System");
  assert.equal(paneSources("").find((p) => p.id === "spend").src, "./spend.html");
  const preload = fs.readFileSync(path.join(__dirname, "console-preload.cjs"), "utf8");
  assert.match(preload, /href\.includes\("\/spend\.html"\)\) \{\n\s+require\("\.\/spend-preload\.cjs"\)/);
  const internal = require("./browser-internal.cjs");
  assert.equal(internal.preloadForUrl("aither://spend/"), "spend-preload.cjs");
  // The rail icon is drawn, not the grid fallback.
  assert.match(fs.readFileSync(path.join(__dirname, "console.html"), "utf8"), /\n {2}wallet: '</);
  // main wires the detached twin and the IPC.
  const main = fs.readFileSync(path.join(__dirname, "main.cjs"), "utf8");
  assert.match(main, /spend: \{\n\s+open: \(\) => createSpendWindow\(\)/);
  assert.match(main, /ensureSpendIpc\(\);/);
  assert.match(main, /spendTrayItems\(latestSpend, \(\) => openConsole\("spend"\)\)/);
});

// spend-page.js is a classic browser script; evaluate its pure half like plane-page.test.cjs.
function loadPage(file) {
  const sandbox = { module: { exports: {} } };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, file), "utf8"), sandbox);
  return sandbox.module.exports;
}

test("spend page viewModel: not-deployed and error say so; ok flattens models by spend", () => {
  const page = loadPage("spend-page.js");
  assert.equal(page.viewModel({ ok: false, notDeployed: true }).state, "not-deployed");
  const err = page.viewModel({ ok: false, notDeployed: false, reason: "gateway timeout" });
  assert.equal(err.state, "error");
  assert.match(err.message, /gateway timeout/);
  const vmOk = page.viewModel({ ok: true, data: shapeSpend(contract()) });
  assert.equal(vmOk.state, "ok");
  assert.deepEqual(Array.from(vmOk.models, (m) => m.model), ["deepseek-v4-pro", "gpt-x", "deepseek-v4-flash"]);
  assert.equal(vmOk.models[0].provider, "deepseek");
  assert.equal(page.fmtUsd(0.0345), "$0.03");
  assert.equal(page.fmtUsd(0.0012), "$0.0012");
  assert.equal(page.fmtTokens(120000), "120.0k");
  assert.equal(page.fmtTokens(2500000), "2.50M");
  assert.deepEqual(Array.from(page.WINDOWS, (w) => w.hours), [24, 168, 720]);
});

test("Pulse page spend card: honest when absent, money only from a real report", () => {
  const plane = loadPage("plane-page.js");
  const absent = plane.spendCardModel({ ok: false, notDeployed: true });
  assert.equal(absent.pill, "not deployed");
  assert.ok(!absent.lines.join(" ").includes("$"));
  const failed = plane.spendCardModel({ ok: false, reason: "no session bearer" });
  assert.equal(failed.tone, "bad");
  assert.match(failed.lines[0], /no session bearer/);
  const ok = plane.spendCardModel({ ok: true, data: shapeSpend(contract({ unpriced_requests: 2 })) });
  assert.equal(ok.pill, "$1.23");
  assert.equal(ok.tone, "warn");
  assert.ok(ok.lines.includes("DeepSeek balance: $12.34"));
  assert.ok(ok.lines.some((l) => /2 unpriced/.test(l)));
  // spend.html really loads its page script (browser-internal serves only named scripts).
  assert.match(fs.readFileSync(path.join(__dirname, "spend.html"), "utf8"), /<script src="spend-page\.js"><\/script>/);
});
