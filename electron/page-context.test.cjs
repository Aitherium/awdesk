"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const pageContext = require("./page-context.cjs");

test("page context: the newest page is briefed as untrusted data, then goes stale", () => {
  pageContext.clearPage();
  assert.equal(pageContext.brief(), "");
  pageContext.setPage({ type: "awconnect.page", url: "https://example.com/", title: "Ex", selection: "sel" }, 1000);
  const text = pageContext.brief(2000);
  assert.match(text, /untrusted web content/);
  assert.match(text, /https:\/\/example\.com\//);
  assert.match(text, /sel/);
  assert.equal(pageContext.brief(1000 + pageContext.MAX_AGE_MS + 1), "");
  assert.equal(pageContext.setPage({ type: "state" }), null);
  pageContext.clearPage();
});
