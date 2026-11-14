"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const perms = require("./browser-permissions.cjs");

function tmpFile() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), "awdesk-perm-")), "browser-permissions.json");
}
const OWNER = { by: "you", kind: "web", private: false };
const SITE = "https://meet.test";

test("only the five permissions are ever asked about", () => {
  assert.deepEqual(perms.kindsOf("media", { mediaTypes: ["video", "audio"] }), ["camera", "microphone"]);
  assert.deepEqual(perms.kindsOf("media", { mediaTypes: ["audio"] }), ["microphone"]);
  assert.deepEqual(perms.kindsOf("media", { mediaType: "video" }), ["camera"]);
  assert.deepEqual(perms.kindsOf("media", { mediaType: "unknown" }), []);
  for (const p of ["geolocation", "notifications", "clipboard-read"]) assert.deepEqual(perms.kindsOf(p), [p]);
  for (const p of ["midi", "midiSysex", "hid", "serial", "usb", "bluetooth", "openExternal", "display-capture",
    "pointerLock", "fullscreen", "idle-detection", "window-management", "__proto__", "constructor", ""]) {
    assert.deepEqual(perms.kindsOf(p), [], p);
    assert.equal(perms.decide({ permission: p, url: SITE, tab: OWNER }).verdict, "deny", p);
  }
});

test("only a secure page is asked: https, or this computer", () => {
  assert.equal(perms.promptableOrigin("https://a.test/x?y"), "https://a.test");
  assert.equal(perms.promptableOrigin("http://localhost:8080/x"), "http://localhost:8080");
  assert.equal(perms.promptableOrigin("http://127.0.0.1/"), "http://127.0.0.1");
  for (const url of ["http://a.test/", "file:///C:/x.html", "aither://settings/", "data:text/html,x", "about:blank",
    "https://u:p@a.test/", "chrome-extension://abc/x.html", ""]) {
    assert.equal(perms.promptableOrigin(url), null, url);
    assert.equal(perms.decide({ permission: "geolocation", url, tab: OWNER }).verdict, "deny", url);
  }
});

test("an agent tab is denied without a prompt, even where the owner allowed the site", () => {
  const store = perms.createPermissionStore({ file: tmpFile() });
  store.set(SITE, ["camera", "microphone", "geolocation"], "allow");
  const req = { permission: "media", details: { mediaTypes: ["video"] }, url: `${SITE}/call`, store };
  assert.equal(perms.decide({ ...req, tab: OWNER }).verdict, "allow");
  assert.equal(perms.decide({ ...req, tab: { by: "agent", kind: "web" } }).verdict, "deny");
  assert.equal(perms.decide({ ...req, tab: null }).verdict, "deny", "an unknown sender");
  for (const kind of ["internal", "hosted", "extension"]) {
    assert.equal(perms.decide({ ...req, tab: { by: "you", kind } }).verdict, "deny", kind);
  }
  assert.equal(perms.decide({ ...req, details: { mediaTypes: ["video"], isMainFrame: false }, tab: OWNER }).verdict, "deny",
    "a frame inside the page");
});

test("the first ask prompts; Allow and Block are remembered per site and per kind", () => {
  const file = tmpFile();
  const store = perms.createPermissionStore({ file, now: () => 42 });
  const ask = (permission, details, url = `${SITE}/`) => perms.decide({ permission, details, url, tab: OWNER, store });
  assert.deepEqual(ask("geolocation"), { verdict: "prompt", origin: SITE, kinds: ["geolocation"] });
  assert.equal(store.set(SITE, ["geolocation"], "block"), true);
  assert.equal(ask("geolocation").verdict, "deny");
  assert.equal(ask("notifications").verdict, "prompt", "another kind is still asked");
  assert.equal(ask("geolocation", {}, "https://other.test/").verdict, "prompt", "another site is still asked");
  // Camera allowed, microphone not yet: asking for both still prompts.
  store.set(SITE, ["camera"], "allow");
  assert.equal(ask("media", { mediaTypes: ["video"] }).verdict, "allow");
  assert.equal(ask("media", { mediaTypes: ["video", "audio"] }).verdict, "prompt");
  store.set(SITE, ["microphone"], "block");
  assert.equal(ask("media", { mediaTypes: ["video", "audio"] }).verdict, "deny", "one blocked kind denies the pair");
  // It is on disk, and a second store reads it.
  const again = perms.createPermissionStore({ file });
  assert.deepEqual(again.list().map((r) => [r.origin, r.kind, r.value, r.at]), [
    [SITE, "camera", "allow", 42], [SITE, "microphone", "block", 42], [SITE, "geolocation", "block", 42]]);
  // Revoke: the site is asked again.
  assert.equal(again.remove(SITE, "geolocation"), true);
  assert.equal(perms.decide({ permission: "geolocation", url: SITE, tab: OWNER, store: again }).verdict, "prompt");
  assert.equal(again.remove(SITE), true);
  assert.deepEqual(again.list(), []);
  assert.equal(again.remove(SITE), false);
});

test("the store refuses what it should never hold", () => {
  const store = perms.createPermissionStore({ file: tmpFile() });
  assert.equal(store.set("http://a.test", ["camera"], "allow"), false, "not a secure origin");
  assert.equal(store.set(`${SITE}/path`, ["camera"], "allow"), false, "an address, not an origin");
  assert.equal(store.set(SITE, ["usb"], "allow"), false, "not one of the five");
  assert.equal(store.set(SITE, ["camera"], "maybe"), false);
  assert.deepEqual(store.list(), []);
  // A hand-edited file cannot grant anything else either.
  const file = tmpFile();
  fs.writeFileSync(file, JSON.stringify({ version: 1, sites: {
    "http://evil.test": { camera: { value: "allow" } },
    [SITE]: { usb: { value: "allow" }, camera: { value: "yes" }, notifications: { value: "allow", at: 1 } } } }));
  assert.deepEqual(perms.createPermissionStore({ file }).list().map((r) => `${r.origin} ${r.kind} ${r.value}`),
    [`${SITE} notifications allow`]);
  fs.writeFileSync(file, "{broken");
  assert.deepEqual(perms.createPermissionStore({ file }).list(), []);
});

test("InPrivate is asked every time: Allow does not carry over, Block does", () => {
  const store = perms.createPermissionStore({ file: tmpFile() });
  const priv = { by: "you", kind: "web", private: true };
  store.set(SITE, ["camera"], "allow");
  assert.equal(perms.decide({ permission: "media", details: { mediaTypes: ["video"] }, url: SITE, tab: priv, store }).verdict, "prompt");
  store.set(SITE, ["geolocation"], "block");
  assert.equal(perms.decide({ permission: "geolocation", url: SITE, tab: priv, store }).verdict, "deny");
});

test("the prompt says who wants what", () => {
  assert.equal(perms.promptText("https://meet.test:8443", ["camera", "microphone"]),
    "meet.test:8443 wants to use your camera and use your microphone.");
  assert.equal(perms.promptText(SITE, ["geolocation"]), "meet.test wants to know your location.");
});

test("prompts queue per tab; one answer settles every caller; leaving denies the rest", () => {
  const prompts = perms.createPrompts();
  const got = [];
  const cb = (name) => (allow) => got.push(`${name}:${allow}`);
  assert.equal(prompts.head(1), null);
  const head = prompts.ask(1, { origin: SITE, kinds: ["geolocation"] }, cb("a"));
  assert.equal(head.text, "meet.test wants to know your location.");
  prompts.ask(1, { origin: SITE, kinds: ["geolocation"] }, cb("b")); // the same ask again
  prompts.ask(1, { origin: SITE, kinds: ["notifications"] }, cb("c"));
  prompts.ask(2, { origin: SITE, kinds: ["camera"] }, cb("d"));
  assert.equal(prompts.pending(1), 2);
  assert.deepEqual(prompts.answer(1, false), { origin: SITE, kinds: ["geolocation"] });
  assert.deepEqual(got, ["a:false", "b:false"]);
  assert.deepEqual(prompts.head(1).kinds, ["notifications"]);
  assert.equal(prompts.cancel(1), 1);
  assert.deepEqual(got, ["a:false", "b:false", "c:false"]);
  assert.equal(prompts.answer(1, true), null, "nothing left to answer");
  assert.deepEqual(prompts.answer(2, true), { origin: SITE, kinds: ["camera"] });
  assert.deepEqual(got, ["a:false", "b:false", "c:false", "d:true"]);
});
