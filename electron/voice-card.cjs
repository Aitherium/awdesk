"use strict";

/**
 * voice-card -- answer a decision card OUT LOUD (owner, 2026-09-22: "IT JUST
 * SPEAKS UPDATES ... NOT GETTING A CHANCE TO RESPOND OR ANSWER ANY KIND OF CARD").
 *
 * The desk already SAID a card arrived ("A decision needs you: <title>") and
 * then gave the owner nothing to say back to: the options were never read, and
 * the next sentence went to Command as a brand-new task. This turns the card
 * into a spoken question (cardPrompt) and the owner's reply into an answer
 * (matchReply): a number or an option's words picks that option, "yes" picks
 * the recommended one, and anything else is a STEER -- sent to the raising
 * session as a work order, the same as typing it into the card.
 *
 * Pure: no Electron, no awask. main.cjs wires it to voice-ask and
 * decision-cards.
 */

const NUMBER_WORDS = [
  ["one", "first", "1"],
  ["two", "second", "2"],
  ["three", "third", "3"],
  ["four", "fourth", "4"],
  ["five", "fifth", "5"],
  ["six", "sixth", "6"],
];
const SPOKEN = ["one", "two", "three", "four", "five", "six"];
const AFFIRM = /^(yes|yeah|yep|sure|ok(ay)?|do it|go( ahead)?|approve[d]?|sounds good|the recommended( one)?)\b/;
const MAX_OPTIONS = SPOKEN.length;

function norm(text) {
  return String(text || "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** The sentence the avatar asks. Options are numbered so "two" is an answer. */
function cardPrompt(card) {
  const title = String((card && card.title) || "a decision").slice(0, 160);
  const options = (card && Array.isArray(card.options) ? card.options : []).slice(0, MAX_OPTIONS);
  if (!options.length) return `A decision needs you: ${title}. Tell me what to do.`;
  const listed = options
    .map((o, i) => `${SPOKEN[i]}, ${String(o.label || o.key).slice(0, 80)}${o.recommended ? ", recommended" : ""}`)
    .join("; ");
  return `A decision needs you: ${title}. Options: ${listed}. Say a number, or tell me what to do instead.`;
}

/**
 * What the owner's reply means for this card:
 *   { kind: "answer", key, label } | { kind: "steer", text } | { kind: "none" }
 */
function matchReply(card, transcript) {
  const said = norm(transcript);
  if (!said) return { kind: "none" };
  const options = (card && Array.isArray(card.options) ? card.options : []).slice(0, MAX_OPTIONS);
  const pick = (o) => ({ kind: "answer", key: o.key, label: String(o.label || o.key) });
  if (options.length) {
    const words = said.split(" ");
    // "two" / "option two" / "the second one" -- a short reply naming a number.
    if (words.length <= 4) {
      const hits = [];
      for (let i = 0; i < options.length; i += 1) {
        if (NUMBER_WORDS[i].some((w) => words.includes(w))) hits.push(i);
      }
      // "the second one": the ordinal is the answer, "one" is a pronoun.
      const named = hits.length > 1 ? hits.filter((i) => i !== 0 || !words.includes("one") || words.includes("first") || words.includes("1")) : hits;
      if (named.length === 1) return pick(options[named[0]]);
    }
    // The option's own words: the longest label fully contained in the reply wins,
    // so "restart the service" beats "restart" when both are options. Only in a
    // SHORT reply -- a sentence that merely mentions an option's word is a steer.
    let best = null;
    for (const o of options) {
      for (const candidate of [norm(o.label), norm(o.key)]) {
        const fits = candidate && words.length <= candidate.split(" ").length + 3;
        if (fits && (` ${said} `).includes(` ${candidate} `)) {
          if (!best || candidate.length > best.len) best = { o, len: candidate.length };
        }
      }
    }
    if (best) return pick(best.o);
    // A bare yes means the raiser's recommendation -- or the only option.
    if (AFFIRM.test(said) && words.length <= 5) {
      const rec = options.find((o) => o.recommended)
        || options.find((o) => o.key === card.defaultKey)
        || (options.length === 1 ? options[0] : null);
      if (rec) return pick(rec);
    }
  }
  return { kind: "steer", text: String(transcript).trim() };
}

// ── who is allowed to speak for the owner ─────────────────────────────
// A card ask (voice-ask.cjs) says the question ALOUD and then opens the
// microphone. Whatever that mic hears next -- a video playing in the room,
// another person, the avatar's own audio bleeding back -- used to be treated as
// the owner's reply, and anything that was not a matching option was STEERED to
// the raising session as the OWNER's words (a note marked "queued"). That is a
// prompt-injection path: ambient speech can steer an agent. This gate fails
// CLOSED, so an utterance only reaches a card when it is POSITIVELY the owner.

/** The owner pressed the talk key and spoke: an explicit, deliberate capture. */
const CAPTURE_PUSH_TO_TALK = "push-to-talk";
/** The always-on / auto-armed recorder: heard, but nobody chose to be heard. */
const CAPTURE_OPEN_MIC = "open-mic";

/**
 * Was this capture POSITIVELY the owner speaking? Returns {verified, reason}.
 *
 * Positive signals, in order:
 *   - ``speakerVerified``: a match against an enrolled owner voiceprint (the
 *     only true identity check; no verifier is wired yet, so callers pass
 *     false and everything fails closed until one is);
 *   - an explicit push-to-talk with no media playing.
 * Anything heard while media is playing, or from the ambient open mic, is
 * UNVERIFIED: it may never answer or steer a card.
 */
function classifyCapture({ capture = CAPTURE_OPEN_MIC, speakerVerified = false, mediaPlaying = false } = {}) {
  if (speakerVerified === true) return { verified: true, reason: "speaker-match" };
  if (mediaPlaying === true) return { verified: false, reason: "media-playing" };
  if (capture === CAPTURE_PUSH_TO_TALK) return { verified: true, reason: "explicit-push-to-talk" };
  return { verified: false, reason: "ambient" };
}

/**
 * Gate a spoken reply to a card.
 *
 *   verified   -> the same {kind:"answer"|"steer"|"none"} matchReply gives,
 *                 plus ``verified: true``; the caller may apply it.
 *   unverified -> {kind:"unverified", text, reason}; the caller MUST NOT apply
 *                 it. At most it is held as an "unverified heard" item the owner
 *                 confirms with an explicit click.
 */
function gateReply(card, transcript, options = {}) {
  const text = String(transcript || "").trim();
  if (!text) return { kind: "none", verified: false, reason: "empty" };
  const capture = classifyCapture(options);
  if (!capture.verified) {
    return { kind: "unverified", text, reason: capture.reason, verified: false };
  }
  return { ...matchReply(card, transcript), verified: true };
}

module.exports = {
  cardPrompt,
  matchReply,
  norm,
  CAPTURE_PUSH_TO_TALK,
  CAPTURE_OPEN_MIC,
  classifyCapture,
  gateReply,
};
