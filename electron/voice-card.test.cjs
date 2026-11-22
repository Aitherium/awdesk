"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  cardPrompt,
  matchReply,
  classifyCapture,
  gateReply,
  CAPTURE_PUSH_TO_TALK,
  CAPTURE_OPEN_MIC,
} = require("./voice-card.cjs");

const card = {
  id: "c1",
  title: "Restart the scheduler?",
  defaultKey: "later",
  options: [
    { key: "restart", label: "Restart now", recommended: true },
    { key: "later", label: "Later tonight" },
    { key: "restart-hard", label: "Restart now and clear the queue" },
  ],
};

test("the prompt reads the title and numbers every option, marking the recommended one", () => {
  assert.equal(
    cardPrompt(card),
    "A decision needs you: Restart the scheduler?. Options: one, Restart now, recommended; "
      + "two, Later tonight; three, Restart now and clear the queue. Say a number, or tell me what to do instead.",
  );
  assert.match(cardPrompt({ title: "Free text", options: [] }), /Tell me what to do\.$/);
});

test("a number picks that option however it is said", () => {
  for (const said of ["two", "Option two.", "the second one", "2"]) {
    assert.deepEqual(matchReply(card, said), { kind: "answer", key: "later", label: "Later tonight" }, said);
  }
});

test("the option's own words pick it, the longest match winning", () => {
  assert.equal(matchReply(card, "later tonight please").key, "later");
  assert.equal(matchReply(card, "restart now and clear the queue").key, "restart-hard");
  assert.equal(matchReply(card, "restart now").key, "restart");
});

test("a bare yes means the recommended option", () => {
  assert.equal(matchReply(card, "Yes, do it").key, "restart");
  const noRec = { ...card, options: card.options.map((o) => ({ ...o, recommended: false })) };
  assert.equal(matchReply(noRec, "yes").key, "later", "falls back to the card's default");
});

test("anything else is a steer to the session, never a guessed option", () => {
  assert.deepEqual(matchReply(card, "No -- wait until the ARC run finishes, then restart"), {
    kind: "steer",
    text: "No -- wait until the ARC run finishes, then restart",
  });
  // A long sentence that merely CONTAINS a number is not a pick.
  assert.equal(matchReply(card, "I think one of them is fine but check the logs first").kind, "steer");
});

test("silence is nothing, and a card without options only steers", () => {
  assert.deepEqual(matchReply(card, "   "), { kind: "none" });
  assert.equal(matchReply({ title: "t", options: [] }, "yes").kind, "steer");
});

// ── owner-voice gate (prompt-injection defence) ───────────────────────
// The defect: a card ask opened the mic, a YouTube video in the room was heard,
// and the stray sentence was STEERED to the raising session as the OWNER's words
// (a note marked "queued"). Ambient speech may never answer or steer a card.

test("an ambient (open-mic) transcript is UNVERIFIED and never becomes a steer or answer", () => {
  // The flagged sentence, verbatim in spirit: not a matching option.
  const stray = "as we saw here in Lowell Massachusetts where the law sided with the community";
  const g = gateReply(card, stray, { capture: CAPTURE_OPEN_MIC });
  assert.equal(g.kind, "unverified", "ambient speech must not be steered");
  assert.equal(g.verified, false);
  assert.equal(g.reason, "ambient");
  assert.equal(g.text, stray, "the caller may show it, but must not apply it");

  // Even an option's exact words heard on the open mic is UNVERIFIED: nobody
  // positive that the owner said it.
  assert.equal(gateReply(card, "Restart now", { capture: CAPTURE_OPEN_MIC }).kind, "unverified");
  // Defaults fail closed too: no options means the safest capture is ambient.
  assert.equal(gateReply(card, "Restart now").kind, "unverified");
});

test("a transcript taken while media is playing is UNVERIFIED even on push-to-talk", () => {
  assert.deepEqual(
    classifyCapture({ capture: CAPTURE_PUSH_TO_TALK, mediaPlaying: true }),
    { verified: false, reason: "media-playing" },
  );
  assert.equal(
    gateReply(card, "do the other one", { capture: CAPTURE_PUSH_TO_TALK, mediaPlaying: true }).kind,
    "unverified",
  );
});

test("a positive speaker match makes the transcript verified and still steers/answers", () => {
  // A matching speaker verifier is the strongest signal and wins over media.
  assert.deepEqual(
    classifyCapture({ capture: CAPTURE_OPEN_MIC, speakerVerified: true, mediaPlaying: true }),
    { verified: true, reason: "speaker-match" },
  );
  // A verified, non-matching reply is still a steer (the feature keeps working).
  assert.deepEqual(
    gateReply(card, "wait until the ARC run finishes", { speakerVerified: true }),
    { kind: "steer", text: "wait until the ARC run finishes", verified: true },
  );
  // A verified option pick is still an answer.
  assert.deepEqual(
    gateReply(card, "two", { speakerVerified: true }),
    { kind: "answer", key: "later", label: "Later tonight", verified: true },
  );
});

test("an explicit push-to-talk with no media is verified and still steers", () => {
  assert.deepEqual(
    classifyCapture({ capture: CAPTURE_PUSH_TO_TALK, mediaPlaying: false }),
    { verified: true, reason: "explicit-push-to-talk" },
  );
  assert.deepEqual(
    gateReply(card, "wait until the ARC run finishes", { capture: CAPTURE_PUSH_TO_TALK }),
    { kind: "steer", text: "wait until the ARC run finishes", verified: true },
  );
});

test("empty speech gates to none, never unverified noise", () => {
  assert.deepEqual(gateReply(card, "   ", { capture: CAPTURE_OPEN_MIC }), {
    kind: "none",
    verified: false,
    reason: "empty",
  });
});
