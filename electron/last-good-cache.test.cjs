"use strict";

// The desk's offline memory for aither:// pages (owner, 2026-10-10: "cache the
// pages"): last good answer on disk, handed back STALE-marked when the live read
// fails, never invented when nothing was saved.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const { createLastGoodCache, staleText } = require("./last-good-cache.cjs");
const { createSpendClient, shapeSpend, spendTrayLabel, createBudgetStore, shapeBudget } = require("./spend-client.cjs");
const { createPlaneClient } = require("./plane-client.cjs");
const { spendHandlers } = require("./spend-window.cjs");

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "desk-lastgood-"));
}

function report(extra = {}) {
  return {
    window_hours: 24, generated_at: "2026-10-10T01:00:00Z", total_usd: 2.5, unpriced_requests: 0,
    providers: [{ provider: "deepseek", usd: 2.5, prompt_tokens: 10, completion_tokens: 5, requests: 3, failed: 0,
      models: [{ model: "deepseek-v4-flash", usd: 2.5, prompt_tokens: 10, completion_tokens: 5, requests: 3 }] }],
    top_sources: [{ source: "teacher", usd: 2.5, requests: 3, tokens: 15 }],
    balance: {},
    ...extra,
  };
}

test("cache: remember -> recall survives a new instance (disk), atomic file, bad keys refused", () => {
  const dir = tmpDir();
  let t = Date.parse("2026-10-10T00:00:00Z");
  const a = createLastGoodCache({ dir, now: () => t });
  assert.equal(a.recall("spend-24h"), null);
  assert.equal(a.remember("spend-24h", { x: 1 }), true);
  const b = createLastGoodCache({ dir: () => dir, now: () => t });
  assert.deepEqual(b.recall("spend-24h"), { savedAt: "2026-10-10T00:00:00.000Z", value: { x: 1 } });
  assert.deepEqual(fs.readdirSync(dir), ["spend-24h.json"]);
  t += 25 * 3600 * 1000;
  assert.equal(b.age(b.recall("spend-24h")).old, true);
  assert.throws(() => a.remember("../escape", 1), /bad cache key/);
  assert.throws(() => a.recall("A B"), /bad cache key/);
  fs.writeFileSync(path.join(dir, "junk.json"), "{not json");
  assert.equal(createLastGoodCache({ dir }).recall("junk"), null);
});

test("staleText names the age and the live failure", () => {
  const now = Date.parse("2026-10-10T03:00:00Z");
  assert.match(staleText("2026-10-10T00:00:00Z", "gateway down", now), /offline copy from 3 h ago -- live read failed: gateway down/);
  assert.match(staleText("2026-10-10T02:59:30Z", "", now), /just now$/);
});

test("spend client: a failed live read serves the last good report marked stale; nothing saved stays a failure", async () => {
  const store = createLastGoodCache({ dir: tmpDir() });
  let down = false;
  const call = async () => {
    if (down) throw new Error("gateway unreachable");
    return JSON.stringify(report());
  };
  const client = createSpendClient({ call, store, cacheMs: 0 });
  const live = await client.report(24);
  assert.equal(live.ok, true);
  assert.equal(live.stale, undefined);
  down = true;
  const offline = await client.report(24, { fresh: true });
  assert.equal(offline.ok, true);
  assert.equal(offline.stale, true);
  assert.equal(offline.data.total_usd, 2.5);
  assert.match(offline.reason, /gateway unreachable/);
  assert.match(spendTrayLabel(offline), /\(offline copy\)/);
  // A window never read live has no copy: the failure is said, not zeros.
  const never = await client.report(720, { fresh: true });
  assert.equal(never.ok, false);
});

test("shapeSpend: by_day absent = null (no chart), present = sorted, validated rows", () => {
  assert.equal(shapeSpend(report()).by_day, null);
  const d = shapeSpend(report({ by_day: [
    { day: "2026-10-10", usd: 1, requests: 2, tokens: 3, unpriced: 0, providers: { deepseek: 1 } },
    { day: "2026-10-09", usd: "1.5", requests: 1, tokens: 1, unpriced: 1, providers: { moonshot: 0 } },
    { day: "garbage", usd: 9 },
  ] }));
  assert.deepEqual(d.by_day.map((r) => r.day), ["2026-10-09", "2026-10-10"]);
  assert.equal(d.by_day[0].usd, 1.5);
  assert.deepEqual(d.by_day[1].providers, { deepseek: 1 });
});

test("budget store: clamps junk to 0, persists, handlers answer {ok,data}", () => {
  const file = path.join(tmpDir(), "spend-budget.json");
  const store = createBudgetStore({ file });
  assert.deepEqual(store.get(), { daily_usd: 0, monthly_usd: 0 });
  assert.deepEqual(store.set({ daily_usd: "5.555", monthly_usd: -3 }), { daily_usd: 5.56, monthly_usd: 0 });
  assert.deepEqual(createBudgetStore({ file }).get(), { daily_usd: 5.56, monthly_usd: 0 });
  assert.deepEqual(shapeBudget({ daily_usd: "NaN", monthly_usd: 100 }), { daily_usd: 0, monthly_usd: 100 });
  const h = spendHandlers({ report: async () => ({ ok: true }) }, () => null, store);
  assert.deepEqual(h["desk:spend-budget-get"](), { ok: true, data: { daily_usd: 5.56, monthly_usd: 0 } });
  assert.deepEqual(h["desk:spend-budget-set"]({}, { daily_usd: 10, monthly_usd: 200 }).data, { daily_usd: 10, monthly_usd: 200 });
});

function loadPage(file) {
  const sandbox = { module: { exports: {} } };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, file), "utf8"), sandbox);
  return sandbox.module.exports;
}

test("spend page: budget view per window, day bars fill gaps, share, stale line", () => {
  const page = loadPage("spend-page.js");
  assert.equal(page.budgetView(5, 24, { daily_usd: 0, monthly_usd: 0 }), null);
  const day = page.budgetView(9, 24, { daily_usd: 10 });
  assert.equal(day.tone, "warn");
  assert.match(day.label, /\$9\.00 of \$10\.00 daily budget \(90%\)/);
  assert.equal(page.budgetView(80, 168, { daily_usd: 10 }).tone, "bad");
  assert.equal(page.budgetView(80, 168, { daily_usd: 10 }).left, "over by $10.00");
  assert.equal(page.budgetView(10, 720, { daily_usd: 1, monthly_usd: 100 }).basis, "monthly budget");
  assert.equal(page.budgetView(10, 720, { daily_usd: 1 }).basis, "30 x daily budget");
  assert.equal(page.dayBars(null, 7), null);
  const bars = page.dayBars([{ day: "2026-10-08", usd: 4, requests: 1, providers: {} },
    { day: "2026-10-10", usd: 2, requests: 1, providers: {} }], 3);
  assert.deepEqual(Array.from(bars, (b) => b.day), ["2026-10-08", "2026-10-09", "2026-10-10"]);
  assert.deepEqual(Array.from(bars, (b) => b.pct), [100, 0, 50]);
  assert.equal(page.share(1, 4), "25%");
  assert.equal(page.share(0.001, 4), "<1%");
  assert.equal(page.share(1, 0), "—");
  assert.equal(page.staleLine({ ok: true }), null);
  assert.match(page.staleLine({ stale: true, savedAt: "2026-10-10T00:00:00Z", reason: "down" },
    Date.parse("2026-10-10T00:30:00Z")), /Offline copy from 30 min ago -- live read failed: down/);
  const vmStale = page.viewModel({ ok: true, stale: true, savedAt: "x", reason: "down", data: shapeSpend(report()) });
  assert.equal(vmStale.stale, true);
});

test("plane client: a failed read serves its last good answer stale; snapshot counts stale apart from failed", async () => {
  const store = createLastGoodCache({ dir: tmpDir() });
  let down = false;
  const fetchPlane = async (planeId) => {
    if (down) throw new Error("plane route 502");
    if (planeId !== "nexus") throw new Error("plane route 502");
    return { ok: true, reads: {
      service: { ok: true, data: { services: { Nexus: { status: "running" } } } },
      collections: { ok: true, data: { bases: ["docs"] } },
    } };
  };
  const client = createPlaneClient({ fetchPlane, store });
  const live = await client.snapshot("nexus");
  assert.equal(live.ok, true);
  assert.equal(live.stale, 0);
  down = true;
  const offline = await client.snapshot("nexus");
  assert.equal(offline.failed, 0);
  assert.equal(offline.stale, 2);
  assert.equal(offline.ok, false);
  const kbs = offline.reads.find((r) => r.id === "collections");
  assert.deepEqual(kbs.data, { bases: ["docs"] });
  assert.match(kbs.error, /plane route 502/);
  // A plane never read live has nothing to fall back on.
  const strata = await client.snapshot("strata");
  assert.equal(strata.failed, strata.reads.length);
  const page = loadPage("plane-page.js");
  assert.match(page.staleNote(kbs), /Offline copy from .* -- live read failed: plane route 502/);
  const card = page.spendCardModel({ ok: true, stale: true, savedAt: "2026-10-10T00:00:00Z", data: shapeSpend(report()) });
  assert.equal(card.tone, "warn");
  assert.match(card.lines[0], /Offline copy/);
});
