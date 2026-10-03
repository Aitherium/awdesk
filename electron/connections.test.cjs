"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { connections, LOCAL, RUNNABLE } = require("./connections.cjs");

const healthy = {
  [LOCAL.gateway]: { status: "healthy" },
  [LOCAL.adk]: { status: "healthy", version: "3.8.48", tools: { mode: "platform", registered: 18, catalogue: 1656 } },
  [LOCAL.awsh]: { ok: true, sessions: 2, harnesses_installed: ["claude", "gemini"] },
};
const fetchFrom = (table) => async (url) => {
  if (!(url in table)) throw new Error("ECONNREFUSED");
  return table[url];
};
const linked = async () => ({ ok: true, data: { linked: true, username: "david", role: "owner" } });

test("every link joined up -> every row ok, no actions but Sessions", async () => {
  const rows = await connections({ fetchJson: fetchFrom(healthy), linkStatus: linked, awconnect: { state: "installed" } });
  assert.deepEqual(rows.map((r) => r.id), ["account", "gateway", "adk", "awsh", "awconnect"]);
  for (const row of rows) assert.equal(row.ok, true, `${row.id}: ${row.detail}`);
  assert.deepEqual(rows.filter((r) => r.action).map((r) => r.action.id), ["console.open"]);
});

test("a running adk daemon on built-in tools only is not ok, and says why (measured 2026-10-03)", async () => {
  const why = "plaintext gateway http://127.0.0.1:8182 refused: any local user can bind a loopback port";
  const table = { ...healthy, [LOCAL.adk]: { status: "healthy", version: "3.8.48",
    tools: { mode: "builtin-only", registered: 0, last_error: why } } };
  const rows = await connections({ fetchJson: fetchFrom(table), linkStatus: linked, awconnect: { state: "installed" } });
  const adk = rows.find((r) => r.id === "adk");
  assert.equal(adk.ok, false);
  assert.match(adk.detail, /built-in tools only -- plaintext gateway/);
});

test("down daemons and an unlinked account say so, with the fix where the desk has one", async () => {
  const rows = await connections({
    fetchJson: fetchFrom({}),
    linkStatus: async () => ({ ok: true, data: { linked: false, signed_in: true } }),
    awconnect: { state: "not_installed" },
  });
  const by = Object.fromEntries(rows.map((r) => [r.id, r]));
  assert.equal(by.account.ok, false);
  assert.equal(by.account.action.id, "link");
  assert.match(by.account.detail, /not linked/);
  for (const id of ["gateway", "adk", "awsh"]) {
    assert.equal(by[id].ok, false);
    assert.match(by[id].detail, /not answering/);
  }
  assert.equal(by.awconnect.action.id, "awconnect.setup");
  for (const row of rows) if (row.action) assert.ok(RUNNABLE.includes(row.action.id), row.action.id);
});

test("a throwing link check is a row, never a crash", async () => {
  const rows = await connections({ fetchJson: fetchFrom(healthy), linkStatus: async () => { throw new Error("adk missing"); } });
  assert.match(rows[0].detail, /could not check \(adk missing\)/);
});
