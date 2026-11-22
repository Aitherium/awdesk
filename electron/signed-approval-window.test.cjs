"use strict";

// The approve window is never blank (2026-11-18: the Aitherium API answered 502/503
// during a fleet restart and the owner got a white window), and it says what is being
// approved before the Windows Hello prompt.

const assert = require("node:assert/strict");
const test = require("node:test");

const sa = require("./signed-approval.cjs");

const ORIGIN = "https://api.aitherium.com";
const URL_ = `${ORIGIN}/approve?card=d-grant1&choice=grant`;
const CARD = {
  id: "d-grant1",
  title: "Allow Claude to use: Bash(gh pr create --repo Aitherium/awdesk:*)",
  summary: "Granting adds ONE allow rule to settings.local.json.",
  kind: "blocked",
  options: [
    { key: "grant", label: "Grant this one rule", consequence: "adds exactly this allow rule; the session's retry then runs" },
    { key: "deny", label: "Deny", consequence: "nothing changes" },
  ],
  facts: [
    "permission_rule: Bash(gh pr create --repo Aitherium/awdesk:*)",
    "settings_file: C:\\AitherOS-Fresh\\.claude\\settings.local.json",
    "Approve on app.aitherium.com with your passkey; an unsigned answer grants nothing.",
  ],
};

function fakeTimers() {
  const pending = new Map();
  let next = 1;
  return {
    pending,
    setTimeout(fn, ms) { const id = next++; pending.set(id, { fn, ms }); return id; },
    clearTimeout(id) { pending.delete(id); },
    fire(id) { const t = pending.get(id); pending.delete(id); t.fn(); },
    only() { assert.equal(pending.size, 1, "exactly one timer pending"); return [...pending.entries()][0]; },
  };
}

class FakeWin {
  constructor(opts) {
    this.opts = opts;
    this.handlers = {};
    this.loaded = [];
    this.destroyed = false;
    this.webContents = {
      setWindowOpenHandler: () => {},
      on: (ev, fn) => { this.handlers[ev] = fn; },
    };
  }
  on(ev, fn) { this.handlers["win:" + ev] = fn; }
  loadURL(u) { this.loaded.push(u); return Promise.resolve(); }
  isDestroyed() { return this.destroyed; }
  close() { this.destroyed = true; this.handlers["win:closed"](); }
  show() {}
  focus() {}
  last() { return this.loaded[this.loaded.length - 1]; }
  lastPage() {
    const u = this.last();
    assert.ok(u.startsWith("data:text/html"), `expected a local page, got ${u}`);
    return decodeURIComponent(u.slice(u.indexOf(",") + 1));
  }
  /** Click a desk button on the local page: a link the will-navigate guard intercepts. */
  click(action) {
    let prevented = false;
    this.handlers["will-navigate"]({ preventDefault: () => { prevented = true; } }, `${sa.DESK_ACTION_ORIGIN}/${action}`);
    assert.equal(prevented, true, "a desk action never navigates");
  }
}

function open(extra = {}) {
  const timers = fakeTimers();
  const win = sa.openApproveWindow({ BrowserWindow: FakeWin, url: URL_, origin: ORIGIN, card: CARD, timers, ...extra });
  return { win, timers };
}

test("the summary of what is approved is shown BEFORE the portal and its Windows Hello prompt", (t) => {
  const { win } = open();
  t.after(() => win.close());
  assert.equal(win.loaded.length, 1);
  const html = win.lastPage();
  assert.ok(html.includes("Allow Claude to use: Bash(gh pr create --repo Aitherium/awdesk:*)"), "card title");
  assert.ok(html.includes("What it will run"));
  assert.ok(html.includes("<li>permission_rule: Bash(gh pr create --repo Aitherium/awdesk:*)</li>"), "each action");
  assert.ok(html.includes("<li>settings_file: C:\\AitherOS-Fresh\\.claude\\settings.local.json</li>"));
  assert.ok(!html.includes("<li>Approve on app.aitherium.com"), "an instruction is not an action");
  assert.ok(html.includes("If you approve (Grant this one rule)"));
  assert.ok(html.includes("adds exactly this allow rule; the session&#39;s retry then runs"), "what approve does");
  assert.ok(html.includes("If you reject (Deny)") && html.includes("nothing changes."), "what reject does");
  assert.ok(html.includes(`${sa.DESK_ACTION_ORIGIN}/continue`), "a way on to Windows Hello");
  assert.ok(!win.loaded.includes(URL_), "the portal is not loaded until Continue");
  win.click("continue");
  assert.equal(win.last(), URL_);
});

test("no card -> says so plainly and offers no way to approve blind", (t) => {
  const { win } = open({ card: undefined, readCard: () => null });
  t.after(() => win.close());
  const html = win.lastPage();
  assert.ok(html.includes("The desk cannot show what this approves"));
  assert.ok(html.includes("<code>d-grant1</code>"));
  assert.ok(html.includes("Nothing was approved"));
  assert.ok(!html.includes("/continue"), "no Continue to Windows Hello");
  win.click("continue");
  assert.ok(!win.loaded.includes(URL_), "Continue is refused without a summary");
});

test("readCard supplies the card when the caller had only the url; a mismatched id is not summarised", (t) => {
  const seen = [];
  const { win } = open({ card: undefined, readCard: (id) => { seen.push(id); return CARD; } });
  assert.deepEqual(seen, ["d-grant1"]);
  assert.ok(win.lastPage().includes("What it will run"));
  win.close();
  const { win: w2 } = open({ card: { ...CARD, id: "d-other" } });
  t.after(() => w2.close());
  assert.ok(w2.lastPage().includes("The desk cannot show what this approves"));
});

test("a failed portal load renders the local fallback, never a blank window", (t) => {
  const { win } = open();
  t.after(() => win.close());
  win.click("continue");
  win.handlers["did-fail-load"]({}, -105, "ERR_NAME_NOT_RESOLVED", URL_, true);
  const html = win.lastPage();
  assert.ok(html.includes("The approval page is unreachable (the Aitherium API did not answer: ERR_NAME_NOT_RESOLVED). Nothing was approved."));
  assert.ok(html.includes(`${sa.DESK_ACTION_ORIGIN}/retry`), "a Retry button");
});

test("an HTTP 502/503 from the API renders the fallback with the code", (t) => {
  for (const code of [502, 503, 500]) {
    const { win } = open();
    win.click("continue");
    win.handlers["did-navigate"]({}, URL_, code, "Bad Gateway");
    assert.ok(win.lastPage().includes(`(the Aitherium API answered ${code}). Nothing was approved.`), String(code));
    win.close();
  }
  const { win } = open();
  t.after(() => win.close());
  win.click("continue");
  win.handlers["did-navigate"]({}, URL_, 200, "OK");
  assert.equal(win.last(), URL_, "a 200 is left alone");
});

test("a portal that never finishes loading times out to the fallback after ~10 s", (t) => {
  const { win, timers } = open();
  t.after(() => win.close());
  win.click("continue");
  const [id, { ms }] = timers.only();
  assert.equal(ms, 10_000);
  timers.fire(id);
  assert.ok(win.lastPage().includes("did not answer within 10 s"));
});

test("a page that loads clears the timeout; an aborted or sub-frame failure is ignored", (t) => {
  const { win, timers } = open();
  t.after(() => win.close());
  win.click("continue");
  win.handlers["did-fail-load"]({}, -3, "ERR_ABORTED", URL_, true);
  win.handlers["did-fail-load"]({}, -105, "ERR_NAME_NOT_RESOLVED", "https://cdn.example/x.js", false);
  assert.equal(win.last(), URL_);
  win.handlers["did-finish-load"]();
  assert.equal(timers.pending.size, 0, "no timeout left after the page loaded");
});

test("Retry reloads the portal; it also retries on its own with growing backoff", (t) => {
  const { win, timers } = open();
  t.after(() => win.close());
  win.click("continue");
  win.handlers["did-navigate"]({}, URL_, 503, "Service Unavailable");
  // auto-retry: the pending timer is the backoff, firing it reloads the portal
  const delays = [];
  for (let i = 0; i < 4; i++) {
    const [rid, { ms }] = timers.only();
    delays.push(ms);
    timers.fire(rid);
    assert.equal(win.last(), URL_, `auto-retry ${i + 1} reloads the portal`);
    const [lid] = timers.only(); // the load timeout of that try
    timers.fire(lid);
    assert.ok(win.lastPage().includes("Nothing was approved"));
  }
  assert.deepEqual(delays, [2000, 4000, 8000, 16000]);
  // the Retry button reloads at once and cancels the scheduled retry
  const before = win.loaded.length;
  win.click("retry");
  assert.equal(win.loaded.length, before + 1);
  assert.equal(win.last(), URL_);
  assert.equal(timers.only()[1].ms, 10_000, "only the new load timeout is pending");
  win.handlers["did-finish-load"]();
  assert.equal(timers.pending.size, 0);
});

test("closing the window stops every retry", () => {
  const { win, timers } = open();
  win.click("continue");
  win.handlers["did-navigate"]({}, URL_, 502, "Bad Gateway");
  assert.equal(timers.pending.size, 1);
  win.click("close");
  assert.equal(win.destroyed, true);
  assert.equal(timers.pending.size, 0);
});

test("a second approval in the open window starts over at its own summary", (t) => {
  const { win, timers } = open();
  t.after(() => win.close());
  win.click("continue");
  win.handlers["did-navigate"]({}, URL_, 502, "Bad Gateway");
  const other = { ...CARD, id: "d-plan2", title: "Apply relocation plan rp-3", facts: ["plan_id: rp-3"] };
  const w2 = sa.openApproveWindow({ BrowserWindow: FakeWin, url: `${ORIGIN}/approve?card=d-plan2&choice=grant`, origin: ORIGIN, card: other, timers });
  assert.equal(w2, win);
  assert.equal(timers.pending.size, 0, "the old card's retry is cancelled");
  assert.ok(win.lastPage().includes("Apply relocation plan rp-3"));
  assert.ok(win.lastPage().includes("<li>plan_id: rp-3</li>"));
});

test("retry backoff caps at 30 s", () => {
  assert.equal(sa.retryDelayMs(0), 2000);
  assert.equal(sa.retryDelayMs(3), 16000);
  assert.equal(sa.retryDelayMs(4), 30000);
  assert.equal(sa.retryDelayMs(50), 30000);
});

test("the local pages escape card text", () => {
  const html = sa.summaryPageHtml(sa.approvalSummary({ id: "d-x", title: "<img src=x onerror=alert(1)>", facts: ["a: <b>"] }, "approve"));
  assert.ok(!html.includes("<img src=x"));
  assert.ok(html.includes("&lt;img src=x onerror=alert(1)&gt;"));
  assert.ok(html.includes("<li>a: &lt;b&gt;</li>"));
  assert.ok(html.includes("default-src 'none'"), "no script runs on the local page");
});

test("main.cjs hands the approve window the card that routed the answer", () => {
  const src = require("node:fs").readFileSync(require("node:path").join(__dirname, "main.cjs"), "utf8");
  const f = src.indexOf("function answerDeckCard(id, choice, parent, note");
  assert.match(src.slice(f, f + 2500), /url: signedApproval\.approveUrl\(id, choice\),\s+card: raw,/);
  const o = src.indexOf("decisionCards.setSignedAnswerOpener(");
  assert.match(src.slice(o, o + 500), /readCard: \(id\) =>\s+decisionCards\.rawCard\(id\) \|\| signedApproval\.readCardRaw\(id, decisionCards\.storeDir\(\)\)/);
});
