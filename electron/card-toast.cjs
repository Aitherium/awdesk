"use strict";

/**
 * card-toast -- a decision card arrives as an ACTIONABLE toast, and never as a window.
 *
 * WHAT THIS REPLACES. A high|critical card used to call `openInbox(newest.id)` the
 * moment it landed (main.cjs announceDecisions): an always-on-top window taking focus
 * mid-keystroke. The owner's report -- "it pops out on its own" -- and the attention
 * plan (A1) both say the same thing: the card may ASK, the owner opens it.
 *
 * WHAT IT IS NOW. Windows gets a toast built with `toastXml` (Electron 39; unused in
 * the desk until now) carrying three buttons -- the card's own primary answer, Later,
 * Open. A button is `activationType="protocol"` with a `desk://card/answer` link, which
 * Windows hands back to the running Desk through the SAME protocol path every desk://
 * link uses (main.cjs handleProtocolUrl). main verifies the toast TICKET (a desk:// link
 * is reachable from any page; only the toast the desk showed carries one), re-reads the
 * card and routes the answer through `answerDeckCard`, so a signed card still opens the
 * Windows Hello window instead of recording an unsigned answer that approves nothing.
 *
 * ELSEWHERE (or unpackaged, where the desk:// handler is not registered) the toast is a
 * plain notification: title/body and a click that opens the card. No buttons are
 * invented for a platform that cannot deliver them.
 *
 * PURE: no electron, no fs. Every rule here is asserted under `node --test`.
 */

/** Most card toasts one announcement shows (a burst); the rest are the badge's
 *  and the tray's job. A backlog shows one (see main's announceDecisions). */
const notifyPolicy = require("./notify-policy.cjs");

const MAX_CARD_TOASTS = 3;
/** A toast action the card offers. Anything else is refused, not guessed. */
const ACTIONS = Object.freeze(["approve", "later", "open"]);
const DEFAULT_SCHEME = "desk";
/** Same grammar as signed-approval.readCardRaw: a toast argument is attacker-shaped
 *  input the moment it comes back through the protocol handler. */
const CARD_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
const TICKET_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{7,63}$/;
/** How long a toast's button stays usable (the toast itself lives in Action Center). */
const TICKET_TTL_MS = 10 * 60_000;
const TICKET_MAX = 200;

function isCardId(id) {
  return typeof id === "string" && CARD_ID_RE.test(id) && !id.includes("..");
}

function isOptionKey(key) {
  if (typeof key !== "string" || key.length === 0 || key.length > 64) return false;
  for (const ch of key) {
    const code = ch.charCodeAt(0);
    if (code < 32 || code === 127) return false;
  }
  return true;
}

/**
 * May a card toast be shown RIGHT NOW? The desk already has doors that quiet every
 * unsolicited surface, and a card toast is one: companion quiet mode (`quietUntil`,
 * set from the fairy's menu or the tray), now-mode, and Do not disturb. A held toast
 * is not lost -- the badge, the tray and the Inbox still carry the card; only the
 * popup waits.
 * @returns {{allow: boolean, reason: string}}
 */
function cardToastAllowed({ quietUntil = 0, now = Date.now(), doNotDisturb = false, nowMode = false } = {}) {
  if (nowMode) return { allow: false, reason: "now mode" };
  if (doNotDisturb) return { allow: false, reason: "do not disturb is on" };
  // Number() so a NaN/garbage deadline can never hold every toast forever.
  const until = Number(quietUntil);
  if (Number.isFinite(until) && until > Number(now)) return { allow: false, reason: "companion quiet mode" };
  return { allow: true, reason: "the desk may speak" };
}

/**
 * Can a toast carry BUTTONS? Windows (toastXml actions) and only packaged (the desk://
 * protocol handler is registered then). NEVER kid mode: kid mode routes every desk://
 * link to the classroom -- a child's desk must not show an Approve button whose link is
 * swallowed, and a child is not the one to answer a permission card.
 */
function canCarryActions({ platform = process.platform, packaged = false, kidMode = false } = {}) {
  if (kidMode) return false;
  return platform === "win32" && Boolean(packaged);
}

/**
 * The card's own primary answer -- `default_key`, else the recommended option, else the
 * first. Mirrors `primaryChoice` in src/deck/deck-types.ts (the Inbox's button) so a
 * toast and the Inbox never offer different answers for one card.
 * @returns {{key: string, label: string}|null}
 */
function primaryChoice(card) {
  const raw = card && Array.isArray(card.options) ? card.options : [];
  const options = raw
    .filter((o) => o && isOptionKey(o.key))
    .map((o) => ({
      key: o.key,
      label: String(typeof o.label === "string" && o.label ? o.label : o.key).slice(0, 40),
      recommended: Boolean(o.recommended),
    }));
  if (!options.length) return null;
  const byKey = (key) => options.find((o) => o.key === key) || null;
  const pick = (typeof card.defaultKey === "string" && byKey(card.defaultKey))
    || options.find((o) => o.recommended)
    || options[0];
  return { key: pick.key, label: pick.label };
}

/**
 * The desk:// link a toast button activates, or null when the arguments are not a
 * well-formed action on this card. `choice` rides only on an approve; `ticket` is the
 * one-shot-ish proof that the DESK showed this toast (see createTicketStore).
 */
function answerLink({ cardId, action, choice, ticket = "" } = {}, scheme = DEFAULT_SCHEME) {
  if (!isCardId(cardId)) return null;
  const act = String(action || "").trim().toLowerCase();
  if (!ACTIONS.includes(act)) return null;
  if (act === "approve" && !isOptionKey(choice)) return null;
  if (ticket && !TICKET_RE.test(String(ticket))) return null;
  const url = new URL(`${String(scheme || DEFAULT_SCHEME)}://card/answer`);
  url.searchParams.set("card", cardId);
  url.searchParams.set("action", act);
  if (act === "approve") url.searchParams.set("choice", choice);
  if (ticket) url.searchParams.set("ticket", String(ticket));
  return url.toString();
}

/** XML text/attribute escaping. Card titles are agent text: control characters that
 *  XML 1.0 forbids are dropped, everything else is escaped or the toast is refused. */
function escapeXml(value) {
  const text = String(value == null ? "" : value)
    // XML 1.0 leaves only TAB, LF and CR from the C0 range.
    .split("")
    .filter((ch) => {
      const code = ch.charCodeAt(0);
      return code >= 32 || code === 9 || code === 10 || code === 13;
    })
    .join("");
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/** The Windows toast XML: body click opens the card, one button per offered action. */
function cardToastXml({ cardId, title, body, approve, ticket = "" }, scheme = DEFAULT_SCHEME) {
  const open = answerLink({ cardId, action: "open", ticket }, scheme);
  const later = answerLink({ cardId, action: "later", ticket }, scheme);
  const approveLink = approve ? answerLink({ cardId, action: "approve", choice: approve.key, ticket }, scheme) : null;
  if (!open || !later) return null;
  const actions = [];
  if (approveLink) {
    actions.push(`<action content="${escapeXml(approve.label)}" activationType="protocol" arguments="${escapeXml(approveLink)}" />`);
  }
  actions.push(`<action content="Later" activationType="protocol" arguments="${escapeXml(later)}" />`);
  actions.push(`<action content="Open" activationType="protocol" arguments="${escapeXml(open)}" />`);
  return [
    '<?xml version="1.0" encoding="utf-8"?>',
    `<toast launch="${escapeXml(open)}" activationType="protocol">`,
    "  <visual>",
    '    <binding template="ToastGeneric">',
    `      <text>${escapeXml(title)}</text>`,
    `      <text>${escapeXml(body)}</text>`,
    "    </binding>",
    "  </visual>",
    "  <actions>",
    ...actions.map((line) => `    ${line}`),
    "  </actions>",
    "</toast>",
  ].join("\n");
}

/**
 * One card as a toast description.
 * @param {object} card  a shaped card (decision-cards.cardFromRaw)
 * @param {{scheme?: string, actionable?: boolean, ticket?: string}} [opts]
 *   `actionable`: this platform can carry buttons (Windows, and the desk:// handler is
 *   registered). `ticket`: proof, minted by the desk when it showed this toast, that
 *   the button came from it and not from a page that guessed a desk:// link.
 */
function buildCardToast(card, { scheme = DEFAULT_SCHEME, actionable = false, ticket = "", policy = null } = {}) {
  if (!card || !isCardId(card.id)) return null;
  // The ONE message shape (notify-policy.cjs, owner 2026-11-18): a <=60 char sentence
  // title never cut mid-word, an "If you approve:" body, no line repeating the title.
  const { title, body } = notifyPolicy.shape(card, policy || notifyPolicy.readPolicy());
  const approve = primaryChoice(card);
  const actions = [];
  if (approve) actions.push({ action: "approve", label: approve.label, choice: approve.key });
  actions.push({ action: "later", label: "Later" });
  actions.push({ action: "open", label: "Open" });
  return {
    cardId: card.id,
    title,
    body,
    actions,
    // Buttons are only worth building when the desk can deliver AND verify them:
    // an actionable toast with no ticket could not be told from a guessed link.
    ticket: TICKET_RE.test(String(ticket || "")) ? String(ticket) : "",
    toastXml: actionable && TICKET_RE.test(String(ticket || ""))
      ? cardToastXml({ cardId: card.id, title, body, approve, ticket }, scheme)
      : null,
  };
}

/**
 * The tickets behind a toast's buttons. A desk:// link is reachable from any page
 * that names it, and this one can answer a card that spends money or grants a
 * permission, so a button must prove the DESK showed that toast: the XML carries a
 * ticket minted here, and the protocol handler refuses an action without a live one.
 * TTL-bounded (a toast in Action Center outlives the window it came from) and capped.
 * @param {{ttlMs?: number, max?: number, now?: () => number, random?: () => string}} [opts]
 */
function createTicketStore({
  ttlMs = TICKET_TTL_MS, max = TICKET_MAX, now = Date.now,
  random = () => require("node:crypto").randomUUID(),
} = {}) {
  const tickets = new Map(); // ticket -> {cardId, at}
  function prune(at) {
    for (const [key, entry] of tickets) {
      if (at - entry.at > ttlMs) tickets.delete(key);
    }
  }
  /** A ticket for `cardId`, or "" when the id is not a card id. */
  function mint(cardId) {
    if (!isCardId(cardId)) return "";
    const at = now();
    prune(at);
    while (tickets.size >= max) tickets.delete(tickets.keys().next().value);
    let ticket = String(random() || "");
    while (!TICKET_RE.test(ticket) || tickets.has(ticket)) ticket = String(random() || "");
    tickets.set(ticket, { cardId, at });
    return ticket;
  }
  /** Does `ticket` name a live toast for exactly this card? */
  function verify(ticket, cardId) {
    if (typeof ticket !== "string" || !TICKET_RE.test(ticket) || !isCardId(cardId)) return false;
    const entry = tickets.get(ticket);
    if (!entry) return false;
    if (now() - entry.at > ttlMs) {
      tickets.delete(ticket);
      return false;
    }
    return entry.cardId === cardId;
  }
  return { mint, verify, size: () => tickets.size };
}

/**
 * What ONE card arrival does: show a toast, and nothing else. There is deliberately no
 * `openInbox` in here -- that is the whole point of the slice, and the test asserts it.
 * @param {object[]} cards  shaped cards, newest/best first
 * @param {{notify: (toast: object) => void, mintTicket?: (card: object) => string,
 *          actionable?: boolean, scheme?: string, max?: number,
 *          log?: (line: string) => void}} deps
 * @returns {{shown: number, autoOpen: false}}
 */
function announceCards(cards, {
  notify, mintTicket, actionable = false, scheme = DEFAULT_SCHEME, max = MAX_CARD_TOASTS, log = () => {},
} = {}) {
  const list = Array.isArray(cards) ? cards.filter(Boolean) : [];
  const limit = Number.isFinite(max) && max >= 0 ? max : MAX_CARD_TOASTS;
  let shown = 0;
  for (const card of list) {
    if (shown >= limit) break;
    let ticket = "";
    if (actionable && typeof mintTicket === "function") {
      try {
        ticket = String(mintTicket(card) || "");
      } catch (error) {
        log(`card toast ticket failed: ${error && error.message}`);
      }
    }
    const toast = buildCardToast(card, { scheme, actionable, ticket });
    if (!toast || typeof notify !== "function") continue;
    try {
      notify(toast);
      shown += 1;
    } catch (error) {
      log(`card toast failed: ${error && error.message}`);
    }
  }
  return { shown, autoOpen: false };
}

/**
 * One toast action coming back from Windows. The caller re-reads the card, so a stale
 * toast (the card was answered elsewhere, or its options changed) can never answer
 * something the card no longer offers: that case opens the card instead of guessing.
 *
 * @param {{cardId: string, action: string, choice?: string, card?: object|null,
 *          answer?: Function, open?: Function, snooze?: Function,
 *          log?: Function}} deps  `answer` is main's answerDeckCard (the signed route).
 * @returns {{ok: boolean, reason?: string, opened?: boolean, snoozed?: boolean,
 *            via?: string, result?: any}}
 */
function dispatchCardAction({
  cardId, action, choice = "", card = null,
  answer, open, snooze, log = () => {},
} = {}) {
  if (!isCardId(cardId)) return { ok: false, reason: "unknown card" };
  const act = String(action || "").trim().toLowerCase();
  if (!ACTIONS.includes(act)) return { ok: false, reason: "unknown action" };
  if (act === "open") {
    if (typeof open === "function") open(cardId);
    return { ok: true, opened: true };
  }
  if (act === "later") {
    const ok = typeof snooze === "function" ? snooze(cardId) !== false : false;
    if (!ok) log(`[card-toast] ${cardId}: could not snooze`);
    return { ok, snoozed: ok };
  }
  // approve: the choice must STILL be one of this card's own options.
  const options = card && Array.isArray(card.options) ? card.options : [];
  const valid = isOptionKey(choice) && options.some((o) => o && String(o.key) === choice);
  if (!valid) {
    log(`[card-toast] ${cardId}: stale approve (${choice || "no choice"}) -- opening the card instead`);
    if (typeof open === "function") open(cardId);
    return { ok: false, reason: "stale", opened: true };
  }
  if (typeof answer !== "function") return { ok: false, reason: "no answer path" };
  const result = answer(cardId, choice);
  return { ok: result !== false, via: "answer", result };
}

module.exports = {
  MAX_CARD_TOASTS,
  ACTIONS,
  DEFAULT_SCHEME,
  TICKET_TTL_MS,
  isCardId,
  isOptionKey,
  cardToastAllowed,
  canCarryActions,
  primaryChoice,
  answerLink,
  escapeXml,
  cardToastXml,
  buildCardToast,
  createTicketStore,
  announceCards,
  dispatchCardAction,
};
