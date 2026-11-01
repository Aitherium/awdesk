"use strict";
// The rail draws real icons, not two-letter tiles (owner screenshot 2026-11-01).
// Asserts: every icon name a rail row can carry has an SVG in browser-chrome.html's
// ICON_SVG map, and innerHTML is only ever fed from that constant map.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const html = fs.readFileSync(path.join(__dirname, "browser-chrome.html"), "utf8");
const rail = fs.readFileSync(path.join(__dirname, "browser-rail.cjs"), "utf8");

function iconMapKeys() {
  const start = html.indexOf("const ICON_SVG = {");
  assert.ok(start >= 0, "ICON_SVG map missing from browser-chrome.html");
  const body = html.slice(start, html.indexOf("};", start));
  return new Set([...body.matchAll(/^\s*([a-z][a-z0-9]*):\s*ico\(/gm)].map((m) => m[1]));
}

test("every rail icon name has an SVG (no fallback tiles for known rows)", () => {
  const keys = iconMapKeys();
  const used = new Set([...rail.matchAll(/\bicon:\s*"([a-z0-9]+)"/g)].map((m) => m[1]));
  assert.ok(used.size > 0, "found no icon names in browser-rail.cjs");
  const missing = [...used].filter((n) => !keys.has(n));
  assert.deepStrictEqual(missing, [], `icons with no SVG: ${missing.join(", ")}`);
});

test("innerHTML is assigned only from the constant icon map", () => {
  const sinks = [...html.matchAll(/\.innerHTML\s*=\s*([^;]+);/g)].map((m) => m[1].trim());
  for (const rhs of sinks) {
    assert.ok(!/label|title|row\.|textContent/.test(rhs), `innerHTML fed from a non-constant: ${rhs}`);
  }
});

test("the two-letter tile helper is gone; unknown icons fall back to one letter", () => {
  assert.ok(!/slice\(0,\s*2\)/.test(html.slice(html.indexOf("const ICON_SVG"))), "two-letter tile still present");
  assert.match(html, /const initial = \(label\) =>[^\n]*slice\(0, 1\)/);
});
