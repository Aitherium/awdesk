// node electron/speakable.test.cjs -- the desk says what a line SOUNDS like.
// The vectors match awkit speakable.test.ts and Speakable.java's check.
"use strict";

const assert = require("node:assert/strict");
const { speakable } = require("./speakable.cjs");

const cases = [
  ["*blinks* *bounces* 🐾 Hi Athena!", "Hi Athena!"],
  ["*waves* Hello from the desk.", "Hello from the desk."],
  ["That is *so* cool.", "That is so cool."],
  ["**Done.** Next step.", "Done. Next step."],
  ["(laughs) Okay, (5 + 5) is ten [1].", "Okay, (5 + 5) is ten [1]."],
  ["# Heading\n- one\n- two", "Heading one two"],
  ["Use `npm test` now ✨", "Use npm test now"],
  ["", ""],
  [null, ""],
];

let bad = 0;
for (const [input, want] of cases) {
  const got = speakable(input);
  try {
    assert.equal(got, want);
  } catch {
    bad += 1;
    console.log(`FAIL ${JSON.stringify(input)} -> ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
  }
}
console.log(bad === 0 ? `ok ${cases.length}` : `${bad} FAILED`);
process.exit(bad === 0 ? 0 : 1);
