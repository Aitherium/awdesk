"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { createFilesAccess } = require("./files-access.cjs");
const { createFileAsk, askToolCall, MAX_QUESTION, READ_BYTES } = require("./file-ask.cjs");

/** An ephemeral HTTP server standing in for TokenGate. */
function startServer(handler) {
  return new Promise((resolve, reject) => {
    const server = http.createServer(async (req, res) => {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      let body = null;
      try { body = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { /* leave null */ }
      await handler(req, res, body);
    });
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      resolve({
        url: `http://127.0.0.1:${server.address().port}`,
        close: () => new Promise((done) => server.close(done)),
      });
    });
  });
}

function json(res, status, body) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

/** A shared root with the fixtures every test needs, and the owner's grant ON. */
function sandbox(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "awdesk-file-ask-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const shared = path.join(dir, "shared");
  fs.mkdirSync(path.join(shared, "notes"), { recursive: true });
  fs.writeFileSync(path.join(shared, "notes", "todo.md"), "# todo\nship the ask feature\n");
  fs.writeFileSync(path.join(shared, "blob.bin"), Buffer.from([1, 2, 0, 3]));
  fs.writeFileSync(path.join(shared, "report.pdf"), "%PDF-1.4\nplain enough to look like text\n");
  const castFile = path.join(dir, "cast.json");
  fs.writeFileSync(castFile, JSON.stringify({ version: 1, files: { roots: [
    { path: shared, label: "Shared" },
    { path: path.join(dir, "private"), label: "Private" },
  ] } }));
  fs.mkdirSync(path.join(dir, "private"), { recursive: true });
  fs.writeFileSync(path.join(dir, "private", "diary.txt"), "PLANTED-PRIVATE\n");

  const files = createFilesAccess({ castFile, home: dir });
  const root = files.roots().roots.find((r) => r.label === "Shared");
  files.setAgentRead(root.id, true);
  return { dir, shared, files: files.agent };
}

test("a shared text file is posted as the document and the answer keeps its evidence offsets", async (t) => {
  const s = sandbox(t);
  const seen = [];
  const tokenGate = await startServer((req, res, body) => {
    seen.push({ method: req.method, url: req.url, body });
    json(res, 200, {
      answer: "The todo says to ship the ask feature.",
      evidence: [{ text: "ship the ask feature", start: 8, end: 27, kept: 5 }],
      kept_tokens: 5,
      state_tokens: 5,
      prefill_ms: 12.5,
      request_ms: 30,
      model: "bonsai-test",
      checkpoint: "ck3",
    });
  });
  t.after(() => tokenGate.close());

  const ask = createFileAsk({ files: s.files, askUrl: tokenGate.url });
  const result = await ask.ask({
    root: "Shared", path: "notes/todo.md", question: "  what should I ship?  ",
  });

  assert.equal(result.ok, true);
  assert.equal(result.answer, "The todo says to ship the ask feature.");
  assert.equal(result.reader, "tokengate");
  // The released gates are task-specific; every answer must say so.
  assert.equal(result.reader_label, "read by TokenGate (ck3), experimental");
  assert.equal(result.experimental, true);
  assert.deepEqual(result.evidence, [{ text: "ship the ask feature", start: 8, end: 27, kept: 5 }]);
  assert.equal(result.question, "what should I ship?");
  assert.equal(result.file.rel, "notes/todo.md");
  assert.equal(result.file.truncated, false);

  assert.equal(seen.length, 1);
  assert.equal(seen[0].method, "POST");
  assert.equal(seen[0].url, "/ask");
  assert.equal(seen[0].body.document, "# todo\nship the ask feature\n");
  assert.equal(seen[0].body.question, "what should I ship?");
  assert.equal(seen[0].body.max_kept_tokens, undefined, "not sent unless the caller asked for a cap");
});

test("max_kept_tokens is forwarded when the caller sets it", async (t) => {
  const s = sandbox(t);
  let received = null;
  const tokenGate = await startServer((_req, res, body) => {
    received = body;
    json(res, 200, { answer: "ok", evidence: [] });
  });
  t.after(() => tokenGate.close());

  const result = await createFileAsk({ files: s.files, askUrl: tokenGate.url })
    .ask({ root: "Shared", path: "notes/todo.md", question: "q", maxKeptTokens: 512 });
  assert.equal(result.ok, true);
  assert.equal(received.max_kept_tokens, 512);
});

test("413 is surfaced with the ceiling and the real token sizes", async (t) => {
  const s = sandbox(t);
  const tokenGate = await startServer((_req, res) => json(res, 413, {
    detail: { reason: "state_too_large", state_tokens: 40000, max_state_tokens: 32768 },
  }));
  t.after(() => tokenGate.close());

  const result = await createFileAsk({ files: s.files, askUrl: tokenGate.url })
    .ask({ root: "Shared", path: "notes/todo.md", question: "q" });
  assert.equal(result.ok, false);
  assert.equal(result.status, 413);
  assert.equal(result.reason, "state_too_large");
  assert.equal(result.state_tokens, 40000);
  assert.equal(result.max_state_tokens, 32768);
  assert.match(result.error, /token ceiling/);
});

test("503 says TokenGate is not ready instead of a generic failure", async (t) => {
  const s = sandbox(t);
  const tokenGate = await startServer((_req, res) => json(res, 503, { detail: { reason: "model_loading" } }));
  t.after(() => tokenGate.close());

  const result = await createFileAsk({ files: s.files, askUrl: tokenGate.url })
    .ask({ root: "Shared", path: "notes/todo.md", question: "q" });
  assert.equal(result.ok, false);
  assert.equal(result.status, 503);
  assert.equal(result.reason, "model_loading");
  assert.match(result.error, /not ready/);
});

test("a PDF is refused by name -- nothing is posted, no mojibake answer", async (t) => {
  const s = sandbox(t);
  let calls = 0;
  const tokenGate = await startServer((_req, res) => { calls += 1; json(res, 200, { answer: "x" }); });
  t.after(() => tokenGate.close());

  const result = await createFileAsk({ files: s.files, askUrl: tokenGate.url })
    .ask({ root: "Shared", path: "report.pdf", question: "q" });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "no_text_extractor");
  assert.match(result.error, /no text extractor/);
  assert.equal(calls, 0);
});

test("a binary file with a non-extractor name is refused after the read", async (t) => {
  const s = sandbox(t);
  const tokenGate = await startServer((_req, res) => json(res, 200, { answer: "x" }));
  t.after(() => tokenGate.close());

  const result = await createFileAsk({ files: s.files, askUrl: tokenGate.url })
    .ask({ root: "Shared", path: "blob.bin", question: "q" });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "binary_file");
  assert.match(result.error, /reads text files only/);
});

test("a folder the owner has not shared is refused with files-access's own sentence", async (t) => {
  const s = sandbox(t);
  const result = await createFileAsk({ files: s.files, askUrl: "http://127.0.0.1:1" })
    .ask({ root: "Private", path: "diary.txt", question: "q" });
  assert.equal(result.ok, false);
  assert.match(result.error, /not shared with agents/);
  assert.doesNotMatch(result.error, /PLANTED/);
});

test("TokenGate unreachable names the URL and the health check", async (t) => {
  const s = sandbox(t);
  const gone = await startServer((_req, res) => json(res, 200, {}));
  const url = gone.url;
  await gone.close();

  const result = await createFileAsk({ files: s.files, askUrl: url })
    .ask({ root: "Shared", path: "notes/todo.md", question: "q" });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "unreachable");
  assert.match(result.error, /unreachable/);
  assert.ok(result.error.includes(url));
  assert.match(result.error, /\/health/);
});

test("an empty question, an over-long question and an empty path are refused locally", async (t) => {
  const s = sandbox(t);
  const ask = createFileAsk({ files: s.files, askUrl: "http://127.0.0.1:1" });
  assert.equal((await ask.ask({ root: "Shared", path: "notes/todo.md", question: " " })).error, "empty question");
  assert.match((await ask.ask({ root: "Shared", path: "notes/todo.md", question: "q".repeat(MAX_QUESTION + 1) })).error,
    /longer than/);
  assert.equal((await ask.ask({ root: "Shared", path: "", question: "q" })).error, "empty file path");
});

test("a truncated read is labelled on the result, never silently narrower", async (t) => {
  const s = sandbox(t);
  const long = path.join(s.shared, "long.md");
  fs.writeFileSync(long, "x".repeat(READ_BYTES + 5000));
  let document = null;
  const tokenGate = await startServer((_req, res, body) => {
    document = body.document;
    json(res, 200, { answer: "ok", evidence: [] });
  });
  t.after(() => tokenGate.close());

  const result = await createFileAsk({ files: s.files, askUrl: tokenGate.url })
    .ask({ root: "Shared", path: "long.md", question: "q" });
  assert.equal(result.ok, true);
  assert.equal(result.file.truncated, true);
  assert.match(result.note, /first 100000 bytes/);
  assert.equal(document.length, READ_BYTES);
});

test("askToolCall returns the MCP result shape and marks refusals as errors", async (t) => {
  const s = sandbox(t);
  const tokenGate = await startServer((_req, res) => json(res, 200, { answer: "fine", evidence: [] }));
  t.after(() => tokenGate.close());
  const ask = createFileAsk({ files: s.files, askUrl: tokenGate.url });

  const ok = await askToolCall(ask, { root: "Shared", path: "notes/todo.md", question: "q" });
  assert.equal(ok.isError, false);
  assert.equal(JSON.parse(ok.content[0].text).answer, "fine");

  const refused = await askToolCall(ask, { root: "Private", path: "diary.txt", question: "q" });
  assert.equal(refused.isError, true);
  assert.match(JSON.parse(refused.content[0].text).error, /not shared with agents/);
});
