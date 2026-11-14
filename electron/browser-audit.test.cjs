"use strict";

// The audit spool: six known fields per row, the origin only (never a path, a query or
// page content), append-only, rotated at its size cap, and an upload seam that sends nothing.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { AUDIT_FILE, createAudit, shape } = require("./browser-audit.cjs");

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "awdesk-audit-"));

test("a row holds ts, tenant, origin, action, verdict and tab kind -- and nothing else", () => {
  const row = shape({ tenant: "acme", origin: "https://crm.example.com/deals/42?token=s3cret#frag", action: "copy", verdict: "deny", tab: "work",
    text: "the page said hello", password: "hunter2", url: "https://crm.example.com/deals/42", title: "Deal 42" }, Date.parse("2026-11-13T10:00:00Z"));
  assert.deepEqual(row, { ts: "2026-11-13T10:00:00.000Z", tenant: "acme", origin: "https://crm.example.com", action: "copy", verdict: "deny", tab: "work" });
  assert.ok(!JSON.stringify(row).includes("s3cret") && !JSON.stringify(row).includes("hunter2") && !JSON.stringify(row).includes("deals"));
});

test("fields that are not what they should be are cut down, never passed through", () => {
  const row = shape({ tenant: "a b\nc", origin: "javascript:alert(1)", action: "Copy the <b>page</b>", verdict: "maybe", tab: "root" }, 0);
  assert.deepEqual(row, { ts: "1970-01-01T00:00:00.000Z", tenant: "", origin: "", action: "unknown", verdict: "deny", tab: "owner" });
  assert.equal(shape({ origin: "user:pw@nohost" }, 0).origin, "");
  assert.equal(shape({ origin: "https://user:pw@crm.example.com/x" }, 0).origin, "https://crm.example.com", "credentials in an address are dropped");
});

test("rows are appended as JSON lines and read back in order", () => {
  const dir = tmp();
  const audit = createAudit({ dir, now: () => 1000 });
  audit.record({ tenant: "acme", origin: "http://wiki.corp.test/a", action: "copy", verdict: "deny", tab: "work" });
  audit.record({ tenant: "acme", origin: "http://wiki.corp.test/b", action: "open", verdict: "allow", tab: "work" });
  const raw = fs.readFileSync(path.join(dir, AUDIT_FILE), "utf8");
  assert.equal(raw.split("\n").filter(Boolean).length, 2);
  assert.ok(raw.endsWith("\n"));
  assert.deepEqual(audit.read().map((r) => [r.action, r.verdict, r.origin]), [["copy", "deny", "http://wiki.corp.test"], ["open", "allow", "http://wiki.corp.test"]]);
  // A second handle on the same file appends; it does not start over.
  createAudit({ dir }).record({ action: "print", verdict: "deny" });
  assert.equal(audit.read().length, 3);
});

test("the spool is size-capped: it rotates and keeps a fixed number of old files", () => {
  const dir = tmp();
  const audit = createAudit({ dir, maxBytes: 400, keep: 2 });
  for (let i = 0; i < 40; i += 1) audit.record({ tenant: "acme", origin: "https://crm.example.com", action: "copy", verdict: "deny", tab: "work" });
  const files = fs.readdirSync(dir).sort();
  assert.deepEqual(files, [AUDIT_FILE, `${AUDIT_FILE}.1`, `${AUDIT_FILE}.2`]);
  for (const f of files) assert.ok(fs.statSync(path.join(dir, f)).size <= 400, f);
  assert.ok(audit.read().length >= 1);
});

test("a disk that refuses the write does not throw", () => {
  const dir = tmp();
  const blocker = path.join(dir, "file");
  fs.writeFileSync(blocker, "x");
  const audit = createAudit({ dir: path.join(blocker, "under-a-file") });
  assert.equal(audit.record({ action: "copy", verdict: "deny" }), null);
  assert.deepEqual(audit.read(), []);
});

test("upload is a seam that sends nothing yet", async () => {
  const dir = tmp();
  const audit = createAudit({ dir });
  audit.record({ action: "copy", verdict: "deny" });
  const before = fs.readFileSync(path.join(dir, AUDIT_FILE), "utf8");
  assert.deepEqual(await audit.upload(), { ok: true, uploaded: 0, pending: 1, implemented: false });
  assert.equal(fs.readFileSync(path.join(dir, AUDIT_FILE), "utf8"), before, "the spool is untouched");
});
