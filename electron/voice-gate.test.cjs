"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const gate = require("./voice-gate.cjs");

/**
 * The three real rows the desk dispatched or steered on 2026-11-23, copied
 * verbatim from %USERPROFILE%\.aither\desk-command.jsonl (source=voice).
 * They are media/room audio, not the owner talking to the desk.
 */
const FRAGMENT_CORE_WORLDS = "core worlds. Some people wouldn't";
const FRAGMENT_HORRENDOUS =
  "probably the most important person in the world has made some horrendous decisions and";
const FRAGMENT_MEDIA_LECTURE =
  "So you might own a little bit of this without ever deciding to if you own those funds. " +
  "Number two, we kind of already own this bet. I've done a lot of research on this. I was " +
  "talking about it earlier, the electricity crisis, mortgage rates. We are all really exposed " +
  "to what's happening with AI in tech right now. The S&P, one third of that is tech. Like, " +
  "you already own a lot of the AI trade. It's worked out pretty well up until this past " +
  "night, but just be aware of what you own, especially if you index funds. Number three is " +
  "borrow them. And the biggest companies are more than you borrow hundreds of billion.";
const REAL_FRAGMENTS = [FRAGMENT_CORE_WORLDS, FRAGMENT_HORRENDOUS, FRAGMENT_MEDIA_LECTURE];

test("every real fragment is rejected from every voice entry point", () => {
  for (const text of REAL_FRAGMENTS) {
    for (const provenance of gate.PROVENANCES) {
      const verdict = gate.assessVoice({ text, provenance, wakeWord: "aither" });
      assert.equal(verdict.pass, false, `${provenance} accepted: ${text.slice(0, 60)}`);
      assert.ok(verdict.reasons.length > 0, "a rejection always says why");
      assert.equal(verdict.text, "", "a rejected transcript is never handed on");
    }
  }
});

test("a fragment is named as a fragment, not merely as unaddressed", () => {
  const a = gate.assessVoice({ text: FRAGMENT_CORE_WORLDS, provenance: "push-to-talk" });
  assert.ok(a.reasons.some((r) => /fragment:/.test(r)), a.reasons.join("; "));
  const b = gate.assessVoice({ text: FRAGMENT_HORRENDOUS, provenance: "push-to-talk" });
  assert.ok(b.reasons.some((r) => /ends mid-sentence on "and"/.test(r)), b.reasons.join("; "));
  // The long lecture starts on a connective, so it is caught even with a period.
  assert.match(gate.fragmentReason(FRAGMENT_MEDIA_LECTURE), /connective/);
});

test("a complete push-to-talk request passes without a wake word", () => {
  const verdict = gate.assessVoice({ text: "what are my sessions doing", provenance: "push-to-talk" });
  assert.equal(verdict.pass, true, verdict.reasons.join("; "));
  assert.equal(verdict.text, "what are my sessions doing");
});

test("the open microphone needs a wake word or a direct address", () => {
  const bare = gate.assessVoice({ text: "record this", provenance: "open-mic", wakeWord: "aither" });
  assert.equal(bare.pass, false);
  assert.match(bare.reasons.join("; "), /open microphone/);

  const woke = gate.assessVoice({ text: "Hey Aither, record this", provenance: "open-mic", wakeWord: "aither" });
  assert.equal(woke.pass, true, woke.reasons.join("; "));
  assert.equal(woke.text, "record this", "the wake word is stripped before the command runs");

  // The built-in name works even with no wake word configured.
  const named = gate.assessVoice({ text: "Aither, record this", provenance: "open-mic" });
  assert.equal(named.pass, true, named.reasons.join("; "));
  assert.equal(named.text, "record this");
});

test("a spoken card answer must address the desk; a fragment is never a steer", () => {
  const bare = gate.assessVoice({ text: "two", provenance: "card-answer" });
  assert.equal(bare.pass, false, "a desk-armed microphone is not the owner's gesture");
  assert.match(bare.reasons.join("; "), /card answer/);

  const addressed = gate.assessVoice({ text: "Aither, two", provenance: "card-answer" });
  assert.equal(addressed.pass, true, addressed.reasons.join("; "));
  assert.equal(addressed.text, "two", "matchReply must see the bare option");

  const steer = gate.assessVoice({ text: FRAGMENT_HORRENDOUS, provenance: "card-answer", wakeWord: "aither" });
  assert.equal(steer.pass, false, "the fragment must never reach steerCard");
});

test("a verified owner voice stands in for the direct address", () => {
  const owner = gate.assessVoice({
    text: "record this", provenance: "open-mic", speakerId: "owner-1", ownerSpeakerId: "owner-1",
  });
  assert.equal(owner.pass, true, owner.reasons.join("; "));
  const stranger = gate.assessVoice({
    text: "record this", provenance: "open-mic", speakerId: "guest-2", ownerSpeakerId: "owner-1",
  });
  assert.equal(stranger.pass, false);
  assert.match(stranger.reasons.join("; "), /not the owner/);
});

test("audio the PC is playing at capture time rejects the words", () => {
  const echo = gate.assessVoice({ text: "Aither, what are my sessions doing", provenance: "open-mic", pcPlaying: true });
  assert.equal(echo.pass, false);
  assert.match(echo.reasons.join("; "), /PC was playing audio/);
});

test("rejections are written to a reviewable log, never dropped", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "voice-gate-"));
  const file = path.join(dir, "rejected.jsonl");
  const log = gate.createRejectionLog({ file, now: () => new Date("2026-11-23T04:31:54.751Z") });
  try {
    const verdict = gate.assessVoice({ text: FRAGMENT_CORE_WORLDS, provenance: "open-mic", wakeWord: "aither" });
    log.record({ text: FRAGMENT_CORE_WORLDS, provenance: verdict.provenance, reasons: verdict.reasons });
    const rows = log.recent(10);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].text, FRAGMENT_CORE_WORLDS);
    assert.equal(rows[0].at, "2026-11-23T04:31:54.751Z");
    assert.equal(rows[0].provenance, "open-mic");
    assert.ok(rows[0].reasons.length > 0);
    const onDisk = fs.readFileSync(file, "utf8").trim().split("\n");
    assert.equal(onDisk.length, 1, "one JSON object per line");
    assert.doesNotThrow(() => JSON.parse(onDisk[0]));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a missing log directory is created, not fatal", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "voice-gate-missing-"));
  const file = path.join(dir, "deep", "nested", "rejected.jsonl");
  try {
    const log = gate.createRejectionLog({ file });
    const entry = log.record({ text: "x", provenance: "open-mic", reasons: ["r"] });
    assert.equal(entry.text, "x");
    assert.equal(fs.existsSync(file), true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a waiting card ask claims every transcript, whatever the renderer says", () => {
  assert.equal(
    gate.normalizeProvenance({ mode: "push-to-talk", cardWaiting: true }),
    "card-answer",
  );
  // The renderer's own labels map one-to-one.
  assert.equal(gate.normalizeProvenance({ mode: "open" }), "open-mic");
  assert.equal(gate.normalizeProvenance({ mode: "open-mic" }), "open-mic");
  assert.equal(gate.normalizeProvenance({ mode: "one-shot" }), "one-shot");
  assert.equal(gate.normalizeProvenance({ mode: "push-to-talk" }), "push-to-talk");
  // An explicit card-answer from a replay must not be mistaken for a press.
  assert.equal(gate.normalizeProvenance({ mode: "card-answer" }), "card-answer");
  // An old renderer sends nothing: the open mic's own state decides.
  assert.equal(gate.normalizeProvenance({ openMic: true }), "open-mic");
  assert.equal(gate.normalizeProvenance({ openMic: false }), "push-to-talk");
  assert.equal(gate.normalizeProvenance(), "push-to-talk");
});

/**
 * The three tool envelopes the desk ran as owner commands (desk command history,
 * source=voice), copied verbatim: a disabled-tool notice (2026-11-17), an empty
 * transcript (11-19) and Whisper's "Thank you." over silence (11-27). All three passed
 * checks 1-4: their words neither dangle nor start lowercase.
 */
const ENVELOPE_DISABLED_TOOL =
  "{\"note\":\"Tool 'transcribe_audio' (module: mcp_voice) requires Genesis and is disabled in " +
  "standalone mode. Reason: Genesis connection failed (TimeoutError): The read operation timed out " +
  "If Genesis is running, check the health endpoint or increase AITHER_GENESIS_TIMEOUT (current: " +
  "5.0s). Or set AITHER_API_KEY t\"}";
const ENVELOPE_EMPTY = "{\"note\":\"Transcription: \"}";
const ENVELOPE_THANK_YOU = "{\"note\":\"Transcription: Thank you.\"}";
const REAL_ENVELOPES = [ENVELOPE_DISABLED_TOOL, ENVELOPE_EMPTY, ENVELOPE_THANK_YOU];

test("a tool's JSON envelope is never a command, from any voice entry point", () => {
  for (const text of REAL_ENVELOPES) {
    for (const provenance of gate.PROVENANCES) {
      const verdict = gate.assessVoice({ text, provenance });
      assert.equal(verdict.pass, false, `${provenance}: ${text.slice(0, 60)}`);
      assert.equal(verdict.text, "");
    }
    const pressed = gate.assessVoice({ text, provenance: "push-to-talk" });
    assert.deepEqual(pressed.reasons, ["a tool's JSON envelope, not speech"]);
  }
});

test("Whisper's filler for silence is dropped even from a push-to-talk press", () => {
  const fillers = ["Thank you.", "Thanks for watching!", "Thank you very much.", "you", "Bye.",
    "Aither, thank you."];
  for (const text of fillers) {
    const verdict = gate.assessVoice({ text, provenance: "push-to-talk" });
    assert.equal(verdict.pass, false, text);
    assert.match(verdict.reasons.join("; "), /Whisper's filler/, text);
  }
});

test("a real request that opens with a pleasantry still passes", () => {
  const text = "Thank you. Now open the whiteboard.";
  const verdict = gate.assessVoice({ text, provenance: "push-to-talk" });
  assert.equal(verdict.pass, true, verdict.reasons.join("; "));
  assert.equal(verdict.text, text);
});
