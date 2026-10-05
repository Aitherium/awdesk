"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { extensionsHandlers, fromExtensionsPage, saveDirs, savedDirs } = require("./extensions-window.cjs");

const page = { getURL: () => "aither://extensions/" };
const evt = { sender: page };

function setup() {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "ext-")), "extensions.json");
  const mine = fs.mkdtempSync(path.join(os.tmpdir(), "myext-"));
  fs.writeFileSync(path.join(mine, "manifest.json"), "{}");
  const loaded = [
    { id: "a".repeat(32), name: "awconnect", version: "3.8.0", path: "/builtin", manifest: { side_panel: { default_path: "p.html" } } },
    { id: "b".repeat(32), name: "Mine", version: "1", path: mine, manifest: {} },
  ];
  const removed = [];
  const ses = { extensions: { getAllExtensions: () => loaded, removeExtension: (id) => removed.push(id) } };
  const host = { session: () => ses, awconnectId: () => "a".repeat(32), openExtensionUi: () => ({ ok: true }) };
  saveDirs([mine], { file });
  return { file, mine, removed, handlers: extensionsHandlers({ getHost: () => host, file }) };
}

test("only aither://extensions reaches these channels", async () => {
  assert.equal(fromExtensionsPage(page), true);
  assert.equal(fromExtensionsPage({ getURL: () => "https://evil.test/extensions" }), false);
  const { handlers } = setup();
  for (const h of Object.values(handlers)) {
    assert.equal((await h({ sender: { getURL: () => "aither://settings/" } })).ok, false);
  }
});

test("the list marks awconnect built in and your folder as added", async () => {
  const { handlers } = setup();
  const r = await handlers["desk:extensions-list"](evt);
  assert.deepEqual(r.extensions.map((x) => [x.name, x.builtin, x.added, x.hasUi]),
    [["awconnect", true, false, true], ["Mine", false, true, false]]);
});

test("awconnect cannot be removed; yours can, and leaves the saved list", async () => {
  const { handlers, removed, file, mine } = setup();
  assert.equal((await handlers["desk:extensions-remove"](evt, "a".repeat(32))).ok, false);
  assert.equal((await handlers["desk:extensions-remove"](evt, "b".repeat(32))).ok, true);
  assert.deepEqual(removed, ["b".repeat(32)]);
  assert.deepEqual(savedDirs({ file }), [], `${mine} left the saved list`);
});

test("saved folders: absolute paths that still hold a manifest only", () => {
  const { file, mine } = setup();
  saveDirs([mine, "relative/x", path.join(os.tmpdir(), "gone-ext-folder")], { file });
  assert.deepEqual(savedDirs({ file }), [mine]);
});

test("plugins: only status and install reach adk, and its JSON becomes a plain row", async () => {
  const { runAdkMod } = require("./extensions-window.cjs");
  const calls = [];
  const exec = (cmd, args, _o, cb) => { calls.push([cmd, ...args]); cb(null, JSON.stringify({ active: true, plugin_installed: true,
    plugin_version: "0.2.0", source_version: "0.2.1", plugin_stale: true, function_hooks_enabled: true, note: "restart" }), ""); };
  const r = await runAdkMod("status", exec);
  assert.deepEqual(calls[0], ["adk", "harness", "mod", "status"]);
  assert.equal(r.plugin.stale, true);
  assert.equal((await runAdkMod("uninstall", exec)).ok, false, "no other verb");
  assert.equal(calls.length, 1);
});
