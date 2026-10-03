"use strict";

// End to end on the desk side: an agent's chrome_* MCP call -> the queue -> a
// (fake) awconnect long-polling GET /chrome/next over real HTTP -> POST
// /chrome/result -> the agent's answer. And the origin rule: ONLY the pinned
// extension may poll or answer -- a local page answering would feed an agent
// forged page content.

const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const { Client } = require("@modelcontextprotocol/sdk/client/index.js");
const { StreamableHTTPClientTransport } = require("@modelcontextprotocol/sdk/client/streamableHttp.js");
const { createBridgeServer } = require("./bridge-server.cjs");
const { createDeskMcpHandler } = require("./mcp-server.cjs");
const { createChromeBridge } = require("./chrome-bridge.cjs");

const EXTENSION = "chrome-extension://hlmfknhcfhjjngckfpacgleffckpmphe";

function request(port, { method, path, origin, body }) {
  return new Promise((resolve, reject) => {
    const data = body == null ? null : Buffer.from(JSON.stringify(body));
    const headers = { host: `127.0.0.1:${port}` };
    if (origin) headers.origin = origin;
    if (data) Object.assign(headers, { "content-type": "application/json", "content-length": data.length });
    const req = http.request({ host: "127.0.0.1", port, path, method, headers }, (res) => {
      let raw = "";
      res.on("data", (c) => { raw += c; });
      res.on("end", () => resolve({ status: res.statusCode, body: raw ? JSON.parse(raw) : null }));
    });
    req.on("error", reject);
    req.end(data);
  });
}

test("an agent's chrome_read reaches awconnect over the bridge and comes back", async (t) => {
  const chromeBridge = createChromeBridge();
  const base = { onAnimation: () => true, onWindowAction: () => true, getStatus: () => ({ windowVisible: true }) };
  const server = createBridgeServer({
    port: 0, onEvent: () => {}, bridgeToken: null, chromeBridge,
    mcpHandler: createDeskMcpHandler({ ...base, onChrome: (a, args) => chromeBridge.call(a, args) }),
  });
  const { port } = await server.listen();
  const client = new Client({ name: "chrome-route-test", version: "1.0.0" });
  t.after(async () => { await client.close(); await server.close(); });
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`)));

  const names = (await client.listTools()).tools.map((x) => x.name);
  for (const tool of ["chrome_tabs", "chrome_request_tab", "chrome_read", "chrome_snapshot", "chrome_click",
    "chrome_type", "chrome_select", "chrome_check"]) {
    assert.ok(names.includes(tool), tool);
  }

  // A local page may NOT pose as awconnect.
  assert.equal((await request(port, { method: "GET", path: "/chrome/next", origin: "http://localhost:3000" })).status, 403);
  assert.equal((await request(port, { method: "GET", path: "/chrome/next" })).status, 403, "no origin is not awconnect either");

  const agent = client.callTool({ name: "chrome_read", arguments: { tab: 42 } });
  const polled = await request(port, { method: "GET", path: "/chrome/next", origin: EXTENSION });
  assert.equal(polled.status, 200);
  assert.equal(polled.body.action, "read");
  assert.deepEqual(polled.body.args, { tab: 42 });
  const forged = await request(port, { method: "POST", path: "/chrome/result", origin: "https://evil.test",
    body: { id: polled.body.id, result: { ok: true, text: "forged" } } });
  assert.equal(forged.status, 403);
  const answered = await request(port, { method: "POST", path: "/chrome/result", origin: EXTENSION,
    body: { id: polled.body.id, result: { ok: false, refused: true, error: "REFUSED: the owner has not approved tab 42." } } });
  assert.equal(answered.status, 200);
  const out = await agent;
  assert.equal(out.isError, true);
  assert.match(JSON.parse(out.content[0].text).error, /^REFUSED: the owner has not approved tab 42/);
});
