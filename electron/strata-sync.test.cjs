"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");

const sync = require("./strata-sync.cjs");

/** A fake Veil: records every multipart upload, answers with `status`. */
function fakeVeil(statuses = [200]) {
  const seen = [];
  let i = 0;
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      seen.push({ method: req.method, url: req.url, headers: req.headers, body: Buffer.concat(chunks).toString("latin1") });
      const status = statuses[Math.min(i, statuses.length - 1)];
      i += 1;
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(status === 200 ? { success: true, file: { name: "x" } } : { success: false, error: `boom ${status}` }));
    });
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => {
    resolve({ seen, origin: `http://127.0.0.1:${server.address().port}`, close: () => server.close() });
  }));
}

test("origin: AWDESK_SYNC_ORIGIN wins when safe, else the desk's page host", () => {
  assert.deepEqual(sync.syncOrigin({ env: { AWDESK_SYNC_ORIGIN: "https://staging.aitherium.com/x" }, onlineUrl: () => "https://app.aitherium.com/" }),
    { origin: "https://staging.aitherium.com", from: "env.AWDESK_SYNC_ORIGIN" });
  assert.equal(sync.syncOrigin({ env: { AWDESK_SYNC_ORIGIN: "http://127.0.0.1:3000" } }).origin, "http://127.0.0.1:3000");
  // Plain http off loopback would carry the bearer in clear text: refused.
  assert.deepEqual(sync.syncOrigin({ env: { AWDESK_SYNC_ORIGIN: "http://evil.example" }, onlineUrl: () => "https://app.aitherium.com/" }),
    { origin: "https://app.aitherium.com", from: "onlineUrl" });
  assert.equal(sync.syncOrigin({ env: {}, onlineUrl: () => "https://app.aitherium.com/" }).origin, "https://app.aitherium.com");
});

test("POSITIVE: one upload reaches /api/strata/upload with bearer, folder and file, and no tenant", async () => {
  const veil = await fakeVeil([200]);
  try {
    const bytes = Buffer.from("PNGDATA-123");
    const v = await sync.uploadOnce({
      origin: veil.origin, folder: "screenshots", name: "Screenshot 2026-11-01 120000.png",
      bytes, contentType: "image/png", token: "tok-abc",
    });
    assert.equal(v.ok, true, JSON.stringify(v));
    assert.equal(veil.seen.length, 1);
    const req = veil.seen[0];
    assert.equal(req.method, "POST");
    assert.equal(req.url, "/api/strata/upload");
    assert.equal(req.headers.authorization, "Bearer tok-abc");
    assert.match(req.headers["content-type"], /^multipart\/form-data; boundary=/);
    assert.match(req.body, /name="folder"\r\n\r\nscreenshots\r\n/);
    assert.match(req.body, /name="file"; filename="Screenshot 2026-11-01 120000.png"/);
    assert.match(req.body, /Content-Type: image\/png/);
    assert.ok(req.body.includes("PNGDATA-123"));
    assert.doesNotMatch(req.body, /tenant_id|user_id/);
  } finally {
    veil.close();
  }
});

test("signed out: no request is made and the reason names the remedy", async () => {
  let called = false;
  const v = await sync.uploadOnce({ origin: "https://x", folder: "clipboard", name: "a", bytes: Buffer.from("a"), token: null,
    fetchImpl: () => { called = true; } });
  assert.equal(v.ok, false);
  assert.equal(called, false);
  assert.match(v.reason, /sign in/);
  assert.equal(v.permanent, false);
});

test("the token never appears in a failure reason", async () => {
  const veil = await fakeVeil([500]);
  try {
    const v = await sync.uploadOnce({ origin: veil.origin, folder: "clipboard", name: "a.json", bytes: Buffer.from("{}"), token: "SECRET-TOKEN-VALUE" });
    assert.equal(v.ok, false);
    assert.doesNotMatch(JSON.stringify(v), /SECRET-TOKEN-VALUE/);
  } finally {
    veil.close();
  }
});

/** A manual clock + scheduler so retries are driven deterministically. */
function clockQueue(veilOrigin, extra = {}) {
  let t = 1_000_000;
  const timers = [];
  const events = [];
  const spoolDir = fs.mkdtempSync(path.join(os.tmpdir(), "spool-"));
  const make = () => sync.createUploadQueue({
    spoolDir,
    token: () => "tok",
    origin: () => veilOrigin,
    now: () => t,
    schedule: (fn, ms) => { const h = { fn, at: t + ms }; timers.push(h); return h; },
    cancel: (h) => { const i = timers.indexOf(h); if (i >= 0) timers.splice(i, 1); },
    onEvent: (e) => events.push(e.type),
    baseMs: 1000,
    ...extra,
  });
  return {
    spoolDir, events, make,
    advance: (ms) => { t += ms; },
    async fireDue() {
      const due = timers.filter((h) => h.at <= t);
      for (const h of due) { timers.splice(timers.indexOf(h), 1); h.fn(); }
    },
  };
}

test("queue: a 503 is retried with backoff and then uploads; the spool is emptied", async () => {
  const veil = await fakeVeil([503, 503, 200]);
  try {
    const c = clockQueue(veil.origin);
    const q = c.make();
    assert.equal(q.enqueue({ folder: "clipboard", name: "clip.json", bytes: Buffer.from("{}"), contentType: "application/json" }).ok, true);
    await q.drain();
    assert.deepEqual(c.events, ["retry"]);
    assert.equal(q.pending()[0].attempts, 1);
    c.advance(999); await c.fireDue(); await q.drain();
    assert.equal(veil.seen.length, 1, "retried before the backoff elapsed");
    c.advance(1); await c.fireDue(); await q.drain();
    assert.deepEqual(c.events, ["retry", "retry"]);
    c.advance(2000); await c.fireDue(); await q.drain();
    assert.deepEqual(c.events, ["retry", "retry", "uploaded"]);
    assert.equal(veil.seen.length, 3);
    assert.equal(q.pending().length, 0);
    assert.deepEqual(fs.readdirSync(c.spoolDir), []);
  } finally {
    veil.close();
  }
});

test("queue: a 400 is dropped, not retried forever", async () => {
  const veil = await fakeVeil([400]);
  try {
    const c = clockQueue(veil.origin);
    const q = c.make();
    q.enqueue({ folder: "screenshots", name: "bad.png", bytes: Buffer.from("x") });
    await q.drain();
    assert.deepEqual(c.events, ["dropped"]);
    assert.equal(q.pending().length, 0);
  } finally {
    veil.close();
  }
});

test("queue: a job spooled before a restart is uploaded by the next run", async () => {
  const veil = await fakeVeil([200]);
  try {
    const c = clockQueue(veil.origin, { token: () => null }); // signed out: stays spooled
    const q1 = c.make();
    q1.enqueue({ folder: "screenshots", name: "kept.png", bytes: Buffer.from("KEEP") });
    await q1.drain();
    q1.stop();
    assert.equal(veil.seen.length, 0);
    const q2 = sync.createUploadQueue({ spoolDir: c.spoolDir, token: () => "tok", origin: () => veil.origin, schedule: () => null, cancel: () => {} });
    q2.start();
    await q2.drain();
    assert.equal(veil.seen.length, 1);
    assert.ok(veil.seen[0].body.includes("KEEP"));
    assert.equal(q2.pending().length, 0);
  } finally {
    veil.close();
  }
});

test("queue: an unknown folder is refused at enqueue", () => {
  const q = sync.createUploadQueue({ spoolDir: fs.mkdtempSync(path.join(os.tmpdir(), "spool-")), schedule: () => null, cancel: () => {} });
  assert.equal(q.enqueue({ folder: "../other-tenant", name: "x", bytes: Buffer.from("x") }).ok, false);
});
