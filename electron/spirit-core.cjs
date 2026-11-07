"use strict";

/**
 * spirit-core — the pure half of the spirit (orb-window.cjs), the floating ask
 * orb grown into a companion that can be ATTACHED to a body or a window, SENT
 * to do something and WATCHED while it goes, and can come back HOLDING a file
 * or a web result.
 *
 * Owner, 2026-11-02, in order: "integrate with the awdesk avatar/persona too" ·
 * "make the spirit attachable/detachable basically" · "awdesk avatars which are
 * basically an agent can send the spirit orb to do stuff around the desktop, go
 * look at files, for context" · "and you can watch it go" · "I want to be able to
 * right click and search, or ask a question or send something to it, or be like
 * 'go find this file and give me the path' and then it literally retrieves it and
 * holds it ... or just read it and talk to me about the file in text or voice" ·
 * "and things like web searches too!"
 *
 * No DOM, no Electron, no clock, no fs: every decision here is a value, so the
 * rules are asserted under `node --test`. orb-window.cjs owns the windows, the
 * animation, the probe and the transports; this file answers:
 *   - what a spirit command means (parseArg), and what a trip is
 *   - where the orb docks for each attach target, and which target a drop hit
 *   - the eased flight path and how long it takes
 *   - the trip queue (one at a time) and the visible log (last five)
 *   - what a search answer looks like as rows ("top 5 + N more")
 *   - what "held" means for a file, a web result, dropped text or images
 *   - which paths are refused as credentials, before anything is opened
 */

// ── commands ────────────────────────────────────────────────────────────────

/** What an agent may ask the spirit to do through `spirit.go`. */
const KINDS = Object.freeze(["file", "folder", "window", "region", "search", "web"]);

const MAX_TARGET = 1000;
const MAX_QUESTION = 2000;

function text(value, max) {
  return String(value == null ? "" : value).trim().slice(0, max);
}

/**
 * `spirit.go`'s argument. Agents send JSON ({kind, target, question?,
 * requester?}); the palette row and a bare string mean "find this".
 *
 * @param {string|object} arg
 * @returns {{ok: true, request: object} | {ok: false, error: string}}
 */
function parseArg(arg) {
  if (arg == null || arg === "") return { ok: false, error: "the spirit needs something to do" };
  let raw = arg;
  if (typeof arg === "string") {
    const t = arg.trim();
    if (!t) return { ok: false, error: "the spirit needs something to do" };
    try {
      raw = JSON.parse(t);
    } catch {
      // A plain sentence is a search, not an error: "go find notes.md".
      raw = { kind: "search", target: t };
    }
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, error: "the spirit wants a JSON object, not that" };
  }
  const kind = text(raw.kind, 20).toLowerCase();
  if (!KINDS.includes(kind)) {
    return { ok: false, error: `unknown spirit kind "${kind}" — use ${KINDS.join(", ")}` };
  }
  const target = text(raw.target, MAX_TARGET);
  if (!target && kind !== "region") return { ok: false, error: `a ${kind} trip needs a target` };
  const question = text(raw.question, MAX_QUESTION) || null;
  return {
    ok: true,
    request: {
      kind,
      target,
      question,
      requester: text(raw.requester, 200) || null,
      // The avatar that SPEAKS the answer: the requester's slot when named, or
      // the body the spirit is attached to when it is attached to one.
      slotId: text(raw.slotId || raw.slot, 80) || null,
    },
  };
}

let seq = 0;
/** Give a request an id and a time; the queue and the log use both. */
function normalizeTrip(request, now = Date.now()) {
  const r = request && typeof request === "object" ? request : {};
  seq = (seq + 1) % 1e6;
  return {
    id: typeof r.id === "string" && r.id ? r.id : `trip-${now}-${seq}`,
    kind: KINDS.includes(r.kind) ? r.kind : "search",
    target: text(r.target, MAX_TARGET),
    question: text(r.question, MAX_QUESTION) || null,
    requester: text(r.requester, 200) || null,
    slotId: text(r.slotId || r.slot, 80) || null,
    at: now,
  };
}

// ── the trip queue: one at a time, the rest wait ────────────────────────────

function createTripQueue({ max = 20 } = {}) {
  return { items: [], cur: null, max };
}

/** Queue a trip. Returns {ok, trip, position} — position 1 is "running". */
function enqueue(queue, request, now = Date.now()) {
  const trip = normalizeTrip(request, now);
  queue.items.push(trip);
  while (queue.items.length > queue.max) queue.items.shift();
  // The place this trip will run: after the running one, then in queue order.
  const position = (queue.cur ? 1 : 0) + queue.items.length;
  return { ok: true, trip, position };
}

/** Take the next trip when nothing is running. Returns the trip or null. */
function dequeue(queue) {
  if (queue.cur || !queue.items.length) return null;
  queue.cur = queue.items.shift();
  return queue.cur;
}

function finish(queue, id = null) {
  const done = queue.cur;
  if (!done) return null;
  if (id && done.id !== id) return null;
  queue.cur = null;
  return done;
}

/**
 * Cancel the running trip (Esc, a click on the spirit). The queued trips stay,
 * because cancelling one is not a request to abandon the rest.
 */
function cancel(queue, id = null) {
  const cur = queue.cur;
  if (!cur) return { ok: false, reason: "no trip is running" };
  if (id && cur.id !== id) return { ok: false, reason: "that trip is not the one running" };
  queue.cur = null;
  return { ok: true, trip: cur };
}

function queueCount(queue) {
  return (queue.cur ? 1 : 0) + queue.items.length;
}

/** "2 more trips waiting" / "" — the bubble's footer. */
function queueLine(queue) {
  const waiting = queue.items.length;
  if (!waiting) return "";
  return `${waiting} more trip${waiting === 1 ? "" : "s"} waiting`;
}

// ── the visible trip log: the last five, then "+N more" ────────────────────

function createTripLog({ max = 5 } = {}) {
  return { items: [], extra: 0, max };
}

/**
 * Append one finished trip. `entry` is {label, ok, at} — the label is the line
 * the owner reads ("found notes.md", "refused a credential").
 */
function logTrip(log, entry, now = Date.now()) {
  const e = {
    label: text(entry && entry.label, 200) || "a trip",
    ok: !(entry && entry.ok === false),
    at: Number.isFinite(entry && entry.at) ? Number(entry.at) : now,
  };
  log.items.unshift(e);
  while (log.items.length > log.max) {
    log.items.pop();
    log.extra += 1;
  }
  return e;
}

/** What the bubble renders: five lines and "+N more". */
function logView(log) {
  return {
    items: log.items.slice(0, log.max),
    more: log.extra,
    moreLine: log.extra > 0 ? `+${log.extra} more` : "",
  };
}

// ── flight ──────────────────────────────────────────────────────────────────

function num(v, fallback = 0) {
  return Number.isFinite(Number(v)) ? Number(v) : fallback;
}

/** Cubic ease-in-out: it leaves the shoulder and arrives at the target softly. */
function easeInOut(t) {
  const x = Math.max(0, Math.min(1, num(t)));
  return x < 0.5 ? 4 * x * x * x : 1 - ((-2 * x + 2) ** 3) / 2;
}

/**
 * The path from `from` to `to`, as a cubic bezier that ARCKS (never a straight
 * jump): the control points sit on the perpendicular, lifted upward, so a trip
 * to the far side of a 4K display visibly crosses the desktop and a trip to the
 * next display arcs over the bezel.
 */
function flightPath(from, to, { lift = null } = {}) {
  const p0 = { x: num(from && from.x), y: num(from && from.y) };
  const p3 = { x: num(to && to.x), y: num(to && to.y) };
  const dx = p3.x - p0.x;
  const dy = p3.y - p0.y;
  const dist = Math.hypot(dx, dy);
  // Perpendicular (dx,dy) -> (dy,-dx), flipped so the arc rises on screen.
  let nx = dy;
  let ny = -dx;
  if (ny > 0) { nx = -nx; ny = -ny; }
  if (dist < 1) { nx = 0; ny = -1; }
  const nlen = Math.hypot(nx, ny) || 1;
  const amount = lift == null ? Math.max(60, Math.min(260, dist * 0.18)) : Math.max(0, num(lift));
  const ox = (nx / nlen) * amount;
  const oy = (ny / nlen) * amount;
  return {
    p0,
    p1: { x: p0.x + dx * 0.28 + ox, y: p0.y + dy * 0.28 + oy },
    p2: { x: p0.x + dx * 0.72 + ox, y: p0.y + dy * 0.72 + oy },
    p3,
    distance: dist,
  };
}

/** The point at `t` on the path (t is already eased by the caller). */
function pointAt(path, t) {
  const u = Math.max(0, Math.min(1, num(t)));
  const v = 1 - u;
  const a = v * v * v;
  const b = 3 * v * v * u;
  const c = 3 * v * u * u;
  const d = u * u * u;
  return {
    x: Math.round(a * path.p0.x + b * path.p1.x + c * path.p2.x + d * path.p3.x),
    y: Math.round(a * path.p0.y + b * path.p1.y + c * path.p2.y + d * path.p3.y),
  };
}

/** How long a trip takes: distance-scaled, bounded, never a jump. */
function flightDurationMs(from, to, { min = 600, max = 2200 } = {}) {
  const dist = Math.hypot(num(to && to.x) - num(from && from.x), num(to && to.y) - num(from && from.y));
  return Math.round(Math.max(min, Math.min(max, 650 + dist * 0.75)));
}

/** A short hop home after a cancel, so the spirit never teleports. */
function returnDurationMs() {
  return 480;
}

// ── attach ──────────────────────────────────────────────────────────────────

const ATTACH_KINDS = Object.freeze(["avatar", "window", "desk"]);

/** Bounds as {x,y,width,height} with finite numbers; null when unusable. */
function normBounds(b) {
  if (!b || typeof b !== "object") return null;
  const width = num(b.width);
  const height = num(b.height);
  if (width <= 0 || height <= 0) return null;
  return { x: Math.round(num(b.x)), y: Math.round(num(b.y)), width: Math.round(width), height: Math.round(height) };
}

function containsPoint(b, p, pad = 0) {
  const r = normBounds(b);
  if (!r) return false;
  const x = num(p && p.x);
  const y = num(p && p.y);
  return x >= r.x - pad && x <= r.x + r.width + pad && y >= r.y - pad && y <= r.y + r.height + pad;
}

function areaOf(b) {
  const r = normBounds(b);
  return r ? r.width * r.height : Infinity;
}

/**
 * Which target did a drop land on? An avatar wins (the owner dropped the orb
 * ON the body), then the smallest window containing the point (the one on top,
 * in practice). A candidate without usable bounds is ignored.
 */
function pickAttachTarget(point, candidates = []) {
  const usable = (Array.isArray(candidates) ? candidates : [])
    .filter((c) => c && ATTACH_KINDS.includes(c.kind) && normBounds(c.bounds))
    .filter((c) => containsPoint(c.bounds, point, c.kind === "avatar" ? 28 : 4));
  if (!usable.length) return null;
  const priority = (c) => (c.kind === "avatar" ? 0 : c.kind === "desk" ? 1 : 2);
  usable.sort((a, b) => priority(a) - priority(b) || areaOf(a.bounds) - areaOf(b.bounds));
  return usable[0];
}

/** The orb's spot while attached: the avatar's shoulder, or a window's corner. */
function dockPosition(target, size, { gap = 14 } = {}) {
  const b = normBounds(target && target.bounds) || { x: 0, y: 0, width: 0, height: 0 };
  const w = num(size && size.width, 72);
  if (target && target.kind === "avatar") {
    // Shoulder: against the right edge, high enough to read as "at the shoulder".
    return { x: Math.round(b.x + b.width - w * 0.55), y: Math.round(b.y + b.height * 0.18) };
  }
  return { x: Math.round(b.x + b.width - w - gap), y: Math.round(b.y + gap) };
}

/**
 * The spirit's default life (owner 2026-11-02: "by default it should basically just
 * orbit the awdesk avatars"): a slow tilted ellipse around the avatar's upper body.
 * `front` is +1 when it passes in front, -1 behind (the renderer dims/shrinks it).
 */
function orbitPoint(bounds, tMs, { periodMs = 7000, phase = 0 } = {}) {
  const b = normBounds(bounds);
  if (!b) return null;
  const angle = phase + ((Number(tMs) || 0) % periodMs) / periodMs * Math.PI * 2;
  const rx = Math.max(56, b.width * 0.42);
  const ry = Math.max(14, rx * 0.26);
  const cx = b.x + b.width / 2;
  const cy = b.y + b.height * 0.36;
  return {
    x: Math.round(cx + Math.cos(angle) * rx),
    y: Math.round(cy + Math.sin(angle) * ry),
    front: Math.sin(angle) >= 0 ? 1 : -1,
  };
}

/**
 * A free spirit is not a parked icon (owner 2026-11-02: the fairy is the default
 * companion when no avatar is set up): it hovers around its spot on two slow,
 * unequal sines, so it drifts like something alive and never wanders off.
 */
function hoverOffset(tMs, { ax = 9, ay = 6 } = {}) {
  const t = Number(tMs) || 0;
  return {
    x: Math.round(Math.sin(t / 1700) * ax + Math.sin(t / 4100) * ax * 0.4),
    y: Math.round(Math.sin(t / 2300) * ay),
  };
}

/** Where the tether line ends on the target. */
function anchorFor(target) {
  const b = normBounds(target && target.bounds);
  if (!b) return null;
  if (target.kind === "avatar") {
    return { x: Math.round(b.x + b.width * 0.58), y: Math.round(b.y + b.height * 0.26) };
  }
  return { x: Math.round(b.x + b.width - 18), y: Math.round(b.y + 18) };
}

function attachLabel(target) {
  if (!target) return "free";
  if (target.kind === "avatar") return `attached to ${target.title || "an avatar"}`;
  if (target.kind === "desk") return `attached to ${target.title || "a desk window"}`;
  return `attached to ${target.title || "a window"}`;
}

// ── captions ────────────────────────────────────────────────────────────────

function baseName(p) {
  const s = String(p == null ? "" : p).replace(/[\\/]+$/, "");
  const at = Math.max(s.lastIndexOf("\\"), s.lastIndexOf("/"));
  return at >= 0 ? s.slice(at + 1) : s;
}

function quote(value, max = 48) {
  const s = String(value == null ? "" : value).trim();
  return `“${s.length > max ? `${s.slice(0, max - 1)}…` : s}”`;
}

/** The line the spirit says while it is doing the thing ("reading notes.md"). */
function captionFor(trip) {
  const t = trip || {};
  const name = baseName(t.target);
  if (t.kind === "file") return `reading ${name || "the file"}`;
  if (t.kind === "folder") return `looking in ${name || "the folder"}`;
  if (t.kind === "window") return `looking at ${t.target || "that window"}`;
  if (t.kind === "region") return "looking at that region";
  if (t.kind === "web") return `searching the web for ${quote(t.target)}`;
  return `searching for ${quote(t.target)}`;
}

/** The line a finished trip writes to the visible log. */
function tripSummary(trip, outcome = {}) {
  const t = trip || {};
  if (outcome.ok === false && outcome.refused) return "refused a credential";
  if (outcome.ok === false) return `could not ${t.kind === "web" ? "search the web" : "finish"}${outcome.reason ? ` — ${outcome.reason}` : ""}`.slice(0, 200);
  if (outcome.held) return `holding ${outcome.held.label || outcome.held.name || baseName(outcome.held.path || t.target) || "it"}`;
  if (t.kind === "file") return `read ${baseName(t.target)}`;
  if (t.kind === "folder") return `looked in ${baseName(t.target)}`;
  if (t.kind === "window") return `looked at ${t.target}`;
  if (t.kind === "web") return `searched the web for ${quote(t.target)}`;
  return `found ${baseName(t.target) || t.target}`;
}

// ── guardrails: a credential is refused before anything is opened ──────────

const SECRET_RULES = Object.freeze([
  { test: (name) => /^\.env(\.|$)/i.test(name), why: "an environment file" },
  { test: (name) => /\.(pem|key|p12|pfx|jks|keystore)$/i.test(name), why: "a private key" },
  { test: (name) => /^id_(rsa|dsa|ecdsa|ed25519)(\.pub)?$/i.test(name), why: "an SSH key" },
  { test: (name) => /^credentials(\..*)?\.json$/i.test(name), why: "a credentials file" },
  { test: (name) => /^(\.?session-bearer|\.?netrc|\.?pgpass)$/i.test(name), why: "a credential" },
  { test: (name) => /secret/i.test(name), why: "a credential" },
]);

/**
 * Why this path must not be read, or null when it is ordinary.
 * Matter-of-fact on purpose: the owner asked for the line "1 file refused — it
 * looks like a credential", not a security lecture.
 *
 * @returns {{code: string, reason: string, line: string} | null}
 */
function secretPathReason(filePath) {
  const full = String(filePath == null ? "" : filePath);
  if (!full.trim()) return null;
  const name = baseName(full);
  const segs = full.split(/[\\/]+/).filter(Boolean);
  if (segs.some((s) => s.toLowerCase() === ".ssh")) {
    return { code: "secret", reason: "an SSH folder", line: "1 file refused — it looks like a credential" };
  }
  const lower = segs.map((s) => s.toLowerCase());
  if (lower.includes(".aither") && /session-bearer$/i.test(name)) {
    return { code: "secret", reason: "a session bearer", line: "1 file refused — it looks like a credential" };
  }
  for (const rule of SECRET_RULES) {
    if (rule.test(name)) {
      return { code: "secret", reason: rule.why, line: "1 file refused — it looks like a credential" };
    }
  }
  return null;
}

// ── results as rows: top five, then "+N more" ──────────────────────────────

const FILE_GROUPS = Object.freeze(["files", "screenshots", "apps"]);
const ROW_LIMIT = 5;

function rowDomain(url) {
  try {
    return new URL(String(url)).hostname.replace(/^www\./i, "");
  } catch {
    return "";
  }
}

/**
 * A universal-search run (universal-search.cjs) as the spirit's pick list.
 * Files first, screenshots next, apps last — the owner asked for a FILE — and
 * every group's own `total` (not just the page it returned) is what "+N more"
 * counts.
 */
function fileRows(run, { limit = ROW_LIMIT } = {}) {
  const r = run && typeof run === "object" ? run : {};
  if (r.ok === false) return { ok: false, reason: String(r.reason || "the search did not answer"), rows: [], more: 0, total: 0 };
  const groups = Array.isArray(r.groups) ? r.groups : [];
  const rows = [];
  let total = 0;
  for (const id of FILE_GROUPS) {
    const g = groups.find((x) => x && x.id === id);
    if (!g) continue;
    total += num(g.total, (g.items || []).length);
    for (const item of Array.isArray(g.items) ? g.items : []) {
      if (!item || !item.target) continue;
      rows.push({
        kind: String(item.kind || id),
        title: String(item.title || baseName(item.target)).slice(0, 200),
        subtitle: String(item.subtitle || "").slice(0, 300),
        target: String(item.target),
      });
    }
  }
  // One row per path, keeping the first (the files group's).
  const seen = new Set();
  const unique = rows.filter((row) => {
    const key = row.target.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  const top = unique.slice(0, Math.max(1, limit));
  return {
    ok: true,
    query: String(r.query || ""),
    rows: top,
    more: Math.max(0, total - top.length),
    total,
    note: Array.isArray(r.notes) && r.notes.length ? String(r.notes[0].note || "") : "",
    errors: Array.isArray(r.errors) ? r.errors.map((e) => ({ group: e.group, reason: e.reason })) : [],
  };
}

/**
 * A search-client.cjs web run as rows. Only http(s) links survive (the client
 * already enforces that; this repeats it because a row is clickable).
 */
function webRows(result, { limit = ROW_LIMIT } = {}) {
  const r = result && typeof result === "object" ? result : {};
  if (r.ok === false) return { ok: false, reason: String(r.error || r.reason || "the search did not answer"), rows: [], more: 0, total: 0 };
  const all = Array.isArray(r.results) ? r.results.filter((x) => x && /^https?:\/\//i.test(String(x.url))) : [];
  const top = all.slice(0, Math.max(1, limit)).map((x) => ({
    kind: "web",
    title: String(x.title || x.url).slice(0, 200),
    subtitle: String(x.snippet || "").slice(0, 300),
    url: String(x.url),
    domain: rowDomain(x.url),
    source: String(x.source || ""),
  }));
  return {
    ok: true,
    query: String(r.query || ""),
    answer: typeof r.answer === "string" && r.answer.trim() ? r.answer.trim() : null,
    rows: top,
    more: Math.max(0, all.length - top.length),
    total: all.length,
  };
}

/** "5 of 23" — the count beside a pick list. */
function resultCountLine(rows) {
  const r = rows || {};
  if (!r.rows || !r.rows.length) return "nothing found";
  if (!r.more) return `${r.rows.length} result${r.rows.length === 1 ? "" : "s"}`;
  return `${r.rows.length} of ${r.rows.length + r.more}`;
}

// ── held things ─────────────────────────────────────────────────────────────

const DROP_TEXT_MAX = 4000;

function holdFromFile(filePath, extra = {}) {
  const p = String(filePath == null ? "" : filePath);
  if (!p) return null;
  return {
    kind: "file",
    path: p,
    name: baseName(p) || p,
    dir: p.slice(0, Math.max(0, p.length - (baseName(p) || "").length)).replace(/[\\/]+$/, ""),
    ...extra,
  };
}

function holdFromFiles(paths) {
  const list = (Array.isArray(paths) ? paths : []).filter(Boolean).map(String);
  if (!list.length) return null;
  const first = holdFromFile(list[0]);
  if (!first) return null;
  if (list.length === 1) return first;
  return { ...first, files: list, label: `${list.length} files` };
}

function holdFromWeb(row) {
  if (!row || !/^https?:\/\//i.test(String(row.url))) return null;
  return {
    kind: "web",
    url: String(row.url),
    title: String(row.title || row.url).slice(0, 300),
    domain: row.domain || rowDomain(row.url),
    label: String(row.title || rowDomain(row.url) || "a link").slice(0, 120),
  };
}

function holdFromText(value) {
  const body = String(value == null ? "" : value).trim();
  if (!body) return null;
  return {
    kind: "text",
    text: body.slice(0, DROP_TEXT_MAX),
    label: body.length > 120 ? `${body.slice(0, 117)}…` : body,
  };
}

/** Which buttons the chip under the orb offers for this hold. */
function holdActions(hold, { hasBoard = false } = {}) {
  if (!hold) return [];
  if (hold.kind === "file") {
    const out = [
      { id: "open", label: "Open" },
      { id: "show", label: "Show in Files" },
      { id: "copy", label: "Copy path" },
    ];
    // An image gets the question the owner asked for a dropped picture; a
    // document gets "Read it" (file-ask summarises it in plain sentences).
    if (/\.(png|jpe?g|gif|webp|bmp|heic|avif|tiff?)$/i.test(String(hold.path || hold.name || ""))) {
      out.push({ id: "what", label: "What is this" });
    }
    out.push({ id: "read", label: "Read it" });
    return out;
  }
  if (hold.kind === "web") {
    return [
      { id: "open", label: "Open" },
      { id: "copy", label: "Copy URL" },
      { id: "read", label: "Read it" },
    ];
  }
  const out = [{ id: "summarize", label: "Summarize" }];
  if (hasBoard) out.push({ id: "board", label: "Put on a whiteboard" });
  return out;
}

function holdLabel(hold) {
  if (!hold) return "";
  if (hold.kind === "file") return hold.label || hold.name || "a file";
  if (hold.kind === "web") return hold.label || hold.domain || "a link";
  return hold.label || "text";
}

// ── tint: the body's colour, when it has one ────────────────────────────────

/** Eight companion hues; slot 0 (the resident body) is the warm gold. */
const SPIRIT_TINTS = Object.freeze([
  { name: "white", css: "#f4faff" }, // the default spirit is a soft white fairy (owner 2026-11-02)
  { name: "azure", css: "#7aa2ff" },
  { name: "mint", css: "#68e0b8" },
  { name: "orchid", css: "#c98cff" },
  { name: "coral", css: "#ff8f7a" },
  { name: "ice", css: "#8fd8ff" },
  { name: "lime", css: "#b6e36a" },
  { name: "rose", css: "#ff9ec4" },
]);

function hashText(s) {
  let h = 0;
  const str = String(s || "");
  for (let i = 0; i < str.length; i += 1) h = ((h << 5) - h + str.charCodeAt(i)) | 0;
  return Math.abs(h);
}

/**
 * A stable tint for a body. `preferred` (a css colour the avatar exposes) wins;
 * otherwise slot0 is the amber resident colour and every other slot hashes into
 * the palette, so the same body is the same colour on every trip.
 */
function tintFor(slotId, preferred = null) {
  if (typeof preferred === "string" && /^#[0-9a-f]{3,8}$/i.test(preferred.trim())) {
    return { name: "body", css: preferred.trim() };
  }
  const id = String(slotId == null ? "" : slotId);
  if (!id || id === "slot0" || id === "default") return SPIRIT_TINTS[0];
  return SPIRIT_TINTS[(hashText(id) % (SPIRIT_TINTS.length - 1)) + 1];
}

// ── misc for the window layer ───────────────────────────────────────────────

/** Keep a point's orb box fully on a work area (for "send home"). */
function clampOrbPoint(point, size, workArea) {
  const area = workArea || { x: 0, y: 0, width: 1920, height: 1080 };
  const w = num(size && size.width, 72);
  const h = num(size && size.height, 72);
  return {
    x: Math.round(Math.max(area.x + w / 2, Math.min(area.x + area.width - w / 2, num(point && point.x)))),
    y: Math.round(Math.max(area.y + h / 2, Math.min(area.y + area.height - h / 2, num(point && point.y)))),
  };
}

/** Shorten a path for a chip or a line: "…\Projects\notes.md". */
function shortenPath(p, max = 46) {
  const s = String(p == null ? "" : p);
  if (s.length <= max) return s;
  const name = baseName(s);
  const room = max - name.length - 3;
  return room > 4 ? `…${s.slice(-room)}` : `…${name.slice(-(max - 1))}`;
}

module.exports = {
  KINDS, ATTACH_KINDS, FILE_GROUPS, ROW_LIMIT, SPIRIT_TINTS, DROP_TEXT_MAX,
  parseArg, normalizeTrip, createTripQueue, enqueue, dequeue, finish, cancel, queueCount, queueLine,
  createTripLog, logTrip, logView,
  easeInOut, flightPath, pointAt, flightDurationMs, returnDurationMs,
  normBounds, containsPoint, pickAttachTarget, dockPosition, anchorFor, attachLabel,
  baseName, quote, captionFor, tripSummary,
  secretPathReason,
  fileRows, webRows, rowDomain, resultCountLine,
  holdFromFile, holdFromFiles, holdFromWeb, holdFromText, holdActions, holdLabel,
  tintFor, hashText, clampOrbPoint, shortenPath, orbitPoint, hoverOffset,
  _internal: { SECRET_RULES },
};
