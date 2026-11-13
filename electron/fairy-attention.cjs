"use strict";

/**
 * fairy-attention — what the fairy nudges the owner about, how hard, and when.
 *
 * Owner, 2026-11-08: "cards keep popping up and I can't even move them -- these
 * need to live in the fairy ... it can come flutter in front of my eyes to get my
 * attention without blocking anything ... BE GOOD AT GETTING ATTENTION AND
 * TRIAGING ... INCREASING INTENSITY IF IT'S SOMETHING I KNOW I NEED ... I IGNORE
 * THE CARDS AND POPUPS BECAUSE I HAVE SO MUCH INFO IN FRONT OF ME ... a soft nudge
 * and interruption ... read things off and reminders like hey this thing is still
 * waiting for you and here is why you should look at it now."
 *
 * So the card stops being a window and becomes a nudge with a LADDER:
 *
 *   L0 badge    the count on the fairy. Reports ("Noted"), stale asks, muted cards.
 *   L1 glow     the fairy pulses where it rests and whispers one line beside itself.
 *   L2 flutter  the fairy flies to where the owner is looking (the cursor), flutters
 *               there with the whisper -- never under the cursor, click-through
 *               except the whisper's own buttons, never takes focus -- then goes home.
 *   L3 insist   the flutter, brighter and longer, re-asked every few minutes, and the
 *               line is READ ALOUD on a repeat (the arrival line is already spoken).
 *
 * The step up is earned: every ignored nudge lifts the card one level
 * (`escalateEvery`), capped by how much it matters (importance). "Keep nudging me"
 * pins a card at the top; "Stop nudging" drops it to the badge; "Later" puts it off
 * an hour and it comes back one level LOUDER (the owner said it matters, just not now).
 *
 * AN IGNORED CARD GETS LOUDER, NEVER SILENT (owner, 2026-11-12). He never noticed
 * d-qabc, a `blocked` card a running session was stopped on: it fluttered once at
 * 18:05 and was not nudged again before he was told in chat. Three causes, all here:
 * a never-nudged card outranked a repeat, so with 36 cards waiting each got one nudge
 * and a repeat was hours away; a step up needed TWO ignored nudges; and an ordinary
 * ask rested for four hours after three. Now a repeat that climbed outranks a first
 * nudge, one ignored nudge is one step, a card that stops running work whose own
 * fallback is to hold ranks first and insists, an ordinary ask climbs to the flutter
 * (the fairy flies to the pointer), and only "Later" or "Stop nudging" puts a card
 * off. Cards that change nothing (a no-op suggestion) or are a day old still glow at
 * most and rest: they were the noise of 2026-11-10.
 *
 * Pacing is the other half of not being noise: one card per nudge (the rest ride
 * as "+N more"), a global gap between nudges, a per-card interval by level, held
 * entirely while quiet (Do not disturb, NOW mode, a full-screen app, a game) or
 * while the owner is away from the keyboard -- and the moment they come back, the
 * top card gets one nudge ("while you were away").
 *
 * PURE: no electron, no fs. The caller owns the clock, the windows and where the
 * per-card memory is kept. node --test.
 */

const cardUiCore = require("./card-ui.cjs");

const MIN = 60_000;
const HOUR = 60 * MIN;

const LEVEL = Object.freeze({ BADGE: 0, GLOW: 1, FLUTTER: 2, INSIST: 3 });

const DEFAULTS = Object.freeze({
  /** Never two nudges closer than this, by the level of the one that is due:
   *  a glow is the softest ask and the rarest, an insist may come back sooner. */
  gapMs: Object.freeze({ 1: 15 * MIN, 2: 5 * MIN, 3: 90_000 }),
  /** A NEW card that matters (importance >= 2) may cut the gap down to this. */
  arrivalGapMs: 20_000,
  /** "New" means raised this recently -- not merely never nudged. Measured 2026-11-08:
   *  on a desk restart every un-nudged card read as an arrival and the fairy
   *  fluttered through the whole backlog 20 s apart. */
  arrivalWindowMs: 10 * MIN,
  /** Re-nudge the same card no sooner than this, by level. */
  intervalMs: Object.freeze({ 1: 20 * MIN, 2: 10 * MIN, 3: 5 * MIN }),
  /** How long a nudge stays up (a hovered whisper stays while hovered). */
  showMs: Object.freeze({ 1: 9000, 2: 14000, 3: 20000 }),
  /** The owner idle this long: nobody is looking, hold everything. */
  idleHoldMs: 2 * MIN,
  /** Idle this long and then back: the top card gets a "while you were away". */
  awayMs: 5 * MIN,
  /** Older than this: the badge only -- never a whisper, even after "keep nudging"
   *  (owner 2026-11-09: a 22-day-old Pixel approval still popped). An explicitly
   *  clicked old card still opens, with an "old -- still relevant?" line. */
  staleMs: 48 * HOUR,
  /** An ask older than this (not a credential, not critical) is a glow at most:
   *  a blocked session this old has very likely moved on. */
  freshMs: 24 * HOUR,
  /** A card that does NOT climb (a no-op suggestion, a day-old ask) rests this long
   *  after `restAfter` ignored glows. A card that climbs never rests on its own. */
  restAfter: 3,
  restMs: 4 * HOUR,
  /** "Later" puts a card off this long. */
  laterMs: HOUR,
  /** Ignored nudges per level step: one. The second nudge is already a step up. */
  escalateEvery: 1,
  /** A spoken repeat no more often than this, across all cards. */
  voiceGapMs: 5 * MIN,
});

function lower(value) {
  return String(value == null ? "" : value).trim().toLowerCase();
}

/** A one-choice card whose only answer is an acknowledgement is a REPORT. */
const ACK_LABEL_RE = /^(noted|ok|okay|got it|ack|acknowledged?|seen|thanks|dismiss|understood)\.?$/i;
function ackOnly(card) {
  const options = Array.isArray(card && card.options) ? card.options : [];
  if (options.length === 0) return false;
  return options.every((o) => ACK_LABEL_RE.test(String((o && (o.label || o.key)) || "").trim()));
}

function createdMs(card) {
  return (Number(card && card.createdAt) || 0) * 1000;
}

/**
 * The suggested answers that change nothing. MUST equal
 * decision-cards.cjs RANK_RULES.noop_labels: the queue ranks these cards below
 * ones needing the owner, and the fairy must not shout about them either.
 */
const NOOP_SUGGESTION_LABELS = Object.freeze(["skip", "keep refusing", "keep it scheduled"]);

/** The label of the option the card suggests (`defaultKey`), lowercased. */
function suggestedText(card) {
  const key = lower(card && card.defaultKey);
  if (!key) return "";
  const options = Array.isArray(card && card.options) ? card.options : [];
  const hit = options.find((o) => o && lower(o.key) === key);
  return hit ? lower(hit.label || hit.key) : "";
}

/**
 * The card's suggested answer is a NO-OP ("Skip", "Keep it scheduled"): picking
 * it changes nothing, and the store will pick it by itself at the deadline.
 * Owner, 2026-11-10: a 43 h "paid launch refused" card that repeats and an awrise
 * streak card ("picks 'Keep it scheduled' for you in 19 h") kept fluttering over
 * the one ask that mattered. Such a card glows at most. A deadline with a REAL
 * recommendation still escalates: deciding before it passes is the point.
 */
function noopSuggestion(card) {
  const label = suggestedText(card);
  return NOOP_SUGGESTION_LABELS.some((noop) => label === noop
    || (label.startsWith(noop) && !/[a-z0-9]/i.test(label.charAt(noop.length))));
}

/** Older than `staleMs`: the badge and the list only, never a whisper on its own. */
function isStale(card, nowMs = Date.now(), cfg = DEFAULTS) {
  const born = createdMs(card);
  return born > 0 && nowMs - born > cfg.staleMs;
}

/** Two strings that say the same thing: case, spacing and punctuation ignored. */
function sameText(a, b) {
  const norm = (v) => String(v == null ? "" : v).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
  const x = norm(a);
  return x.length > 0 && x === norm(b);
}

/** The whisper's link to the whole list: the true count, "99+" past that. */
function moreLabel(more) {
  const n = Math.max(0, Math.floor(Number(more) || 0));
  if (!n) return "";
  return `${n > 99 ? "99+" : n} more waiting`;
}

/** Milliseconds until the card's deadline, or null when it has none. */
function deadlineLeftMs(card, nowMs) {
  const dl = Number(card && card.deadline) || 0;
  return dl > 0 ? dl * 1000 - nowMs : null;
}

function optionLabel(card, key) {
  const options = Array.isArray(card && card.options) ? card.options : [];
  const hit = options.find((o) => o && (o.key === key || lower(o.key) === lower(key)));
  return hit ? String(hit.label || hit.key) : "";
}

/** "3 h", "25 min", "2 d" -- short, spoken-friendly. */
function fmtSpan(ms) {
  const m = Math.max(0, Math.round(Number(ms) / MIN));
  if (m < 1) return "under a minute";
  if (m < 60) return `${m} min`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h} h`;
  return `${Math.round(h / 24)} d`;
}

/** The suggested answers that leave the waiting session stopped. */
const HOLD_SUGGESTION_RE = /^(hold|deny|wait|stop|pause|refuse|keep refusing|not now|do nothing|leave)\b/;

/**
 * A session is STOPPED on this card and the card's own fallback keeps it stopped
 * (its suggestion is to hold / deny, or it suggests nothing). Not answering it is
 * the one choice that costs running work, so it ranks first and insists.
 */
function holdsWork(card) {
  if (!card || typeof card !== "object") return false;
  if (!(card.blocking === true || lower(card.kind) === "blocked")) return false;
  if (ackOnly(card)) return false;
  const label = suggestedText(card);
  const key = lower(card.defaultKey);
  return !label && !key ? true : HOLD_SUGGESTION_RE.test(label) || HOLD_SUGGESTION_RE.test(key);
}

/**
 * Does an ignored nudge about this card get louder? Yes for anything that needs the
 * owner now. No for a report, a no-op suggestion nobody is stopped on, and an ask
 * more than a day old (not a credential, not critical): those glow at most and rest.
 */
function climbs(card, nowMs = Date.now(), mem = {}, cfg = DEFAULTS) {
  if (!card || typeof card !== "object") return false;
  if (mem && mem.keep) return true;
  if (ackOnly(card) || isStale(card, nowMs, cfg)) return false;
  const kind = lower(card.kind);
  const blocked = card.blocking === true || kind === "blocked";
  if (!blocked && kind !== "credential" && noopSuggestion(card)) return false;
  if (nowMs - createdMs(card) > cfg.freshMs && kind !== "credential" && lower(card.urgency) !== "critical") return false;
  return true;
}

/**
 * How much a card matters, 0..3. 0 = the badge only.
 * `mem` is this card's nudge memory (see `recordShown` & co).
 */
function importance(card, nowMs, mem = {}, cfg = DEFAULTS) {
  if (!card || typeof card !== "object") return 0;
  if (mem && mem.muted) return 0;
  if (isStale(card, nowMs, cfg)) return 0;
  if (mem && mem.keep) return 3;
  const kind = lower(card.kind);
  const urgency = lower(card.urgency) || "normal";
  const age = nowMs - createdMs(card);
  const blocked = card.blocking === true || kind === "blocked";
  let score;
  if (ackOnly(card)) {
    // "Noted" is a report. Only a critical one (a disk under its floor) earns a flutter.
    score = urgency === "critical" ? 2 : 0;
  } else {
    score = { critical: 3, high: 2, normal: 1, low: 0 }[urgency];
    if (score === undefined) score = 1;
    if (kind === "credential") score = Math.max(score, 1);
    if (blocked) score = Math.max(score, 2);
    // Stopped work whose fallback is to stay stopped: nothing else outranks it.
    if (holdsWork(card)) score = 3;
    const left = deadlineLeftMs(card, nowMs);
    if (left != null && left > 0) {
      // Not answering is also a choice once the deadline passes: say so while it can still be made.
      if (left <= 30 * MIN) score = 3;
      else if (left <= 2 * HOUR) score = Math.min(3, score + 1);
    }
  }
  // A no-op suggestion ("Skip", "Keep it scheduled") is not a person waiting: the
  // card glows at most and its deadline never escalates it. ("Keep nudging me"
  // returned above: the owner's own ask outranks this.) Needs-you kinds are never
  // demoted. A deadline with a REAL recommendation still escalates.
  if (!blocked && kind !== "credential" && noopSuggestion(card)) score = Math.min(score, 1);
  if (age > cfg.freshMs && kind !== "credential" && urgency !== "critical") score = Math.min(score, 1);
  if (age > cfg.staleMs) score = Math.min(score, 0);
  // "Later" means it matters, just not then. When later comes, it comes back louder.
  if (mem && mem.laterCount > 0 && mem.snoozeUntil && nowMs >= mem.snoozeUntil && score > 0) {
    score = Math.min(3, score + 1);
  }
  return Math.max(0, Math.min(3, score));
}

/** The level a card is nudged at: earned by ignored nudges, capped by importance. */
function levelFor(imp, mem = {}, cfg = DEFAULTS, { climbs: louder = imp >= 2 } = {}) {
  if (!(imp > 0)) return LEVEL.BADGE;
  const base = imp >= 3 ? LEVEL.INSIST : imp === 2 ? LEVEL.FLUTTER : LEVEL.GLOW;
  // A card that matters climbs to the insist. An ordinary ask climbs to the flutter:
  // ignored once, the fairy comes to the pointer. A card that does not climb stays a
  // glow and RESTS instead (recordIgnored).
  const cap = imp >= 2 ? LEVEL.INSIST : louder ? LEVEL.FLUTTER : LEVEL.GLOW;
  const steps = Math.floor((Number(mem && mem.ignored) || 0) / Math.max(1, cfg.escalateEvery));
  return Math.min(cap, base + steps);
}

/** WHO is waiting, in words: the agent, the tab, or the host. */
const GENERIC_WHO_RE = /^(claude[- ]?code|claude|codex|agent|session|unknown|an unidentified.*)$/i;
function whoWaits(card) {
  const agent = String((card && card.agent) || "").trim();
  if (agent && !GENERIC_WHO_RE.test(agent)) return agent;
  const tab = String((card && card.tab) || "").trim();
  if (tab) return tab.length > 40 ? `${tab.slice(0, 39)}…` : tab;
  return "";
}

/** Why look NOW -- at most two short reasons, the strongest first. */
function whyNow(card, nowMs) {
  if (!card) return "";
  const kind = lower(card.kind);
  const reasons = [];
  const who = whoWaits(card);
  const left = deadlineLeftMs(card, nowMs);
  const age = nowMs - createdMs(card);
  if (kind === "credential") {
    const name = String(card.secretName || "").trim();
    reasons.push(`${who || "A session"} needs ${name || "a secret"} to keep going`);
  } else if (card.blocking === true || kind === "blocked") {
    reasons.push(`${who || "A session"} is stopped until you answer`);
  }
  const report = ackOnly(card);
  if (left != null && left > 0 && !report) {
    const fallback = optionLabel(card, card.defaultKey);
    reasons.push(fallback
      ? `picks “${fallback}” for you in ${fmtSpan(left)}`
      : `due in ${fmtSpan(left)}`);
  } else if (lower(card.urgency) === "critical" && reasons.length === 0) {
    // (a critical REPORT lands here too: "Noted" by the deadline is not a reason)
    reasons.push("marked critical");
  }
  if (reasons.length < 2 && age > 10 * MIN) reasons.push(`waiting ${fmtSpan(age)}`);
  if (reasons.length < 2 && !report) {
    const rec = optionLabel(card, card.defaultKey);
    if (rec && !(left != null && left > 0)) reasons.push(`suggested: “${rec}”`);
  }
  const line = reasons.slice(0, 2).join(" · ");
  return line ? line.charAt(0).toUpperCase() + line.slice(1) : "";
}

/** The whisper's lead: new, back, or still waiting. */
function leadFor(card, mem = {}, { returned = false, nowMs = Date.now() } = {}) {
  if (returned) return "While you were away";
  if (!mem || !mem.nudges) return nowMs - createdMs(card) < 15 * MIN ? "New for you" : "Waiting on you";
  return "Still waiting on you";
}

/** The sentence read aloud: short, names the thing and why now. */
function voiceLine(card, nowMs, { more = 0 } = {}) {
  if (!card) return "";
  const title = String(card.title || "a decision").replace(/^Claude Code needs you:\s*/i, "").slice(0, 120);
  const why = whyNow(card, nowMs);
  const tail = more > 0 ? ` And ${more} more after that.` : "";
  return `Hey. ${title} is still waiting for you.${why ? ` ${why}.` : ""}${tail}`;
}

/**
 * What to do now. `cards` in queue order (rank order -- the caller's), `mems` a
 * map id -> memory. ctx: {nowMs, lastNudgeAt, quiet, idleMs, busy, returned}.
 * Returns {act:"none", reason} or {act:"nudge", card, level, importance, why,
 * lead, more, voice, arrival, showMs}.
 */
function plan(cards, mems, ctx = {}, cfg = DEFAULTS) {
  const nowMs = Number(ctx.nowMs) || Date.now();
  if (ctx.quiet) return { act: "none", reason: `held while quiet: ${ctx.quiet}` };
  if (ctx.busy) return { act: "none", reason: "the fairy is busy" };
  if ((Number(ctx.idleMs) || 0) >= cfg.idleHoldMs) return { act: "none", reason: "the owner is away" };
  const list = Array.isArray(cards) ? cards.filter((c) => c && c.id) : [];
  const memory = mems && typeof mems === "object" ? mems : {};
  const live = [];
  for (let i = 0; i < list.length; i += 1) {
    const card = list[i];
    const mem = memory[card.id] || {};
    if (mem.snoozeUntil && nowMs < mem.snoozeUntil) continue;
    const imp = importance(card, nowMs, mem, cfg);
    if (imp <= 0) continue;
    const louder = climbs(card, nowMs, mem, cfg);
    live.push({ card, mem, imp, louder, hold: holdsWork(card) && louder,
      level: levelFor(imp, mem, cfg, { climbs: louder }), order: i });
  }
  if (!live.length) return { act: "none", reason: "nothing waiting that needs a nudge" };
  const due = live.filter((x) => {
    if (ctx.returned) return true;
    const last = Number(x.mem.lastNudgeAt) || 0;
    return !last || nowMs - last >= (cfg.intervalMs[x.level] || cfg.intervalMs[1]);
  });
  if (!due.length) return { act: "none", reason: "nothing is due yet" };
  // Stopped work first; then the loudest; then what matters most. Between equals an
  // IGNORED card goes before one never nudged (it has waited longer and was missed
  // once already) -- the other way round starved every repeat behind the backlog.
  due.sort((a, b) => ((b.hold ? 1 : 0) - (a.hold ? 1 : 0)) || (b.level - a.level) || (b.imp - a.imp)
    || ((Number(b.mem.ignored) || 0) - (Number(a.mem.ignored) || 0))
    || ((a.mem.lastNudgeAt ? 1 : 0) - (b.mem.lastNudgeAt ? 1 : 0)) || (a.order - b.order));
  const top = due[0];
  const arrival = !top.mem.lastNudgeAt && nowMs - createdMs(top.card) < cfg.arrivalWindowMs;
  if (!ctx.returned) {
    const gap = nowMs - (Number(ctx.lastNudgeAt) || 0);
    const need = arrival && top.imp >= 2 ? cfg.arrivalGapMs : (cfg.gapMs[top.level] || cfg.gapMs[1]);
    if (gap < need) return { act: "none", reason: "pacing: a nudge just ran" };
  }
  const more = live.length - 1;
  const voiceDue = nowMs - (Number(ctx.lastVoiceAt) || 0) >= cfg.voiceGapMs;
  return {
    act: "nudge",
    card: top.card,
    level: top.level,
    importance: top.imp,
    climbs: top.louder,
    hold: top.hold,
    arrival,
    returned: Boolean(ctx.returned),
    why: whyNow(top.card, nowMs),
    lead: leadFor(top.card, top.mem, { returned: ctx.returned, nowMs }),
    more,
    // The arrival (and the startup backlog) is spoken by the desk's own announcement:
    // the fairy speaks a REPEAT -- a card it has already nudged about.
    voice: top.level >= LEVEL.INSIST && Boolean(top.mem.lastNudgeAt) && voiceDue,
    showMs: cfg.showMs[top.level] || cfg.showMs[1],
  };
}

// ── per-card memory (pure updates; the caller persists the map) ─────────────

function recordShown(mem = {}, nowMs = Date.now()) {
  return { ...mem, lastNudgeAt: nowMs, nudges: (Number(mem.nudges) || 0) + 1 };
}
/** Ignored. A card that climbs gets louder and is NEVER put off here: only the
 *  owner's "Later" or "Stop nudging" does that. A card that does not climb (a no-op
 *  suggestion, a day-old ask) RESTS after `restAfter` ignored glows -- off the
 *  rotation for `restMs`, and it does not come back louder. */
function recordIgnored(mem = {}, { importance: imp = 2, nowMs = Date.now(), climbs: louder = imp >= 2 } = {}, cfg = DEFAULTS) {
  const ignored = (Number(mem.ignored) || 0) + 1;
  if (!louder && imp <= 1 && !mem.keep && ignored >= cfg.restAfter) {
    return { ...mem, ignored: 0, snoozeUntil: nowMs + cfg.restMs };
  }
  return { ...mem, ignored };
}
/** Opened or answered: the ladder starts over (an answered card leaves the queue anyway). */
function recordActed(mem = {}) {
  return { ...mem, ignored: 0 };
}
function recordLater(mem = {}, nowMs = Date.now(), cfg = DEFAULTS) {
  return { ...mem, snoozeUntil: nowMs + cfg.laterMs, laterCount: (Number(mem.laterCount) || 0) + 1 };
}
function recordMute(mem = {}) {
  return { ...mem, muted: true, keep: false };
}
function recordKeep(mem = {}) {
  return { ...mem, keep: true, muted: false, snoozeUntil: 0 };
}

/** Drop memory for cards that are no longer open, so the file cannot grow forever. */
function pruneMems(mems, openIds) {
  const keep = openIds instanceof Set ? openIds : new Set(openIds || []);
  const out = {};
  for (const [id, mem] of Object.entries(mems && typeof mems === "object" ? mems : {})) {
    if (keep.has(id) && mem && typeof mem === "object") out[id] = mem;
  }
  return out;
}

/** Only well-formed memory survives a load. */
function sanitizeMems(raw) {
  const out = {};
  if (!raw || typeof raw !== "object") return out;
  for (const [id, mem] of Object.entries(raw)) {
    if (!/^d-[a-z0-9]{2,16}$/i.test(id) || !mem || typeof mem !== "object") continue;
    const clean = {};
    for (const key of ["lastNudgeAt", "nudges", "ignored", "snoozeUntil", "laterCount"]) {
      const n = Number(mem[key]);
      if (Number.isFinite(n) && n > 0) clean[key] = n;
    }
    if (mem.muted === true) clean.muted = true;
    if (mem.keep === true) clean.keep = true;
    out[id] = clean;
  }
  return out;
}

// ── where the flutter goes ──────────────────────────────────────────────────

function rectsOverlap(a, b) {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
}

/**
 * Where the fairy hovers and the whisper sits for a flutter: near the cursor (where
 * the owner is looking), NEVER covering it. Four candidate spots around the cursor,
 * the first whose fairy+whisper box fits the work area and keeps a margin around
 * the pointer wins; else the work area's upper-middle, which is still in view.
 * Returns {orb:{x,y} (centre), whisper:{x,y} (top-left), side:"right"|"left"}.
 */
function nudgePlacement(cursor, area, orbSize, whisperSize, { offset = 120, guard = 48 } = {}) {
  const a = area || { x: 0, y: 0, width: 1920, height: 1080 };
  const c = cursor && Number.isFinite(cursor.x) && Number.isFinite(cursor.y)
    ? cursor : { x: a.x + a.width / 2, y: a.y + a.height / 2 };
  const ow = orbSize.width;
  const oh = orbSize.height;
  const ww = whisperSize.width;
  const wh = whisperSize.height;
  const pointer = { x: c.x - guard, y: c.y - guard, width: guard * 2, height: guard * 2 };
  const layout = (centre, side) => {
    const whisper = side === "right"
      ? { x: centre.x + ow / 2 + 4, y: centre.y - wh / 2 }
      : { x: centre.x - ow / 2 - 4 - ww, y: centre.y - wh / 2 };
    const box = {
      x: Math.min(centre.x - ow / 2, whisper.x),
      y: Math.min(centre.y - oh / 2, whisper.y),
      width: ow + ww + 4,
      height: Math.max(oh, wh),
    };
    return { orb: centre, whisper, side, box };
  };
  const fits = (box) => box.x >= a.x && box.y >= a.y
    && box.x + box.width <= a.x + a.width && box.y + box.height <= a.y + a.height;
  const candidates = [
    layout({ x: c.x + offset, y: c.y - offset }, "right"),
    layout({ x: c.x - offset, y: c.y - offset }, "left"),
    layout({ x: c.x + offset, y: c.y + offset }, "right"),
    layout({ x: c.x - offset, y: c.y + offset }, "left"),
  ];
  for (const cand of candidates) {
    if (fits(cand.box) && !rectsOverlap(cand.box, pointer)) {
      return { orb: cand.orb, whisper: cand.whisper, side: cand.side };
    }
  }
  // Fallback: upper-middle of the screen, clamped, still clear of the pointer when it can be.
  const centre = { x: a.x + a.width / 2 - ww / 2, y: a.y + Math.max(oh, a.height * 0.18) };
  let fb = layout(centre, "right");
  if (rectsOverlap(fb.box, pointer)) fb = layout({ x: centre.x, y: a.y + a.height * 0.62 }, "right");
  const clampX = (x, w) => Math.max(a.x, Math.min(x, a.x + a.width - w));
  const clampY = (y, h) => Math.max(a.y, Math.min(y, a.y + a.height - h));
  return {
    orb: { x: clampX(fb.orb.x - ow / 2, ow) + ow / 2, y: clampY(fb.orb.y - oh / 2, oh) + oh / 2 },
    whisper: { x: clampX(fb.whisper.x, ww), y: clampY(fb.whisper.y, wh) },
    side: "right",
  };
}

/** The flutter itself: a small figure-eight around the anchor, bigger when insisting. */
function flutterOffset(nowMs, level) {
  const amp = level >= LEVEL.INSIST ? 16 : 10;
  const t = Number(nowMs) / 1000;
  return {
    x: Math.round(Math.sin(t * 2.6) * amp),
    y: Math.round(Math.sin(t * 5.2) * amp * 0.45 + Math.sin(t * 1.3) * 3),
  };
}

/** What the whisper shows: the card's own options (max 3), never invented ones. */
function whisperView(decision, nowMs = Date.now()) {
  if (!decision || !decision.card) return null;
  const card = decision.card;
  const kind = lower(card.kind);
  const options = kind === "credential" ? [] : (Array.isArray(card.options) ? card.options : [])
    .slice(0, 4)
    .map((o) => ({
      key: String(o.key),
      label: String(o.label || o.key).slice(0, 120),
      // A consequence that only repeats its label ("Leave them" / "Leave them") says nothing.
      consequence: sameText(o.consequence, o.label || o.key) ? "" : String(o.consequence || "").slice(0, 160),
      recommended: Boolean(o.recommended) || (card.defaultKey && lower(o.key) === lower(card.defaultKey)),
    }));
  const title = String(card.title || "A decision").replace(/^Claude Code needs you:\s*/i, "");
  // Only an explicit click opens an old card; it says so, and how old, in the header.
  const old = isStale(card, nowMs);
  const lead = decision.lead || leadFor(card, {}, { nowMs });
  return {
    id: card.id,
    level: decision.level,
    lead: old ? `${lead} · ${fmtSpan(nowMs - createdMs(card))} old` : lead,
    old: old ? "Old — still relevant?" : "",
    title: title.length > 110 ? `${title.slice(0, 109)}…` : title,
    why: decision.why || whyNow(card, nowMs),
    // Owner 2026-11-08: "I need this to give me more info". The whisper carries
    // what the card actually says -- its summary, its facts -- not just a title.
    summary: kind === "credential" ? "" : clip(String(card.summary || card.detail || ""), 420),
    facts: kind === "credential" ? [] : (Array.isArray(card.facts) ? card.facts : [])
      .filter((f) => typeof f === "string" && f.trim())
      .slice(0, 4)
      .map((f) => clip(f.trim(), 220)),
    options,
    credential: kind === "credential",
    more: Math.max(0, Number(decision.more) || 0),
    moreLabel: moreLabel(decision.more),
    // The card's generated UI (card-ui.cjs render tree), when it is current and
    // valid; the page draws it with createElement/textContent and falls back to
    // the options above on null. Re-checked here against the card's OWN keys.
    ui: whisperUi(card, kind),
    uiKeys: whisperUi(card, kind) ? cardKeys(card) : [],
  };
}

function clip(s, n) {
  const t = s.replace(/[ \t]+\n/g, "\n").trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
}

/** The render tree the whisper may draw, or null (credential, stale, invalid). */
function whisperUi(card, kind) {
  if (kind === "credential" || !card.uiTree) return null;
  return cardUiCore.checkTree(card.uiTree, cardKeys(card)) > 0 ? card.uiTree : null;
}

function cardKeys(card) {
  return (Array.isArray(card.options) ? card.options : [])
    .filter((o) => o && typeof o.key === "string")
    .map((o) => o.key);
}

// ── the fairy's voice: a chime, and a chat about the card ──────────────────

/**
 * The chime a nudge plays (owner 2026-11-08: "optionally have the fairy actually
 * make sounds"). Synthesized in the orb page with WebAudio -- no audio files --
 * and louder by level: L1 one soft note, L2 a two-note rise, L3 three notes.
 * Each note: {freq (Hz), at (s from start), dur (s), gain (0..1 peak)}.
 * Level 0 (the badge) is silent: [].
 */
const CHIME = Object.freeze({
  1: Object.freeze([{ freq: 1046.5, at: 0, dur: 0.5, gain: 0.05 }]),
  2: Object.freeze([
    { freq: 784, at: 0, dur: 0.32, gain: 0.07 },
    { freq: 1174.7, at: 0.16, dur: 0.5, gain: 0.07 },
  ]),
  3: Object.freeze([
    { freq: 784, at: 0, dur: 0.28, gain: 0.1 },
    { freq: 987.8, at: 0.14, dur: 0.28, gain: 0.1 },
    { freq: 1318.5, at: 0.28, dur: 0.6, gain: 0.11 },
  ]),
});
function chimePattern(level) {
  const lv = Math.max(0, Math.min(3, Math.floor(Number(level) || 0)));
  return (CHIME[lv] || []).map((n) => ({ ...n }));
}

function clipText(value, max) {
  const s = String(value == null ? "" : value).replace(/\s+/g, " ").trim();
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

/**
 * What the fairy knows when the owner chats about a card: the title, why it wants
 * an answer now, the card's OWN options with their consequences, and -- for a card
 * a session raised -- what that session last asked and said (session-context
 * readContext). Plain text, bounded, never the value of a credential (a credential
 * card carries a NAME only, and this reads no field that could hold a value).
 */
function chatContext(card, nowMs = Date.now(), { session = null } = {}) {
  if (!card || typeof card !== "object") return "";
  const kind = lower(card.kind);
  const title = clipText(String(card.title || "A decision").replace(/^Claude Code needs you:\s*/i, ""), 200);
  const lines = [`The owner is asking about this decision card: "${title}".`];
  const who = whoWaits(card);
  if (who) lines.push(`Raised by: ${clipText(who, 80)}.`);
  const why = whyNow(card, nowMs);
  if (why) lines.push(`Why it wants an answer now: ${why}.`);
  if (card.summary) lines.push(`What the card says: ${clipText(card.summary, 800)}`);
  if (kind === "credential") {
    lines.push(`It needs the secret ${clipText(card.secretName || "(unnamed)", 80)}, entered in the Inbox's masked field -- never in chat.`);
  } else {
    const options = Array.isArray(card.options) ? card.options.slice(0, 6) : [];
    if (options.length) {
      lines.push("Its options:");
      options.forEach((o, i) => {
        const rec = o.recommended || (card.defaultKey && lower(o.key) === lower(card.defaultKey));
        const cons = o.consequence && !sameText(o.consequence, o.label || o.key) ? ` -- ${clipText(o.consequence, 200)}` : "";
        lines.push(`${i + 1}. ${clipText(o.label || o.key, 80)}${rec ? " (suggested)" : ""}${cons}`);
      });
    }
  }
  if (session && session.ok) {
    if (session.name) lines.push(`The session: ${clipText(session.name, 120)}.`);
    if (session.lastAsk) lines.push(`Its last instruction: ${clipText(session.lastAsk, 500)}`);
    if (session.lastSaid) lines.push(`What it last said: ${clipText(session.lastSaid, 1200)}`);
  }
  return lines.join("\n");
}

/** The question sent through the bubble's ask path: the card first, then the owner. */
function chatQuestion(context, said) {
  const q = String(said || "").trim();
  if (!context) return q;
  return `${context}\n\nAnswer about THIS card (not about the screen unless asked). The owner asks: ${q}`;
}

module.exports = {
  LEVEL,
  DEFAULTS,
  ackOnly,
  noopSuggestion,
  NOOP_SUGGESTION_LABELS,
  holdsWork,
  climbs,
  isStale,
  sameText,
  moreLabel,
  deadlineLeftMs,
  fmtSpan,
  importance,
  levelFor,
  whyNow,
  leadFor,
  voiceLine,
  plan,
  recordShown,
  recordIgnored,
  recordActed,
  recordLater,
  recordMute,
  recordKeep,
  pruneMems,
  sanitizeMems,
  nudgePlacement,
  flutterOffset,
  whisperView,
  chimePattern,
  chatContext,
  chatQuestion,
};
