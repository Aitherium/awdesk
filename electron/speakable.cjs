/**
 * speakable -- what a line SOUNDS like, for the desk's one speech funnel (main.cjs speakAloud).
 *
 * A reply written for the screen ("*waves* Hello!", "**Done.**", emoji) must be said as
 * "Hello!", never "asterisk waves asterisk". The same rule, with the same vectors, lives in
 * awkit/src/panels/speakable.ts (web), lib/media/speakable.py (the voice plane) and
 * Speakable.java (the Android app); this is the CommonJS port for Electron's main process.
 *
 *  - `*action*` / `_action_` spans go, except one word emphasised mid-sentence ("that is
 *    *so* cool" keeps "so"). `**bold**` keeps its words.
 *  - `(action)` / `[action]` spans of words only go; "(5 + 5)" and "[1]" stay.
 *  - Emoji (pictographs, flags, skin tones, joiners, variation selectors) go.
 *  - Markdown marks go.
 *
 * Pure: node electron/speakable.test.cjs.
 */
"use strict";

const WORDS = "[A-Za-z][A-Za-z' ,\\-]{0,60}";
const STAR = /(?<!\*)\*(?![*\s])([^*\n]{1,60}?)(?<!\s)\*(?!\*)/g;
const UNDER = /(?<![\w_])_(?![_\s])([^_\n]{1,60}?)(?<!\s)_(?![\w_])/g;
const PAREN = new RegExp(`\\((${WORDS})\\)`, "g");
const SQUARE = new RegExp(`\\[(${WORDS})\\](?!\\()`, "g");
const EMOJI = /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{FE00}-\u{FE0F}\u{E0020}-\u{E007F}‍⃣⌀-⏿←-⇿〰〽㊗㊙]+/gu;
const LINE_MARK = /^[ \t]*(#{1,6}|>|[-*+•]|\d+[.)])[ \t]+/gm;
const MARKS = /(?<!\w)[*_]+|[*_]+(?!\w)|`+|~~|#+(?=\s)/g;
const ORPHAN = /^[\s,.;:!?\-–—]+/;
const SPACE_PUNCT = /\s+([,.;:!?])/g;

function isAlpha(c) {
  return !!c && /\p{L}/u.test(c);
}

/** True when a *span* is one word inside a sentence: words on both sides. */
function emphasis(inner, src, start, end) {
  const word = inner.trim();
  if (!word || word.includes(" ")) return false;
  const before = src.slice(0, start).trimEnd();
  const after = src.slice(end).trimStart();
  const a = after[0];
  return isAlpha(before[before.length - 1]) && isAlpha(a) && a === a.toLowerCase();
}

/** `text` with stage directions, emoji and markdown removed, as a voice should say it. */
function speakable(text) {
  if (!text) return "";
  const src = String(text);
  let s = src.replace(STAR, (m, inner, offset) =>
    (emphasis(inner, src, offset, offset + m.length) ? ` ${inner.trim()} ` : " "));
  const s2 = s;
  s = s.replace(UNDER, (m, inner, offset) =>
    (emphasis(inner, s2, offset, offset + m.length) ? ` ${inner.trim()} ` : " "));
  s = s.replace(PAREN, " ").replace(SQUARE, " ").replace(EMOJI, " ");
  s = s.replace(LINE_MARK, "").replace(MARKS, "");
  s = s.split(/\s+/).filter(Boolean).join(" ");
  s = s.replace(SPACE_PUNCT, "$1").replace(ORPHAN, "");
  return s.trim();
}

module.exports = { speakable };
