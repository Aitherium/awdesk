"use strict";

/**
 * W4-04: a model chosen in the Deck's Models section lands in characters/ through the
 * roster funnel, exactly once, and is then visible everywhere the roster is read --
 * listCharacters() and the desk MCP's list_characters.
 *
 * Every fixture lives in a per-process temp dir (DESK_ROSTER_DIR and friends are set
 * BEFORE the roster modules load), so the real characters/ tree is never touched.
 */

const assert = require("node:assert/strict");
const nodeCrypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "desk-avatar-sync-"));
const ROSTER = path.join(TMP, "characters");
process.env.DESK_ROSTER_DIR = ROSTER;
process.env.DESK_ADULT_CONTENT_MIRROR = path.join(TMP, "adult-content.json");
process.env.DESK_ADULT_CONTENT_LOG = path.join(TMP, "adult-content.log");
process.env.DESK_CAST_FILE = path.join(TMP, "cast.json");
process.env.DESK_PARTY_FILE = path.join(TMP, "party.json");
fs.mkdirSync(ROSTER, { recursive: true });
test.after(() => fs.rmSync(TMP, { recursive: true, force: true }));

const roster = require("./character-roster.cjs");
const sync = require("./avatar-library-sync.cjs");

/** The smallest buffer that passes the GLB magic check, made unique by `tag`. */
function fakeVrm(tag) {
  return Buffer.concat([Buffer.from("glTF", "ascii"), Buffer.alloc(16), Buffer.from(String(tag))]);
}
const sha = (b) => nodeCrypto.createHash("sha256").update(b).digest("hex");

/** A fake broker client that counts downloads. */
function fakeClient({ avatars = [], bytes = {}, vroid = {} } = {}) {
  const calls = { libraryModel: 0, vroidModel: 0 };
  return {
    calls,
    async avatarLibrary() {
      return { ok: true, avatars, active: avatars[0] ? avatars[0].id : null };
    },
    async libraryModel(id) {
      calls.libraryModel += 1;
      return bytes[id] ? { ok: true, bytes: bytes[id] } : { ok: false, reason: "no such avatar" };
    },
    async vroidModel(id) {
      calls.vroidModel += 1;
      return vroid[id] ? { ok: true, bytes: vroid[id] } : { ok: false, reason: "no ticket" };
    },
  };
}

function deps(client, extra = {}) {
  const applied = [];
  const parties = [];
  return {
    applied,
    parties,
    client,
    apply: (name) => {
      applied.push(name);
      return roster.listCharacters().includes(name);
    },
    exportParty: () => {
      parties.push(Date.now());
      return { ok: true, members: 1, error: null };
    },
    enrollOptions: {
      consultInstall: async () => ({ allow: true, reachable: true }),
      spawn: () => ({ unref() {} }),
    },
    ...extra,
  };
}

test("a library entry is installed once and appears in listCharacters", async () => {
  const bytes = fakeVrm("mira");
  const record = { id: "Mira-1a2b3c4d", name: "Mira", rating: "general", size: bytes.length, sha256: sha(bytes) };
  const client = fakeClient({ avatars: [record], bytes: { [record.id]: bytes } });
  const d = deps(client);

  const first = await sync.installLibraryAvatar(record.id, d);
  assert.equal(first.ok, true, first.reason);
  assert.equal(first.name, "mira-1a2b3c4d");
  assert.equal(first.installed, true);
  assert.equal(first.applied, true);
  assert.ok(roster.listCharacters().includes("mira-1a2b3c4d"), "the installed avatar is on the roster");
  assert.deepEqual(fs.readFileSync(path.join(ROSTER, "mira-1a2b3c4d", "model.vrm")), bytes);
  const rec = JSON.parse(fs.readFileSync(path.join(ROSTER, "mira-1a2b3c4d", "character.json"), "utf8"));
  assert.equal(rec.rating, "general");
  assert.equal(rec.source, "library");
  assert.equal(rec.library_sha256, record.sha256);

  const second = await sync.installLibraryAvatar(record.id, d);
  assert.equal(second.ok, true);
  assert.equal(second.installed, false, "the second choice only switches to it");
  assert.equal(client.calls.libraryModel, 1, "the model is downloaded exactly once");
  assert.equal(roster.listCharacters().filter((n) => n === "mira-1a2b3c4d").length, 1);
  assert.deepEqual(d.applied, ["mira-1a2b3c4d", "mira-1a2b3c4d"], "each choice puts it on stage");
  assert.equal(d.parties.length, 2, "party.json is re-exported after each choice");
  assert.equal(fs.readdirSync(ROSTER).filter((f) => f.startsWith(".incoming-")).length, 0, "no temp file is left");

  const view = await sync.libraryView(d);
  assert.equal(view.avatars[0].installed, true);
});

test("bytes that do not match the library's sha256 are refused and nothing is written", async () => {
  const good = fakeVrm("real");
  const record = { id: "Swap-0000aaaa", name: "Swap", rating: "general", sha256: sha(good) };
  const client = fakeClient({ avatars: [record], bytes: { [record.id]: fakeVrm("tampered") } });
  const r = await sync.installLibraryAvatar(record.id, deps(client));
  assert.equal(r.ok, false);
  assert.match(r.reason, /does not match/);
  assert.equal(fs.existsSync(path.join(ROSTER, "swap-0000aaaa")), false);
});

test("non-VRM bytes are refused before the roster", async () => {
  const junk = Buffer.from("<html>login</html>----------");
  const record = { id: "Junk-11112222", name: "Junk", rating: "general", sha256: sha(junk) };
  const client = fakeClient({ avatars: [record], bytes: { [record.id]: junk } });
  const r = await sync.installLibraryAvatar(record.id, deps(client));
  assert.equal(r.ok, false);
  assert.match(r.reason, /not a \.vrm/);
  assert.equal(fs.existsSync(path.join(ROSTER, "junk-11112222")), false);
});

test("a safety-plane refusal writes nothing", async () => {
  const bytes = fakeVrm("nope");
  const record = { id: "Nope-33334444", name: "Nope", rating: "general", sha256: sha(bytes) };
  const client = fakeClient({ avatars: [record], bytes: { [record.id]: bytes } });
  const d = deps(client);
  d.enrollOptions.consultInstall = async () => ({ allow: false, reason: "refused by policy" });
  const r = await sync.installLibraryAvatar(record.id, d);
  assert.equal(r.ok, false);
  assert.match(r.reason, /refused by policy/);
  assert.equal(fs.existsSync(path.join(ROSTER, "nope-33334444")), false);
});

test("an id that is not in YOUR library is refused without a download", async () => {
  const client = fakeClient({ avatars: [] });
  const r = await sync.installLibraryAvatar("Someone-else-1", deps(client));
  assert.equal(r.ok, false);
  assert.equal(client.calls.libraryModel, 0);
});

test("an r18 VRoid model installs hidden while the gate is closed, and says why", async () => {
  const bytes = fakeVrm("vroid-adult");
  const client = fakeClient({ vroid: { "123456": bytes } });
  const d = deps(client);
  const r = await sync.installVroidModel({ id: "123456", name: "A", downloadable: true, r18: true }, d);
  assert.equal(r.ok, true, r.reason);
  assert.equal(r.installed, true);
  assert.equal(r.applied, false);
  assert.match(r.reason, /mature content is currently hidden/);
  assert.equal(roster.listCharacters().includes("vroid-123456"), false);
  const rec = JSON.parse(fs.readFileSync(path.join(ROSTER, "vroid-123456", "character.json"), "utf8"));
  assert.equal(rec.rating, "r18");
  assert.equal(rec.source, "vroid");
});

test("a VRoid model is installed once; a non-downloadable one is never fetched", async () => {
  const bytes = fakeVrm("vroid-ok");
  const client = fakeClient({ vroid: { "777": bytes } });
  const d = deps(client);
  const model = { id: "777", name: "Seven", downloadable: true, r15: false, r18: false };
  assert.equal((await sync.installVroidModel(model, d)).installed, true);
  assert.equal((await sync.installVroidModel(model, d)).installed, false);
  assert.equal(client.calls.vroidModel, 1);
  assert.ok(roster.listCharacters().includes("vroid-777"));

  const locked = await sync.installVroidModel({ id: "888", downloadable: false }, d);
  assert.equal(locked.ok, false);
  assert.equal(client.calls.vroidModel, 1);
});

test("while the gate is closed no R15/R18 row reaches the Deck", async () => {
  const models = [{ id: "1", r18: true }, { id: "2", r15: true }, { id: "3" }];
  assert.deepEqual(sync.visibleVroidModels(models, false).map((m) => m.id), ["3"]);
  assert.equal(sync.visibleVroidModels(models, true).length, 3);
  assert.equal(sync.gateOpen(), false, "no mirror file: the gate fails closed");

  const avatars = [
    { id: "Adult-aaaa0000", rating: "r18", sha256: "x" },
    { id: "Teen-bbbb0000", rating: "r15", sha256: "y" },
    { id: "Plain-cccc0000", rating: "general", sha256: "z" },
  ];
  const closed = await sync.libraryView({ client: fakeClient({ avatars }), isAdultContentVisible: () => false });
  assert.deepEqual(closed.avatars.map((a) => a.id), ["Plain-cccc0000"]);
  const open = await sync.libraryView({ client: fakeClient({ avatars }), isAdultContentVisible: () => true });
  assert.equal(open.avatars.length, 3);
});

test("list_characters over the desk MCP shows an installed library avatar", async (context) => {
  let sdk;
  try {
    sdk = {
      Client: require("@modelcontextprotocol/sdk/client/index.js").Client,
      Transport: require("@modelcontextprotocol/sdk/client/streamableHttp.js").StreamableHTTPClientTransport,
    };
  } catch {
    context.skip("@modelcontextprotocol/sdk is not installed (npm install)");
    return;
  }
  const bytes = fakeVrm("mcp");
  const record = { id: "Echo-5555aaaa", name: "Echo", rating: "general", sha256: sha(bytes) };
  const r = await sync.installLibraryAvatar(record.id, deps(fakeClient({ avatars: [record], bytes: { [record.id]: bytes } })));
  assert.equal(r.ok, true, r.reason);

  const { createDeskMcpHandler } = require("./mcp-server.cjs");
  const { createBridgeServer } = require("./bridge-server.cjs");
  const bridge = createBridgeServer({
    port: 0,
    onEvent: () => {},
    mcpHandler: createDeskMcpHandler({
      onAnimation: () => {},
      onWindowAction: () => true,
      getStatus: () => ({}),
      // The same shape main.cjs hands the MCP server.
      listCharacters: () => ({ characters: roster.listCharacters(), active: null }),
      onCharacter: () => true,
    }),
  });
  const address = await bridge.listen();
  const client = new sdk.Client({ name: "desk-test", version: "1.0.0" });
  context.after(async () => {
    await client.close();
    await bridge.close();
  });
  await client.connect(new sdk.Transport(new URL(`http://127.0.0.1:${address.port}/mcp`)));
  const result = await client.callTool({ name: "list_characters", arguments: {} });
  const listed = JSON.parse(result.content[0].text);
  assert.ok(listed.characters.includes("echo-5555aaaa"), JSON.stringify(listed));
});
