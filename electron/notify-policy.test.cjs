"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const np = require("./notify-policy.cjs");
const ct = require("./card-toast.cjs");

const NL = String.fromCharCode(10);

// The toast the owner sent (2026-11-18): title cut mid-word, body repeating it.
const HOOK_CARD = {
  id: "d-wild",
  title: "Free RAM: To make WildAntheia's starting still on the local 5090, OK to stop two idle fleet units (aither-ait…",
  summary: "Needs: To make WildAntheia's starting still on the local 5090, OK to stop two idle fleet units (aither-cinema, aither-mediaforge)?",
  options: [
    { key: "ans:1", label: "Yes, stop them (Recommended)", recommended: true, consequence: "Stops both units; the still renders on the 5090 next." },
    { key: "ans:2", label: "No" },
  ],
};

// Shared vectors: the Python shape (adk.decisions.notify_policy) gives the same answers.
const VECTORS = [
  [HOOK_CARD.title, "OK to stop two idle fleet units?"],
  ["Burst spend: OK to spend real money to render WildAntheia's clip now? It rents a vast.ai GPU", "OK to spend real money to render WildAntheia's clip now?"],
  ["Turn on automatic cloud burst for media renders (vast.ai, capped)?", "Turn on automatic cloud burst for media renders?"],
  ["Reboot the desktop (re-raised: the first card was closed by an agent message, not by you)", "Reboot the desktop."],
  ["Apply the Occupy SaaS product plan: 9 domain homes, forum tags, 40 triage replies, 22 products?", "Apply the Occupy SaaS product plan: 9 domain homes?"],
  ["Sessions: Which dead sessions should I reopen as Windows Terminal tabs?", "Which dead sessions should I reopen as Windows Terminal…"],
  ["Claude Code needs you: AitherOS-Fresh -- please transform this into a resume plan for the multiagent workflow:…", "Claude Code needs you: AitherOS-Fresh."],
];

test("the owner's toast: a whole-sentence title and an approve line, nothing repeated", () => {
  const s = np.shape(HOOK_CARD);
  assert.equal(s.title, "OK to stop two idle fleet units?");
  assert.equal(s.body, "If you approve: Stops both units; the still renders on the 5090 next.");
  assert.ok(!/Needs/.test(s.body) && !/WildAntheia/.test(s.body));
});

for (const [title, want] of VECTORS) {
  test(`headline: ${want}`, () => {
    const got = np.headline({ title });
    assert.equal(got, want);
    assert.ok(got.length <= 60, `${got.length} > 60`);
  });
}

test("a title is never cut mid-word and always ends a sentence", () => {
  for (const title of ["x".repeat(300), "word ".repeat(40), "", "a b c d e f g h i j k l m n o p q r s t u v w x y z aa bb cc dd"]) {
    const got = np.headline({ title });
    assert.ok(got.length > 0 && got.length <= 60, got);
    assert.match(got, /[.?!…]$/);
    const words = got.replace(/[.?!…]$/, "").split(" ");
    for (const w of words) assert.ok(title.toLowerCase().includes(w.toLowerCase()) || got === "A decision needs you.", `${w} is a fragment`);
  }
});

test("the body never repeats the title", () => {
  const s = np.shape({
    id: "d-1",
    title: "Turn on automatic cloud burst for media renders?",
    summary: ["Turn on automatic cloud burst for media renders?", "Code refuses spend."].join(NL),
    options: [{ key: "a", label: "Approve caps", consequence: "Approve caps" }],
  });
  assert.deepEqual(s.body.split(NL), ["If you approve: Approve caps.", "Code refuses spend."]);
});

test("the policy file's message limits are read; a broken file is the defaults", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "np-"));
  const good = path.join(dir, "good.json");
  fs.writeFileSync(good, JSON.stringify({ message: { title_max: 30 } }));
  assert.equal(np.readPolicy({ file: good }).message.title_max, 30);
  assert.ok(np.shape({ title: "OK to spend real money to render the clip now?" }, np.readPolicy({ file: good })).title.length <= 30);
  const bad = path.join(dir, "bad.json");
  fs.writeFileSync(bad, "{nope");
  assert.deepEqual(np.readPolicy({ file: bad }).message, np.DEFAULT_MESSAGE);
});

test("ledger: one toast per card id; changed words replace; same words are a dup", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "npl-"));
  const file = path.join(dir, "notify-ledger.json");
  // A Python sender already wrote the same file: its rows survive.
  fs.writeFileSync(file, JSON.stringify({ sent: { web_push: { "d-x": { at: 1, fp: "" } } }, desk_last_alive: 5 }));
  const ledger = np.createLedger({ file, now: () => 1_800_000_000_000 });
  assert.equal(ledger.claim("d-1", "A\nB"), "new");
  assert.equal(ledger.claim("d-1", "A\nB"), "dup");
  assert.equal(ledger.claim("d-1", "A\nC"), "update");
  assert.equal(ledger.claim("d-2", "A\nB"), "new");
  const data = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.ok(data.sent.desk_toast["d-1"] && data.sent.desk_toast["d-2"]);
  assert.equal(data.desk_last_alive, 5);
});

test("the card toast is built from the shape", () => {
  const toast = ct.buildCardToast(HOOK_CARD);
  assert.equal(toast.title, "OK to stop two idle fleet units?");
  assert.ok(toast.body.startsWith("If you approve: "));
});

test("main shows a card toast only through the ledger, and closes the old one on update", () => {
  const src = fs.readFileSync(path.join(__dirname, "main.cjs"), "utf8");
  const at = src.indexOf("function showCardToast(toast)");
  assert.ok(at > 0);
  const body = src.slice(at, src.indexOf("\n}", at));
  assert.match(body, /cardToastLedger\.claim\(toast\.cardId/);
  assert.match(body, /verdict === "dup"[\s\S]*return null/);
  assert.match(body, /previous\.close\(\)/);
});
