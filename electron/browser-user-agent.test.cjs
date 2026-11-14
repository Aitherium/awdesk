"use strict";

// Sites saw "Electron/39.x" and the app's own token, so Google sign-in and banks refused
// the Aither Browser. Pages now get the plain Chrome string, on the session and on the
// app-wide fallback a popup and a service worker read.

const test = require("node:test");
const assert = require("node:assert/strict");
const { chromeUserAgent, install, namesTheApp } = require("./browser-user-agent.cjs");

const BASE = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko)";
const DEV = `${BASE} Chrome/142.0.7444.265 Electron/39.8.10 Safari/537.36`;
const PACKAGED = `${BASE} awdesk/0.1.31 Chrome/142.0.7444.265 Electron/39.8.10 Safari/537.36`;
const PLAIN = `${BASE} Chrome/142.0.0.0 Safari/537.36`;

test("the Electron token and the app's own token are removed; Chrome's version is reduced like real Chrome", () => {
  assert.equal(chromeUserAgent(DEV), PLAIN);
  assert.equal(chromeUserAgent(PACKAGED), PLAIN);
  assert.equal(chromeUserAgent(`${BASE} Aither/2 Chrome/142.0.7444.265 Electron/39.8.10 Safari/537.36`), PLAIN, "any product name, not a fixed list");
  assert.equal(chromeUserAgent(PLAIN), PLAIN, "already plain: unchanged");
  assert.ok(!/Electron|awdesk/i.test(chromeUserAgent(PACKAGED)));
});

test("other platforms keep their platform comment", () => {
  const mac = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) awdesk/0.1.31 Chrome/142.0.7444.265 Electron/39.8.10 Safari/537.36";
  assert.equal(chromeUserAgent(mac), "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36");
});

test("a string that is not a Chromium user agent is never rewritten", () => {
  for (const bad of ["", null, undefined, "curl/8.0", "Mozilla/5.0 (X11) Gecko/20100101 Firefox/130.0", `${BASE} Electron/39.8.10`]) {
    assert.equal(chromeUserAgent(bad), "", String(bad));
  }
});

test("namesTheApp tells a leaking user agent from the plain one", () => {
  assert.equal(namesTheApp(DEV), true);
  assert.equal(namesTheApp(PACKAGED), true);
  assert.equal(namesTheApp(PLAIN), false);
});

test("install sets the session and the app-wide fallback (a popup and a service worker read the fallback)", () => {
  const app = { userAgentFallback: PACKAGED };
  let sessionUa = PACKAGED;
  const sets = [];
  const ses = { getUserAgent: () => sessionUa, setUserAgent: (ua) => { sets.push(ua); sessionUa = ua; } };
  assert.equal(install(ses, app), PLAIN);
  assert.equal(app.userAgentFallback, PLAIN);
  assert.deepEqual(sets, [PLAIN]);
  // A second session after the fallback is already plain: still set; nothing set twice.
  let second = DEV;
  const ses2 = { getUserAgent: () => second, setUserAgent: (ua) => { second = ua; } };
  assert.equal(install(ses2, app), PLAIN);
  assert.equal(second, PLAIN);
  assert.equal(install(ses, app), PLAIN);
  assert.deepEqual(sets, [PLAIN], "an already-plain session is not set again");
});

test("install leaves a user agent it cannot read alone", () => {
  const app = { userAgentFallback: "something else" };
  const ses = { getUserAgent: () => "something else", setUserAgent: () => { throw new Error("must not be called"); } };
  assert.equal(install(ses, app), "");
  assert.equal(app.userAgentFallback, "something else");
});
