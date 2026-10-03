"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { readInnerState } = require("./sense-commands.cjs");

test("asks the gateway's sense_inner_state tool and says the mood in one line", async () => {
  const calls = [];
  const fake = async (name, args) => {
    calls.push([name, args]);
    return JSON.stringify({
      mood: "anxious",
      current_concern: "reliability issue",
      thoughts: [{ type: "musing", content: "Something isn't right..." }],
      daydreams: [{ type: "wonder", content: "I wonder about the heartbeat" }],
      errors: {},
    });
  };
  const v = await readInnerState(fake);
  assert.deepEqual(calls, [["sense_inner_state", { limit: 3 }]]);
  assert.equal(v.ok, true);
  assert.match(v.message, /mood anxious/);
  assert.match(v.message, /concern: reliability issue/);
  assert.match(v.message, /daydream: I wonder/);
});

test("a source error with no mood is a FAILURE, not a calm empty state", async () => {
  const v = await readInnerState(async () => JSON.stringify({ mood: null, errors: { innerlife: "HTTP 500" } }));
  assert.equal(v.ok, false);
  assert.match(v.message, /innerlife: HTTP 500/);
});

test("a gateway denial in prose comes back as the error", async () => {
  const v = await readInnerState(async () => "Tool 'sense_inner_state' is not available on the platform tier");
  assert.equal(v.ok, false);
  assert.match(v.message, /not available/);
});

test("a transport failure is reported", async () => {
  const v = await readInnerState(async () => { throw new Error("503 billing_unavailable"); });
  assert.equal(v.ok, false);
  assert.match(v.message, /503/);
});
