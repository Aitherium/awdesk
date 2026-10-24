"use strict";

/**
 * house-posture -- the fleet's HOUSE posture and its on-demand wake groups, in the tray.
 *
 * Owner, 2026-10-24: "MAKE IT FUCKING EASY FOR ME TO SEE AND MANAGE ... i should see this
 * everywhere i interact". The phone card (Veil, src/lib/posture-client.ts) already shows it;
 * this is the same view for the Desk tray: the posture WORD with a coloured dot on the tray
 * icon and in the tooltip, a Posture submenu that flips it, and one row per group (darkmatter,
 * garg, dgg, shop, vibe) that wakes or sleeps it.
 *
 * Not to be confused with desk-posture.cjs (owner vs customer Desk) or game-posture.cjs
 * (Desk standing down while "Game on" holds). This file only READS and ASKS.
 *
 * CONTRACT: the ONLY transport is gateway-mcp.cjs (the session bearer, 127.0.0.1:8182). The
 * rules live in the gateway tools, owner only:
 *
 *   fleet_posture_status            -> {ok, label, posture, surfaces, gpu?, next?, error?}
 *   fleet_posture_set {word,until?} -> {ok, word, label, pending?, error?}
 *   fleet_group_status {}           -> {ok, groups: {name: {units, doors, summary}}}
 *   fleet_group_status {name}       -> {group, ok, up, state, units, eta_s, idle_s, ...}
 *   fleet_group_wake {name}         -> {ok, group, state: awake|starting, eta_s?, error?}
 *   fleet_group_park {name}         -> "Sleep" (newer gateways; an absent tool says so)
 *
 * The labels are the phone's, word for word (POSTURE_LABELS mirrors posture-client.ts and
 * mcp_fleet_posture.LABELS). A failure is never a posture: an unanswered read is "unknown".
 * Pure core with an injected `call`, so tests need no gateway.
 */

const POSTURE_WORDS = Object.freeze(["shop", "after", "game", "dark", "auto"]);
const POSTURE_LABELS = Object.freeze({
  shop: "Shop open",
  after: "After hours",
  game: "Game on",
  dark: "Dark",
  auto: "On schedule",
});
/** The order the groups are listed in when the gateway names them; others follow, sorted. */
const GROUP_ORDER = Object.freeze(["darkmatter", "garg", "dgg", "shop", "vibe"]);
/** Dot colours (BGRA-friendly {r,g,b}); `unknown` is red -- the house did not answer. */
const DOT_COLORS = Object.freeze({
  shop: { r: 0x30, g: 0xa4, b: 0x6c },   // green: open for business
  after: { r: 0xf5, g: 0xa5, b: 0x24 },  // amber
  game: { r: 0x8e, g: 0x4e, b: 0xc6 },   // purple: the PC is yours
  dark: { r: 0x5b, g: 0x6b, b: 0x82 },   // slate: only the wake core
  auto: { r: 0x3e, g: 0x63, b: 0xdd },   // blue: following the schedule
  unknown: { r: 0xe5, g: 0x48, b: 0x4d },
});
const CACHE_MS = 30 * 1000;
const NOT_DEPLOYED_RE = /unknown tool|tool[^.\n]{0,40}not (?:found|registered|available)|no such tool|method not found|not deployed/i;
const SLEEP_NOT_DEPLOYED = "Sleep not available yet on this gateway";

function isRecord(v) {
  return Boolean(v) && typeof v === "object" && !Array.isArray(v);
}

function parse(raw) {
  if (isRecord(raw)) return raw;
  try {
    const v = JSON.parse(String(raw || ""));
    return isRecord(v) ? v : null;
  } catch {
    return null;
  }
}

function errText(error) {
  return String((error && error.message) || error || "no answer");
}

/** "Dark" -> "dark"; anything else -> "unknown". */
function wordForLabel(label) {
  const want = String(label || "").trim().toLowerCase();
  return POSTURE_WORDS.find((w) => POSTURE_LABELS[w].toLowerCase() === want) || "unknown";
}

/** The word the house is in: the label the tool gave, else posture.applied/desired. */
function postureWord(doc) {
  if (!isRecord(doc)) return "unknown";
  const fromLabel = wordForLabel(doc.label);
  if (fromLabel !== "unknown") return fromLabel;
  const p = isRecord(doc.posture) ? doc.posture : {};
  for (const key of ["applied", "desired", "posture"]) {
    let v = p[key];
    if (isRecord(v)) v = v.word || v.name;
    if (typeof v === "string" && POSTURE_WORDS.includes(v.toLowerCase())) return v.toLowerCase();
  }
  return "unknown";
}

/** A group's one word: awake | asleep | waking | failed | unknown. */
function groupState(st) {
  if (!isRecord(st)) return "unknown";
  const units = isRecord(st.units) ? Object.values(st.units) : [];
  if (st.state === "waking" || units.includes("waking")) return "waking";
  if (st.up === true) return "awake";
  if (st.ok === false || st.up == null) return "unknown";
  if (st.state === "failed") return "failed";
  return "asleep";
}

function orderGroups(names) {
  const known = GROUP_ORDER.filter((n) => names.includes(n));
  const rest = names.filter((n) => !GROUP_ORDER.includes(n)).sort();
  return [...known, ...rest];
}

/**
 * The client. `call(name, args)` resolves the tool's text (gateway-mcp.callTool).
 * read() -> {ok, word, label, problem, groups:[{name, summary, state, etaS, idleS}]}; never throws.
 */
function createHousePostureClient({ call, now = () => Date.now(), cacheMs = CACHE_MS } = {}) {
  if (typeof call !== "function") throw new TypeError("house-posture: call is required");
  let cached = null; // {at, value}
  let inflight = null;

  async function readGroups() {
    const list = parse(await call("fleet_group_status", {}));
    if (!list || list.ok === false) throw new Error((list && list.error) || "no group list");
    const names = orderGroups(Object.keys(isRecord(list.groups) ? list.groups : {}));
    return Promise.all(names.map(async (name) => {
      const meta = list.groups[name] || {};
      // One group that does not answer is "?" in its row, never a failed menu.
      const st = await call("fleet_group_status", { name }).then(parse, () => null);
      return {
        name,
        summary: String((st && st.summary) || meta.summary || ""),
        state: groupState(st),
        etaS: st && Number.isFinite(Number(st.eta_s)) ? Number(st.eta_s) : null,
        idleS: st && Number.isFinite(Number(st.idle_s)) ? Number(st.idle_s) : null,
      };
    }));
  }

  async function fetchOnce() {
    let doc = null;
    let problem = "";
    try {
      doc = parse(await call("fleet_posture_status", {}));
      if (!doc) problem = "The house did not answer.";
      else if (typeof doc.error === "string") problem = doc.error;
    } catch (error) {
      problem = errText(error);
    }
    let groups = [];
    let groupsProblem = "";
    try {
      groups = await readGroups();
    } catch (error) {
      groupsProblem = errText(error);
    }
    const word = postureWord(doc);
    return {
      ok: word !== "unknown",
      word,
      label: word === "unknown" ? "unknown" : POSTURE_LABELS[word],
      problem,
      groups,
      groupsProblem,
    };
  }

  async function read({ fresh = false } = {}) {
    if (!fresh && cached && now() - cached.at < cacheMs) return cached.value;
    if (inflight) return inflight;
    inflight = fetchOnce().then((value) => {
      cached = { at: now(), value };
      inflight = null;
      return value;
    });
    return inflight;
  }

  async function act(tool, args, okText) {
    cached = null; // the next read must see the change
    try {
      const doc = parse(await call(tool, args));
      if (!doc) return { ok: false, message: "The house did not answer." };
      if (doc.ok !== true) return { ok: false, message: String(doc.error || "The house refused.") };
      return { ok: true, message: okText(doc) };
    } catch (error) {
      const msg = errText(error);
      return { ok: false, message: tool === "fleet_group_park" && NOT_DEPLOYED_RE.test(msg) ? SLEEP_NOT_DEPLOYED : msg };
    }
  }

  return {
    read,
    clear: () => { cached = null; },
    /** Flip the house. Refuses an unknown word before any call. */
    setPosture: (word, until = "") => {
      const w = String(word || "").trim().toLowerCase();
      if (!POSTURE_WORDS.includes(w)) return Promise.resolve({ ok: false, message: `Not a posture: ${word}` });
      const args = until ? { word: w, until } : { word: w };
      return act("fleet_posture_set", args, (d) => (d.pending
        ? `${POSTURE_LABELS[w]}: still applying`
        : `House is now ${POSTURE_LABELS[w]}`));
    },
    wake: (name) => act("fleet_group_wake", { name }, (d) => (d.state === "awake"
      ? `${name} is already awake`
      : `${name} is waking up${d.eta_s ? ` -- about ${d.eta_s} s` : ""}`)),
    sleep: (name) => act("fleet_group_park", { name }, () => `${name} is going to sleep`),
  };
}

// ── rendering ────────────────────────────────────────────────────────────────

const STATE_WORDS = { awake: "awake", asleep: "asleep", waking: "waking", failed: "failed", unknown: "?" };

/** "House: Dark" for the tooltip; "" before the first read. */
function houseTooltipLine(view) {
  if (!view) return "";
  return `House: ${view.label}`;
}

/**
 * The tray rows: a header ("● House: Dark"), a Posture submenu (radio, the current word
 * checked), then one row per group that does the obvious thing -- an asleep group's row
 * wakes it, an awake group's row puts it to sleep. `actions` = {setPosture, wake, sleep, open?}.
 */
function housePostureTrayItems(view, actions = {}) {
  const header = view
    ? `● House: ${view.label}${view.problem && view.ok ? " (!)" : ""}`
    : "● House: checking…";
  const rows = [{ label: header, enabled: typeof actions.open === "function", click: () => actions.open && actions.open() }];
  if (view && !view.ok && view.problem) rows.push({ label: `   ${view.problem.slice(0, 80)}`, enabled: false });
  rows.push({
    label: "Posture",
    submenu: POSTURE_WORDS.map((w) => ({
      label: POSTURE_LABELS[w],
      type: "radio",
      checked: Boolean(view) && view.word === w,
      click: () => actions.setPosture && actions.setPosture(w),
    })),
  });
  const groups = (view && view.groups) || [];
  for (const g of groups) {
    const st = STATE_WORDS[g.state] || "?";
    if (g.state === "awake") {
      rows.push({ label: `   ${g.name}: ${st} -- Sleep`, click: () => actions.sleep && actions.sleep(g.name) });
    } else if (g.state === "waking") {
      rows.push({ label: `   ${g.name}: waking${g.etaS ? ` (~${g.etaS} s)` : ""}`, enabled: false });
    } else {
      rows.push({ label: `   ${g.name}: ${st} -- Wake`, click: () => actions.wake && actions.wake(g.name) });
    }
  }
  if (view && !groups.length && view.groupsProblem) {
    rows.push({ label: `   Groups: ${view.groupsProblem.slice(0, 70)}`, enabled: false });
  }
  rows.push({ type: "separator" });
  return rows;
}

/**
 * Draw the posture dot into a BGRA bitmap in place: top-LEFT corner (the inbox badge owns
 * bottom-right), white rim so it reads on a dark or light taskbar. Returns the word drawn.
 */
function drawPostureDot(pixels, width, height, word, { diameter } = {}) {
  const color = DOT_COLORS[word] || DOT_COLORS.unknown;
  const d = Math.max(5, Math.min(diameter || Math.round(Math.min(width, height) * 0.42), width, height));
  const r = d / 2;
  const c = (d - 1) / 2;
  for (let y = 0; y < d; y += 1) {
    for (let x = 0; x < d; x += 1) {
      const dist2 = (x - c) * (x - c) + (y - c) * (y - c);
      if (dist2 > r * r) continue;
      const rim = dist2 > (r - 1) * (r - 1);
      const i = (y * width + x) * 4;
      pixels[i] = rim ? 0xff : color.b;
      pixels[i + 1] = rim ? 0xff : color.g;
      pixels[i + 2] = rim ? 0xff : color.r;
      pixels[i + 3] = 0xff;
    }
  }
  return DOT_COLORS[word] ? word : "unknown";
}

module.exports = {
  CACHE_MS,
  DOT_COLORS,
  GROUP_ORDER,
  POSTURE_LABELS,
  POSTURE_WORDS,
  SLEEP_NOT_DEPLOYED,
  createHousePostureClient,
  drawPostureDot,
  groupState,
  houseTooltipLine,
  housePostureTrayItems,
  postureWord,
  wordForLabel,
};
