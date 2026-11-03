"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const ops = require("./spirit-ops.cjs");

function tmpDir(prefix = "spirit-ops-") {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function searchClientReturning(result) {
  return {
    mode: null,
    calls: [],
    async search(mode, query, opts) {
      this.mode = mode;
      this.calls.push({ mode, query, opts });
      return result;
    },
  };
}

// ── find a file: the desk's own universal search ──────────────────────────

test("findFiles asks universal-search and returns the top five rows", async () => {
  const seen = [];
  const universal = () => ({
    run: async (q, opts) => {
      seen.push({ q, opts });
      return {
        ok: true,
        query: q,
        groups: [
          { id: "files", total: 2, items: [
            { kind: "file", title: "notes.md", target: "C:\\a\\notes.md" },
            { kind: "file", title: "plan.md", target: "C:\\a\\plan.md" },
          ] },
        ],
      };
    },
  });
  const spirit = ops.createSpiritOps({ universal });
  const r = await spirit.findFiles("notes");
  assert.equal(r.ok, true);
  assert.deepEqual(r.rows.map((x) => x.title), ["notes.md", "plan.md"]);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].q, "notes");
  assert.equal(seen[0].opts.phase, "all");
});

test("findFiles says what is wrong instead of throwing", async () => {
  assert.equal((await ops.createSpiritOps({}).findFiles("x")).ok, false);
  const broken = ops.createSpiritOps({ universal: () => ({ run: async () => { throw new Error("index locked"); } }) });
  const r = await broken.findFiles("x");
  assert.equal(r.ok, false);
  assert.match(r.reason, /index locked/);
  assert.equal((await broken.findFiles("  ")).ok, false);
});

// ── web search: awfind through search-client ─────────────────────────────

test("webSearch maps awfind's links and keeps its answer", async () => {
  const client = searchClientReturning({
    ok: true,
    query: "bonsai",
    answer: "Bonsai 2 is a small model.",
    results: [
      { title: "Bonsai", url: "https://example.com/bonsai", snippet: "small", source: "web" },
    ],
  });
  const spirit = ops.createSpiritOps({ searchClient: client });
  const r = await spirit.webSearch("bonsai", { answer: true });
  assert.equal(r.ok, true);
  assert.equal(client.mode, "answer");
  assert.equal(r.answer, "Bonsai 2 is a small model.");
  assert.equal(r.rows[0].domain, "example.com");
  assert.equal(r.total, 1);
});

test("a missing awfind is a loud refusal, never a silent empty list", async () => {
  const client = {
    async search() {
      const error = new Error("awfind is not installed (pip install -e the awfind package)");
      error.code = "ENOENT";
      throw error;
    },
  };
  const spirit = ops.createSpiritOps({ searchClient: client });
  const r = await spirit.webSearch("anything");
  assert.equal(r.ok, false);
  assert.match(r.line, /^1 search refused — /);
  assert.match(r.line, /awfind is not installed/);
  assert.deepEqual(r.rows, []);
});

test("a lazy search-client factory is resolved, so the first search itself works", async () => {
  const client = searchClientReturning({ ok: true, results: [{ title: "A", url: "https://example.com/a" }] });
  let made = 0;
  const spirit = ops.createSpiritOps({ searchClient: () => { made += 1; return client; } });
  const r = await spirit.webSearch("anything");
  assert.equal(r.ok, true);
  assert.equal(r.rows.length, 1);
  assert.equal(made, 1);
});

test("a web query with no client or no words refuses in words", async () => {
  assert.equal((await ops.createSpiritOps({}).webSearch("x")).ok, false);
  const r = await ops.createSpiritOps({ searchClient: searchClientReturning({ ok: true, results: [] }) }).webSearch(" ");
  assert.equal(r.ok, false);
  assert.match(r.line, /type something to search for/);
});

test("readWeb uses the answer lane and refuses a non-http target", async () => {
  const client = searchClientReturning({ ok: true, answer: "The page says hello.", results: [] });
  const spirit = ops.createSpiritOps({ searchClient: client });
  const r = await spirit.readWeb("https://example.com/page", "what does it say");
  assert.equal(r.ok, true);
  assert.equal(r.answer, "The page says hello.");
  assert.match(client.calls[0].query, /^https:\/\/example\.com\/page/);
  assert.equal((await spirit.readWeb("file:///etc/passwd")).ok, false);
});

test("a page awfind cannot read is refused with a line", async () => {
  const client = searchClientReturning({ ok: true, answer: null, results: [] });
  const spirit = ops.createSpiritOps({ searchClient: client });
  const r = await spirit.readWeb("https://example.com/page");
  assert.equal(r.ok, false);
  assert.match(r.line, /1 page refused/);
});

// ── reading a file: the refusal is BEFORE the bytes ──────────────────────

test("a credential is refused before the filesystem is touched", async () => {
  let statCalls = 0;
  const fsImpl = {
    statSync() { statCalls += 1; throw new Error("must not be reached"); },
  };
  const spirit = ops.createSpiritOps({ fsImpl });
  const r = await spirit.readFile("C:\\Users\\wzns\\.env", "what is in it");
  assert.equal(r.ok, false);
  assert.equal(r.refused, true);
  assert.equal(r.line, "1 file refused — it looks like a credential");
  assert.equal(statCalls, 0, "no stat, no open, no answer");
});

test("readFile hands file-ask the owner's file and the default question", async () => {
  const dir = tmpDir();
  const file = path.join(dir, "notes.md");
  fs.writeFileSync(file, "# Notes\nRemember this.");
  const asked = [];
  const fileAsk = {
    async ask(payload) {
      asked.push(payload);
      return { ok: true, answer: "It is a note about remembering.", evidence: [], reader: "test" };
    },
  };
  const spirit = ops.createSpiritOps({ fileAsk });
  const r = await spirit.readFile(file);
  assert.equal(r.ok, true);
  assert.equal(r.answer, "It is a note about remembering.");
  assert.equal(asked[0].root, dir);
  assert.equal(asked[0].path, "notes.md");
  assert.equal(asked[0].question, ops.DEFAULT_READ_QUESTION);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("readFile refuses a missing file and reports file-ask's own sentence", async () => {
  const dir = tmpDir();
  const spirit = ops.createSpiritOps({ fileAsk: { ask: async () => ({ ok: false, error: "This PDF is scanned; no text." }) } });
  const missing = await spirit.readFile(path.join(dir, "gone.md"));
  assert.equal(missing.ok, false);
  assert.match(missing.reason, /not there/);
  const pdf = path.join(dir, "scan.pdf");
  fs.writeFileSync(pdf, "%PDF-1.4");
  const r = await spirit.readFile(pdf);
  assert.equal(r.ok, false);
  assert.match(r.line, /scanned/);
  fs.rmSync(dir, { recursive: true, force: true });
});

// ── a folder is names, never contents ────────────────────────────────────

test("listFolder lists names, counts the rest, and never reads them", async () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, "a.md"), "x");
  fs.writeFileSync(path.join(dir, "b.txt"), "y");
  fs.mkdirSync(path.join(dir, "sub"));
  const spirit = ops.createSpiritOps({});
  const r = await spirit.listFolder(dir);
  assert.equal(r.ok, true);
  assert.equal(r.total, 3);
  assert.deepEqual(r.rows.map((x) => x.title).sort(), ["a.md", "b.txt", "sub"]);
  assert.equal(r.rows.find((x) => x.title === "sub").kind, "folder");
  assert.equal(r.rows.find((x) => x.title === "a.md").kind, "file");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("listFolder refuses a credential folder and a missing folder", async () => {
  const spirit = ops.createSpiritOps({});
  const refused = await spirit.listFolder("C:\\Users\\wzns\\.ssh");
  assert.equal(refused.ok, false);
  assert.equal(refused.refused, true);
  const missing = await spirit.listFolder(path.join(tmpDir(), "nope"));
  assert.equal(missing.ok, false);
  assert.match(missing.reason, /could not be listed/);
});

// ── the direct-file reader file-ask is given ─────────────────────────────

test("createDirectFiles refuses a credential, flags binary and truncates", () => {
  const dir = tmpDir();
  const text = path.join(dir, "notes.md");
  fs.writeFileSync(text, "hello world");
  const files = ops.createDirectFiles({});
  const got = files.read(dir, "notes.md");
  assert.equal(got.text, "hello world");
  assert.equal(got.binary, false);
  assert.equal(got.truncated, false);

  const binary = path.join(dir, "image.bin");
  fs.writeFileSync(binary, Buffer.from([1, 0, 2, 0, 3]));
  const bin = files.read(dir, "image.bin");
  assert.equal(bin.binary, true);
  assert.equal(bin.text, "");

  assert.throws(() => files.read(dir, ".env"), /credential/);
  fs.rmSync(dir, { recursive: true, force: true });
});
