"use strict";

// window.open() was denied and reopened as an unrelated tab, so window.opener was null
// and sign-in / payment popups never finished. A web tab's popup is now a tab that keeps
// its opener, owned by whoever owns the opener.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { POPUP_BURST, POPUP_WINDOW_MS, createPopupLedger, popupUrlOk, popupVerdict, rootOf } = require("./browser-popups.cjs");

const owner = { by: "you", kind: "web" };
const agent = { by: "agent", kind: "web" };
const isInternalUrl = (url) => String(url).startsWith("aither://");

test("a web tab's popup is adopted and belongs to the opener's owner", () => {
  assert.deepEqual(popupVerdict({ opener: owner, url: "https://accounts.example.com/o/oauth2", disposition: "new-window" }),
    { action: "adopt", by: "you", activate: true, private: false });
  assert.deepEqual(popupVerdict({ opener: agent, url: "https://pay.example.com/checkout", disposition: "new-window" }),
    { action: "adopt", by: "agent", activate: true, private: false }, "an agent page's popup is still the agent's");
  assert.deepEqual(popupVerdict({ opener: { by: "you", kind: "web", private: true }, url: "https://x.example/" }),
    { action: "adopt", by: "you", activate: true, private: true }, "an InPrivate tab's popup is InPrivate");
});

test("a popup never changes owner: there is no input that turns an agent's popup into the owner's", () => {
  for (const url of ["https://a.example/", "about:blank", ""]) {
    for (const disposition of ["new-window", "foreground-tab", "background-tab", "other"]) {
      assert.equal(popupVerdict({ opener: agent, url, disposition }).by, "agent");
    }
  }
});

test("an empty popup (opened first, navigated after) is adopted; a ctrl-click stays in the background", () => {
  assert.equal(popupVerdict({ opener: owner, url: "about:blank" }).action, "adopt");
  assert.equal(popupVerdict({ opener: owner, url: "" }).action, "adopt");
  assert.equal(popupVerdict({ opener: owner, url: "https://a.example/", disposition: "background-tab" }).activate, false);
});

test("javascript:, file:, data:, aither: and app links are never a popup", () => {
  for (const url of ["javascript:alert(1)", "file:///C:/Windows/win.ini", "data:text/html,<script>1</script>", "aither://settings/",
    "mailto:a@b.example", "zoommtg://zoom.us/join", "chrome://settings", "about:srcdoc", "blob:https://a.example/1", "not a url"]) {
    assert.equal(popupVerdict({ opener: owner, url }).action, "deny", url);
    assert.equal(popupUrlOk(url), false, url);
  }
});

test("console, hosted and extension pages are never adopted: their page opens the old way, with no opener", () => {
  assert.deepEqual(popupVerdict({ opener: { by: "you", kind: "hosted" }, url: "https://evil.example/", isInternalUrl }), { action: "tab", by: "you", activate: true });
  assert.deepEqual(popupVerdict({ opener: { by: "you", kind: "extension" }, url: "https://docs.example/", isInternalUrl }), { action: "tab", by: "you", activate: true });
  assert.deepEqual(popupVerdict({ opener: { by: "you", kind: "internal" }, url: "aither://history/", isInternalUrl }), { action: "tab", by: "you", activate: true });
  assert.equal(popupVerdict({ opener: { by: "you", kind: "internal" }, url: "about:blank", isInternalUrl }).action, "deny");
  assert.equal(popupVerdict({ opener: { by: "you", kind: "hosted" }, url: "aither://settings/", isInternalUrl }).action, "deny",
    "only a console page opens a console page");
});

test("the owner's popup to an Aitherium page opens in its own signed-in tab, not in the web session; an agent's stays a web popup", () => {
  const isHostedSite = (url) => String(url).startsWith("https://app.aitherium.com/");
  assert.deepEqual(popupVerdict({ opener: owner, url: "https://app.aitherium.com/workspace", isHostedSite }), { action: "tab", by: "you", activate: true });
  assert.equal(popupVerdict({ opener: agent, url: "https://app.aitherium.com/workspace", isHostedSite }).action, "adopt");
  assert.equal(popupVerdict({ opener: agent, url: "https://app.aitherium.com/workspace", isHostedSite }).by, "agent");
  assert.equal(popupVerdict({ opener: owner, url: "https://other.example/", isHostedSite }).action, "adopt");
});

test("an agent tab riding the owner's session is never adopted from: its popup's session is picked again", () => {
  const riding = { by: "agent", kind: "web", ownerSession: true };
  assert.deepEqual(popupVerdict({ opener: riding, url: "https://bank.example/" }), { action: "tab", by: "agent", activate: true });
  assert.equal(popupVerdict({ opener: riding, url: "about:blank" }).action, "deny", "an empty popup would inherit the owner's session");
  assert.equal(popupVerdict({ opener: riding, url: "" }).action, "deny");
  // The owner's own tab is not an "agent on the owner's session".
  assert.equal(popupVerdict({ opener: { by: "you", kind: "web", ownerSession: true }, url: "https://a.example/" }).action, "adopt");
});

test("no opener tab, or an unknown owner: denied", () => {
  assert.equal(popupVerdict({ opener: null, url: "https://a.example/" }).action, "deny");
  assert.equal(popupVerdict({ opener: { by: "page", kind: "web" }, url: "https://a.example/" }).action, "deny");
  assert.equal(popupVerdict().action, "deny");
});

test("a page that opens popups in a loop is refused after the burst, and may again later", () => {
  let t = 1_000_000;
  const ledger = createPopupLedger({ now: () => t });
  for (let i = 0; i < POPUP_BURST; i += 1) {
    assert.equal(popupVerdict({ opener: owner, url: "https://a.example/", recent: ledger.count(1) }).action, "adopt", `popup ${i + 1}`);
    ledger.note(1);
  }
  assert.equal(popupVerdict({ opener: owner, url: "https://a.example/", recent: ledger.count(1) }).action, "deny");
  assert.equal(ledger.count(2), 0, "another opener is counted on its own");
  t += POPUP_WINDOW_MS + 1;
  assert.equal(ledger.count(1), 0);
  assert.equal(popupVerdict({ opener: owner, url: "https://a.example/", recent: ledger.count(1) }).action, "adopt");
  ledger.note(1);
  ledger.forget(1);
  assert.equal(ledger.count(1), 0);
});

test("browser-window adopts the popup's own page and never builds it with a preload", () => {
  const src = fs.readFileSync(path.join(__dirname, "browser-window.cjs"), "utf8");
  assert.match(src, /action: "allow", outlivesOpener: true, createWindow:/);
  const adopt = src.slice(src.indexOf("function adoptPopup("), src.indexOf("function wirePopupClose("));
  assert.match(adopt, /new WebContentsView\(\{ webContents: guest \}\)/, "the popup's own page is shown, not a new one");
  assert.doesNotMatch(adopt, /preload/);
  assert.match(adopt, /tabs\.add\(verdict\.by,/, "the tab's owner comes from the verdict");
  const open = src.slice(src.indexOf("function openFromPage("), src.indexOf("function adoptPopup("));
  assert.match(open, /ownerSession: opener\.by === "agent" && \(opener\.viewSpec \|\| \{\}\)\.webPartition === PARTITION/,
    "the verdict is told when an agent tab rides the owner's session");
});

// ---------------------------------------------------------------- review finding L3

test("L3: the burst is counted against the root of the opener chain, so a popup's popups share one allowance", () => {
  assert.equal(rootOf({ by: "you", kind: "web" }, 4), 4, "a tab nobody opened is its own root");
  assert.equal(rootOf({ by: "you", kind: "web", popupRoot: 2 }, 9), 2, "a popup counts against the tab that started the chain");
  assert.equal(rootOf({ by: "you", kind: "web", popupRoot: 0 }, 9), 0);
  assert.equal(rootOf(null, 5), 5);
  // Tab 1 opens popup 2, which opens popup 3, which opens 4...: every popup is a new opener.
  let t = 1_000_000;
  const ledger = createPopupLedger({ now: () => t });
  const tabsById = { 1: { by: "you", kind: "web" } };
  let opener = 1;
  let adopted = 0;
  for (let next = 2; next <= 20; next += 1) {
    const root = rootOf(tabsById[opener], opener);
    const verdict = popupVerdict({ opener: tabsById[opener], url: "https://a.example/", recent: ledger.count(root) });
    if (verdict.action === "deny") break;
    ledger.note(root);
    tabsById[next] = { by: "you", kind: "web", popupRoot: root };
    opener = next;
    adopted += 1;
  }
  assert.equal(adopted, POPUP_BURST, "a chain is stopped at the burst, not allowed a fresh burst per popup");
  assert.equal(ledger.count(1), POPUP_BURST);
});

test("L3: the old no-opener way of opening a tab is refused after the burst too", () => {
  const isHostedSite = (url) => String(url).startsWith("https://app.aitherium.com/");
  const cases = [
    [{ by: "you", kind: "hosted" }, "https://evil.example/"],
    [{ by: "you", kind: "extension" }, "https://docs.example/"],
    [{ by: "you", kind: "internal" }, "aither://history/"],
    [{ by: "agent", kind: "web", ownerSession: true }, "https://bank.example/"],
    [{ by: "you", kind: "web" }, "https://app.aitherium.com/workspace"],
  ];
  for (const [opener, url] of cases) {
    const args = { opener, url, isHostedSite, isInternalUrl: (u) => String(u).startsWith("aither://") };
    assert.equal(popupVerdict({ ...args, recent: POPUP_BURST - 1 }).action, "tab", `${opener.kind} below the burst`);
    assert.equal(popupVerdict({ ...args, recent: POPUP_BURST }).action, "deny", `${opener.kind} at the burst`);
  }
});

test("L3: browser-window counts every opened tab against the root and carries the root on the new tab", () => {
  const src = fs.readFileSync(path.join(__dirname, "browser-window.cjs"), "utf8");
  const open = src.slice(src.indexOf("function openFromPage("), src.indexOf("function adoptPopup("));
  assert.match(open, /const root = popups\.rootOf\(opener, id\);/);
  assert.match(open, /recent: popupLedger\.count\(root\)/);
  assert.ok(open.indexOf("popupLedger.note(root);") > 0 && open.indexOf("popupLedger.note(root);") < open.indexOf('verdict.action === "tab"'),
    "the tab path is counted, not only the adopted one");
  assert.match(open, /tabs\.get\(opened\.id\)\.popupRoot = root;/, "a tab opened the old way carries the root");
  assert.doesNotMatch(open, /popupLedger\.(count|note)\(id\)/);
  const adopt = src.slice(src.indexOf("function adoptPopup("), src.indexOf("function wirePopupClose("));
  assert.match(adopt, /tab\.popupRoot = root;/, "an adopted popup carries the root");
});
