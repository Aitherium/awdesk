"use strict";

// The electron half of the managed browser, with electron faked: which key, menu row and
// permission needs which policy action, the page guard's script, and the invariants a
// real window cannot show cheaply -- the door's credential goes to the work session only,
// and an agent's or an InPrivate tab is refused a private app.

const test = require("node:test");
const assert = require("node:assert/strict");
const nodeCrypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");
const P = require("./browser-workspace-policy.cjs");
const W = require("./browser-workspace.cjs");
const { REALM } = require("./browser-mesh-door.cjs");

const { publicKey, privateKey } = nodeCrypto.generateKeyPairSync("ed25519");
const WIKI = "http://wiki.corp.test";
const policyDoc = (over = {}) => P.signPolicy({ v: 1, tenant_id: "acme", serial: 1, not_after: "2099-01-01T00:00:00Z",
  apps: [{ origin: WIKI, private: { host: "127.0.0.1", port: 9 }, deny: ["copy", "print", "download", "devtools"], watermark: true }], ...over }, privateKey);

const key = (k, mods = {}) => ({ type: "keyDown", key: k, ...mods });

test("keys: copy, cut, paste, save and the developer tools keys map to their policy action", () => {
  assert.equal(W.keyAction(key("c", { control: true })), "copy");
  assert.equal(W.keyAction(key("X", { control: true })), "copy");
  assert.equal(W.keyAction(key("c", { meta: true })), "copy");
  assert.equal(W.keyAction(key("Insert", { control: true })), "copy");
  assert.equal(W.keyAction(key("Delete", { shift: true })), "copy");
  assert.equal(W.keyAction(key("v", { control: true })), "paste");
  assert.equal(W.keyAction(key("V", { control: true, shift: true })), "paste");
  assert.equal(W.keyAction(key("Insert", { shift: true })), "paste");
  assert.equal(W.keyAction(key("s", { control: true })), "capture");
  assert.equal(W.keyAction(key("F12")), "devtools");
  for (const k of ["I", "J", "C"]) assert.equal(W.keyAction(key(k, { control: true, shift: true })), "devtools", k);
  for (const input of [key("c"), key("a", { control: true }), key("c", { control: true, alt: true }), { type: "keyUp", key: "c", control: true }, null]) {
    assert.equal(W.keyAction(input), null);
  }
});

test("every right-click row that moves page content out or in needs a policy action", () => {
  assert.deepEqual(W.MENU_ACTIONS, { copy: "copy", cut: "copy", "copy-text": "copy", "image-copy": "copy", search: "copy",
    paste: "paste", "paste-plain": "paste", "image-save": "download", "save-page": "capture", translate: "capture", "read-aloud": "capture",
    print: "print", inspect: "devtools" });
  assert.deepEqual(W.PERMISSION_ACTIONS, { "clipboard-sanitized-write": "copy", "clipboard-read": "paste" });
  assert.equal(W.BROWSER_ACTIONS.print, "print");
});

test("the notice names what was blocked, where, and the workspace policy", () => {
  assert.equal(W.blockedText("copy", "wiki.corp.test"), "Copying is turned off on wiki.corp.test by your workspace policy.");
  assert.match(W.blockedText("download", "x"), /^Downloads are turned off on x by your workspace policy\.$/);
});

/** Run the guard script against a fake window and hand back what it registered. */
function runGuard(deny, nonce = "N:") {
  const listeners = [];
  const logs = [];
  const window = { addEventListener: (type, fn, capture) => listeners.push({ type, fn, capture }) };
  const ctx = vm.createContext({ window, console: { debug: (m) => logs.push(m) } });
  const run = (d) => vm.runInContext(W.guardScript(d, nonce), ctx);
  assert.equal(run(deny), true);
  const fire = (type, extra = {}) => {
    const e = { prevented: false, stopped: false, cleared: false, preventDefault() { this.prevented = true; }, stopImmediatePropagation() { this.stopped = true; }, ...extra };
    for (const l of listeners.filter((x) => x.type === type)) { if (!e.stopped) l.fn(e); }
    return e;
  };
  return { listeners, logs, fire, run };
}

test("the page guard stops copy, cut and drag-out in the capture phase and reports it", () => {
  const g = runGuard(["copy"]);
  assert.ok(g.listeners.every((l) => l.capture === true), "before the page's own handlers");
  for (const type of ["copy", "cut", "dragstart"]) {
    const data = { clearData() { this.cleared = true; } };
    const e = g.fire(type, { clipboardData: data });
    assert.ok(e.prevented && e.stopped && data.cleared, type);
  }
  assert.deepEqual(g.logs, ["N:copy", "N:copy", "N:copy"]);
  assert.equal(g.fire("paste", { clipboardData: { types: ["text/plain"], clearData() {} } }).prevented, false, "paste is not on this app's list");
});

test("the page guard tells a pasted or dropped FILE (upload) from pasted text (paste)", () => {
  const g = runGuard(["upload"]);
  assert.equal(g.fire("paste", { clipboardData: { types: ["text/plain"], clearData() {} } }).prevented, false);
  assert.equal(g.fire("paste", { clipboardData: { types: ["Files"], clearData() {} } }).prevented, true);
  assert.equal(g.fire("drop", { dataTransfer: { types: ["Files"] } }).prevented, true);
  assert.equal(g.fire("click", { target: { matches: (s) => s === "input[type=file]" } }).prevented, true, "the file chooser");
  assert.equal(g.fire("click", { target: { matches: () => false } }).prevented, false);
  assert.deepEqual(g.logs, ["N:upload", "N:upload", "N:upload"]);
  const p = runGuard(["paste"]);
  assert.equal(p.fire("paste", { clipboardData: { types: ["text/plain"], clearData() {} } }).prevented, true);
  assert.equal(p.fire("drop", { dataTransfer: { types: ["text/plain"] } }).prevented, true);
  assert.equal(p.fire("drop", { dataTransfer: { types: ["Files"] } }).prevented, false, "a dropped file is an upload, not a paste");
});

test("the guard is installed once per document; a second run only updates the deny list", () => {
  const g = runGuard([]);
  const count = g.listeners.length;
  assert.equal(g.fire("copy", {}).prevented, false);
  assert.equal(g.run(["copy"]), true);
  assert.equal(g.listeners.length, count);
  assert.equal(g.fire("copy", {}).prevented, true);
});

// ---------------------------------------------------------------- with electron faked

async function fakeWorld({ doc = policyDoc(), platform = doc, debugDoor = () => "", accountTenant = async () => "" } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "awdesk-ws-"));
  if (doc) fs.writeFileSync(path.join(dir, P.POLICY_FILE), JSON.stringify(doc));
  const sessions = new Map();
  const appHandlers = {};
  const session = { fromPartition: (name) => {
    if (!sessions.has(name)) sessions.set(name, { name, proxy: null, setProxy: async function setProxy(c) { this.proxy = c; }, closeAllConnections: async () => {} });
    return sessions.get(name);
  } };
  const tabsById = new Map();
  const pages = new Map();
  const notices = [];
  const opened = [];
  const hardened = [];
  const host = {
    electron: () => ({ session, app: { on: (name, fn) => { appHandlers[name] = fn; } } }),
    userData: () => dir, window: () => null,
    tab: (id) => tabsById.get(id) || null, tabIds: () => [...tabsById.keys()], activeId: () => null,
    tabIdOf: (wc) => { for (const [id, p] of pages) if (p === wc) return id; return null; },
    pageOf: (id) => pages.get(id) || null, activeBounds: () => null,
    setNotice: (id, n) => notices.push({ id, ...n }), isolated: async () => true,
    hardenSession: (ses) => hardened.push(ses.name), openTab: (by, url, opts) => { opened.push({ by, url, opts }); return { ok: true, id: 99 }; },
    blockedPage: (url, reason) => `data:text/plain,${encodeURIComponent(reason)}`,
    keys: [P.publicKeyRaw(publicKey)], account: async () => "david", accountTenant, debugDoor,
    allowLoopbackTargets: true, // this file's private app points at 127.0.0.1:9; the app never sets it
    // The stand-in platform: it confirms `platform` (null = the route answers 404).
    remote: { origin: () => "https://app.aitherium.com", token: async () => "tok",
      fetchImpl: async () => (platform ? { status: 200, text: async () => JSON.stringify(platform) } : { status: 404, text: async () => "" }) },
  };
  const ws = W.createWorkspace(host);
  await ws.refresh();
  const page = (id, tab, url, ses) => {
    const wc = { url, loaded: [], session: ses || null, isDestroyed: () => false, getURL() { return this.url; },
      loadURL(u) { this.loaded.push(u); this.url = u; return Promise.resolve(); }, mainFrame: null,
      insertCSS: async () => "k", removeInsertedCSS: async () => {}, isDevToolsOpened: () => false };
    tabsById.set(id, tab);
    pages.set(id, wc);
    return wc;
  };
  return { appHandlers, dir, hardened, host, notices, opened, page, session, sessions, ws };
}

test("the owner's tab for a workspace app is built in the tenant's work partition, hardened", async () => {
  const w = await fakeWorld();
  assert.deepEqual(w.ws.gateOpen({ by: "you", url: `${WIKI}/home` }), { partition: "persist:aither-work-acme" });
  assert.deepEqual(w.hardened, ["persist:aither-work-acme"]);
  assert.deepEqual(w.ws.gateOpen({ by: "you", url: "https://example.com/" }), {}, "ordinary browsing is untouched");
  await w.ws.ready();
  const proxy = w.sessions.get("persist:aither-work-acme").proxy;
  assert.equal(proxy.mode, "pac_script");
  const script = Buffer.from(proxy.pacScript.split(",")[1], "base64").toString();
  assert.match(script, /\["wiki\.corp\.test"\]/);
  assert.match(script, new RegExp(`PROXY 127\\.0\\.0\\.1:${w.ws.door.port()}"`));
  assert.ok(!w.sessions.has("persist:aither-browser-agent") && !w.sessions.has("aither-inprivate"), "no other session was given a proxy script");
  await w.ws.dispose();
});

test("an agent asking for a private app gets an error and no tab; the refusal is audited", async () => {
  const w = await fakeWorld();
  const r = w.ws.gateOpen({ by: "agent", url: `${WIKI}/home` });
  assert.match(r.error, /is a workspace app: a workspace app does not open in an agent's tab/);
  assert.equal(r.partition, undefined);
  assert.deepEqual(w.ws.audit.read().map((x) => [x.action, x.verdict, x.tab, x.origin]), [["open", "deny", "agent", WIKI]]);
  await w.ws.dispose();
});

test("an agent's and an InPrivate tab already open are refused the private app, with the dark page", async () => {
  const w = await fakeWorld();
  const agent = w.page(1, { by: "agent", kind: "web", viewSpec: { webPartition: "persist:aither-browser-agent" } }, "https://example.com/");
  const priv = w.page(2, { by: "you", kind: "web", private: true, viewSpec: { webPartition: "aither-inprivate" } }, "https://example.com/");
  for (const [id, wc] of [[1, agent], [2, priv]]) {
    await assert.rejects(() => w.ws.beforeLoad({ webContents: wc }, `${WIKI}/home`), /workspace policy/);
    assert.equal(wc.loaded.length, 1, `tab ${id} got the dark page, not the app`);
    assert.ok(wc.loaded[0].startsWith("data:"));
    let prevented = false;
    assert.equal(w.ws.onNavigate(id, `${WIKI}/x`, { preventDefault() { prevented = true; } }), true);
    assert.equal(prevented, true);
  }
  assert.deepEqual(w.opened, [], "neither was moved into a work tab");
  assert.ok(w.notices.some((n) => n.id === 1 && /agent's tab/.test(n.text)) && w.notices.some((n) => n.id === 2 && /InPrivate/.test(n.text)));
  await w.ws.dispose();
});

test("an ordinary owner tab that heads for a workspace app is stopped and a work tab opens instead", async () => {
  const w = await fakeWorld();
  const wc = w.page(1, { by: "you", kind: "web", viewSpec: { webPartition: "persist:aither-browser" } }, "https://example.com/");
  assert.equal(await w.ws.beforeLoad({ webContents: wc }, `${WIKI}/a`), true);
  let prevented = false;
  assert.equal(w.ws.onNavigate(1, `${WIKI}/b`, { preventDefault() { prevented = true; } }), true);
  assert.equal(prevented, true);
  assert.deepEqual(w.opened.map((o) => [o.by, o.url]), [["you", `${WIKI}/a`], ["you", `${WIKI}/b`]]);
  assert.deepEqual(wc.loaded, []);
  // A page in the work partition goes on as usual, and so does everything that is not governed.
  const work = w.page(2, { by: "you", kind: "web", viewSpec: { webPartition: "persist:aither-work-acme" } }, `${WIKI}/a`);
  assert.equal(await w.ws.beforeLoad({ webContents: work }, `${WIKI}/c`), false);
  assert.equal(w.ws.onNavigate(2, "https://login.example.com/sso", { preventDefault() { throw new Error("not stopped"); } }), false);
  assert.equal(w.ws.onNavigate(1, "https://example.com/next", { preventDefault() { throw new Error("not stopped"); } }), false);
  // A console page or a signed-in hosted page is not moved (and does not loop).
  w.page(3, { by: "you", kind: "hosted", viewSpec: { webPartition: "persist:aither-browser" } }, "https://example.com/");
  assert.equal(w.ws.onNavigate(3, `${WIKI}/d`, { preventDefault() { throw new Error("not stopped"); } }), false);
  await w.ws.dispose();
});

test("the door's credential is given to the work session only, for the door only", async () => {
  const w = await fakeWorld();
  w.ws.gateOpen({ by: "you", url: `${WIKI}/` });
  await w.ws.ready();
  const login = w.appHandlers.login;
  assert.equal(typeof login, "function");
  const port = w.ws.door.port();
  const ask = (wc, authInfo) => {
    const out = { prevented: false, answer: "untouched" };
    login({ preventDefault() { out.prevented = true; } }, wc, {}, authInfo, (...args) => { out.answer = args; });
    return out;
  };
  const doorInfo = { isProxy: true, host: "127.0.0.1", port, realm: REALM, scheme: "basic" };
  const workWc = { isDestroyed: () => false, session: w.session.fromPartition("persist:aither-work-acme") };
  const got = ask(workWc, doorInfo);
  assert.equal(got.prevented, true);
  assert.deepEqual(got.answer, [w.ws.door.credential().username, w.ws.door.credential().password]);
  for (const part of ["persist:aither-browser", "persist:aither-browser-agent", "aither-inprivate"]) {
    const refused = ask({ isDestroyed: () => false, session: w.session.fromPartition(part) }, doorInfo);
    assert.deepEqual([refused.prevented, refused.answer], [true, []], `${part} gets no credential`);
  }
  assert.deepEqual(ask(undefined, doorInfo).answer, [], "a request with no page behind it gets none");
  // Anything that is not the door asking is left to the browser (never answered with the door's secret).
  for (const other of [{ ...doorInfo, isProxy: false }, { ...doorInfo, port: port + 1 }, { ...doorInfo, host: "proxy.example.com" }, { ...doorInfo, realm: "corp" }]) {
    const left = ask(workWc, other);
    assert.deepEqual([left.prevented, left.answer], [false, "untouched"]);
  }
  await w.ws.dispose();
});

test("a tampered policy takes the credential and the private hosts away from the work session", async () => {
  const w = await fakeWorld();
  w.ws.gateOpen({ by: "you", url: `${WIKI}/` });
  await w.ws.ready();
  const open = w.page(1, { by: "you", kind: "web", viewSpec: { webPartition: "persist:aither-work-acme" } }, `${WIKI}/home`);
  const forged = policyDoc();
  forged.apps[0].deny = [];
  fs.writeFileSync(path.join(w.dir, P.POLICY_FILE), JSON.stringify(forged));
  assert.equal((await w.ws.reload()).state, "invalid");
  // Review finding 9: the private host is NOT set free to go direct. It stays pointed at the door, which refuses it.
  const proxy = w.sessions.get("persist:aither-work-acme").proxy;
  assert.equal(proxy.mode, "pac_script");
  const script = Buffer.from(proxy.pacScript.split(",")[1], "base64").toString();
  assert.match(script, /"wiki\.corp\.test"/);
  assert.match(script, new RegExp(`PROXY 127\\.0\\.0\\.1:${w.ws.door.port()}"`));
  assert.equal(w.ws.policy.privateTarget("wiki.corp.test", 80), null, "and the door maps it nowhere");
  const out = { answer: "untouched" };
  w.appHandlers.login({ preventDefault() {} }, { isDestroyed: () => false, session: w.session.fromPartition("persist:aither-work-acme") }, {},
    { isProxy: true, host: "127.0.0.1", port: w.ws.door.port(), realm: REALM }, (...a) => { out.answer = a; });
  assert.deepEqual(out.answer, [], "no credential while the policy is not in force");
  assert.equal(open.loaded.length, 1, "the open app was replaced by the dark page");
  assert.ok(w.notices.some((n) => n.id === 1 && /did not open/.test(n.text) && /signature/.test(n.text)));
  assert.deepEqual(w.ws.gateOpen({ by: "you", url: `${WIKI}/` }), {}, "no work tab is built for a closed app");
  await assert.rejects(() => w.ws.beforeLoad({ webContents: open }, `${WIKI}/home`), /workspace policy/);
  await w.ws.dispose();
});

test("a block is said once and audited once, with the origin only", async () => {
  const w = await fakeWorld();
  const wc = w.page(1, { by: "you", kind: "web", viewSpec: { webPartition: "persist:aither-work-acme" } }, `${WIKI}/secret/page?id=7`);
  assert.equal(w.ws.blocks(1, "copy"), true);
  assert.equal(w.ws.blocks(1, "copy"), true, "still blocked the second time");
  assert.equal(w.ws.blocksMenu(1, "copy"), true);
  assert.equal(w.ws.blocksMenu(1, "select-all"), false);
  assert.equal(w.ws.blocks(1, "paste"), false, "not on this app's list");
  assert.equal(w.ws.blocksAction(1, "print"), true);
  assert.equal(w.ws.blocksAction(1, "reload"), false);
  assert.equal(w.ws.blocksPermission(wc, "clipboard-sanitized-write", { quiet: true }), true);
  assert.equal(w.ws.blocksPermission(wc, "notifications"), false);
  const rows = w.ws.audit.read();
  assert.deepEqual(rows.map((r) => [r.action, r.verdict, r.tab, r.origin, r.tenant]), [["copy", "deny", "work", WIKI, "acme"], ["print", "deny", "work", WIKI, "acme"]]);
  assert.ok(!JSON.stringify(rows).includes("secret"));
  assert.deepEqual(w.notices.map((n) => n.text), ["Copying is turned off on wiki.corp.test by your workspace policy.",
    "Printing is turned off on wiki.corp.test by your workspace policy."]);
  // A download from the app, and a file of the app asked for from another page.
  let cancelled = 0;
  assert.equal(w.ws.blocksDownload({ getURL: () => "https://cdn.example.com/f.bin", cancel() { cancelled += 1; } }, wc), true);
  const elsewhere = w.page(2, { by: "you", kind: "web", viewSpec: {} }, "https://example.com/");
  assert.equal(w.ws.blocksDownload({ getURL: () => `${WIKI}/export.csv`, cancel() { cancelled += 1; } }, elsewhere), true);
  assert.equal(w.ws.blocksDownload({ getURL: () => "https://example.com/f.bin", cancel() { cancelled += 1; } }, elsewhere), false);
  assert.equal(cancelled, 2);
  await w.ws.dispose();
});

test("with no policy nothing is blocked, moved or proxied", async () => {
  const w = await fakeWorld({ doc: null });
  const wc = w.page(1, { by: "you", kind: "web", viewSpec: {} }, `${WIKI}/home`);
  assert.deepEqual(w.ws.gateOpen({ by: "you", url: `${WIKI}/` }), {});
  assert.deepEqual(w.ws.gateOpen({ by: "agent", url: `${WIKI}/` }), {});
  assert.equal(await w.ws.beforeLoad({ webContents: wc }, `${WIKI}/home`), false);
  for (const a of P.ACTIONS) assert.equal(w.ws.blocks(1, a), false, a);
  await w.ws.ready();
  assert.equal(w.sessions.size, 0);
  assert.equal(w.ws.door.port(), 0, "the door is not even listening");
  assert.deepEqual(w.ws.audit.read(), []);
  await w.ws.dispose();
});

// ---------------------------------------------------------------- security review of PR #81

const PUBLIC = "https://crm.example.com";
const twoApps = (over = {}) => policyDoc({ apps: [
  { origin: WIKI, private: { host: "127.0.0.1", port: 9 }, deny: ["copy", "capture"], watermark: true },
  { origin: PUBLIC, deny: ["copy"] },
], ...over });

// Finding 1.
test("debugDoor names every way this desk can be driven from outside, and nothing when there is none", () => {
  const cl = (...names) => ({ hasSwitch: (n) => names.includes(n) });
  assert.equal(W.debugDoor({ commandLine: cl(), env: {} }), "");
  assert.equal(W.debugDoor({}), "");
  assert.equal(W.debugDoor({ commandLine: cl("remote-debugging-port"), env: {} }), "--remote-debugging-port");
  assert.equal(W.debugDoor({ commandLine: cl("remote-debugging-pipe"), env: {} }), "--remote-debugging-pipe");
  assert.equal(W.debugDoor({ commandLine: cl("remote-debugging-address", "remote-debugging-port"), env: {} }), "--remote-debugging-port, --remote-debugging-address");
  assert.equal(W.debugDoor({ commandLine: cl(), env: { DESK_CDP_PORT: "9223" } }), "DESK_CDP_PORT", "main.cjs turns this into the switch");
  assert.equal(W.debugDoor({ commandLine: cl("remote-debugging-port"), env: { DESK_CDP_PORT: "9223" } }), "--remote-debugging-port", "named once");
  assert.equal(W.debugDoor({ commandLine: cl(), env: { DESK_CDP_PORT: "off" } }), "", "main.cjs ignores a value that is not a port, and so does this");
  assert.equal(W.debugDoor({ commandLine: cl(), env: {}, inspectorUrl: "ws://127.0.0.1:9229/x" }), "the Node inspector");
  assert.equal(W.debugDoor({ commandLine: { hasSwitch() { throw new Error("x"); } }, env: {} }), "");
  assert.deepEqual([...W.DEBUG_SWITCHES], ["remote-debugging-port", "remote-debugging-pipe", "remote-debugging-address"]);
});

test("with remote debugging on, governed apps are refused with the reason and the door is never started", async () => {
  const w = await fakeWorld({ debugDoor: () => "DESK_CDP_PORT" });
  assert.equal(w.ws.policy.status().state, "unsafe");
  assert.deepEqual(w.ws.gateOpen({ by: "you", url: `${WIKI}/` }), {}, "no work tab is built");
  const wc = w.page(1, { by: "you", kind: "web", viewSpec: { webPartition: "persist:aither-browser" } }, "https://example.com/");
  await assert.rejects(() => w.ws.beforeLoad({ webContents: wc }, `${WIKI}/home`), /remote debugging is on \(DESK_CDP_PORT\)/);
  assert.ok(wc.loaded[0].startsWith("data:"), "the dark page");
  assert.ok(w.notices.some((n) => n.id === 1 && /remote debugging is on \(DESK_CDP_PORT\)/.test(n.text)), "said in the toolbar");
  await w.ws.ready();
  assert.equal(w.ws.door.port(), 0, "the door is not listening");
  assert.equal(w.appHandlers.login, undefined, "and no proxy login is answered");
  const proxy = w.sessions.get("persist:aither-work-acme").proxy;
  assert.match(Buffer.from(proxy.pacScript.split(",")[1], "base64").toString(), /PROXY 127\.0\.0\.1:1"/, "the private host points at a closed port, not DIRECT");
  assert.equal(w.ws.blocks(1, "copy"), false, "an ordinary page is as before");
  await w.ws.dispose();
  // A desk with no workspace policy: remote debugging changes nothing.
  const plain = await fakeWorld({ doc: null, debugDoor: () => "DESK_CDP_PORT" });
  const page = plain.page(1, { by: "you", kind: "web", viewSpec: {} }, `${WIKI}/home`);
  assert.equal(await plain.ws.beforeLoad({ webContents: page }, `${WIKI}/home`), false);
  assert.deepEqual(plain.notices, []);
  await plain.ws.dispose();
});

// Finding 2.
test("until the platform confirms the policy in this launch, a private app does not open and gets no credential", async () => {
  const w = await fakeWorld({ platform: null });
  assert.equal(w.ws.policy.status().state, "ok", "the local policy is good");
  assert.deepEqual(w.ws.gateOpen({ by: "you", url: `${WIKI}/` }), {}, "no work tab for the private app");
  const wc = w.page(1, { by: "you", kind: "web", viewSpec: { webPartition: "persist:aither-work-acme" } }, "https://example.com/");
  await assert.rejects(() => w.ws.beforeLoad({ webContents: wc }, `${WIKI}/home`), /after the platform has confirmed/);
  await w.ws.ready();
  const out = { answer: "untouched" };
  if (w.appHandlers.login) {
    w.appHandlers.login({ preventDefault() {} }, { isDestroyed: () => false, session: w.session.fromPartition("persist:aither-work-acme") }, {},
      { isProxy: true, host: "127.0.0.1", port: w.ws.door.port(), realm: REALM }, (...a) => { out.answer = a; });
    assert.deepEqual(out.answer, [], "the work session gets no door credential");
  }
  assert.equal(w.ws.policy.privateTarget("wiki.corp.test", 80), null);
  await w.ws.dispose();
});

// Finding 4.
test("an agent gets no governed app at all, and no read or capture of one it is somehow on", async () => {
  const w = await fakeWorld({ doc: twoApps() });
  const r = w.ws.gateOpen({ by: "agent", url: `${PUBLIC}/deals` });
  assert.match(r.error, /crm\.example\.com is a workspace app/);
  const agent = w.page(1, { by: "agent", kind: "web", viewSpec: { webPartition: "persist:aither-browser" } }, "https://example.com/");
  await assert.rejects(() => w.ws.beforeLoad({ webContents: agent }, `${PUBLIC}/deals`), /agent's tab/);
  let prevented = false;
  assert.equal(w.ws.onNavigate(1, `${PUBLIC}/x`, { preventDefault() { prevented = true; } }), true);
  assert.equal(prevented, true);
  // Somehow on the page anyway (a redirect that slipped, a popup): the read and the screenshot are still refused.
  const onIt = w.page(2, { by: "agent", kind: "web", viewSpec: {} }, `${WIKI}/home`);
  assert.equal(w.ws.blocksRead(2, "read"), true);
  assert.equal(w.ws.blocksRead(2, "snapshot"), true);
  assert.equal(w.ws.blocks(2, "capture"), true, "what screenshot() asks");
  assert.equal(onIt.loaded.length, 0);
  assert.deepEqual(w.ws.audit.read().filter((x) => x.action === "capture").map((x) => [x.verdict, x.tab]), [["deny", "agent"]]);
  await w.ws.dispose();
});

// Finding 7.
test("the selection is a copy: it is not read for anyone when the app forbids copying", async () => {
  assert.deepEqual(W.readActions("selection"), ["capture", "copy"]);
  assert.deepEqual(W.readActions("read"), ["capture"]);
  assert.deepEqual(W.readActions("overview"), ["capture"]);
  const w = await fakeWorld({ doc: twoApps() });
  w.page(1, { by: "you", kind: "web", viewSpec: { webPartition: "persist:aither-work-acme" } }, `${PUBLIC}/deal/7`); // deny: copy only
  assert.equal(w.ws.blocksRead(1, "selection"), true, "the side panel's notes and 'selection' get nothing");
  assert.equal(w.ws.blocksRead(1, "read"), false, "capture is not denied on this app");
  assert.deepEqual(w.ws.audit.read().map((x) => [x.action, x.verdict, x.origin]), [["copy", "deny", PUBLIC]]);
  assert.match(w.notices[0].text, /^Copying is turned off on crm\.example\.com/);
  w.page(2, { by: "you", kind: "web", viewSpec: {} }, "https://example.com/");
  assert.equal(w.ws.blocksRead(2, "selection"), false, "an ordinary page is as before");
  await w.ws.dispose();
});

// Finding 3.
test("a request for a private app from a page that is not a governed app is cancelled and audited", async () => {
  const w = await fakeWorld({ doc: twoApps() });
  const app = w.page(1, { by: "you", kind: "web", viewSpec: { webPartition: "persist:aither-work-acme" } }, `${WIKI}/home`);
  const stray = w.page(2, { by: "you", kind: "web", viewSpec: { webPartition: "persist:aither-work-acme" } }, "https://evil.example/landing");
  const req = (webContents, over = {}) => w.ws.cancelsRequest({ url: `${WIKI}/api/secrets`, resourceType: "xhr", webContents, ...over });
  assert.equal(req(app), false, "the app's own request goes through");
  assert.equal(req(stray), true, "an ungoverned page in the work session gets nothing from the private app");
  assert.equal(req(stray, { resourceType: "subFrame" }), true, "nor a frame of it");
  assert.equal(req(null), true, "nor a request with no page behind it");
  assert.equal(req(stray, { resourceType: "mainFrame" }), false, "a navigation is the gate's to judge");
  assert.equal(w.ws.cancelsRequest({ url: "https://cdn.example.com/a.js", resourceType: "script", webContents: stray }), false, "other hosts are untouched");
  assert.equal(w.ws.cancelsRequest({ url: "http://[", resourceType: "xhr", webContents: stray }), true, "an address that cannot be read is not waved through");
  const rows = w.ws.audit.read().filter((x) => x.action === "request");
  assert.ok(rows.length >= 3 && rows.every((x) => x.verdict === "deny" && x.origin === WIKI && !JSON.stringify(x).includes("secrets")), JSON.stringify(rows));
  await w.ws.dispose();
});

test("a policy for another workspace than the signed-in account's closes the apps", async () => {
  let tenant = "acme";
  const w = await fakeWorld({ accountTenant: async () => tenant });
  const open = w.page(1, { by: "you", kind: "web", viewSpec: { webPartition: "persist:aither-work-acme" } }, `${WIKI}/home`);
  await w.ws.refreshUser();
  assert.equal(w.ws.policy.status().state, "ok");
  assert.equal(open.loaded.length, 0);
  tenant = "globex";
  await w.ws.refreshUser();
  assert.equal(w.ws.policy.status().state, "invalid");
  assert.equal(open.loaded.length, 1, "the open app was replaced by the dark page");
  assert.ok(w.notices.some((n) => n.id === 1 && /signed in to another one/.test(n.text)));
  assert.equal(w.ws.policy.privateTarget("wiki.corp.test", 80), null);
  tenant = ""; // signed out: not known, the binding is not applied
  await w.ws.refreshUser();
  assert.equal(w.ws.policy.status().state, "ok");
  await w.ws.dispose();
});
