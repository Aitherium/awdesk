"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const sa = require("./signed-approval.cjs");

function tmpStore() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "desk-approve-"));
}

test("destructive kinds and proposal/plan facts route Approve to the passkey window", () => {
  for (const kind of ["awstorage-manage", "awstorage-suggestion", "awstorage-relocate", "AWSTORAGE-RELOCATE"]) {
    assert.equal(sa.answerRoute({ id: "d-1", kind }, "approve"), "window", kind);
  }
  // awstorage manage/suggest cards are kind "decision" -- the FACT marks them.
  assert.equal(sa.answerRoute({ kind: "decision", facts: ["proposal_id: 12", "node: x"] }, "approve"), "window");
  assert.equal(sa.answerRoute({ kind: "decision", facts: ["plan_id: rp-3", "plan_sha256: ab"] }, "Approve"), "window");
});

test("reject and ordinary cards keep using awask", () => {
  assert.equal(sa.answerRoute({ kind: "awstorage-manage" }, "reject"), "awask");
  assert.equal(sa.answerRoute({ kind: "decision", facts: ["proposal_id: 1"] }, "REJECT"), "awask");
  assert.equal(sa.answerRoute({ kind: "decision", facts: ["node: x"] }, "approve"), "awask");
  assert.equal(sa.answerRoute({ kind: "credential" }, "approve"), "awask");
  // a fact that merely MENTIONS the key is not the key
  assert.equal(sa.answerRoute({ kind: "decision", facts: ["see proposal_id: 1"] }, "approve"), "awask");
  assert.equal(sa.answerRoute(null, "approve"), "awask");
});

test("readCardRaw reads only a valid id inside the store", () => {
  const dir = tmpStore();
  fs.writeFileSync(path.join(dir, "d-abc.json"), JSON.stringify({ id: "d-abc", kind: "awstorage-manage" }));
  fs.writeFileSync(path.join(dir, "d-lie.json"), JSON.stringify({ id: "d-other" }));
  assert.equal(sa.readCardRaw("d-abc", dir).kind, "awstorage-manage");
  assert.equal(sa.readCardRaw("d-lie", dir), null, "file whose id disagrees is refused");
  assert.equal(sa.readCardRaw("../d-abc", dir), null);
  assert.equal(sa.readCardRaw("d-..", dir), null);
  assert.equal(sa.readCardRaw("d-missing", dir), null);
  assert.equal(sa.readCardRaw(42, dir), null);
});

test("portal origin: https or loopback http only, default api.aitherium.com", () => {
  assert.equal(sa.portalOrigin({}), "https://api.aitherium.com");
  assert.equal(sa.portalOrigin({ AITHER_PORTAL_ORIGIN: "https://portal.aitherium.com/x" }), "https://portal.aitherium.com");
  assert.equal(sa.portalOrigin({ AITHER_PORTAL_ORIGIN: "http://localhost:3000" }), "http://localhost:3000");
  assert.equal(sa.portalOrigin({ AITHER_PORTAL_ORIGIN: "http://evil.example" }), "https://api.aitherium.com");
  assert.equal(sa.portalOrigin({ AITHER_PORTAL_ORIGIN: "https://u:p@aitherium.com" }), "https://api.aitherium.com");
  assert.equal(sa.portalOrigin({ AITHER_PORTAL_ORIGIN: "not a url" }), "https://api.aitherium.com");
  assert.equal(
    sa.approveUrl("d-1", "approve", "https://aitherium.com"),
    "https://aitherium.com/approve?card=d-1&choice=approve",
  );
  assert.equal(sa.approveUrl("d 1&x", "a/b", "https://aitherium.com"), "https://aitherium.com/approve?card=d+1%26x&choice=a%2Fb");
});

test("navigation guard allows the portal and *.aitherium.com only", () => {
  const o = "https://aitherium.com";
  assert.equal(sa.isAllowedApproveNavigation("https://aitherium.com/login?redirect=/approve", o), true);
  assert.equal(sa.isAllowedApproveNavigation("https://idp.aitherium.com/authorize", o), true);
  assert.equal(sa.isAllowedApproveNavigation("https://evilaitherium.com/", o), false);
  assert.equal(sa.isAllowedApproveNavigation("http://idp.aitherium.com/", o), false);
  assert.equal(sa.isAllowedApproveNavigation("file:///C:/x", o), false);
});

test("openApproveWindow: 520x640, persistent partition, no node, no popups; reused", () => {
  const made = [];
  class FakeWin {
    constructor(opts) {
      this.opts = opts;
      this.handlers = {};
      this.loaded = [];
      this.destroyed = false;
      this.webContents = {
        setWindowOpenHandler: (fn) => { this.openHandler = fn; },
        on: (ev, fn) => { this.handlers[ev] = fn; },
      };
      made.push(this);
    }
    on(ev, fn) { this.handlers["win:" + ev] = fn; }
    loadURL(u) { this.loaded.push(u); }
    isDestroyed() { return this.destroyed; }
    show() {}
    focus() {}
  }
  const w = sa.openApproveWindow({ BrowserWindow: FakeWin, url: "https://aitherium.com/approve?card=d-1&choice=approve", origin: "https://aitherium.com" });
  assert.equal(w.opts.width, 520);
  assert.equal(w.opts.height, 640);
  assert.equal(w.opts.webPreferences.partition, "persist:aither-approve");
  assert.equal(w.opts.webPreferences.nodeIntegration, false);
  assert.equal(w.opts.webPreferences.contextIsolation, true);
  assert.equal(w.opts.webPreferences.preload, undefined);
  assert.deepEqual(w.openHandler(), { action: "deny" });
  let prevented = false;
  w.handlers["will-navigate"]({ preventDefault: () => { prevented = true; } }, "https://evil.example/");
  assert.equal(prevented, true);
  // second approval reuses the same window (one Hello prompt surface, not a pile)
  const w2 = sa.openApproveWindow({ BrowserWindow: FakeWin, url: "https://aitherium.com/approve?card=d-2&choice=approve" });
  assert.equal(w2, w);
  assert.equal(made.length, 1);
  assert.equal(w.loaded.length, 2);
  // after close a new one is made
  w.handlers["win:closed"]();
  sa.openApproveWindow({ BrowserWindow: FakeWin, url: "https://aitherium.com/approve?card=d-3&choice=approve" });
  assert.equal(made.length, 2);
});

test("main.cjs routes desk:deck-answer through signed-approval before awask", () => {
  const src = fs.readFileSync(path.join(__dirname, "main.cjs"), "utf8");
  const i = src.indexOf('ipcMain.handle("desk:deck-answer"');
  assert.ok(i > 0);
  // The handler delegates to the ONE answer path every desk surface shares.
  assert.match(src.slice(i, i + 300), /return answerDeckCard\(id, choice, deckWindow\)/);
  const f = src.indexOf("function answerDeckCard(id, choice, parent)");
  assert.ok(f > 0, "answerDeckCard is the shared answer path");
  const body = src.slice(f, f + 2500);
  const route = body.indexOf("signedApproval.answerRoute(");
  const awask = body.indexOf("decisionCards.answerCard(");
  assert.ok(route > 0 && awask > route, "answerRoute must be consulted before answerCard");
  assert.match(body, /readCardRaw\(id, decisionCards\.storeDir\(\)\)/);
  assert.match(body, /pending: true/);
});

test("the browser side panel's Agents tab answers through the same answerDeckCard", () => {
  const src = fs.readFileSync(path.join(__dirname, "main.cjs"), "utf8");
  const i = src.indexOf("browserWindow.setAgentsHost(agentsPanel.createAgentsSource({");
  assert.ok(i > 0, "main installs the Agents host");
  const body = src.slice(i, i + 1200);
  assert.match(body, /answerDeckCard\(id, choice, parent\)/);
  assert.doesNotMatch(body, /decisionCards\.answerCard\(/, "no second, unsigned answer path");
  assert.match(body, /getCards: \(\) => openDecisions/);
  assert.match(body, /getRoom: \(\) => roomFeed/);
  // The answer is handed to createAgentsSource, which holds an answered id until the
  // watcher drops the card -- not spread beside it, where nothing would wrap it.
  assert.match(body, /^ {2}answer: \(id, choice, parent\) =>/m);
});

test("an agent-approval card opens its /approvals page in the approve window, never an answer", () => {
  const raw = { id: "d-9", kind: "info", raised_by: "agent-approvals", dedupe_key: "agent-approval:apr-0123456789abcdef" };
  assert.equal(sa.agentApprovalId(raw), "apr-0123456789abcdef");
  assert.equal(sa.answerRoute(raw, sa.AGENT_APPROVAL_CHOICE), "agent-approval");
  assert.equal(sa.answerRoute(raw, "approve"), "awask", "any other answer approves nothing");
  assert.equal(sa.agentApprovalUrl("apr-0123456789abcdef", "https://api.aitherium.com"),
    "https://api.aitherium.com/approvals?id=apr-0123456789abcdef");
  assert.throws(() => sa.agentApprovalUrl("apr-../x"));
  // Only the router's own card counts: a lookalike dedupe key from another raiser does not.
  assert.equal(sa.agentApprovalId({ ...raw, raised_by: "some-agent" }), "");
  assert.equal(sa.agentApprovalId({ ...raw, dedupe_key: "agent-approval:../../x" }), "");
  assert.equal(sa.agentApprovalId(null), "");
});

test("the desk card for an agent approval offers exactly one choice: open it with the passkey", () => {
  const dc = require("./decision-cards.cjs");
  const card = dc.cardFromRaw({ id: "d-9", status: "open", kind: "info", raised_by: "agent-approvals",
    dedupe_key: "agent-approval:apr-0123456789abcdef", title: "Agent asks approval: focus_announce" });
  assert.deepEqual(card.options.map((o) => o.key), [sa.AGENT_APPROVAL_CHOICE]);
  assert.equal(card.defaultKey, sa.AGENT_APPROVAL_CHOICE);
  const other = dc.cardFromRaw({ id: "d-8", status: "open", kind: "info", title: "x" });
  assert.deepEqual(other.options, []);
});

test("main.cjs sends the agent-approval choice to the approve window before any answer", () => {
  const src = fs.readFileSync(path.join(__dirname, "main.cjs"), "utf8");
  const at = src.indexOf('route === "agent-approval"');
  assert.ok(at > 0);
  assert.ok(at < src.indexOf("decisionCards.answerCard(id, choice)"));
  assert.match(src.slice(at, at + 600), /agentApprovalUrl\(signedApproval\.agentApprovalId\(raw\)\)/);
});

// ── owner 2026-11-15: approving a card must not start from a fresh sign-in ──
function fakeSession() {
  const set = [];
  return {
    set,
    fromPartition(name) {
      return { cookies: { set: async (d) => { set.push({ name, d }); } } };
    },
  };
}

test("the desk session is seeded into the approve partition", async () => {
  const ses = fakeSession();
  const ok = await sa.seedApproveSession({
    session: ses,
    readToken: () => ({ token: "tok", expiresAt: 4102444800000 }),
    cookieDetails: (t, o) => ({ value: t, exp: o.expiresAt }),
  });
  assert.equal(ok, true);
  assert.equal(ses.set.length, 1);
  assert.equal(ses.set[0].name, "persist:aither-approve");
  assert.equal(ses.set[0].d.value, "tok");
});

test("no desk token leaves the approve partition untouched", async () => {
  const ses = fakeSession();
  assert.equal(await sa.seedApproveSession({ session: ses, readToken: () => null,
    cookieDetails: () => ({}) }), false);
  assert.equal(ses.set.length, 0);
});

test("the approve page loads after the seed, and still loads if seeding fails", async () => {
  // An earlier test leaves the approve window open, so this also covers the reuse path:
  // wrap loadURL on whichever window openApproveWindow returns, before the seed settles.
  const order = [];
  class Win {
    constructor() { this.webContents = { setWindowOpenHandler() {}, on() {} }; }
    on() {}
    isDestroyed() { return false; }
    loadURL() {}
    show() {} focus() {}
  }
  const watch = (w) => { w.loadURL = (u) => order.push(["load", u]); return w; };
  watch(sa.openApproveWindow({ BrowserWindow: Win, url: "https://api.aitherium.com/decide?id=a",
    seed: async () => { order.push(["seed"]); return true; } }));
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual(order, [["seed"], ["load", "https://api.aitherium.com/decide?id=a"]]);
  watch(sa.openApproveWindow({ BrowserWindow: Win, url: "https://api.aitherium.com/decide?id=b",
    seed: async () => { throw new Error("vault down"); } }));
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual(order[order.length - 1], ["load", "https://api.aitherium.com/decide?id=b"]);
});
