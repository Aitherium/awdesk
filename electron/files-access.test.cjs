"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const cast = require("./cast-config.cjs");
const {
  createFilesAccess, agentToolCall, cleanRel, agentDenied, agentDeniedRel, AGENT_TOOLS,
} = require("./files-access.cjs");
const { filesHandlers, handOffLine } = require("./files-window.cjs");

function sandbox(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "awdesk-files-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const home = path.join(dir, "home");
  for (const sub of ["Desktop", "Documents", "Downloads"]) fs.mkdirSync(path.join(home, sub), { recursive: true });
  const shared = path.join(dir, "shared");
  const privateDir = path.join(dir, "private");
  fs.mkdirSync(path.join(shared, "notes"), { recursive: true });
  fs.mkdirSync(privateDir, { recursive: true });
  fs.writeFileSync(path.join(shared, "notes", "todo.md"), "# todo\nship the files page\n");
  fs.writeFileSync(path.join(shared, ".env"), "SECRET=PLANTED-ENV\n");
  fs.writeFileSync(path.join(shared, "id_ed25519"), "PLANTED-KEY\n");
  fs.writeFileSync(path.join(shared, "blob.bin"), Buffer.from([1, 2, 0, 3]));
  fs.writeFileSync(path.join(privateDir, "diary.txt"), "PLANTED-PRIVATE\n");
  const castFile = path.join(dir, "cast.json");
  return { dir, home, shared, privateDir, castFile };
}

function writeCast(file, roots) {
  fs.writeFileSync(file, JSON.stringify({ version: 1, files: { roots } }, null, 2));
}

/** The owner's switch, by label (the grant lives in the machine-local grants file). */
function share(files, label) {
  const root = files.roots().roots.find((r) => r.label === label);
  files.setAgentRead(root.id, true);
  return root;
}

test("cast.json files.roots validates: absolute or ~ paths and a label; a synced agentRead is dropped", () => {
  const ok = cast.validateCast({ version: 1, files: { roots: ["~/Documents", { path: "/srv/x", label: "X",
    agentRead: true }] } });
  assert.deepEqual(ok.problems, []);
  assert.deepEqual(ok.config.files.roots, [
    { path: "~/Documents", label: null },
    { path: "/srv/x", label: "X" },
  ], "the grant never rides in cast.json, which syncs across machines");
  const rel = cast.validateCast({ version: 1, files: { roots: ["relative/dir"] } });
  assert.equal(rel.problems.length, 1);
  assert.equal(rel.problems[0].path, "files.roots.0");
  assert.equal(cast.resolveDesk({ version: 1 }, { env: {} }).files.roots, null, "unset = builtin home folders");
});

test("no roots authored -> the home folders, none shared with agents", (t) => {
  const s = sandbox(t);
  const files = createFilesAccess({ castFile: s.castFile, home: s.home });
  const { roots, source } = files.roots();
  assert.equal(source, "builtin");
  assert.deepEqual(roots.map((r) => r.label), ["Home", "Desktop", "Documents", "Downloads"]);
  assert.ok(roots.every((r) => r.exists && !r.agentRead));
  assert.deepEqual(files.agent.roots(), [], "agents see nothing until the owner grants");
});

test("owner listing: dirs first, hidden flagged, confined to the root", (t) => {
  const s = sandbox(t);
  writeCast(s.castFile, [{ path: s.shared, label: "Shared" }]);
  const files = createFilesAccess({ castFile: s.castFile, home: s.home });
  const [root] = files.roots().roots;
  const top = files.list(root.id, "");
  assert.equal(top.entries[0].name, "notes");
  assert.equal(top.entries[0].kind, "dir");
  assert.ok(top.entries.find((e) => e.name === ".env").hidden);
  assert.equal(top.parent, null);
  const inner = files.list(root.id, "notes");
  assert.equal(inner.parent, "");
  assert.deepEqual(inner.entries.map((e) => e.rel), ["notes/todo.md"]);
  assert.throws(() => files.list(root.id, "../private"), /climbs out/);
  assert.throws(() => files.list(root.id, s.privateDir), /relative to the root|climbs out|not found/);
  assert.throws(() => files.locate(root.id, "notes/../../private/diary.txt"), /climbs out/);
  assert.equal(files.locate(root.id, "notes/todo.md").path, path.join(s.shared, "notes", "todo.md"));
});

test("agents: refused on an ungranted root, allowed read-only after the owner's switch", (t) => {
  const s = sandbox(t);
  writeCast(s.castFile, [{ path: s.shared, label: "Shared" }, { path: s.privateDir, label: "Private" }]);
  const files = createFilesAccess({ castFile: s.castFile, home: s.home });
  const [shared, priv] = files.roots().roots;
  assert.throws(() => files.agent.list(shared.id, ""), /not shared with agents/);
  assert.throws(() => files.agent.read(shared.id, "notes/todo.md"), /not shared with agents/);

  files.setAgentRead(shared.id, true);
  assert.deepEqual(files.agent.roots().map((r) => r.label), ["Shared"]);
  const read = files.agent.read("Shared", "notes/todo.md");
  assert.equal(read.binary, false);
  assert.match(read.text, /ship the files page/);
  assert.throws(() => files.agent.read(priv.id, "diary.txt"), /not shared with agents/);
  // The grant is machine-local (~/.aither/desk-file-grants.json), never cast.json.
  assert.equal(files.grantsPath, path.join(s.home, ".aither", "desk-file-grants.json"));
  const grants = JSON.parse(fs.readFileSync(files.grantsPath, "utf8")).grants;
  assert.deepEqual(grants, { [shared.id]: true });
  const onDisk = JSON.parse(fs.readFileSync(s.castFile, "utf8"));
  assert.ok(onDisk.files.roots.every((r) => r.agentRead === undefined), "cast.json carries no grant");

  files.setAgentRead(shared.id, false);
  assert.throws(() => files.agent.read(shared.id, "notes/todo.md"), /not shared with agents/, "revoke is immediate");
});

test("agents never see keys or .env files, even inside a granted root; binary is metadata only", (t) => {
  const s = sandbox(t);
  writeCast(s.castFile, [{ path: s.shared, label: "Shared" }]);
  const files = createFilesAccess({ castFile: s.castFile, home: s.home });
  share(files, "Shared");
  const listing = files.agent.list("Shared", "");
  const names = listing.entries.map((e) => e.name);
  assert.ok(!names.includes(".env") && !names.includes("id_ed25519"));
  assert.equal(listing.withheld, 2);
  assert.throws(() => files.agent.read("Shared", ".env"), /withheld/);
  assert.throws(() => files.agent.read("Shared", "id_ed25519"), /withheld/);
  const bin = files.agent.read("Shared", "blob.bin");
  assert.equal(bin.binary, true);
  assert.equal(bin.text, null);
  for (const n of [".env.local", "server.pem", "session-bearer", ".ssh", "credentials.json", "secrets.yaml"]) {
    assert.ok(agentDenied(n), n);
  }
  assert.ok(!agentDenied("notes.md"));
});

test("a symlink inside a granted root that points outside it is refused", (t) => {
  const s = sandbox(t);
  writeCast(s.castFile, [{ path: s.shared, label: "Shared" }]);
  const link = path.join(s.shared, "escape");
  try {
    fs.symlinkSync(s.privateDir, link, "junction");
  } catch (error) {
    t.skip(`cannot create a link here: ${error.code}`);
    return;
  }
  const files = createFilesAccess({ castFile: s.castFile, home: s.home });
  share(files, "Shared");
  assert.throws(() => files.agent.read("Shared", "escape/diary.txt"), /outside the root/);
  assert.throws(() => files.list(files.roots().roots[0].id, "escape"), /outside the root/);
});

test("read caps bytes and pages with offset", (t) => {
  const s = sandbox(t);
  fs.writeFileSync(path.join(s.shared, "big.txt"), "a".repeat(5000));
  writeCast(s.castFile, [{ path: s.shared, label: "Shared" }]);
  const files = createFilesAccess({ castFile: s.castFile, home: s.home });
  share(files, "Shared");
  const first = files.agent.read("Shared", "big.txt", { maxBytes: 1000 });
  assert.equal(first.text.length, 1000);
  assert.equal(first.truncated, true);
  const last = files.agent.read("Shared", "big.txt", { maxBytes: 1000, offset: 4500 });
  assert.equal(last.text.length, 500);
  assert.equal(last.truncated, false);
});

test("add/remove a root writes cast.json; a builtin set is materialised first", (t) => {
  const s = sandbox(t);
  const files = createFilesAccess({ castFile: s.castFile, home: s.home });
  const added = files.addRoot(s.shared);
  assert.equal(added.added, true);
  const roots = files.roots().roots;
  assert.equal(roots.length, 5);
  assert.equal(files.roots().source, "file");
  assert.equal(files.addRoot(s.shared).added, false, "adding twice is a no-op");
  assert.throws(() => files.addRoot("relative"), /absolute/);
  files.removeRoot(added.id);
  assert.equal(files.roots().roots.length, 4);
});

test("the agent tool call: refusals are isError with the sentence that says how to get access", (t) => {
  const s = sandbox(t);
  writeCast(s.castFile, [{ path: s.shared, label: "Shared" }]);
  const files = createFilesAccess({ castFile: s.castFile, home: s.home });
  assert.deepEqual(AGENT_TOOLS, ["files_roots", "files_list", "files_read"]);
  const none = agentToolCall(files.agent, "files_roots", {});
  assert.equal(none.isError, false);
  assert.match(none.content[0].text, /has not shared any folder/);
  const refused = agentToolCall(files.agent, "files_read", { root: "Shared", path: "notes/todo.md" });
  assert.equal(refused.isError, true);
  assert.match(refused.content[0].text, /grants it in the Files page/);
  assert.equal(agentToolCall(files.agent, "files_write", {}).isError, true);
  files.setAgentRead(files.roots().roots[0].id, true);
  const ok = agentToolCall(files.agent, "files_read", { root: "Shared", path: "notes/todo.md" });
  assert.equal(ok.isError, false);
  assert.match(JSON.parse(ok.content[0].text).text, /ship the files page/);
});

test("cleanRel normalises and refuses climbs and drive paths", () => {
  assert.equal(cleanRel("a\\b/./c/"), "a/b/c");
  assert.equal(cleanRel("/"), "");
  assert.throws(() => cleanRel("a/../../b"), /climbs out/);
  assert.throws(() => cleanRel("C:/Windows"), /relative/);
});

test("IPC: open/reveal/hand act on the resolved path; hand says whether agents can read it", async (t) => {
  const s = sandbox(t);
  writeCast(s.castFile, [{ path: s.shared, label: "Shared" }]);
  const files = createFilesAccess({ castFile: s.castFile, home: s.home });
  const opened = [];
  const revealed = [];
  const posted = [];
  const shell = {
    openPath: async (p) => { opened.push(p); return ""; },
    showItemInFolder: (p) => revealed.push(p),
  };
  const handOff = async (text, meta) => { posted.push({ text, meta }); return { ok: true }; };
  const h = filesHandlers({ files, shell, handOff, pickFolder: async () => s.privateDir });
  const id = files.roots().roots[0].id;
  const want = path.join(s.shared, "notes", "todo.md");

  assert.equal((await h["desk:files-open"]({}, id, "notes/todo.md")).ok, true);
  assert.deepEqual(opened, [want]);
  assert.equal((await h["desk:files-reveal"]({}, id, "notes/todo.md")).ok, true);
  assert.deepEqual(revealed, [want]);

  const hand = await h["desk:files-hand"]({}, id, "notes/todo.md");
  assert.equal(hand.ok, true);
  assert.equal(posted[0].meta.path, want);
  assert.equal(posted[0].meta.agentRead, false);
  assert.match(posted[0].text, /NOT shared with agents/);
  assert.ok(posted[0].text.includes(want));
  assert.deepEqual(files.agent.roots(), [], "handing over a path grants nothing");

  const granted = await h["desk:files-grant"]({}, id, true);
  assert.equal(granted.ok, true);
  await h["desk:files-hand"]({}, id, "notes/todo.md");
  assert.match(posted[1].text, /agents may read it/);

  const escape = await h["desk:files-open"]({}, id, "../private/diary.txt");
  assert.equal(escape.ok, false);
  assert.match(escape.error, /climbs out/);
  assert.equal(opened.length, 1, "a refused path is never opened");

  const failing = filesHandlers({ files, shell: { openPath: async () => "No application is associated" } });
  const res = await failing["desk:files-open"]({}, id, "notes/todo.md");
  assert.equal(res.ok, false);
  assert.match(res.error, /No application/);

  const added = await h["desk:files-add-root"]();
  assert.equal(added.ok, true);
  assert.equal(added.data.added, true);
  const cancelled = await filesHandlers({ files, pickFolder: async () => null })["desk:files-add-root"]();
  assert.equal(cancelled.data.cancelled, true);
});

test("IPC: hand-to-agent with no chat wired is an error, not a silent drop", async (t) => {
  const s = sandbox(t);
  writeCast(s.castFile, [{ path: s.shared, label: "Shared" }]);
  const files = createFilesAccess({ castFile: s.castFile, home: s.home });
  const id = files.roots().roots[0].id;
  const res = await filesHandlers({ files })["desk:files-hand"]({}, id, "notes/todo.md");
  assert.equal(res.ok, false);
  assert.match(res.error, /not wired/);
  const refused = await filesHandlers({ files, handOff: async () => ({ ok: false, detail: "relay down" }) })[
    "desk:files-hand"]({}, id, "notes/todo.md");
  assert.equal(refused.ok, false);
  assert.match(refused.error, /relay down/);
  assert.match(handOffLine({ path: "/x", root: { label: "R", agentRead: true } }), /files_read/);
});

test("a grant on one machine is not a grant on another: cast.json agentRead is never honoured", (t) => {
  const s = sandbox(t);
  // A cast.json synced from another machine where the folder WAS shared.
  writeCast(s.castFile, [{ path: s.shared, label: "Shared", agentRead: true }]);
  const files = createFilesAccess({ castFile: s.castFile, home: s.home });
  assert.equal(files.roots().roots[0].agentRead, false);
  assert.deepEqual(files.agent.roots(), []);
  assert.throws(() => files.agent.read("Shared", "notes/todo.md"), /not shared with agents/);
  share(files, "Shared");
  // Same cast.json, a different machine (its own home, so its own grants file).
  const otherHome = path.join(s.dir, "other-home");
  fs.mkdirSync(otherHome);
  const other = createFilesAccess({ castFile: s.castFile, home: otherHome });
  assert.deepEqual(other.agent.roots(), [], "the grant did not travel with cast.json");
  assert.equal(files.agent.roots().length, 1);
  // A corrupt grants file is "nothing shared", never "everything shared".
  fs.writeFileSync(files.grantsPath, "{not json");
  assert.deepEqual(files.agent.roots(), []);
});

test("Claude/gh/cloud credential stores are withheld from agents", () => {
  for (const n of [".credentials.json", "credentials.json", ".claude.json", "desk-file-grants.json"]) {
    assert.ok(agentDenied(n), n);
  }
  for (const rel of [".claude/.credentials.json", ".config/gh/hosts.yml", "AppData/x/gh/hosts.yaml",
    ".docker/config.json", ".config/gcloud/application_default_credentials.json", ".aither/session-bearer",
    "a\\.ssh\\config"]) {
    assert.ok(agentDeniedRel(rel), rel);
  }
  assert.ok(!agentDeniedRel("notes/hosts.yml"));
  assert.ok(!agentDeniedRel("notes/todo.md"));
  assert.ok(!agentDeniedRel(""));
});

test("an 8.3 short name of a denied file is withheld (judged on the native real path)", (t) => {
  const s = sandbox(t);
  fs.mkdirSync(path.join(s.shared, ".ssh"));
  fs.writeFileSync(path.join(s.shared, ".ssh", "config"), "PLANTED-SSH\n");
  writeCast(s.castFile, [{ path: s.shared, label: "Shared" }]);
  const files = createFilesAccess({ castFile: s.castFile, home: s.home });
  share(files, "Shared");
  if (!fs.existsSync(path.join(s.shared, "ENV~1")) || !fs.existsSync(path.join(s.shared, "SSH~1"))) {
    t.skip("8.3 short names are not generated on this volume");
    return;
  }
  assert.throws(() => files.agent.read("Shared", "ENV~1"), /withheld/);
  assert.throws(() => files.agent.read("Shared", "SSH~1/config"), /withheld/);
  assert.throws(() => files.agent.list("Shared", "SSH~1"), /withheld/);
  const viaTool = agentToolCall(files.agent, "files_read", { root: "Shared", path: "ENV~1" });
  assert.equal(viaTool.isError, true);
  assert.ok(!viaTool.content[0].text.includes("PLANTED"));
  assert.ok(!files.agent.list("Shared", "").entries.some((e) => e.name === ".ssh" || e.name === ".env"));
  // The owner still reaches it from the page.
  assert.ok(files.locate(files.roots().roots[0].id, "ENV~1").path);
});

test("an innocently named link to a denied file or folder is withheld, read and list", (t) => {
  const s = sandbox(t);
  fs.mkdirSync(path.join(s.shared, ".aither"));
  fs.writeFileSync(path.join(s.shared, ".aither", "session-bearer"), "PLANTED-BEARER\n");
  writeCast(s.castFile, [{ path: s.shared, label: "Shared" }]);
  const files = createFilesAccess({ castFile: s.castFile, home: s.home });
  share(files, "Shared");
  try {
    fs.symlinkSync(path.join(s.shared, ".aither"), path.join(s.shared, "docs"), "junction");
  } catch (error) {
    t.skip(`cannot create a junction here: ${error.code}`);
    return;
  }
  assert.throws(() => files.agent.read("Shared", "docs/session-bearer"), /withheld/);
  assert.throws(() => files.agent.list("Shared", "docs"), /withheld/);
  const top = files.agent.list("Shared", "");
  assert.ok(!top.entries.some((e) => e.name === "docs"), "the alias is not even listed");
  assert.ok(!JSON.stringify(top).includes("PLANTED"));

  let fileLink = true;
  try {
    fs.symlinkSync(path.join(s.shared, ".env"), path.join(s.shared, "readme.txt"), "file");
  } catch {
    fileLink = false; // file symlinks need Developer Mode/admin on Windows
  }
  if (fileLink) {
    assert.throws(() => files.agent.read("Shared", "readme.txt"), /withheld/);
    assert.ok(!files.agent.list("Shared", "").entries.some((e) => e.name === "readme.txt"));
  }
});
