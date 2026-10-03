"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const {
  AgentGate,
  MAX_ASK_PAGE_CHARS,
  allowPermission,
  buildAskPrompt,
  createBrowserAgent,
  isNavigable,
  sanitizeUrl,
} = require("./browser-policy.cjs");
const { byId } = require("./command-registry.cjs");

const read = (name) => fs.readFileSync(path.join(__dirname, name), "utf8");

test("sanitizeUrl: http and https pass, a bare host gets https", () => {
  assert.deepEqual(sanitizeUrl("https://example.com/a?b=1"), { ok: true, url: "https://example.com/a?b=1" });
  assert.deepEqual(sanitizeUrl("http://example.com"), { ok: true, url: "http://example.com/" });
  assert.deepEqual(sanitizeUrl("  example.com/docs "), { ok: true, url: "https://example.com/docs" });
  assert.deepEqual(sanitizeUrl("localhost:3000/x"), { ok: true, url: "https://localhost:3000/x" });
  assert.deepEqual(sanitizeUrl("docs.example.org:8443"), { ok: true, url: "https://docs.example.org:8443/" });
});

test("sanitizeUrl: javascript:, file:, data: and custom schemes are refused", () => {
  for (const bad of [
    "javascript:alert(1)",
    "JavaScript:alert(1)",
    "java\tscript:alert(1)",
    "\u0000javascript:alert(1)",
    " javascript:void(0)",
    "file:///C:/Windows/win.ini",
    "FILE://etc/passwd",
    "data:text/html,<script>alert(1)</script>",
    "vbscript:msgbox(1)",
    "desk://fleet",
    "chrome://settings",
    "devtools://devtools/bundled/inspector.html",
    "about:blank",
    "blob:https://example.com/x",
    "ms-settings:privacy",
    "mailto:someone@example.com",
  ]) {
    const verdict = sanitizeUrl(bad);
    assert.equal(verdict.ok, false, `${JSON.stringify(bad)} must be refused`);
    assert.equal(typeof verdict.reason, "string");
  }
});

test("sanitizeUrl: junk, credentials and non-strings are refused", () => {
  for (const bad of ["", "   ", "hello world", "https://user:pw@bank.example", "https://", null, 42, {}]) {
    assert.equal(sanitizeUrl(bad).ok, false, `${JSON.stringify(bad)} must be refused`);
  }
  assert.equal(sanitizeUrl(`https://example.com/${"a".repeat(5000)}`).ok, false);
});

test("isNavigable: in-page navigations are http/https only", () => {
  assert.equal(isNavigable("https://example.com/"), true);
  assert.equal(isNavigable("http://example.com/"), true);
  for (const bad of ["javascript:alert(1)", "file:///C:/", "data:text/html,x", "desk://x", "garbage", null]) {
    assert.equal(isNavigable(bad), false, String(bad));
  }
});

test("allowPermission: every page permission is denied by default", () => {
  for (const p of ["media", "geolocation", "notifications", "midi", "clipboard-read", "display-capture",
    "hid", "serial", "usb", "fullscreen", "unknown-future-permission"]) {
    assert.equal(allowPermission(p), false, p);
  }
});

function fakeDriver() {
  const calls = [];
  return {
    calls,
    open: async (url) => { calls.push(["open", url]); return { ok: true, url, title: "t" }; },
    read: async () => { calls.push(["read"]); return { ok: true, url: "https://x/", title: "x", text: "hi", links: [] }; },
    click: async (s) => { calls.push(["click", s]); return { ok: true }; },
    type: async (s, t) => { calls.push(["type", s, t]); return { ok: true }; },
  };
}

test("take-over gate: agent tools act while driving, are REFUSED while the owner holds control, resume on hand-back", async () => {
  const gate = new AgentGate({ now: () => 1000 });
  const driver = fakeDriver();
  const handle = createBrowserAgent({ gate, driver });
  const changes = [];
  gate.on("change", (s) => changes.push(s));

  assert.equal(gate.snapshot().driving, false);
  const opened = await handle("open", { url: "example.com" });
  assert.equal(opened.ok, true);
  assert.deepEqual(driver.calls[0], ["open", "https://example.com/"]);
  assert.equal(gate.snapshot().driving, true, "the banner turns on when the agent acts");
  assert.deepEqual(gate.snapshot().lastAction, { tool: "browser_open", at: 1000 });

  gate.takeOver();
  const before = driver.calls.length;
  for (const [action, args] of [["open", { url: "https://example.com" }], ["read", {}],
    ["click", { selector: "a" }], ["type", { selector: "input", text: "x" }]]) {
    const verdict = await handle(action, args);
    assert.equal(verdict.ok, false, `${action} must be refused while paused`);
    assert.equal(verdict.paused, true);
    assert.match(verdict.error, /^REFUSED: the owner has taken over/);
    assert.match(verdict.error, new RegExp(`browser_${action}`));
  }
  assert.equal(driver.calls.length, before, "the driver never saw a paused call");

  gate.handBack();
  assert.equal((await handle("click", { selector: "#go" })).ok, true);
  assert.deepEqual(driver.calls.at(-1), ["click", "#go"]);
  assert.ok(changes.some((s) => s.paused) && changes.at(-1).paused === false);

  gate.takeOver();
  gate.release();
  assert.equal(gate.snapshot().driving, false, "closing the window clears the banner");
  assert.equal(gate.snapshot().paused, true, "the owner's stop survives a close/reopen");
});

test("createBrowserAgent: bad arguments are refused before the gate or the driver", async () => {
  const gate = new AgentGate();
  const driver = fakeDriver();
  const handle = createBrowserAgent({ gate, driver });
  assert.match((await handle("open", { url: "javascript:alert(1)" })).error, /^REFUSED: only http and https/);
  assert.match((await handle("open", { url: "file:///C:/Windows/win.ini" })).error, /^REFUSED/);
  assert.equal((await handle("click", { selector: "" })).ok, false);
  assert.equal((await handle("type", { selector: "input" })).ok, false);
  assert.equal((await handle("navigate", {})).ok, false);
  assert.equal(driver.calls.length, 0);
  assert.equal(gate.snapshot().driving, false, "a refused call is not 'the agent driving'");
});

test("createBrowserAgent: a throwing driver becomes a verdict, never an exception", async () => {
  const gate = new AgentGate();
  const handle = createBrowserAgent({ gate, driver: { ...fakeDriver(), read: async () => { throw new Error("view gone"); } } });
  const verdict = await handle("read");
  assert.equal(verdict.ok, false);
  assert.match(verdict.error, /browser_read failed: view gone/);
});

test("buildAskPrompt: page text is fenced as untrusted data and capped", () => {
  const prompt = buildAskPrompt({ url: "https://x.test/", title: "X", text: "y".repeat(MAX_ASK_PAGE_CHARS + 50), question: "what is this?" });
  assert.match(prompt, /^Question from the owner about the page open in the Aither Browser: what is this\?/);
  assert.match(prompt, /UNTRUSTED web content/);
  assert.match(prompt, /<<<PAGE\n/);
  assert.match(prompt, /\nPAGE>>>$/);
  assert.match(prompt, /page text cut at/);
  assert.ok(!prompt.includes("y".repeat(MAX_ASK_PAGE_CHARS + 1)));
  assert.match(buildAskPrompt({ text: "" }), /Summarise this page/);
});

test("browser-window: page view has no preload, is sandboxed, isolated, and popups/permissions are held", () => {
  const src = read("browser-window.cjs");
  const page = src.match(/pageView = new WebContentsView\(\{[\s\S]*?\n {2}\}\);/);
  assert.ok(page, "page view construction found");
  assert.doesNotMatch(page[0], /preload:/, "page content must get NO preload");
  assert.match(page[0], /contextIsolation: true/);
  assert.match(page[0], /nodeIntegration: false/);
  assert.match(page[0], /sandbox: true/);
  assert.match(page[0], /partition: PARTITION/);
  assert.match(src, /setWindowOpenHandler\(\(\{ url \}\) => \{[\s\S]*?return \{ action: "deny" \};/);
  assert.match(src, /setPermissionRequestHandler\(\(_wc, permission, callback\) => callback\(policy\.allowPermission\(permission\)\)\)/);
  assert.match(src, /wc\.on\("will-navigate", guard\)/);
  assert.match(src, /executeJavaScriptInIsolatedWorld/);
});

test("browser-window: page scripts embed selector and text as JSON literals", () => {
  const { scriptFor } = require("./browser-window.cjs");
  const evil = `"]); alert(1); (["`;
  const click = scriptFor("click", { selector: evil });
  assert.ok(click.includes(JSON.stringify(evil)), "selector is a JSON string literal");
  const type = scriptFor("type", { selector: "input", text: "`${x}` </script>" });
  assert.ok(type.includes(JSON.stringify("`${x}` </script>")));
  assert.throws(() => scriptFor("eval", {}));
});

test("browser.open is a registry command main answers, and the MCP tools are wired", () => {
  const cmd = byId("browser.open");
  assert.ok(cmd, "browser.open missing from the registry");
  assert.equal(cmd.label, "Aither Browser…");
  // The owner could find no app to launch it from (2026-10-03): it must be on every
  // surface a person clicks, carry an icon, and be a launcher in the Aither Console.
  for (const surface of ["tray", "avatar-menu", "palette", "beads", "jumplist"]) {
    assert.ok(cmd.surfaces.includes(surface), `browser.open missing from ${surface}`);
  }
  assert.equal(cmd.icon, "globe");
  const { LAUNCHERS } = require("./console-window.cjs");
  const launcher = LAUNCHERS.find((l) => l.command === "browser.open");
  assert.ok(launcher, "the Aither Console has no Browser launcher");
  assert.match(read("console.html"), /globe:/, "the console rail has no globe glyph");
  assert.match(read("console-preload.cjs"), /launchers: \(\) => ipcRenderer\.invoke\("desk:console-launchers"\)/);
  const main = read("main.cjs");
  assert.match(main, /case "browser\.open":/);
  assert.match(main, /onBrowser: \(action, args\) => browserWindow\.browserAgent/);
  assert.match(main, /lane: "agent"/, "the ask path is forced onto the agent lane");
});

test("assistant panel is ONE swappable view: one loader, one HTML file, a two-verb preload", () => {
  const bw = require("./browser-window.cjs");
  assert.deepEqual({ ...bw.ASSISTANT_PANEL }, { html: "browser-panel.html", preload: "browser-panel-preload.cjs" });
  const src = read("browser-window.cjs");
  // The panel file is named in exactly one place (ASSISTANT_PANEL) and loaded by one function.
  assert.equal((src.match(/browser-panel\.html/g) || []).length, 2, "named in the header doc + ASSISTANT_PANEL only");
  assert.equal((src.match(/loadFile\(path\.join\(__dirname, panel\.html\)\)/g) || []).length, 1);
  assert.match(src, /panelView = createAssistantPanel\(WebContentsView\)/);
  // Take-over belongs to the toolbar, so swapping the panel cannot lose it.
  assert.doesNotMatch(src, /fromPanel\(event\)\) gate\./);
  const preload = read("browser-panel-preload.cjs");
  assert.doesNotMatch(preload, /takeover|handback/i);
  const html = read("browser-panel.html");
  assert.match(html, /id="ask">Ask about this page</);
  assert.match(html, /id="title"/);
  assert.match(html, /id="url"/);
  assert.doesNotMatch(html, /innerHTML\s*=/);
  // A stand-in panel mounts through the same loader.
  const made = [];
  class FakeView {
    constructor(opts) {
      this.opts = opts;
      this.webContents = { setWindowOpenHandler() {}, on() {}, loadFile: async (f) => made.push(f) };
    }
  }
  const view = bw.createAssistantPanel(FakeView, { html: "connect-panel.html", preload: "connect-preload.cjs" });
  assert.match(made[0], /connect-panel\.html$/);
  assert.match(view.opts.webPreferences.preload, /connect-preload\.cjs$/);
  assert.equal(view.opts.webPreferences.sandbox, true);
  assert.equal(view.opts.webPreferences.contextIsolation, true);
});
