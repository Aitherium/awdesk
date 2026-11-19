"use strict";

/**
 * notify-policy -- the desk's half of the ONE decision-card notification policy.
 *
 * WHY. Owner, 2026-11-18, furious: the same card reached him through the desk toast,
 * an Edge toast from awconnect, the awask card window, a phone web push and a Discord
 * DM, each with its own look, and one read "Free RAM: To make WildAntheia's starting
 * still on ... Needs: To make WildAntheia's starting still on ..." -- title cut
 * mid-word, body repeating it. The rule and the shape now live in ONE config file,
 * ~/.aither/notify-policy.json, read by every sender (the Python source of truth is
 * adk.decisions.notify_policy). While the desk is alive its toast is the ONLY surface,
 * so this module is what makes that one surface right:
 *
 *   - shape(card): a title of at most `message.title_max` (60) characters written as a
 *     plain sentence and never cut mid-word; a body that leads with what approving
 *     does; no body line that repeats the title. Same algorithm and same output as
 *     the Python shape (the shared vectors in notify-policy.test.cjs pin it).
 *   - the ledger (~/.aither/notify-ledger.json, shared with the Python senders): one
 *     desk toast per card id. claim() answers "new" (show), "update" (the words
 *     changed: REPLACE the toast already shown) or "dup" (show nothing).
 *
 * PURE apart from the injected fs in readPolicy/createLedger; asserted under node --test.
 */

const path = require("node:path");
const os = require("node:os");

const DEFAULT_MESSAGE = Object.freeze({ title_max: 60, body_max: 200, approve_prefix: "If you approve: " });
const CHANNEL = "desk_toast";
const LEDGER_TTL_MS = 14 * 86400 * 1000;
const ELLIPSIS = "…";

function aitherHome(env = process.env) {
  return env.AITHER_HOME || path.join(os.homedir(), ".aither");
}
function policyPath(env = process.env) {
  return env.AITHER_NOTIFY_POLICY || path.join(aitherHome(env), "notify-policy.json");
}
function ledgerPath(env = process.env) {
  return env.AITHER_NOTIFY_LEDGER || path.join(aitherHome(env), "notify-ledger.json");
}

/** The message section of the policy file over the defaults. Never throws. */
function readPolicy({ fs = require("node:fs"), file = policyPath() } = {}) {
  try {
    const data = JSON.parse(fs.readFileSync(file, "utf8"));
    const msg = data && typeof data.message === "object" ? data.message : {};
    return { message: { ...DEFAULT_MESSAGE, ...msg } };
  } catch {
    return { message: { ...DEFAULT_MESSAGE } };
  }
}

// ── the shape ──────────────────────────────────────────────────────────────────

const ASK = /\b(ok to|okay to|should|approve|allow|can i|may i|do you|want me|shall i|is it ok|confirm|pick|choose|which)\b|\?/i;
const STOP_TAIL = new Set(["a", "an", "the", "to", "of", "for", "on", "in", "with", "and", "or", "but", "by", "at", "from", "as", "is", "are", "be", "so", "that"]);
const NEEDS = /^\s*(needs|you asked|claude last said)\s*:\s*/i;
const DECLINE = /\b(no|decline|deny|reject|later|skip|cancel|hold|wait)\b/i;
const HEADER = /^([^:?!.]{1,32}):\s+(.+)$/;
const ELLIPSIS_TAIL = /\s*\S*(?:…|\.\.\.)\s*$/;

const squash = (s) => String(s == null ? "" : s).split(/\s+/).filter(Boolean).join(" ");
const norm = (s) => squash(String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, " "));

function wordCut(text, limit, mark = ELLIPSIS) {
  text = String(text).trim();
  if (text.length <= limit) return text;
  let out = "";
  for (const word of text.split(" ")) {
    const trial = `${out} ${word}`.trim();
    if (trial.length + mark.length > limit) break;
    out = trial;
  }
  const parts = out.replace(/[\s,;:\-–—(]+$/, "").split(" ");
  while (parts.length > 1 && STOP_TAIL.has(parts[parts.length - 1].toLowerCase())) parts.pop();
  out = parts.join(" ").replace(/[\s,;:\-–—(]+$/, "");
  return out ? out + mark : "A decision needs you.";
}

function finish(text, question, limit) {
  text = String(text).trim().replace(/[,;:\-–—\s]+$/, "");
  if (!text) return "";
  text = text[0].toUpperCase() + text.slice(1);
  if (!".?!…".includes(text[text.length - 1])) text += question ? "?" : ".";
  return text.length > limit ? wordCut(text.replace(/[.?!]+$/, ""), limit) : text;
}

function plain(text) {
  let s = text.replace(/\s*\([^()]*\)/g, "");
  s = s.replace(/\s*\([^()]*$/, "");
  s = s.replace(/\s*\[[^[\]]*\]/g, "");
  s = s.replace(/[()[\]]/g, "");
  s = s.replace(/[\s+&/|❯>-]+$/, "");
  s = s.replace(/^[\s❯>]+/, "");
  return squash(s);
}

const firstSentence = (t) => String(t).trim().split(/(?<=[.?!])\s+/)[0].trim();

/** The title: <= limit chars, a plain sentence, never cut mid-word. */
function headline(card, limit = DEFAULT_MESSAGE.title_max) {
  let raw = squash(card && card.title);
  if (!raw) return "A decision needs you.";
  if (ELLIPSIS_TAIL.test(raw)) raw = raw.replace(ELLIPSIS_TAIL, "");
  raw = plain(raw);
  let first = firstSentence(raw);
  let question = first.includes("?") || ASK.test(first);
  if (first.length + 1 <= limit) return finish(first, question, limit);
  const m = HEADER.exec(raw);
  if (m && m[1].trim().length >= 3 && m[1].split(/\s+/).length <= 3 && m[2].split(/\s+/).length >= 3) {
    first = firstSentence(m[2]);
    question = first.includes("?") || ASK.test(first);
    if (first.length + 1 <= limit) return finish(first, question, limit);
  }
  const clauses = first.split(/,\s+|\s+--\s+|;\s+|\s+[-–—]\s+/)
    .map((c) => c.replace(/^[\s+&/]+|[\s+&/]+$/g, ""))
    .filter((c) => c.split(/\s+/).length >= 3);
  const asks = clauses.filter((c) => ASK.test(c));
  for (const pick of [...asks].reverse()) if (pick.length + 1 <= limit) return finish(pick, true, limit);
  for (const pick of clauses) if (pick.length + 1 <= limit) return finish(pick, question, limit);
  let cut = wordCut(first.replace(/[.?!]+$/, ""), limit - 1);
  cut = cut[0].toUpperCase() + cut.slice(1);
  return cut.endsWith(ELLIPSIS) ? cut : finish(cut, question, limit);
}

function approveOption(card) {
  const opts = Array.isArray(card && card.options) ? card.options : [];
  if (!opts.length) return null;
  return opts.find((o) => o && o.recommended)
    || opts.find((o) => o && !DECLINE.test(o.label || "") && !String(o.key || "").endsWith(":type"))
    || opts[0];
}

function approveLine(card, limit = DEFAULT_MESSAGE.body_max, prefix = DEFAULT_MESSAGE.approve_prefix) {
  const o = approveOption(card);
  if (!o) return "Nothing happens until you answer.";
  const label = String(o.label || "").replace(/\s*\(recommended\)\s*/i, " ").trim();
  const consequence = squash(o.consequence);
  let what = consequence && norm(consequence) !== norm(label) ? consequence : label;
  what = what.replace(/\.+$/, "") + ".";
  return wordCut(prefix + what[0].toUpperCase() + what.slice(1), limit);
}

function overlaps(a, b) {
  const na = norm(a);
  const nb = norm(b);
  if (!na || !nb) return false;
  if (na.includes(nb) || nb.includes(na)) return true;
  const ta = new Set(na.split(" "));
  const tb = new Set(nb.split(" "));
  let common = 0;
  for (const t of ta) if (tb.has(t)) common += 1;
  return common / Math.max(1, Math.min(ta.size, tb.size)) >= 0.6;
}

function contextLine(card, title) {
  const text = String((card && (card.summary || card.detail)) || "");
  const prose = squash(text.split(/\r?\n/).filter((l) => !NEEDS.test(l)).join(" "));
  for (const s of prose.split(/(?<=[.?!])\s+/)) {
    const sentence = s.trim();
    if (!sentence) continue;
    if (overlaps(sentence, title) || overlaps(sentence, squash(card.title))) continue;
    return sentence;
  }
  return "";
}

/** {title, body} -- the ONE message shape. `policy` = readPolicy() output. */
function shape(card, policy = { message: DEFAULT_MESSAGE }) {
  const msg = { ...DEFAULT_MESSAGE, ...((policy && policy.message) || {}) };
  const title = headline(card || {}, Number(msg.title_max) || 60);
  let body = approveLine(card || {}, Number(msg.body_max) || 200, msg.approve_prefix || DEFAULT_MESSAGE.approve_prefix);
  const ctx = contextLine(card || {}, title);
  if (ctx && body.length + 1 + ctx.length <= (Number(msg.body_max) || 200)) body = `${body}\n${ctx}`;
  return { title, body };
}

// ── the ledger: one desk toast per card id ────────────────────────────────────────

/**
 * @param {{fs?: object, file?: string, now?: () => number}} [opts]
 * claim(cardId, fingerprint) -> "new" | "update" | "dup" and records it.
 */
function createLedger({ fs = require("node:fs"), file = ledgerPath(), now = Date.now } = {}) {
  function read() {
    try {
      const data = JSON.parse(fs.readFileSync(file, "utf8"));
      return data && typeof data === "object" ? data : {};
    } catch {
      return {};
    }
  }
  function write(data) {
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const tmp = `${file}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(data, null, 1));
      fs.renameSync(tmp, file);
    } catch { /* bookkeeping: a failed write must not stop the toast */ }
  }
  function claim(cardId, fingerprint) {
    if (!cardId) return "new";
    const data = read();
    const sent = (data.sent && typeof data.sent === "object") ? data.sent : {};
    const bucket = (sent[CHANNEL] && typeof sent[CHANNEL] === "object") ? sent[CHANNEL] : {};
    const prev = bucket[cardId];
    const at = now();
    const fp = String(fingerprint || "");
    let verdict = "new";
    if (prev) verdict = String(prev.fp || "") === fp ? "dup" : "update";
    if (verdict === "dup") return verdict;
    const cutoff = at / 1000 - LEDGER_TTL_MS / 1000;
    for (const key of Object.keys(bucket)) {
      if (Number((bucket[key] || {}).at || 0) < cutoff) delete bucket[key];
    }
    bucket[cardId] = { at: at / 1000, fp };
    sent[CHANNEL] = bucket;
    data.sent = sent;
    write(data);
    return verdict;
  }
  /** The desk is alive right now: the Python senders measure "away" from this. */
  function noteAlive() {
    const data = read();
    data.desk_last_alive = now() / 1000;
    write(data);
  }
  return { claim, noteAlive, read };
}

/** The fingerprint the Python ledger stores: the shaped words. */
function fingerprint(shaped) {
  return `${shaped.title}\n${shaped.body}`;
}

module.exports = {
  CHANNEL, DEFAULT_MESSAGE,
  readPolicy, policyPath, ledgerPath,
  headline, approveLine, shape, fingerprint, createLedger,
};
