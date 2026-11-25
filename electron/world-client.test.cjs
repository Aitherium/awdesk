"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const world = require("./world-client.cjs");

function fakeFetch(answers) {
  const calls = [];
  return {
    calls,
    async fetchImpl(url, init) {
      calls.push({ url, init });
      const answer = answers[url] ?? answers["*"];
      if (answer instanceof Error) throw answer;
      return answer;
    },
  };
}

const json = (body, status = 200) => ({ ok: status < 400, status, async json() { return body; } });

test("layers reads the AI layer catalogue in its list and keyed shapes", async () => {
  const f = fakeFetch({ "*": json({ layers: [{ id: "viirs", label: "Night lights", enabled: true }, "conflict"] }) });
  const r = await world.createClient({ fetchImpl: f.fetchImpl }).layers();
  assert.equal(r.ok, true);
  assert.deepEqual(r.layers.map((l) => l.id), ["viirs", "conflict"]);
  assert.equal(r.layers[0].on, true);
});

test("pins normalises, keeps only mappable pins and reports truncation", async () => {
  const f = fakeFetch({ "*": json({ pins: [
    { id: "a", lat: 1.5, lon: 2.5, label: "Port", kind: "ship" },
    { pin_id: "b", latitude: "3", longitude: "4", title: "Base" },
    { id: "c", label: "no coords" },
  ] }) });
  const r = await world.createClient({ fetchImpl: f.fetchImpl }).pins();
  assert.equal(r.ok, true);
  assert.equal(r.pins.length, 2);
  assert.deepEqual(r.pins[1], { id: "b", lat: 3, lng: 4, label: "Base", kind: "", at: "" });
  assert.equal(r.truncated, false);
});

test("search is a LOCAL filter and says so", async () => {
  const f = fakeFetch({ "*": json([
    { id: "1", lat: 1, lng: 1, label: "Sevastopol", kind: "port" },
    { id: "2", lat: 2, lng: 2, label: "Odessa", kind: "port" },
  ]) });
  const r = await world.createClient({ fetchImpl: f.fetchImpl }).search("sevas");
  assert.equal(r.ok, true);
  assert.equal(r.local, true);
  assert.equal(r.results.length, 1);
  assert.equal(r.results[0].label, "Sevastopol");
});

test("an unreachable host is UNREACHABLE, not an empty world", async () => {
  const f = fakeFetch({ "*": Object.assign(new Error("socket hang up"), { name: "Error" }) });
  const r = await world.createClient({ fetchImpl: f.fetchImpl }).pins();
  assert.equal(r.ok, false);
  assert.equal(r.unreachable, true);
  assert.match(r.error, /did not answer/);
});

test("a non-JSON answer and an unknown shape are refused, never guessed", async () => {
  const html = { ok: true, status: 200, async json() { throw new SyntaxError("Unexpected token <"); } };
  const r1 = await world.createClient({ fetchImpl: fakeFetch({ "*": html }).fetchImpl }).layers();
  assert.equal(r1.ok, false);
  assert.match(r1.error, /not JSON/);

  const r2 = await world.createClient({ fetchImpl: fakeFetch({ "*": json({ unexpected: true }) }).fetchImpl }).pins();
  assert.equal(r2.ok, false);
  assert.match(r2.error, /unfamiliar shape/);
});

test("only public read routes are ever requested", async () => {
  const f = fakeFetch({ "*": json([]) });
  const client = world.createClient({ fetchImpl: f.fetchImpl });
  await client.layers();
  await client.pins();
  for (const call of f.calls) {
    assert.match(call.url, /^https:\/\/shadowbroker\.aitherium\.com\/api\/ai\//);
    assert.equal(call.init.method, undefined);
  }
});

test("pinLine and mapUrl render a pin for a room or a page", () => {
  const line = world.pinLine({ label: "Port", kind: "ship", lat: 44.6166, lng: 33.5254 });
  assert.equal(line, "- Port [ship] (44.6166, 33.5254)");
  assert.equal(world.mapUrl({ lat: 44.6166, lng: 33.5254 }), "https://shadowbroker.aitherium.com/?lat=44.6166&lng=33.5254");
  assert.equal(world.mapUrl({}), "https://shadowbroker.aitherium.com");
});
