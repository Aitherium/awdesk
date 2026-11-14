"use strict";

// A crashed page and a followed link that did not load both left the tab blank.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { ERR_ABORTED, crashNotice, failedLoad } = require("./browser-page-errors.cjs");

test("a crashed renderer raises a notice with Reload; a clean exit raises nothing", () => {
  const n = crashNotice({ reason: "crashed" });
  assert.equal(n.kind, "crashed");
  assert.equal(n.text, "This page crashed.");
  assert.deepEqual(n.actions.map((a) => a.id), ["crash-reload", "dismiss"]);
  assert.equal(crashNotice({ reason: "oom" }).text, "This page ran out of memory.");
  assert.equal(crashNotice({ reason: "killed" }).text, "This page crashed.");
  assert.equal(crashNotice(undefined).text, "This page crashed.");
  assert.equal(crashNotice({ reason: "clean-exit" }), null);
});

test("a main-frame web load that failed gets the error page, with the reason", () => {
  assert.deepEqual(failedLoad({ code: -102, desc: "ERR_CONNECTION_REFUSED", url: "http://localhost:9/x", isMainFrame: true }),
    { url: "http://localhost:9/x", reason: "ERR_CONNECTION_REFUSED (-102)" });
  assert.deepEqual(failedLoad({ code: -105, url: "https://nope.example/", isMainFrame: true }),
    { url: "https://nope.example/", reason: "the page did not load (-105)" });
});

test("an aborted navigation, a frame, a non-web address and a non-error code show nothing", () => {
  assert.equal(failedLoad({ code: ERR_ABORTED, desc: "ERR_ABORTED", url: "https://a.example/file.zip", isMainFrame: true }), null);
  assert.equal(failedLoad({ code: -102, url: "https://ads.example/", isMainFrame: false }), null);
  for (const url of ["data:text/html,x", "aither://settings/", "chrome-error://chromewebdata/", "about:blank", "", null]) {
    assert.equal(failedLoad({ code: -102, url, isMainFrame: true }), null, String(url));
  }
  assert.equal(failedLoad({ code: 0, url: "https://a.example/", isMainFrame: true }), null);
  assert.equal(failedLoad({ code: "x", url: "https://a.example/", isMainFrame: true }), null);
  assert.equal(failedLoad(), null);
});

test("browser-window wires both, and leaves a load the address bar started to its own error page", () => {
  const src = fs.readFileSync(path.join(__dirname, "browser-window.cjs"), "utf8");
  const wire = src.slice(src.indexOf("function wirePageGaps("), src.indexOf("function openFromPage("));
  assert.match(wire, /"render-process-gone"/);
  assert.match(wire, /pageErrors\.crashNotice\(/);
  assert.match(wire, /pageErrors\.failedLoad\(/);
  assert.match(wire, /loaderBusy\.has\(wc\)/, "loadInView shows its own error page; never two");
});
