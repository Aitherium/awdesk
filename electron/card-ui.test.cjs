"use strict";
/**
 * card-ui.cjs: a decision card's generated UI (A2UI v0.9) is drawn only when it
 * is current and binds to the card's own options; everything else falls back.
 */
const test = require("node:test");
const assert = require("node:assert/strict");

const cardUi = require("./card-ui.cjs");
const decisionCards = require("./decision-cards.cjs");

// Produced by awdk `adk.decisions.card_ui` (Aitherium/AitherOS #15477) on
// 2026-11-08: `compile_default(card)` attached as card["ui"], and
// `card_hash(card)` = PY_HASH. Quotes, a trailing newline, NBSP padding, a
// control char, CJK, an astral emoji and a backslash pin the byte-exact port.
const PY_CARD = {"id": "d-vec1", "status": "open", "kind": "decision", "title": "  Ship \"awdesk\" 0.9?\n", "summary": "Caf\u00e9 \u2014 r\u00e9sum\u00e9 \u4e2d\u6587 \ud83d\ude00 tab\there \\ slash", "facts": [" tests pass ", "\u00a0nbsp-wrapped\u00a0", "ctl\u0001char", "line1\nline2"], "options": [{"key": "yes", "label": "Ship it now, the whole label xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx", "recommended": true}, {"key": "no", "label": " Hold "}], "default_key": "no", "ui": {"a2ui": "v0.9", "card_hash": "082e9a2afdab0a582c96bafc05b131c4e2b4db7d3f24ba720e3d0246c72c99fb", "messages": [{"version": "v0.9", "createSurface": {"surfaceId": "card-d-vec1", "catalogId": "https://a2ui.org/specification/v0_9/catalogs/basic/catalog.json"}}, {"version": "v0.9", "updateComponents": {"surfaceId": "card-d-vec1", "components": [{"id": "root", "component": "Column", "align": "stretch", "children": ["title", "summary", "fact0", "fact1", "fact2", "fact3", "opt0", "opt1"]}, {"id": "title", "component": "Text", "variant": "h3", "text": "Ship \"awdesk\" 0.9?"}, {"id": "summary", "component": "Text", "variant": "body", "text": "Caf\u00e9 \u2014 r\u00e9sum\u00e9 \u4e2d\u6587 \ud83d\ude00 tab\there \\ slash"}, {"id": "fact0-t", "component": "Text", "variant": "caption", "text": "tests pass"}, {"id": "fact0", "component": "Row", "children": ["fact0-t"]}, {"id": "fact1-t", "component": "Text", "variant": "caption", "text": "nbsp-wrapped"}, {"id": "fact1", "component": "Row", "children": ["fact1-t"]}, {"id": "fact2-t", "component": "Text", "variant": "caption", "text": "ctl\u0001char"}, {"id": "fact2", "component": "Row", "children": ["fact2-t"]}, {"id": "fact3-t", "component": "Text", "variant": "caption", "text": "line1\nline2"}, {"id": "fact3", "component": "Row", "children": ["fact3-t"]}, {"id": "opt0", "component": "Button", "variant": "primary", "text": "Ship it now, the whole label xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx", "action": {"event": {"name": "answer:yes"}}}, {"id": "opt1", "component": "Button", "variant": "borderless", "text": "Hold", "action": {"event": {"name": "answer:no"}}}]}}]}};
const PY_HASH = "082e9a2afdab0a582c96bafc05b131c4e2b4db7d3f24ba720e3d0246c72c99fb";

const KEYS = ["yes", "no"];
const clone = (v) => JSON.parse(JSON.stringify(v));
const comps = (ui) => ui.messages[1].updateComponents.components;

test("cardHash is byte-exact with the Python card_hash (vector)", () => {
  assert.equal(cardUi.cardHash(PY_CARD), PY_HASH);
  assert.equal(PY_CARD.ui.card_hash, PY_HASH, "the fixture's ui was compiled against this text");
  assert.equal(cardUi.isCurrent(PY_CARD), true);
});

test("a revised card's ui is not current (title, fact, option label each move the hash)", () => {
  for (const edit of [
    (c) => { c.title = "Ship it later?"; },
    (c) => { c.facts.push("one more fact"); },
    (c) => { c.options[1].label = "Hold it"; },
  ]) {
    const c = clone(PY_CARD);
    edit(c);
    assert.notEqual(cardUi.cardHash(c), PY_HASH);
    assert.equal(cardUi.isCurrent(c), false);
    assert.equal(cardUi.cardUi(c, KEYS).uiTree, null, "stale = fall back");
  }
  // Status and notes are not what the card SAYS.
  const c = clone(PY_CARD);
  c.status = "answered";
  c.notes = [{ text: "x" }];
  assert.equal(cardUi.cardHash(c), PY_HASH);
});

test("pyStrip matches Python str.strip (NEL and the separator controls strip; BOM does not)", () => {
  assert.equal(cardUi.pyStrip("\x85\x1c a \u3000"), "a");
  assert.equal(cardUi.pyStrip("\ufeffa"), "\ufeffa");
});

test("a valid current ui renders a tree: heading, facts, full-label answer buttons", () => {
  const r = cardUi.cardUi(PY_CARD, KEYS);
  assert.deepEqual(r.uiErrors, []);
  assert.equal(r.uiCurrent, true);
  const tree = r.uiTree;
  assert.equal(tree.type, "column");
  assert.equal(tree.align, "stretch");
  assert.deepEqual(tree.children[0], { type: "text", text: PY_CARD.title.trim(), variant: "h3" });
  const buttons = tree.children.filter((n) => n.type === "button");
  assert.deepEqual(buttons.map((b) => b.key), ["yes", "no"]);
  assert.equal(buttons[0].text, PY_CARD.options[0].label, "the WHOLE label, never sliced");
  assert.equal(buttons[0].variant, "primary");
  assert.ok(tree.children.some((n) => n.type === "row" && n.children[0].text === "line1\nline2"));
  assert.equal(cardUi.checkTree(tree, KEYS), 2);
});

test("an unknown component, an invented event, a URL, or >30 components is refused", () => {
  const cases = {
    "unknown component": (ui) => { comps(ui)[1].component = "Image"; },
    "event for no option": (ui) => { comps(ui).find((c) => c.component === "Button").action.event.name = "answer:rm-rf"; },
    "event that is not an answer": (ui) => { comps(ui).find((c) => c.component === "Button").action.event.name = "open"; },
    "event with context": (ui) => { comps(ui).find((c) => c.component === "Button").action.event.context = { a: 1 }; },
    "url in text": (ui) => { comps(ui)[1].text = "see https://evil.example/x"; },
    "javascript: in text": (ui) => { comps(ui)[1].text = "javascript:alert(1)"; },
    "stray url property": (ui) => { comps(ui)[1].url = "x"; },
    "other catalog": (ui) => { ui.messages[0].createSurface.catalogId = "urn:other"; },
    "action on a Text": (ui) => { comps(ui)[1].action = { event: { name: "answer:yes" } }; },
    "too many components": (ui) => {
      for (let i = 0; i < 30; i += 1) comps(ui).push({ id: `pad${i}`, component: "Text", text: "." });
    },
  };
  for (const [name, mutate] of Object.entries(cases)) {
    const c = clone(PY_CARD);
    mutate(c.ui);
    assert.ok(cardUi.validateUi(c.ui, KEYS).length > 0, `${name}: the validator refuses it`);
    const r = cardUi.cardUi(c, KEYS);
    assert.ok(r.uiErrors.length > 0, `${name}: refused`);
    assert.equal(r.uiTree, null, `${name}: falls back`);
  }
});

test("credential cards never carry ui; an oversized ui is not carried", () => {
  const cred = { ...clone(PY_CARD), kind: "credential" };
  assert.equal(cardUi.cardUi(cred, KEYS).ui, null);
  assert.equal(cardUi.cardUi(cred, KEYS).uiTree, null);
  const big = clone(PY_CARD);
  comps(big.ui)[1].text = "x".repeat(cardUi.MAX_UI_BYTES);
  const r = cardUi.cardUi(big, KEYS);
  assert.equal(r.ui, null);
  assert.equal(r.uiTree, null);
});

test("a cycle or a repeated child is drawn once, never multiplied", () => {
  const c = clone(PY_CARD);
  const list = comps(c.ui);
  list[0].children.push("root", list[0].children[0]);
  const tree = cardUi.cardUi(c, KEYS).uiTree;
  assert.ok(tree);
  assert.equal(tree.children.length, list[0].children.length - 2);
});

test("checkTree refuses a tree that names a key the card lacks or an unknown node", () => {
  const tree = cardUi.cardUi(PY_CARD, KEYS).uiTree;
  assert.equal(cardUi.checkTree(tree, ["yes"]), -1);
  assert.equal(cardUi.checkTree({ type: "html", text: "<b>" }, KEYS), -1);
  assert.equal(cardUi.checkTree({ type: "column", children: [{ type: "text", text: "no buttons" }] }, KEYS), 0);
});

test("cardFromRaw carries ui, uiCurrent and uiTree; a card without ui is unchanged", () => {
  const card = decisionCards.cardFromRaw(PY_CARD);
  assert.equal(card.uiCurrent, true);
  assert.ok(card.uiTree && card.uiTree.type === "column");
  assert.equal(card.ui.card_hash, PY_HASH);
  const plain = clone(PY_CARD);
  delete plain.ui;
  const bare = decisionCards.cardFromRaw(plain);
  assert.equal(bare.ui, null);
  assert.equal(bare.uiCurrent, false);
  assert.equal(bare.uiTree, null);
});
