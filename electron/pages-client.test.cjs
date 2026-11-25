"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const pages = require("./pages-client.cjs");

function fakeClient(result = { ok: true, docId: "doc_1" }) {
  const calls = [];
  return {
    calls,
    async createDoc(title, docKind, content) {
      calls.push({ title, docKind, content });
      return result;
    },
  };
}

const REPORT = {
  question: "How does the podman fleet restart?",
  research_depth: "standard",
  raw_response: "It restarts through fleet-deploy.sh.",
  claims: [
    { text: "Restarts are coalesced in a 20 s window.", sources: [1] },
    { text: "Genesis is in an HA pair.", sources: [1, 2] },
    { text: "Nothing pages when a restart fails.", sources: [], unsourced_reason: "not found" },
    { text: "This claim has no source at all.", sources: [] },
  ],
  sources: [
    { title: "deploy-reality.md", url: "https://example.com/a" },
    { title: "", url: "https://example.com/b" },
  ],
};

test("savePage writes a document, not a canvas", async () => {
  const client = fakeClient();
  const r = await pages.savePage(client, { title: "Notes", markdown: "# Hi\n\nbody" });
  assert.equal(r.ok, true);
  assert.equal(r.docId, "doc_1");
  assert.equal(client.calls.length, 1);
  assert.equal(client.calls[0].docKind, "document");
  assert.equal(client.calls[0].title, "Notes");
  assert.match(client.calls[0].content, /# Hi/);
});

test("savePage names the source page once, even when the body already carries the url", async () => {
  const url = "https://example.com/page";
  const once = fakeClient();
  await pages.savePage(once, { title: "P", markdown: `read ${url}`, sourceUrl: url });
  assert.equal(once.calls[0].content.match(new RegExp(url, "g")).length, 1);

  const added = fakeClient();
  await pages.savePage(added, { title: "P", markdown: "plain body", sourceUrl: url });
  assert.match(added.calls[0].content, /Source: https:\/\/example\.com\/page/);
});

test("savePage falls back to the first heading for a title", async () => {
  const client = fakeClient();
  await pages.savePage(client, { markdown: "## A found heading\n\nbody" });
  assert.equal(client.calls[0].title, "A found heading");
});

test("savePage refuses an empty page and a missing client", async () => {
  const client = fakeClient();
  const empty = await pages.savePage(client, { markdown: "   \n" });
  assert.equal(empty.ok, false);
  assert.match(empty.error, /empty/);
  assert.equal(client.calls.length, 0);

  const none = await pages.savePage(null, { markdown: "x" });
  assert.equal(none.ok, false);
  assert.match(none.error, /AitherOne client/);
});

test("savePage passes a signed-out or refused client answer through unchanged", async () => {
  const signedOut = fakeClient({ ok: false, signedOut: true, error: "sign in" });
  const r1 = await pages.savePage(signedOut, { markdown: "body" });
  assert.deepEqual(r1, { ok: false, signedOut: true, error: "sign in" });

  const refused = fakeClient({ ok: false, status: 403, error: "forbidden" });
  const r2 = await pages.savePage(refused, { markdown: "body" });
  assert.equal(r2.status, 403);
});

test("reportToMarkdown keeps citation numbers 1-based and every source", () => {
  const md = pages.reportToMarkdown(REPORT);
  assert.match(md, /^# How does the podman fleet restart\?/m);
  assert.match(md, /Restarts are coalesced in a 20 s window\. \[1\]/);
  assert.match(md, /Genesis is in an HA pair\. \[1\] \[2\]/);
  assert.match(md, /Nothing pages when a restart fails\. \(unsourced: not found\)/);
  assert.match(md, /This claim has no source at all\. \(unsourced\)/);
  assert.match(md, /^1\. deploy-reality\.md — https:\/\/example\.com\/a$/m);
  assert.match(md, /^2\. https:\/\/example\.com\/b$/m);
});

test("reportToMarkdown never looks better sourced than the report was", () => {
  const bare = pages.reportToMarkdown({ question: "q" });
  assert.match(bare, /\(No claims in this report\)/);
  assert.match(bare, /\(No sources in this report\)/);
  assert.match(bare, /_Depth: not recorded_/);
});

test("researchToPage saves the report as a page titled by its question", async () => {
  const client = fakeClient();
  const r = await pages.researchToPage(client, REPORT);
  assert.equal(r.ok, true);
  assert.equal(client.calls[0].title, "How does the podman fleet restart?");
  assert.equal(client.calls[0].docKind, "document");
  assert.match(client.calls[0].content, /\[1\]/);
  assert.match(client.calls[0].content, /example\.com\/a/);
});
