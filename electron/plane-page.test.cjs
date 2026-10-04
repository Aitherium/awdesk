"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

// plane-page.js is a classic browser script; package.json makes .js ESM, so it
// is evaluated here with a `module` object and exports its pure half (no DOM).
function loadPage() {
  const sandbox = { module: { exports: {} } };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, "plane-page.js"), "utf8"), sandbox);
  return sandbox.module.exports;
}
const page = loadPage();

test("serviceVerdict: running is up, stopped is down, anything unknown is NEVER up", () => {
  assert.equal(page.serviceVerdict({ services: { Pulse: { status: "running" } } }).state, "up");
  assert.equal(page.serviceVerdict({ services: { Pulse: { status: "exited" } } }).state, "down");
  assert.equal(page.serviceVerdict({ services: { Pulse: { healthy: false, status: "running" } } }).state, "down");
  assert.equal(page.serviceVerdict({ services: { Pulse: { status: "starting" } } }).state, "unknown");
  assert.equal(page.serviceVerdict({ services: {} }).state, "unknown");
  assert.equal(page.serviceVerdict(null).state, "unknown");
  assert.equal(page.serviceVerdict({ status: "healthy" }).state, "up");
  // One of two rows down -> the plane is down, not "mostly up".
  assert.equal(page.serviceVerdict({ services: { A: { status: "running" }, B: { status: "dead" } } }).state, "down");
});

test("formatScalar reads bytes, percents and booleans from their keys", () => {
  assert.equal(page.formatScalar("free_bytes", 1536), "1.5 KiB");
  assert.equal(page.formatScalar("size", 3 * 1024 * 1024 * 1024), "3.0 GiB");
  assert.equal(page.formatScalar("used_percent", 41.26), "41.3%");
  assert.equal(page.formatScalar("enabled", true), "yes");
  assert.equal(page.formatScalar("enabled", false), "no");
  assert.equal(page.formatScalar("x", null), "—");
  assert.equal(page.formatScalar("count", 7), "7");
  assert.equal(page.humanBytes(-1), "-1");
});

test("tableColumns: scalar keys only, first seen first, capped", () => {
  const rows = [{ name: "a", nested: { x: 1 }, size: 1 }, { name: "b", kind: "dir" }];
  // Spread: the array comes from the vm realm, deepStrictEqual compares prototypes.
  assert.deepEqual([...page.tableColumns(rows)], ["name", "size", "kind"]);
  const wide = [{ a: 1, b: 2, c: 3, d: 4, e: 5, f: 6, g: 7, h: 8 }];
  assert.equal(page.tableColumns(wide).length, page.MAX_COLS);
});

test("serviceVerdict grades only the named row of a whole-fleet answer", () => {
  const fleet = { services: { Genesis: { status: "running" }, Strata: { status: "running" },
    Pulse: { status: "stopped" }, Chronicle: { status: "unknown" } } };
  assert.equal(page.serviceVerdict(fleet, "Strata").state, "up", "a stopped Pulse is not Strata's problem");
  assert.equal(page.serviceVerdict(fleet, "Strata").text, "running");
  assert.equal(page.serviceVerdict(fleet, "pulse").state, "down");
  const missing = page.serviceVerdict(fleet, "Nexus");
  assert.equal(missing.state, "unknown");
  assert.equal(missing.text, "not listed");
  assert.equal(page.serviceVerdict({ service: "Flux", listed: false, services: {} }).text, "not listed");
  assert.equal(page.serviceVerdict({ service: "Flux", listed: true,
    services: { Flux: { status: "running" } } }).state, "up");
});
