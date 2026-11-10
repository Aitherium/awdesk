// A Claude permission-grant card is approved where the answer gets SIGNED (Online),
// never by a local unsigned `awask answer` (2026-11-09).
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

function fresh(dir) {
  process.env.AITHER_DECISIONS_DIR = dir;
  delete require.cache[require.resolve("./decision-cards.cjs")];
  return require("./decision-cards.cjs");
}

test("a grant card's Approve opens Online and spawns no local answer", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cards-"));
  fs.writeFileSync(path.join(dir, "d-grant1.json"), JSON.stringify({
    id: "d-grant1", status: "open", facts: ["permission_rule: Bash(podman secret create aither-x:*)"] }));
  const dc = fresh(dir);
  const opened = [];
  dc.setSignedAnswerOpener((u) => opened.push(u));
  const spawned = [];
  const ok = dc.answerCard("d-grant1", "grant", "", (...a) => { spawned.push(a); return { on() {}, unref() {} }; });
  assert.equal(ok, true);
  assert.deepEqual(opened, [dc.SIGNED_ANSWER_URL]);
  assert.equal(spawned.length, 0, "no unsigned local answer");
  assert.equal(dc.lastSignedHandoff().id, "d-grant1");
});

test("Deny, and every ordinary card, still answer locally", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cards-"));
  fs.writeFileSync(path.join(dir, "d-grant2.json"), JSON.stringify({ id: "d-grant2", facts: ["permission_rule: Bash(x y z abc:*)"] }));
  fs.writeFileSync(path.join(dir, "d-plain.json"), JSON.stringify({ id: "d-plain", facts: ["job: nightly"] }));
  const dc = fresh(dir);
  const opened = [];
  dc.setSignedAnswerOpener((u) => opened.push(u));
  assert.equal(dc.needsSignedAnswer(dc.readCardRaw("d-plain")), false);
  assert.equal(dc.needsSignedAnswer(dc.readCardRaw("d-grant2")), true);
  dc.answerCard("d-grant2", "deny", "", () => ({ on() {}, unref() {} }));
  dc.answerCard("d-plain", "keep", "", () => ({ on() {}, unref() {} }));
  assert.deepEqual(opened, []);
});

test("a malformed id never becomes a path", () => {
  const dc = fresh(fs.mkdtempSync(path.join(os.tmpdir(), "cards-")));
  assert.equal(dc.readCardRaw("../../etc/passwd"), null);
  assert.equal(dc.readCardRaw("d-ok/../x"), null);
});
