"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { EventEmitter } = require("node:events");
const { createToaster } = require("./held-toast.cjs");

/** A Notification stand-in; `made` records every instance. */
function fakeNotification({ supported = true } = {}) {
  const made = [];
  class N extends EventEmitter {
    constructor(opts) { super(); this.opts = opts; this.shown = false; made.push(this); }
    show() { this.shown = true; }
    static isSupported() { return supported; }
  }
  return { N, made };
}

test("the toast is HELD after show() returns, so a collected one cannot lose its click", () => {
  const { N, made } = fakeNotification();
  const t = createToaster({ Notification: N });
  let clicked = 0;
  t.show({ title: "Phone connected: Pixel", body: "Click", onClick: () => { clicked += 1; } });
  assert.equal(t.held(), 1, "nothing but the toaster references the notification");
  assert.equal(made[0].shown, true);
  made[0].emit("click");
  assert.equal(clicked, 1);
  assert.equal(t.held(), 0, "released once clicked");
});

test("closed and failed toasts are released; the ttl releases one that never reports", () => {
  const { N, made } = fakeNotification();
  const timers = [];
  const t = createToaster({ Notification: N, ttlMs: 1000,
    setTimeoutImpl: (fn) => { const h = { fn }; timers.push(h); return h; }, clearTimeoutImpl: () => {} });
  t.show({ title: "a", body: "b" }); t.show({ title: "c", body: "d" }); t.show({ title: "e", body: "f" });
  assert.equal(t.held(), 3);
  made[0].emit("close");
  made[1].emit("failed");
  assert.equal(t.held(), 1);
  timers[2].fn();
  assert.equal(t.held(), 0);
});

test("the held set is capped", () => {
  const { N } = fakeNotification();
  const t = createToaster({ Notification: N, max: 3 });
  for (let i = 0; i < 10; i++) t.show({ title: String(i), body: "x" });
  assert.equal(t.held(), 3);
});

test("a click handler that throws or rejects is logged, not thrown", async () => {
  const { N, made } = fakeNotification();
  const lines = [];
  const t = createToaster({ Notification: N, log: (l) => lines.push(l) });
  t.show({ title: "a", body: "b", onClick: () => { throw new Error("boom"); } });
  t.show({ title: "c", body: "d", onClick: async () => { throw new Error("later"); } });
  assert.doesNotThrow(() => made[0].emit("click"));
  made[1].emit("click");
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(lines, ["toast click failed: boom", "toast click failed: later"]);
});

test("unsupported toasts return null and never construct a Notification", () => {
  const { N, made } = fakeNotification({ supported: false });
  assert.equal(createToaster({ Notification: N }).show({ title: "a", body: "b" }), null);
  assert.equal(made.length, 0);
});

test("main.cjs raises every clickable toast through the toaster (a bare local `n.on(click)` is the bug)", () => {
  // Root cause of the dead "Phone connected" click: `const n = new Notification(..);
  // n.on("click", ..)` in a callback. This pins the clickable ones to the holder.
  for (const file of ["main.cjs", "local-ai-window.cjs"]) {
    const src = fs.readFileSync(path.join(__dirname, file), "utf8");
    const bad = src.split(/\r?\n/).map((l, i) => [i + 1, l]).filter(([, l]) =>
      /\bn\.on\(\s*"click"/.test(l));
    // upload notices hold theirs in uploadNoticesHeld and the update notice in a module
    // variable; both are retained on purpose.
    const allowed = bad.filter(([i]) => {
      const around = src.split(/\r?\n/).slice(Math.max(0, i - 6), i + 1).join("\n");
      return /uploadNoticesHeld/.test(around);
    });
    assert.equal(bad.length, allowed.length, `${file}: unheld toast click at line(s) ${bad.filter((b) => !allowed.includes(b)).map(([i]) => i)}`);
  }
});
