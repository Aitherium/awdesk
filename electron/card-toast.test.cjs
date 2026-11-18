"use strict";

/**
 * card-toast -- the A1 contract, asserted where it can fail:
 *
 *   - a card arrival is a TOAST and never a window (announceCards has no openInbox);
 *   - a toast button carries the card id and the card's OWN choice, and dispatch
 *     reaches the injected answer (main wires that to answerDeckCard, asserted below);
 *   - a stale toast opens the card instead of answering something it no longer offers;
 *   - a non-Windows/unpackaged desk gets a plain toast, never invented buttons.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const ct = require("./card-toast.cjs");
const sa = require("./signed-approval.cjs");

/** A shaped card as decision-cards.cardFromRaw builds one. */
function card(overrides = {}) {
  return {
    id: "d-test",
    title: "Approve the deploy?",
    summary: "Two files, no migrations.",
    urgency: "high",
    options: [
      { key: "approve", label: "Approve", recommended: true },
      { key: "deny", label: "Deny", recommended: false },
    ],
    defaultKey: "",
    ...overrides,
  };
}

test("an actionable card gets Approve / Later / Open, and the toast body opens the card", () => {
  const toast = ct.buildCardToast(card(), { actionable: true, ticket: "tkt-1234567" });
  assert.equal(toast.cardId, "d-test");
  assert.deepEqual(toast.actions.map((a) => a.action), ["approve", "later", "open"]);
  assert.equal(toast.actions[0].choice, "approve", "the card's own recommended choice");
  assert.equal(toast.actions[0].label, "Approve");
  const xml = toast.toastXml;
  assert.match(xml, /<toast launch="desk:\/\/card\/answer\?card=d-test&amp;action=open&amp;ticket=tkt-1234567" activationType="protocol">/);
  assert.equal((xml.match(/<action /g) || []).length, 3);
  assert.match(xml, /arguments="desk:\/\/card\/answer\?card=d-test&amp;action=approve&amp;choice=approve&amp;ticket=tkt-1234567"/);
  assert.match(xml, /arguments="desk:\/\/card\/answer\?card=d-test&amp;action=later&amp;ticket=tkt-1234567"/);
});

test("an actionable toast with no ticket carries no buttons (fail closed)", () => {
  const toast = ct.buildCardToast(card(), { actionable: true });
  assert.equal(toast.toastXml, null);
  assert.equal(toast.ticket, "");
});

test("without actionable platform support the toast is plain -- no invented buttons", () => {
  const toast = ct.buildCardToast(card());
  assert.equal(toast.toastXml, null);
  assert.equal(toast.title, "Approve the deploy?");
  assert.equal(toast.body, "Two files, no migrations.");
  assert.equal(toast.actions.length, 3, "the description still says what the card offers");
});

test("a card with no options (credential) offers Later and Open only", () => {
  const toast = ct.buildCardToast(card({ kind: "credential", options: [] }), { actionable: true, ticket: "tkt-1234567" });
  assert.deepEqual(toast.actions.map((a) => a.action), ["later", "open"]);
  assert.equal((toast.toastXml.match(/<action /g) || []).length, 2);
});

test("card text is XML-escaped and control characters are dropped", () => {
  const toast = ct.buildCardToast(
    card({ title: 'A & B <tag> "q" \u0007', summary: "x > y" }),
    { actionable: true, ticket: "tkt-1234567" },
  );
  assert.match(toast.toastXml, /A &amp; B &lt;tag&gt; &quot;q&quot; /);
  assert.equal(toast.toastXml.includes("\u0007"), false, "the control character is dropped");
  assert.match(toast.toastXml, /x &gt; y/);
});

test("the primary choice is the card's default_key, then recommended, then the first", () => {
  const options = [
    { key: "a", label: "A" },
    { key: "b", label: "B", recommended: true },
    { key: "c", label: "C" },
  ];
  assert.equal(ct.primaryChoice({ options, defaultKey: "c" }).key, "c");
  assert.equal(ct.primaryChoice({ options }).key, "b");
  assert.equal(ct.primaryChoice({ options: [{ key: "only", label: "Only" }] }).key, "only");
  assert.equal(ct.primaryChoice({ options: [] }), null);
});

test("an arrival shows a toast and NEVER opens the Inbox", () => {
  const shown = [];
  let opened = 0;
  const tickets = ct.createTicketStore();
  const r = ct.announceCards([card({ urgency: "critical" })], {
    actionable: true,
    mintTicket: (c) => tickets.mint(c.id),
    notify: (t) => shown.push(t),
    // Deliberately passed to prove it is not called -- the spy is the failure signal.
    openInbox: () => { opened += 1; },
  });
  assert.deepEqual(r, { shown: 1, autoOpen: false });
  assert.equal(shown.length, 1);
  assert.equal(shown[0].toastXml !== null, true, "the arrived toast is actionable");
  assert.equal(opened, 0, "nothing may open a window on arrival");
});

test("a toast's ticket is proof the DESK showed it: wrong card, expired and absent all fail", () => {
  let t = 1_000;
  let n = 0;
  const tickets = ct.createTicketStore({ ttlMs: 5_000, now: () => t, random: () => `ticket-${(n += 1)}0000` });
  const mine = tickets.mint("d-1");
  assert.equal(mine, "ticket-10000");
  assert.equal(tickets.verify(mine, "d-1"), true);
  assert.equal(tickets.verify(mine, "d-2"), false, "a ticket for another card never matches");
  assert.equal(tickets.verify("ticket-99999", "d-1"), false, "an invented ticket never matches");
  assert.equal(tickets.verify("", "d-1"), false);
  assert.equal(tickets.verify(undefined, "d-1"), false);
  t += 5_001;
  assert.equal(tickets.verify(mine, "d-1"), false, "expired");
  assert.equal(tickets.size(), 0, "expiry prunes");
  assert.equal(tickets.mint("../etc/passwd"), "", "only a card id gets a ticket");
});

test("the ticket store is capped", () => {
  let n = 0;
  const tickets = ct.createTicketStore({ max: 2, random: () => `ticket-${(n += 1)}0000` });
  const first = tickets.mint("d-1");
  tickets.mint("d-1");
  tickets.mint("d-1");
  assert.equal(tickets.size(), 2);
  assert.equal(tickets.verify(first, "d-1"), false, "the oldest ticket was evicted");
});

test("a backlog announces at most one card, a burst at most three", () => {
  const many = Array.from({ length: 10 }, (_, i) => card({ id: `d-${i}` }));
  let n = 0;
  ct.announceCards(many, { notify: () => { n += 1; } });
  assert.equal(n, 3);
  n = 0;
  ct.announceCards(many, { notify: () => { n += 1; }, max: 1 });
  assert.equal(n, 1);
});

test("a notify that throws is logged, not thrown, and does not stop the rest", () => {
  const lines = [];
  let n = 0;
  const r = ct.announceCards([card({ id: "d-1" }), card({ id: "d-2" })], {
    notify: () => { n += 1; throw new Error("boom"); },
    log: (l) => lines.push(l),
  });
  assert.equal(n, 2);
  assert.equal(r.shown, 0);
  assert.deepEqual(lines, ["card toast failed: boom", "card toast failed: boom"]);
});

test("a toast action reaches the answer with the card id and the card's choice", () => {
  const calls = [];
  const r = ct.dispatchCardAction({
    cardId: "d-test",
    action: "approve",
    choice: "approve",
    card: card(),
    answer: (id, choice) => { calls.push([id, choice]); return true; },
    open: () => { throw new Error("must not open on a valid approve"); },
  });
  assert.deepEqual(calls, [["d-test", "approve"]]);
  assert.equal(r.ok, true);
  assert.equal(r.via, "answer");
});

test("a signed card's Approve still routes to the passkey window (signed-approval decides)", () => {
  // dispatch passes the id+choice to the injected answer; main wires that to
  // answerDeckCard, which asks signed-approval for the route. This pins both halves.
  const raw = {
    id: "d-signed",
    status: "open",
    kind: "decision",
    facts: ["permission_rule: Bash(rm:*)"],
    options: [{ key: "approve", label: "Approve" }],
  };
  const routed = [];
  const r = ct.dispatchCardAction({
    cardId: "d-signed",
    action: "approve",
    choice: "approve",
    card: card({ id: "d-signed", options: [{ key: "approve", label: "Approve", recommended: true }] }),
    answer: (id, choice) => {
      const route = sa.answerRoute(raw, choice);
      routed.push(route);
      return route === "window" ? { pending: true, via: "approve-window" } : true;
    },
  });
  assert.deepEqual(routed, ["window"]);
  assert.deepEqual(r.result, { pending: true, via: "approve-window" });
});

test("a stale toast never answers: the card is opened instead", () => {
  let answered = 0;
  let opened = 0;
  const r = ct.dispatchCardAction({
    cardId: "d-test",
    action: "approve",
    choice: "yes-please", // not one of this card's options any more
    card: card({ options: [{ key: "approve", label: "Approve" }] }),
    answer: () => { answered += 1; return true; },
    open: () => { opened += 1; },
  });
  assert.equal(answered, 0);
  assert.equal(opened, 1);
  assert.deepEqual({ ok: r.ok, reason: r.reason, opened: r.opened }, { ok: false, reason: "stale", opened: true });
});

test("a card that is gone, or a malformed link, is refused", () => {
  const calls = [];
  const deps = { answer: (...a) => { calls.push(a); return true; }, open: () => {}, snooze: () => true };
  assert.equal(ct.dispatchCardAction({ ...deps, cardId: "../etc/passwd", action: "approve", choice: "x", card: card() }).ok, false);
  assert.equal(ct.dispatchCardAction({ ...deps, cardId: "d-test", action: "delete", card: card() }).ok, false);
  assert.equal(ct.dispatchCardAction({ ...deps, cardId: "d-test", action: "approve", choice: "approve", card: null }).ok, false);
  assert.deepEqual(calls, [], "nothing answered");
});

test("Open opens the card; Later snoozes it and answers nothing", () => {
  const events = [];
  const deps = {
    cardId: "d-test",
    card: card(),
    answer: () => events.push("answer"),
    open: () => events.push("open"),
    snooze: () => { events.push("snooze"); return true; },
  };
  assert.equal(ct.dispatchCardAction({ ...deps, action: "open" }).opened, true);
  const later = ct.dispatchCardAction({ ...deps, action: "later" });
  assert.equal(later.ok, true);
  assert.equal(later.snoozed, true);
  assert.deepEqual(events, ["open", "snooze"]);
});

test("the answer link is built and rejected by one rule, shared with the parser", () => {
  assert.equal(
    ct.answerLink({ cardId: "d-1", action: "approve", choice: "yes" }),
    "desk://card/answer?card=d-1&action=approve&choice=yes",
  );
  assert.equal(
    ct.answerLink({ cardId: "d-1", action: "open", ticket: "tkt-1234567" }),
    "desk://card/answer?card=d-1&action=open&ticket=tkt-1234567",
  );
  assert.equal(ct.answerLink({ cardId: "d-1", action: "open", ticket: "bad ticket!" }), null);
  assert.equal(ct.answerLink({ cardId: "d-1", action: "approve" }), null, "approve needs a choice");
  assert.equal(ct.answerLink({ cardId: "", action: "open" }), null);
  assert.equal(ct.answerLink({ cardId: "d-1", action: "rm" }), null);
  assert.equal(ct.answerLink({ cardId: "a/b", action: "open" }), null);
});

// ── the desk's quiet doors, and kid mode ─────────────────────────────────────

test("cardToastAllowed: companion quiet mode, now-mode and DND each HOLD the toast", () => {
  const now = 1_000_000;
  assert.equal(ct.cardToastAllowed({ now }).allow, true, "the ordinary case speaks");
  // The fairy's "be quiet until ..." (orbWindow.quietUntil) is an unsolicited-surface
  // door like any other: a card toast waits while it is live, and speaks again after.
  const quiet = ct.cardToastAllowed({ now, quietUntil: now + 60_000 });
  assert.equal(quiet.allow, false);
  assert.match(quiet.reason, /quiet/);
  assert.equal(ct.cardToastAllowed({ now, quietUntil: now - 1 }).allow, true, "an expired quiet window is over");
  assert.equal(ct.cardToastAllowed({ now, doNotDisturb: true }).allow, false);
  assert.equal(ct.cardToastAllowed({ now, nowMode: true }).allow, false);
  // Garbage must not silence the desk forever: a NaN/Infinity deadline is not a hold.
  assert.equal(ct.cardToastAllowed({ now, quietUntil: "not a time" }).allow, true);
  assert.equal(ct.cardToastAllowed({ now, quietUntil: Infinity }).allow, true);
});

test("canCarryActions: Windows + packaged only, and NEVER kid mode", () => {
  assert.equal(ct.canCarryActions({ platform: "win32", packaged: true }), true);
  assert.equal(ct.canCarryActions({ platform: "win32", packaged: false }), false, "unpackaged: no desk:// handler");
  assert.equal(ct.canCarryActions({ platform: "darwin", packaged: true }), false);
  assert.equal(ct.canCarryActions({ platform: "linux", packaged: true }), false);
  // Kid mode routes every desk:// link to the classroom, so an Approve button would be
  // swallowed (and a child is not who answers a permission card): no buttons at all.
  assert.equal(ct.canCarryActions({ platform: "win32", packaged: true, kidMode: true }), false);
});

test("a kid-mode toast is a plain toast: no buttons, and no ticket to mint", () => {
  const actionable = ct.canCarryActions({ platform: "win32", packaged: true, kidMode: true });
  const toast = ct.buildCardToast(card(), { actionable, ticket: "tkt-1234567" });
  assert.equal(toast.toastXml, null, "no toastXml means no protocol buttons to swallow");
  assert.deepEqual(toast.actions.map((a) => a.action), ["approve", "later", "open"], "the descriptor is unchanged");
});

test("main: kid mode removes the buttons, quiet mode holds the toast", () => {
  const src = fs.readFileSync(path.join(__dirname, "main.cjs"), "utf8");
  const actionsAt = src.indexOf("function toastActionsAvailable(");
  assert.ok(actionsAt >= 0);
  const actions = src.slice(actionsAt, src.indexOf("\n}", actionsAt));
  assert.match(actions, /cardToast\.canCarryActions\(/);
  assert.match(actions, /kidMode:\s*kidDeskMode\(\)\.enabled/, "kid mode is asked, not assumed");
  // announceDecisions must check the companion quiet door, not only DND.
  const at = src.indexOf("const announceDecisions = (list, isBacklog");
  const end = src.indexOf("let decisionsAnnounced", at);
  const announce = src.slice(at, end);
  assert.match(announce, /orbWindow\.quietUntil\(\)/);
  assert.match(announce, /cardToast\.cardToastAllowed\(/);
  assert.match(announce, /\bverdict\.allow\b/);
});

test("main wires the toast action through answerDeckCard, the ONE answer path", () => {
  const src = fs.readFileSync(path.join(__dirname, "main.cjs"), "utf8");
  // The signed route lives in answerDeckCard; an unsigned decisionCards.answerCard
  // here would record an approval that approves nothing.
  assert.match(src, /answer: \(id, choice\) => answerDeckCard\(id, choice/);
  assert.match(src, /else if \(command\.type === "card-answer"\) handleCardToastAnswer\(command\);/);
  assert.match(src, /cardToast\.announceCards\(/);
  // A desk:// link is reachable from any page: the ticket check must come FIRST.
  const at = src.indexOf("function handleCardToastAnswer(");
  const body = src.slice(at, src.indexOf("\n}", at));
  const verifyAt = body.indexOf("cardTickets.verify(");
  const dispatchAt = body.indexOf("dispatchCardAction(");
  assert.ok(verifyAt > 0 && dispatchAt > verifyAt, "the ticket is verified before anything is dispatched");
  // A dead ticket still OPENS the card: the ticket gates ANSWERS, never
  // navigation (Action Center outlives the TTL, and a restart clears the store).
  assert.match(body, /action === "open" && cardToast\.isCardId\(cardId\)[\s\S]*?openInbox\(cardId\)/);
  assert.match(body, /reason: "unknown ticket"/, "an answer with no live ticket is still refused");
});
