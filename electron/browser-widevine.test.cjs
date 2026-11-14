"use strict";

/**
 * The pure parts of Widevine support: the status mapping, the more-menu line, which
 * notice a DRM page gets, and the holder around Electron's `components` (faked here).
 * The live proof (a real CDM, a real encrypted stream) is browser-widevine-smoke.cjs.
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const w = require("./browser-widevine.cjs");

const ID = w.WIDEVINE_CDM_ID;
const installed = { [ID]: { status: "updated", title: "Widevine Content Decryption Module", version: "4.10.3112.0" } };
const absent = { [ID]: { status: "not-installed", title: "Widevine Content Decryption Module", version: null } };

test("stock Electron (no components API) is 'missing', whatever else is passed", () => {
  const s = w.widevineSnapshot({ hasApi: false, phase: "ready", record: installed });
  assert.deepEqual(s, { state: "missing", build: "stock", version: null, status: null, error: "" });
  assert.equal(w.widevineSnapshot().state, "missing");
});

test("the status mapping: installing, ready, failed", () => {
  assert.equal(w.widevineSnapshot({ hasApi: true, phase: "idle", record: absent }).state, "installing");
  assert.equal(w.widevineSnapshot({ hasApi: true, phase: "installing", record: absent }).state, "installing");
  const ready = w.widevineSnapshot({ hasApi: true, phase: "ready", record: installed });
  assert.equal(ready.state, "ready");
  assert.equal(ready.version, "4.10.3112.0");
  assert.equal(ready.build, "castlabs");
  // Installed on an earlier run: usable before this run's promise settles.
  assert.equal(w.widevineSnapshot({ hasApi: true, phase: "installing", record: installed }).state, "ready");
  assert.equal(w.widevineSnapshot({ hasApi: true, phase: "idle", record: { [ID]: { status: "up-to-date", version: "4.10.1" } } }).state, "ready");
  // The promise resolved but no CDM is there: that is a failure, never "ready".
  const hollow = w.widevineSnapshot({ hasApi: true, phase: "ready", record: absent });
  assert.equal(hollow.state, "failed");
  assert.match(hollow.error, /did not install/);
  const failed = w.widevineSnapshot({ hasApi: true, phase: "failed", record: installed, error: "offline" });
  assert.equal(failed.state, "failed");
  assert.equal(failed.error, "offline");
  // A broken status record never throws.
  assert.equal(w.widevineSnapshot({ hasApi: true, phase: "idle", record: "nonsense" }).state, "installing");
});

test("the more-menu line names the state", () => {
  assert.match(w.widevineMenuLabel({ state: "ready", version: "4.10.3112.0" }), /on \(Widevine 4\.10\.3112\.0\)/);
  assert.match(w.widevineMenuLabel({ state: "installing" }), /installing/);
  assert.match(w.widevineMenuLabel({ state: "failed" }), /did not install/);
  assert.match(w.widevineMenuLabel({ state: "missing" }), /opens in Edge/);
  assert.match(w.widevineMenuLabel(null), /opens in Edge/);
});

test("the notice decision: Edge is offered ONLY when Widevine is unavailable", () => {
  const base = { needsDrm: true, tabBy: "you", hasEdge: true, url: "https://www.netflix.com/", host: "www.netflix.com" };
  assert.equal(w.drmNotice({ ...base, snap: { state: "ready" } }), null, "ready: the page just plays");
  const missing = w.drmNotice({ ...base, snap: { state: "missing" } });
  assert.equal(missing.kind, "drm");
  assert.deepEqual(missing.actions.map((a) => a.id), ["open-edge", "drm-stay"]);
  assert.deepEqual(missing.data, { url: base.url, host: base.host });
  const failed = w.drmNotice({ ...base, snap: { state: "failed" } });
  assert.equal(failed.kind, "drm");
  assert.match(failed.text, /did not install/);
  const wait = w.drmNotice({ ...base, snap: { state: "installing" } });
  assert.equal(wait.kind, "drm-wait");
  assert.deepEqual(wait.actions, []);
  // No snapshot at all is treated as missing, never as ready.
  assert.equal(w.drmNotice({ ...base, snap: null }).kind, "drm");
});

test("the notice decision: never for an agent tab, a non-DRM page, a stayed host, or no Edge", () => {
  const base = { needsDrm: true, tabBy: "you", hasEdge: true, snap: { state: "missing" } };
  assert.equal(w.drmNotice({ ...base, tabBy: "agent" }), null);
  assert.equal(w.drmNotice({ ...base, tabBy: "agent", snap: { state: "installing" } }), null);
  assert.equal(w.drmNotice({ ...base, needsDrm: false }), null);
  assert.equal(w.drmNotice({ ...base, stayed: true }), null);
  assert.equal(w.drmNotice({ ...base, hasEdge: false }), null);
  assert.equal(w.drmNotice(), null);
});

function fakeComponents({ fail = null, hang = false } = {}) {
  let record = absent;
  const calls = [];
  return {
    calls,
    WIDEVINE_CDM_ID: ID,
    status: () => record,
    whenReady: (required) => {
      calls.push(required);
      if (hang) return new Promise(() => {});
      if (fail) return Promise.reject(fail);
      record = installed;
      return Promise.resolve([]);
    },
  };
}

test("the holder: without `components` nothing is called and nothing throws", async () => {
  for (const components of [undefined, null, {}, { whenReady: () => {} }]) {
    const wv = w.createWidevine({ components });
    assert.equal(wv.hasApi, false);
    assert.equal(wv.snapshot().state, "missing");
    assert.equal((await wv.ensure()).state, "missing");
  }
});

test("the holder: installs once, requires only the Widevine CDM, reports ready", async () => {
  const components = fakeComponents();
  const wv = w.createWidevine({ components });
  assert.equal(wv.snapshot().state, "installing");
  const [a, b] = await Promise.all([wv.ensure(), wv.ensure()]);
  assert.equal(a.state, "ready");
  assert.equal(b.version, "4.10.3112.0");
  assert.deepEqual(components.calls, [[ID]], "one whenReady call, for the Widevine CDM only");
  await wv.ensure({ retry: true });
  assert.equal(components.calls.length, 1, "retry does nothing once it is ready");
});

test("the holder: a failed install never rejects, carries the reasons, and can be retried", async () => {
  const error = Object.assign(new Error("Components failed"), { errors: [new Error("net::ERR_INTERNET_DISCONNECTED")] });
  const components = fakeComponents({ fail: error });
  const logged = [];
  const wv = w.createWidevine({ components, log: (m) => logged.push(m) });
  const snap = await wv.ensure();
  assert.equal(snap.state, "failed");
  assert.match(snap.error, /Components failed; net::ERR_INTERNET_DISCONNECTED/);
  assert.equal(logged.length, 1);
  await wv.ensure();
  assert.equal(components.calls.length, 1, "a plain ensure() does not hammer a failed install");
  await wv.ensure({ retry: true });
  assert.equal(components.calls.length, 2, "retry asks again");
});

test("the holder: an install that never settles times out as failed", async () => {
  const wv = w.createWidevine({ components: fakeComponents({ hang: true }), timeoutMs: 20 });
  const snap = await wv.ensure();
  assert.equal(snap.state, "failed");
  assert.match(snap.error, /not ready after/);
});

test("the wiring: main starts the install guarded, and only this module touches `components`", () => {
  const fs = require("node:fs");
  const path = require("node:path");
  const main = fs.readFileSync(path.join(__dirname, "main.cjs"), "utf8");
  assert.match(main, /try \{ void require\("\.\/browser-widevine\.cjs"\)\.getWidevine\(\)\.ensure\(\); \} catch/);
  const win = fs.readFileSync(path.join(__dirname, "browser-window.cjs"), "utf8");
  assert.doesNotMatch(win, /components\.(whenReady|status)/);
  assert.doesNotMatch(main, /components\.(whenReady|status)/);
});
