"use strict";

/** assist-files: the Explorer verbs. Path jail, no destructive verb, rename never overwrites, folder sends need a card. */

const test = require("node:test");
const assert = require("node:assert/strict");
const files = require("./assist-files.cjs");

function memfs(entries) {
  const m = new Map(Object.entries(entries)); // path -> {dir?:bool, text?:string, size?:number, kids?:[]}
  const renames = [];
  return {
    renames, map: m,
    existsSync: (p) => m.has(String(p)),
    statSync: (p) => { const e = m.get(String(p)); if (!e) throw new Error("ENOENT"); return { isDirectory: () => Boolean(e.dir), size: e.size != null ? e.size : Buffer.byteLength(e.text || "") }; },
    readdirSync: (p) => (m.get(String(p)).kids || []).map((k) => ({ name: k, isDirectory: () => Boolean(m.get(`${p}\\${k}`) && m.get(`${p}\\${k}`).dir) })),
    openSync: (p) => ({ p }),
    readSync: (fd, buf) => { const e = m.get(fd.p); const b = Buffer.from(e.bytes || e.text || ""); b.copy(buf); return b.length; },
    closeSync: () => {},
    renameSync: (a, b) => { renames.push([a, b]); const e = m.get(a); m.delete(a); m.set(b, e); },
  };
}

function rig(entries, extra = {}) {
  const fsImpl = memfs(entries);
  const records = [];
  const engineCalls = [];
  const engine = { run: async (req) => { engineCalls.push(req); return { ok: true, id: "e1", verb: req.verb, kind: "answer", text: extra.reply || "Q3 budget summary" }; } };
  const execs = [];
  const f = files.createAssistFiles({
    fsImpl, existsSync: fsImpl.existsSync, engine, gateway: extra.gateway || null, vision: extra.vision || null,
    confirm: extra.confirm || null, log: { append: (r) => { records.push(r); return extra.logOk === false ? { ok: false, error: "disk full" } : { ok: true }; } },
    execFile: (exe, args, opts, cb) => { execs.push({ exe, args, opts }); cb(extra.execError || null, "", ""); },
    findExe: extra.findExe || (() => null), ...(extra.verifyExe ? { verifyExe: extra.verifyExe } : {}), now: () => 5000,
  });
  return { f, fsImpl, records, engineCalls, execs };
}

const DOC = "C:\\Users\\me\\Docs\\report.txt";
const BASE = { "C:\\Users\\me\\Docs": { dir: true, kids: ["report.txt", "pic.png"] }, [DOC]: { text: "Quarterly budget numbers ..." }, "C:\\Users\\me\\Docs\\pic.png": { text: "x", size: 10 } };

test("the path jail: absolute drive paths only, no .., no wildcards, no verbatim prefix, never Windows / Program Files", () => {
  const ex = (p) => p === "C:\\Users\\me\\a.txt" || p === "C:\\Windows\\System32\\x.dll";
  assert.equal(files.checkPath("C:\\Users\\me\\a.txt", ex).ok, true);
  assert.equal(files.checkPath('"C:\\Users\\me\\a.txt"', ex).ok, true);
  for (const bad of ["", "a.txt", "..\\a.txt", "C:\\Users\\..\\a.txt", "C:\\Users\\*.txt", "\\\\?\\C:\\a.txt", "\\\\server\\share\\a.txt", "C:\\Windows\\System32\\x.dll", "C:\\Program Files\\x\\y.exe", "C:\\Users\\me\\missing.txt"]) {
    assert.equal(files.checkPath(bad, ex).ok, false, bad);
  }
  assert.equal(files.checkPath(["C:\\Users\\me\\a.txt", "C:\\other"], ex).path, "C:\\Users\\me\\a.txt", "a multi-selection takes the first only");
});

test("names the model suggests are made plain: no path, no extension, no reserved device name", () => {
  assert.equal(files.sanitizeName('"2026 Q3 budget review.pdf"'), "2026 Q3 budget review");
  assert.equal(files.sanitizeName("..\\..\\evil: name?"), "evil name");
  assert.equal(files.sanitizeName("CON"), "");
  assert.equal(files.sanitizeName("   "), "");
  assert.equal(files.sanitizeName("first line\nsecond"), "first line");
  assert.ok(files.sanitizeName("x".repeat(500)).length <= 100);
});

test("inspect: text is read and capped; pdf / docx are refused BY NAME; images are marked; folders list", () => {
  const r = rig({ ...BASE, "C:\\Users\\me\\Docs\\a.pdf": { text: "%PDF" }, "C:\\Users\\me\\Docs\\bin.dat": { bytes: Buffer.from([1, 0, 2, 0]), size: 4 } });
  const t = r.f.inspect(DOC);
  assert.ok(t.ok && t.textable && /Quarterly/.test(t.text));
  const pdf = r.f.inspect("C:\\Users\\me\\Docs\\a.pdf");
  assert.equal(pdf.textable, false);
  assert.match(pdf.why, /no text extractor for \.pdf/);
  assert.equal(r.f.inspect("C:\\Users\\me\\Docs\\pic.png").image, true);
  assert.equal(r.f.inspect("C:\\Users\\me\\Docs\\bin.dat").textable, false);
  const dir = r.f.inspect("C:\\Users\\me\\Docs");
  assert.equal(dir.kind, "dir");
  assert.match(dir.text, /report\.txt/);
});

test("summarize / ask go through the engine as fenced selection with surface explorer; an unreadable file never reaches it", async () => {
  const r = rig({ ...BASE, "C:\\Users\\me\\Docs\\a.pdf": { text: "%PDF" } });
  const ok = await r.f.runVerb({ verb: "summarize", info: r.f.inspect(DOC) });
  assert.ok(ok.ok);
  assert.equal(r.engineCalls[0].surface, "explorer");
  assert.match(r.engineCalls[0].ctx.selection, /Quarterly/);
  assert.equal(r.engineCalls[0].ctx.title, "report.txt");
  const bad = await r.f.runVerb({ verb: "summarize", info: r.f.inspect("C:\\Users\\me\\Docs\\a.pdf") });
  assert.equal(bad.ok, false);
  assert.equal(r.engineCalls.length, 1);
});

test("an image is answered by the vision ladder, logged before and after", async () => {
  const seen = [];
  const r = rig(BASE, { vision: async (p, q) => { seen.push([p, q]); return { ok: true, text: "A chart", via: "scheduler" }; } });
  const res = await r.f.runVerb({ verb: "summarize", info: r.f.inspect("C:\\Users\\me\\Docs\\pic.png") });
  assert.equal(res.text, "A chart");
  assert.equal(seen[0][0], "C:\\Users\\me\\Docs\\pic.png");
  assert.deepEqual(r.records.map((x) => x.outcome), ["started", "ok"]);
});

test("rename: proposal first, nothing applied; apply keeps the folder and extension; never overwrites; undo restores", async () => {
  const r = rig({ ...BASE, "C:\\Users\\me\\Docs\\2026 Q3 budget.txt": { text: "taken" } }, { reply: "2026 Q3 budget" });
  const p = await r.f.proposeRename(r.f.inspect(DOC));
  assert.ok(p.ok);
  assert.equal(p.to, "C:\\Users\\me\\Docs\\2026 Q3 budget.txt");
  assert.equal(r.fsImpl.renames.length, 0, "a proposal renames nothing");
  const clash = r.f.applyRename({ from: DOC, name: "2026 Q3 budget" });
  assert.equal(clash.ok, false);
  assert.match(clash.error, /already there/);
  assert.equal(r.fsImpl.renames.length, 0);
  const ok = r.f.applyRename({ from: DOC, name: "Budget notes" });
  assert.ok(ok.ok);
  assert.deepEqual(r.fsImpl.renames[0], [DOC, "C:\\Users\\me\\Docs\\Budget notes.txt"]);
  assert.equal(r.f.applyRename({ from: DOC, name: "..\\..\\evil" }).ok, false, "gone now, and a path-like name is made plain anyway");
  const undo = r.f.undoRename();
  assert.ok(undo.ok);
  assert.deepEqual(r.fsImpl.renames[1], ["C:\\Users\\me\\Docs\\Budget notes.txt", DOC]);
  assert.equal(r.f.undoRename().ok, false, "one undo");
  assert.ok(r.records.some((x) => x.outcome === "undone"));
});

test("rename refuses a folder, a missing file, and a log that cannot be written", async () => {
  const r = rig(BASE);
  assert.equal((await r.f.proposeRename(r.f.inspect("C:\\Users\\me\\Docs"))).ok, false);
  assert.equal(r.f.applyRename({ from: "C:\\Users\\me\\nope.txt", name: "x" }).ok, false);
  const noLog = rig(BASE, { logOk: false });
  const res = noLog.f.applyRename({ from: DOC, name: "Fine name" });
  assert.equal(res.ok, false);
  assert.match(res.error, /action log is not writable/);
  assert.equal(noLog.fsImpl.renames.length, 0);
});

test("convert writes a NEW file beside the original with an argv array and never replaces one", async () => {
  const r = rig({ ...BASE, "C:\\Users\\me\\Docs\\photo.jpg": { text: "x" }, "C:\\Users\\me\\Docs\\photo.png": { text: "already here" } }, { findExe: (t) => (t === "magick" ? "C:\\Tools\\magick.exe" : null) });
  const info = r.f.inspect("C:\\Users\\me\\Docs\\photo.jpg");
  const opts = r.f.conversionsFor(info);
  assert.ok(opts.find((c) => c.id === "png").available);
  assert.equal(opts.find((c) => c.id === "webp").tool, "magick");
  const res = await r.f.convert({ info, to: "png" });
  assert.ok(res.ok);
  assert.equal(res.output, "C:\\Users\\me\\Docs\\photo (converted).png", "the existing photo.png is not replaced");
  assert.deepEqual(r.execs[0].args, ["C:\\Users\\me\\Docs\\photo.jpg", "C:\\Users\\me\\Docs\\photo (converted).png"]);
  assert.equal(r.execs[0].opts.shell, false);
  assert.deepEqual(files.conversionArgs("ffmpeg", "a", "b").slice(0, 4), ["-nostdin", "-hide_banner", "-loglevel", "error"]);
  assert.ok(files.conversionArgs("ffmpeg", "a", "b").includes("-n"), "ffmpeg is told never to overwrite");
  const ff = files.conversionArgs("ffmpeg", "a", "b");
  assert.deepEqual(ff.slice(ff.indexOf("-protocol_whitelist"), ff.indexOf("-protocol_whitelist") + 2), ["-protocol_whitelist", "file"], "a crafted playlist cannot read URLs or other files");
  assert.equal(files.conversionArgs("pandoc", "a", "b")[0], "--sandbox");
});

test("convert says what to install when no tool is there, and refuses unknown targets", async () => {
  const r = rig({ ...BASE, "C:\\Users\\me\\Docs\\photo.jpg": { text: "x" } });
  const info = r.f.inspect("C:\\Users\\me\\Docs\\photo.jpg");
  assert.match((await r.f.convert({ info, to: "png" })).error, /Needs magick or ffmpeg/);
  assert.equal((await r.f.convert({ info, to: "exe" })).ok, false);
  assert.equal(r.execs.length, 0);
});

test("send to pipeline: one file goes straight to rag_ingest; a folder needs the card and no answer is no", async () => {
  const calls = [];
  const gateway = { callTool: async (name, args) => { calls.push([name, args]); return { content: [{ text: "ok" }] }; } };
  const one = rig(BASE, { gateway });
  const ok = await one.f.sendToPipeline({ info: one.f.inspect(DOC) });
  assert.ok(ok.ok);
  assert.deepEqual(calls[0], ["rag_ingest", { text: "Quarterly budget numbers ...", title: "report.txt" }]);
  calls.length = 0;
  const noCard = rig(BASE, { gateway });
  assert.match((await noCard.f.sendToPipeline({ info: noCard.f.inspect("C:\\Users\\me\\Docs") })).error, /approval card/);
  assert.equal(calls.length, 0);
  const asked = [];
  const declined = rig(BASE, { gateway, confirm: async (c) => { asked.push(c); return "Do not send"; } });
  const no = await declined.f.sendToPipeline({ info: declined.f.inspect("C:\\Users\\me\\Docs") });
  assert.equal(no.ok, false);
  assert.match(no.error, /no approval/);
  assert.equal(calls.length, 0);
  assert.equal(asked[0].options[0], "Send");
  const yes = rig(BASE, { gateway, confirm: async () => "Send" });
  assert.ok((await yes.f.sendToPipeline({ info: yes.f.inspect("C:\\Users\\me\\Docs") })).ok);
  assert.equal(calls.length, 1, "only the text file; the png is not ingestable");
});

test("a pdf is refused by the pipeline with the reason, not sent as bytes", async () => {
  const gateway = { callTool: async () => { throw new Error("must not be called"); } };
  const r = rig({ ...BASE, "C:\\Users\\me\\Docs\\a.pdf": { text: "%PDF" } }, { gateway });
  const res = await r.f.sendToPipeline({ info: r.f.inspect("C:\\Users\\me\\Docs\\a.pdf") });
  assert.equal(res.ok, false);
  assert.match(res.error, /no text extractor/);
});

test("run a tool pack: a validated pack name goes to the owner's agent as a read-only task", async () => {
  const sent = [];
  const gateway = { callTool: async (n, a) => { sent.push([n, a]); return { content: [{ text: "queued" }] }; } };
  const r = rig(BASE, { gateway });
  const info = r.f.inspect(DOC);
  assert.ok((await r.f.runPack({ info, pack: "dgg-research", agent: "hydra" })).ok);
  assert.equal(sent[0][0], "delegate_to_agent");
  assert.equal(sent[0][1].to_agent, "hydra");
  assert.match(sent[0][1].description, /Read-only unless the pack says otherwise/);
  assert.equal((await r.f.runPack({ info, pack: "x; rm -rf /" })).ok, false);
  assert.equal(sent.length, 1);
});

test("there is no delete, overwrite or move verb on the surface", () => {
  const surface = Object.keys(files.createAssistFiles({ engine: {} })).sort();
  assert.deepEqual(surface, ["applyRename", "convert", "conversionsFor", "inspect", "proposeRename", "runPack", "runVerb", "sendToPipeline", "undoRename"].sort());
  const src = require("node:fs").readFileSync(require("node:path").join(__dirname, "assist-files.cjs"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  assert.doesNotMatch(src, /rmSync|rmdirSync|copyFileSync|writeFileSync|"-y"|"--replace"/);
  assert.equal((src.match(/unlinkSync/g) || []).length, 1, "the ONLY unlink is the old name after a no-clobber hard link");
});

test("rename uses a no-clobber hard link: if the name appears between the check and the act, nothing is replaced", () => {
  const r = rig({ ...BASE });
  const links = [];
  r.fsImpl.linkSync = (a, b) => { links.push([a, b]); if (b === "C:\\Users\\me\\Docs\\Race.txt") { const e = new Error("EEXIST"); e.code = "EEXIST"; throw e; } r.fsImpl.map.set(b, r.fsImpl.map.get(a)); };
  r.fsImpl.unlinkSync = (a) => { r.fsImpl.map.delete(a); };
  const lost = r.f.applyRename({ from: DOC, name: "Race" });
  assert.equal(lost.ok, false);
  assert.ok(r.fsImpl.map.has(DOC), "the original is untouched when the link fails");
  const won = r.f.applyRename({ from: DOC, name: "Free name" });
  assert.ok(won.ok);
  assert.ok(!r.fsImpl.map.has(DOC) && r.fsImpl.map.has("C:\\Users\\me\\Docs\\Free name.txt"));
});

test("a folder send never carries secret-looking files", async () => {
  const calls = [];
  const gateway = { callTool: async (n, a) => { calls.push(a.title); return { content: [{ text: "ok" }] }; } };
  const r = rig({
    "C:\\Users\\me\\Docs": { dir: true, kids: ["notes.txt", ".env", "id_rsa", "server.pem", "password list.txt", "plan.md"] },
    "C:\\Users\\me\\Docs\\notes.txt": { text: "n" }, "C:\\Users\\me\\Docs\\.env": { text: "KEY=1" }, "C:\\Users\\me\\Docs\\id_rsa": { text: "-----BEGIN" },
    "C:\\Users\\me\\Docs\\server.pem": { text: "pem" }, "C:\\Users\\me\\Docs\\password list.txt": { text: "pw" }, "C:\\Users\\me\\Docs\\plan.md": { text: "p" },
  }, { gateway, confirm: async () => "Send" });
  assert.ok((await r.f.sendToPipeline({ info: r.f.inspect("C:\\Users\\me\\Docs") })).ok);
  assert.deepEqual(calls.sort(), ["notes.txt", "plan.md"]);
});

test("convert runs the VERIFIED path, and a tool that fails the signature check is never executed", async () => {
  const entries = { ...BASE, "C:\\Users\\me\\Docs\\photo.jpg": { text: "x" } };
  const good = rig(entries, { findExe: (t) => (t === "magick" ? "C:\\Evil\\magick.exe" : null), verifyExe: async () => ({ ok: true, path: "C:\\Program Files\\ImageMagick-7\\magick.exe" }) });
  const info = good.f.inspect("C:\\Users\\me\\Docs\\photo.jpg");
  assert.ok((await good.f.convert({ info, to: "png" })).ok);
  assert.equal(good.execs[0].exe, "C:\\Program Files\\ImageMagick-7\\magick.exe", "the verified path, not the located one");
  const bad = rig(entries, { findExe: (t) => (t === "magick" ? "C:\\Tools\\magick.exe" : null), verifyExe: async () => ({ ok: false, error: "Not run: magick.exe failed the signature check (its Authenticode signature is HashMismatch)." }) });
  const res = await bad.f.convert({ info: bad.f.inspect("C:\\Users\\me\\Docs\\photo.jpg"), to: "png" });
  assert.equal(res.ok, false);
  assert.match(res.error, /signature check/);
  assert.equal(bad.execs.length, 0, "nothing was executed");
  assert.equal(bad.records.length, 0, "and nothing was logged as started");
});
