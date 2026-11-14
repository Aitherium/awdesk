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
const tmp = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), "aither-ext-apps-")), "external.json");

test("the allow-list is exactly the eleven schemes", () => {
  assert.deepEqual(Object.keys(ext.APPS).sort(), ["discord:", "mailto:", "msteams:", "slack:", "sms:", "spotify:", "steam:", "tel:",
    "vscode:", "zoommtg:", "zoomus:"]);
});

test("a listed link from the owner's tab asks, and carries the exact address", () => {
  const url = "zoommtg://zoom.us/join?confno=123456789&pwd=abc%20def";
  const v = ext.judge({ url, tab: owner, pageUrl: PAGE, mainFrame: true });
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
  for (const url of links) assert.equal(ext.judge({ url, tab: owner, pageUrl: PAGE, mainFrame: true }).verdict, "prompt", url);
});

test("an agent's tab gets nothing, whatever the link, the site or a remembered Always", () => {
  const store = ext.createExternalStore({ file: tmp() });
  store.allow(ORIGIN, "mailto:");
  for (const tab of [{ by: "agent", kind: "web" }, { by: "agent", kind: "hosted" }, null, { by: "you", kind: "internal" }, { by: "you", kind: "extension" }]) {
    assert.deepEqual(ext.judge({ url: "mailto:a@b.example", tab, pageUrl: PAGE, mainFrame: true, gesture: true, store }), { verdict: "deny" }, JSON.stringify(tab));
  }
});

test("a scheme that is not on the list stays refused", () => {
  for (const url of ["file:///C:/Windows/System32/calc.exe", "javascript:alert(1)", "ms-msdt:/id PCWDiagnostic", "search-ms:query=x", "ms-officecmd:x",
    "calculator:", "shell:startup", "data:text/html,x", "aither://settings/", "https://example.com/", "tg://resolve?domain=x", "ssh://host", "x-made-up:1", "", null, 42]) {
    assert.deepEqual(ext.judge({ url, tab: owner, pageUrl: PAGE, mainFrame: true }), { verdict: "deny" }, String(url));
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
    assert.deepEqual(ext.judge({ url: "mailto:a@b.example", tab: owner, pageUrl, mainFrame: true }), { verdict: "deny" }, pageUrl);
  }
});

test("Always is remembered per site and per app, and needs the top frame and a page the owner used", () => {
  const store = ext.createExternalStore({ file: tmp(), now: () => 777 });
  assert.equal(store.allow(ORIGIN, "zoommtg:"), true);
  const base = { url: "zoommtg://zoom.us/join?confno=1", tab: owner, pageUrl: PAGE, store };
  assert.equal(ext.judge({ ...base, mainFrame: true, gesture: true }).verdict, "open");
  assert.equal(ext.judge({ ...base, mainFrame: true, gesture: false }).verdict, "prompt", "a page the owner never touched: asked again");
  assert.equal(ext.judge({ ...base, mainFrame: true, gesture: true, sinceAuto: ext.AUTO_OPEN_GAP_MS - 1 }).verdict, "prompt",
    "a second app start right after the first: asked (no launch loop)");
  assert.equal(ext.judge({ ...base, mainFrame: true, gesture: true, sinceAuto: ext.AUTO_OPEN_GAP_MS }).verdict, "open");
  assert.match(ext.INTERACTED_SCRIPT, /navigator\.userActivation\.hasBeenActive/);
  assert.equal(ext.judge({ ...base, mainFrame: false, gesture: true }).verdict, "prompt", "an embedded frame: asked again");
  assert.equal(ext.judge({ ...base, url: "mailto:a@b.example", mainFrame: true, gesture: true }).verdict, "prompt", "another app: asked");
  assert.equal(ext.judge({ ...base, pageUrl: "https://other.example/", mainFrame: true, gesture: true }).verdict, "prompt", "another site: asked");
});

test("Always is not offered InPrivate, on a plain http site or from an embedded frame", () => {
  const offered = (v) => ext.noticeFor(v).actions.map((a) => a.id).includes("external-always");
  const url = "mailto:a@b.example";
  assert.equal(offered(ext.judge({ url, tab: owner, pageUrl: PAGE, mainFrame: true })), true);
  assert.equal(offered(ext.judge({ url, tab: { ...owner, private: true }, pageUrl: PAGE, mainFrame: true })), false);
  assert.equal(offered(ext.judge({ url, tab: owner, pageUrl: "http://plain.example/", mainFrame: true })), false);
  assert.equal(offered(ext.judge({ url, tab: owner, pageUrl: PAGE, mainFrame: false })), false);
  // A remembered Always is not used InPrivate either.
  const store = ext.createExternalStore({ file: tmp() });
  store.allow(ORIGIN, "mailto:");
  assert.equal(ext.judge({ url, tab: { ...owner, private: true }, pageUrl: PAGE, mainFrame: true, gesture: true, store }).verdict, "prompt");
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
