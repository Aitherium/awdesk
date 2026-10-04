"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const { createSecretsClient, sanitiseEntry, sanitiseList, maskHint, SOURCES, MASK } = require("./secrets-client.cjs");
const { secretsHandlers, safeError, ENTRY_FIELDS, ERROR_MAX } = require("./secrets-window.cjs");

// Planted values. If ANY of these strings appears in what the IPC returns, a
// secret value reached the renderer.
const PLANTED = [
  "sk-live-PLANTED-VALUE-0001",
  "ghp_PLANTEDTOKEN0000000000000000000000",
  "hunter2-PLANTED-PASSWORD",
  "-----BEGIN PRIVATE KEY-----PLANTED",
  "PLANTED-NESTED-VALUE",
  "PLANTED-DICT-VALUE",
];

/** Tool answers shaped like every way a list tool could betray its promise. */
function leakyCall() {
  const calls = [];
  const call = async (name, args) => {
    calls.push({ name, args });
    if (name === "list_secrets") {
      // A vault that started returning objects with values in them.
      return JSON.stringify({
        secrets: [
          { name: "OPENAI_API_KEY", value: PLANTED[0], hint: "sk-l…0001" },
          { name: "GITHUB_TOKEN", secret: PLANTED[1], plaintext: PLANTED[1], masked: "ghp_…0000" },
          { key: "DB_PASSWORD", data: { value: PLANTED[2] }, tags: ["db", { value: PLANTED[2] }] },
          "PLAIN_NAME_ONLY",
        ],
        count: 4,
      });
    }
    if (name === "workspace_secrets_list") {
      // {NAME: "<value>"} -- the dict-of-values shape list_secrets' fallback would pass on.
      return JSON.stringify({ keys: { STRIPE_KEY: PLANTED[5], SIGNING_PEM: { value: PLANTED[3],
        description: "release signing", updated_at: "2026-10-01T00:00:00Z" } } });
    }
    if (name === "lockbox_user_list") {
      return JSON.stringify([{ secret_name: "MY_NOTE", value: PLANTED[4], meta: { value: PLANTED[4] } }]);
    }
    throw new Error(`unexpected tool ${name}`);
  };
  return { call, calls };
}

test("the IPC strips every value: a planted value never appears in what reaches the renderer", async () => {
  const { call, calls } = leakyCall();
  const handlers = secretsHandlers(createSecretsClient({ call }));
  const res = await handlers["desk:secrets-list"]();
  assert.equal(res.ok, true);
  const wire = JSON.stringify(res);
  for (const value of PLANTED) {
    assert.ok(!wire.includes(value), `a secret value crossed the bridge: ${value.slice(0, 12)}…`);
  }
  // The envelope's own `data` is the answer; inside it no value-shaped key may exist.
  assert.doesNotMatch(JSON.stringify(res.data), /"(value|secret|plaintext|data|meta)"\s*:/,
    "a value-shaped key crossed the bridge");
  // ...and the names did arrive, so the page is not just empty.
  const names = res.data.sources.flatMap((s) => (s.entries || []).map((e) => e.name)).sort();
  assert.deepEqual(names, ["DB_PASSWORD", "GITHUB_TOKEN", "MY_NOTE", "OPENAI_API_KEY", "PLAIN_NAME_ONLY",
    "SIGNING_PEM", "STRIPE_KEY"]);
  for (const s of res.data.sources) {
    for (const e of s.entries || []) {
      for (const k of Object.keys(e)) assert.ok(ENTRY_FIELDS.includes(k), `entry field ${k} is not allowlisted`);
    }
  }
  assert.deepEqual(calls.map((c) => c.name).sort(), SOURCES.map((s) => s.tool).sort());
  assert.ok(!calls.some((c) => /get|reveal|set|delete/.test(c.name)), "the page may only call list tools");
});

test("hints are masked here: at most the last four characters of a hint field", () => {
  assert.equal(maskHint("sk-l…0001"), `${MASK}0001`);
  assert.equal(maskHint("ab"), MASK, "a hint too short to mask shows only the mask");
  assert.equal(maskHint("****"), MASK);
  assert.equal(maskHint(""), null);
  const e = sanitiseEntry({ name: "X", hint: "sk-PLANTEDLONGVALUE9999" });
  assert.equal(e.hint, `${MASK}9999`);
  assert.ok(!JSON.stringify(e).includes("PLANTED"));
  assert.equal(sanitiseEntry({ name: "X", value: "abcdef123456" }).hint, null,
    "a hint is never derived from the value");
});

test("sanitiseList handles list, keys-dict, bare array and garbage without throwing", () => {
  assert.deepEqual(sanitiseList({ secrets: ["B", "A"] }).map((e) => e.name), ["A", "B"]);
  assert.deepEqual(sanitiseList({ keys: { K: "v" } }).map((e) => e.name), ["K"]);
  assert.deepEqual(sanitiseList([{ id: "i1" }]).map((e) => e.name), ["i1"]);
  assert.deepEqual(sanitiseList({ count: 3 }), []);
  assert.deepEqual(sanitiseList({ secrets: [null, 7, {}, { name: "" }] }).map((e) => e.name), ["7"]);
});

test("one failed scope is its own error, never an empty list, and the others still answer", async () => {
  const call = async (name) => {
    if (name === "lockbox_user_list") {
      return JSON.stringify({ error: "no_caller_token", message: "Lockbox tools act as the calling user" });
    }
    if (name === "workspace_secrets_list") throw new Error("HTTP 503: identity_unreachable");
    return JSON.stringify({ secrets: ["A"], count: 1 });
  };
  const res = await secretsHandlers(createSecretsClient({ call }))["desk:secrets-list"]();
  assert.equal(res.ok, true);
  assert.equal(res.data.failed, 2);
  const by = Object.fromEntries(res.data.sources.map((s) => [s.id, s]));
  assert.equal(by.platform.ok, true);
  assert.equal(by.platform.count, 1);
  assert.equal(by.personal.ok, false);
  assert.match(by.personal.error, /lockbox_user_list: no_caller_token -- Lockbox tools act as the calling user/);
  assert.equal(by.personal.entries, undefined, "a failed scope carries no list to render as 'none'");
  assert.match(by.workspace.error, /identity_unreachable/);
});

test("the bridge exposes ONE verb and the page has no reveal/copy/set control", () => {
  const preload = fs.readFileSync(path.join(__dirname, "secrets-preload.cjs"), "utf8");
  const verbs = [...preload.matchAll(/^\s{2}(\w+):/gm)].map((m) => m[1]);
  assert.deepEqual(verbs, ["list"]);
  assert.deepEqual(Object.keys(secretsHandlers({ list: async () => ({}) })), ["desk:secrets-list"]);
  const html = fs.readFileSync(path.join(__dirname, "secrets.html"), "utf8");
  assert.doesNotMatch(html, /bridge\.(get|reveal|set|copy|delete)/);
  assert.doesNotMatch(html, /innerHTML/, "names are data, rendered with textContent");
});

test("a failed scope's error text is capped and masked before it crosses the bridge", async () => {
  // workspace_secrets_list quotes up to 500 chars of the Genesis body into its error.
  const body = `{"name":"OPENAI","value":"${PLANTED[2]}","token":"${PLANTED[0]}"} ${PLANTED[1]} `
    + "x".repeat(600);
  const call = async (name) => {
    if (name === "workspace_secrets_list") throw new Error(`HTTP 500: ${body}`);
    if (name === "lockbox_user_list") return JSON.stringify({ error: "denied", message: PLANTED[1] });
    return JSON.stringify({ secrets: ["A"], count: 1 });
  };
  const res = await secretsHandlers(createSecretsClient({ call }))["desk:secrets-list"]();
  const blob = JSON.stringify(res);
  for (const v of PLANTED) assert.ok(!blob.includes(v), `planted ${v.slice(0, 12)} reached the renderer`);
  const by = Object.fromEntries(res.data.sources.map((s) => [s.id, s]));
  assert.ok(by.workspace.error.length <= ERROR_MAX);
  assert.match(by.workspace.error, /^HTTP 500: /, "the useful head survives");
  assert.match(by.personal.error, /denied/);
  // The outer answer() path is masked too.
  const outer = await secretsHandlers({ list: async () => { throw new Error(`boom ${PLANTED[1]}`); } })[
    "desk:secrets-list"]();
  assert.equal(outer.ok, false);
  assert.ok(!outer.error.includes(PLANTED[1]));
  assert.equal(safeError("HTTP 503: identity_unreachable"), "HTTP 503: identity_unreachable");
  assert.equal(safeError(null), "");
});
