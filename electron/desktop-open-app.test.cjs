"use strict";
// desktop_open's `app` (owner 2026-10-31: agents bring the window to you, not "click here").
const assert = require("node:assert/strict");
const test = require("node:test");
const { Client } = require("@modelcontextprotocol/sdk/client/index.js");
const { StreamableHTTPClientTransport } = require("@modelcontextprotocol/sdk/client/streamableHttp.js");
const { createBridgeServer } = require("./bridge-server.cjs");
const { createDeskMcpHandler, desktopAppRefusal } = require("./mcp-server.cjs");

test("desktopAppRefusal: consent windows, bad ids and the wrong surface are refused", () => {
  assert.equal(desktopAppRefusal("app", "files"), null);
  assert.equal(desktopAppRefusal("app", undefined), null);
  assert.equal(desktopAppRefusal("overlay", undefined), null);
  for (const denied of ["auth", "portal", "this-device"]) assert.match(desktopAppRefusal("app", denied), /may not open/);
  assert.match(desktopAppRefusal("app", "../etc"), /not an OS app id/);
  assert.match(desktopAppRefusal("overlay", "files"), /surface=app/);
});

test("desktop_open over MCP hands the app id to the desk, and never calls it when refused", async (t) => {
  const calls = [];
  const mcpHandler = createDeskMcpHandler({
    onAnimation: () => true,
    onWindowAction: () => true,
    getStatus: () => ({ windowVisible: true, voiceState: null, listener: null }),
    onDesktop: (surface, opts) => { calls.push([surface, opts?.app ?? null]); return { ok: true, opened: surface, app: opts?.app ?? null }; },
  });
  const bridge = createBridgeServer({ port: 0, onEvent: () => {}, mcpHandler });
  const address = await bridge.listen();
  const client = new Client({ name: "desk-test-open-app", version: "1.0.0" });
  t.after(async () => { await client.close(); await bridge.close(); });
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${address.port}/mcp`)));

  const ok = await client.callTool({ name: "desktop_open", arguments: { surface: "app", app: "files" } });
  assert.notEqual(ok.isError, true);
  assert.deepEqual(calls, [["app", "files"]]);

  const no = await client.callTool({ name: "desktop_open", arguments: { surface: "app", app: "auth" } });
  assert.equal(no.isError, true);
  assert.deepEqual(calls, [["app", "files"]], "a refused app must never reach the desk");
});
