"use strict";

/**
 * launcher.html -- the Alt+Space overlay the owner actually types into.
 *
 * The page has no smoke of its own: `npm run test:space` drives the Space pane,
 * not this window, so a crash in `render()` shipped with every unit test green
 * and the overlay drew nothing but a heading. Measured 2026-11-06: the page read
 * `group.shown` while the groups that were passed carried only `items`, so
 * `for (const item of undefined)` threw on the FIRST group and the list the
 * owner asked for never appeared.
 *
 * These tests read the page's own source. The two pure functions are extracted
 * and EXECUTED (they are the answer-resolution rules); the rest are structural
 * assertions on the shapes that have broken before.
 */
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const SOURCE = fs.readFileSync(path.join(__dirname, "launcher.html"), "utf8");

/** The text of `function name(` up to its matching closing brace. */
function functionText(source, name) {
  const start = source.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `launcher.html no longer defines ${name}`);
  let depth = 0;
  let opened = false;
  for (let i = start; i < source.length; i += 1) {
    const ch = source[i];
    if (ch === "{") { depth += 1; opened = true; }
    else if (ch === "}") {
      depth -= 1;
      if (opened && depth === 0) return source.slice(start, i + 1);
    }
  }
  throw new Error(`${name} is not closed`);
}

function loadPure(name) {
  // The page's own source, executed here on purpose: these two functions are
  // pure and this is the only way to test the rules the owner actually types into.
  return new Function(`${functionText(SOURCE, name)}; return ${name};`)();
}

const matchOption = loadPure("matchOption");
const recommendedIndex = loadPure("recommendedIndex");

const OPTIONS = [
  { index: 1, key: "ack", label: "Acknowledge" },
  { index: 2, key: "later", label: "Not now" },
  { index: 3, key: "retry", label: "Retry it", recommended: true },
];

test("a group without `shown` still draws its rows (the list-appears crash)", () => {
  // Both the row model and the renderer must fall back to `items`.
  const reads = SOURCE.match(/group\.shown/g) || [];
  assert.equal(reads.length, 2, "rowsFor and render each read group.shown once");
  const fallbacks = SOURCE.match(/group\.shown \|\| group\.items/g) || [];
  assert.equal(fallbacks.length, 2, "a group that sends only `items` must not blank the list");
  // And the group that the empty overlay builds really does send `shown`.
  const { needsYouGroup } = require("./launcher-context.cjs");
  const group = needsYouGroup([{ id: "d-1", title: "Ask" }, { id: "d-2", title: "Ask 2" }]).group;
  assert.ok(Array.isArray(group.shown) && group.shown.length === 2);
  assert.ok(Array.isArray(group.items) && group.items.length === 2);
});

test("typed text that names an option answers it; a single letter never guesses", () => {
  assert.equal(matchOption(OPTIONS, "ack").index, 1, "an exact key answers");
  assert.equal(matchOption(OPTIONS, "Not now").index, 2, "an exact label answers");
  assert.equal(matchOption(OPTIONS, "not n").index, 2, "a unique label prefix answers");
  assert.equal(matchOption(OPTIONS, "n"), null, "'n' is for finding, not answering");
  assert.equal(matchOption(OPTIONS, "zzz"), null);
  assert.equal(matchOption(null, "ack"), null, "a card with no options answers nothing");
});

test("Enter on an open card takes the recommendation, then the default, then the first", () => {
  assert.equal(recommendedIndex({ options: OPTIONS }), 3, "the raiser's recommendation wins");
  assert.equal(
    recommendedIndex({ options: OPTIONS, defaultKey: "later" }),
    3,
    "a recommendation outranks the default key",
  );
  const noRec = OPTIONS.map((o) => ({ ...o, recommended: false }));
  assert.equal(recommendedIndex({ options: noRec, defaultKey: "later" }), 2, "then the default key");
  assert.equal(recommendedIndex({ options: noRec }), 1, "then the first option");
  assert.equal(recommendedIndex({ options: [] }), null, "nothing to take");
});

test("1-9 answer the focused card only while the box is empty", () => {
  const start = SOURCE.indexOf('input.addEventListener("keydown"');
  assert.notEqual(start, -1, "launcher.html still binds a keydown handler on the box");
  const handler = SOURCE.slice(start, SOURCE.indexOf("});", start));
  assert.match(handler, /!input\.value && \/\^\[1-9\]\$\//, "a digit is an answer only in an empty box");
  assert.match(handler, /row\.item\.kind === "card"/, "digits act on a card row, not an app row");
  assert.match(handler, /o\.index === Number\(event\.key\)/, "the digit is the option's own index");
  assert.match(handler, /answerOption\(row\.item, option\.index\)/);
});

test("Esc collapses an open card first and only then closes the window", () => {
  const escape = SOURCE.slice(SOURCE.indexOf('if (event.key === "Escape")'));
  const collapse = escape.indexOf("state.openCard = null");
  const hide = escape.indexOf("window.aitherLauncher.hide()");
  assert.ok(collapse !== -1, "Esc still collapses");
  assert.ok(hide !== -1, "Esc still closes the window");
  assert.ok(collapse < hide, "collapsing comes first -- Esc never closes on the first press");
  // Esc must never answer: no run/answer call before the hide.
  const beforeHide = escape.slice(0, hide);
  assert.doesNotMatch(beforeHide, /answerOption|\.run\(/, "Esc answers nothing");
});

test("Enter opens a card before it answers it", () => {
  const run = functionText(SOURCE, "runSelected");
  const open = run.indexOf("toggleCard(item.key)");
  const answer = run.indexOf("recommendedIndex(item)");
  assert.ok(open !== -1 && answer !== -1);
  assert.ok(open < answer, "the first Enter opens, the second takes the recommendation");
  assert.match(run, /matchOption\(item\.options, term\)/, "typed text naming an option answers directly");
});
