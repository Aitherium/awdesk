"use strict";

/**
 * orb-core — the pure half of the floating ask orb (orb-window.cjs).
 *
 * Owner, 2026-11-02: "integrate the system like the spirit guide in DarkMatter
 * where you can click and ask it what it sees and it just responds like a
 * floating orb with a chat bubble on your desktop".
 *
 * The FEEL is the spirit guide's (D:/dark-matters .../world3d/guideQueueCore.mjs):
 * ONE line up at a time, an answer holds for its reading time, a more urgent
 * line preempts a quieter one, and nothing repeats. A chat transcript would be
 * the wrong shape — the owner asked for a floating companion, not a window to
 * scroll.
 *
 * No DOM, no Electron, no clock: every function takes `now` as an argument, so
 * the pacing rules can be asserted under `node --test`. orb-window.cjs owns the
 * windows, the timers and the vision transport; this file owns the decisions.
 *
 * Deliberately NOT here: streaming. The vision service answers in ONE response
 * (`/analyze/upload`), so the bubble's reveal is cosmetic pacing, not transport.
 */

// ── pacing ──────────────────────────────────────────────────────────────────

/** Words per minute the owner reads a short answer at. */
const READ_WPM = 240;
/** A line is up for at least this long, even if it is two words. */
const MIN_HOLD_MS = 4000;
/** ...and never longer than this, however long the answer. */
const MAX_HOLD_MS = 30000;
/** Fixed holds for the kinds that are not read word-for-word. */
const HOLD_MS = Object.freeze({ error: 12000, status: 2200 });
/** Quiet gap before the next non-urgent line shows. */
const GAP_MS = 700;
/** A status line still waiting after this long is stale (the ask it described
 *  already finished, or failed loudly in another line). */
const STATUS_TTL_MS = 12000;
/** How long a captured image stays the FOLLOW-UP context. */
const FOLLOWUP_MS = 120000;

/**
 * How long an answer stays up: a read time for its word count, bounded.
 * 1.2 s of settle time so the eye lands before the clock starts.
 */
function readingTimeMs(text, { wpm = READ_WPM, minMs = MIN_HOLD_MS, maxMs = MAX_HOLD_MS } = {}) {
  const words = String(text || "").trim().split(/\s+/).filter(Boolean).length;
  const ms = 1200 + (words / Math.max(1, wpm)) * 60000;
  return Math.round(Math.max(minMs, Math.min(maxMs, ms)));
}

function kindOf(item) {
  return item && item.kind === "error" ? "error"
    : item && item.kind === "status" ? "status"
      : "answer";
}

/** Urgency is the guide's: an answer and an error always get through (3), a
 *  status line waits for a quiet moment (1). */
function urgencyOf(kind) {
  return kind === "status" ? 1 : 3;
}

/** A tie at urgency 3: the error wins, the answer waits its turn. */
function rankOf(kind) {
  return kind === "error" ? 2 : kind === "answer" ? 1 : 0;
}

let seq = 0;
function nextId(now) {
  seq = (seq + 1) % 1e6;
  return `orb-${now}-${seq}`;
}

function normalize(item, now) {
  const kind = kindOf(item);
  const text = String((item && item.text) || "").trim();
  if (!text) return null;
  const holdMs = Number.isFinite(item.holdMs)
    ? Math.max(800, Number(item.holdMs))
    : kind === "answer" ? readingTimeMs(text) : HOLD_MS[kind];
  // A status line normally goes stale in 12 s (the ask it describes is done or
  // has failed loudly elsewhere). A status that NAMES a long wait — the region
  // selection — carries its own ttl.
  const ttlMs = Number.isFinite(item.ttlMs) && Number(item.ttlMs) > 0 ? Number(item.ttlMs) : STATUS_TTL_MS;
  return {
    id: typeof item.id === "string" && item.id ? item.id : nextId(now),
    kind,
    text,
    urgency: Number.isFinite(item.urgency) ? Math.max(0, Math.min(3, Number(item.urgency))) : urgencyOf(kind),
    holdMs,
    ttlMs,
    pinned: item.pinned === true,
    at: now,
    // Free-form, renderer-only context (the capture path, the elapsed time, the
    // remedy lines). Never interpreted here.
    meta: item.meta && typeof item.meta === "object" ? { ...item.meta } : null,
  };
}

function createQueue({ max = 8, chatty = true } = {}) {
  return { items: [], cur: null, curAt: 0, lastHideAt: -Infinity, chatty, max, shown: 0 };
}

/** Queue a line. Returns the normalized item, or null when it was empty or a
 *  duplicate of what is already up / waiting. */
function push(queue, item, now = Date.now()) {
  const it = normalize(item, now);
  if (!it) return null;
  // A status line is about NOW and never queues behind a finished ask.
  if (it.kind === "status") {
    queue.items = queue.items.filter((x) => x.kind !== "status");
    if (queue.cur && queue.cur.kind === "status") {
      queue.cur = null;
      queue.lastHideAt = now;
    }
  } else {
    if (queue.cur && queue.cur.kind === it.kind && queue.cur.text === it.text) return null;
    if (queue.items.some((x) => x.kind === it.kind && x.text === it.text)) return null;
  }
  queue.items.push(it);
  // Bounded: drop the oldest unpinned status first, then the oldest unpinned line.
  while (queue.items.length > queue.max) {
    const status = queue.items.findIndex((x) => !x.pinned && x.kind === "status");
    const drop = status >= 0 ? status : queue.items.findIndex((x) => !x.pinned);
    if (drop < 0) break;
    queue.items.splice(drop, 1);
  }
  return it;
}

function rank(item) {
  return [item.urgency, rankOf(item.kind), -item.at];
}

function bestOf(items) {
  let best = null;
  for (const item of items) {
    if (!best) { best = item; continue; }
    const a = rank(item), b = rank(best);
    if (a[0] !== b[0] ? a[0] > b[0] : a[1] !== b[1] ? a[1] > b[1] : a[2] > b[2]) best = item;
  }
  return best;
}

/**
 * Advance the queue: what to take down and what to put up, at most one line.
 * @returns {{show: object|null, hide: object|null, cur: object|null}}
 */
function tick(queue, now = Date.now()) {
  const out = { show: null, hide: null, cur: queue.cur };
  // The line currently up leaves when its hold has elapsed — unless pinned.
  if (queue.cur && !queue.cur.pinned && now - queue.curAt >= queue.cur.holdMs) {
    out.hide = queue.cur;
    queue.cur = null;
    queue.lastHideAt = now;
  }
  // A status line describes an ask in flight; once it is stale it is noise.
  queue.items = queue.items.filter((x) => x.kind !== "status" || now - x.at < x.ttlMs);
  if (!queue.items.length) {
    out.cur = queue.cur;
    return out;
  }
  const best = bestOf(queue.items);
  if (!best) {
    out.cur = queue.cur;
    return out;
  }
  if (queue.cur) {
    const wins = best.urgency > queue.cur.urgency
      || (best.urgency === queue.cur.urgency && rankOf(best.kind) > rankOf(queue.cur.kind));
    if (!wins) {
      out.cur = queue.cur;
      return out;
    }
    // Preempted: a real answer goes back into the queue (it has no expiry);
    // a status line is simply dropped.
    out.hide = queue.cur;
    if (queue.cur.kind !== "status") queue.items.push(queue.cur);
    queue.cur = null;
  } else if (!queue.chatty && best.urgency < 3) {
    out.cur = queue.cur;
    return out;
  } else if (best.urgency < 3 && now - queue.lastHideAt < GAP_MS) {
    out.cur = queue.cur;
    return out;
  }
  queue.items.splice(queue.items.indexOf(best), 1);
  queue.cur = best;
  queue.curAt = now;
  queue.shown += 1;
  out.show = best;
  out.cur = best;
  return out;
}

/** Pin/unpin a line so its hold never expires it. Returns the new state. */
function setPinned(queue, id, pinned, now = Date.now()) {
  const next = Boolean(pinned);
  if (queue.cur && queue.cur.id === id) {
    queue.cur.pinned = next;
    // Toggling the pin restarts the hold: the owner just touched the card, so
    // it gets a full reading time from that moment (pinning keeps it forever;
    // unpinning resumes the countdown from now rather than expiring instantly).
    queue.curAt = now;
    return { ok: true, item: queue.cur, pinned: next };
  }
  const item = queue.items.find((x) => x.id === id);
  if (!item) return { ok: false, reason: "that answer is no longer up" };
  item.pinned = next;
  return { ok: true, item, pinned: next };
}

function clear(queue) {
  const had = Boolean(queue.cur) || queue.items.length > 0;
  const hide = queue.cur;
  queue.items = [];
  queue.cur = null;
  return { ok: true, had, hide };
}

/** "2 answers waiting" / "" — the bubble's footer and the orb's badge. */
function queueSummary(queue) {
  const answers = queue.items.filter((x) => x.kind === "answer").length;
  const errors = queue.items.filter((x) => x.kind === "error").length;
  const waiting = answers + errors;
  if (!waiting) return "";
  if (errors && answers) return `${waiting} waiting (${errors} error${errors === 1 ? "" : "s"})`;
  if (errors) return `${errors} error${errors === 1 ? "" : "s"} to read`;
  return `${answers} answer${answers === 1 ? "" : "s"} waiting`;
}

/** Count for the orb badge: everything not yet shown (the answer up counts as
 *  unread until it is pinned or copied). */
function unreadCount(queue) {
  const up = queue.cur && queue.cur.kind !== "status" ? 1 : 0;
  return queue.items.filter((x) => x.kind !== "status").length + up;
}

// ── prompts ─────────────────────────────────────────────────────────────────

const SCREEN_PROMPT = [
  "This is a screenshot of the desktop the user is looking at right now.",
  "Answer directly in 2-4 short sentences, first person, as their on-screen assistant.",
  "Say what the main windows are, quote any text that looks important, and name anything",
  "that looks wrong or that they may need to act on. Never describe the screenshot itself,",
  "never mention pixels, and never ask the user to repeat the question.",
].join(" ");

const REGION_PROMPT = [
  "This is a region the user selected on their screen.",
  "Say what it is and quote the text it contains, in 2-3 short sentences.",
  "If it is a dialog, a chart, a form or an error, say what it wants from the user.",
].join(" ");

const ANSWER_STYLE = "Answer in 2-4 short sentences. Quote any on-screen text you rely on.";

/**
 * The question text handed to the vision model.
 * @param {"screen"|"region"|"text"} kind
 * @param {string} [text] the user's typed question
 * @param {{lastQuestion?: string, isFollowUp?: boolean}} [ctx]
 */
function buildPrompt(kind, text, ctx = {}) {
  const said = String(text || "").trim();
  if (kind === "screen") return SCREEN_PROMPT;
  if (kind === "region") return said ? `${REGION_PROMPT} The user's question about it: ${said}` : REGION_PROMPT;
  if (ctx.isFollowUp && ctx.lastQuestion) {
    return [
      `Earlier the user asked about this same screen: "${String(ctx.lastQuestion).slice(0, 400)}".`,
      `Now they ask: ${said || "what else is worth knowing?"}`,
      ANSWER_STYLE,
    ].join(" ");
  }
  return `${said}\n\n${ANSWER_STYLE}`;
}

// ── vision answers and failures ─────────────────────────────────────────────

/**
 * Turn whatever the gateway's ask_about_image returned into {ok,text} or
 * {ok:false,error}. vision-client parses JSON when the tool returns it and
 * otherwise keeps the plain string in `note` — a failure there is a string
 * that starts with "Error".
 */
function interpretGatewayAnswer(result) {
  if (result == null) return { ok: false, error: "the vision service returned nothing" };
  if (typeof result === "string") {
    const text = result.trim();
    if (!text) return { ok: false, error: "the vision service returned nothing" };
    if (/^error\b/i.test(text)) return { ok: false, error: text };
    return { ok: true, text };
  }
  if (typeof result !== "object") return { ok: false, error: String(result) };
  const direct = result.error;
  if (direct) return { ok: false, error: String(direct) };
  if (typeof result.note === "string" && /^error\b/i.test(result.note.trim())) {
    return { ok: false, error: result.note.trim() };
  }
  for (const key of ["analysis", "answer", "description", "note", "result", "text"]) {
    if (typeof result[key] === "string" && result[key].trim()) return { ok: true, text: result[key].trim() };
  }
  return { ok: false, error: "the vision service returned no answer" };
}

/**
 * The measured causes of a failed ask, each with a remedy the owner can act on.
 * "Never silently" is the feature's contract: an unreachable vision service is
 * a loud card in the bubble that names the port, the error and the next step.
 *
 * @param {string} message the error text (gateway or direct)
 * @param {{gateway?: {active?: string}}} [ctx]
 * @returns {{code: string, title: string, text: string, remedy: string}}
 */
function classifyVisionFailure(message, ctx = {}) {
  const raw = String(message || "").trim();
  const text = raw || "no reason was given";
  const gateway = ctx.gateway && ctx.gateway.active ? ` (gateway ${ctx.gateway.active})` : "";
  // Measured 2026-11-02 on the owner's box: the MCP gateway resolves
  // PerceptionMedia to http:// while the service serves TLS, so the socket
  // closes before a response. That exact sentence is the signature.
  if (/server disconnected without sending a response/i.test(raw)) {
    return {
      code: "tls-mismatch",
      title: "Vision is dialled over plain http",
      text: `The MCP gateway${gateway} reached PerceptionMedia over http:// and the service answered TLS — the socket closed before a response.`,
      remedy: "Set AITHER_PERCEPTIONMEDIA_URL=https://aitheros-perception-media:8084 (and AITHER_VOICE_URL likewise) in the gateway's environment, then restart aitheros-mcpgateway. The orb tried the local service directly; this card means both paths failed.",
    };
  }
  if (/no session bearer|HTTP 401|HTTP 403|unauthor/i.test(raw)) {
    return {
      code: "auth",
      title: "The gateway refused the desk",
      text,
      remedy: "Mint a session bearer, then retry: python AitherOS/dev/tools/mint_session_bearer.py",
    };
  }
  if (/ECONNREFUSED|EHOSTUNREACH|ENETUNREACH|ENOTFOUND|EAI_AGAIN|connect .*refused/i.test(raw)) {
    return {
      code: "unreachable",
      title: "The gateway is not answering",
      text,
      remedy: "Check curl http://127.0.0.1:8182/health — if it refuses, start aitheros-mcpgateway (127.0.0.1, never localhost). The orb retries on the next question.",
    };
  }
  if (/vision lane unavailable|no provider|model returned no analysis|no vision provider/i.test(raw)) {
    return {
      code: "no-provider",
      title: "The vision model lane is down",
      text,
      remedy: "Open https://127.0.0.1:8084/status — when vllm shows available:false and no cloud provider is configured there is nothing to see with. Start the perceiver lane and ask again.",
    };
  }
  if (/timeout|timed out|ETIMEDOUT/i.test(raw)) {
    return {
      code: "timeout",
      title: "Vision did not answer in time",
      text,
      remedy: "Ask again once — the first ask pays a ~28-60 s cold model load and the second call is warm. If it times out twice, open https://127.0.0.1:8084/status: when vllm shows available:false with no cloud provider configured, there is nothing on this box that can see.",
    };
  }
  return {
    code: "unknown",
    title: "Vision could not answer",
    text,
    remedy: "Retry once. If it repeats, read https://127.0.0.1:8084/status and the gateway's log; the error above is the exact reason.",
  };
}

/** The card text for a failure: title, the error, then the remedy. Counts and
 *  remedies in words, per the house UI rule. */
function failureCard(message, ctx = {}) {
  const f = classifyVisionFailure(message, ctx);
  return { ...f, text: `${f.text}\n\n${f.remedy}` };
}

// ── geometry ────────────────────────────────────────────────────────────────

function num(v) {
  return Number.isFinite(Number(v)) ? Number(v) : 0;
}

/** Keep a window fully inside the work area (top-left wins the clamp). */
function clampToWorkArea(pos, size, workArea) {
  const width = num(size && size.width);
  const height = num(size && size.height);
  const area = workArea || { x: 0, y: 0, width: 1920, height: 1080 };
  const maxX = area.x + area.width - width;
  const maxY = area.y + area.height - height;
  return {
    x: Math.round(Math.max(area.x, Math.min(maxX, num(pos && pos.x)))),
    y: Math.round(Math.max(area.y, Math.min(maxY, num(pos && pos.y)))),
  };
}

/**
 * The work area minus a box somebody else owns: the largest of the four rectangles
 * (left of, right of, above, below) that does not touch the box grown by `pad`.
 * 2026-11-12 (Garg): the tenant site draws its own companion (a goblin) in the
 * bottom-right corner, which is also the fairy's first-run spot, so the two sat on
 * top of each other. The fairy yields. No box, a box off this area, or a box that
 * leaves no usable rectangle: the area unchanged.
 */
function areaAvoiding(workArea, box, pad = 0) {
  const a = workArea || { x: 0, y: 0, width: 1920, height: 1080 };
  if (!box || typeof box !== "object") return a;
  if (!(num(box.width) > 0 && num(box.height) > 0)) return a;
  const p = Math.max(0, num(pad));
  const left = Math.max(a.x, num(box.x) - p);
  const top = Math.max(a.y, num(box.y) - p);
  const right = Math.min(a.x + a.width, num(box.x) + num(box.width) + p);
  const bottom = Math.min(a.y + a.height, num(box.y) + num(box.height) + p);
  if (right <= left || bottom <= top) return a;
  const usable = [
    { x: a.x, y: a.y, width: left - a.x, height: a.height },
    { x: right, y: a.y, width: a.x + a.width - right, height: a.height },
    { x: a.x, y: a.y, width: a.width, height: top - a.y },
    { x: a.x, y: bottom, width: a.width, height: a.y + a.height - bottom },
  ].filter((c) => c.width >= 240 && c.height >= 240);
  if (!usable.length) return a;
  return usable.sort((m, n) => n.width * n.height - m.width * m.height)[0];
}

/** A page rect (CSS px of a window at zoom 1) as a screen rect, or null when it is
 *  not a sane on-screen box. `bounds` is the window's content bounds. */
function pageRectOnScreen(rect, bounds) {
  if (!rect || typeof rect !== "object" || !bounds) return null;
  const vals = [rect.x, rect.y, rect.width, rect.height].map(Number);
  if (!vals.every(Number.isFinite)) return null;
  const [x, y, width, height] = vals;
  if (!(width > 0 && height > 0) || width > 640 || height > 640) return null;
  return { x: Math.round(num(bounds.x) + x), y: Math.round(num(bounds.y) + y), width: Math.round(width), height: Math.round(height) };
}

/**
 * The fairy's spot while it is DOCKED on the AitherOS window (owner, 2026-11-12: "the
 * fairy cluster from awdesk should attach to the AitherOS desktop and not be stuck
 * behind the goblin"). Bottom-right INSIDE the window, above its bottom bar, and out
 * of the box the tenant's companion stands in. Top-left of the orb window.
 */
function windowDockSpot(bounds, size, box, pad = 0, { bar = 64 } = {}) {
  const b = bounds || { x: 0, y: 0, width: 1280, height: 800 };
  const inside = { x: num(b.x), y: num(b.y), width: num(b.width), height: Math.max(num(size && size.height) + 56, num(b.height) - bar) };
  const free = areaAvoiding(inside, box, pad);
  return clampToWorkArea(defaultOrbPosition(free, size), size, free);
}

/** First-run spot: bottom-right of the work area, clear of the taskbar. */
function defaultOrbPosition(workArea, size, margin = 28) {
  const area = workArea || { x: 0, y: 0, width: 1920, height: 1080 };
  const width = num(size && size.width);
  const height = num(size && size.height);
  return { x: Math.round(area.x + area.width - width - margin), y: Math.round(area.y + area.height - height - margin) };
}

/**
 * Where the bubble sits beside the orb: right of it normally, LEFT when the
 * right edge would leave the work area, then clamped. Vertically aligned with
 * the orb's top, flipped up when the bottom would overflow.
 */
function bubblePosition(orb, bubble, workArea, gap = 10) {
  const o = orb || {};
  const b = bubble || {};
  const area = workArea || { x: 0, y: 0, width: 1920, height: 1080 };
  const w = num(b.width);
  const h = num(b.height);
  let x = num(o.x) + num(o.width) + gap;
  if (x + w > area.x + area.width) x = num(o.x) - w - gap;
  let y = num(o.y);
  if (y + h > area.y + area.height) y = area.y + area.height - h;
  return clampToWorkArea({ x, y }, { width: w, height: h }, area);
}

// ── persisted state (orb.json) ──────────────────────────────────────────────

/** The saved shape is small on purpose: position, whether the orb is showing,
 *  and whether an answer was pinned. A bad file costs the settings, never a
 *  launch (the same fail-soft rule as window-size.json). */
function sanitizeState(raw) {
  const src = raw && typeof raw === "object" ? raw : {};
  const finite = (v) => (Number.isFinite(Number(v)) ? Math.round(Number(v)) : null);
  return {
    visible: src.visible !== false,
    pinned: src.pinned === true,
    x: finite(src.x),
    y: finite(src.y),
    // The owner pulled the spirit off its avatar and left it free: do not re-orbit.
    freeRoam: src.freeRoam === true,
    // The fairy chimes when it nudges (owner 2026-11-08), on unless turned off.
    sounds: src.sounds !== false,
    // "Mute nudges 1 hour" from the orb's right-click menu (owner 2026-11-12): ms epoch.
    muteUntil: Math.max(0, finite(src.muteUntil) || 0),
  };
}

module.exports = {
  READ_WPM, MIN_HOLD_MS, MAX_HOLD_MS, HOLD_MS, GAP_MS, STATUS_TTL_MS, FOLLOWUP_MS,
  SCREEN_PROMPT, REGION_PROMPT,
  readingTimeMs, createQueue, push, tick, setPinned, clear, queueSummary, unreadCount,
  buildPrompt, interpretGatewayAnswer, classifyVisionFailure, failureCard,
  clampToWorkArea, areaAvoiding, pageRectOnScreen, windowDockSpot, defaultOrbPosition, bubblePosition, sanitizeState,
};
