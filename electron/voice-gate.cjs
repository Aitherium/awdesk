"use strict";

/**
 * voice-gate -- ONE gate in front of every voice entry point.
 *
 * The desk kept dispatching sentence fragments of media or room audio as the
 * owner's commands (measured 2026-11-23): "core worlds. Some people wouldn't"
 * started a full Claude session, and a fragment captured while a decision card
 * was waiting was written to that card's session as a STEER. The earlier
 * wake-word gate only covered the open microphone, and only when a wake word
 * had been configured -- with no wake word it passed every sentence, and
 * push-to-talk bypassed it entirely.
 *
 * A transcript may become a command, a card answer or a steer ONLY when ALL of
 * these hold:
 *
 *   1. it was triggered explicitly -- a push-to-talk press, a one-shot talk
 *      gesture, or a wake word/direct address for the always-open microphone;
 *   2. it is attributed to the owner -- a speaker id that matches the owner's
 *      enrolled id, or (with no speaker id) a clear direct address. A physical
 *      push-to-talk press is the owner's own attribution;
 *   3. it is a complete utterance, not a fragment cut mid-sentence;
 *   4. the PC was not playing audio while it was captured (a loopback/echo
 *      check, when a playback signal is available).
 *   5. it is speech: not a tool's JSON envelope that reached the transcript
 *      slot, and not Whisper's filler for silence ("Thank you.", "you").
 *
 * A card answer is NEVER an owner gesture even when the recorder was armed by
 * the desk: the desk opened the microphone, so the words must still address the
 * desk. That is the path that wrote a media fragment into card d-a4n3.
 *
 * Pure: no Electron, no filesystem (the rejection log takes its own seam), so
 * this is testable with the three real fragments.
 */

const PROVENANCES = Object.freeze(["push-to-talk", "one-shot", "open-mic", "card-answer", "unknown"]);

/** A terminal punctuation mark, optionally followed by a closing quote/bracket. */
const TERMINAL = /[.!?…]["'”’)\]]?$/;
const START_LOWER = /^[a-z]/;
/** A sentence boundary followed by more words: a transcript cut mid-thought. */
const INTERNAL_BREAK = /[.!?…]\s+\S/;
/** A fragment usually begins on the connective that joined it to the sentence before. */
const LEADING_CONNECTIVE = /^(?:and|but|or|so|because|which|that|then|anyway)\b[\s,]+/i;
/** A sentence cannot end on one of these and be complete. */
const DANGLING = new Set([
  "and", "but", "or", "because", "which", "that", "if", "when", "while", "nor", "yet", "so",
  "the", "a", "an", "of", "to", "for", "with", "from", "at", "on", "in", "by", "as", "than",
  "into", "onto", "over", "under", "about",
  "is", "are", "was", "were", "be", "been", "being", "am",
  "do", "does", "did", "have", "has", "had",
  "will", "would", "can", "could", "should", "shall", "may", "might", "must",
  "wouldnt", "dont", "doesnt", "didnt", "isnt", "arent", "wasnt", "werent",
  "wont", "cant", "couldnt", "shouldnt", "hasnt", "havent", "hadnt",
  "im", "ive", "ill", "id", "youre", "youve", "theyre", "weve",
  "hes", "shes", "thats", "whats", "lets",
]);

/** How the desk can be addressed by name. */
const ADDRESS = /^(?:(?:hey|hi|ok|okay|yo|hello|hay)\s+)?(?:aither|desk|computer)\b[\s,.!?:-]*/i;

function normalize(text) {
  return String(text == null ? "" : text).replace(/\s+/g, " ").trim();
}

function words(text) {
  return normalize(text)
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter(Boolean);
}

/**
 * Remove a wake word or a direct address and say whether one was present.
 * `wakeWord` is the configured word (Settings -> Talk); the built-in names work
 * even when no wake word is configured, so "Aither, ..." always counts.
 */
function stripAddress(text, wakeWord = "") {
  const said = normalize(text);
  const word = normalize(wakeWord).toLowerCase().replace(/[^a-z0-9 ]/g, "").trim();
  if (word) {
    const re = new RegExp(`^(?:(?:hey|hi|ok|okay|yo|hello|hay)\\s+)?${word}[\\s,.!?:-]+`, "i");
    const match = said.match(re);
    if (match) return { addressed: true, text: said.slice(match[0].length).trim() };
  }
  const match = said.match(ADDRESS);
  if (match) return { addressed: true, text: said.slice(match[0].length).trim() };
  return { addressed: false, text: said };
}

/** "" when the transcript is a complete thought, else why it reads as a fragment. */
function fragmentReason(text) {
  const said = normalize(text);
  if (!said) return "empty transcript";
  const list = words(said);
  if (!list.length) return "no words";
  // "So you might own a little bit of this..." -- media caught mid-argument.
  if (LEADING_CONNECTIVE.test(said)) return "starts mid-sentence on a connective";
  const last = list[list.length - 1];
  if (DANGLING.has(last)) return `ends mid-sentence on "${last}"`;
  // "core worlds. Some people wouldn't" -- lowercase start, a sentence break
  // inside, and nothing terminating the last clause.
  if (START_LOWER.test(said) && INTERNAL_BREAK.test(said) && !TERMINAL.test(said)) {
    return "starts mid-sentence and is cut at a sentence boundary";
  }
  return "";
}

/**
 * What Whisper writes over silence, noise or music, never a request: the same phrases
 * and normalisation as the awvoice brick's WHISPER_PHANTOMS. awvoice also bounds them by
 * clip length, because a voice CONVERSATION answers a real "thank you"; the desk has no
 * clip length here, and a lone pleasantry never needs an agent session, so the desk
 * drops one at any length.
 */
const WHISPER_PHANTOMS = new Set([
  "thank you", "thank you very much", "thanks for watching", "thank you for watching",
  "please subscribe", "subscribe", "you", "bye", "bye bye", "so", "uh", "um", "hmm",
  "subtitles by the amaraorg community",
]);

/** A raw tool answer in the transcript slot: nobody says a JSON object out loud. */
const ENVELOPE = /^\{\s*"/;

/**
 * "" when the transcript is speech, else why it is not: a tool's JSON envelope (the
 * gateway lane's '{"note":"Transcription: Thank you."}' started a full session on
 * 2026-11-27) or nothing but Whisper's filler for silence.
 */
function notSpeechReason(text) {
  const said = normalize(text);
  if (ENVELOPE.test(said)) return "a tool's JSON envelope, not speech";
  const plain = said.toLowerCase().replace(/[^\p{L} ']/gu, "").split(" ").filter(Boolean).join(" ");
  if (WHISPER_PHANTOMS.has(plain)) return `only Whisper's filler for silence ("${plain}"), not a request`;
  return "";
}

/**
 * How a transcript reached us. A waiting card ask makes EVERY transcript its
 * answer -- the desk armed the microphone, so the next sentence in the room is
 * not an owner command. Otherwise the trigger the renderer reported decides,
 * with the open mic's state as the fallback for an old renderer.
 *
 * @param {object} input
 * @param {string} [input.mode]   push-to-talk | one-shot | open-mic | card-answer
 * @param {boolean} [input.openMic]
 * @param {boolean} [input.cardWaiting]
 */
function normalizeProvenance({ mode = "", openMic = false, cardWaiting = false } = {}) {
  if (cardWaiting) return "card-answer";
  const value = String(mode || "");
  if (value === "open-mic" || value === "open") return "open-mic";
  if (value === "one-shot") return "one-shot";
  if (value === "push-to-talk") return "push-to-talk";
  if (value === "card-answer") return "card-answer";
  return openMic ? "open-mic" : "push-to-talk";
}


/**
 * The one decision every voice entry point asks.
 *
 * @param {object} input
 * @param {string} input.text          the transcript, exactly as recognised
 * @param {string} input.provenance    push-to-talk | one-shot | open-mic | card-answer | unknown
 * @param {string} [input.wakeWord]    the configured wake word, "" when none
 * @param {string|null} [input.speakerId]      the recognised speaker, if the STT reports one
 * @param {string|null} [input.ownerSpeakerId] the owner's enrolled id, if one exists
 * @param {boolean} [input.pcPlaying]  true when PC audio was audibly playing during capture
 * @returns {{pass:boolean,text:string,provenance:string,addressed:boolean,reasons:string[]}}
 */
function assessVoice({
  text,
  provenance = "unknown",
  wakeWord = "",
  speakerId = null,
  ownerSpeakerId = null,
  pcPlaying = false,
} = {}) {
  const raw = normalize(text);
  const prov = PROVENANCES.includes(provenance) ? provenance : "unknown";
  if (!raw) return { pass: false, text: "", provenance: prov, addressed: false, reasons: ["empty transcript"] };

  const reasons = [];
  const { addressed, text: without } = stripAddress(raw, wakeWord);
  // A verified owner voice satisfies attribution in place of a direct address.
  const ownerVoice = Boolean(
    speakerId && ownerSpeakerId && String(speakerId) === String(ownerSpeakerId),
  );

  // 1. Explicit trigger / direct address. The always-open microphone has no
  //    owner gesture behind a sentence, so its words must name the desk (or a
  //    speaker id must prove the owner is talking).
  if (prov === "open-mic" && !addressed && !ownerVoice) {
    reasons.push("open microphone needs a wake word or a direct address");
  }
  if (prov === "card-answer" && !addressed && !ownerVoice) {
    reasons.push("a spoken card answer needs a direct address");
  }
  if (prov === "unknown" && !addressed) {
    reasons.push("no push-to-talk press and no direct address");
  }

  // 2. Attribution. A push-to-talk press is the owner's own gesture; without a
  //    speaker id every other capture must address the desk (checked above).
  if (speakerId && ownerSpeakerId) {
    if (!ownerVoice) reasons.push("the speaker is not the owner");
  } else if (speakerId && !addressed) {
    reasons.push("the speaker cannot be confirmed as the owner and the words do not address the desk");
  }

  // 3. Completeness: a fragment cut mid-sentence is never a command or a steer.
  const fragment = fragmentReason(raw);
  if (fragment) reasons.push(`fragment: ${fragment}`);

  // 4. Echo: words captured while the PC was audible are likely the PC's own.
  if (pcPlaying) reasons.push("the PC was playing audio while this was captured");

  // 5. Speech at all: a tool's envelope or Whisper's filler for silence is never a
  //    command, a card answer or a steer, whatever armed the microphone.
  const notSpeech = notSpeechReason(addressed ? without : raw);
  if (notSpeech) reasons.push(notSpeech);

  return {
    pass: reasons.length === 0,
    // A rejected transcript is never handed on to a command, a card or a steer.
    text: reasons.length === 0 ? (addressed ? without : raw) : "",
    provenance: prov,
    addressed,
    reasons,
  };
}

/**
 * The reviewable log every rejection lands in. One JSON object per line, the
 * last N readable for a review surface. No audio, no session: the transcript
 * and the reasons only.
 */
function createRejectionLog({
  file = null,
  now = () => new Date(),
  fsImpl = null,
  pathImpl = null,
} = {}) {
  const fs = fsImpl || require("node:fs");
  const path = pathImpl || require("node:path");
  const target = file || path.join(require("node:os").homedir(), ".aither", "desk-voice-rejected.jsonl");

  function record({ text, provenance = "unknown", reasons = [] } = {}) {
    let at;
    try {
      const value = typeof now === "function" ? now() : now;
      at = value instanceof Date ? value.toISOString() : new Date(value).toISOString();
    } catch {
      at = new Date().toISOString();
    }
    const entry = {
      at,
      text: String(text == null ? "" : text).slice(0, 4000),
      provenance: String(provenance || "unknown"),
      reasons: Array.isArray(reasons) ? reasons.map(String) : [String(reasons)],
    };
    try {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.appendFileSync(target, `${JSON.stringify(entry)}\n`, "utf8");
    } catch {
      /* a full disk must never break the voice path; the caller still gets the entry */
    }
    return entry;
  }

  function recent(limit = 50) {
    const n = Math.max(1, Math.min(500, Number(limit) || 50));
    let text;
    try {
      text = fs.readFileSync(target, "utf8");
    } catch {
      return [];
    }
    const lines = text.split(/\r?\n/).filter(Boolean);
    const out = [];
    for (const line of lines.slice(-n)) {
      try {
        const value = JSON.parse(line);
        if (value && typeof value === "object") out.push(value);
      } catch {
        /* one torn line does not hide the rest */
      }
    }
    return out;
  }

  return { record, recent, file: target };
}

module.exports = {
  PROVENANCES,
  WHISPER_PHANTOMS,
  assessVoice,
  fragmentReason,
  notSpeechReason,
  normalizeProvenance,
  stripAddress,
  createRejectionLog,
};
