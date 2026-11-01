"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { createFilesAccess } = require("./files-access.cjs");
const { createFilesOps, cleanName, freeCopyName } = require("./files-ops.cjs");
const { filesHandlers, senderAllowed, guardHandlers, PAGE_FILE } = require("./files-window.cjs");
const { pathToFileURL } = require("node:url");
const Module = require("node:module");

/** Two places (A, B), a folder OUTSIDE both, and a junction in A pointing outside. */
function sandbox(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "awdesk-files-ops-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const home = path.join(dir, "home");
  const a = path.join(dir, "A");
  const b = path.join(dir, "B");
  const outside = path.join(dir, "outside");
  for (const d of [home, path.join(a, "docs"), b, outside]) fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(a, "docs", "todo.md"), "# todo\n");
  fs.writeFileSync(path.join(a, "note.txt"), "hello");
  fs.writeFileSync(path.join(a, ".env"), "SECRET=PLANTED\n");
  fs.writeFileSync(path.join(outside, "secret.txt"), "PLANTED-OUTSIDE");
  let junction = true;
  try {
    fs.symlinkSync(outside, path.join(a, "escape"), "junction");
  } catch {
    junction = false;
  }
  const castFile = path.join(dir, "cast.json");
  fs.writeFileSync(castFile, JSON.stringify({ version: 1, files: { roots: [
    { path: a, label: "A" }, { path: b, label: "B" }] } }));
  const files = createFilesAccess({ castFile, home, grantsFile: path.join(dir, "grants.json") });
  const ids = Object.fromEntries(files.roots().roots.map((r) => [r.label, r.id]));
  const trashed = [];
  const trash = async (p) => { trashed.push(p); };
  const ops = createFilesOps({ files, trash });
  return { dir, a, b, outside, files, ids, ops, trashed, junction };
}

test("cleanName accepts one plain segment and refuses climbs, separators, aliases and devices", () => {
  assert.equal(cleanName("  report v2.md "), "report v2.md");
  for (const bad of ["..", ".", "a/b", "a\\b", "x:y", "a.", "a. ", "CON", "nul.txt", "COM1", "", "a\u0001"]) {
    assert.throws(() => cleanName(bad), Error, `expected ${JSON.stringify(bad)} to be refused`);
  }
});

test("freeCopyName picks the first free 'name - Copy' like Explorer", () => {
  const taken = new Set([path.join("d", "a - Copy.txt")]);
  assert.equal(freeCopyName("d", "a.txt", (p) => taken.has(p)), "a - Copy (2).txt");
  assert.equal(freeCopyName("d", ".gitignore", () => false), ".gitignore - Copy");
});

test("mkdir makes a real folder and numbers a clash", async (t) => {
  const s = sandbox(t);
  const one = await s.ops.mkdir(s.ids.A, "", "New folder");
  const two = await s.ops.mkdir(s.ids.A, "", "New folder");
  assert.equal(one.ok, true);
  assert.equal(one.created, "New folder");
  assert.equal(two.created, "New folder (2)");
  assert.equal(fs.statSync(path.join(s.a, "New folder (2)")).isDirectory(), true);
});

test("rename renames in place and the new name exists", async (t) => {
  const s = sandbox(t);
  const res = await s.ops.rename(s.ids.A, "note.txt", "renamed.txt");
  assert.equal(res.ok, true);
  assert.equal(res.rel, "renamed.txt");
  assert.equal(fs.readFileSync(path.join(s.a, "renamed.txt"), "utf8"), "hello");
  assert.equal(fs.existsSync(path.join(s.a, "note.txt")), false);
});

test("rename is confined: a .. name, a .. source and a separator name are refused", async (t) => {
  const s = sandbox(t);
  const climbName = await s.ops.rename(s.ids.A, "note.txt", "..");
  assert.equal(climbName.ok, false);
  assert.match(climbName.reason, /climbs out/);
  const slashName = await s.ops.rename(s.ids.A, "note.txt", "../../outside/x.txt");
  assert.equal(slashName.ok, false);
  assert.match(slashName.reason, /cannot contain/);
  const climbSrc = await s.ops.rename(s.ids.A, "../outside/secret.txt", "mine.txt");
  assert.equal(climbSrc.ok, false);
  assert.match(climbSrc.reason, /climbs out of the root/);
  assert.equal(fs.readFileSync(path.join(s.outside, "secret.txt"), "utf8"), "PLANTED-OUTSIDE");
  const root = await s.ops.rename(s.ids.A, "", "x");
  assert.equal(root.ok, false);
  assert.match(root.reason, /the place itself/);
});

test("rename through a junction that points outside the root is refused", async (t) => {
  const s = sandbox(t);
  if (!s.junction) return t.skip("this machine cannot make a junction");
  const res = await s.ops.rename(s.ids.A, "escape/secret.txt", "taken.txt");
  assert.equal(res.ok, false);
  assert.match(res.reason, /outside the root/);
  assert.equal(fs.existsSync(path.join(s.outside, "secret.txt")), true);
  assert.equal(fs.existsSync(path.join(s.outside, "taken.txt")), false);
});

test("move between places lands the file and removes it from the source folder", async (t) => {
  const s = sandbox(t);
  const res = await s.ops.move(s.ids.A, ["note.txt"], s.ids.B, "");
  assert.equal(res.ok, true);
  assert.equal(res.done[0].rel, "note.txt");
  assert.equal(fs.readFileSync(path.join(s.b, "note.txt"), "utf8"), "hello");
  assert.equal(fs.existsSync(path.join(s.a, "note.txt")), false);
});

test("move is confined: a .. destination, a junction destination and a folder into itself are refused", async (t) => {
  const s = sandbox(t);
  const up = await s.ops.move(s.ids.A, ["note.txt"], s.ids.A, "..");
  assert.equal(up.ok, false);
  assert.match(up.reason, /climbs out/);
  const self = await s.ops.move(s.ids.A, ["docs"], s.ids.A, "docs");
  assert.equal(self.ok, false);
  assert.equal(self.failed[0].reason, "a folder cannot go inside itself");
  assert.equal(fs.existsSync(path.join(s.a, "docs", "todo.md")), true);
  if (s.junction) {
    const viaLink = await s.ops.move(s.ids.A, ["note.txt"], s.ids.A, "escape");
    assert.equal(viaLink.ok, false);
    assert.match(viaLink.reason, /outside the root/);
    assert.equal(fs.existsSync(path.join(s.outside, "note.txt")), false);
  }
  assert.equal(fs.existsSync(path.join(s.a, "note.txt")), true);
});

test("move refuses to overwrite and names the remedy", async (t) => {
  const s = sandbox(t);
  fs.writeFileSync(path.join(s.b, "note.txt"), "already here");
  const res = await s.ops.move(s.ids.A, ["note.txt"], s.ids.B, "");
  assert.equal(res.ok, false);
  assert.match(res.failed[0].reason, /already exists there -- rename one of them first/);
  assert.equal(fs.readFileSync(path.join(s.b, "note.txt"), "utf8"), "already here");
});

test("a cross-volume move copies, then sends the SOURCE to the Recycle Bin", async (t) => {
  const s = sandbox(t);
  const real = fs.renameSync;
  t.mock.method(fs, "renameSync", (from, to) => {
    if (String(to).startsWith(s.b)) { const e = new Error("EXDEV"); e.code = "EXDEV"; throw e; }
    return real(from, to);
  });
  const res = await s.ops.move(s.ids.A, ["note.txt"], s.ids.B, "");
  assert.equal(res.ok, true);
  assert.equal(fs.readFileSync(path.join(s.b, "note.txt"), "utf8"), "hello");
  assert.deepEqual(s.trashed.map((p) => path.basename(p)), ["note.txt"]);
});

test("copy into the same folder makes 'name - Copy' and keeps the original", async (t) => {
  const s = sandbox(t);
  const res = await s.ops.copy(s.ids.A, ["note.txt", "docs"], s.ids.A, "");
  assert.equal(res.ok, true);
  assert.deepEqual(res.done.map((d) => d.name), ["note - Copy.txt", "docs - Copy"]);
  assert.equal(fs.readFileSync(path.join(s.a, "note - Copy.txt"), "utf8"), "hello");
  assert.equal(fs.readFileSync(path.join(s.a, "docs - Copy", "todo.md"), "utf8"), "# todo\n");
  assert.equal(fs.existsSync(path.join(s.a, "note.txt")), true);
});

test("delete goes to the Recycle Bin: trash gets the path and nothing is unlinked here", async (t) => {
  const s = sandbox(t);
  const unlink = t.mock.method(fs, "unlinkSync");
  const rm = t.mock.method(fs, "rmSync");
  const res = await s.ops.remove(s.ids.A, ["note.txt", "docs"]);
  assert.equal(res.ok, true);
  assert.deepEqual(res.done.map((d) => d.trashed), ["note.txt", "docs"]);
  assert.deepEqual(s.trashed.map((p) => path.basename(p)), ["note.txt", "docs"]);
  // The fake bin kept them: files-ops itself removed nothing.
  assert.equal(fs.existsSync(path.join(s.a, "note.txt")), true);
  assert.equal(unlink.mock.callCount(), 0);
  assert.equal(rm.mock.callCount(), 0);
});

test("delete with no Recycle Bin wired refuses and the file survives", async (t) => {
  const s = sandbox(t);
  const ops = createFilesOps({ files: s.files });
  const res = await ops.remove(s.ids.A, ["note.txt"]);
  assert.equal(res.ok, false);
  assert.match(res.reason, /Recycle Bin is not wired in this build -- nothing was deleted/);
  assert.equal(fs.existsSync(path.join(s.a, "note.txt")), true);
});

test("delete of a path climbing out of the root never reaches the bin", async (t) => {
  const s = sandbox(t);
  const res = await s.ops.remove(s.ids.A, ["../outside/secret.txt", ...(s.junction ? ["escape/secret.txt"] : [])]);
  assert.equal(res.ok, false);
  assert.equal(res.failed.length, s.junction ? 2 : 1);
  assert.deepEqual(s.trashed, []);
});

test("the files-window trash channel calls shell.trashItem, never a hard delete", async (t) => {
  const s = sandbox(t);
  const binned = [];
  const handlers = filesHandlers({ files: s.files, shell: { trashItem: async (p) => { binned.push(p); } } });
  const res = await handlers["desk:files-trash"]({}, s.ids.A, ["note.txt"]);
  assert.equal(res.ok, true);
  assert.equal(path.basename(binned[0]), "note.txt");
  assert.equal(fs.existsSync(path.join(s.a, "note.txt")), true);
});

test("importPaths copies a dropped outside file into the confined folder", async (t) => {
  const s = sandbox(t);
  const res = await s.ops.importPaths([path.join(s.outside, "secret.txt")], s.ids.B, "");
  assert.equal(res.ok, true);
  assert.equal(fs.readFileSync(path.join(s.b, "secret.txt"), "utf8"), "PLANTED-OUTSIDE");
  assert.equal(fs.existsSync(path.join(s.outside, "secret.txt")), true);
  const relative = await s.ops.importPaths(["secret.txt"], s.ids.B, "");
  assert.equal(relative.failed[0].reason, "not an absolute path");
});

test("preview answers text and image, properties count a folder", async (t) => {
  const s = sandbox(t);
  fs.writeFileSync(path.join(s.a, "dot.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  const text = await s.ops.preview(s.ids.A, "docs/todo.md");
  assert.equal(text.kind, "text");
  assert.equal(text.text, "# todo\n");
  const img = await s.ops.preview(s.ids.A, "dot.png");
  assert.equal(img.kind, "image");
  assert.match(img.dataUrl, /^data:image\/png;base64,iVBORw==$/);
  const pdf = (fs.writeFileSync(path.join(s.a, "x.pdf"), "%PDF-1.4"), await s.ops.preview(s.ids.A, "x.pdf"));
  assert.equal(pdf.kind, "pdf");
  assert.match(pdf.url, /^file:\/\/.*x\.pdf$/);
  const props = await s.ops.properties(s.ids.A, "docs");
  assert.equal(props.ok, true);
  assert.equal(props.kind, "dir");
  assert.deepEqual({ files: props.contents.files, folders: props.contents.folders }, { files: 1, folders: 0 });
});

test("Send to Aitherium posts multipart folder=files with the bearer, and never leaks it", async (t) => {
  const s = sandbox(t);
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    return { ok: true, status: 200, json: async () => ({ success: true }) };
  };
  const ops = createFilesOps({ files: s.files, fetchImpl, token: () => "tok-PLANTED", origin: () => "https://veil.test/" });
  const res = await ops.sendToAitherium(s.ids.A, ["note.txt"]);
  assert.equal(res.ok, true);
  assert.equal(res.folder, "files");
  assert.equal(calls[0].url, "https://veil.test/api/strata/upload");
  assert.equal(calls[0].init.headers.Authorization, "Bearer tok-PLANTED");
  assert.equal(calls[0].init.body.get("folder"), "files");
  assert.equal(calls[0].init.body.get("file").name, "note.txt");
  assert.equal(await calls[0].init.body.get("file").text(), "hello");

  const failing = createFilesOps({ files: s.files, token: () => "tok-PLANTED", origin: () => "https://veil.test",
    fetchImpl: async () => ({ ok: false, status: 500, json: async () => ({ error: "strata down" }) }) });
  const bad = await failing.sendToAitherium(s.ids.A, ["note.txt", "docs"]);
  assert.equal(bad.ok, false);
  assert.deepEqual(bad.failed.map((f) => f.reason), ["strata down", "folders are not sent -- open it and send its files"]);
  assert.equal(JSON.stringify(bad).includes("tok-PLANTED"), false);

  const signedOut = createFilesOps({ files: s.files, token: () => null, fetchImpl });
  assert.match((await signedOut.sendToAitherium(s.ids.A, ["note.txt"])).reason, /not signed in -- sign in to Aither/);
});

test("Ask Aither reuses file-ask over the owner reader and never ships a credential file", async (t) => {
  const s = sandbox(t);
  const seen = [];
  const fileAsk = ({ files }) => ({ ask: async ({ root, path: rel, question }) => {
    const read = files.read(root, rel, {});
    seen.push(read.text);
    return { ok: true, answer: `${question}: ${read.text}`, evidence: [] };
  } });
  const ops = createFilesOps({ files: s.files, fileAsk });
  const res = await ops.ask(s.ids.A, "note.txt", "what");
  assert.equal(res.ok, true);
  assert.equal(res.answer, "what: hello");
  assert.throws(() => ops.ownerRead(s.ids.A, ".env"), /credential -- it is never sent to a model/);
  const env = await createFilesOps({ files: s.files }).ask(s.ids.A, ".env", "what is the secret");
  assert.equal(env.ok, false);
  assert.match(env.reason, /never sent to a model/);
  assert.deepEqual(seen, ["hello"]);
});

test("the address bar resolves a path inside a place and refuses one outside with the remedy", async (t) => {
  const s = sandbox(t);
  const inside = await s.ops.resolveAddress(path.join(s.a, "docs", "todo.md"));
  assert.deepEqual({ ok: inside.ok, rootId: inside.rootId, rel: inside.rel, select: inside.select },
    { ok: true, rootId: s.ids.A, rel: "docs", select: "docs/todo.md" });
  const outside = await s.ops.resolveAddress(s.outside);
  assert.equal(outside.ok, false);
  assert.match(outside.reason, /outside your places -- add its folder with "Add folder"/);
});

test("the agent half of files-access still has no write verb", (t) => {
  const s = sandbox(t);
  assert.deepEqual(Object.keys(s.files.agent).sort(), ["list", "read", "roots"]);
});

// ── review fixes 2026-11-01 ──────────────────────────────────────────────────

test("a case-only rename refuses when the other-cased name is a DIFFERENT file (case-sensitive folder)", async (t) => {
  const s = sandbox(t);
  const upper = path.join(s.a, "NOTE.txt");
  const sensitive = !fs.existsSync(upper);
  if (sensitive) fs.writeFileSync(upper, "the other file");
  // On NTFS the two names are one entry; report a different inode for NOTE.txt to model a
  // per-directory case-sensitive folder (WSL-created), where rename would REPLACE it.
  const real = (p) => fs.lstatSync(p, { bigint: true });
  const lstat = (p) => (path.basename(p) === "NOTE.txt" ? { dev: real(p).dev, ino: real(p).ino + 1n } : real(p));
  const ops = createFilesOps({ files: s.files, trash: async () => {}, lstat });
  const res = await ops.rename(s.ids.A, "note.txt", "NOTE.txt");
  assert.equal(res.ok, false);
  assert.equal(res.reason, "NOTE.txt already exists here -- pick another name");
  assert.deepEqual(fs.readdirSync(s.a).filter((n) => n.toLowerCase() === "note.txt").sort(),
    sensitive ? ["NOTE.txt", "note.txt"] : ["note.txt"]);
  assert.equal(fs.readFileSync(path.join(s.a, "note.txt"), "utf8"), "hello");
});

test("a case-only rename of the SAME file still works", async (t) => {
  const s = sandbox(t);
  const res = await s.ops.rename(s.ids.A, "note.txt", "Note.txt");
  assert.equal(res.ok, true);
  assert.equal(res.rel, "Note.txt");
  assert.ok(fs.readdirSync(s.a).includes("Note.txt"));
  assert.equal(fs.readFileSync(path.join(s.a, "Note.txt"), "utf8"), "hello");
});

/** The pure DROP-PLAN block of files.html's inline script, evaluated on its own. */
function loadDropPlan() {
  const html = fs.readFileSync(path.join(__dirname, "files.html"), "utf8");
  const begin = html.indexOf("// DROP-PLAN:BEGIN");
  const end = html.indexOf("// DROP-PLAN:END");
  assert.ok(begin > 0 && end > begin, "files.html carries the DROP-PLAN block");
  return { html, dropPlan: new Function(`${html.slice(begin, end)}\nreturn dropPlan;`)() };
}

test("a stale in-page drag never moves the old selection when Explorer files are dropped", () => {
  const { dropPlan } = loadDropPlan();
  const stale = { rootId: "a", rels: ["old.txt"], at: 0, paths: [String.raw`C:\A\old.txt`] };
  assert.equal(dropPlan(stale, [String.raw`C:\Users\me\Downloads\new.pdf`], 10 * 60_000), "import");
  assert.equal(dropPlan(stale, [String.raw`c:\a\OLD.txt`], 10 * 60_000), "mine");
  assert.equal(dropPlan({ ...stale, paths: null }, [String.raw`C:\A\old.txt`], 1), "import");
  assert.equal(dropPlan(stale, [], 1_000), "mine");
  assert.equal(dropPlan(stale, [], 10 * 60_000), "empty");
  assert.equal(dropPlan(null, [String.raw`C:\x.txt`], 0), "import");
});

test("files.html clears the drag on dragend and imports dropped File objects, never page paths", () => {
  const { html } = loadDropPlan();
  assert.match(html, /addEventListener\("dragend", \(\) => \{ state\.dragging = null; \}\)/);
  assert.match(html, /files\.importFiles\(ev\.dataTransfer\.files, dst\.rootId, dst\.rel, ev\.shiftKey\)/);
  assert.doesNotMatch(html, /files\.importPaths\(/);
  assert.match(html, /res\.routed !== true/);
});

test("the files IPC answers only the local files.html frame, by exact file path", () => {
  const page = pathToFileURL(PAGE_FILE).href;
  assert.equal(senderAllowed({ senderFrame: { url: page } }), true);
  assert.equal(senderAllowed({ senderFrame: { url: `${page}?pane=1#x` } }), true);
  for (const bad of ["https://evil.example/files.html", pathToFileURL(path.join(os.tmpdir(), "files.html")).href,
    `${page.replace(/files\.html$/, "x/files.html")}`, "data:text/html,files.html", ""]) {
    assert.equal(senderAllowed({ senderFrame: { url: bad } }), false, bad);
  }
  assert.equal(senderAllowed({}), false);
});

test("a refused frame never reaches the import handler", async () => {
  const calls = [];
  const guarded = guardHandlers({ "desk:files-import": (_e, paths) => { calls.push(paths); return { ok: true }; } });
  const res = await guarded["desk:files-import"]({ senderFrame: { url: "https://evil.example/files.html" } },
    [path.join(os.homedir(), ".ssh", "id_ed25519")], "A", "", true);
  assert.equal(res.ok, false);
  assert.match(res.reason, /^1 caller refused -- /);
  assert.deepEqual(calls, []);
  const ok = await guarded["desk:files-import"]({ senderFrame: { url: pathToFileURL(PAGE_FILE).href } }, ["x"]);
  assert.equal(ok.ok, true);
});

test("the preload's import resolves File objects itself and drops page-made strings", async (t) => {
  let api = null;
  const invoked = [];
  const fake = {
    contextBridge: { exposeInMainWorld: (_n, value) => { api = value; } },
    ipcRenderer: { invoke: async (...args) => { invoked.push(args); return { ok: true }; } },
    webUtils: { getPathForFile: (f) => (f && f.__disk) || "" },
  };
  const realLoad = Module._load;
  Module._load = function load(request, ...rest) { return request === "electron" ? fake : realLoad.call(this, request, ...rest); };
  t.after(() => { Module._load = realLoad; });
  const file = require.resolve("./files-preload.cjs");
  delete require.cache[file];
  require(file);
  assert.equal(typeof api.importFiles, "function");
  assert.equal(api.importPaths, undefined);
  const dropped = String.raw`C:\drop\a.txt`;
  await api.importFiles([{ __disk: dropped }, String.raw`C:\Users\me\.ssh\id_rsa`, { name: "made-up" }], "A", "docs", true);
  assert.deepEqual(invoked[0], ["desk:files-import", [dropped], "A", "docs", true]);
});
