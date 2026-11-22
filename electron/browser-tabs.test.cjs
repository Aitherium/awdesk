"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { MAX_TABS, TabSet, agentTabView } = require("./browser-tabs.cjs");

test("an agent has no tab until it opens one; then it drives that tab", () => {
  const tabs = new TabSet();
  const home = tabs.add("you").id;
  assert.match(tabs.target().error, /no tab open; call browser_open/);
  const mine = tabs.add("agent").id;
  assert.deepEqual(tabs.target(), { ok: true, id: mine });
  assert.equal(tabs.active, mine, "an agent tab is shown when it opens");
  assert.notEqual(home, mine);
});

test("the owner watching another tab never moves what the agent drives", () => {
  const tabs = new TabSet();
  const home = tabs.add("you").id;
  const agent = tabs.add("agent").id;
  tabs.activate(home);
  assert.equal(tabs.active, home);
  assert.deepEqual(tabs.target(), { ok: true, id: agent }, "the agent still acts on ITS tab, not the one on screen");
});

test("an agent cannot switch to or close an owner's tab; the owner can close anything", () => {
  const tabs = new TabSet();
  const home = tabs.add("you").id;
  const a1 = tabs.add("agent").id;
  const a2 = tabs.add("agent").id;
  assert.match(tabs.agentSwitch(home).error, /owner's; an agent may only use tabs it opened/);
  assert.match(tabs.close(home, "agent").error, /owner's; an agent may only close tabs it opened/);
  assert.deepEqual(tabs.agentSwitch(a1), { ok: true, id: a1 });
  assert.equal(tabs.active, a1, "switching shows the tab");
  assert.equal(tabs.close(a1, "agent").ok, true);
  assert.deepEqual(tabs.target(), { ok: true, id: a2 }, "closing the target falls back to the newest agent tab");
  assert.equal(tabs.close(a2, "you").ok, true, "the owner may close an agent tab");
  assert.equal(tabs.target().ok, false);
  assert.equal(tabs.active, home);
});

test("closing the active tab shows its neighbour; popups land after their opener", () => {
  const tabs = new TabSet();
  const t1 = tabs.add("you").id;
  const t2 = tabs.add("you").id;
  const t3 = tabs.add("you").id;
  const pop = tabs.add("you", { after: t1 }).id;
  assert.deepEqual(tabs.snapshot().tabs.map((t) => t.id), [t1, pop, t2, t3]);
  tabs.activate(t2);
  tabs.close(t2);
  assert.equal(tabs.active, t3);
  tabs.close(t3);
  assert.equal(tabs.active, pop);
});

test("unknown owners and the tab limit are refused", () => {
  const tabs = new TabSet();
  assert.equal(tabs.add("someone").ok, false);
  for (let i = 0; i < MAX_TABS; i += 1) assert.equal(tabs.add("you").ok, true);
  assert.match(tabs.add("agent").error, /tab limit/);
  assert.equal(tabs.close(9999).ok, false);
  assert.equal(tabs.activate(9999).ok, false);
});

test("pinned tabs sit at the front, keep their order, and do not close from the strip", () => {
  const tabs = new TabSet();
  const web = tabs.add("you").id;
  const inbox = tabs.add("you", { kind: "internal", pinned: true, key: "inbox", activate: false }).id;
  const online = tabs.add("you", { kind: "hosted", pinned: true, key: "online", activate: false }).id;
  const pane = tabs.add("you", { kind: "internal" }).id;
  // A popup "after" a pinned tab lands after the LAST pinned tab, never among them.
  const pop = tabs.add("you", { after: inbox }).id;
  assert.deepEqual(tabs.snapshot().tabs.map((t) => t.id), [inbox, online, pop, web, pane]);
  assert.equal(tabs.byKey("online").id, online);
  assert.equal(tabs.byKey("nope"), null);
  assert.match(tabs.close(inbox, "you").error, /pinned/);
  assert.equal(tabs.get(inbox).kind, "internal");
  assert.deepEqual(tabs.snapshot().tabs[0], { id: inbox, by: "you", kind: "internal", pinned: true, shared: false });
  assert.equal(tabs.active, pop, "a pinned tab opened in the background does not steal the strip");
});

test("an agent can never hold an Aither page or a pinned tab", () => {
  const tabs = new TabSet();
  assert.match(tabs.add("agent", { kind: "internal" }).error, /only open web tabs/);
  assert.match(tabs.add("agent", { kind: "hosted" }).error, /only open web tabs/);
  assert.match(tabs.add("agent", { pinned: true }).error, /only open web tabs/);
  assert.match(tabs.add("you", { kind: "file" }).error, /unknown tab kind/);
  const mine = tabs.add("you", { kind: "internal" }).id;
  assert.match(tabs.agentSwitch(mine).error, /owner's/);
  assert.equal(tabs.add("agent").ok, true, "a web tab is still the agent's to open");
});

// BROWSER-5: what an agent may SEE of the strip.
const BANK = "https://bank.example/accounts?id=42";
const strip = (tabs, urls) => tabs.snapshot().tabs.map((t) => ({
  id: t.id, by: t.by, kind: t.kind, pinned: t.pinned, label: t.pinned ? "Inbox" : "", badge: t.pinned ? 123 : 0,
  active: t.id === tabs.active, agentTarget: t.id === tabs.agentTarget, url: urls[t.id] || "",
  title: `title of ${urls[t.id] || "blank"}`, loading: false, popped: false,
  shared: t.by === "you" && tabs.isShared(t.id, urls[t.id]),
}));

test("an owner tab's url and title never reach the agent's view unless shared", () => {
  const tabs = new TabSet();
  const inbox = tabs.add("you", { kind: "internal", pinned: true, key: "inbox" }).id;
  const bank = tabs.add("you").id;
  const urls = { [inbox]: "aither://inbox/", [bank]: BANK };
  const view = agentTabView(strip(tabs, urls));
  const text = JSON.stringify(view);
  assert.ok(!text.includes("bank.example") && !text.includes("title of") && !text.includes("inbox") && !text.includes("123"), text);
  assert.deepEqual(view.tabs, [{ id: inbox, by: "you", withheld: true }, { id: bank, by: "you", withheld: true }]);
  assert.deepEqual(view.owner, { count: 2, shared: 0, withheld: 2 });
});

test("agent tabs pass through the agent's view unchanged", () => {
  const tabs = new TabSet();
  tabs.add("you");
  const mine = tabs.add("agent").id;
  const rows = strip(tabs, { [mine]: "https://docs.example/a" });
  const view = agentTabView(rows);
  assert.deepEqual(view.tabs[1], rows[1]);
  assert.equal(view.tabs[1].url, "https://docs.example/a");
  assert.equal(view.owner.count, 1);
});

test("a shared owner tab is visible, and a navigation off its origin withdraws the share", () => {
  const tabs = new TabSet();
  const id = tabs.add("you").id;
  assert.deepEqual(tabs.share(id, "https://docs.example/page"), { ok: true, id, shared: true });
  let view = agentTabView(strip(tabs, { [id]: "https://docs.example/other" }));
  assert.equal(view.tabs[0].url, "https://docs.example/other", "same origin stays shared");
  assert.deepEqual(view.owner, { count: 1, shared: 1, withheld: 0 });
  view = agentTabView(strip(tabs, { [id]: BANK }));
  assert.deepEqual(view.tabs[0], { id, by: "you", withheld: true }, "the bank it navigated to is withheld");
  assert.equal(tabs.isShared(id, "https://docs.example/page"), false, "and going back does not re-share");
});

test("only the owner's web tabs can be shared, and sharing never lets the agent drive one", () => {
  const tabs = new TabSet();
  const pane = tabs.add("you", { kind: "internal" }).id;
  const web = tabs.add("you").id;
  const mine = tabs.add("agent").id;
  assert.match(tabs.share(pane, "https://x.example/").error, /Aither page/);
  assert.match(tabs.share(mine, "https://x.example/").error, /already visible/);
  assert.match(tabs.share(web, "about:blank").error, /no web page/);
  assert.ok(tabs.share(web, "https://x.example/").ok);
  assert.match(tabs.agentSwitch(web).error, /owner's/);
  assert.match(tabs.close(web, "agent").error, /owner's/);
  assert.deepEqual(tabs.share(web, null), { ok: true, id: web, shared: false });
  assert.equal(tabs.isShared(web, "https://x.example/"), false);
});
