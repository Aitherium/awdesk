"use strict";

// A stray C0 control byte in desk source renders as a box glyph (owner 2026-11-07:
// the rail's section chevrons showed "[]BE" because a scripted edit turned the CSS
// escape for U+25BE into the byte 0x15). Tab, LF and CR are the only ones allowed.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const EXT = new Set([".html", ".css", ".js", ".cjs", ".mjs", ".json"]);
const BACKSLASH = String.fromCharCode(92);

function* walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === "vendor" || e.name === "node_modules") continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) yield* walk(p);
    else if (EXT.has(path.extname(e.name))) yield p;
  }
}

test("no desk source file carries a control byte (other than tab/LF/CR)", () => {
  const bad = [];
  for (const file of walk(__dirname)) {
    const buf = fs.readFileSync(file);
    for (let i = 0; i < buf.length; i += 1) {
      const c = buf[i];
      if (c < 32 && c !== 9 && c !== 10 && c !== 13) {
        bad.push(`${path.relative(__dirname, file)} @${i} 0x${c.toString(16)}`);
        break;
      }
    }
  }
  assert.deepEqual(bad, []);
});

test("the rail's section chevrons are real CSS escapes (U+25BE open, U+25B8 folded)", () => {
  const html = fs.readFileSync(path.join(__dirname, "browser-chrome.html"), "utf8");
  assert.ok(html.includes(`.sec::before { content: "${BACKSLASH}25BE"`), "open chevron escape");
  assert.ok(html.includes(`.sec.folded::before { content: "${BACKSLASH}25B8"`), "folded chevron escape");
});
