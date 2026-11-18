// A card whose answer must be SIGNED (an awstorage proposal/plan, or a Claude
// permission grant) is approved where Genesis signs the answer, never by a local
// unsigned `awask answer` (2026-11-09).
//
// 2026-11-18: that handoff used to open `mission-control?tab=decisions` with NO
// card id -- the whole hub (scope spinner, then a white screen). It now opens
// `/approve?card=<id>&choice=<key>`, the SAME signed-approval implementation
// main.cjs uses, so a voice/index answer and a click cannot disagree.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const signedApproval = require("./signed-approval.cjs");

function fresh(dir) {
  process.env.AITHER_DECISIONS_DIR = dir;
  delete require.cache[require.resolve("./decision-cards.cjs")];
  return require("./decision-cards.cjs");
}

function tmpCards() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cards-"));
  fs.writeFileSync(path.join(dir, "d-grant1.json"), JSON.stringify({
    id: "d-grant1",
    status: "open",
    title: "Grant Bash",
    facts: ["permission_rule: Bash(podman secret create aither-x:*)"],
    options: [
      { key: "grant", label: "Grant" },
      { key: "deny", label: "Deny" },
    ],
  }));
  return dir;
}

const noSpawn = () => { throw new Error("an unsigned local answer was spawned"); };

/** The card= and choice= parameters of an approve URL. */
function approveParams(url) {
  const u = new URL(url);
  return { card: u.searchParams.get("card"), choice: u.searchParams.get("choice"), path: u.pathname };
}

test("a grant card's Approve opens /approve with the card id and choice, and spawns no local answer", () => {
  const dc = fresh(tmpCards());
  const opened = [];
  dc.setSignedAnswerOpener((u) => opened.push(u));
  const ok = dc.answerCard("d-grant1", "grant", "", noSpawn);
  assert.equal(ok, true);
  assert.equal(opened.length, 1);
  assert.deepEqual(approveParams(opened[0]), { card: "d-grant1", choice: "grant", path: "/approve" });
  assert.equal(opened[0], signedApproval.approveUrl("d-grant1", "grant"));
  assert.deepEqual(
    { id: dc.lastSignedHandoff().id, choice: dc.lastSignedHandoff().choice, url: dc.lastSignedHandoff().url },
    { id: "d-grant1", choice: "grant", url: opened[0] },
  );
});

test("the voice/index paths (answerCardIndex, answerCardText) carry card= and choice=", () => {
  const dc = fresh(tmpCards());
  const opened = [];
  dc.setSignedAnswerOpener((u) => opened.push(u));

  assert.equal(dc.answerCardIndex("d-grant1", 1, { spawnFn: noSpawn }), true);
  assert.equal(dc.answerCardText("d-grant1", "grant", { spawnFn: noSpawn }), true);

  assert.equal(opened.length, 2, "both voice/index answers handed off");
  for (const url of opened) {
    const p = approveParams(url);
    assert.equal(p.path, "/approve");
    assert.equal(p.card, "d-grant1");
    assert.equal(p.choice, "grant");
  }
});

test("an awstorage proposal card is routed signed from the voice/index path too", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cards-"));
  fs.writeFileSync(path.join(dir, "d-plan1.json"), JSON.stringify({
    id: "d-plan1", status: "open", kind: "awstorage-manage",
    facts: ["proposal_id: 42"], options: [{ key: "approve", label: "Approve" }],
  }));
  const dc = fresh(dir);
  const opened = [];
  dc.setSignedAnswerOpener((u) => opened.push(u));
  assert.equal(dc.needsSignedAnswer(dc.readCardRaw("d-plan1")), true, "the exported predicate agrees with the route");
  assert.equal(dc.answerCardIndex("d-plan1", 1, { spawnFn: noSpawn }), true);
  assert.deepEqual(approveParams(opened[0]), { card: "d-plan1", choice: "approve", path: "/approve" });
});

test("Deny, and every ordinary card, still answer locally", () => {
  const dir = tmpCards();
  fs.writeFileSync(path.join(dir, "d-plain.json"), JSON.stringify({ id: "d-plain", status: "open", facts: ["job: nightly"] }));
  const dc = fresh(dir);
  const opened = [];
  const spawned = [];
  dc.setSignedAnswerOpener((u) => opened.push(u));
  const spawnFn = (...a) => { spawned.push(a); return { on() {}, unref() {} }; };
  assert.equal(dc.needsSignedAnswer(dc.readCardRaw("d-plain")), false);
  assert.equal(dc.needsSignedAnswer(dc.readCardRaw("d-grant1")), true);
  dc.answerCard("d-grant1", "deny", "", spawnFn);
  dc.answerCard("d-plain", "keep", "", spawnFn);
  assert.deepEqual(opened, []);
  assert.equal(spawned.length, 2, "both local answers went to awask");
});

test("static: mission-control?tab=decisions is never an approve target", () => {
  // The wrong URL loaded the whole hub with no card id. Nothing in the electron
  // main-process tree may open it as an approval handoff again. Test files are
  // excluded so this assertion does not match its own source text.
  const dir = __dirname;
  const offenders = fs.readdirSync(dir)
    .filter((name) => name.endsWith(".cjs") && !name.endsWith(".test.cjs"))
    .filter((name) => fs.readFileSync(path.join(dir, name), "utf8").includes("mission-control?tab=decisions"));
  assert.deepEqual(offenders, [], `approve target must be /approve?card=&choice=, found in: ${offenders.join(", ")}`);
});

test("static: main.cjs opens the SAME in-app approve window for a launcher/palette answer", () => {
  // decision-cards' default opener is shell.openExternal; main.cjs must replace it
  // with the in-app window a click uses, or one card's approval lands in the system
  // browser (no persisted approve partition, no navigation guard).
  const src = fs.readFileSync(path.join(__dirname, "main.cjs"), "utf8");
  const i = src.indexOf("decisionCards.setSignedAnswerOpener(");
  assert.ok(i > 0, "main.cjs wires decision-cards' signed handoff");
  const body = src.slice(i, i + 400);
  assert.match(body, /signedApproval\.openApproveWindow\(\{ BrowserWindow/);
});

test("static: the launcher/palette reports a signed handoff as pending, never answered", () => {
  // answerCardIndex/answerCardText return true for a handoff too, so "answered"
  // would claim a card that is still open until the passkey ceremony lands.
  const src = fs.readFileSync(path.join(__dirname, "main.cjs"), "utf8");
  const i = src.indexOf('case "card-answer"');
  assert.ok(i > 0);
  const body = src.slice(i, i + 2000);
  assert.match(body, /lastSignedHandoff\(\)/, "the branch tells a handoff apart from an answer");
  assert.match(body, /pending: true/);
  assert.match(body, /opened the signed approval/);
});

test("a malformed id never becomes a path", () => {
  const dc = fresh(fs.mkdtempSync(path.join(os.tmpdir(), "cards-")));
  assert.equal(dc.readCardRaw("../../etc/passwd"), null);
  assert.equal(dc.readCardRaw("d-ok/../x"), null);
});
