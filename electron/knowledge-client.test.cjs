"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { createKnowledgeClient, queryFromPage } = require("./knowledge-client.cjs");

function fake(responses) {
  const calls = [];
  const callTool = async (name, args) => {
    calls.push([name, args]);
    const r = responses[name];
    if (r instanceof Error) throw r;
    return typeof r === "function" ? r(args) : JSON.stringify(r || {});
  };
  return { calls, client: createKnowledgeClient({ callTool }) };
}

test("the page's title (minus its site suffix) is the query; a bare host when there is no title", () => {
  assert.equal(queryFromPage({ title: "Podman quadlets explained — Red Hat Blog" }), "Podman quadlets explained");
  assert.equal(queryFromPage({ title: "r/reddit | reddit" }), "r/reddit");
  assert.equal(queryFromPage({ title: "", url: "https://www.example.com/x" }), "example.com");
});

test("related: notes and memories for the page, each half failing alone", async () => {
  const { client } = fake({
    notes_search: { matches: [{ id: "n1", title: "Quadlets", content: "notes body" }] },
    recall: new Error("memory down"),
  });
  const r = await client.related({ title: "Quadlets — Blog", url: "https://x.test/" });
  assert.equal(r.ok, true);
  assert.deepEqual(r.notes.map((n) => n.id), ["n1"]);
  assert.deepEqual(r.memories, []);
  assert.match(r.errors[0], /memory: memory down/);
});

test("save page: title, address, selection and comment -- never unselected page text", async () => {
  const { client, calls } = fake({ notes_add: { note: { id: "n9", title: "T" } } });
  const r = await client.savePage({ title: "T", url: "https://x.test/a", selection: "picked", comment: "why" });
  assert.equal(r.ok, true);
  const [name, args] = calls[0];
  assert.equal(name, "notes_add");
  assert.equal(args.content, "https://x.test/a\n\nwhy\n\n> picked");
  assert.equal((await client.savePage({ url: "aither://settings/" })).ok, false, "only web pages");
});

test("remember: the chosen text plus where it came from; empty is refused before any call", async () => {
  const { client, calls } = fake({ remember: { success: true } });
  assert.equal((await client.rememberText({ text: "  " })).ok, false);
  assert.equal(calls.length, 0);
  const r = await client.rememberText({ text: "Quadlets are systemd units", title: "Blog", url: "https://x.test/" });
  assert.equal(r.ok, true);
  assert.match(calls[0][1].content, /Source: Blog https:\/\/x\.test\//);
  assert.equal(calls[0][1].category, "browsing");
});

test("notes list vs search; a bad note id never reaches the gateway", async () => {
  const { client, calls } = fake({ notes_list: { notes: [{ id: "a", title: "A" }] }, notes_search: { matches: [] } });
  assert.equal((await client.listNotes()).notes.length, 1);
  await client.listNotes({ query: "x" });
  assert.deepEqual(calls.map((c) => c[0]), ["notes_list", "notes_search"]);
  assert.equal((await client.viewNote("../etc")).ok, false);
  assert.equal(calls.length, 2);
});
