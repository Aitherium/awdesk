"use strict";

// upload-notices: a paused, finished or failed workspace upload earns ONE native notice per
// upload per state; no workspace, no session or an old image without the route is silence.
const test = require("node:test");
const assert = require("node:assert/strict");
const U = require("./upload-notices.cjs");

const ORIGIN = "https://ws.example.aitherium.com/";

function uploading(over = {}) {
  return { id: "upload:u1", upload_id: "u1", job_id: null, filename: "projects.zip",
    size: 1000, received_bytes: 510, received_chunks: 101, total_chunks: 199,
    idle_seconds: 10, state: "uploading", detail: "101 of 199 pieces received", ...over };
}
function processing(over = {}) {
  return { id: "job:j1", upload_id: "u1", job_id: "j1", filename: "projects.zip",
    state: "processing", detail: "reading files (3 of 42)", processed_files: 3, total_files: 42, ...over };
}

function harness(replies, { origin = ORIGIN, appName = "Acme Docs", stored = {} } = {}) {
  const calls = [];
  const shown = [];
  const opened = [];
  const saved = [];
  let t = 1_000_000;
  const n = U.createUploadNotices({
    origin: () => origin,
    appName: () => appName,
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      const r = replies.shift();
      if (r instanceof Error) throw r;
      const reply = r || { status: 200, body: { uploads: [] } };
      return {
        ok: reply.status >= 200 && reply.status < 300,
        status: reply.status,
        json: async () => { if (reply.body === undefined) throw new SyntaxError("html"); return reply.body; },
      };
    },
    notify: (title, body, onClick) => shown.push({ title, body, onClick }),
    open: (url) => opened.push(url),
    store: { load: () => stored, save: (o) => saved.push({ ...o }) },
    now: () => t,
    schedule: () => {},
  });
  return { n, calls, shown, opened, saved, advance: (ms) => { t += ms; } };
}

test("an upload idle past two minutes is called paused, with the percent and the way back", async () => {
  const h = harness([{ status: 200, body: { uploads: [uploading({ idle_seconds: 121 })] } }]);
  const delay = await h.n.tick();
  assert.equal(h.calls[0].url, "https://ws.example.aitherium.com/api/documents/uploads");
  assert.equal(h.calls[0].init.redirect, "manual");
  assert.equal(h.shown.length, 1);
  assert.equal(h.shown[0].title, "Upload paused");
  assert.equal(h.shown[0].body,
    "Your upload of projects.zip paused at 51%. Open Acme Docs and drop the same file to resume.");
  assert.equal(delay, U.ACTIVE_MS);
  h.shown[0].onClick();
  assert.deepEqual(h.opened, [ORIGIN]);
});

test("an upload still moving, or with every piece in, is not paused", async () => {
  const h = harness([
    { status: 200, body: { uploads: [uploading({ idle_seconds: 119 })] } },
    { status: 200, body: { uploads: [uploading({ idle_seconds: 900, received_chunks: 199, received_bytes: 1000 })] } },
  ]);
  await h.n.tick();
  await h.n.tick();
  assert.equal(h.shown.length, 0);
});

test("processing that leaves the list is ready, with the number of files", async () => {
  const h = harness([
    { status: 200, body: { uploads: [uploading()] } },
    { status: 200, body: { uploads: [processing()] } },
    { status: 200, body: { uploads: [] } },
  ]);
  await h.n.tick();
  await h.n.tick();
  assert.equal(h.shown.length, 0, "uploading and processing are not news");
  const delay = await h.n.tick();
  assert.equal(h.shown.length, 1);
  assert.equal(h.shown[0].title, "Upload finished");
  assert.equal(h.shown[0].body, "projects.zip is ready. 42 files added to Documents.");
  assert.equal(delay, U.ACTIVE_MS, "recently active: keep the fast cadence a while");
});

test("one file reads singular; an unknown count still says ready", () => {
  assert.equal(U.COPY.ready("a.pdf", 1).body, "a.pdf is ready. 1 file added to Documents.");
  assert.equal(U.COPY.ready("a.pdf", 0).body, "a.pdf is ready. It's in Documents now.");
});

test("an uploading row that disappears (abandoned, expired) says nothing", async () => {
  const h = harness([
    { status: 200, body: { uploads: [uploading()] } },
    { status: 200, body: { uploads: [] } },
  ]);
  await h.n.tick();
  await h.n.tick();
  assert.equal(h.shown.length, 0);
});

test("a failure is told with the server's reason", async () => {
  const reason = "The zip could not be opened. It may be damaged; try zipping it again.";
  const h = harness([{ status: 200, body: { uploads: [processing({ state: "failed", detail: reason })] } }]);
  await h.n.tick();
  assert.equal(h.shown.length, 1);
  assert.equal(h.shown[0].title, "Upload failed");
  assert.equal(h.shown[0].body, `projects.zip could not be added. ${reason}`);
});

test("no nag: the same state is told once, across polls and across a restart", async () => {
  const paused = { status: 200, body: { uploads: [uploading({ idle_seconds: 400 })] } };
  const failed = { status: 200, body: { uploads: [processing({ state: "failed", detail: "Disk full." })] } };
  const h = harness([paused, paused, paused, failed, failed]);
  for (let i = 0; i < 5; i += 1) { await h.n.tick(); h.advance(30_000); }
  assert.deepEqual(h.shown.map((s) => s.title), ["Upload paused", "Upload failed"]);

  // A Desk restart reads the remembered notices back: nothing is said again.
  const stored = h.n.shown();
  assert.deepEqual(Object.keys(stored).sort(), ["u1:failed", "u1:paused"]);
  const again = harness([paused, failed], { stored });
  await again.n.tick();
  await again.n.tick();
  assert.equal(again.shown.length, 0);
});

test("a remembered notice expires after KEEP_MS", async () => {
  const h = harness([{ status: 200, body: { uploads: [uploading({ idle_seconds: 400 })] } }],
    { stored: { "u1:paused": 1_000_000 - U.KEEP_MS - 1 } });
  await h.n.tick();
  assert.equal(h.shown.length, 1);
});

test("an old workspace image (404) is silence and backs off", async () => {
  const h = harness([{ status: 404 }]);
  assert.equal(await h.n.tick(), U.MISSING_MS);
  assert.equal(h.shown.length, 0);
});

test("no session (401, a redirect to sign-in, an HTML answer) is silence", async () => {
  for (const reply of [{ status: 401 }, { status: 403 }, { status: 302 }, { status: 0 }, { status: 200 }]) {
    const h = harness([reply]);
    assert.equal(await h.n.tick(), U.DISCOVER_MS);
    assert.equal(h.shown.length, 0);
  }
});

test("signing out mid-processing never turns into a false 'ready'", async () => {
  const h = harness([
    { status: 200, body: { uploads: [processing()] } },
    { status: 401 },
    { status: 200, body: { uploads: [] } },
  ]);
  await h.n.tick();
  await h.n.tick();
  await h.n.tick();
  assert.equal(h.shown.length, 0);
});

test("a network error keeps what was seen: processing then gone is still ready", async () => {
  const h = harness([
    { status: 200, body: { uploads: [processing()] } },
    new Error("ECONNRESET"),
    { status: 200, body: { uploads: [] } },
  ]);
  await h.n.tick();
  assert.equal(await h.n.tick(), U.ERROR_MS);
  await h.n.tick();
  assert.equal(h.shown.length, 1);
  assert.equal(h.shown[0].title, "Upload finished");
});

test("no workspace host: nothing is fetched", async () => {
  const h = harness([], { origin: "" });
  assert.equal(await h.n.tick(), U.DISCOVER_MS);
  assert.equal(h.calls.length, 0);
  const plain = harness([], { origin: "http://ws.example.aitherium.com/" });
  await plain.n.tick();
  assert.equal(plain.calls.length, 0, "never send the session over plain http");
});

test("cadence: slow discovery when idle, fast while an upload is listed or just left", async () => {
  const h = harness([
    { status: 200, body: { uploads: [] } },
    { status: 200, body: { uploads: [uploading()] } },
    { status: 200, body: { uploads: [] } },
    { status: 200, body: { uploads: [] } },
  ]);
  assert.equal(await h.n.tick(), U.DISCOVER_MS);
  assert.equal(await h.n.tick(), U.ACTIVE_MS);
  h.advance(60_000);
  assert.equal(await h.n.tick(), U.ACTIVE_MS);
  h.advance(U.RECENT_MS);
  assert.equal(await h.n.tick(), U.DISCOVER_MS);
});

test("no workspace name falls back to 'your workspace'; file names are cleaned", async () => {
  const h = harness([{ status: 200, body: { uploads: [uploading({ idle_seconds: 400, filename: "a\nb.zip" })] } }],
    { appName: "" });
  await h.n.tick();
  assert.equal(h.shown[0].body,
    "Your upload of a b.zip paused at 51%. Open your workspace and drop the same file to resume.");
  assert.equal(U.cleanName("x".repeat(200)).length, 80);
  assert.equal(U.percentOf({ size: 10, received_bytes: 10 }), 99);
});
