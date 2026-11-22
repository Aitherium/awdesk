"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const lo = require("./link-opener.cjs");

test("Aitherium URLs default to AitherBrowser, the rest to the system browser", () => {
  assert.equal(lo.openerFor("https://aitherium.com/decide?id=d-1"), "aither");
  assert.equal(lo.openerFor("https://app.aitherium.com/mission-control"), "aither");
  assert.equal(lo.openerFor("https://garg.aitherium.com/"), "aither");
  assert.equal(lo.openerFor("https://github.com/Aitherium/awdesk/pull/1"), "system");
  assert.equal(lo.openerFor("https://evilaitherium.com/"), "system", "a lookalike host is not ours");
  assert.equal(lo.openerFor("javascript:alert(1)"), "", "only web links open");
  assert.equal(lo.openerFor("https://github.com/x", "aither"), "aither", "an explicit pick wins");
});

test("every chooser offers AitherBrowser first, marked default for our links", () => {
  const ours = lo.openWithItems("https://aitherium.com/x");
  assert.deepEqual(ours.map((i) => i.id), ["open-aither", "open-system", "copy-link"]);
  assert.equal(ours[0].default, true);
  assert.match(ours[0].label, /AitherBrowser \(default\)/);
  const theirs = lo.openWithItems("https://github.com/x", { copy: false });
  assert.deepEqual(theirs.map((i) => i.id), ["open-aither", "open-system"]);
  assert.equal(theirs[0].default, false);
  assert.equal(theirs[1].default, true);
  assert.deepEqual(lo.openWithItems("file:///C:/x"), []);
});

test("openLink routes through the injected opener and reports which", () => {
  const seen = [];
  const openers = { openAither: (u) => seen.push(["aither", u]), openSystem: (u) => seen.push(["system", u]) };
  assert.equal(lo.openLink("https://aitherium.com/a", openers).via, "aither");
  assert.equal(lo.openLink("https://github.com/a", openers).via, "system");
  assert.equal(lo.openLink("https://github.com/a", { ...openers, prefer: "aither" }).via, "aither");
  assert.equal(lo.openLink("ftp://x", openers).ok, false);
  assert.deepEqual(seen.map((s) => s[0]), ["aither", "system", "aither"]);
  assert.equal(lo.openLink("https://aitherium.com/a", {}).ok, false, "no opener: says so");
});
