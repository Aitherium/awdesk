"use strict";

// mailto:, tel: and "Join in Zoom" links did nothing. The owner is now asked "Open <App>?"
// for a short allow-list of schemes; an agent's tab and every other scheme get nothing.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const ext = require("./browser-external-apps.cjs");
const { createPermissionStore } = require("./browser-permissions.cjs");

const owner = { by: "you", kind: "web" };
const PAGE = "https://meet.example.com/room/1";
const ORIGIN = "https://meet.example.com";
/** The page itself followed the link: the frame that started the navigation has the page's origin. */
const DIRECT = Object.freeze({ via: "navigate", initiatorOrigin: ORIGIN });
const tmp = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), "aither-ext-apps-")), "external.json");

test("the allow-list is exactly the eleven schemes", () => {
  assert.deepEqual(Object.keys(ext.APPS).sort(), ["discord:", "mailto:", "msteams:", "slack:", "sms:", "spotify:", "steam:", "tel:",
    "vscode:", "zoommtg:", "zoomus:"]);
});

test("a listed link from the owner's tab asks, and carries the exact address", () => {
  const url = "zoommtg://zoom.us/join?confno=123456789&pwd=abc%20def";
  const v = ext.judge({ url, tab: owner, pageUrl: PAGE, ...DIRECT });
  assert.deepEqual(v, { verdict: "prompt", url, scheme: "zoommtg:", app: "Zoom", origin: ORIGIN, canAlways: true });
  const notice = ext.noticeFor(v, 1234);
  assert.equal(notice.kind, "external-app");
  assert.equal(notice.text, "Open Zoom? meet.example.com wants to open a link in it.");
  assert.deepEqual(notice.actions.map((a) => a.label), ["Open", "Always for this site", "Not now"]);
  assert.equal(notice.data.url, url);
  assert.equal(notice.at, 1234);
});

test("every listed scheme is offered; the scheme's case does not matter", () => {
  const links = ["mailto:a@b.example?subject=Hi", "tel:+15551234567", "sms:+15551234567", "zoommtg://zoom.us/join?confno=1", "zoomus://zoom.us/join?confno=1",
    "msteams:/l/meetup-join/19:meeting", "slack://channel?team=T1&id=C1", "spotify:track:4uLU6hMCjMI75M1A2tKUQC", "discord://-/channels/1/2",
    "steam://store/440", "vscode://file/c:/x.txt", "MAILTO:a@b.example"];
  for (const url of links) assert.equal(ext.judge({ url, tab: owner, pageUrl: PAGE, ...DIRECT }).verdict, "prompt", url);
});

test("an agent's tab gets nothing, whatever the link, the site or a remembered Always", () => {
  const store = ext.createExternalStore({ file: tmp() });
  store.allow(ORIGIN, "mailto:");
  for (const tab of [{ by: "agent", kind: "web" }, { by: "agent", kind: "hosted" }, null, { by: "you", kind: "internal" }, { by: "you", kind: "extension" }]) {
    assert.deepEqual(ext.judge({ url: "mailto:a@b.example", tab, pageUrl: PAGE, ...DIRECT, gesture: true, store }), { verdict: "deny" }, JSON.stringify(tab));
  }
});

test("a scheme that is not on the list stays refused", () => {
  for (const url of ["file:///C:/Windows/System32/calc.exe", "javascript:alert(1)", "ms-msdt:/id PCWDiagnostic", "search-ms:query=x", "ms-officecmd:x",
    "calculator:", "shell:startup", "data:text/html,x", "aither://settings/", "https://example.com/", "tg://resolve?domain=x", "ssh://host", "x-made-up:1", "", null, 42]) {
    assert.deepEqual(ext.judge({ url, tab: owner, pageUrl: PAGE, ...DIRECT }), { verdict: "deny" }, String(url));
  }
});

test("a link with whitespace, control characters, quotes or of absurd length is refused", () => {
  for (const url of ["mailto:a@b.example?subject=x y", "zoommtg://zoom.us/join\u0000", "vscode://file/c:/x\" --extensionDevelopmentPath=evil",
    "steam://run/1//`calc`", "slack://open\n", "tel:+1'5", `mailto:${"a".repeat(ext.MAX_LINK)}@b.example`]) {
    assert.equal(ext.launchable(url), null, JSON.stringify(url).slice(0, 60));
  }
});

test("a page that is not a web page (about:blank, data:) cannot ask", () => {
  for (const pageUrl of ["about:blank", "data:text/html,x", "", "file:///c:/x.html"]) {
    assert.deepEqual(ext.judge({ url: "mailto:a@b.example", tab: owner, pageUrl, via: "navigate", initiatorOrigin: null }), { verdict: "deny" }, pageUrl);
  }
});

test("Always is remembered per site and per app, and needs the page itself asking on a page the owner used", () => {
  const store = ext.createExternalStore({ file: tmp(), now: () => 777 });
  assert.equal(store.allow(ORIGIN, "zoommtg:"), true);
  const base = { url: "zoommtg://zoom.us/join?confno=1", tab: owner, pageUrl: PAGE, store };
  assert.equal(ext.judge({ ...base, ...DIRECT, gesture: true }).verdict, "open");
  assert.equal(ext.judge({ ...base, ...DIRECT, gesture: false }).verdict, "prompt", "a page the owner never touched: asked again");
  assert.equal(ext.judge({ ...base, ...DIRECT, gesture: true, sinceAuto: ext.AUTO_OPEN_GAP_MS - 1 }).verdict, "prompt",
    "a second app start right after the first: asked (no launch loop)");
  assert.equal(ext.judge({ ...base, ...DIRECT, gesture: true, sinceAuto: ext.AUTO_OPEN_GAP_MS }).verdict, "open");
  assert.match(ext.INTERACTED_SCRIPT, /navigator\.userActivation\.hasBeenActive/);
  assert.equal(ext.judge({ ...base, via: "frame", requestingUrl: PAGE, gesture: true }).verdict, "prompt", "an embedded frame: asked again");
  assert.equal(ext.judge({ ...base, url: "mailto:a@b.example", ...DIRECT, gesture: true }).verdict, "prompt", "another app: asked");
  assert.equal(ext.judge({ ...base, pageUrl: "https://other.example/", via: "navigate", initiatorOrigin: "https://other.example", gesture: true }).verdict, "prompt", "another site: asked");
});

test("Always is not offered InPrivate, on a plain http site or from an embedded frame", () => {
  const offered = (v) => ext.noticeFor(v).actions.map((a) => a.id).includes("external-always");
  const url = "mailto:a@b.example";
  assert.equal(offered(ext.judge({ url, tab: owner, pageUrl: PAGE, ...DIRECT })), true);
  assert.equal(offered(ext.judge({ url, tab: { ...owner, private: true }, pageUrl: PAGE, ...DIRECT })), false);
  assert.equal(offered(ext.judge({ url, tab: owner, pageUrl: "http://plain.example/", via: "navigate", initiatorOrigin: "http://plain.example" })), false);
  assert.equal(offered(ext.judge({ url, tab: owner, pageUrl: PAGE, via: "frame", requestingUrl: PAGE })), false);
  // A remembered Always is not used InPrivate either.
  const store = ext.createExternalStore({ file: tmp() });
  store.allow(ORIGIN, "mailto:");
  assert.equal(ext.judge({ url, tab: { ...owner, private: true }, pageUrl: PAGE, ...DIRECT, gesture: true, store }).verdict, "prompt");
});

test("a long host shows its END in the question", () => {
  const origin = `https://${"a".repeat(40)}.accounts.zoom.us.evil.example`;
  const text = ext.promptText("Zoom", origin);
  assert.ok(text.startsWith("Open Zoom? …"), text);
  assert.ok(text.includes("evil.example wants to open a link in it."), text);
});

test("the store survives a reload, refuses unknown schemes and insecure sites, and drops a tampered file's junk", () => {
  const file = tmp();
  const store = ext.createExternalStore({ file, now: () => 5 });
  assert.equal(store.allow(ORIGIN, "calculator:"), false);
  assert.equal(store.allow("http://plain.example", "mailto:"), false);
  assert.equal(store.allow(`${ORIGIN}/path`, "mailto:"), false, "an origin, not a page");
  assert.equal(store.allow(ORIGIN, "mailto:"), true);
  assert.equal(store.allow(ORIGIN, "zoommtg:"), true);
  const again = ext.createExternalStore({ file });
  assert.equal(again.get(ORIGIN, "mailto:"), true);
  assert.deepEqual(again.list(), [
    { origin: ORIGIN, kind: "open:mailto:", label: "Open your mail app", value: "allow", at: 5 },
    { origin: ORIGIN, kind: "open:zoommtg:", label: "Open Zoom", value: "allow", at: 5 },
  ]);
  assert.equal(again.remove(ORIGIN, "mailto:"), true);
  assert.equal(again.get(ORIGIN, "mailto:"), false);
  assert.equal(again.remove(ORIGIN, "mailto:"), false);
  fs.writeFileSync(file, JSON.stringify({ version: 1, sites: { [ORIGIN]: { "calculator:": 1, "tel:": 2 }, "javascript:x": { "tel:": 1 } } }));
  assert.deepEqual(ext.createExternalStore({ file }).list().map((r) => r.kind), ["open:tel:"]);
  fs.writeFileSync(file, "not json");
  assert.deepEqual(ext.createExternalStore({ file }).list(), []);
});

test("the review page sees both stores as one list and can take either kind back", () => {
  const permissions = createPermissionStore({ file: tmp(), now: () => 1 });
  const external = ext.createExternalStore({ file: tmp(), now: () => 2 });
  permissions.set(ORIGIN, ["camera"], "allow");
  external.allow(ORIGIN, "zoommtg:");
  external.allow("https://mail.example.com", "mailto:");
  const both = ext.withExternal(permissions, external);
  assert.deepEqual(both.list().map((r) => `${r.origin} ${r.kind}`), [`${ORIGIN} camera`, "https://mail.example.com open:mailto:", `${ORIGIN} open:zoommtg:`]);
  assert.equal(both.remove(ORIGIN, "open:zoommtg:"), true);
  assert.equal(external.get(ORIGIN, "zoommtg:"), false);
  assert.equal(permissions.get(ORIGIN, "camera"), "allow", "the camera answer is untouched");
  assert.equal(both.remove(ORIGIN, "camera"), true);
  assert.equal(both.remove("https://mail.example.com", null), true, "the whole site");
  assert.deepEqual(both.list(), []);
  external.allow(ORIGIN, "tel:");
  permissions.set(ORIGIN, ["camera"], "block");
  assert.equal(both.clear(), 2);
  assert.deepEqual(both.list(), []);
});

test("only the two answer buttons are this module's actions", () => {
  assert.equal(ext.isAction("external-open"), true);
  assert.equal(ext.isAction("external-always"), true);
  assert.equal(ext.isAction("dismiss"), false);
  assert.equal(ext.isAction("permission-allow"), false);
});

test("browser-window never hands a link to the system without the judge and the allow-list", () => {
  const src = fs.readFileSync(path.join(__dirname, "browser-window.cjs"), "utf8");
  const section = src.slice(src.indexOf("function offerExternalApp("), src.indexOf("// ---------------------------------------------------------------- the library pages"));
  assert.match(section, /externalApps\.judge\(/);
  assert.match(section, /externalApps\.launchable\(/, "the address is checked again when the owner answers");
  const launches = section.match(/launchExternal\(/g) || [];
  assert.ok(launches.length >= 2, "one launch after Open, one for a remembered Always");
});

// ---------------------------------------------------------------- review findings (M1, L2)

test("M1: a web address that redirects to an app link always asks, names the redirecting site, and offers no Always", () => {
  const store = ext.createExternalStore({ file: tmp() });
  store.allow(ORIGIN, "mailto:");
  store.allow("https://go.example.net", "mailto:");
  // The owner said "Always" on meet.example.com; a link there goes to go.example.net, which 302s to mailto:.
  const v = ext.judge({ url: "mailto:a@b.example", tab: owner, pageUrl: PAGE, via: "redirect", redirectFrom: "https://go.example.net/out?id=7",
    gesture: true, store });
  assert.equal(v.verdict, "prompt", "never opened unasked, whoever is remembered");
  assert.equal(v.origin, "https://go.example.net", "the redirecting site is the one that asks");
  assert.equal(v.canAlways, false);
  assert.equal(ext.noticeFor(v).text, "Open your mail app? go.example.net wants to open a link in it.");
  assert.deepEqual(ext.noticeFor(v).actions.map((a) => a.label), ["Open", "Not now"]);
  // A same-site redirect is still a redirect: asked.
  assert.equal(ext.judge({ url: "mailto:a@b.example", tab: owner, pageUrl: PAGE, via: "redirect", redirectFrom: `${ORIGIN}/go`, gesture: true, store }).verdict, "prompt");
  // The redirecting address is unknown: the page is named, and it is still asked.
  const unknown = ext.judge({ url: "mailto:a@b.example", tab: owner, pageUrl: PAGE, via: "redirect", redirectFrom: null, gesture: true, store });
  assert.deepEqual([unknown.verdict, unknown.origin, unknown.canAlways], ["prompt", ORIGIN, false]);
});

test("M1: a navigation another window or a cross-origin frame started is credited to it, not to the page", () => {
  const store = ext.createExternalStore({ file: tmp() });
  store.allow(ORIGIN, "zoommtg:");
  const base = { url: "zoommtg://zoom.us/join?confno=1", tab: owner, pageUrl: PAGE, via: "navigate", gesture: true, store };
  assert.equal(ext.judge({ ...base, initiatorOrigin: ORIGIN }).verdict, "open", "the page itself: the remembered Always is used");
  // An adopted popup on evil.example sets opener.location; an ad frame sets top.location.
  const other = ext.judge({ ...base, initiatorOrigin: "https://evil.example" });
  assert.deepEqual([other.verdict, other.origin, other.canAlways], ["prompt", "https://evil.example", false]);
  assert.equal(ext.noticeFor(other).text, "Open Zoom? evil.example wants to open a link in it.");
  // Nobody in a page started it (a typed address, a browser-driven navigation): asked, no Always.
  for (const initiatorOrigin of [null, undefined, "", "null"]) {
    const none = ext.judge({ ...base, initiatorOrigin });
    assert.deepEqual([none.verdict, none.origin, none.canAlways], ["prompt", ORIGIN, false], String(initiatorOrigin));
  }
  // No `via` at all is not "the page asked".
  assert.equal(ext.judge({ ...base, via: undefined, initiatorOrigin: ORIGIN }).verdict, "prompt");
});

test("M1: a frame's app link names the frame's site and is never remembered", () => {
  const store = ext.createExternalStore({ file: tmp() });
  store.allow(ORIGIN, "mailto:");
  store.allow("https://ads.example", "mailto:");
  const v = ext.judge({ url: "mailto:a@b.example", tab: owner, pageUrl: PAGE, via: "frame", requestingUrl: "https://ads.example/slot.html", gesture: true, store });
  assert.deepEqual([v.verdict, v.origin, v.canAlways], ["prompt", "https://ads.example", false]);
  assert.deepEqual(ext.whoAsks({ via: "frame", pageUrl: PAGE, requestingUrl: "" }), { origin: ORIGIN, direct: false }, "no frame address: the page is named");
  assert.deepEqual(ext.whoAsks({ via: "navigate", pageUrl: PAGE, initiatorOrigin: ORIGIN }), { origin: ORIGIN, direct: true });
  assert.deepEqual(ext.whoAsks({ via: "navigate", pageUrl: "about:blank", initiatorOrigin: ORIGIN }), { origin: ORIGIN, direct: false },
    "an empty popup another window navigates: that window is named");
  assert.deepEqual(ext.whoAsks({ pageUrl: "about:blank" }), { origin: null, direct: false });
});

test("L2: percent-encoded quotes, backticks, backslashes, line breaks and NUL are refused, in any case", () => {
  for (const bad of ["%22", "%27", "%60", "%5C", "%5c", "%0A", "%0a", "%0D", "%0d", "%00"]) {
    for (const url of [`vscode://file/c:/x${bad}y`, `mailto:a@b.example?subject=a${bad}b`, `steam://run/1//${bad}`, `zoommtg://zoom.us/join?confno=1&x=${bad}`]) {
      assert.equal(ext.launchable(url), null, url);
      assert.deepEqual(ext.judge({ url, tab: owner, pageUrl: PAGE, ...DIRECT }), { verdict: "deny" }, url);
    }
  }
  assert.ok(ext.launchable("mailto:a@b.example?subject=Hello%20there&body=100%25"), "an ordinary encoded space and percent sign stay fine");
  assert.ok(ext.launchable("mailto:a@b.example?subject=%C3%A9t%C3%A9"), "encoded non-ASCII letters stay fine");
});

test("L2: whitespace outside ASCII is refused", () => {
  for (const ch of ["\u0085", "\u00a0", "\u1680", "\u2000", "\u2003", "\u200a", "\u2028", "\u2029", "\u202f", "\u205f", "\u3000", "\ufeff"]) {
    const url = `mailto:a@b.example?subject=a${ch}b`;
    assert.equal(ext.launchable(url), null, `U+${ch.charCodeAt(0).toString(16)}`);
  }
});

test("L2: Steam and VS Code are asked every time: Always is never offered, stored or honoured for them", () => {
  assert.deepEqual([...ext.NEVER_ALWAYS].sort(), ["steam:", "vscode:"]);
  const file = tmp();
  const store = ext.createExternalStore({ file });
  for (const [scheme, url] of [["steam:", "steam://store/440"], ["vscode:", "vscode://file/c:/x.txt"]]) {
    const v = ext.judge({ url, tab: owner, pageUrl: PAGE, ...DIRECT, gesture: true, store });
    assert.deepEqual([v.verdict, v.canAlways], ["prompt", false], scheme);
    assert.deepEqual(ext.noticeFor(v).actions.map((a) => a.label), ["Open", "Not now"], scheme);
    assert.equal(store.allow(ORIGIN, scheme), false, `${scheme} is not stored`);
    assert.equal(ext.alwaysEligible(scheme), false);
  }
  assert.equal(ext.alwaysEligible("mailto:"), true);
  assert.equal(ext.alwaysEligible("calculator:"), false);
  // An answer an older build (or a hand edit) left in the file is dropped, and a store that still says yes is not believed.
  fs.writeFileSync(file, JSON.stringify({ version: 1, sites: { [ORIGIN]: { "steam:": 1, "vscode:": 2, "tel:": 3 } } }));
  assert.deepEqual(ext.createExternalStore({ file }).list().map((r) => r.kind), ["open:tel:"]);
  const lying = { get: () => true };
  assert.equal(ext.judge({ url: "steam://run/440", tab: owner, pageUrl: PAGE, ...DIRECT, gesture: true, store: lying }).verdict, "prompt");
  assert.equal(ext.judge({ url: "tel:+15551234567", tab: owner, pageUrl: PAGE, ...DIRECT, gesture: true, store: lying }).verdict, "open");
});

test("M1: browser-window tells the judge who asked on each of the three paths", () => {
  const src = fs.readFileSync(path.join(__dirname, "browser-window.cjs"), "utf8");
  assert.match(src, /offerExternalApp\(id, url, \{ via: "navigate", initiatorOrigin: initiatorOriginOf\(event\) \}\)/);
  assert.match(src, /offerExternalApp\(id, url, \{ via: "redirect", redirectFrom: navFrom\.get\(wc\) \|\| null \}\)/);
  assert.match(src, /offerExternalApp\(id, details && details\.externalURL, \{ via: "frame", requestingUrl: details && details\.requestingUrl \}\)/);
  assert.doesNotMatch(src, /mainFrame: true \}\)/, "no path claims the page asked without saying who started it");
  const offer = src.slice(src.indexOf("async function offerExternalApp("), src.indexOf("function answerExternalApp("));
  assert.match(offer, /via: source\.via, initiatorOrigin: source\.initiatorOrigin, redirectFrom: source\.redirectFrom/);
});
